import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore Installer is a Node script, outside the frontend TypeScript build.
import { discoverEditors } from "../scripts/install-extensions-macos.mjs";

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
