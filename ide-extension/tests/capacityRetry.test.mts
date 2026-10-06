import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { overloaded, networkPermissionRevoked, goalKey, retryDelay, RetryPrompt, RetryLedger, NetworkResumePrompt, CodexUpdatePrompt } from "../src/capacityRetry.ts";
import type { Goal } from "../src/goal.ts";
const id = "01a0537e-b2f9-7b71-9520-8db14bf0a76f";
const turn = "01a053b5-c94d-7ce3-8c32-ff2ea32a51cc";
test("only completed failures with the observed structured capacity code qualify", () => {
  assert.equal(overloaded({id:turn,status:"failed",error:{codexErrorInfo:"serverOverloaded"}}),true);
  for (const code of ["usageLimitExceeded","unauthorized","internalServerError",undefined])
    assert.equal(overloaded({id:turn,status:"failed",error:{codexErrorInfo:code}}),false);
  assert.equal(overloaded({id:turn,status:"failed",error:{codexErrorInfo:"server_overloaded"}}),true);
  assert.equal(overloaded({id:turn,status:"failed",error:{message:"Selected model is at capacity. Please try a different model."}}),true);
  assert.equal(overloaded({id:turn,status:"inProgress",error:{codexErrorInfo:"serverOverloaded"}}),false);
  assert.equal(overloaded(null),false);
});
test("only the observed network permission failure qualifies", () => {
  assert.equal(networkPermissionRevoked({id:turn,status:"failed",error:{codexErrorInfo:"other",message:"Error running remote compact task: Fatal error: application network permission was revoked"}}),true);
  assert.equal(networkPermissionRevoked({id:turn,status:"failed",error:{message:"A different network error"}}),false);
  assert.equal(networkPermissionRevoked({id:turn,status:"completed",error:{message:"Fatal error: application network permission was revoked"}}),false);
});
test("network goal prompt requires both numbered choices and invalidates on new output", () => {
  const prompt = new NetworkResumePrompt();
  prompt.observe("1. Resume goal\r\n"); assert.equal(prompt.observedAt,0);
  prompt.observe("2. Leave paused\r\n"); assert.ok(prompt.observedAt);
  prompt.observe("\x1b]0;spinner\x07"); assert.ok(prompt.observedAt);
  prompt.observe("another prompt"); assert.equal(prompt.observedAt,0);
  prompt.observe("1. Resume goal\r\n2. Leave paused\r\n"); assert.ok(prompt.observedAt);
  prompt.invalidate(); assert.equal(prompt.observedAt,0);
});
test("Codex update prompt requires all three choices and invalidates on other output", () => {
  const prompt = new CodexUpdatePrompt();
  prompt.observe("Update available · 0.159.3 → 0.160.1\r\n1. Update now\r\n");
  assert.equal(prompt.observedAt, 0);
  prompt.observe("2. Skip\r\n3. Skip until next version\r\n");
  assert.ok(prompt.observedAt);
  prompt.observe("\x1b]0;spinner\x07");
  assert.ok(prompt.observedAt);
  prompt.observe("Unrelated confirmation");
  assert.equal(prompt.observedAt, 0);
});
test("capacity delays increase with bounded jitter", () => {
  assert.deepEqual([0,1,2,3,4,5].map(n=>retryDelay(n,0)),[30000,60000,120000,240000,300000,300000]);
  assert.equal(retryDelay(0,0.5),32500);
});
test("capacity retries preserve resumable goal identity and stop for other goal states", () => {
  const goal:Goal={threadId:id,objective:"existing",createdAt:1,status:"active",tokensUsed:20,tokenBudget:100};
  assert.ok(goalKey(goal)); assert.equal(goalKey(null),"none");
  assert.ok(goalKey({...goal,status:"usageLimited"}));
  assert.ok(goalKey({...goal,status:"paused"}));
  assert.ok(goalKey({...goal,status:"blocked"}));
  for(const status of ["budgetLimited","complete"] as const) assert.equal(goalKey({...goal,status}),undefined);
  assert.equal(goalKey({...goal,tokensUsed:100}),undefined);
  assert.notEqual(goalKey({...goal,objective:"replacement"}),goalKey(goal));
  assert.notEqual(goalKey({...goal,tokenBudget:200}),goalKey(goal));
});
test("live empty prompt survives title updates but not typing, erases, or a goal dialog", () => {
  const p=new RetryPrompt();
  p.observe("\r\n› Ask Codex to do anything\r\n"); assert.ok(p.observedAt);
  p.observe("\x1b]0;spinner\x07\x1b[?2026h\x1b[?2026l"); assert.ok(p.observedAt);
  p.observe("hello"); assert.equal(p.observedAt,0);
  p.observe("\r\n› Ask Codex to do anything\r\n"); p.observe("\x1b[2J"); assert.equal(p.observedAt,0);
  p.observe("Resume paused goal?\r\n› Ask Codex to do anything\r\n"); assert.equal(p.observedAt,0);
  p.invalidate(); p.observe("\r\n› Ask Codex to do anything\r\n› edited input\r\n"); assert.equal(p.observedAt,0);
  p.invalidate(); p.observe("\r\n› Ask Codex to do anything\r\ngpt-6-astra medium\r\n"); assert.ok(p.observedAt);
});
test("durable claims deduplicate concurrent hosts and cap retries across reloads", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"capacity-ledger-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
  try {
    const a=new RetryLedger(root),b=new RetryLedger(root);
    assert.equal((await Promise.all([a.claim(id,turn,100),b.claim(id,turn,100)])).filter(Boolean).length,1);
    assert.equal(await new RetryLedger(root).claim(id,turn,200),false);
    for(let i=0;i<4;i++) assert.equal(await a.claim(id,`01a053b5-c94d-7ce3-8c32-ff2ea32a51c${i}`,300),true);
    assert.equal(await b.count(id,400),5);
    assert.equal(await b.claim(id,"01a053b5-c94d-7ce3-8c32-ff2ea32a51cf",400),false);
    assert.equal(await b.claim(id,turn,4000000),false);
    assert.equal(await b.claim("../bad",turn),false);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test("corrupt durable claims fail closed", async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"capacity-ledger-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
  try{await fs.writeFile(path.join(root,`${id}.json`),"broken");const ledger=new RetryLedger(root);assert.equal(await ledger.count(id),5);assert.equal(await ledger.claim(id,turn),false);}
  finally{await fs.rm(root,{recursive:true,force:true});}
});
