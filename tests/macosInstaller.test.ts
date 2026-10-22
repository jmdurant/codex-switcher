import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore Installer is a Node script, outside the frontend TypeScript build.
import { discoverEditors, enableTerminalOutputApi } from "../scripts/install-extensions-macos.mjs";

test("enables the companion output API while preserving existing JSONC settings and a recovery copy", () => {
  const root = mkdtempSync(join(tmpdir(), "switcher argv "));
  try {
    const file = join(root, "argv.json");
    const original = '// preferences\n{"enable-crash-reporter":true,"url":"https://example.com",/* keep */"enable-proposed-api":["other.extension",],}\n';
    writeFileSync(file, original);
    assert.equal(enableTerminalOutputApi(file), true);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(settings["enable-crash-reporter"], true);
    assert.equal(settings.url, "https://example.com");
    assert.deepEqual(settings["enable-proposed-api"], ["other.extension", "jmdurant.ai-account-switcher-resume"]);
    assert.equal(readFileSync(`${file}.switcher-backup`, "utf8"), original);
    assert.equal(enableTerminalOutputApi(file), false);
    writeFileSync(file, '{"enable-proposed-api":true}');
    assert.throws(() => enableTerminalOutputApi(file), /Invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("finds editor CLIs in app paths with spaces and skips the standalone Antigravity app", () => {
  const root = mkdtempSync(join(tmpdir(), "switcher installer "));
  try {
    for (const [app, cli] of [["Visual Studio Code.app", "code"], ["Antigravity IDE.app", "antigravity-ide"]]) {
      const bin = join(root, app, "Contents", "Resources", "app", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, cli), "");
    }
    mkdirSync(join(root, "Antigravity.app"));
    const found = discoverEditors([root], false);
    assert.deepEqual(found.map((editor: {name: string}) => editor.name), ["VS Code", "Antigravity IDE"]);
    assert.equal(found[0].cli, join(root, "Visual Studio Code.app/Contents/Resources/app/bin/code"));
    if (process.platform !== "win32") {
      const alias = `${root}-alias`;
      symlinkSync(root, alias);
      try { assert.equal(discoverEditors([root, alias], false).length, 2); }
      finally { rmSync(alias); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
