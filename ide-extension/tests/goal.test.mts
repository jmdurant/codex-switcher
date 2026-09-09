import assert from "node:assert/strict";
import test from "node:test";
import { canContinueGoal, captureGoal, cleanTerminalText, goalReadyAction, sessionIdFromStatus, validGoal, type Goal } from "../src/goal.ts";
import { sessionIdFromCommand, resumeInvocation } from "../src/session.ts";

const id = "01991234-1234-7123-8123-123456789abc";
const goal: Goal = { threadId: id, objective: "Finish the migration", status: "active", tokenBudget: 10000, tokensUsed: 100, createdAt: 10 };

test("only running and quota-limited goals are eligible at capture", () => {
  for (const status of ["active", "usageLimited"] as const) assert.ok(captureGoal({ ...goal, status }));
  for (const status of ["paused", "blocked", "budgetLimited", "complete"] as const) assert.equal(captureGoal({ ...goal, status }), undefined);
  assert.equal(captureGoal(null), undefined);
  assert.equal(captureGoal({ ...goal, tokensUsed: 10000 }), undefined);
});
test("resume preserves identity, budget, and accumulated usage", () => {
  const captured = captureGoal(goal)!;
  assert.equal(canContinueGoal(captured, { ...goal, status: "paused", tokensUsed: 150 }), true);
  assert.equal(canContinueGoal(captured, { ...goal, status: "usageLimited" }), true);
  for (const changed of [
    { ...goal, objective: "A different goal" }, { ...goal, createdAt: 11 },
    { ...goal, threadId: "another-thread" }, { ...goal, tokenBudget: 20000 },
    { ...goal, tokensUsed: 10 }, { ...goal, tokensUsed: 10000 },
    ...(["complete", "blocked", "budgetLimited"] as const).map(status => ({ ...goal, status })),
  ]) assert.equal(canContinueGoal(captured, changed), false);
  assert.equal(canContinueGoal(captured, null), false);
  assert.equal("objective" in captured, false, "bridge does not store the goal objective");
});
test("unbudgeted goals stay unbudgeted", () => {
  const unlimited = { ...goal, tokenBudget: null };
  assert.equal(canContinueGoal(captureGoal(unlimited)!, { ...unlimited, tokensUsed: 900000 }), true);
});
test("malformed and foreign goal responses are rejected", () => {
  assert.equal(validGoal(goal, id), true);
  for (const value of [null, {}, { ...goal, threadId: "other" }, { ...goal, status: "future-state" }, { ...goal, tokensUsed: NaN }, { ...goal, tokenBudget: -1 }]) assert.equal(validGoal(value, id), false);
});
test("exact command capture never mistakes prompts or shell text for a session ID", () => {
  assert.equal(sessionIdFromCommand(`codex resume ${id}`), id);
  assert.equal(sessionIdFromCommand(`& 'C:\\tools\\codex.ps1' resume '${id}'`), id);
  for (const line of [`echo codex resume ${id}`, "codex resume --last", `codex 'explain resume ${id}'`, `codex resume ${id};echo`, "agy --continue"]) assert.equal(sessionIdFromCommand(line), undefined);
  assert.deepEqual(resumeInvocation("codex", id).args, ["resume", id, "--yolo"]);
  assert.throws(() => resumeInvocation("codex", "x;echo unsafe"));
});
test("status detection requires an explicit session label", () => {
  assert.equal(sessionIdFromStatus(`│ Session: ${id} │`), id);
  assert.equal(sessionIdFromStatus(`\u001b[32mSession ID: ${id}\u001b[0m`), id);
  assert.equal(sessionIdFromStatus(`A file contains ${id}`), undefined);
});
test("readiness recognizes the specific goal UI, not generic startup or approval prompts", () => {
  assert.equal(goalReadyAction("Resume paused goal?\nMark it active and continue when idle"), "confirm");
  assert.equal(goalReadyAction("Goal paused (/goal resume)"), "resume");
  assert.equal(goalReadyAction("Goal hit usage limits (/goal resume)"), "resume");
  assert.equal(goalReadyAction("Pursuing goal"), "running");
  for (const text of ["Resume paused goal?", "Allow this command?", "Trust this directory?", "Goal stalled (/goal resume)", "Goal achieved", "Goal unmet", "OpenAI Codex"]) assert.equal(goalReadyAction(text), undefined);
  assert.equal(cleanTerminalText("\u001b[31mGoal paused\u001b[0m"), "Goal paused");
});
