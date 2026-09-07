import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { classifyCommand, resumeInvocation, sessionIdFromCommand, type ResumeTool } from "./session";
import { CodexReader } from "./codexRpc";
import { discoverSessions, ownerForTerminal } from "./sessionDiscovery";
import { GoalDialogCleanup } from "./goalDialogCleanup";
import { RetryLedger, RetryPrompt, overloaded, retryDelay, goalKey } from "./capacityRetry";
import { SESSION_ID, canContinueGoal, captureGoal, fingerprint, goalReadyAction, sessionIdFromStatus, type GoalCapture } from "./goal";

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
  sessionId?: string;
  goal?: GoalCapture;
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
  execution?: vscode.TerminalShellExecution;
  tool: ResumeTool;
  cwd: string;
  terminalProcessId?: number;
  sessionId?: string;
  discovered?: boolean;
  outputRevision?: number;
  retryPrompt?: RetryPrompt;
}

let bridgeRoot = "";
let clientId = "";
let ideKind: IdeKind = "vscode";
let output: vscode.OutputChannel;
let pollTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let polling = false;
let heartbeatWrites: Promise<void> = Promise.resolve();
let discoveryTimer: NodeJS.Timeout | undefined;
let discovering: Promise<void> | undefined;
let stopped = false;
let discoveryScript = "";
let retryTimer: NodeJS.Timeout | undefined;
let retryPolling = false;
let retryBlockedUntil = 0;
let retryGeneration = 0;
const retryNotified = new Set<string>();
const retrySent = new Map<string, { turn: string; at: number; warned: boolean }>();
const retryPending = new Map<vscode.Terminal, { turn: string; due: number; goal: string; generation: number }>();

function retryMode(): string {
  return enabled() ? vscode.workspace.getConfiguration("aiAccountSwitcherResume").get<string>("capacityRetry", "ask") : "off";
}
function cancelRetries(): void {
  retryGeneration++;
  retryPending.clear();
  for (const active of activeExecutions.values()) active.retryPrompt?.invalidate();
}
async function offerRetry(terminal: vscode.Terminal, active: ActiveExecution, turn: string, reason: string): Promise<void> {
  const key = `${active.sessionId}:${turn}`;
  if (retryNotified.has(key)) return;
  retryNotified.add(key);
  output.appendLine(`Capacity retry: ${reason}`);
  void vscode.window.showInformationMessage(`Codex model is at capacity. ${reason}`, "Copy continue", "Dismiss").then(async choice => {
    if (choice === "Copy continue" && activeExecutions.get(terminal) === active && !stopped) {
      await vscode.env.clipboard.writeText("continue");
      terminal.show();
    }
  }).then(undefined, () => {});
}
async function pollCapacityRetries(): Promise<void> {
  if (retryPolling || stopped || !["ask", "automatic"].includes(retryMode()) || Date.now() < retryBlockedUntil) return;
  retryPolling = true;
  const generation = retryGeneration;
  const ledger = new RetryLedger(path.join(bridgeRoot, "capacity-retries"));
  try {
    for (const [terminal, active] of activeExecutions) {
      const session = active.sessionId;
      if (active.tool !== "codex" || !session) continue;
      try {
      const valid = () => !stopped && enabled() && generation === retryGeneration && Date.now() >= retryBlockedUntil && activeExecutions.get(terminal) === active && active.sessionId === session;
      const turn = await codexReader.latestTurn(session, active.cwd);
      if (!valid()) return;
      const sent = retrySent.get(session);
      if (sent) {
        if (turn && turn.id !== sent.turn) {
          output.appendLine(`Capacity retry acknowledged by a new turn for ${session}.`);
          retrySent.delete(session);
        } else {
          if (!sent.warned && Date.now() - sent.at > 15000) {
            sent.warned = true;
            await offerRetry(terminal, active, sent.turn, "A new turn was not confirmed. Inspect the terminal; no duplicate will be sent.");
          }
          continue;
        }
      }
      if (!overloaded(turn) || !Number.isFinite(turn.completedAt) || Date.now() - turn.completedAt! * 1000 > 15 * 60000 || turn.completedAt! * 1000 > Date.now() + 5000) { retryPending.delete(terminal); continue; }
      const currentGoal = await codexReader.readGoal(session, active.cwd);
      if (!valid()) return;
      const key = goalKey(currentGoal);
      const prompt = active.retryPrompt;
      const deliverable = () => retryMode() === "automatic" && !!active.execution && vscode.window.activeTerminal !== terminal && !!prompt?.observedAt && prompt.observedAt >= turn.completedAt! * 1000 && key !== undefined;
      if (!deliverable()) {
        retryPending.delete(terminal);
        await offerRetry(terminal, active, turn.id, "Retry manually when ready; use Copy continue to focus its terminal.");
        continue;
      }
      let pending = retryPending.get(terminal);
      if (!pending || pending.turn !== turn.id) {
        const count = await ledger.count(session);
        if (!valid() || !deliverable()) continue;
        if (count >= 5) { await offerRetry(terminal, active, turn.id, "Automatic retry limit reached (five per hour)."); continue; }
        pending = { turn: turn.id, due: Date.now() + retryDelay(count), goal: key!, generation };
        retryPending.set(terminal, pending);
        output.appendLine(`Capacity retry scheduled in ${Math.ceil((pending.due - Date.now()) / 1000)} seconds for ${session}.`);
      }
      if (Date.now() < pending.due) continue;
      const revision = prompt!.revision;
      const latest = await codexReader.latestTurn(session, active.cwd);
      const goal = await codexReader.readGoal(session, active.cwd);
      if (!valid() || !deliverable() || latest?.id !== turn.id || !overloaded(latest) || goalKey(goal) !== pending.goal || prompt!.revision !== revision) { retryPending.delete(terminal); continue; }
      const claimed = await ledger.claim(session, turn.id);
      retryPending.delete(terminal);
      if (!claimed) { await offerRetry(terminal, active, turn.id, "Retry already claimed or automatic retry limit reached."); continue; }
      // No await between final live checks and fixed input. Uncertain claims are never resent.
      if (!valid() || !deliverable() || prompt!.revision !== revision) continue;
      prompt!.invalidate();
      terminal.sendText("continue", true);
      retrySent.set(session, { turn: turn.id, at: Date.now(), warned: false });
      output.appendLine(`Sent one capacity retry for ${session}, failed turn ${turn.id}. Awaiting a new turn; this turn cannot be sent again.`);
      } catch { output.appendLine(`Capacity retry check unavailable for ${session}; inspect that terminal manually.`); }
    }
  } catch { output.appendLine("Capacity retry check unavailable; no retry input sent by the failed check."); }
  finally { retryPolling = false; }
}

