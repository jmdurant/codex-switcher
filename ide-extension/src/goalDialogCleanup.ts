import { cleanTerminalText, fingerprint, type Goal } from "./goal.ts";

/** These complete sequences change titles/rendering metadata, not screen text.
 * Erases, cursor movement, printable text and incomplete sequences stay significant. */
export function isNonVisualUpdate(chunk: string): boolean {
  return chunk.replace(/\x1b\](?:0|2);[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(?:[0-9;]*m|\?(?:2026|25)[hl])/g, "") === "";
}

/** Conservative observer: screen-affecting output after a recognized prompt invalidates it.
 * A later complete prompt can re-arm it. Never act on an old scrollback match. */
export class GoalDialogCleanup {
  private buffer = "";
  private revision = 0;
  private visible = false;
  private dismissed = false;
  private checking = false;
  private timer?: ReturnType<typeof setInterval>;
  private deadline = 0;
  private armDeadline = Date.now() + 60000;
  private options: {
    expectedFingerprint?: string;
    readGoal: () => Promise<Goal | null>;
    valid: () => boolean;
    dismiss: () => void;
  };
  constructor(options: GoalDialogCleanup["options"]) { this.options = options; }

  observe(chunk: string): void {
    if (isNonVisualUpdate(chunk)) return;
    this.revision++;
    if (this.visible) this.buffer = "";
    this.visible = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.dismissed || !this.options.valid()) return;
    if (Date.now() > this.armDeadline) { this.dispose(); this.dismissed = true; return; }
    // Discard text erased by a full-screen redraw before recognizing a prompt.
    const erased = Math.max(chunk.lastIndexOf("\x1b[2J"), chunk.lastIndexOf("\x1b[3J"));
    if (erased >= 0) { this.buffer = ""; chunk = chunk.slice(erased + 4); }
    this.buffer = (this.buffer + chunk).slice(-8192);
    const text = cleanTerminalText(this.buffer);
    const start = text.lastIndexOf("Resume paused goal?");
    if (start < 0) return;
    const dialog = text.slice(start);
    if (!dialog.includes("Mark it active and continue when idle") ||
        !dialog.includes("Keep it paused; use /goal resume later")) return;
    this.visible = true;
    this.deadline = Date.now() + 5 * 60000;
    this.armDeadline = this.deadline;
    this.timer = setInterval(() => void this.check(), 2000);
    void this.check();
  }

  async check(): Promise<void> {
    if (!this.visible || this.dismissed || this.checking || !this.options.valid()) return;
    if (Date.now() > this.deadline) { this.dispose(); return; }
    const revision = this.revision;
    const current = () => this.visible && !this.dismissed && revision === this.revision && this.options.valid();
    const stale = (goal: Goal | null) => goal === null || (goal.status === "complete" &&
      this.options.expectedFingerprint !== undefined && fingerprint(goal) === this.options.expectedFingerprint);
    this.checking = true;
    try {
      const first = await this.options.readGoal();
      if (!current() || !stale(first)) return;
      // Recheck after the first read: a replacement or resumed goal cancels cleanup.
      const second = await this.options.readGoal();
      if (!current() || !stale(second)) return;
      this.dismissed = true;
      this.dispose();
      this.options.dismiss();
    } catch { /* Unavailable is not the same as cleared. Leave the dialog alone. */ }
    finally { this.checking = false; }
  }

  dispose(): void {
    this.revision++;
    this.visible = false;
    this.buffer = "";
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
