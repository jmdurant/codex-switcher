# Staggered warm-up rotation

36 quota/rotation tests pass, including persisted hourly spacing, exclusion of
used/exhausted/active/unknown accounts, swapped window slots, and Pro reserve
selection between due five-hour windows. No real warm-up or full credential
rotation was performed by these tests. Provider first-contact activation remains
a live verification item. The strategy and README describe the implemented
scheduler and its restrictions.

# Capacity retry extension 0.2.4

Implemented Off/Ask/Automatic capacity recovery. All 71 extension tests and type
checks pass, including a mocked full controller flow, exclusive durable claims,
retry caps, and cancellation checks. The recorded August 30 `serverOverloaded`
failure supplies the classification fixture. A live bounded newest-turn history
read succeeded; no real provider failure or live automatic input was induced.
Automatic only submits to observed background terminals with a fresh known
empty prompt; focused or recovered/unobserved terminals fall back to Ask.
Default is Ask. Installed-host activation still requires editor reload.

# Account switching and resume validation

Run: September 7, 2026, Windows; current uncommitted working tree.

## Stale-dialog cleanup follow-up (extension 0.2.2)

Added conservative cleanup for the known paused-goal dialog in exact sessions
resumed by the extension. Two fresh reads must show a cleared goal or the same
completed goal. A single Escape without Enter dismisses it; a valid paused goal
is preserved. The watcher also handles a goal cleared after the prompt appears.
All 49 extension tests and the type check passed, including terminal-output
races, failed reads, replacement goals, delayed clearing, and unrelated prompts.
The new dismissal action has not yet been verified live; the earlier live
session/goal tests below predate this cleanup feature.

## Live session and goal results

After the second terminal received its first message, both root CLI sessions
were readable and automatically captured with distinct IDs in the same folder.
Three scoped bridge tests then passed against the installed 0.2.1 extension:

1. **Exact session restart:** captured the second session, limited this test's
   bridge response to that session, stopped only its Codex process, and released
   the ready request. A new process owned the same conversation under the same
   terminal shell PID. The primary conversation's process remained running.
2. **Active goal continuation:** created a temporary 5,000-token test goal in
   that second session. After capture and controlled restart, Codex continued
   it, wrote the expected `RESUME_TEST_PASSED` marker, and marked it complete.
   The extension observed the goal already running and sent no duplicate input.
   The budget remained 5,000; final reported usage was 5,784 (not a hard-cap
   enforcement test). This exercised automatic continuation, not the fallback
   `/goal resume` input branch.
3. **Paused goal preservation:** configured a paused test goal with remaining
   budget, restarted the same session, and verified it remained paused with
   unchanged usage. The temporary goal was cleared after verification.

Continue Interrupted Goals was enabled in Antigravity IDE user settings for
these tests and remains enabled. No banked resets were redeemed and no account
credentials were changed. These were controlled process restarts through the
real extension bridge, not full account-switch UI tests. On Windows the current
account-switch backend closes all `codex.exe` processes, including the terminal
hosting this conversation; a full account-switch test remains outstanding.

## Automatic identification follow-up (extension 0.2.1)

The extension now identifies Windows terminals through read-only conversation
writer-lock ownership and process ancestry, verified against root CLI thread
metadata and the terminal workspace. Existing terminals can be rediscovered
after reload. No latest-thread inference, hook installation, or terminal input
is used for identification.

All 36 extension tests and its type check passed. Added coverage includes fresh
launches, reload recovery, distinct terminals sharing a directory, ambiguous
ownership, malformed native output, and exclusion of noninteractive/subagent
threads. A live native lookup found two distinct process-owned conversations;
one passed the root-thread API check, while the newly opened empty session
returned `thread not loaded`. Discovery retries automatically as Codex persists
that session. No live account switch or goal continuation was performed.

Extension 0.2.1 was installed and version-verified in VS Code and Antigravity IDE.
Another editor reload activates this update. Manual linking remains a fallback
for unsupported platforms or unresolved ownership, not the normal Windows flow.

After the next user reload, a live prepare probe automatically captured the
existing terminal's exact session ID without manual linking. Its goal API
returned no goal. The second terminal's writer lock was found, but its thread
still returned unreadable through App Server, consistent with the previous
empty-session observation. The prepare probe was cancelled; no account switch
or resume was performed. Automatic identification of the existing terminal is
now verified in the installed extension, while the separate test session still
needs a persisted conversation before the remaining live test.

## Automated results

