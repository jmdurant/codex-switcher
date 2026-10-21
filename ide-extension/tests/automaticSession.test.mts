import assert from "node:assert/strict";
import test from "node:test";
import { emptyCodexComposer, identifyAutomaticSession } from "../src/automaticSession.ts";

const id = "01991234-1234-7123-8123-123456789abc";
const idle = "› Ask Codex to do anything\n  GPT-6.1-Sol medium · /project\n";
const status = `/status\n  >_ OpenAI Codex (v0.163.0)\n  Model: GPT-6.1-Sol\n  Directory: /project\n  Session: ${id}\n\n${idle}`;

test("automatic identification reads a fresh status response in a recovered terminal", async () => {
  let sent = false;
  const verified: string[] = [];
  assert.equal(await identifyAutomaticSession({
    valid: () => true, read: async () => sent ? status : idle,
    status: () => { sent = true; }, verify: async value => { verified.push(value); return true; },
    wait: async () => {},
  }), id);
  assert.deepEqual(verified, [id]);
});

test("an old status from scrollback cannot establish the current conversation", async () => {
  let verified = false, sent = 0;
  assert.equal(await identifyAutomaticSession({
    valid: () => true, read: async () => status,
    status: () => { sent++; }, verify: async () => { verified = true; return true; }, wait: async () => {},
  }), undefined);
  assert.equal(sent, 1);
  assert.equal(verified, false);
});

test("automatic status never submits typed text or acts on a busy or dialog prompt", async () => {
  for (const buffer of [
    "shell % ", "› finish this task\nGPT-6.1-Sol medium", idle + "unrelated prompt", idle + "esc to interrupt",
    "Resume paused goal?\n› Ask Codex to do anything\nGPT-6.1-Sol medium", "› Ask Codex to do anything\n  tab to queue message",
  ]) {
    assert.equal(emptyCodexComposer(buffer), false, buffer);
    let sent = false;
    await identifyAutomaticSession({valid: () => true, read: async () => buffer, status: () => { sent = true; }, verify: async () => true, wait: async () => {}});
    assert.equal(sent, false);
  }
});

test("input changed during empty-prompt verification cancels the automatic command", async () => {
  let reads = 0, sent = false;
  await identifyAutomaticSession({valid: () => true, read: async () => ++reads === 1 ? idle : "› user is typing", status: () => { sent = true; }, verify: async () => true, wait: async () => {}});
  assert.equal(sent, false);
});

test("foreign workspace verification and a replaced terminal cannot become bindings", async () => {
  for (const change of ["foreign", "replaced"]) {
    let sent = false, valid = true;
    const result = await identifyAutomaticSession({
      valid: () => valid, read: async () => sent ? status : idle, status: () => { sent = true; },
      verify: async () => { if (change === "replaced") valid = false; return change !== "foreign"; }, wait: async () => {},
    });
    assert.equal(result, undefined);
  }
});
