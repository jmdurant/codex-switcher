import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const id = "01991234-1234-7123-8123-123456789abc";
const requestId = "01991234-1234-7123-8123-123456789def";
const compiled = await build({
  entryPoints: [path.resolve("src/extension.ts")], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["vscode"],
  plugins: [{ name: "mock-codex-reader", setup(builder) {
    builder.onResolve({ filter: /codexRpc$/ }, () => ({ path: "reader", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `export class CodexReader { async latestTurn() { return globalThis.readTestTurn?.() ?? null; } async interactiveSession() { return { cwd: globalThis.testSessionCwd }; } async readGoal(id, cwd) { return globalThis.readTestGoal(id, cwd); } dispose() {} }` }));
    builder.onResolve({ filter: /sessionDiscovery$/ }, () => ({ path: "discovery", namespace: "discovery-test" }));
    builder.onLoad({ filter: /.*/, namespace: "discovery-test" }, () => ({ contents: `
      export { ownerForTerminal } from ${JSON.stringify(path.resolve("src/sessionDiscovery.ts"))};
      export async function discoverSessions() { return globalThis.getTestOwners(); }
    `, resolveDir: process.cwd() }));
  } }],
});

async function capacityScenario(change: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-extension-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const events: Record<string, any> = {};
  const sent: string[] = [], messages: string[] = [];
  let now = Date.now(), mode = change === "ask" ? "ask" : "automatic";
  let turn: any = { id: requestId, status: "failed", error: { codexErrorInfo: "serverOverloaded" }, completedAt: Math.floor(now / 1000) };
  let goal: any = null;
  const disposable = { dispose() {} };
  const terminal: any = { name: "Codex", processId: Promise.resolve(11), show() {}, sendText: (s: string) => sent.push(s), shellIntegration: { cwd: { fsPath: root } } };
  const vscode: any = {
    env: { appName: "VS Code", clipboard: { async writeText() {} } },
    commands: { registerCommand() { return disposable; } },
    workspace: { workspaceFolders: [{ uri: { scheme: "file", fsPath: root } }],
      getConfiguration: () => ({ get: (key: string, fallback: any) => key === "capacityRetry" ? mode : key === "enabled" ? true : fallback }),
      onDidChangeConfiguration: (fn: any) => { events.config = fn; return disposable; } },
    window: { terminals: [terminal], activeTerminal: undefined,
      createOutputChannel: () => ({ appendLine: (s: string) => messages.push(s), dispose() {} }),
      onDidStartTerminalShellExecution: (fn: any) => { events.start = fn; return disposable; },
      onDidEndTerminalShellExecution: (fn: any) => { events.end = fn; return disposable; },
      onDidCloseTerminal: (fn: any) => { events.close = fn; return disposable; },
      onDidChangeActiveTerminal: (fn: any) => { events.focus = fn; return disposable; },
      showInformationMessage: async (s: string) => { messages.push(s); },
      showWarningMessage: async () => {} }
  };
  class Clock extends Date { static now() { return now; } }
  const module = { exports: {} as any };
  vm.runInNewContext(compiled.outputFiles[0].text + "\nmodule.exports.testPoll = pollCapacityRetries;", {
    module, exports: module.exports, process: { ...process, platform: "linux" }, console, Buffer, Date: Clock,
    require: (name: string) => name === "vscode" ? vscode : name === "node:os" ? { ...os, homedir: () => root } : require(name),
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    readTestGoal: () => goal, readTestTurn: () => turn, getTestOwners: () => []
  });
  try {
    module.exports.activate({ subscriptions: [], extensionPath: root });
    const ex = execution(`codex resume ${id}`);
    events.start({ terminal, execution: ex, shellIntegration: terminal.shellIntegration });
    ex.push("\r\n› Ask Codex to do anything\r\n");
    await new Promise(resolve => setTimeout(resolve, 10));
    if (change === "focused") vscode.window.activeTerminal = terminal;
    if (change === "quota") turn.error.codexErrorInfo = "usageLimitExceeded";
    if (change === "running") turn.status = "inProgress";
    if (change === "paused") goal = {threadId:id,objective:"task",createdAt:1,status:"paused",tokenBudget:100,tokensUsed:1};
    if (change === "unobserved") { events.end({terminal,execution:ex}); }
    await module.exports.testPoll();
    now += 36000;
    if (change === "focus_during_wait") { vscode.window.activeTerminal = terminal; events.focus(terminal); }
    if (change === "disabled") { mode = "off"; events.config({affectsConfiguration:()=>true}); }
    if (change === "new_turn") turn = {...turn,id:"01991234-1234-7123-8123-123456789aaa",status:"completed",error:null};
    if (change === "typing") { ex.push("typed text"); await new Promise(resolve=>setTimeout(resolve,10)); }
    if (change === "goal_changed") goal = {threadId:id,objective:"new",createdAt:2,status:"active",tokenBudget:100,tokensUsed:1};
    await module.exports.testPoll();
    if (change === "success") {
      assert.deepEqual(sent,["continue"]);
      now += 60000;
      await module.exports.testPoll();
      assert.deepEqual(sent,["continue"]);
      turn = {...turn,id:"01991234-1234-7123-8123-123456789aaa",status:"completed",error:null};
      await module.exports.testPoll();
      assert.ok(messages.some(s=>s.includes("acknowledged by a new turn")));
    } else assert.deepEqual(sent,[]);
  } finally { await module.exports.deactivate(); await fs.rm(root,{recursive:true,force:true}); }
}
for (const change of ["success","ask","focused","quota","running","paused","unobserved","focus_during_wait","disabled","new_turn","typing","goal_changed"]) {
  test(`capacity extension flow: ${change}`, () => capacityScenario(change));
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!await check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for extension test state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function execution(command: string) {
  const chunks: string[] = [];
  let wake: (() => void) | undefined;
  return {
    commandLine: { value: command },
    push(chunk: string) { chunks.push(chunk); wake?.(); },
    async *read() { while (true) { if (!chunks.length) await new Promise<void>(resolve => { wake = resolve; }); while (chunks.length) yield chunks.shift()!; } },
  };
}

async function scenario(options: {
  launchMode?: string; expectedYolo?: boolean;
  capturedStatus?: string; readyText?: string; phase?: string; disableBeforeReady?: boolean;
  beforeLaunch?: Record<string, unknown>; atReady?: Record<string, unknown>;
  expectContinuation?: boolean;
  autoDiscover?: boolean; recovered?: boolean;
  ambiguous?: boolean; missingShellCwd?: boolean; goalUnavailable?: boolean; twoUnknown?: boolean; staleShellCwd?: boolean; exitStartup?: boolean;
  clearAtReady?: boolean; clearAfterPrompt?: boolean; expectCleanup?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "switcher-extension-test-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const events: Record<string, (event: any) => void> = {};
  const intervals = new Map<number, () => void>();
  const sent: string[] = [];
  const newlines: boolean[] = [];
  const launches: string[][] = [];
  const messages: string[] = [];
  let continuationEnabled = true;
  let status = options.capturedStatus ?? "active";
  let goalChanges: Record<string, unknown> = {};
  let goalCleared = false;
  let owners: any[] = options.autoDiscover ? [{sessionId:id,processId:22,ancestors:[11]}] : [];
  if (options.ambiguous) owners.push({sessionId:requestId,processId:23,ancestors:[11]});
  let resumed: ReturnType<typeof execution> | undefined;
  const disposable = { dispose() {} };
  const terminal: any = { name: "Codex", processId: Promise.resolve(11), show() {},
    sendText(text: string, newline: boolean) { sent.push(text); newlines.push(newline); },
    shellIntegration: { cwd: { fsPath: root }, executeCommand(executable: string, args: string[]) {
      launches.push([executable, ...args]);
      resumed = execution([executable, ...args].join(" "));
      events.start({ terminal, execution: resumed, shellIntegration: terminal.shellIntegration });
    } },
  };
  if (options.staleShellCwd) terminal.shellIntegration.cwd = {fsPath: path.join(root, "stale-directory")};
  if (options.missingShellCwd) terminal.shellIntegration.cwd = undefined;
  const secondTerminal = { ...terminal, processId: Promise.resolve(12) };
  const vscode = {
    env: { appName: "VS Code" }, Uri: { file: (value: string) => ({ fsPath: value }) },
    commands: { registerCommand() { return disposable; } },
    workspace: { workspaceFolders: [{ uri: { scheme: "file", fsPath: root } }],
      getConfiguration: () => ({ get: (key: string) => key === "enabled" || key === "cleanupStaleGoalDialogs" || (key === "continueInterruptedGoals" && continuationEnabled) }),
      onDidChangeConfiguration: (fn: any) => { events.config = fn; return disposable; },
    },
    window: { terminals: options.twoUnknown ? [terminal, secondTerminal] : [terminal], activeTerminal: terminal,
      createOutputChannel: () => ({ appendLine: (s: string) => messages.push(s), dispose() {} }),
      onDidStartTerminalShellExecution: (fn: any) => { events.start = fn; return disposable; },
      onDidEndTerminalShellExecution: (fn: any) => { events.end = fn; return disposable; },
      onDidCloseTerminal: (fn: any) => { events.close = fn; return disposable; },
      showWarningMessage: async (s: string) => { messages.push(s); },
      showInformationMessage: async () => {},
    },
  };
  const module = { exports: {} as any };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, process: options.autoDiscover ? { ...process, platform: "win32" } : process, console, Buffer,
    require: (name: string) => name === "vscode" ? vscode : name === "node:os" ? { ...os, homedir: () => root } : require(name),
    setTimeout, clearTimeout,
    setInterval: (fn: () => void, ms: number) => { intervals.set(ms, fn); return ms; },
    clearInterval: (ms: number) => intervals.delete(ms),
    testSessionCwd: root,
    readTestGoal: (threadId: string) => { if (options.goalUnavailable) throw new Error("goal API unavailable"); return goalCleared ? null : ({ threadId, objective: "Finish existing task", status, tokenBudget: 10000, tokensUsed: 100, createdAt: 1, ...goalChanges }); },
    getTestOwners: () => owners,
  });
  try {
    module.exports.activate({ subscriptions: [], extensionPath: root });
    const original = execution(((options.autoDiscover || options.twoUnknown) ? "codex" : `codex resume ${id}`) + (options.launchMode ? ` ${options.launchMode}` : ""));
    if (!options.recovered) events.start({ terminal, execution: original, shellIntegration: terminal.shellIntegration });
    if (options.twoUnknown) events.start({ terminal: secondTerminal, execution: execution("codex"), shellIntegration: terminal.shellIntegration });
    if (options.autoDiscover && !options.ambiguous) await until(() => messages.some(s => s.includes("Automatically identified")));
    const bridge = path.join(root, ".codex-switcher", "ide-bridge");
    const requestPath = path.join(bridge, "requests", `${requestId}.json`);
    await fs.mkdir(path.dirname(requestPath), { recursive: true });
    const request = { version: 1, requestId, tool: "codex", phase: "prepare", createdAtMs: Date.now() };
    await fs.writeFile(requestPath, JSON.stringify(request));
    intervals.get(250)!();
    const responsesDir = path.join(bridge, "responses");
    await until(async () => (await fs.readdir(responsesDir).catch(() => [])).some(name => name.endsWith(".json")));
    const responseFile = (await fs.readdir(responsesDir)).find(name => name.endsWith(".json"))!;
    const response = JSON.parse(await fs.readFile(path.join(responsesDir, responseFile), "utf8"));
    if (options.twoUnknown) { assert.equal(response.sessions.length, 2); return; }
    if (options.ambiguous) {
      assert.equal(response.sessions[0].sessionId, undefined);
      assert.equal(response.sessions[0].goal, undefined);
      assert.equal(messages.some(s => s.includes("Automatically identified")), false);
      return;
    }
    assert.equal(response.sessions[0].sessionId, id);
    assert.equal(JSON.stringify(response).includes("Finish existing task"), false, "bridge must not persist the goal objective");
    assert.equal(response.sessions[0].cwd, root);
    if (options.staleShellCwd) terminal.shellIntegration.cwd = {fsPath:root};
    events.end({ terminal, execution: original });
    owners = [];
    goalChanges = options.beforeLaunch ?? {};
    if (options.disableBeforeReady) continuationEnabled = false;
    await fs.writeFile(requestPath, JSON.stringify({ ...request, phase: options.phase ?? "ready", completedAtMs: Date.now() }));
    intervals.get(250)!();
    if (options.phase === "cancelled") {
      await until(() => messages.some(s => s.includes("Discarded cancelled")));
      assert.equal(launches.length, 0);
    } else {
      await until(() => launches.length === 1);
      assert.deepEqual(launches[0], ["codex", "resume", id, ...(options.expectedYolo === false ? [] : ["--yolo"])]);
      if (options.exitStartup) {
        events.end({terminal,execution:resumed,exitCode:1});
        assert.ok(messages.some(s => s.includes("exited with code 1")));
        assert.ok(messages.some(s => s.includes("exited during startup")));
        assert.ok(!messages.some(s => s.includes("Verified running")));
        return;
      }
      status = "paused";
      goalChanges = { ...goalChanges, ...options.atReady };
      goalCleared = options.clearAtReady ?? false;
      resumed!.push(options.readyText ?? "Goal paused (/goal resume)");
      if (options.clearAfterPrompt) {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(sent.length, 0);
        goalCleared = true;
        intervals.get(2000)!();
      }
      const eligibleCapture = ["active", "usageLimited"].includes(options.capturedStatus ?? "active");
      if (options.expectCleanup) {
        await until(() => sent.length === 1);
        assert.deepEqual(sent, ["\x1b"]);
        assert.deepEqual(newlines, [false]);
      } else if (options.expectContinuation ?? (eligibleCapture && !options.disableBeforeReady)) {
        await until(() => sent.length === 1);
        resumed!.push("Goal paused (/goal resume)");
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(sent, [options.readyText?.includes("Resume paused goal?") ? "" : "/goal resume"]);
      } else {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(sent.length, 0);
      }
      // Repeated polling of a completed bridge request must not relaunch it.
      intervals.get(250)!();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(launches.length, 1);
    }
  } finally {
    await module.exports.deactivate();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("full bridge resumes the exact session and continues its interrupted goal once", () => scenario());
test("bridge preserves explicit YOLO mode", () => scenario({launchMode:"--yolo"}));
test("bridge preserves the long YOLO alias", () => scenario({launchMode:"--dangerously-bypass-approvals-and-sandbox"}));
test("bridge suppresses YOLO for an explicitly guarded launch", () => scenario({launchMode:"--sandbox workspace-write",expectedYolo:false}));
test("full bridge recognizes the specific paused-goal startup choice", () => scenario({ readyText: "Resume paused goal?\nMark it active and continue when idle" }));
test("a previously paused goal is reopened without automatic continuation", () => scenario({ capturedStatus: "paused" }));
test("disabling continuation before ready preserves plain exact resume", () => scenario({ disableBeforeReady: true }));
test("a cancelled account switch never resumes a terminal", () => scenario({ phase: "cancelled" }));
test("a quota-limited goal can continue after switching", () => scenario({ capturedStatus: "usageLimited" }));
test("a goal deliberately paused during the switch stays paused", () => scenario({ beforeLaunch: { status: "paused" }, expectContinuation: false }));
test("a replaced goal at readiness is not continued", () => scenario({ atReady: { objective: "Different task" }, expectContinuation: false }));
test("a changed budget at readiness prevents continuation", () => scenario({ atReady: { tokenBudget: 20000 }, expectContinuation: false }));
test("an exhausted goal budget at readiness prevents continuation", () => scenario({ atReady: { tokensUsed: 10000 }, expectContinuation: false }));
test("a completed goal at readiness stays stopped", () => scenario({ atReady: { status: "complete" }, expectContinuation: false }));
test("a blocked goal at readiness stays stopped", () => scenario({ atReady: { status: "blocked" }, expectContinuation: false }));
test("an already running goal needs no extra input", () => scenario({ readyText: "Pursuing goal", atReady: { status: "active" }, expectContinuation: false }));
test("an unrelated approval prompt receives no goal command", () => scenario({ readyText: "Do you trust the contents of this directory?", expectContinuation: false }));
test("a fresh codex command is automatically identified and exactly resumed", () => scenario({ autoDiscover: true }));
test("a running terminal recovered after editor reload is automatically identified and resumed", () => scenario({ autoDiscover: true, recovered: true }));
test("ambiguous process ownership is never captured as an exact goal session", () => scenario({ autoDiscover: true, ambiguous: true }));
const fullDialog = "Resume paused goal?\nMark it active and continue when idle\nKeep it paused; use /goal resume later";
test("cleared captured goal dismisses its startup dialog without a resume command", () => scenario({readyText:fullDialog,clearAtReady:true,expectCleanup:true}));
test("completed captured goal dismisses its startup dialog", () => scenario({readyText:fullDialog,atReady:{status:"complete"},expectCleanup:true}));
test("a paused goal cleared after its dialog appears is cleaned up on the next check", () => scenario({capturedStatus:"paused",readyText:fullDialog,clearAfterPrompt:true,expectCleanup:true}));
test("a still-valid paused goal keeps its startup dialog", () => scenario({capturedStatus:"paused",readyText:fullDialog,expectContinuation:false}));

test("recovered terminals without shell cwd use their process-owned session directory", () => scenario({autoDiscover:true,recovered:true,missingShellCwd:true}));
test("goal API failure does not prevent capturing and reopening a recovered conversation", () => scenario({autoDiscover:true,recovered:true,goalUnavailable:true,expectContinuation:false}));
test("two unlinked terminals sharing a directory are captured separately", () => scenario({twoUnknown:true}));

test("recovered terminals use session cwd when shell cwd is stale", () => scenario({autoDiscover:true,recovered:true,staleShellCwd:true}));
test("a resumed command exiting during startup is reported as failure", () => scenario({exitStartup:true}));
