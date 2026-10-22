import type { TerminalSnapshot } from "./terminalScreen.ts";

export interface AutomaticSessionTerminal {
  valid(): boolean;
  read(): Promise<TerminalSnapshot | undefined>;
  status(): void;
  enter(): void;
  verify(id: string): Promise<boolean>;
  wait(ms: number): Promise<void>;
  diagnostic?(reason: string): void;
}

/** Use only newly observed /status output; old scrollback never establishes identity. */
export async function identifyAutomaticSession(terminal: AutomaticSessionTerminal): Promise<string | undefined> {
  const defer = (reason: string) => { terminal.diagnostic?.(reason); return undefined; };
  if (!terminal.valid()) return;
  const before = await terminal.read();
  if (!terminal.valid()) return;
  if (!before) return defer("no_live_output");
  // A user-requested status response in this live output stream is exact evidence too.
  if (before.statusId && await terminal.verify(before.statusId) && terminal.valid()) return before.statusId;
  if (before.composer !== "empty") return defer(before.composerReason ?? "composer_not_empty");
  await terminal.wait(150);
  const current = await terminal.read();
  // /status is available while Codex is working. Agent output may change while
  // the user's composer stays empty; it must not prevent early identification.
  if (!terminal.valid() || current?.composer !== "empty") return defer("composer_changed");
  terminal.status();
  // Verify that the TUI echoed only our slash command before submitting it.
  await terminal.wait(150);
  const entered = await terminal.read();
  if (!terminal.valid() || entered?.composer !== "status") return defer("status_input_changed");
  terminal.enter();
  for (let attempt = 0; attempt < 20; attempt++) {
    await terminal.wait(150);
    if (!terminal.valid()) return;
    const response = await terminal.read();
    if (!terminal.valid() || !response) return;
    if (response.statusRevision <= before.statusRevision || !response.statusId) continue;
    if (await terminal.verify(response.statusId) && terminal.valid()) return response.statusId;
    return defer("status_verification_failed");
  }
  return defer("no_fresh_status_response");
}
