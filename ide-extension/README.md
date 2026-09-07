# AI Account Switcher Resume

## Temporary capacity retries (0.2.4)

Set **AI Account Switcher Resume: Capacity Retry** to `off`, `ask` (default), or
`automatic`. Ask offers **Copy continue**, which copies that text and focuses the
terminal for you to review and submit. It does not press Enter.

Automatic reads the newest persisted turn every seven seconds and responds only
to a recent failed turn with `serverOverloaded`. It waits 30, 60, 120, 240, then
300 seconds plus up to five seconds of jitter, with at most five attempts per
session in a rolling hour. Per-turn claims persist under
`~/.codex-switcher/ide-bridge/capacity-retries`, preventing duplicate submissions
across reloads and competing editor hosts. Failed or uncertain delivery is not
resent. A new turn acknowledges delivery; after 15 seconds without one, the
extension offers manual inspection (checked on the next poll).

Automatic input requires an observed **background** terminal, a fresh known empty
`Ask Codex to do anything` prompt, unchanged exact conversation ownership, and
either no goal or an active goal with remaining budget. Focusing a terminal,
editing its input, changing settings, or preparing a switch cancels eligibility.
Paused/blocked/completed goals, approvals, credit limits, and login errors never
trigger automatic input. No models, accounts, goal budgets, or resets are changed.

Sessions recovered after editor reload have identity but may lack live output
observation. They fall back to Ask, as do focused terminals and unrecognized CLI
prompts. A newly launched/resumed session can gain live observation. Automatic
mode is a conservative terminal integration, not a guarantee of unattended
recovery on every CLI version. Never start a second API-owned turn in the same
conversation to bypass an unobservable terminal.

Validation: 71 extension tests, including a mocked complete retry flow and the
recorded capacity error; a live bounded history read also succeeded. A real
provider overload and automatic terminal submission have not been induced in
this release's live testing.

Version 0.2.3 launches the native Windows Codex reader directly with its console
hidden, bypassing npm's child launcher. Stale-dialog cleanup ignores title-spinner
and rendering-metadata updates while preserving checks for actual screen changes.
Native CLI testing confirmed that clearing the test goal dismissed the observed
resume dialog with one Escape and returned to the input prompt. Codex can retain
a stale paused-goal footer until its session refreshes.

Companion extension for AI Account Switcher. It observes Codex and `agy`
commands through VS Code-compatible terminal shell integration. When the
switcher changes profiles, the extension captures active terminal sessions and
resumes them in the same terminal (or a replacement terminal after the IDE has
restarted).

The bridge is local-only and exchanges fixed tool identifiers, workspace paths,
and optional exact session IDs and goal fingerprints through
`~/.codex-switcher/ide-bridge`. It never copies OAuth tokens or goal objectives,
and never accepts arbitrary commands from the switcher.

Shell integration must be enabled for command detection. Remote extension hosts
are intentionally ignored because their filesystem and processes may be on a
different machine from the switcher.

Build a local VSIX from the repository root with
`pnpm --dir ide-extension run package`. This runs type checks, tests, and the
build before packaging. macOS/Linux use `zip`; Windows uses PowerShell.
Install the result with
`code --install-extension ide-extension/ai-account-switcher-resume.vsix --force`.

## Continue interrupted Codex goals

Version 0.2.0 adds the opt-in setting
`aiAccountSwitcherResume.continueInterruptedGoals` (default `false`). Enable it in
the editor's settings to continue a running goal after a successful profile
switch. The switcher and this extension both need to be running.

### Automatic session identification on Windows

Version 0.2.1 identifies plain `codex` launches automatically. Every five seconds,
it uses read-only Windows Restart Manager queries to find the process holding
each Codex conversation writer lock, matches process ancestry to the terminal's
shell PID, and verifies the exact conversation and workspace through App Server.
Root CLI conversations are eligible; subagent and noninteractive sessions are
excluded. Two terminals sharing a folder remain distinct. It never chooses a
conversation merely because it is newest in that folder.

