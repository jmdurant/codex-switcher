# Token Utilization Strategy

Updated: September 7, 2026

This document describes the quota-selection strategy implemented in the current
working tree of AI Account Switcher, plus explicitly labelled proposals for
reset planning. It does not establish which version is installed on a particular
machine.

## Objective

Keep useful work running while reducing unused allowance that is about to reset
and helping the user avoid losing banked resets to expiration. Balance that with
weekly capacity and the disruption caused by changing accounts.

Our working observation is that demanding Astra sessions can exhaust an account's
available allowance in roughly 15–30 minutes. This is an observation from our
workload, not a guaranteed rate or a model-specific constant in the app. It
motivates giving short-window accounts a chance to handle real work before their
quota replenishes.

Although we call this token utilization, the current selector operates on usage
percentages and reset timestamps. It does not measure interchangeable token
balances or predict how many minutes of work an account can support.

## Resources we manage

| Resource | How we treat it |
| --- | --- |
| Five-hour allowance | A short-term opportunity to perform work before replenishment. Unused allowance represents a missed opportunity to use that window. |
| Weekly allowance | A longer-term constraint. An account with both windows must have capacity in both; five-hour usage also consumes weekly allowance. |
| Weekly-only allowance | A single reported constraint, without an assumed five-hour deadline. |
| Banked reset | A separate, expiring opportunity to restore usage limits. It is reviewed and redeemed manually. |
| Purchased credits | Separate from included plan quota. An empty purchased-credit balance alone does not make an account unavailable. |

Read the windows actually returned for the account. Do not infer them from labels
such as Plus, Pro, 10x, or 20x, and do not assume that the primary slot always means
five hours. A five-hour window can appear in either slot.

For selection purposes, remaining headroom is the **smallest remaining percentage
across the reported windows**. For example, 90% five-hour remaining and 2% weekly
remaining means 2% headroom. It does not mean the account has abundant usable
capacity. Percentages across different plans are not equal amounts of work.

## Preserve Pro quota with staggered five-hour rotation

The primary objective is to make weekly-only Pro allowances last longer while
continuing the same long-running conversation and goal. Use short-window accounts
near their reset deadlines, exhaust their usable quota, and let weekly-only
accounts cover the gaps. If another short-window account is already due, switch
directly to it instead of making an unnecessary Pro stop.

With both **Auto-select** and **Use expiring 5-hour quota first** enabled, the
implemented scheduler manages eligible short-window accounts automatically; their
individual auto-warm-up toggles do not need enabling. Configure the rotation in
**Settings → Quota & switching**. Both switches default on for unset preferences;
explicit saved off choices are respected. The lead time defaults to one hour.

The intended sequence is **Non-Pro 1 → Pro → Non-Pro 2 → Pro**, with these rules:

1. Prepare at most one fresh, unused five-hour account per hour. Require verified
   positive weekly headroom, an inactive ChatGPT account, and an explicit 300-minute
   window. A fresh window must report a reset approximately five hours away
   (295–305 minutes). Unknown or stale usage does not qualify.
2. Send the existing small warm-up request (Luna, low reasoning, `Thanks`), then
   refresh usage. This is a real request consuming quota. Do not infer plan/window
   semantics from marketing names or assume a failed warm-up had no effect.
3. Persist an attempt reservation **before** sending. All accounts share a minimum
   60-minute spacing; each attempted account is held for at least five hours.
   Failed or interrupted requests also occupy their slot. A browser-origin lock
   prevents duplicate scheduling across app views sharing that origin; unavailable
   locks or unreadable storage prevent automatic warm-up. Separate installations
   or browser origins are not coordinated by this local ledger.
4. Select a usable five-hour account when its reported reset enters the lead-time
   range, choosing the earliest deadline first. Stay until either limiting window
   reaches 0% or the short window resets. Another account entering the range does
   not displace the selected account.
5. On exhaustion, prefer another due five-hour account. Otherwise use a verified
   weekly-only reserve. If none is available, any usable alternative can keep work
   moving. No quota is fabricated and no banked reset is redeemed automatically.
6. Existing automatic and timed warm-ups skip five-hour accounts while this mode
   manages them. Explicit manual warm-up remains available and can disturb the
   intended spacing. Already-running windows retain their deadlines; warming them
   again cannot be assumed to realign their clocks.

Example, **assuming first-use activation and successful warm-ups**:

