import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { SESSION_ID } from "./goal.ts";

export interface SessionOwner { sessionId: string; processId: number; ancestors: number[] }
export function parseOwners(value: unknown): SessionOwner[] {
  if (!Array.isArray(value)) throw new Error("Invalid session discovery response.");
  return value.filter((row): row is SessionOwner => Boolean(row && SESSION_ID.test(row.sessionId) &&
    Number.isSafeInteger(row.processId) && row.processId > 0 && Array.isArray(row.ancestors) &&
    row.ancestors.every((pid: unknown) => Number.isSafeInteger(pid) && Number(pid) > 0)));
}
/** Match ancestry, never timestamps or the latest conversation in a directory. */
export function ownerForTerminal(owners: SessionOwner[], terminalPid: number): SessionOwner | undefined {
  const matches = owners.filter(owner => owner.ancestors.includes(terminalPid));
  // Nested Codex instances and multiple thread locks are ambiguous: fail closed.
  const unique = new Map(matches.map(owner => [`${owner.processId}:${owner.sessionId}`, owner]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}
export async function discoverSessions(scriptPath: string): Promise<SessionOwner[]> {
  if (process.platform !== "win32") return [];
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await promisify(execFile)(executable, ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
    windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024,
  });
  return parseOwners(JSON.parse(stdout.replace(/^\uFEFF/, "")));
}
