import * as xterm from "@xterm/headless";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { sessionIdFromStatus } from "./goal.ts";

export interface TerminalSnapshot {
  text: string;
  composer: "empty" | "status" | "other";
  composerReason?: string;
  statusId?: string;
  statusRevision: number;
}

/** In-memory rendering of the output stream; never opens editor UI or stores text. */
export class TerminalScreen {
  private terminal: XtermTerminal;
  private pending: Promise<void> = Promise.resolve();
  private statusId?: string;
  private statusRevision = 0;
  private tail = "";
  constructor(cols = 120, rows = 40) {
    const Terminal = (xterm as any).Terminal ?? (xterm as any).default.Terminal;
    this.terminal = new Terminal({cols, rows, scrollback: 200, allowProposedApi: true});
  }
  write(data: string): void {
    this.tail = (this.tail + data).slice(-8192);
    const observed = sessionIdFromStatus(this.tail);
    if (observed) {
      this.statusId = observed;
      this.statusRevision++;
      this.tail = "";
    }
    this.pending = this.pending.then(() => new Promise<void>(resolve => this.terminal.write(data, resolve)));
  }
  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(2, cols), Math.max(2, rows));
  }
  async snapshot(): Promise<TerminalSnapshot> {
    await this.pending;
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = Math.max(0, buffer.baseY - 80); y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    const text = lines.join("\n");
    // Alternate-screen redraws position each row independently, so stripping
    // ANSI from raw chunks can concatenate the Session label with prior rows.
    const renderedId = sessionIdFromStatus(text);
    if (renderedId && renderedId !== this.statusId) {
      this.statusId = renderedId;
      this.statusRevision++;
    }
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const prefix = line?.translateToString(false, 0, buffer.cursorX) ?? "";
    const suffix = line?.translateToString(true, buffer.cursorX) ?? "";
    let composer: TerminalSnapshot["composer"] = "other";
    let composerReason = "cursor_not_at_empty_composer";
    // The cursor sits just after the prompt for an empty composer. Placeholder
    // cells must be dim, so actual input is never mistaken for a suggestion.
    if (/^\s*› $/.test(prefix) && suffix.trim()) {
      let placeholder = true;
      for (let x = buffer.cursorX; x < (line?.length ?? 0); x++) {
        const cell = line?.getCell(x);
        if (cell?.getChars().trim() && !cell.isDim()) { placeholder = false; break; }
      }
      if (placeholder) { composer = "empty"; composerReason = "empty_placeholder"; }
      else composerReason = "visible_input_at_cursor";
    }
    if (/^\s*› \/status$/.test(prefix) && !suffix.trim()) composer = "status";
    return {text, composer, composerReason, statusId: this.statusId, statusRevision: this.statusRevision};
  }
  dispose(): void { void this.pending.then(() => this.terminal.dispose()); }
}
