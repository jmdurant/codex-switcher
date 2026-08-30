import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { classifyCommand, resumeInvocation, type ResumeTool } from "./session";

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 2_000;
const CLIENT_MAX_AGE_MS = 6_000;

type IdeKind = "vscode" | "antigravity";

interface BridgeRequest {
  version: number;
  requestId: string;
  tool: ResumeTool;
  phase: "prepare" | "ready" | "cancelled";
  createdAtMs: number;
  completedAtMs?: number | null;
}

interface CapturedSession {
  tool: ResumeTool;
  cwd: string;
  terminalName: string;
  terminalProcessId?: number;
}

interface BridgeResponse {
  version: number;
  requestId: string;
  clientId: string;
  ideKind: IdeKind;
  ideProcessId: number;
  createdAtMs: number;
  capturedSessions: number;
  sessions: CapturedSession[];
  workspaceFolders: string[];
}

interface ClientHeartbeat {
  version: number;
  clientId: string;
  ideKind: IdeKind;
  ideProcessId: number;
  updatedAtMs: number;
  activeTools: ResumeTool[];
  workspaceFolders: string[];
}

interface ActiveExecution {
  execution: vscode.TerminalShellExecution;
  tool: ResumeTool;
  cwd: string;
  terminalProcessId?: number;
}

let bridgeRoot = "";
let clientId = "";
let ideKind: IdeKind = "vscode";
let output: vscode.OutputChannel;
let pollTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let polling = false;
let heartbeatWrites: Promise<void> = Promise.resolve();

const activeExecutions = new Map<vscode.Terminal, ActiveExecution>();
const acknowledgedRequests = new Set<string>();
const resumedResponses = new Set<string>();

function enabled(): boolean {
  return vscode.workspace
    .getConfiguration("aiAccountSwitcherResume")
    .get<boolean>("enabled", true);
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => path.normalize(folder.uri.fsPath));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rm(filePath, { force: true });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeHeartbeat(): Promise<void> {
  if (!enabled()) {
    if (bridgeRoot && clientId) {
      await fs.rm(path.join(bridgeRoot, "clients", `${clientId}.json`), { force: true });
    }
    return;
  }
  const activeTools = [...new Set([...activeExecutions.values()].map((entry) => entry.tool))];
  const heartbeat: ClientHeartbeat = {
    version: PROTOCOL_VERSION,
    clientId,
    ideKind,
    ideProcessId: process.pid,
    updatedAtMs: Date.now(),
    activeTools,
    workspaceFolders: workspaceFolders(),
  };
  await writeJson(path.join(bridgeRoot, "clients", `${clientId}.json`), heartbeat);
}

function queueHeartbeat(): void {
  heartbeatWrites = heartbeatWrites
    .then(writeHeartbeat, writeHeartbeat)
    .catch((error) => output.appendLine(`Heartbeat failed: ${String(error)}`));
}