| Check | Result |
| --- | --- |
| `node --experimental-strip-types --test tests/*.test.ts` | 37 passed |
| `pnpm --dir ide-extension run test` | 28 passed |
| `pnpm --dir ide-extension run check` | Passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 76 passed, 1 explicitly ignored local-login smoke test |
| Installed Codex App Server read-only smoke check | Initialization, exact thread and goal read, and rejection of a mismatched workspace passed |

The native smoke check found no goal on the sampled thread. It started no turns
and changed no account credentials. It verifies protocol compatibility, not
successful live goal continuation.

The extension integration tests execute the bundled extension with simulated
VS Code terminal events and a simulated goal API, using real temporary bridge
files. They cover exact session relaunch, one continuation input, duplicate
polling, quota-limited goals, cancellation, deliberate pauses during switching,
replacement goals, changed/exhausted budgets, completed/blocked goals, already
running goals, unrelated prompts, and disabling continuation. Nine additional
cases were added in this run. The bridge does not persist goal objective text.

Account tests cover quota selection/freshness/cancellation and rotated credential
preservation. They do not perform a production account switch.

## Remaining live acceptance test

After the user's editor reload, a live prepare request received responses from
two Antigravity IDE companion clients within 1.5 seconds. Both captured zero
Codex sessions and zero goals; their live heartbeats also listed no active tools.
The probe was cancelled afterward. This confirms live bridge communication but
leaves account switching and goal continuation untested until a supported
integrated-terminal Codex session is running and linked.

The current Windows release build was subsequently built and installed to the
existing Codex Switcher directory, verified by executable hash, and restarted.
The app version remains 0.2.12 (local working-tree build). Companion extension
0.2.0 was installed and verified through both VS Code and Antigravity IDE CLIs.
Open editor windows still require reload before claiming runtime activation.
The Windows build emitted the existing Tauri bundle-type metadata warning;
updater behavior was not validated.

After installing the current switcher and extension, reload the editor and use
a disposable, exact-linked CLI session with a bounded test goal. Enable the
extension's Continue Interrupted Goals option. Capture the session ID and goal
budget/usage before switching to another usable account. Verify the same session
returns, its unchanged goal continues once, and accounting is preserved. Switch
back and repeat, then verify a deliberately paused goal stays stopped.

A live switch closes running Codex processes and may affect other sessions.
The automated results above do not establish that this disruptive end-to-end
test has passed. No banked resets were redeemed during these checks.
# September 7 follow-up: cleanup and background console

Extension 0.2.2 live cleanup exposed a regression: title-spinner updates invalidated
the visible resume dialog. Version 0.2.3 ignores complete nonvisual metadata updates.
A native Codex 0.153.4 PTY test using the cleanup class observed the paused-goal
dialog, cleared the disposable test goal through the API, sent exactly one Escape,
and verified the dialog disappeared and the input composer returned. The CLI's
paused-goal footer remained stale; the persisted goal was cleared. This verifies
native dialog behavior, not the newly installed extension host before reload.

The extra visible console was the extension's read-only `app-server --stdio`
process, started by the npm shim at editor reload. Its shim did not pass
`windowsHide` to the native child. Version 0.2.3 resolves the native binary directly
and spawns it hidden. A live read with the new resolver succeeded. Type checking
and all 52 extension tests passed. No account credentials changed and no resets
were redeemed in this follow-up.

## September 7, 4:23 PM switch follow-up

The ready bridge request `cf9549c3-8283-4d47-900d-7d635ae33380` captured one
Codex session in the codex-switcher editor and zero in the DroneCapture editor.
The editor logs record three original terminal command exits around 16:23:55–57.
The bridge became ready at approximately 16:24:08. A currently running exact
resume process was created at 16:24:13; another CLI process started at 16:25:08.
The old extension's untimestamped "Resumed" message only establishes command
submission. It does not establish successful startup or identify whether later
launches were manual. The transient console windows have not been attributed.

Companion 0.2.5 removes shell cwd and goal-read dependencies from native-owned
session discovery: it reads the authoritative cwd from the exact process-owned
root CLI thread. Goal operations still validate the captured workspace. Unknown
sessions in separate terminals sharing a directory are no longer deduplicated
by directory. Resume logs now distinguish command submission from a native
ownership check, include timestamps, and report observed startup exits.

Validation: type checking, all 77 extension tests, packaging, and read-only
metadata reads for both currently running CLI sessions passed. Added regressions
cover missing/stale shell cwd, unavailable goal reads, separate unlinked terminals,
and startup exit reporting. Installed 0.2.5 in Antigravity IDE and VS Code and
verified both installed JavaScript hashes against the build. Open editor hosts
still need reload. No account switch, terminal restart, or reset redemption was
performed during this investigation; live recovery remains unverified.