| Account | Warm-up | Preferred work begins | Expected short reset |
| --- | --- | --- | --- |
| Non-Pro 1 | Noon | 4 PM | 5 PM |
| Non-Pro 2 | 1 PM | 5 PM | 6 PM |
| Non-Pro 3 | 2 PM | 6 PM | 7 PM |

Pro handles the periods before and between those useful short-window runs. These
are preferred scheduling times, not guaranteed appointments: fresh provider
readings, remaining weekly quota, cooldowns, application uptime, and active work
can change the sequence. The scheduler checks every 30 seconds while the main app
is running. After sleep, it prepares at most one account and spaces the next
attempt from the actual contact; it does not burst through missed hourly slots.

### Activation evidence and continuity limitations

First actual model use after reset appears to anchor the next five-hour window;
a warm-up is intended to provide that contact. A usage lookup is not a model
request. This behavior has user reports, but has not been verified here with a
controlled dormant-window before/after test. Returned reset timestamps remain the
runtime scheduling input; 0% reported usage can reflect rounding and does not prove
that a window is dormant. The narrow freshness check avoids warming accounts
already well into a window but cannot establish provider activation semantics.

On September 7, two accounts reporting 0% used retained the same five-hour reset
timestamp across checks roughly two minutes apart. That observation alone did
not establish how their windows started. The earlier 4:23 PM forecast was based
on those timestamps and is conditional, not a confirmed activation schedule.

The existing companion extension resumes the exact conversation and eligible
goal across switches. Full live credential switching with goal continuation has
not yet been verified. Closing/relaunching a CLI can interrupt work, so preserved
history is not proof that every in-flight operation completed. This release does
not add idle-boundary switching, consumption-time prediction, a model fallback,
or automatic reset redemption.

Validation: 36 quota/rotation tests cover hourly spacing, persisted reservations,
per-account reuse, stale/unknown/exhausted eligibility, both window slots, and
weekly-only fallback between due short windows. Real five-hour activation and a
multi-account rotation still need live observation.

## Operating modes

### 1. Manual comparison

**Compare options** refreshes usage and banked-reset information. The user can
switch to an available account, review reset instructions, or keep the current
account. Automatic selection can be disabled independently using its toggle.

The comparison ranks verified usable accounts ahead of unavailable accounts.
Within usable choices, it prefers:

1. More than 10% remaining in every reported window.
2. A known upcoming reset within 24 hours, with earlier deadlines first.
3. More remaining headroom when the preceding rules tie.
4. Account name, then account ID, for deterministic ties.

This ranking is a practical heuristic. It does not convert plan percentages into
tokens. The ordinary account list and tray may still use their separate display
ordering; the quota comparison and automatic decision rules described here are
the utilization policy.

### 2. Standard automatic selection — enabled by default

**Auto-select the best available account** defaults to on for unset preferences
and preserves explicit saved choices. It checks every 30 seconds while
the app's main UI is running.

| Active account state | Automatic action |
| --- | --- |
| Any positive quota remaining in every reported window | Stay on the current account, including below 1%. |
| Exhausted | Use the highest-ranked verified usable alternative, even if it has low headroom. |
| Usage missing, invalid, or awaiting a reset refresh | Make no automatic selection from that uncertain state. |
| No eligible alternative | Stay and check again; manual reset review remains available. |

The current implementation waits for **0% reported remaining (100% used)** in
either limiting window. The 10% label only helps rank alternatives; it no longer
triggers departure. Provider reporting precision and the 30-second polling
interval determine when exhaustion becomes visible.

### 3. Use expiring five-hour quota first — optional within auto mode

Enable **Use expiring 5-hour quota first** to allow an early switch even when the
current account has plenty of quota. The lead-time choices are **15 minutes,
30 minutes, 1 hour, or 2 hours**, with **1 hour** as the default. The option itself
defaults to on; explicit saved on/off choices are preserved.

The rules, in order, are:

1. Verify the active account's usage. If its state is uncertain, wait for valid
   data before making a decision.
2. If the active account already has an eligible expiring five-hour window, stay
   on it until either limit is exhausted or the window resets. Do not leave just
   because remaining quota drops below 10%, or because another deadline becomes
   earlier.
3. Otherwise, consider accounts with an actual five-hour window, a known future
   reset within the lead time, and usable quota in every reported window. Among
   eligible accounts, choose the earliest five-hour deadline; break ties by ID.
