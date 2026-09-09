import * as path from "node:path";

export type ResumeTool = "codex" | "agy";

export interface ResumeInvocation {
  executable: string;
  args: string[];
  commandLine: string;
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
export function sessionIdFromCommand(commandLine: string): string | undefined {
  if (classifyCommand(commandLine) !== "codex") return undefined;
  const tokens = commandLine.trim().replace(/^&\s+/, "").match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  if (tokens.some(token => token === "--remote" || token.startsWith("--remote="))) return undefined;
  if (tokens[1] !== "resume") return undefined;
  const id = tokens[2]?.replace(/^['"]|['"]$/g, "");
  return id && UUID.test(id) ? id.toLowerCase() : undefined;
}

/** Only inspect launch options, never flag-looking text in a prompt or option value. */
export function yoloFromCommand(commandLine: string): boolean | undefined {
  if (classifyCommand(commandLine) !== "codex") return undefined;
  const tokens = commandLine.trim().replace(/^&\s+/, "").match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  let mode: boolean | undefined;
  let resume = false;
  let session = false;
  const values = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "--add-dir", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image"]);
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i].replace(/^['"]|['"]$/g, "");
    if (token === "--") break;
    if (token === "resume" && i === 1) { resume = true; continue; }
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

export function resumeInvocation(tool: ResumeTool, sessionId?: string, yolo?: boolean): ResumeInvocation {
  if (sessionId !== undefined && !UUID.test(sessionId)) throw new Error("Invalid Codex session ID.");
  return tool === "codex"
    ? {
        executable: "codex",
        args: ["resume", sessionId ?? "--last", ...(yolo === false ? [] : ["--yolo"])],
        commandLine: `codex resume ${sessionId ?? "--last"}${yolo === false ? "" : " --yolo"}`,
      }
    : {
        executable: "agy",
        args: ["--continue"],
        commandLine: "agy --continue",
      };
}
