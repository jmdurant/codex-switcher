import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const editors = [
  { name: "VS Code", bundle: "Visual Studio Code.app", id: "com.microsoft.VSCode", cli: "code" },
  { name: "VS Code Insiders", bundle: "Visual Studio Code - Insiders.app", id: "com.microsoft.VSCodeInsiders", cli: "code-insiders" },
  { name: "Antigravity IDE", bundle: "Antigravity IDE.app", id: "com.google.antigravity-ide", cli: "antigravity-ide" },
  // Older Antigravity releases were a VS Code-compatible editor. The newer
  // standalone app has no editor CLI, so it is naturally excluded below.
  { name: "Antigravity (legacy IDE)", bundle: "Antigravity.app", id: "com.google.antigravity", cli: "antigravity" },
];

export function discoverEditors(appRoots = ["/Applications", join(homedir(), "Applications")], searchSystem = true) {
  const found = [];
  const seen = new Set();
  for (const editor of editors) {
    const apps = appRoots.map((directory) => join(directory, editor.bundle));
    if (searchSystem) {
      try {
        apps.push(...execFileSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${editor.id}"`],
          { encoding: "utf8", timeout: 10_000 }).trim().split("\n").filter(Boolean));
      } catch { /* Standard app locations still work without Spotlight. */ }
    }
    for (const app of apps) {
      const cli = join(app, "Contents", "Resources", "app", "bin", editor.cli);
      if (!existsSync(cli)) continue;
      const canonical = realpathSync(cli);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      found.push({ name: editor.name, cli });
    }
  }
  return found;
}

export function installExtensions(vsix = join(root, "ide-extension", "ai-account-switcher-resume.vsix")) {
  if (process.platform !== "darwin") throw new Error("This installer requires macOS.");
  if (!existsSync(vsix)) throw new Error(`VSIX not found: ${vsix}. Package the extension first.`);
  const manifest = JSON.parse(readFileSync(join(root, "ide-extension", "package.json"), "utf8"));
  const expected = `${manifest.publisher}.${manifest.name}@${manifest.version}`.toLowerCase();
  const found = discoverEditors();
  if (!found.some((editor) => editor.name.startsWith("VS Code"))) console.log("VS Code not found; skipped.");
  if (!found.some((editor) => editor.name.startsWith("Antigravity"))) console.log("Antigravity IDE not found; skipped.");
  const env = { ...process.env };
  // Install locally even when invoked inside an editor's integrated terminal.
  delete env.VSCODE_IPC_HOOK_CLI;
  const failures = [];
  for (const editor of found) {
    try {
      console.log(`Installing companion extension in ${editor.name}...`);
      execFileSync(editor.cli, ["--install-extension", resolve(vsix), "--force"],
        { env, stdio: "inherit", timeout: 120_000 });
      const installed = execFileSync(editor.cli, ["--list-extensions", "--show-versions"],
        { env, encoding: "utf8", timeout: 30_000 });
      if (!installed.toLowerCase().split(/\r?\n/).some((line) => line.trim() === expected)) {
        throw new Error(`Editor did not report ${expected} after installation.`);
      }
      console.log(`Verified ${expected} in ${editor.name}.`);
    } catch (error) {
      failures.push(`${editor.name}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Extension installation failed:\n${failures.join("\n")}`);
  if (found.length) console.log("Reload open editor windows to activate the companion extension.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installExtensions(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
