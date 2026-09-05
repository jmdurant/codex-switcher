import { cpSync, mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));

if (process.platform === "win32") {
  execFileSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(extensionRoot, "scripts", "package.ps1"),
  ], { stdio: "inherit" });
} else {
  const stagingRoot = mkdtempSync(join(tmpdir(), "ai-account-switcher-resume-"));
  const outputPath = join(extensionRoot, "ai-account-switcher-resume.vsix");
  // Build beside the destination so replacing an existing package is atomic.
  const temporaryOutput = `${outputPath}.${process.pid}.zip`;
  try {
    const extensionStage = join(stagingRoot, "extension");
    mkdirSync(extensionStage);
    for (const name of ["package.json", "README.md", "dist"]) {
      cpSync(join(extensionRoot, name), join(extensionStage, name), { recursive: true });
    }
    cpSync(join(extensionRoot, "assets", "extension.vsixmanifest"),
      join(stagingRoot, "extension.vsixmanifest"));
    cpSync(join(extensionRoot, "assets", "content-types.xml"),
      join(stagingRoot, "[Content_Types].xml"));
    execFileSync("zip", ["-q", "-r", resolve(temporaryOutput),
      "extension", "extension.vsixmanifest", "[Content_Types].xml"],
    { cwd: stagingRoot, stdio: "inherit" });
    renameSync(temporaryOutput, outputPath);
    console.log(`Packaged extension: ${outputPath}`);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(temporaryOutput, { force: true });
  }
}
