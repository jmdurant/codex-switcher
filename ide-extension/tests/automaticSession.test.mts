import assert from "node:assert/strict";
import test from "node:test";
import { identifyAutomaticSession } from "../src/automaticSession.ts";
import { TerminalScreen, type TerminalSnapshot } from "../src/terminalScreen.ts";

const id = "01991234-1234-7123-8123-123456789abc";
const idle: TerminalSnapshot = {text:"idle",composer:"empty",statusRevision:0};
const typed: TerminalSnapshot = {text:"typed",composer:"other",statusRevision:0};
const slash: TerminalSnapshot = {text:"/status",composer:"status",statusRevision:0};
const status: TerminalSnapshot = {text:"response",composer:"empty",statusId:id,statusRevision:1};

test("automatically identifies a restored terminal through silent output and verified status", async () => {
  let state = idle;
  const sent: string[] = [];
  assert.equal(await identifyAutomaticSession({
    valid: () => true, read: async () => state,
    status: () => {sent.push("/status");state=slash;}, enter: () => {sent.push("enter");state=status;},
    verify: async value => value===id,wait:async()=>{},
  }),id);
  assert.deepEqual(sent,["/status","enter"]);
});

test("typed input or missing output never receives automatic input", async () => {
  for(const state of [typed,undefined]) {
    let sent=false;
    await identifyAutomaticSession({valid:()=>true,read:async()=>state,status:()=>{sent=true;},enter:()=>{sent=true;},verify:async()=>true,wait:async()=>{}});
    assert.equal(sent,false);
  }
});

test("input changed before status submission cancels Enter",async()=>{
  let state=idle,entered=false;
  await identifyAutomaticSession({valid:()=>true,read:async()=>state,status:()=>{state=typed;},enter:()=>{entered=true;},verify:async()=>true,wait:async()=>{}});
  assert.equal(entered,false);
});

test("a live user-requested status links without sending another command",async()=>{
  let sent=false;
  assert.equal(await identifyAutomaticSession({valid:()=>true,read:async()=>status,status:()=>{sent=true;},enter:()=>{sent=true;},verify:async()=>true,wait:async()=>{}}),id);
  assert.equal(sent,false);
});

test("workspace verification and terminal validity are required for every binding",async()=>{
  for(const change of ["foreign","replaced"]){
    let valid=true;
    assert.equal(await identifyAutomaticSession({valid:()=>valid,read:async()=>status,status:()=>{},enter:()=>{},verify:async()=>{if(change==='replaced')valid=false;return change!=='foreign';},wait:async()=>{}}),undefined);
  }
});

test("live screen recognizes arbitrary dim placeholders using the cursor, not placeholder wording",async()=>{
  const screen=new TerminalScreen(100,24);
  try{
    for(const placeholder of ['Ask Codex to do anything','Improve documentation in @filename','Find and fix a bug in @filename']){
      screen.write(`\x1b[2J\x1b[1;1H› \x1b[2m${placeholder}\x1b[0m\x1b[1;3H`);
      assert.equal((await screen.snapshot()).composer,'empty',placeholder);
    }
    screen.write('\x1b[2J\x1b[1;1H› user input\x1b[1;3H');
    assert.equal((await screen.snapshot()).composer,'other');
    screen.write('\x1b[2J\x1b[1;1H› \x1b[2mAsk Codex to do anything\x1b[0m\x1b[1;3H\x1b]7501;state=working:app=codex\x1b\\');
    assert.equal((await screen.snapshot()).composer,'empty', 'read-only /status remains available during a running task with an empty composer');
    screen.write('\x1b]7501;state=idle:app=codex\x1b\\');
    assert.equal((await screen.snapshot()).composer,'empty');
  }finally{screen.dispose();}
});

test("a newly observed status with split ANSI output is read without editor UI",async()=>{
  const screen=new TerminalScreen();
  try{
    screen.write('\r\n\x1b[2m  Session:   \x1b[22m'+id.slice(0,12));
    screen.write(id.slice(12)+'\r\n');
    const result=await screen.snapshot();
    assert.equal(result.statusId,id);
    assert.equal(result.statusRevision,1);
  }finally{screen.dispose();}
});


test("changing agent output does not block /status while the composer is empty",async()=>{
  let reads=0,state=idle;
  assert.equal(await identifyAutomaticSession({valid:()=>true,read:async()=>{reads++;return state===idle ? {...idle,text:'agent output '+reads}:state;},status:()=>{state=slash;},enter:()=>{state=status;},verify:async()=>true,wait:async()=>{}}),id);
});

test("alternate-screen cursor-positioned status rows identify the session", async () => {
  const screen = new TerminalScreen(120, 30);
  try {
    screen.write(`\x1b[?1049h\x1b[2J\x1b[4;3HCollaboration mode: Default\x1b[5;3HSession: ${id}\x1b[8;1H› \x1b[2mAsk Codex to do anything\x1b[0m\x1b[8;3H`);
    const result = await screen.snapshot();
    assert.equal(result.statusId, id);
    assert.equal(result.statusRevision, 1);
    assert.equal(result.composer, "empty");
    assert.equal((await screen.snapshot()).statusRevision, 1, "reading the same frame is not new evidence");
  } finally { screen.dispose(); }
});
