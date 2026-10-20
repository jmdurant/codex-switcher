import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { SESSION_ID } from "./goal.ts";

export interface SessionOwner { sessionId: string; processId: number; ancestors: number[]; commandLine?: string }
export interface UnixCodexProcess { processId: number; ancestors: number[]; cwd: string; sessionId?: string; commandLine: string; argv?: string[] }
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

/** Parse lsof's machine-readable names, shared by macOS and other Unix hosts. */
export function lsofNames(output: string): string[] {
  return output.split(/[\n\0]/).filter(line => line.startsWith("n")).map(line => line.slice(1));
}
export function sessionFromOpenFiles(files: string[]): string | undefined {
  const ids = new Set(files.flatMap(file => {
    const match = file.match(/(?:^|\/)thread-writer-locks\/([^/]+)\.lock$/);
    return match && SESSION_ID.test(match[1]) ? [match[1].toLowerCase()] : [];
  }));
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Discover terminal descendants and their own writer locks; shared daemon
 * locks cannot prove which conversation is attached to a terminal. */
export async function discoverUnixCodexProcesses(
  diagnostic?: (pid: number, outcome: string) => void,
): Promise<UnixCodexProcess[]> {
  if (process.platform === "win32") return [];
  const { stdout } = await promisify(execFile)("ps", ["-ww", "-eo", "pid=,ppid=,args="], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  const rows = new Map<number, { ppid: number; args: string }>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
  }
  const result: UnixCodexProcess[] = [];
  for (const [pid, row] of rows) {
    if (!/(^|\/)codex(?:\s|$)/.test(row.args) || /app-server|codex-switcher/.test(row.args)) continue;
    diagnostic?.(pid, "candidate");
    const ancestors: number[] = [pid];
    let parent = row.ppid;
    for (let i = 0; i < 32 && parent > 1; i++) {
      ancestors.push(parent);
      const next = rows.get(parent)?.ppid;
      if (!next || next === parent) break;
      parent = next;
    }
    try {
      let cwd: string | undefined, files: string[], argv: string[] | undefined;
      if (process.platform === "linux") {
        cwd = await fs.readlink(`/proc/${pid}/cwd`);
        argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
        const descriptors = await fs.readdir(`/proc/${pid}/fd`);
        files = (await Promise.all(descriptors.map(fd => fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => ""))));
      } else {
        const options = { timeout: 1500, maxBuffer: 2 * 1024 * 1024 };
        const [directory, open] = await Promise.all([
          promisify(execFile)("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], options),
          promisify(execFile)("lsof", ["-p", String(pid), "-Fn"], options),
        ]);
        cwd = lsofNames(directory.stdout)[0];
        files = lsofNames(open.stdout);
      }
      if (cwd?.startsWith("/")) {
        const sessionId = sessionFromOpenFiles(files);
        result.push({ processId: pid, ancestors, cwd: path.normalize(cwd), sessionId, commandLine: row.args, argv });
        diagnostic?.(pid, sessionId ? "exact_writer_lock" : "no_unique_writer_lock");
      } else diagnostic?.(pid, "cwd_unavailable");
    } catch (error) {
      // Process exits and access errors are expected during a snapshot. Report
      // only the error category, never process arguments or file contents.
      diagnostic?.(pid, `inspection_failed:${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
    }
  }
  return result;
}
