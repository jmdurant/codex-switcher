import test from "node:test";
import assert from "node:assert/strict";
import { quotaOption, quotaWindows, rankQuotaOptions } from "../src/lib/quotaOptions.ts";
import type { AccountWithUsage, UsageInfo } from "../src/types/index.ts";

const now = Date.parse("2026-09-07T12:00:00Z");
const hour = 3600000;
function account(id: string, overrides: Partial<UsageInfo> = {}): AccountWithUsage {
  return {
    id, name: id, email: null, plan_type: "pro", subscription_expires_at: null,
    auth_mode: "chat_g_p_t", is_active: false, created_at: "", last_used_at: null,
    usage: { account_id: id, plan_type: "pro", primary_used_percent: 20,
      primary_window_minutes: 10080, primary_resets_at: (now + 72 * hour) / 1000,
      secondary_used_percent: null, secondary_window_minutes: null, secondary_resets_at: null,
      has_credits: false, unlimited_credits: false, credits_balance: "0", error: null, ...overrides },
  };
}

test("weekly-only quota is usable without purchased credits, independent of plan name", () => {
  const a = account("weekly");
  assert.equal(quotaOption(a, now).available, true);
  assert.deepEqual(quotaWindows(a.usage).map(w => w.label), ["Weekly"]);
  a.plan_type = "unrecognized_20x";
  assert.equal(quotaOption(a, now).remaining, 80);
});

test("the tighter window determines headroom even when weekly is primary", () => {
  const a = account("dual", { primary_used_percent: 99, secondary_used_percent: 10,
    secondary_window_minutes: 300, secondary_resets_at: (now + hour) / 1000 });
  assert.equal(quotaOption(a, now).remaining, 1);
  assert.equal(quotaOption(a, now).low, true);
  assert.equal(rankQuotaOptions([a, account("healthy")], now)[0].account.id, "healthy");
});

test("requires every exhausted window to recover before suggesting availability", () => {
  const a = account("blocked", { primary_used_percent: 100, secondary_used_percent: 100,
    secondary_window_minutes: 300, secondary_resets_at: (now + hour) / 1000 });
  const result = quotaOption(a, now);
  assert.equal(result.available, false);
  assert.equal(result.recoveryAt, now + 72 * hour);
});

test("healthy quota replenishing soon is favored over more quota replenishing later", () => {
  const soon = account("soon", { primary_used_percent: 60, primary_resets_at: (now + 2 * hour) / 1000 });
  assert.equal(rankQuotaOptions([account("later"), soon], now)[0].account.id, "soon");
  soon.usage!.primary_used_percent = 95;
  assert.equal(rankQuotaOptions([soon, account("later")], now)[0].account.id, "later");
});

test("missing, erroneous, loading, expired, and incomplete usage cannot be recommended", () => {
  for (const a of [
    { ...account("missing"), usage: undefined },
    account("error", { error: "offline" }),
    { ...account("loading"), usageLoading: true },
    account("expired", { primary_resets_at: now / 1000 }),
    account("nan", { primary_used_percent: NaN }),
    account("negative", { primary_used_percent: -1 }),
    account("incomplete", { secondary_used_percent: null, secondary_window_minutes: 300 }),
  ]) assert.equal(quotaOption(a, now).available, false, a.id);
});

test("banked redemption is reflected from new percentages and timestamps, not old dates", () => {
  const exhausted = account("reset", { primary_used_percent: 100 });
  assert.equal(quotaOption(exhausted, now).available, false);
  const refreshed = account("reset", { primary_used_percent: 0, primary_resets_at: (now + 168 * hour) / 1000 });
  assert.equal(quotaOption(refreshed, now).remaining, 100);
  assert.equal(quotaOption(refreshed, now).nextReset, now + 168 * hour);
});

test("ties are deterministic and ranking does not mutate the input", () => {
  const input = [account("b"), account("a")];
  assert.deepEqual(rankQuotaOptions(input, now).map(o => o.account.id), ["a", "b"]);
  assert.deepEqual(input.map(a => a.id), ["b", "a"]);
});
