import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { SESSION_ID } from "./goal.ts";

export interface SessionOwner { sessionId: string; processId: number; ancestors: number[] }
export interface UnixCodexProcess { processId: number; ancestors: number[]; cwd: string }
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

/** Discover Codex processes below integrated-terminal shells on Linux. */
export async function discoverUnixCodexProcesses(): Promise<UnixCodexProcess[]> {
  if (process.platform === "win32") return [];
  const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,args="], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  const rows = new Map<number, { ppid: number; args: string }>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
  }
  const result: UnixCodexProcess[] = [];
  for (const [pid, row] of rows) {
    if (!/(^|\/)codex(?:\s|$)/.test(row.args) || /app-server|codex-switcher/.test(row.args)) continue;
    const ancestors: number[] = [pid];
    let parent = row.ppid;
    for (let i = 0; i < 32 && parent > 1; i++) {
      ancestors.push(parent);
      const next = rows.get(parent)?.ppid;
      if (!next || next === parent) break;
      parent = next;
    }
    try {
      const cwd = await fsReadlink(`/proc/${pid}/cwd`);
      if (cwd.startsWith("/")) result.push({ processId: pid, ancestors, cwd: path.normalize(cwd) });
    } catch { /* process exited during the snapshot */ }
  }
  return result;
}

async function fsReadlink(file: string): Promise<string> {
  const { stdout } = await promisify(execFile)("readlink", ["-f", file], { timeout: 1000 });
  return stdout.trim();
}
