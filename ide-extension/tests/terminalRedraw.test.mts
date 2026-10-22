import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { redrawTerminal } from "../src/terminalRedraw.ts";

test("macOS recovery repaints a real PTY, restores its size, and respects a concurrent resize", {skip: process.platform !== "darwin"}, async () => {
  // This terminal belongs only to the test; it has no editor or user input.
  const child = spawn("/usr/bin/python3", ["-u", "-c", `
import os, pty, fcntl, termios, struct, signal, time, json
os.setsid()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
os.dup2(slave, 0)
os.tcsetpgrp(0, os.getpgrp())
fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
def resized(*args):
    size = os.get_terminal_size(0)
    print(json.dumps({'columns': size.columns}), flush=True)
signal.signal(signal.SIGWINCH, resized)
print(json.dumps({'pid': os.getpid(), 'tty': os.ttyname(0)}), flush=True)
while True: time.sleep(1)
`], {stdio: ["ignore", "pipe", "pipe"]});
  let output = "", errors = "";
  child.stdout.on("data", chunk => {output += chunk;});
  child.stderr.on("data", chunk => {errors += chunk;});
  const rows = () => output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!condition() && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(condition(), errors || output);
  };
  try {
    await until(() => rows().some(row => row.pid));
    const {pid, tty} = rows()[0];
    await redrawTerminal(pid, () => true);
    await until(() => rows().some(row => row.columns === 100));
    assert.ok(rows().some(row => row.columns === 99));
    output = "";
    const repaint = redrawTerminal(pid, () => true);
    await until(() => rows().some(row => row.columns === 99));
    await promisify(execFile)("/bin/stty", ["-f", tty, "columns", "130"]);
    await repaint;
    const size = await promisify(execFile)("/bin/stty", ["-f", tty, "size"]);
    assert.equal(size.stdout.trim(), "30 130");
  } finally {
    child.kill();
  }
});
