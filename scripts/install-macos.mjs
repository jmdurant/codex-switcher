import { existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { installExtensions } from "./install-extensions-macos.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const identifier = "com.lampese.codex-switcher";

function bundleId(app) {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(app, "Contents", "Info.plist")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

function pnpm(args) {
  const execPath = process.env.npm_execpath;
  if (execPath) execFileSync(process.execPath, [execPath, ...args], { cwd: root, stdio: "inherit" });
  else execFileSync("corepack", ["pnpm", ...args], { cwd: root, stdio: "inherit" });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This installer requires macOS.");
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--debug", "--skip-build"].includes(arg))) {
    throw new Error("Usage: pnpm install:macos [--debug] [--skip-build]");
  }
  const debug = args.includes("--debug");
  const source = join(root, "src-tauri", "target", debug ? "debug" : "release", "bundle", "macos", "AI Account Switcher.app");
  if (!args.includes("--skip-build")) {
    pnpm(["--dir", "ide-extension", "run", "package"]);
    pnpm(["tauri", "build", ...(debug ? ["--debug"] : []), "--bundles", "app", "--config",
      JSON.stringify({ bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: "-" } } })]);
  }
  if (bundleId(source) !== identifier) throw new Error(`Expected a built AI Account Switcher app at ${source}`);
  // Preserve an existing installation path, including Dock shortcuts to the old name.
  const candidates = ["AI Account Switcher.app", "Codex Switcher.app"].map((name) => join("/Applications", name));
  const destination = candidates.find((app) => bundleId(app) === identifier) ?? candidates[0];
  if (existsSync(destination) && bundleId(destination) !== identifier) {
    throw new Error(`Refusing to replace another application at ${destination}`);
  }
  const processes = execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8" });
  if (processes.split("\n").some((line) => line.trim().startsWith(`${destination}/Contents/MacOS/`))) {
    throw new Error("Quit AI Account Switcher using its Quit menu, then run the installer again.");
  }
  const stageRoot = join("/Applications", `.codex-switcher-install-${randomUUID()}`);
  const staged = join(stageRoot, "AI Account Switcher.app");
  const backup = join(stageRoot, "previous.app");
  mkdirSync(stageRoot);
  let installed = false;
  try {
    execFileSync("/usr/bin/ditto", [source, staged], { stdio: "inherit" });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], { stdio: "inherit" });
    if (existsSync(destination)) renameSync(destination, backup);
    try { renameSync(staged, destination); installed = true; }
    catch (error) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
  } finally {
    // If rollback itself failed, retain the previous bundle for recovery.
    if (installed || !existsSync(backup)) rmSync(stageRoot, { recursive: true, force: true });
  }
  console.log(`Installed app: ${destination}`);
  installExtensions();
  execFileSync("/usr/bin/open", [destination], { stdio: "inherit" });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