4. If none qualify, use the standard automatic-selection rules.

Cooldown exclusions still apply. An expiring candidate may have less than 10%
remaining: this mode deliberately prioritizes using its remaining opportunity.
A weekly-exhausted account is never eligible, even if its five-hour allowance is
mostly unused.

After the five-hour reset, the special stay-on-account rule ends. That does not
force a switch: fresh usage is evaluated again, and staying may still be the right
choice. The app routes existing work; it does not create work to spend quota.

## Banked reset strategy

Keep redemption manual. Display available resets in expiration order, highlight
those expiring within three days in Quota options, and show the account and
workspace checks needed before redemption. Expired or unavailable resets are
excluded from the available list. Missing or malformed expiration dates require
verification in Codex; they are not evidence of unlimited validity.

When deciding whether to use a reset:

1. Compare the banked expiry with the account's natural reset times.
2. Consider using meaningful remaining quota before redeeming.
3. Prefer an earlier-expiring reset if Codex offers a choice, and redeem when it
   would restore capacity useful for the work at hand.
4. Refresh usage after redemption before deciding where to send work next.

OpenAI's documentation, checked September 7, 2026, says a full banked reset
refreshes eligible five-hour and weekly usage windows and **changes the weekly
reset date**. Reset eligibility and expiration can vary. Our implementation reads
the actual new timestamps after redemption rather than assuming the previous
schedule survives. See [How banked Codex resets work](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work).

Banked-reset expiry does **not** currently influence automatic account ranking.
An exhausted account does not become an automatic candidate merely because a
reset is available. Review and redemption happen in Codex for the matching
account and workspace; switching the local account does not change a browser's
signed-in account.

### Proposed reset planner — not implemented

The planner should maximize useful progress from the goal's remaining work while
preserving scarce resets when ordinary quota can keep it moving. It should
recommend what to do next and when to reconsider. Redemption remains manual.

The governing rule is: **preserve a reset while other capacity can bridge the
gap to natural replenishment, unless doing so risks losing a useful redemption
opportunity before expiry.** A reset should not be redeemed solely because its
account is exhausted, nor should usable resets be saved indefinitely.

#### Inputs and scope

For each account, evaluate its current windows, which windows actually prevent
work, and when all blocking windows will recover. For a weekly-only Pro account,
that is its weekly reset. For a dual-window account with both windows exhausted,
the five-hour reset alone is not enough.

For each banked reset, record its account/workspace, eligibility, affected
windows, status, and expiry. Do not treat different reset types as interchangeable.
Across accounts, evaluate alternatives that can perform the goal's work, their
remaining allowance, upcoming replenishments, and the interruption cost of
switching. A percentage on one plan is not equivalent to the same percentage on
another plan.

The goal's state matters too: is there useful work ready now, is there an actual
deadline, and is the user willing to pause briefly? A completed, deliberately
paused, budget-limited, or genuinely blocked goal is not a reason to redeem a
reset or manufacture activity.

#### Four recommendations

| Recommendation | When it fits | What the user sees |
| --- | --- | --- |
| **Save reset; use another account** | Alternative quota can plausibly cover the wait for natural recovery, and redemption opportunities remain before expiry. | The suggested account, natural recovery time, reset expiry, and confidence in the bridge estimate. |
| **Wait for natural reset** | Recovery is soon, the user accepts the idle time, and expiry risk is low. | Expected wait and the time to refresh usage. Do not claim an exhausted account has recovered before checking it. |
| **Use this account now; review its reset next** | A banked expiry is approaching, but the account still has meaningful ordinary quota. | Why this account should receive work, which reset comes next, and the latest sensible review time. |
| **Recommend redeeming now** | A reset would restore useful capacity and either prevent an unacceptable interruption or avoid losing a useful redemption opportunity. | The specific account/reset, what it is expected to restore, competing natural reset time, and manual redemption instructions. |

If evidence is missing, show **Needs review** rather than inventing a countdown or
a confident recommendation. A reset that cannot currently restore an eligible
window should not be represented as immediately useful.

#### Protect natural replenishment when practical

For an exhausted Pro account whose weekly reset is close and whose banked reset
lasts another two weeks, the normal recommendation is to use another account
until the weekly reset. Then use the naturally refreshed Pro allowance and keep
the banked reset for a later shortage.

