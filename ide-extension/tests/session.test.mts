import assert from "node:assert/strict";
import test from "node:test";

import { classifyCommand, resumeInvocation } from "../src/session.ts";

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
    args: ["resume", "--last"],
    commandLine: "codex resume --last",
  });
  assert.deepEqual(resumeInvocation("agy"), {
    executable: "agy",
    args: ["--continue"],
    commandLine: "agy --continue",
  });
});

test("recognizes macOS and Linux installation paths including quoted spaces", () => {
  assert.equal(classifyCommand("/opt/homebrew/bin/codex resume --last"), "codex");
  assert.equal(classifyCommand("'/Users/Test User/bin/codex'"), "codex");
  assert.equal(classifyCommand('"/Applications/Antigravity.app/Contents/Resources/app/bin/agy" --continue'), "agy");
  assert.equal(classifyCommand("/usr/local/bin/agy"), "agy");
  assert.equal(classifyCommand("/usr/bin/echo /opt/homebrew/bin/codex"), undefined);
});
