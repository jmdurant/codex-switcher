$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$extensionRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-account-switcher-resume-" + [guid]::NewGuid())
$extensionStage = Join-Path $stagingRoot "extension"
$outputPath = Join-Path $extensionRoot "ai-account-switcher-resume.vsix"

try {
    New-Item -ItemType Directory -Path $extensionStage -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $extensionRoot "package.json") -Destination $extensionStage
    Copy-Item -LiteralPath (Join-Path $extensionRoot "README.md") -Destination $extensionStage
    Copy-Item -LiteralPath (Join-Path $extensionRoot "dist") -Destination $extensionStage -Recurse
    Copy-Item -LiteralPath (Join-Path $extensionRoot "assets\extension.vsixmanifest") -Destination (Join-Path $stagingRoot "extension.vsixmanifest")
    Copy-Item -LiteralPath (Join-Path $extensionRoot "assets\content-types.xml") -Destination (Join-Path $stagingRoot "[Content_Types].xml")

    if (Test-Path -LiteralPath $outputPath) {
        Remove-Item -LiteralPath $outputPath -Force
    }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $outputPath)
    Write-Output "Packaged extension: $outputPath"
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
