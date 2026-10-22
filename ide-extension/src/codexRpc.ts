import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as os from "node:os";
import WebSocket from "ws";
import { SESSION_ID, validGoal, type Goal } from "./goal.ts";

export interface Launch { executable: string; args: string[]; env?: NodeJS.ProcessEnv }

function interactiveTerminalThread(thread: any): boolean {
  return thread.parentThreadId === null && (thread.source === "cli" ||
    // Modern TUIs launched inside VS Code inherit its source classification.
    // Their explicit originator distinguishes them from editor-owned chats.
    (thread.source === "vscode" && thread.originator === "codex-tui" && thread.threadSource === "user"));
}

/** Resolve npm's native binary directly: its JS shim does not hide child windows. */
export async function nativeCodexFromScript(script: string, arch = process.arch): Promise<string> {
  const triple = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : undefined;
  if (!triple) throw new Error("Unsupported Windows Codex architecture.");
  const realScript = await fs.realpath(script);
  let vendor: string;
  try {
    const manifest = createRequire(realScript).resolve(`@openai/codex-win32-${arch}/package.json`);
    vendor = path.join(path.dirname(manifest), "vendor");
  } catch { vendor = path.resolve(path.dirname(realScript), "..", "vendor"); }
  const executable = path.join(vendor, triple, "bin", "codex.exe");
  if (!await fs.stat(executable).then(s => s.isFile(), () => false)) throw new Error("Codex native Windows executable was not found.");
  return executable;
}

/** Avoid invoking a shell or interpolating paths into command text. */
export async function codexLaunch(): Promise<Launch> {
  if (process.platform !== "win32") return { executable: "codex", args: ["app-server", "--stdio"] };
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const native = path.join(directory, "codex.exe");
    if (await fs.stat(native).then(s => s.isFile(), () => false)) return { executable: native, args: ["app-server", "--stdio"] };
    const script = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (await fs.stat(script).then(s => s.isFile(), () => false)) {
      return { executable: await nativeCodexFromScript(script), args: ["app-server", "--stdio"] };
    }
  }
  throw new Error("Codex CLI was not found on the extension host PATH.");
}

