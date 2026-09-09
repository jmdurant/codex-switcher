import assert from "node:assert/strict";
import test from "node:test";

import { classifyCommand, resumeInvocation, yoloFromCommand } from "../src/session.ts";

test("recognizes Codex and agy commands launched from common Windows shells", () => {
  assert.equal(classifyCommand("codex"), "codex");
  assert.equal(classifyCommand("codex resume --last"), "codex");
  assert.equal(classifyCommand("& 'C:\\tools\\codex.ps1' resume --last"), "codex");
  assert.equal(classifyCommand('"C:\\tools\\agy.exe" --continue'), "agy");
  assert.equal(classifyCommand("agy --conversation abc"), "agy");
});

test("does not treat unrelated commands as resumable agents", () => {
  assert.equal(classifyCommand("echo codex"), undefined);
  assert.equal(classifyCommand("codex-switcher.exe"), undefined);
  assert.equal(classifyCommand("pnpm codex"), undefined);
  assert.equal(classifyCommand(""), undefined);
});

test("resume commands are fixed and do not contain captured shell text", () => {
  assert.deepEqual(resumeInvocation("codex"), {
    executable: "codex",
    args: ["resume", "--last", "--yolo"],
    commandLine: "codex resume --last --yolo",
  });
  assert.deepEqual(resumeInvocation("agy"), {
    executable: "agy",
    args: ["--continue"],
    commandLine: "agy --continue",
  });
});

test("captures YOLO aliases and explicit guarded launches without reading prompt text", () => {
  for (const command of ["codex --yolo", "codex --dangerously-bypass-approvals-and-sandbox"]) assert.equal(yoloFromCommand(command), true);
  for (const command of ["codex --sandbox workspace-write", "codex --sandbox=read-only", "codex -a on-request", "codex --full-auto", "codex --approve-for-me"]) assert.equal(yoloFromCommand(command), false);
  for (const command of ["codex", "agy --yolo", 'codex "explain --yolo"', "codex -- --yolo", "codex -m --yolo", "codex --profile personal"]) assert.equal(yoloFromCommand(command), undefined);
});

test("unknown captures default to YOLO while explicit guarded captures suppress it", () => {
  const id = "01991234-1234-7123-8123-123456789abc";
  for (const mode of [true, undefined]) {
    assert.deepEqual(resumeInvocation("codex", id, mode).args, ["resume", id, "--yolo"]);
    assert.equal(resumeInvocation("codex", id, mode).commandLine, `codex resume ${id} --yolo`);
  }
  assert.deepEqual(resumeInvocation("codex", id, false).args, ["resume", id]);
  assert.equal(resumeInvocation("codex", undefined, false).commandLine, "codex resume --last");
  assert.equal(resumeInvocation("agy", undefined, true).commandLine, "agy --continue");
});

test("recognizes macOS and Linux installation paths including quoted spaces", () => {
  assert.equal(classifyCommand("/opt/homebrew/bin/codex resume --last"), "codex");
  assert.equal(classifyCommand("'/Users/Test User/bin/codex'"), "codex");
  assert.equal(classifyCommand('"/Applications/Antigravity.app/Contents/Resources/app/bin/agy" --continue'), "agy");
  assert.equal(classifyCommand("/usr/local/bin/agy"), "agy");
  assert.equal(classifyCommand("/usr/bin/echo /opt/homebrew/bin/codex"), undefined);
});
