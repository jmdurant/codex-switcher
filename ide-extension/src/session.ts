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

export function resumeInvocation(tool: ResumeTool, sessionId?: string): ResumeInvocation {
  if (sessionId !== undefined && !UUID.test(sessionId)) throw new Error("Invalid Codex session ID.");
  return tool === "codex"
    ? {
        executable: "codex",
        args: ["resume", sessionId ?? "--last"],
        commandLine: `codex resume ${sessionId ?? "--last"}`,
      }
    : {
        executable: "agy",
        args: ["--continue"],
        commandLine: "agy --continue",
      };
}
