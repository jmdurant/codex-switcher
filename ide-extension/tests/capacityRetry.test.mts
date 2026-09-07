import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { overloaded, goalKey, retryDelay, RetryPrompt, RetryLedger } from "../src/capacityRetry.ts";
import type { Goal } from "../src/goal.ts";
const id = "01a0537e-b2f9-7b71-9520-8db14bf0a76f";
const turn = "01a053b5-c94d-7ce3-8c32-ff2ea32a51cc";
test("only completed failures with the observed structured capacity code qualify", () => {
  assert.equal(overloaded({id:turn,status:"failed",error:{codexErrorInfo:"serverOverloaded"}}),true);
  for (const code of ["usageLimitExceeded","unauthorized","internalServerError","server_overloaded",undefined])
    assert.equal(overloaded({id:turn,status:"failed",error:{codexErrorInfo:code}}),false);
  assert.equal(overloaded({id:turn,status:"inProgress",error:{codexErrorInfo:"serverOverloaded"}}),false);
  assert.equal(overloaded(null),false);
});
test("capacity delays increase with bounded jitter", () => {
  assert.deepEqual([0,1,2,3,4,5].map(n=>retryDelay(n,0)),[30000,60000,120000,240000,300000,300000]);
  assert.equal(retryDelay(0,0.5),32500);
});
test("capacity retries preserve active goal identity and stop for other goal states", () => {
  const goal:Goal={threadId:id,objective:"existing",createdAt:1,status:"active",tokensUsed:20,tokenBudget:100};
  assert.ok(goalKey(goal)); assert.equal(goalKey(null),"none");
  for(const status of ["paused","blocked","budgetLimited","usageLimited","complete"] as const) assert.equal(goalKey({...goal,status}),undefined);
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
