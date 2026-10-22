import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** A same-size SIGWINCH does not repaint Codex. Briefly change its PTY width
 * and restore it, without touching the composer, focus, or editor layout. */
export async function redrawTerminal(processId: number, valid: () => boolean): Promise<void> {
  if (process.platform !== "darwin" || !Number.isSafeInteger(processId) || processId <= 0 || !valid()) return;
  const options = {timeout: 2000, maxBuffer: 4096};
  const {stdout} = await execute("/bin/ps", ["-o", "tty=", "-p", String(processId)], options);
  const tty = stdout.trim();
  if (!/^ttys\d+$/.test(tty) || !valid()) return;
  // Keep restoration in the child so an extension-host reload cannot strand
  // the PTY at the temporary size. A real user resize takes precedence.
  await execute("/bin/sh", ["-c", `
device=$1
original=$(/bin/stty -f "$device" size) || exit 0
set -- $original
[ "$#" = 2 ] || exit 0
rows=$1
columns=$2
case "$rows:$columns" in *[!0-9:]*|:*) exit 0;; esac
[ "$columns" -gt 2 ] || exit 0
narrow=$((columns - 1))
restore() {
  current=$(/bin/stty -f "$device" size) || return
  [ "$current" != "$rows $narrow" ] || /bin/stty -f "$device" columns "$columns"
}
trap restore EXIT HUP INT TERM
/bin/stty -f "$device" columns "$narrow" || exit 0
/bin/sleep 0.2
`, "switcher-terminal-redraw", `/dev/${tty}`], options);
}
