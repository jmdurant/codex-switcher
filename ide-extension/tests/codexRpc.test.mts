import assert from "node:assert/strict";
import test from "node:test";
import { CodexReader, nativeCodexFromScript } from "../src/codexRpc.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

test("Windows npm installs resolve native binaries without spawning the visible shim", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-launch-"));
  try {
    const script = path.join(root, "bin", "codex.js");
    await fs.mkdir(path.dirname(script), {recursive:true});
    await fs.writeFile(script, "");
    await assert.rejects(nativeCodexFromScript(script, "x64"), /not found/);
    for (const [arch, triple] of [["x64", "x86_64-pc-windows-msvc"], ["arm64", "aarch64-pc-windows-msvc"]] as const) {
      const pkg = path.join(root, "node_modules", "@openai", `codex-win32-${arch}`);
      const binary = path.join(pkg, "vendor", triple, "bin", "codex.exe");
      await fs.mkdir(path.dirname(binary), {recursive:true});
      await fs.writeFile(path.join(pkg, "package.json"), "{}");
      await fs.writeFile(binary, "");
      assert.equal(await nativeCodexFromScript(script, arch), binary);
    }
    await assert.rejects(nativeCodexFromScript(script, "ia32"), /Unsupported/);
  } finally { await fs.rm(root, {recursive:true, force:true}); }
});

const id = "01991234-1234-7123-8123-123456789abc";
const fixture = `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const q = JSON.parse(line);
 if(q.id === undefined) return;
 if(q.method === 'initialize') return console.log(JSON.stringify({id:q.id,result:{}}));
 if(q.method === 'thread/read') return console.log(JSON.stringify({id:q.id,result:{thread:{id:q.params.threadId,cwd:process.cwd()}}}));
 if(q.method === 'thread/goal/get') return console.log(JSON.stringify({id:q.id,result:{goal:{threadId:q.params.threadId,objective:'test',status:'active',tokenBudget:100,tokensUsed:5,createdAt:1}}}));
 console.log(JSON.stringify({id:q.id,error:{code:-32601}}));
});`;
test("reader initializes once, reads exact goals, and checks workspace", async () => {
  let starts = 0;
  const reader = new CodexReader(async () => { starts++; return {executable:process.execPath,args:['-e',fixture]}; });
  try {
    const goals = await Promise.all([reader.readGoal(id, process.cwd()), reader.readGoal(id, process.cwd())]);
    assert.equal(goals[0]?.status, "active"); assert.equal(starts, 1);
    await assert.rejects(reader.readGoal(id, "/a-different-project"), /workspace/);
    await assert.rejects(reader.readGoal("not-a-session", process.cwd()), /Invalid/);
  } finally { reader.dispose(); }
});
test("reader requests bounded newest-first turn history and validates its schema", async () => {
  const history = fixture.replace("if(q.method === 'thread/goal/get')", `if(q.method === 'thread/turns/list') {
    if(q.params.limit!==1 || q.params.sortDirection!=='desc' || q.params.itemsView!=='notLoaded') throw Error('wrong pagination');
    return console.log(JSON.stringify({id:q.id,result:{data:[{id:q.params.threadId,status:'failed',completedAt:1788110971,error:{codexErrorInfo:'serverOverloaded'}}]}}));
  }
  if(q.method === 'thread/goal/get')`);
  for (const malformed of [false,true]) {
    const reader = new CodexReader(async () => ({ executable:process.execPath,args:['-e',malformed ? history.replace("status:'failed'","status:'unknown'") : history] }));
    try {
      if(malformed) await assert.rejects(reader.latestTurn(id,process.cwd()),/Unsupported/);
      else {assert.equal((await reader.latestTurn(id,process.cwd()))?.error?.codexErrorInfo,'serverOverloaded');await assert.rejects(reader.latestTurn(id,'/wrong-workspace'),/workspace/);}
    } finally {reader.dispose();}
  }
});
test("reader times out and can be disposed without hanging", async () => {
  const reader = new CodexReader(async () => ({executable:process.execPath,args:['-e','process.stdin.resume()']}), 150);
  try { await assert.rejects(reader.readGoal(id, process.cwd()), /timed out/); }
  finally { reader.dispose(); }
});
test("reader rejects malformed goals instead of assuming they are resumable", async () => {
  const reader = new CodexReader(async () => ({executable:process.execPath,args:['-e',fixture.replace("status:'active'", "status:'unknown'")]}));
  try { await assert.rejects(reader.readGoal(id, process.cwd()), /unsupported goal state/); }
  finally { reader.dispose(); }
});
test("automatic discovery accepts only root interactive CLI threads", async () => {
  for (const [metadata, expected] of [
    ["source:'cli',parentThreadId:null", true],
    ["source:'exec',parentThreadId:null", false],
    ["source:'cli',parentThreadId:'parent'", false],
    ["source:'unknown',parentThreadId:null", false],
  ] as const) {
    const reader = new CodexReader(async () => ({ executable: process.execPath,
      args: ['-e', fixture.replace('cwd:process.cwd()', `cwd:process.cwd(),${metadata}`)] }));
    try { assert.equal(await reader.isInteractiveSession(id, process.cwd()), expected); }
    finally { reader.dispose(); }
  }
});
