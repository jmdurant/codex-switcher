import assert from "node:assert/strict";
import test from "node:test";
import { GoalDialogCleanup, isNonVisualUpdate } from "../src/goalDialogCleanup.ts";
import { fingerprint, type Goal } from "../src/goal.ts";

const dialog = "Resume paused goal?\nMark it active and continue when idle\nKeep it paused; use /goal resume later";
const goal: Goal = {threadId:"01991234-1234-7123-8123-123456789abc",objective:"test",status:"paused",tokenBudget:10000,tokensUsed:10,createdAt:1};
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
function setup(readGoal: () => Promise<Goal | null>, valid = () => true) {
  let dismissals = 0;
  const cleaner = new GoalDialogCleanup({expectedFingerprint:fingerprint(goal),readGoal,valid,dismiss:()=>{dismissals++;}});
  return {cleaner, count:()=>dismissals};
}
test("cleared goal dismisses its observed dialog once, including split output", async()=>{
  const s=setup(async()=>null);
  try {s.cleaner.observe(dialog.slice(0,30));s.cleaner.observe(dialog.slice(30));await settle();assert.equal(s.count(),1);s.cleaner.observe(dialog);await s.cleaner.check();assert.equal(s.count(),1);}
  finally{s.cleaner.dispose();}
});
test("a matching completed goal dismisses the dialog",async()=>{
  const s=setup(async()=>({...goal,status:"complete"}));try{s.cleaner.observe(dialog);await settle();assert.equal(s.count(),1);}finally{s.cleaner.dispose();}
});
test("a valid paused goal can be cleared later while its dialog remains visible",async()=>{
  let current: Goal|null=goal;const s=setup(async()=>current);
  try{s.cleaner.observe(dialog);await settle();assert.equal(s.count(),0);current=null;await s.cleaner.check();assert.equal(s.count(),1);}finally{s.cleaner.dispose();}
});
test("valid stopped/running goals and replacement completed goals are left alone",async()=>{
  for(const current of [goal,...(["active","blocked","usageLimited","budgetLimited"] as const).map(status=>({...goal,status})),{...goal,status:"complete" as const,objective:"replacement"}]){
    const s=setup(async()=>current);try{s.cleaner.observe(dialog);await settle();assert.equal(s.count(),0);}finally{s.cleaner.dispose();}
  }
});
test("failed reads never mean a cleared goal",async()=>{
  const s=setup(async()=>{throw Error("offline")});try{s.cleaner.observe(dialog);await settle();assert.equal(s.count(),0);}finally{s.cleaner.dispose();}
});
test("a replacement between the two reads cancels cleanup",async()=>{
  let reads=0;const s=setup(async()=>++reads===1?null:goal);try{s.cleaner.observe(dialog);await settle();assert.equal(s.count(),0);}finally{s.cleaner.dispose();}
});
test("new terminal output during verification invalidates the old prompt",async()=>{
  let resolve!: (g:Goal|null)=>void;const s=setup(()=>new Promise(r=>{resolve=r}));
  try{s.cleaner.observe(dialog);s.cleaner.observe("Trust this directory?");resolve(null);await settle();assert.equal(s.count(),0);}finally{s.cleaner.dispose();}
});
test("disabled or closed session during verification receives no input",async()=>{
  let valid=true;let resolve!: (g:Goal|null)=>void;const s=setup(()=>new Promise(r=>{resolve=r}),()=>valid);
  try{s.cleaner.observe(dialog);valid=false;resolve(null);await settle();assert.equal(s.count(),0);}finally{s.cleaner.dispose();}
});
test("a footer or generic approval cannot trigger dialog cleanup",async()=>{
  const s=setup(async()=>null);try{for(const text of ["Goal paused (/goal resume)","Allow command?","Resume paused goal?"]){s.cleaner.observe(text);await s.cleaner.check();}assert.equal(s.count(),0);}finally{s.cleaner.dispose();}
});
test("real CLI title-spinner and synchronized-render updates preserve the visible dialog",async()=>{
  let current:Goal|null=goal;const s=setup(async()=>current);
  try{
    s.cleaner.observe(dialog);await settle();
    for(const chunk of ["\x1b]0;\u2819 codex-switcher\x07","\x1b[?2026h","\x1b[?2026l\x1b[22m","\x1b]0;\u2807 codex-switcher\x07"]){s.cleaner.observe(chunk);}
    current=null;await s.cleaner.check();assert.equal(s.count(),1);
  }finally{s.cleaner.dispose();}
});
test("screen erases and incomplete escape sequences are never ignored as metadata",()=>{
  for(const chunk of ["\x1b[2J","\x1b[K","\x1b[H","\x1b]0;unfinished","\x1b[?2026hTrust this directory?"]){assert.equal(isNonVisualUpdate(chunk),false);}
  assert.equal(isNonVisualUpdate("\x1b]2;title\x1b\\\x1b[0m"),true);
});
