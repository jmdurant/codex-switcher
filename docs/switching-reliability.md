# Switching reliability — app 0.2.17 / companion 0.2.26

Scope: account activation, exact session binding, recoverable switching, accurate
status, and preserved launch settings on Windows, macOS, and Linux.

## Implemented

- [x] Verify the actual daemon credential on Windows and Unix; honor CODEX_HOME.
- [x] Recover credential and selection changes after errors and interrupted operations.
- [x] Use one coordinator and stale-decision checks for UI, tray, auto, web, and MCP.
- [x] Bind sessions without inferring ownership from conversation recency.
- [x] Support macOS discovery through ps/lsof instead of Linux /proc.
- [x] Preserve daemon mode, executable, approval, sandbox, model and profile options.
- [x] Show blocked, saved, verified, resume-pending, and failed states separately.
- [x] Add failure injection, ownership fixtures, and a Windows/macOS/Linux CI matrix.
- [x] Build, install, and verify the updated app and companion.

## Changes and recovery

The previous Windows account path could terminate every codex.exe while trying
to restart IDE integrations. That termination has been removed. Interruption
requires exact session captures and current terminal process coverage.

Auth and account files use atomic replacement. OS file locks serialize account
operations between desktop, web, and MCP processes. A private pending-switch
journal records the previous credentials and intended selection. Selection is
committed after credential replacement and daemon verification. Failures restore
the previous state; a failed rollback leaves a recovery record for the next
switch. Recovery is scoped to the original CODEX_HOME. A newer external login
is preserved when detected; explicitly capturing it resolves that conflict.

The journal contains credentials, uses private file permissions, and must never
be included in diagnostics or frontend IPC.

The daemon refresh handler checks current credential identity and selection.
Token refresh avoids overwriting a separately changed local login.

## Session identification

Supported evidence is an explicit resume UUID, verified /status output, manual
linking, or one conversation writer lock owned by a terminal descendant.
Shared-daemon ownership does not identify a terminal. Unlinked sessions are
excluded from capture, even with goal continuation disabled.

Linux reads /proc cwd and descriptors. macOS and other Unix hosts use ps/lsof.
Windows uses Restart Manager and process ancestry. Recovered macOS launches with
value options require explicit linking when the original argument boundaries
cannot be recovered. Shell expansions and ambiguous quoting are reported instead
of replayed with changed meaning.

Bridge protocol 2 rejects old companion hosts. After installing 0.2.26, reload the
editor. For an existing daemon terminal, run /status; if needed, use
**AI Account Switcher: Link Codex Session** and supply the original launch command.

## Verification

- Frontend build and 51 frontend tests passed on Windows.
- Companion type checks, 112 tests, build, and VSIX packaging passed on Windows.
- 108 Rust tests passed (two optional local probes skipped in the regular suite).
  They cover activation failure, commit failure, interrupted writes,
  rollback failure, competing external login, signed-out recovery, last-account
  deletion, credential reformatting, and CODEX_HOME scoping.
- The native Windows daemon transport completed a read-only WebSocket handshake
  and exact credential comparison against installed Codex 0.163.0.
- Cargo binary checks passed on Windows.
- The unsigned Windows NSIS installer completed successfully. Installed app
  0.2.17 matches the release binary by SHA-256 and its process is responsive.
  Companion 0.2.26 is installed in VS Code and Antigravity IDE; both installed
  JavaScript bundles match the tested build by SHA-256.
- The Tauri bundler warns that its updater bundle-type marker is absent. Local
  installation succeeds; automatic updater packaging is outside this switching
  verification and needs checking before a signed release.
- CI now runs frontend, companion and Rust checks on Windows, macOS and Linux.
  Native macOS/Linux runs were not performed from this Windows workspace.
- No live account was switched and no user Codex terminal was interrupted during
  verification. Resume behavior has automated bridge coverage; a full live
  switch/resume remains a user acceptance check.

## Runtime protocol evidence

Local Codex 0.163.0 app-server proxy transports raw WebSocket bytes over stdio,
not newline JSON. getAuthStatus(includeToken: true, refreshToken: false) allows an
internal exact credential comparison. The response is never logged or sent to
the UI. account/read does not expose workspace ID, so email alone is insufficient
verification. The daemon is not started or stopped by the handoff.

Externally managed daemon authentication needs the switcher connection available
for refresh requests. Closing that connection or using an unsupported Codex
runtime can require activation again; these failures are reported explicitly.
