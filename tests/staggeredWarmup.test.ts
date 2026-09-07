import test from "node:test";
import assert from "node:assert/strict";
import {canStaggerWarm,emptyStaggerLedger,readStaggerLedger,reserveStaggerWarmup,selectStaggerWarmup,STAGGER_MS} from "../src/lib/staggeredWarmup.ts";
import {selectAutoQuotaOption} from "../src/lib/quotaOptions.ts";
import type {AccountWithUsage} from "../src/types/index.ts";
const now=Date.parse("2026-09-07T12:00:00Z");
function account(id:string,used=0):AccountWithUsage {
  return {id,name:id,email:null,auth_mode:"chat_g_p_t",plan_type:"team",is_active:false,created_at:"",last_used_at:null,subscription_expires_at:null,
    usage:{account_id:id,plan_type:"team",primary_used_percent:used,primary_window_minutes:300,primary_resets_at:now/1000+18000,secondary_used_percent:20,secondary_window_minutes:10080,secondary_resets_at:now/1000+86400,has_credits:false,unlimited_credits:false,credits_balance:null,error:null}};
}
test("fresh five-hour accounts are selected deterministically one at a time",()=>{
  assert.equal(selectStaggerWarmup([account("b"),account("a")],emptyStaggerLedger(),now)?.id,"a");
});
test("saved attempts maintain an hour gap across reloads including uncertain failures",()=>{
  const ledger=readStaggerLedger(JSON.stringify(reserveStaggerWarmup(emptyStaggerLedger(),"a",now)));
  assert.equal(selectStaggerWarmup([account("b")],ledger,now+STAGGER_MS-1),undefined);
  const b=account("b");b.usage!.primary_resets_at!+=3600;
  assert.equal(selectStaggerWarmup([b],ledger,now+STAGGER_MS)?.id,"b");
});
test("the same account cannot be re-primed in its reserved five-hour window",()=>{
  const ledger=reserveStaggerWarmup(emptyStaggerLedger(),"a",now);
  const a=account("a");a.usage!.primary_resets_at!+=3600;
  assert.equal(canStaggerWarm(a,ledger,now+STAGGER_MS),false);
  a.usage!.primary_resets_at=now/1000+36000;
  assert.equal(canStaggerWarm(a,ledger,now+5*STAGGER_MS),true);
});
test("active, used, exhausted, unknown and already-running windows are excluded",()=>{
  const weeklyEmpty=account("weekly");weeklyEmpty.usage!.secondary_used_percent=100;
  const running=account("running");running.usage!.primary_resets_at!-=3600;
  const unknown=account("unknown");unknown.usage=undefined;
  for(const a of [{...account("active"),is_active:true},account("used",1),account("empty",100),weeklyEmpty,running,unknown]) assert.equal(canStaggerWarm(a,emptyStaggerLedger(),now),false,a.id);
});
test("uses actual window lengths even when primary and secondary swap",()=>{
  const a=account("swapped");
  for(const suffix of ["used_percent","window_minutes","resets_at"] as const){const p=`primary_${suffix}` as const,s=`secondary_${suffix}` as const;[a.usage![p],a.usage![s]]=[a.usage![s],a.usage![p]];}
  assert.equal(canStaggerWarm(a,emptyStaggerLedger(),now),true);
});
test("corrupt schedule fails closed instead of resetting the hour gap",()=>{
  assert.throws(()=>readStaggerLedger('{"lastAttemptAt":0,"accounts":{"x":null}}'));
  assert.deepEqual(readStaggerLedger(null),emptyStaggerLedger());
});
test("rotation uses weekly reserve between due five-hour windows",()=>{
  const active={...account("active",100),is_active:true};
  const reserve=account("pro");reserve.usage!.primary_used_percent=null;reserve.usage!.primary_window_minutes=null;reserve.usage!.primary_resets_at=null;
  const next=account("next");
  assert.equal(selectAutoQuotaOption([active,next,reserve],now)?.account.id,"pro");
  next.usage!.primary_resets_at=now/1000+1800;
  assert.equal(selectAutoQuotaOption([active,next,reserve],now)?.account.id,"next");
});