This becomes stronger when redemption changes the weekly schedule: do not count
on receiving a full banked refill now **and** the previously scheduled weekly
refill shortly afterward. After redemption, discard that forecast and read the
actual reset timestamps. Even where an offer preserves a schedule, the decision
still depends on useful work gained before natural recovery.

If all suitable accounts are exhausted, the choice is between idle time and
spending a reset. Let a user preference control acceptable idle time; do not
silently assume that waiting several hours is acceptable for an unattended goal.
Keeping the task moving can justify a reset even when natural recovery is near.

#### Prevent expiration through planned use

Expiry urgency should reflect **remaining opportunities to redeem usefully**,
not just days remaining on a calendar. Start routing real work toward an account
before its deadline if it must first consume ordinary quota to benefit from its
banked resets.

An expiry is a deadline to redeem the banked benefit. Do not automatically treat
it as the deadline to consume every unit of restored quota; verify offer-specific
terms. For multiple resets, however, useful consumption between redemptions is
important: redeeming several full resets back-to-back can discard much of their
value or leave nothing eligible for a further reset.

For **N equivalent full resets on one account with a shared expiry E**, a rough
planning estimate is:

```text
latest time to start routing work to this account
  = E
    - time to consume useful existing quota
    - time to consume useful refills between the first N-1 redemptions
    - buffer for manual redemption, refresh, and uncertainty
```

The final refill need not be exhausted before E unless the offer requires that.
This is a planning estimate, not a current app calculation. It must account for
actual working hours, natural replenishments, workload changes, and other
accounts competing for the same goal's work. Unknown consumption rates should
produce an uncertainty range. Our observed 15–30-minute sessions are not a
reliable depletion rate for every Pro or 20x allowance.

Group differing expiries by deadline and reevaluate after each natural reset or
redemption. Three resets expiring tomorrow may deserve attention before one
expiring tonight if draining the former account takes much longer; earliest
expiry alone is not a sufficient scheduling algorithm. Within a set of equally
useful available resets, prefer the earliest expiry where the provider offers a
choice.

If there is insufficient useful work or time to use every reset meaningfully,
report the likely unused benefits. The strategy aims to avoid preventable waste;
it cannot guarantee all promotional benefits are useful for every workload.

#### Thinking effort and speed near expiry — proposed, not implemented

Plan over **account + model + reasoning effort + speed**, rather than account
alone. A temporary increase in capability or speed can be worthwhile when useful
work and expiring capacity coincide. The objective remains completed, correct
work; a higher quota-consumption rate alone is not an improvement.

Keep reasoning and speed separate:

