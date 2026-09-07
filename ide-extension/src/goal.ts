import { createHash } from "node:crypto";

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface Goal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  createdAt: number;
}
export interface GoalCapture {
  fingerprint: string;
  status: "active" | "usageLimited";
  tokenBudget: number | null;
  tokensUsed: number;
}

export function validGoal(value: unknown, threadId: string): value is Goal {
  if (!value || typeof value !== "object") return false;
  const g = value as Goal;
  return g.threadId === threadId && typeof g.objective === "string" && g.objective.trim().length > 0 &&
    ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(g.status) &&
    Number.isFinite(g.createdAt) && Number.isFinite(g.tokensUsed) && g.tokensUsed >= 0 &&
    (g.tokenBudget === null || (Number.isFinite(g.tokenBudget) && g.tokenBudget > 0));
}
export function fingerprint(goal: Goal): string {
  return createHash("sha256").update(JSON.stringify([goal.threadId, goal.createdAt, goal.objective])).digest("hex");
}
export function captureGoal(goal: Goal | null): GoalCapture | undefined {
  if (!goal || !["active", "usageLimited"].includes(goal.status) || (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget)) return undefined;
  return { fingerprint: fingerprint(goal), status: goal.status as GoalCapture["status"], tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed };
}
export function canContinueGoal(capture: GoalCapture, goal: Goal | null): boolean {
  return Boolean(goal && ["active", "paused", "usageLimited"].includes(goal.status) &&
    fingerprint(goal) === capture.fingerprint && goal.tokenBudget === capture.tokenBudget &&
    goal.tokensUsed >= capture.tokensUsed && (goal.tokenBudget === null || goal.tokensUsed < goal.tokenBudget));
}

export function cleanTerminalText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
}

/** Only a /status-style labelled ID is accepted, never arbitrary UUIDs in output. */
export function sessionIdFromStatus(text: string): string | undefined {
  const matches = [...cleanTerminalText(text).matchAll(/(?:^|\n|[│┃])\s*Session(?:\s+ID)?\s*:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi)];
  return matches.at(-1)?.[1].toLowerCase();
}

export type GoalReadyAction = "confirm" | "resume" | "running";
export function goalReadyAction(text: string): GoalReadyAction | undefined {
  const clean = cleanTerminalText(text);
  if (clean.includes("Resume paused goal?") && clean.includes("Mark it active and continue when idle")) return "confirm";
  if (/Goal (?:paused|hit usage limits)\s*\(\/goal resume\)/.test(clean)) return "resume";
  if (clean.includes("Pursuing goal")) return "running";
  return undefined;
}
