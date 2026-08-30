# AI Account Switcher Resume

Companion extension for AI Account Switcher. It observes Codex and `agy`
commands through VS Code-compatible terminal shell integration. When the
switcher changes profiles, the extension captures active terminal sessions and
resumes them in the same terminal (or a replacement terminal after the IDE has
restarted).

The bridge is local-only and exchanges fixed tool identifiers and workspace
paths through `~/.codex-switcher/ide-bridge`. It never copies OAuth tokens or
accepts arbitrary commands from the switcher.

Shell integration must be enabled for command detection. Remote extension hosts
are intentionally ignored because their filesystem and processes may be on a
different machine from the switcher.
