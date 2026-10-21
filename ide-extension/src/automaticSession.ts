import { sessionIdFromStatus } from "./goal.ts";

/** The buffer must belong to a terminal with exactly one native Codex descendant. */
export interface AutomaticSessionTerminal {
  valid(): boolean;
  read(): Promise<string | undefined>;
  status(): void;
  verify(id: string): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

/** Inspect only the current composer, never an old empty prompt in scrollback. */
export function emptyCodexComposer(buffer: string): boolean {
  const lines = buffer.trimEnd().split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && !/^\s*›/.test(lines[index])) index--;
  if (index < 0 || !/^\s*› Ask Codex to do anything\s*$/.test(lines[index])) return false;
  const footer = lines.slice(index + 1).filter(line => line.trim());
  return footer.length <= 2 && footer.every(line => /^\s*(?:gpt-[\w.-]+\b|\d+% context left\b)/i.test(line)) &&
    !/esc to interrupt|tab to queue|Resume paused goal\?|Press enter to confirm/i.test(lines.slice(Math.max(0, index - 2)).join("\n"));
}

function statusCount(buffer: string): number {
  return [...buffer.matchAll(/(?:^|\n)\s*(?:›\s*)?\/status\s*(?:\n|$)/g)].length;
}

/** Obtain fresh terminal-specific evidence even after shell execution events were lost. */
export async function identifyAutomaticSession(terminal: AutomaticSessionTerminal): Promise<string | undefined> {
  if (!terminal.valid()) return;
  const before = await terminal.read();
  if (!terminal.valid() || before === undefined || !emptyCodexComposer(before)) return;
  await terminal.wait(150);
  const current = await terminal.read();
  if (!terminal.valid() || current !== before || !emptyCodexComposer(current)) return;
  // No await between checking the fresh empty composer and the fixed slash command.
  terminal.status();
  for (let attempt = 0; attempt < 12; attempt++) {
    await terminal.wait(150);
    if (!terminal.valid()) return;
    const response = await terminal.read();
    if (!terminal.valid() || response === undefined) return;
    // A previous /status may describe another conversation. Require a newly
    // rendered response to the command we just sent before using its ID.
    if (statusCount(response) <= statusCount(before)) continue;
    const panel = response.slice(response.lastIndexOf("/status") + 7);
    const id = sessionIdFromStatus(panel);
    if (!id || !/\bModel:\s*\S/.test(panel) || !/\bDirectory:\s*\S/.test(panel)) continue;
    if (await terminal.verify(id) && terminal.valid()) return id;
    return;
  }
}