const activeExecutions = new Map<vscode.Terminal, ActiveExecution>();
const terminalExecutions = new Map<vscode.Terminal, vscode.TerminalShellExecution>();
const resumeAttempts = new Map<vscode.Terminal, { sessionId?: string; startedAt: number; execution?: vscode.TerminalShellExecution; verified?: boolean }>();
const acknowledgedRequests = new Set<string>();
const resumedResponses = new Set<string>();
const codexReader = new CodexReader();
interface PendingGoal { sessionId: string; goal: GoalCapture; expiresAt: number; checking: boolean; timer: NodeJS.Timeout }
const pendingGoals = new Map<vscode.Terminal, PendingGoal>();
const dialogCleaners = new Map<vscode.Terminal, GoalDialogCleanup>();
const cleanupLaunches = new Map<vscode.Terminal, { sessionId: string; fingerprint?: string }>();

function cleanupDialogs(): boolean {
  return enabled() && vscode.workspace.getConfiguration("aiAccountSwitcherResume").get<boolean>("cleanupStaleGoalDialogs", true);
}
function clearDialogCleaner(terminal: vscode.Terminal): void {
  dialogCleaners.get(terminal)?.dispose();
  dialogCleaners.delete(terminal);
}

function continueGoals(): boolean {
  return enabled() && vscode.workspace.getConfiguration("aiAccountSwitcherResume").get<boolean>("continueInterruptedGoals", false);
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise.catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function clearPendingGoal(terminal: vscode.Terminal): void {
  const pending = pendingGoals.get(terminal);
  if (pending) clearTimeout(pending.timer);
  pendingGoals.delete(terminal);
}

async function observeExecution(terminal: vscode.Terminal, active: ActiveExecution): Promise<void> {
  if (!active.execution) return;
  let tail = "";
  try {
    for await (const chunk of active.execution.read()) {
      if (activeExecutions.get(terminal) !== active) return;
      const revision = active.outputRevision = (active.outputRevision ?? 0) + 1;
      dialogCleaners.get(terminal)?.observe(chunk);
      active.retryPrompt?.observe(chunk);
      tail = (tail + chunk).slice(-8192);
      // A subsequently displayed different /status invalidates the explicit binding.
      const observedId = sessionIdFromStatus(tail);
      if (observedId && active.sessionId && observedId !== active.sessionId) {
        active.retryPrompt?.invalidate();
        retryPending.delete(terminal);
        active.sessionId = undefined;
        clearDialogCleaner(terminal);
        clearPendingGoal(terminal);
        output.appendLine("Codex session changed; link the current session again before goal continuation.");
      }
      const pending = pendingGoals.get(terminal);
      if (!pending || pending.checking || active.sessionId !== pending.sessionId || !continueGoals()) continue;
      const action = goalReadyAction(tail);
      if (!action) continue;
      pending.checking = true;
      // Consume the readiness observation once. Later output must provide a new one.
      tail = "";
      void (async () => {
      const goal = await within(codexReader.readGoal(pending.sessionId, active.cwd), 3000);
      if (pendingGoals.get(terminal) !== pending || activeExecutions.get(terminal) !== active || !continueGoals() || Date.now() > pending.expiresAt) return;
      if (active.outputRevision !== revision) { pending.checking = false; return; }
      if (!goal || !canContinueGoal(pending.goal, goal)) {
        clearPendingGoal(terminal);
        output.appendLine("Goal continuation skipped: state, identity, or budget could not be verified.");
        return;
      }
      clearPendingGoal(terminal); // At most one input per captured resume.
      if (action === "running") {
        output.appendLine("The captured goal is already running; no continuation input sent.");
      } else {
        // Fixed TUI input only, after a goal-specific readiness signal and state check.
        terminal.sendText(action === "confirm" ? "" : "/goal resume", true);
        output.appendLine("Requested continuation of the captured goal without changing its objective or budget.");
      }
      })().catch(() => {
        clearPendingGoal(terminal);
        output.appendLine("Goal continuation input failed; inspect the terminal manually.");
      });
    }
  } catch { output.appendLine("Terminal observation ended; automatic goal continuation is unavailable for this execution."); }
}

function refreshDiscovery(): Promise<void> {
  if (discovering) return discovering;
  if (stopped || !enabled() || process.platform !== "win32") return Promise.resolve();
  discovering = (async () => {
    const owners = await discoverSessions(discoveryScript);
    for (const terminal of vscode.window.terminals) {
      const pid = await terminal.processId;
      if (!pid || stopped || !enabled()) continue;
      let active = activeExecutions.get(terminal);
      if (active && active.tool !== "codex") continue;
      const candidates = owners.filter(owner => owner.ancestors.includes(pid));
      let uncertain = false;
      const directories = new Map<string, string>();
      const verified = await Promise.all(candidates.map(async owner => {
        try {
          const session = await codexReader.interactiveSession(owner.sessionId);
          if (!session) return undefined;
          directories.set(owner.sessionId, session.cwd);
          return owner;
        }
        catch { uncertain = true; return undefined; }
      }));
      if (stopped || !enabled() || activeExecutions.get(terminal) !== active) continue;
      const owner = uncertain ? undefined : ownerForTerminal(verified.filter(owner => owner !== undefined), pid);
      if (!owner) {
        if (active?.discovered) {
          active.sessionId = undefined;
          clearPendingGoal(terminal);
          if (!active.execution) activeExecutions.delete(terminal);
        }
        continue;
      }
      const cwd = directories.get(owner.sessionId)!;
      try {
        if (stopped || !enabled() || !vscode.window.terminals.includes(terminal) || activeExecutions.get(terminal) !== active) continue;
        if (!active) {
          active = { tool: "codex", cwd, terminalProcessId: pid, discovered: true };
          activeExecutions.set(terminal, active);
        }
        active.cwd = cwd;
        active.terminalProcessId = pid;
        if (active.sessionId !== owner.sessionId) {
          active.retryPrompt?.invalidate();
          retryPending.delete(terminal);
          clearPendingGoal(terminal);
          active.sessionId = owner.sessionId;
          output.appendLine("Automatically identified the Codex conversation owned by this terminal.");
        }
        active.discovered = true;
        const attempt = resumeAttempts.get(terminal);
        if (attempt && !attempt.verified && attempt.sessionId === owner.sessionId) {
          attempt.verified = true;
          output.appendLine(`Verified running Codex session ${owner.sessionId} in ${cwd}.`);
        }
      } catch {
        if (active?.discovered) { active.sessionId = undefined; clearPendingGoal(terminal); }
      }
    }
    queueHeartbeat();
  })().catch(() => {
    // An unavailable native query must never turn into a guessed identity.
    for (const [terminal, active] of activeExecutions) {
      if (active.discovered) { active.sessionId = undefined; clearPendingGoal(terminal); }
    }
  }).finally(() => { discovering = undefined; });
  return discovering;
}

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
  retryBlockedUntil = Date.now() + 2 * 60000;
  cancelRetries();
  acknowledgedRequests.add(request.requestId);

  const sessions: CapturedSession[] = [];
  const reads: Promise<void>[] = [];
  const seen = new Set<string>();
  for (const [terminal, active] of activeExecutions) {
    if (active.tool !== request.tool) continue;
    const identity = active.sessionId ?? `terminal:${active.terminalProcessId ?? vscode.window.terminals.indexOf(terminal)}`;
    const key = `${active.tool}:${identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const session: CapturedSession = {
      tool: active.tool,
      cwd: active.cwd,
      terminalName: terminal.name,
      terminalProcessId: active.terminalProcessId,
      sessionId: active.sessionId,
    };
    sessions.push(session);
    if (active.tool === "codex" && active.sessionId && continueGoals()) {
      reads.push((async () => {
        const goal = await within(codexReader.readGoal(active.sessionId!, active.cwd), 700);
        if (activeExecutions.get(terminal) === active && active.sessionId === session.sessionId && continueGoals() && goal) session.goal = captureGoal(goal);
      })());
    }
  }
  await Promise.all(reads); // Bounded below the switcher's 1.5 second prepare timeout.

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
  if (activeExecutions.get(terminal)?.discovered && !activeExecutions.get(terminal)?.execution) {
    await refreshDiscovery();
    if (activeExecutions.has(terminal)) throw new Error("Recovered Codex terminal is still running; refusing to send a shell command.");
  }
  const deadline = Date.now() + 5_000;
  while (terminalExecutions.has(terminal) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (terminalExecutions.has(terminal)) throw new Error("Original terminal is still executing; refusing to send a shell command.");
}

async function executeResume(terminal: vscode.Terminal, session: CapturedSession): Promise<void> {
  await waitUntilIdle(terminal);
  if (session.tool === "codex" && session.sessionId && cleanupDialogs()) {
    const before = await within(codexReader.readGoal(session.sessionId, session.cwd), 4000);
    cleanupLaunches.set(terminal, { sessionId: session.sessionId, fingerprint: before ? fingerprint(before) : undefined });
  }
  terminal.show(false);
  const invocation = resumeInvocation(session.tool, session.sessionId);
  resumeAttempts.set(terminal, { sessionId: session.sessionId, startedAt: Date.now() });
  if (terminal.shellIntegration) {
    terminal.shellIntegration.executeCommand(invocation.executable, invocation.args);
    return;
  }

  terminal.sendText(invocation.commandLine, true);
}

async function resumeSession(session: CapturedSession): Promise<void> {
  if (!["codex", "agy"].includes(session.tool) || !path.isAbsolute(session.cwd) || (session.sessionId !== undefined && !SESSION_ID.test(session.sessionId))) throw new Error("Invalid captured session.");
  if (session.tool === "codex" && continueGoals() && !session.sessionId) {
    throw new Error("Exact Codex session is unknown. Use Link Codex Session in the command palette; automatic goal continuation never uses --last.");
  }
  let terminal = await terminalByProcessId(session.terminalProcessId);
  const shellCwd = terminal?.shellIntegration?.cwd?.fsPath;
  if (shellCwd && path.normalize(shellCwd) !== path.normalize(session.cwd)) terminal = undefined;
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name: `${session.tool === "codex" ? "Codex" : "agy"} (resumed)`,
      cwd: vscode.Uri.file(session.cwd),
      isTransient: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  await waitUntilIdle(terminal);
  if (session.tool === "codex" && session.sessionId && session.goal && continueGoals()) {
    const goal = await within(codexReader.readGoal(session.sessionId, session.cwd), 4000);
    // A goal paused before relaunch is a deliberate stop, not a TUI resume prompt.
    if (goal && goal.status !== "paused" && canContinueGoal(session.goal, goal)) {
      clearPendingGoal(terminal);
      const target = terminal;
      const timer = setTimeout(() => {
        clearPendingGoal(target);
        output.appendLine("Goal readiness was not verified within 60 seconds. Continue manually with /goal resume if appropriate.");
      }, 60000);
      pendingGoals.set(terminal, { sessionId: session.sessionId, goal: session.goal, expiresAt: Date.now() + 60000, checking: false, timer });
    }
  }
  try { await executeResume(terminal, session); }
  catch (error) { resumeAttempts.delete(terminal); cleanupLaunches.delete(terminal); clearDialogCleaner(terminal); clearPendingGoal(terminal); throw error; }
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
  cancelRetries();
  retryBlockedUntil = Date.now() + 2 * 60000;

  if (request.phase === "cancelled") {
    output.appendLine(`Discarded cancelled resume request ${request.requestId}.`);
    return;
  }

  for (const session of response.sessions) {
    try {
      await resumeSession(session);
      output.appendLine(`Sent ${session.tool} resume command in ${session.cwd}; startup is not yet verified.`);
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
      if (!request || request.version !== PROTOCOL_VERSION || !SESSION_ID.test(request.requestId) || !["codex", "agy"].includes(request.tool) || !["prepare", "ready", "cancelled"].includes(request.phase)) continue;
      if (!Number.isFinite(request.createdAtMs) || request.createdAtMs > Date.now() + 5000 || Date.now() - request.createdAtMs > 5 * 60000) continue;

      if (request.phase === "prepare") {
        retryBlockedUntil = Math.max(retryBlockedUntil, Date.now() + 10000);
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
        if (!response || response.version !== PROTOCOL_VERSION || response.requestId !== request.requestId || !Array.isArray(response.sessions) || !Array.isArray(response.workspaceFolders)) continue;
        await resumeResponse(responseFile, request, response);
      }
    }
  } finally {
    polling = false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  stopped = false;
  discoveryScript = path.join(context.extensionPath, "dist", "discover-sessions.ps1");
  output = vscode.window.createOutputChannel("AI Account Switcher Resume");
  const appendLine = output.appendLine.bind(output);
  output.appendLine = (line: string) => appendLine(`${new Date().toISOString()} ${line}`);
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
    vscode.commands.registerCommand("aiAccountSwitcherResume.linkCodexSession", async () => {
      const terminal = vscode.window.activeTerminal;
      const active = terminal && activeExecutions.get(terminal);
      if (!terminal || !active || active.tool !== "codex") {
        void vscode.window.showWarningMessage("Select a running Codex integrated terminal with shell integration enabled first.");
        return;
      }
      const id = await vscode.window.showInputBox({
        title: "Link Codex Session", prompt: "Run /status in this Codex terminal, then paste its Session ID. Relink if you change conversations inside the terminal.",
        validateInput: value => SESSION_ID.test(value.trim()) ? undefined : "Enter the complete session UUID from /status.",
      });
      if (!id || activeExecutions.get(terminal) !== active) return;
      try {
        await codexReader.readGoal(id.trim().toLowerCase(), active.cwd);
        if (activeExecutions.get(terminal) !== active) return;
        active.sessionId = id.trim().toLowerCase();
        void vscode.window.showInformationMessage("Codex session linked for exact resume. Enable Continue Interrupted Goals in extension settings to continue its goal after switches.");
      } catch { void vscode.window.showWarningMessage("Could not verify this Codex session and workspace. Check the ID and installed CLI."); }
    }),
    vscode.window.onDidStartTerminalShellExecution((event) => {
      terminalExecutions.set(event.terminal, event.execution);
      const tool = classifyCommand(event.execution.commandLine.value);
      if (!tool) return;
      const attempt = resumeAttempts.get(event.terminal);
      if (attempt && !attempt.execution) attempt.execution = event.execution;
      const cwd = event.shellIntegration.cwd?.fsPath ?? workspaceFolders()[0];
      if (!cwd) {
        output.appendLine(`Ignored ${tool} terminal because its working directory is unknown.`);
        return;
      }
      const active: ActiveExecution = {
        execution: event.execution,
        tool,
        cwd,
        retryPrompt: tool === "codex" ? new RetryPrompt() : undefined,
        sessionId: tool === "codex" ? sessionIdFromCommand(event.execution.commandLine.value) : undefined,
      };
      activeExecutions.set(event.terminal, active);
      clearDialogCleaner(event.terminal);
      const cleanupLaunch = cleanupLaunches.get(event.terminal);
      cleanupLaunches.delete(event.terminal);
      if (tool === "codex" && cleanupLaunch && active.sessionId === cleanupLaunch.sessionId && cleanupDialogs()) {
        const cleaner = new GoalDialogCleanup({
          expectedFingerprint: cleanupLaunch.fingerprint,
          readGoal: () => codexReader.readGoal(cleanupLaunch.sessionId, active.cwd),
          valid: () => !stopped && cleanupDialogs() && activeExecutions.get(event.terminal) === active && active.sessionId === cleanupLaunch.sessionId,
          dismiss: () => {
            clearPendingGoal(event.terminal);
            event.terminal.sendText("\x1b", false);
            output.appendLine("Dismissed a stale goal-resume dialog after verifying the goal was cleared or completed.");
          },
        });
        dialogCleaners.set(event.terminal, cleaner);
      }
      if (tool === "codex") {
        void observeExecution(event.terminal, active);
        if (active.sessionId) void within(codexReader.readGoal(active.sessionId, cwd), 4000);
      }
      void event.terminal.processId.then((processId) => {
        const current = activeExecutions.get(event.terminal);
        if (current === active) current.terminalProcessId = processId;
      });
      queueHeartbeat();
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      const attempt = resumeAttempts.get(event.terminal);
      if (attempt?.execution === event.execution) {
        resumeAttempts.delete(event.terminal);
        output.appendLine(`Resumed terminal command exited with code ${event.exitCode ?? "unknown"} after ${Math.round((Date.now() - attempt.startedAt) / 1000)} seconds.`);
        if (event.exitCode !== 0 && Date.now() - attempt.startedAt < 15000) {
          void vscode.window.showWarningMessage("AI Account Switcher: the resumed command exited during startup. Inspect the terminal error before retrying.");
        }
      }
      if (terminalExecutions.get(event.terminal) === event.execution) terminalExecutions.delete(event.terminal);
      const active = activeExecutions.get(event.terminal);
      if (active?.execution === event.execution) {
        retryPending.delete(event.terminal);
        clearDialogCleaner(event.terminal);
        activeExecutions.delete(event.terminal);
        clearPendingGoal(event.terminal);
        queueHeartbeat();
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      resumeAttempts.delete(terminal);
      retryPending.delete(terminal);
      cleanupLaunches.delete(terminal);
      clearDialogCleaner(terminal);
      terminalExecutions.delete(terminal);
      activeExecutions.delete(terminal);
      clearPendingGoal(terminal);
      queueHeartbeat();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("aiAccountSwitcherResume")) cancelRetries();
      if (event.affectsConfiguration("aiAccountSwitcherResume.enabled")) {
        queueHeartbeat();
      }
      if (!continueGoals()) for (const terminal of pendingGoals.keys()) clearPendingGoal(terminal);
      if (!cleanupDialogs()) for (const terminal of dialogCleaners.keys()) clearDialogCleaner(terminal);
    }),
  );

  if (vscode.window.onDidChangeActiveTerminal) context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(() => cancelRetries()));

  queueHeartbeat();
  void pollBridge().catch(error => output.appendLine(`Bridge check failed: ${String(error)}`));
  heartbeatTimer = setInterval(queueHeartbeat, HEARTBEAT_INTERVAL_MS);
  void refreshDiscovery();
  discoveryTimer = setInterval(() => void refreshDiscovery(), 5000);
  retryTimer = setInterval(() => void pollCapacityRetries(), 7000);
  pollTimer = setInterval(() => void pollBridge().catch(error => output.appendLine(`Bridge check failed: ${String(error)}`)), POLL_INTERVAL_MS);
  output.appendLine(`Bridge active for ${ideKind} as ${clientId}.`);
}

export async function deactivate(): Promise<void> {
  stopped = true;
  cancelRetries();
  if (retryTimer) clearInterval(retryTimer);
  cleanupLaunches.clear();
  resumeAttempts.clear();
  for (const terminal of dialogCleaners.keys()) clearDialogCleaner(terminal);
  if (discoveryTimer) clearInterval(discoveryTimer);
  await discovering;
  codexReader.dispose();
  for (const terminal of pendingGoals.keys()) clearPendingGoal(terminal);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (bridgeRoot && clientId) {
    await heartbeatWrites;
    await fs.rm(path.join(bridgeRoot, "clients", `${clientId}.json`), { force: true });
  }
}