Existing terminals can also be rediscovered after an editor reload when their
shell PID and shell-integration working directory are available. No command is
typed into a terminal to identify it. A fresh empty session may need its first
message before Codex persists the conversation for API verification.

Discovery requires the CLI's `thread-writer-locks` layout (verified with 0.153.4),
Windows PowerShell/CIM, and access to query lock ownership. These are local
implementation details, not a stable Codex API contract. Unknown or ambiguous
ownership stays unidentified. macOS/Linux retain explicit-resume identification
and the manual fallback below. Goal continuation remains opt-in.

### Manual fallback

For a Codex terminal launched while this extension is active:

1. Run `/status` in Codex and copy its Session ID.
2. Keep that terminal selected and run **AI Account Switcher: Link Codex Session**
   from the command palette.
3. Paste the ID. The extension verifies the session against the terminal's
   working directory using the local Codex App Server API.
4. Enable **Continue Interrupted Goals** in the extension settings.

An explicit `codex resume <UUID>` invocation is recognized automatically. Each
subsequent switch uses that same UUID. Separate linked sessions in the same
directory are captured separately; duplicate references to one session are not
launched twice. Windows discovery rechecks conversation ownership; other
platforms require relinking after interactive conversation changes. The extension
also invalidates a binding when later `/status` output shows a different ID.

With goal continuation enabled, an unidentified Codex session is not relaunched
using `--last`: the extension reports the missing identity instead of guessing.
With the setting off, ordinary unidentified sessions retain the previous
`codex resume --last` behavior. `agy` continues to use `agy --continue`.

### Continuation rules

Version 0.2.2 adds **Cleanup Stale Goal Dialogs**, enabled by default separately
from goal continuation. In exact sessions relaunched by the extension, it watches
for the full paused-goal question and both known choices. If two fresh API reads
confirm the goal is absent, or the same prelaunch goal is complete, it sends
Escape once without Enter to dismiss the stale question. It does not change the
goal, select Resume, or dismiss a valid paused/replaced goal or unrelated prompt.

The watcher also detects a goal cleared after its dialog appears, checking every
two seconds for up to five minutes. It requires a prompt observed within the
first minute of relaunch; later terminal output invalidates that observation
unless the full prompt is observed again. API errors, changed session identity,
closing the terminal, or disabling cleanup prevent input. A dialog already on
screen before extension activation is not assumed observable and may still
need manual dismissal. This cleanup has automated integration coverage; its
Escape behavior still needs a live check against the installed CLI.

- Capture only goals that are `active` or `usageLimited`, with remaining budget.
- Leave previously paused, blocked, completed, and budget-limited goals stopped.
- Read the goal again before relaunch and before continuation. A changed goal,
  changed budget, exhausted budget, mismatched workspace, or unavailable API
  prevents automatic continuation. A goal paused before relaunch stays paused.
- Wait for the original shell execution to finish before issuing the resume
  command. Do not type a shell command into a terminal still executing something.
- After exact resume, recognize the goal-specific paused-goal choice or paused /
  usage-limited goal footer. Confirm that specific choice or send the fixed
  `/goal resume` command once. If the goal already shows as running, send nothing.
- If readiness cannot be verified within 60 seconds, leave the session open for
  manual inspection. Generic approval, login, or trust prompts are not accepted.
- Preserve the existing goal's objective, token budget, and accumulated usage.
  The API client is read-only; it never creates a goal or starts an API turn.

The goal-specific terminal text was checked against Codex CLI 0.153.4. Other
versions or localized interfaces may need manual continuation. The CLI must be
available on the extension host's PATH, and its environment must use the same
Codex home as the terminal. Remote CLI endpoints are unsupported. On platforms
without native discovery, terminals started before activation need restarting
and interactive conversation changes need relinking.

This is an experimental terminal integration. A continuation request is not a
guarantee that the goal starts successfully: Codex can still require approval,
encounter another limit, or stop on its own conditions. No live user goal is
started by the extension test suite; tests simulate the terminal and bridge.

References: [goal controls](https://learn.chatgpt.com/use-cases/follow-goals) and
[persisted goal API](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal).