- **Reasoning effort, including Ultra:** choose effort appropriate to the work.
  Official OpenAI documentation says higher effort can improve complex results
  but takes more time and tokens; Ultra can also use subagents for divisible
  work. It is not a fixed usage multiplier or a guaranteed speedup. See
  [Models](https://learn.chatgpt.com/docs/models).
- **Fast:** a speed/usage tradeoff, not a request for deeper reasoning. As checked
  September 7, 2026, the documented Astra Fast credit rate is 2.5 times Standard
  where available. This does not establish a 2.5-times speedup or a universal
  multiplier for every reported quota window. See
  [Speed](https://learn.chatgpt.com/docs/agent-configuration/speed).
- **Ultrafast:** treat as a separate capability to verify for the installed
  client, account, and model. OpenAI's August 13 announcement describes GPT-5.6
  Sol at up to 14 times Standard processing speed and up to 750 output tokens
  per second, initially in a limited API preview. Those are model-serving
  figures, not guaranteed end-to-end task acceleration or quota multipliers.
  See [Previewing Ultrafast](https://openai.com/index/previewing-ultrafast/).
  The API also documents the access-controlled tier for Sol. Neither source
  establishes an Astra `/ultrafast` command, subscription availability, or its
  quota multiplier. Keep those unknown until verified; do not substitute models
  silently. See
  [Responses service tiers](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

Keep API billing separate from subscription quota: an API-only acceleration
route is not evidence that it consumes the allowance a banked Codex reset
restores. Only include Ultrafast in reset-utilization forecasts after verifying
the actual billing/quota pool. Otherwise it is a separately costed way to speed
up a task, subject to the user's spending preferences, rather than a way to use
an expiring subscription reset.

Offer **Allow temporary acceleration near expiry**, off by default and separate
from automatic account selection. Let the user independently permit higher
effort (with a ceiling), Fast, and verified Ultrafast. Recommendations should
still be available when automatic changes are disabled. Respect the selected
model, delegation preferences, goal budget, and paid-credit spending settings.

| Situation | Proposed effort/speed decision |
| --- | --- |
| Plenty of time to use quota and redeem before expiry | Keep the user's normal settings. |
| Complex analysis or separable implementation remains, with capacity likely to go unused | Consider higher effort or Ultra when it is expected to improve useful results. |
| Model latency prevents useful work from fitting before the redemption deadline | Consider an allowed faster tier, retaining task-appropriate reasoning effort. |
| Time is mostly spent in tests, downloads, approvals, or other external waits | Do not assume a faster model solves the bottleneck. |
| Weekly recovery is near and the banked reset lasts weeks | Preserve the bridge-to-natural-reset strategy; acceleration may exhaust the bridge early. |
| Final expiring reset has been redeemed | Refresh its new windows and reevaluate; the old redemption deadline alone no longer justifies acceleration. |

Maintain separate estimates for **useful work completed per elapsed hour** and
**consumption of each quota window per active model minute**. Segment observations
by account, model, effort, speed, and workload; include child-agent usage where
observable. Separate tool/idle time from model time and detect natural resets
and redemptions rather than counting them as negative consumption. Account-wide
usage from other sessions lowers confidence in any one session's estimate.

Compare normal settings with allowed alternatives in the latest-start estimate
above. Show ranges for time to useful redemption, work likely completed, weekly
headroom afterward, and goal-budget use. Do not multiply an advertised credit
rate by an advertised speed factor and treat that as a measured depletion rate.
With sparse data, recommend a review rather than claim a deadline is guaranteed.

For example, an account with a reset expiring in 90 minutes and substantial real
work might benefit from temporary Fast if model latency is limiting progress.
Ultra is a separate decision about that work's complexity. Faster consumption
that merely replaces quota with another refill while finishing no additional
useful work is not a reason to accelerate. With several expiring resets, include
time for useful work between redemptions and manual redemption buffers.

Apply any future automatic setting change at a verified idle/turn boundary in
the exact linked session, then confirm the effective setting. Preserve the
baseline and restore it when the expiry opportunity ends, the account changes,
or the option is disabled, without overwriting a newer manual user choice.
Reevaluate after redemption and natural replenishment. Use minimum dwell times
to avoid oscillating settings; never send unverified slash commands into a
running terminal. The current extension has no effort/speed-control integration.

#### Initial defaults and decision order

Before reliable consumption history exists, start with understandable review
thresholds rather than claims of optimal scheduling:

- Keep the existing **three-day** expiry highlight as a planning reminder.
- Add a proposed **24-hour** urgent-review level. It increases attention and may
  favor routing work to that account; it is not an automatic redemption trigger.
- Reassess when quota changes materially, a natural reset occurs, a reset is
  redeemed, the goal changes state, or the next planned review time arrives.
- Ask the user to choose an acceptable idle-time policy, such as preserving
  resets versus keeping work continuous. This preference is not implemented yet.

First exclude ineligible resets and account states. Next check whether any
redemption opportunity is in danger of being missed. Otherwise prefer ordinary
quota that can bridge the wait, especially five-hour quota about to replenish.
If bridging is not viable, compare the user's acceptable wait with the useful
capacity a reset would restore. Among sensible redemption options, weigh expiry
urgency, useful restored capacity, and disruption to a nearby natural reset.
Recompute after every action; do not commit to a fixed sequence for the whole week.

#### Worked decisions

| Situation | Proposed recommendation |
| --- | --- |
| Pro exhausted; weekly reset in 45 minutes; banked reset expires in 14 days; another account has usable quota | Save the banked reset and use the other account to bridge the gap. Verify Pro's recovery before returning. |
| Same Pro account, but no alternatives | Offer a 45-minute wait or manual redemption. Favor waiting if the user accepts that delay; favor redemption if useful work must continue. |
| Pro exhausted; weekly reset in five days; banked reset expires in two days; substantial goal work remains | Recommend redemption when the task needs this capacity; do not preserve it for a natural reset that comes after its expiry. |
| Banked reset expires in three hours; its account still has substantial quota | Route work to this account early enough to make a useful redemption possible, then review. Do not redeem merely because the clock is short. |
| Three full resets expire tomorrow on an account that takes hours to drain | Begin a planned consume/redeem sequence now if the goal has enough work. Recheck each reset rather than applying all three together. |
| Goal is finished or blocked on user input | Do not redeem merely to avoid an unused reset. Surface the expiry and explain the lack of useful work. |

The first implementation should be a **reset advisor with reasons and review
times**, not automatic redemption. Consumption history and observed post-reset
behavior can later improve the estimates without changing the user's goal or
its budget.

## Examples

| Situation | Expected behavior |
| --- | --- |
| Active weekly-only account has 80% left; another account has 60% five-hour and 50% weekly remaining, with its five-hour reset in 45 minutes | Standard auto stays. Expiring-quota mode with a one-hour lead selects the short-window account, subject to cooldowns. |
| The selected short-window account falls to 4% five-hour remaining before reset | Expiring-quota mode stays while both limits remain usable. It leaves on exhaustion, at 0% reported remaining. |
| Five-hour quota is 80% remaining but weekly quota is exhausted | Exclude the account. A five-hour reset alone does not restore weekly availability. |
| Two eligible short windows reset in 20 and 50 minutes | Select the 20-minute deadline unless already using an eligible expiring window. |
| An exhausted account has a banked reset expiring tomorrow | Show manual reset review. Do not redeem or assume restored capacity automatically. |

## Freshness, switching, and recovery

- Manual comparison results older than two minutes require refresh. A selected
  target's usage is checked again before the switch request.
- Automatic selection fetches current usage, scans candidates in batches of up
  to three, and rechecks the active and selected accounts before acting. Failed
  candidate requests do not prevent other candidates from being considered.
- A passed reset timestamp is a reason to refresh, not permission to assume full
  quota. When several windows are exhausted, expected recovery requires all of
  them to recover.
- A changed active account, disabled auto mode, or conflicting app operation can
  cancel an in-progress automatic check.
- Automatic switch attempts and failed checks have a one-minute backoff. After
  a successful automatic switch, the account just left is excluded for five
  minutes. These controls are held in memory and reset when the UI remounts.
- Manual switches use the existing running-session confirmation. Auto mode may
  close running Codex sessions and attempt to resume supported IDE sessions.
  Resume depends on the companion integration and is not guaranteed for every
  session. A failed switch does not trigger a successful-switch resume.

## Current limitations and future refinements

### Continuing the task across account switches

The companion extension's optional **Continue Interrupted Goals** setting closes
the loop between choosing quota and continuing work. It captures an exact linked
Codex session and an eligible goal fingerprint before the switch, resumes that
session afterward, and requests goal continuation only after verifying its state
and a goal-specific terminal readiness signal. It preserves the objective,
budget, and accumulated usage. Banked resets remain manual.

On Windows, extension 0.2.1 automatically matches Codex writer-lock ownership to
the terminal process and verifies the conversation through App Server. Explicit
`codex resume <UUID>` commands are also recognized automatically. Manual linking
from `/status` remains a fallback for unsupported or ambiguous cases. Unknown identities
are never guessed with `--last` when goal continuation is enabled. Paused,
blocked, completed, and budget-limited goals are not automatically restarted.
Readiness failure leaves the session for manual inspection instead of repeatedly
sending commands. See the [extension setup and limitations](ide-extension/README.md#continue-interrupted-codex-goals).

The intended cycle is **work → evaluate quota → capture session and goal → switch
account → resume the same session → continue the existing goal**. This provides
continuity for an existing task; it does not expand its scope or override its
stopping conditions. It is not yet fully unattended: banked-reset redemption,
approvals, unsupported terminal states, and genuine task blockers can still need
the user.

### Recovering from temporary model capacity failures (extension 0.2.4)

History review on September 7 found one confirmed model-capacity interruption:
on August 30 at 1:29:31 PM Eastern, a `gpt-5.6-sol` high-effort turn failed with
`Selected model is at capacity. Please try a different model.` The persisted
turn error is `serverOverloaded` in the history database and `server_overloaded`
in the rollout's `task_complete.error.codex_error_info`. At 1:30:13 PM, the user
sent `try again`; the next turn used the same model and effort and completed at
1:36:46 PM. This establishes one successful retry after 42 seconds, not a
universal recovery time or an Astra-specific failure.

Evidence: local session `01a0537e-b2f9-7b71-9520-8db14bf0a76f`, failed turn
`01a053b5-c94d-7ce3-8c32-ff2ea32a51cc`, successful retry turn
`01a053b8-c4fa-7622-bebd-b6c2f710bd8a`. The same history database also contains
`usageLimitExceeded` and `unauthorized` failures; these require quota or sign-in
handling and must not enter the capacity retry loop.

The implemented **Capacity Retry** setting offers Off, Ask (default), and
Automatic. Ask offers **Copy continue**, focusing the terminal without submitting
anything. Automatic applies to observed background Codex terminals in the window
where it is enabled. Sessions recovered after reload without live output
observation, focused terminals, and unknown prompt layouts fall back to Ask.

The controller polls newest-first persisted turn history every seven seconds.
Only a recent terminal failure with the exact `serverOverloaded` error qualifies;
assistant prose, MCP errors, in-progress native retries, quota failures, and
sign-in failures do not. This does not assume stored runtime status proves that
a separate CLI process is idle.

Before sending fixed `continue`, the controller checks the same failed turn,
conversation identity, a fresh known empty input prompt, background-terminal
status, and either no goal or an unchanged active goal with remaining budget.
Any other goal status falls back to Ask. Screen changes invalidate the prompt;
complete title-spinner updates do not. Focus changes, settings changes, and
account-switch preparation cancel pending eligibility. The controller never
starts a parallel API turn, sends `/goal resume`, changes budgets, chooses a
model/account, or redeems a reset as part of capacity recovery.

Delays are 30, 60, 120, 240, and 300 seconds plus up to five seconds of jitter;
the seven-second polling interval can add latency. Five automatic attempts are
allowed per session per rolling hour, including across successful turns and
extension reloads. This is stricter than resetting the counter on every success.
Durable per-turn claims under the local bridge prevent duplicate submissions by
multiple editor hosts. Corrupt state and abandoned lock files fail closed.
Uncertain delivery consumes its claim; it is never automatically resent. The
next new turn acknowledges delivery. If no new turn is observed after 15 seconds,
the next poll offers manual inspection. Old errors over 15 minutes are ignored.

The terminal prompt allowlist currently recognizes `Ask Codex to do anything`;
other CLI layouts require manual retry. A paused goal is never assumed to have
paused because of capacity. Supporting additional transient errors, server retry
hints, more prompt layouts, and authenticated access to the running CLI's own
control channel are future work.

Validation includes 71 extension tests: the recorded overload code, successful
single input and new-turn acknowledgment in a mocked extension host, duplicate
claims across hosts/reloads, retry limits, typing/focus/settings cancellation,
new turns, changed/paused goals, quota failures, malformed API state, and missing
observation. A bounded read against the local live App Server succeeded. No real
provider outage or automatic live retry submission was induced in this release.

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes persisted turn reads and exponential backoff with jitter for server
ingress overload. That transport overload is distinct from the observed model
capacity failure; its guidance informs backoff, not the error classifier.

### Further utilization improvements

The initial strategy favors understandable decisions over a claim of optimal
allocation. It has no measured consumption-rate model, cross-plan token
conversion, model-specific runway estimate, or reservation of weekly quota for
future work. Expiring-quota mode can consume a scarce weekly allowance to use a
short window; its eligibility check only requires that weekly quota remain usable.

The staggered scheduler now sends activation warm-ups to qualifying fresh
five-hour accounts, while actual activation semantics remain a live-test item. Auto-selection depends on the running UI and
its timers; it is not an independent background scheduler. A 30-second check
interval cannot guarantee interruption-free handling of fast quota consumption.

Potential next steps, **not implemented**, are consumption-based lead times,
per-account weekly reserves, a durable decision history, and reset-aware
recommendations that estimate whether restored capacity can be used before the
next relevant deadline. Actual observed usage and reset outcomes should drive
those refinements.

## Implementation references

- [Quota evaluation and selection policy](src/lib/quotaOptions.ts)
- [Fresh automatic-decision checks](src/lib/autoQuotaSwitch.ts)
- [Automatic polling and cooldowns](src/hooks/useAutoQuotaSwitch.ts)
- [Comparison and reset-review UI](src/components/QuotaOptions.tsx)
- [Automatic-selection tests](tests/autoQuotaSwitch.test.ts)
- [Quota evaluation tests](tests/quotaOptions.test.ts)

The latest validation of the current implementation passed the production
frontend build and all 37 tests. Changes to this strategy should preserve tests
for window bottlenecks, expiring-window priority, staying until exhaustion,
reset-time changes, stale data, and cancellation during selection.
