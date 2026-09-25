# Local agent connection

Account Switcher includes a local stdio MCP server. Launch the installed desktop
executable with `--mcp` to connect a client; keep the normal GUI running as the
operation worker. The MCP process does not start another GUI or expose an HTTP port.

In **Settings → Quota & switching → Agent connection**, enable access and choose
standing permissions for switching, interrupting captured IDE sessions, and spending
banked resets. New installations default to disabled. Allowed accounts, a reset
threshold, and an operation cooldown are enforced by the app, not by tool descriptions.

For Codex, copy the configuration shown in the settings panel into the user-level
`config.toml`, or register the installed executable:

```powershell
codex mcp add account_switcher -- 'C:\Users\you\AppData\Local\Codex Switcher\codex-switcher.exe' --mcp
```

Other local MCP clients use the same executable and `args: ["--mcp"]`. The transport
supports MCP 2024-11-05 through 2025-11-25 lifecycle negotiation, tool discovery,
tool calls, notifications and ping. Codex configuration reference:
https://developers.openai.com/codex/mcp

## Tools

| Tool | Behavior |
| --- | --- |
| `get_quota_options` | Reads allowed ChatGPT accounts, live quota, reset times and available credits. Optionally takes `account_id`. Never returns credentials. |
| `switch_and_resume` | Accepts `account_id`, `expected_active_account_id`, and a client-generated UUID `operation_id`. Queues a durable operation and returns its ID/state. |
| `get_operation_status` | Reads the journal using `operation_id`, including startup verification reported by the companion extension. |
| `list_operations` | Lists the latest 30 operations so a reconnected agent can locate an earlier request. |
| `use_reset` | Accepts `account_id`, `credit_id`, and a UUID `operation_id`; spends only that available Codex reset on the active account if policy and fresh quota allow it. |

Use account IDs returned by `get_quota_options`, not email addresses. Save the
operation UUID before calling either mutation. A retry with the same UUID and same
arguments returns the original operation; changing arguments under that UUID fails.
Only one agent mutation can be pending. Do not submit a new operation UUID to work
around an `uncertain` or `interrupted` outcome.

The app stores its settings and journal in
`~/.codex-switcher/agent-control/journal.sqlite`. It commits the operation before
acknowledging it. Work is owned by the GUI and survives the requesting MCP process
being killed. A GUI crash/restart marks unfinished work `interrupted` and does not
replay it. Inspect active login, quota, and IDE sessions before taking another action.
This is a same-OS-user connection, not an isolation boundary against other programs
running as that user. No bearer tokens are copied into the journal.

## Switching and continuation

Switching changes the shared local Codex login. The app validates the target's
quota and credentials, captures supported IDE terminals, verifies that every
process it would stop belongs to an exact captured session, closes them, switches,
and releases the captures for resumption. GUI and MCP switching use the same
backend sequence lock. If switching fails after closing terminals, it requests
resume on the account still active.

Agent-driven interruption requires the companion extension. Standalone/native
Codex desktop sessions are not automatically captured/resumed and block agent
switches while running. Ordinary GUI switching keeps its existing manual behavior.

Install companion extension 0.2.7 or later and reload the editor for startup
verification. `resume_requested_sessions` only means resume was requested.
`resume_verified` means every expected session was subsequently found running;
it does not mean its task has completed. An older extension can resume but cannot
report startup verification. Failure reports take precedence over verification.

Continuing an interrupted goal additionally requires the extension setting
**Continue Interrupted Goals**. Existing checks for exact session identity,
goal state and budget still apply. Deliberately paused goals remain paused.

MCP cannot make a quota-exhausted model call tools. Use Account Switcher's existing
auto-selection monitor for app-driven recovery, or have the agent request a switch
before it exhausts quota. Reset spending requires a tool request; this feature does
not add an automatic reset-spending loop.

## Reset redemption

The request format was verified against installed Codex desktop 26.901.6511.0:
`POST /backend-api/wham/rate-limit-reset-credits/consume` with `credit_id` and
`redeem_request_id`. This is a client backend route, not a documented public API,
and can change. The operation UUID is used as `redeem_request_id`. There is no
automatic POST retry. Unknown responses, transport failures and non-success HTTP
responses are recorded as `uncertain`; inspect credit status and quota before any
further spending.

The reset policy requires at least one verified quota window at or below the
configured remaining percentage, an available unexpired credit, and the same
active account at redemption. A reset may forfeit remaining quota and change
reset dates. Quota and credits are re-read after a confirmed redemption, with
refresh errors reported separately. A confirmed spend is not repeated if the
follow-up read fails. Spending does not restart or send input to sessions.

Tests use local mock redemption responses; no real credits are consumed by the
test suite.