async function captureRequest(request: BridgeRequest): Promise<void> {
  if (acknowledgedRequests.has(request.requestId)) return;
  acknowledgedRequests.add(request.requestId);

  const seen = new Set<string>();
  const sessions: CapturedSession[] = [];
  for (const [terminal, active] of activeExecutions) {
    if (active.tool !== request.tool) continue;
    const key = `${active.tool}\0${path.normalize(active.cwd).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({
      tool: active.tool,
      cwd: active.cwd,
      terminalName: terminal.name,
      terminalProcessId: active.terminalProcessId,
    });
  }

  const response: BridgeResponse = {
    version: PROTOCOL_VERSION,
    requestId: request.requestId,
    clientId,
    ideKind,
    ideProcessId: process.pid,
    createdAtMs: Date.now(),
    capturedSessions: sessions.length,
    sessions,
    workspaceFolders: workspaceFolders(),
  };
  await writeJson(
    path.join(bridgeRoot, "responses", `${request.requestId}-${clientId}.json`),
    response,
  );
  output.appendLine(
    `Captured ${sessions.length} ${request.tool} terminal session(s) for ${request.requestId}.`,
  );
}

function compatibleWorkspace(response: BridgeResponse): boolean {
  if (response.clientId === clientId) return true;
  const current = workspaceFolders().map((folder) => folder.toLowerCase());
  const previous = response.workspaceFolders.map((folder) => path.normalize(folder).toLowerCase());
  if (current.length === 0 || previous.length === 0) {
    return response.sessions.some((session) =>
      current.some((folder) => path.normalize(session.cwd).toLowerCase().startsWith(folder)),
    );
  }
  return current.some((folder) => previous.includes(folder));
}

async function originalClientIsStale(response: BridgeResponse): Promise<boolean> {
  if (response.clientId === clientId) return false;
  const heartbeat = await readJson<ClientHeartbeat>(
    path.join(bridgeRoot, "clients", `${response.clientId}.json`),
  );
  return !heartbeat || Date.now() - heartbeat.updatedAtMs > CLIENT_MAX_AGE_MS;
}

async function claimResponse(responseFile: string, response: BridgeResponse): Promise<boolean> {
  if (response.ideKind !== ideKind || !compatibleWorkspace(response)) return false;
  if (response.clientId !== clientId && !(await originalClientIsStale(response))) return false;

  const claimPath = path.join(bridgeRoot, "claims", path.basename(responseFile));
  try {
    await fs.mkdir(path.dirname(claimPath), { recursive: true });
    const handle = await fs.open(claimPath, "wx", 0o600);
    await handle.writeFile(clientId, "utf8");
    await handle.close();
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EEXIST" && (await fs.readFile(claimPath, "utf8").catch(() => "")) === clientId;
  }
}

async function terminalByProcessId(processId: number | undefined): Promise<vscode.Terminal | undefined> {
  if (!processId) return undefined;
  for (const terminal of vscode.window.terminals) {
    if ((await terminal.processId) === processId) return terminal;
  }
  return undefined;
}

async function waitUntilIdle(terminal: vscode.Terminal): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (activeExecutions.has(terminal) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function executeResume(terminal: vscode.Terminal, tool: ResumeTool): Promise<void> {
  await waitUntilIdle(terminal);
  terminal.show(false);
  const invocation = resumeInvocation(tool);
  if (terminal.shellIntegration) {
    terminal.shellIntegration.executeCommand(invocation.executable, invocation.args);
    return;
  }

  terminal.sendText(invocation.commandLine, true);
}

async function resumeSession(session: CapturedSession): Promise<void> {
  let terminal = await terminalByProcessId(session.terminalProcessId);
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name: `${session.tool === "codex" ? "Codex" : "agy"} (resumed)`,
      cwd: vscode.Uri.file(session.cwd),
      isTransient: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  await executeResume(terminal, session.tool);
}

async function resumeResponse(
  responseFile: string,
  request: BridgeRequest,
  response: BridgeResponse,
): Promise<void> {
  const responseKey = path.basename(responseFile);
  if (resumedResponses.has(responseKey) || response.sessions.length === 0) return;
  if (!(await claimResponse(responseFile, response))) return;
  resumedResponses.add(responseKey);

  if (request.phase === "cancelled") {
    output.appendLine(`Discarded cancelled resume request ${request.requestId}.`);
    return;
  }

  for (const session of response.sessions) {
    try {
      await resumeSession(session);
      output.appendLine(`Resumed ${session.tool} in ${session.cwd}.`);
    } catch (error) {
      output.appendLine(`Failed to resume ${session.tool} in ${session.cwd}: ${String(error)}`);
      void vscode.window.showWarningMessage(
        `AI Account Switcher could not resume ${session.tool} in ${session.cwd}.`,
      );
    }
  }
}

async function pollBridge(): Promise<void> {
  if (polling || !enabled()) return;
  polling = true;
  try {
    const requestsDir = path.join(bridgeRoot, "requests");
    const requestFiles = await fs.readdir(requestsDir).catch(() => [] as string[]);
    for (const fileName of requestFiles.filter((name) => name.endsWith(".json"))) {
      const requestFile = path.join(requestsDir, fileName);
      const request = await readJson<BridgeRequest>(requestFile);
      if (!request || request.version !== PROTOCOL_VERSION) continue;

      if (request.phase === "prepare") {
        await captureRequest(request);
        continue;
      }

      const responsesDir = path.join(bridgeRoot, "responses");
      const responseFiles = await fs.readdir(responsesDir).catch(() => [] as string[]);
      for (const responseName of responseFiles.filter((name) =>
        name.startsWith(`${request.requestId}-`),
      )) {
        const responseFile = path.join(responsesDir, responseName);
        const response = await readJson<BridgeResponse>(responseFile);
        if (!response || response.requestId !== request.requestId) continue;
        await resumeResponse(responseFile, request, response);
      }
    }
  } finally {
    polling = false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("AI Account Switcher Resume");
  context.subscriptions.push(output);

  if (vscode.env.remoteName) {
    output.appendLine(`Disabled in remote extension host: ${vscode.env.remoteName}.`);
    return;
  }

  bridgeRoot = path.join(os.homedir(), ".codex-switcher", "ide-bridge");
  clientId = `${process.pid}-${crypto.randomUUID()}`;
  ideKind = vscode.env.appName.toLowerCase().includes("antigravity")
    ? "antigravity"
    : "vscode";

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      const tool = classifyCommand(event.execution.commandLine.value);
      if (!tool) return;
      const cwd = event.shellIntegration.cwd?.fsPath ?? workspaceFolders()[0];
      if (!cwd) {
        output.appendLine(`Ignored ${tool} terminal because its working directory is unknown.`);
        return;
      }
      const active: ActiveExecution = {
        execution: event.execution,
        tool,
        cwd,
      };
      activeExecutions.set(event.terminal, active);
      void event.terminal.processId.then((processId) => {
        const current = activeExecutions.get(event.terminal);
        if (current === active) current.terminalProcessId = processId;
      });
      queueHeartbeat();
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      const active = activeExecutions.get(event.terminal);
      if (active?.execution === event.execution) {
        activeExecutions.delete(event.terminal);
        queueHeartbeat();
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      activeExecutions.delete(terminal);
      queueHeartbeat();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("aiAccountSwitcherResume.enabled")) {
        queueHeartbeat();
      }
    }),
  );

  queueHeartbeat();
  void pollBridge();
  heartbeatTimer = setInterval(queueHeartbeat, HEARTBEAT_INTERVAL_MS);
  pollTimer = setInterval(() => void pollBridge(), POLL_INTERVAL_MS);
  output.appendLine(`Bridge active for ${ideKind} as ${clientId}.`);
}

export async function deactivate(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (bridgeRoot && clientId) {
    await heartbeatWrites;
    await fs.rm(path.join(bridgeRoot, "clients", `${clientId}.json`), { force: true });
  }
}
