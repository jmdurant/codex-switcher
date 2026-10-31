import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readlink } from "node:fs/promises";

const execute = promisify(execFile);

/** A same-size SIGWINCH does not repaint Codex. Briefly change its PTY width
 * and restore it, without touching the composer, focus, or editor layout. */
export async function redrawTerminal(processId: number, valid: () => boolean, resize?: (columns: number, rows: number) => void): Promise<void> {
  if (!["darwin", "linux"].includes(process.platform) || !Number.isSafeInteger(processId) || processId <= 0 || !valid()) return;
  const options = {timeout: 2000, maxBuffer: 4096};
  let device: string;
  const stty = process.platform === "linux" ? "/usr/bin/stty" : "/bin/stty";
  const deviceFlag = process.platform === "linux" ? "-F" : "-f";
  if (process.platform === "linux") {
    device = await readlink(`/proc/${processId}/fd/0`);
    if (!/^\/dev\/pts\/\d+$/.test(device) || !valid()) return;
  } else {
    const {stdout} = await execute("/bin/ps", ["-o", "tty=", "-p", String(processId)], options);
    const tty = stdout.trim();
    if (!/^ttys\d+$/.test(tty) || !valid()) return;
    device = `/dev/${tty}`;
  }
  const size = await execute(stty, [deviceFlag, device, "size"], options);
  const dimensions = size.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!dimensions || !valid()) return;
  resize?.(Number(dimensions[2]), Number(dimensions[1]));
  // Keep restoration in the child so an extension-host reload cannot strand
  // the PTY at the temporary size. A real user resize takes precedence.
  await execute("/bin/sh", ["-c", `
device=$1
stty=$2
flag=$3
original=$("$stty" "$flag" "$device" size) || exit 0
set -- $original
[ "$#" = 2 ] || exit 0
rows=$1
columns=$2
case "$rows:$columns" in *[!0-9:]*|:*) exit 0;; esac
[ "$columns" -gt 2 ] || exit 0
narrow=$((columns - 1))
restore() {
  current=$("$stty" "$flag" "$device" size) || return
  [ "$current" != "$rows $narrow" ] || "$stty" "$flag" "$device" columns "$columns"
}
trap restore EXIT HUP INT TERM
"$stty" "$flag" "$device" columns "$narrow" || exit 0
/bin/sleep 0.2
`, "switcher-terminal-redraw", device, stty, deviceFlag], options);
}
