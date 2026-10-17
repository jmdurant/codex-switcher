import assert from "node:assert/strict";
import test from "node:test";

import { classifyCommand, isLastResumeCommand, resumeInvocation, sessionIdFromCommand, yoloFromCommand, launchFromCommand, hasShellSafeArguments } from "../src/session.ts";

test("global launch options do not hide the exact resume session", () => {
  const id = "01991234-1234-7123-8123-123456789abc";
  assert.equal(sessionIdFromCommand(`codex --profile work --no-daemon resume --model test ${id}`), id);
  assert.equal(yoloFromCommand(`codex --profile work resume ${id} --yolo`), true);
  assert.equal(isLastResumeCommand("codex --profile work resume --last"), true);
});

test("shell expansion and compound launches require explicit literal settings", () => {
  for (const command of ["codex --profile $PROFILE", "codex --model `model`", "codex --yolo; other-command", "codex --profile $(command)"]) {
    assert.throws(() => launchFromCommand(command), /shell expansions/);
  }
});

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
test("last-resume commands are identified for Linux session binding", () => {
  assert.equal(isLastResumeCommand("codex resume --last --yolo"), true);
  assert.equal(isLastResumeCommand("codex resume"), true);
  assert.equal(isLastResumeCommand("codex resume 01991234-1234-7123-8123-123456789abc"), false);
  assert.equal(isLastResumeCommand("agy --continue"), false);
  assert.equal(isLastResumeCommand("codex --no-daemon resume --last --yolo"), true);
  assert.equal(sessionIdFromCommand("codex --no-daemon resume 01991234-1234-7123-8123-123456789abc --yolo"), "01991234-1234-7123-8123-123456789abc");
});

test("resume keeps the normal daemon connection to the conversation owner", () => {
  const invocation = resumeInvocation("codex", undefined, true);
  assert.deepEqual(invocation.args, ["resume", "--last", "--yolo"]);
  assert.equal(invocation.commandLine, "codex resume --last --yolo");
  assert.equal(yoloFromCommand(invocation.commandLine), true);
});

test("captures YOLO aliases and explicit guarded launches without reading prompt text", () => {
  for (const command of ["codex --yolo", "codex --dangerously-bypass-approvals-and-sandbox"]) assert.equal(yoloFromCommand(command), true);
  for (const command of ["codex --sandbox workspace-write", "codex --sandbox=read-only", "codex -a on-request", "codex --full-auto", "codex --approve-for-me"]) assert.equal(yoloFromCommand(command), false);
  for (const command of ["codex", "agy --yolo", 'codex "explain --yolo"', "codex -- --yolo", "codex -m --yolo", "codex --profile personal"]) assert.equal(yoloFromCommand(command), undefined);
});

test("unknown captures retain configured permissions rather than enabling YOLO", () => {
  const id = "01991234-1234-7123-8123-123456789abc";
  for (const mode of [true]) {
    assert.deepEqual(resumeInvocation("codex", id, mode).args, ["resume", id, "--yolo"]);
    assert.equal(resumeInvocation("codex", id, mode).commandLine, `codex resume ${id} --yolo`);
  }
  assert.deepEqual(resumeInvocation("codex", id, false).args, ["resume", id]);
  assert.deepEqual(resumeInvocation("codex", id, undefined).args, ["resume", id]);
  assert.equal(resumeInvocation("codex", undefined, false).commandLine, "codex resume --last");
  assert.equal(resumeInvocation("agy", undefined, true).commandLine, "agy --continue");
});

test("restart preserves daemon, profile, model and explicit permission settings", () => {
  const id = "01991234-1234-7123-8123-123456789abc";
  const launch = launchFromCommand(`codex --no-daemon resume ${id} --profile work --model sample-model --sandbox workspace-write --ask-for-approval on-request --add-dir ../shared`);
  const invocation = resumeInvocation("codex", id, true, launch);
  assert.deepEqual(invocation.args, ["resume", id, "--no-daemon", "--profile", "work", "--model", "sample-model", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--add-dir", "../shared"]);
  assert.equal(hasShellSafeArguments(invocation), true);
});

test("quoted configuration is preserved as one argument and never sent as raw shell text", () => {
  const launch = launchFromCommand(`codex -c 'model_reasoning_effort="high"' -p 'Work Profile' "please explain --yolo"`);
  assert.deepEqual(launch?.args, ["-c", 'model_reasoning_effort="high"', "-p", "Work Profile"]);
  assert.equal(hasShellSafeArguments(resumeInvocation("codex", undefined, undefined, launch)), false);
  assert.throws(() => launchFromCommand("codex --remote ws://host:1234"), /Remote/);
  assert.throws(() => resumeInvocation("codex", undefined, undefined, {args:["--remote", "ws://host"]}), /Invalid/);
});

test("custom Codex executable and flags after the initial prompt survive resume", () => {
  const launch = launchFromCommand(`'/Users/Test User/bin/codex' 'original task' --profile work --no-daemon`);
  const invocation = resumeInvocation("codex", undefined, undefined, launch);
  assert.equal(invocation.executable, "/Users/Test User/bin/codex");
  assert.deepEqual(invocation.args, ["resume", "--last", "--profile", "work", "--no-daemon"]);
  assert.equal(hasShellSafeArguments(invocation), false);
});

test("recognizes macOS and Linux installation paths including quoted spaces", () => {
  assert.equal(classifyCommand("/opt/homebrew/bin/codex resume --last"), "codex");
  assert.equal(classifyCommand("'/Users/Test User/bin/codex'"), "codex");
  assert.equal(classifyCommand('"/Applications/Antigravity.app/Contents/Resources/app/bin/agy" --continue'), "agy");
  assert.equal(classifyCommand("/usr/local/bin/agy"), "agy");
  assert.equal(classifyCommand("/usr/bin/echo /opt/homebrew/bin/codex"), undefined);
});
