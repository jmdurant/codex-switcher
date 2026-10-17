import assert from "node:assert/strict";
import test from "node:test";
import { ownerForTerminal, parseOwners, lsofNames, sessionFromOpenFiles } from "../src/sessionDiscovery.ts";

const a = "01991234-1234-7123-8123-123456789abc";
const b = "01991234-1234-7123-8123-123456789def";

test("macOS lsof preserves spaces and exact writer-lock IDs", () => {
  const files = lsofNames(`p123\nfcwd\nn/Users/test/Project With Spaces\nf4\nn/Users/test/.codex/thread-writer-locks/${a}.lock\n`);
  assert.equal(files[0], "/Users/test/Project With Spaces");
  assert.equal(sessionFromOpenFiles(files), a);
  assert.equal(sessionFromOpenFiles([...files, `/home/test/.codex/thread-writer-locks/${b}.lock`]), undefined);
  assert.equal(sessionFromOpenFiles([`/tmp/${a}.lock`]), undefined);
});

test("shared daemon ownership never binds an unrelated terminal", () => {
  assert.equal(ownerForTerminal([{sessionId:a,processId:99,ancestors:[]}],11), undefined);
});
test("two terminals in one directory map to their own process-owned conversations", () => {
  const rows = [{sessionId:a,processId:1,ancestors:[11,100]}, {sessionId:b,processId:2,ancestors:[22,100]}];
  assert.equal(ownerForTerminal(rows,11)?.sessionId,a);
  assert.equal(ownerForTerminal(rows,22)?.sessionId,b);
  assert.equal(ownerForTerminal(rows,33),undefined);
  assert.equal(ownerForTerminal(rows,100),undefined);
});
test("multiple conversations owned under one terminal remain ambiguous", () => {
  assert.equal(ownerForTerminal([{sessionId:a,processId:1,ancestors:[11]}, {sessionId:b,processId:1,ancestors:[11]}],11),undefined);
});
test("duplicate lock-owner rows do not make an exact match ambiguous", () => {
  const row = {sessionId:a,processId:1,ancestors:[11]};
  assert.equal(ownerForTerminal([row,row],11)?.sessionId,a);
});
test("invalid native discovery output cannot become a binding", () => {
  assert.throws(()=>parseOwners({}));
  assert.deepEqual(parseOwners([null,{sessionId:'bad',processId:1,ancestors:[11]}, {sessionId:a,processId:-1,ancestors:[11]}, {sessionId:a,processId:1,ancestors:['11']}]),[]);
});
