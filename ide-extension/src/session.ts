import * as path from "node:path";

export type ResumeTool = "codex" | "agy";

export interface ResumeInvocation {
  executable: string;
  args: string[];
  commandLine: string;
}

/** Only launch settings are persisted, never a prompt or remote credentials. */
export interface ResumeLaunch { args: string[]; executable?: string; }
const VALUE_OPTIONS = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--enable", "--disable", "--local-provider"]);
const FLAG_OPTIONS = new Set(["--no-daemon", "--strict-config", "--oss", "--search", "--no-alt-screen", "--yolo", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "--full-auto"]);

function literalTokens(commandLine: string): string[] {
  const tokens: string[] = [];
  let token = "", quote = "", started = false;
  const text = commandLine.trim().replace(/^&\s+/, "");
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if ((quote !== "'" && /[$`]/.test(char)) || /[\r\n\0]/.test(char) || (!quote && /[;&|<>]/.test(char))) {
      throw new Error("Cannot safely preserve shell expansions or compound Codex commands. Use literal launch options.");
    }
    if ((char === "\\" && quote !== "'" && /[\s'\"]/.test(text[index + 1] ?? "")) ||
        (!quote && /[*?~]/.test(char)) || (quote && char === quote && text[index + 1] === quote)) {
      throw new Error("Cannot safely preserve ambiguous shell escaping. Quote complete option values literally.");
    }
    if (quote) {
      if (char === quote) quote = ""; else token += char;
      started = true;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ""; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) throw new Error("Cannot preserve an incomplete quoted Codex launch option.");
  if (started) tokens.push(token);
  return tokens;
}

export function launchFromCommand(commandLine: string): ResumeLaunch | undefined {
  if (classifyCommand(commandLine) !== "codex") return undefined;
  return launchFromArgs(literalTokens(commandLine));
}

export function launchFromArgs(tokens: readonly string[]): ResumeLaunch {
  const args: string[] = [];
  let resume = false, session = false, prompt = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i], key = token.split("=")[0];
    if (token === "--") break;
    if (token === "resume" && !resume) { resume = true; continue; }
    if (!resume && ["exec", "e", "review", "fork", "login", "logout", "app-server", "mcp", "mcp-server", "completion", "debug", "features"].includes(token)) {
      throw new Error("Only interactive Codex conversations can be captured for resume.");
    }
    if (resume && !session && UUID.test(token)) { session = true; continue; }
    if (["--last", "--all", "--include-non-interactive", "--worktree"].includes(token)) continue;
    if (key === "--remote" || key === "--remote-auth-token-env") throw new Error("Remote Codex sessions cannot be switched through local credentials.");
    if (key === "-i" || key === "--image") { if (!token.includes("=")) i++; continue; }
    if (FLAG_OPTIONS.has(token)) { args.push(token); continue; }
    if (VALUE_OPTIONS.has(key)) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : tokens[++i];
      if (value === undefined || /[\r\n\0]/.test(value)) throw new Error(`Cannot preserve Codex option ${key}.`);
      args.push(key, value); continue;
    }
    if (!token.startsWith("-")) {
      if (prompt) throw new Error("Ambiguous Codex launch arguments; quote the initial prompt as one argument.");
      prompt = true; continue; // The initial prompt is never replayed.
    }
    throw new Error(`Unsupported Codex launch option ${key}; relaunch with supported options before switching.`);
  }
  return { args, executable: tokens[0] };
}

function checkedLaunchArgs(launch: ResumeLaunch): string[] {
  if (!Array.isArray(launch.args) || launch.args.length > 128) throw new Error("Invalid saved Codex launch options.");
  for (let i = 0; i < launch.args.length; i++) {
    const flag = launch.args[i];
    if (FLAG_OPTIONS.has(flag)) continue;
    if (!VALUE_OPTIONS.has(flag) || typeof launch.args[++i] !== "string" || /[\r\n\0]/.test(launch.args[i])) throw new Error("Invalid saved Codex launch options.");
  }
  return [...launch.args];
}

/** Fallback is usable only for literal shell-safe arguments. Complex options
 * require executeCommand's argument-aware shell integration. */
export function hasShellSafeArguments(invocation: ResumeInvocation): boolean {
  return [invocation.executable, ...invocation.args].every(arg => /^[a-zA-Z0-9_./:=@,+-]+$/.test(arg));
}

export function classifyCommand(commandLine: string): ResumeTool | undefined {
  const trimmed = commandLine.trim().replace(/^&\s+/, "");
  const firstToken = trimmed.match(/^(?:"[^"]+"|'[^']+'|\S+)/)?.[0];
  if (!firstToken) return undefined;
  // Commands may use either path convention regardless of the extension host.
  const executable = path.win32
    .basename(firstToken.replace(/^['"]|['"]$/g, ""))
    .toLowerCase();
  if (["codex", "codex.exe", "codex.cmd", "codex.ps1"].includes(executable)) {
    return "codex";
  }
  if (["agy", "agy.exe", "agy.cmd", "agy.ps1"].includes(executable)) {
    return "agy";
  }
  return undefined;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function commandTokens(commandLine: string): string[] {
  let tokens: string[];
  try { tokens = literalTokens(commandLine); } catch { return []; }
  if (tokens.some(token => token === "--remote" || token.startsWith("--remote="))) return [];
  // Global options may precede resume; options may also precede its session ID.
  const positional = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i], key = token.split("=")[0];
    if (VALUE_OPTIONS.has(key) || key === "--image" || key === "-i") { if (!token.includes("=")) i++; continue; }
    if (FLAG_OPTIONS.has(token) || ["--all", "--include-non-interactive"].includes(token)) continue;
    positional.push(token);
    if (positional.length >= 3) break;
  }
  return positional;
}
export function sessionIdFromCommand(commandLine: string): string | undefined {
  if (classifyCommand(commandLine) !== "codex") return undefined;
  const tokens = commandTokens(commandLine);
  if (tokens.some(token => token === "--remote" || token.startsWith("--remote="))) return undefined;
  if (tokens[1] !== "resume") return undefined;
  const id = tokens[2]?.replace(/^['"]|['"]$/g, "");
  return id && UUID.test(id) ? id.toLowerCase() : undefined;
}

export function isLastResumeCommand(commandLine: string): boolean {
  if (classifyCommand(commandLine) !== "codex") return false;
  const tokens = commandTokens(commandLine);
  return tokens[1] === "resume" && (tokens[2] === "--last" || tokens[2] === undefined);
}

/** Only inspect launch options, never flag-looking text in a prompt or option value. */
export function yoloFromCommand(commandLine: string): boolean | undefined {
  if (classifyCommand(commandLine) !== "codex") return undefined;
  let tokens: string[];
  try { tokens = literalTokens(commandLine); } catch { return undefined; }
  let mode: boolean | undefined;
  let resume = false;
  let session = false;
  const values = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "--add-dir", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image"]);
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i].replace(/^['"]|['"]$/g, "");
    if (token === "--") break;
    if (token === "resume" && !resume) { resume = true; continue; }
    if (resume && !session && UUID.test(token)) { session = true; continue; }
    if (token === "--yolo" || token === "--dangerously-bypass-approvals-and-sandbox") { mode = true; continue; }
    if (["--full-auto", "--approve-for-me"].includes(token)) { mode = false; continue; }
    const key = token.split("=")[0];
    if (["-s", "--sandbox", "-a", "--ask-for-approval"].includes(key)) {
      mode = false;
      if (!token.includes("=")) i++;
      continue;
    }
    if (values.has(key)) { if (!token.includes("=")) i++; continue; }
    if (!token.startsWith("-")) break;
  }
  return mode;
}

export function resumeInvocation(tool: ResumeTool, sessionId?: string, yolo?: boolean, launch?: ResumeLaunch): ResumeInvocation {
  if (sessionId !== undefined && !UUID.test(sessionId)) throw new Error("Invalid Codex session ID.");
  const executable = launch?.executable ?? "codex";
  if (tool === "codex" && (!/^(codex|codex\.exe|codex\.cmd|codex\.ps1)$/i.test(path.win32.basename(executable)) || /[\r\n\0]/.test(executable))) throw new Error("Invalid saved Codex executable.");
  const args = ["resume", sessionId ?? "--last", ...(launch ? checkedLaunchArgs(launch) : yolo === true ? ["--yolo"] : [])];
  return tool === "codex"
    ? {
        executable,
        args,
        commandLine: `${executable} ${args.join(" ")}`,
      }
    : {
        executable: "agy",
        args: ["--continue"],
        commandLine: "agy --continue",
      };
}