/** This client exposes read-only methods; it never starts turns or changes goals. */
export class CodexReader {
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private send?: (message: unknown) => void;
  private ready?: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private launch: () => Promise<Launch>;
  private timeoutMs: number;
  private listTimeoutMs: number;
  private daemonPath?: string;
  constructor(launch: () => Promise<Launch> = codexLaunch, timeoutMs = 4000, listTimeoutMs = 30000, daemonPath?: string) {
    this.launch = launch;
    this.timeoutMs = timeoutMs;
    this.listTimeoutMs = listTimeoutMs;
    this.daemonPath = daemonPath ?? (launch === codexLaunch && process.platform !== "win32"
      ? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "app-server-control", "app-server-control.sock") : undefined);
  }

  private receive(message: any): void {
    const entry = this.pending.get(message.id);
    if (!entry || message.method) return;
    clearTimeout(entry.timer); this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(`Codex read request failed (${message.error.code ?? "unknown"}).`));
    else entry.resolve(message.result);
  }

  private async connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const daemon = this.daemonPath && await fs.stat(this.daemonPath).then(s => s.isSocket(), () => false);
      if (daemon) {
        // Query the runtime that already owns the terminal's conversation.
        // A separate app-server cannot read daemon-only loaded threads.
        const socket = new WebSocket(`ws+unix://${this.daemonPath}:/`, {
          handshakeTimeout: this.timeoutMs, maxPayload: 8 * 1024 * 1024,
          perMessageDeflate: false,
        });
        this.socket = socket;
        socket.on("message", data => {
          try { this.receive(JSON.parse(data.toString())); } catch { this.dispose(); }
        });
        socket.on("error", () => { if (this.socket === socket) this.dispose(); });
        socket.on("close", () => { if (this.socket === socket) this.dispose(); });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        this.send = message => socket.send(JSON.stringify(message));
      } else {
        const launch = await this.launch();
        const child = spawn(launch.executable, launch.args, { shell: false, windowsHide: true, stdio: "pipe", env: launch.env ?? process.env });
        this.child = child;
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stderr.resume();
        child.stdin.on("error", () => this.dispose());
        child.on("error", () => this.dispose());
        child.on("exit", () => { if (this.child === child) this.dispose(); });
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 8 * 1024 * 1024) { this.dispose(); return; }
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try {
              this.receive(JSON.parse(line));
            } catch { /* Ignore non-protocol output; requests still time out. */ }
          }
        });
        this.send = message => child.stdin.write(JSON.stringify(message) + "\n");
      }
      await this.request("initialize", { clientInfo: { name: "ai-account-switcher-resume", version: "0.2.0" }, capabilities: { experimentalApi: true } });
      this.send!({ method: "initialized" });
    })();
    try { await this.ready; } catch (error) { this.dispose(); throw error; }
  }
  private request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      if (!this.send) { reject(new Error("Codex reader is not connected.")); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private async readThread(threadId: string, cwd?: string): Promise<any> {
    if (!SESSION_ID.test(threadId)) throw new Error("Invalid Codex session ID.");
    await this.connect();
    const { thread } = await this.request("thread/read", { threadId, includeTurns: false });
    const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!thread || thread.id !== threadId || typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd)) throw new Error("Invalid Codex session workspace.");
    if (cwd !== undefined && normalize(thread.cwd) !== normalize(cwd)) {
      const [threadPath, terminalPath] = await Promise.all([
        fs.realpath(thread.cwd).catch(() => undefined), fs.realpath(cwd).catch(() => undefined),
      ]);
      if (!threadPath || !terminalPath || normalize(threadPath) !== normalize(terminalPath)) throw new Error("Codex session does not match the terminal workspace.");
    }
    return thread;
  }
  async isInteractiveSession(threadId: string, cwd: string): Promise<boolean> {
    const thread = await this.readThread(threadId, cwd);
    return interactiveTerminalThread(thread);
  }
  /** Only use after native process ancestry has tied this ID to a terminal. */
  async interactiveSession(threadId: string): Promise<{ cwd: string } | null> {
    const thread = await this.readThread(threadId);
    return interactiveTerminalThread(thread) ? { cwd: thread.cwd } : null;
  }
  /** Recency never establishes terminal ownership. Retained for old callers;
   * exact IDs must come from native ownership, /status, or explicit linking. */
  async recentInteractiveSession(_cwd: string, report?: (reason: string, detail: Record<string, number>) => void): Promise<string | undefined> {
    report?.("exact_session_binding_required", {});
    return undefined;
  }
  async latestTurn(threadId: string, cwd: string): Promise<import("./capacityRetry.ts").RetryTurn | null> {
    await this.readThread(threadId, cwd);
    const result = await this.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    if (!Array.isArray(result.data)) throw new Error("Unsupported turn history.");
    const turn = result.data[0];
    if (!turn) return null;
    if (!SESSION_ID.test(turn.id) || !["completed", "failed", "interrupted", "inProgress"].includes(turn.status)) throw new Error("Unsupported turn state.");
    return turn;
  }
  async readGoal(threadId: string, cwd: string): Promise<Goal | null> {
    await this.readThread(threadId, cwd);
    const { goal } = await this.request("thread/goal/get", { threadId });
    if (goal === null) return null;
    if (!validGoal(goal, threadId)) throw new Error("Codex returned an unsupported goal state.");
    return goal;
  }
  dispose(): void {
    const child = this.child; this.child = undefined; this.ready = undefined;
    const socket = this.socket; this.socket = undefined; this.send = undefined;
    if (socket) socket.terminate();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Codex reader disconnected.")); }
    this.pending.clear();
    if (child) {
      // EOF shuts down the app server too when launched through npm's Node shim.
      child.stdin.end();
      const force = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 500);
      force.unref();
      child.once("exit", () => clearTimeout(force));
    }
  }
}
