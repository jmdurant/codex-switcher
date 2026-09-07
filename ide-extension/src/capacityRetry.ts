import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cleanTerminalText, fingerprint, SESSION_ID, type Goal } from "./goal.ts";
import { isNonVisualUpdate } from "./goalDialogCleanup.ts";

export interface RetryTurn { id: string; status: string; error?: { codexErrorInfo?: unknown }; completedAt?: number }
export function overloaded(turn: RetryTurn | null): turn is RetryTurn {
  return turn?.status === "failed" && turn.error?.codexErrorInfo === "serverOverloaded";
}
export function retryDelay(attempt: number, random = Math.random()): number {
  return [30, 60, 120, 240, 300][Math.min(attempt, 4)]! * 1000 + Math.floor(random * 5000);
}
export function goalKey(goal: Goal | null): string | undefined {
  if (goal === null) return "none";
  if (goal.status !== "active" || (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget)) return undefined;
  return `${fingerprint(goal)}:${goal.tokenBudget}`;
}

/** A narrow live observation, never a search of historical scrollback.
 * Any later screen change invalidates it; title-only updates do not. */
export class RetryPrompt {
  private text = "";
  observedAt = 0;
  revision = 0;
  observe(chunk: string): void {
    if (isNonVisualUpdate(chunk)) return;
    this.revision++;
    if (this.observedAt) this.text = "";
    this.observedAt = 0;
    const erased = Math.max(chunk.lastIndexOf("\x1b[2J"), chunk.lastIndexOf("\x1b[3J"));
    if (erased >= 0) { this.text = ""; chunk = chunk.slice(erased + 4); }
    this.text = (this.text + chunk).slice(-4096);
    const text = cleanTerminalText(this.text);
    // Only this known CLI placeholder is supported. Other prompts fall back to Ask.
    const match = /(?:^|\n)[ \t]*› Ask Codex to do anything[ \t]*(?:\n|$)/.exec(text);
    const after = match ? text.slice(match.index + match[0].length).trim() : "";
    if (match && (!after || /^gpt-[\w.-]+[^\n]*$/.test(after)) &&
        !/Resume paused goal\?|esc to interrupt|Press enter to confirm|Goal paused/i.test(text)) this.observedAt = Date.now();
  }
  invalidate(): void { this.text = ""; this.observedAt = 0; this.revision++; }
}

/** Exclusive per-session lock + durable attempt claims across editor hosts/reloads.
 * A crashed holder fails closed; no stale lock is automatically stolen. */
export class RetryLedger {
  private root: string;
  constructor(root: string) { this.root = root; }
  async claim(session: string, turn: string, now = Date.now()): Promise<boolean> {
    if (!SESSION_ID.test(session) || !SESSION_ID.test(turn)) return false;
    await fs.mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, `${session}.lock`);
    let handle;
    try { handle = await fs.open(lock, "wx"); } catch (error: any) { if (error.code === "EEXIST") return false; throw error; }
    try {
      const file = path.join(this.root, `${session}.json`);
      let records: { turn: string; at: number }[] = [];
      try { records = JSON.parse(await fs.readFile(file, "utf8")); }
      catch (error: any) { if (error.code !== "ENOENT") return false; }
      if (!Array.isArray(records) || records.some(r => typeof r.turn !== "string" || !Number.isFinite(r.at))) return false;
      if (records.some(r => r.turn === turn) || records.filter(r => now - r.at < 3600000).length >= 5) return false;
      records.push({ turn, at: now });
      const temp = file + ".tmp";
      await fs.writeFile(temp, JSON.stringify(records));
      await fs.rename(temp, file);
      return true;
    } finally { await handle.close(); await fs.unlink(lock); }
  }
  async count(session: string, now = Date.now()): Promise<number> {
    if (!SESSION_ID.test(session)) return 5;
    try {
      const records = JSON.parse(await fs.readFile(path.join(this.root, `${session}.json`), "utf8"));
      if (!Array.isArray(records)) return 5;
      return records.filter(r => !Number.isFinite(r.at) || now - r.at < 3600000).length;
    } catch (error: any) { return error.code === "ENOENT" ? 0 : 5; }
  }
}
