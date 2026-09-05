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

export function resumeInvocation(tool: ResumeTool): ResumeInvocation {
  return tool === "codex"
    ? {
        executable: "codex",
        args: ["resume", "--last"],
        commandLine: "codex resume --last",
      }
    : {
        executable: "agy",
        args: ["--continue"],
        commandLine: "agy --continue",
      };
}
