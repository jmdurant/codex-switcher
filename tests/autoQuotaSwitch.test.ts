import test from "node:test";
import assert from "node:assert/strict";
import { findAutoQuotaSwitch } from "../src/lib/autoQuotaSwitch.ts";
import { expiringFiveHourReset, normalizeAutoQuotaPolicy, selectAutoQuotaOption } from "../src/lib/quotaOptions.ts";
import type { AccountWithUsage, UsageInfo } from "../src/types/index.ts";
const now = Date.parse("2026-09-07T12:00:00Z");
function account(id: string, remaining: number, hours = 48): AccountWithUsage {
  return { id, name: id, email: null, plan_type: "pro", auth_mode: "chat_g_p_t", is_active: id === "active", created_at: "", last_used_at: null, subscription_expires_at: null,
    usage: {account_id:id, plan_type:"pro", primary_used_percent:100-remaining, primary_window_minutes:10080, primary_resets_at:now/1000+hours*3600, secondary_used_percent:null, secondary_window_minutes:null, secondary_resets_at:null, has_credits:false, unlimited_credits:false, credits_balance:"0", error:null} };
}
function source(accounts: AccountWithUsage[]) {
  return { listAccounts: async () => accounts, getUsage: async (id: string) => accounts.find(a => a.id === id)!.usage!, now: () => now, cancelled: () => false };
}
const excluded = new Set<string>();
test("healthy active quota stays put even with a better-ranked alternative", () => {
  assert.equal(selectAutoQuotaOption([account("active", 11), account("soon", 90, 2)], now), undefined);
});
test("zero quota moves to the healthiest eligible ranking, excluding active and recent accounts", () => {
  const accounts = [account("active", 0), account("soon", 40, 2), account("later", 90)];
  assert.equal(selectAutoQuotaOption(accounts, now)?.account.id, "soon");
  assert.equal(selectAutoQuotaOption(accounts, now, new Set(["soon"]))?.account.id, "later");
});
test("low-to-low switching is suppressed until the active account is exhausted", () => {
  assert.equal(selectAutoQuotaOption([account("active", 5), account("other", 9)], now), undefined);
  assert.equal(selectAutoQuotaOption([account("active", 0), account("other", 9)], now)?.account.id, "other");
});
test("exhausted, unknown and API-key candidates are not automatic fallbacks", () => {
  const candidates = [account("active", 0), account("empty", 0), {...account("api", 90), auth_mode:"api_key" as const}, {...account("unknown", 90), usage:undefined}];
  assert.equal(selectAutoQuotaOption(candidates, now), undefined);
});
test("fresh scanner skips failed candidates and verifies both accounts twice", async () => {
  const accounts = [account("active", 0), account("failed", 90, 1), account("best", 40, 2)];
  const calls: string[] = [];
  const inputs = source(accounts);
  inputs.getUsage = async id => { calls.push(id); if(id === "failed") throw new Error("offline"); return accounts.find(a => a.id === id)!.usage!; };
  assert.equal((await findAutoQuotaSwitch(inputs, excluded))?.to.id, "best");
  assert.equal(calls.filter(id => id === "active").length, 2);
  assert.equal(calls.filter(id => id === "best").length, 2);
});
test("a recovered active account cancels the planned switch", async () => {
  const inputs = source([account("active", 0), account("best", 50)]);
  let reads = 0;
  inputs.getUsage = async id => id === "active" ? account(id, ++reads === 1 ? 0 : 80).usage! : account(id, 50).usage!;
  assert.equal(await findAutoQuotaSwitch(inputs, excluded), undefined);
});
test("target exhaustion during verification cancels the switch", async () => {
  const inputs = source([account("active", 0), account("best", 50)]);
  let reads = 0;
  inputs.getUsage = async id => id === "best" ? account(id, ++reads === 1 ? 50 : 0).usage! : account(id, 0).usage!;
  assert.equal(await findAutoQuotaSwitch(inputs, excluded), undefined);
});
test("an intervening manual switch cancels the automatic decision", async () => {
  const accounts = [account("active", 0), account("best", 50)];
  const inputs = source(accounts); let calls = 0;
  inputs.listAccounts = async () => ++calls === 1 ? accounts : accounts.map(a => ({...a, is_active:a.id === "best"}));
  assert.equal(await findAutoQuotaSwitch(inputs, excluded), undefined);
});
test("turning off auto-selection during refresh prevents a decision", async () => {
  const inputs = source([account("active", 0), account("best", 50)]); let cancelled = false;
  inputs.cancelled = () => cancelled;
  inputs.getUsage = async id => {cancelled = true; return account(id, 50).usage!;};
  assert.equal(await findAutoQuotaSwitch(inputs, excluded), undefined);
});
test("mismatched account usage is rejected", async () => {
  const inputs = source([account("active", 0), account("best", 50)]);
  inputs.getUsage = async () => account("wrong", 50).usage as UsageInfo;
  assert.equal(await findAutoQuotaSwitch(inputs, excluded), undefined);
});

const expiryPolicy = { useExpiringFiveHourQuota: true, leadMinutes: 60 };
function shortAccount(id: string, remaining = 80, minutes = 45, weeklyRemaining = 80) {
  const a = account(id, remaining, minutes / 60);
  a.plan_type = "plus";
  a.usage!.primary_window_minutes = 300;
  a.usage!.secondary_window_minutes = 10080;
  a.usage!.secondary_used_percent = 100 - weeklyRemaining;
  a.usage!.secondary_resets_at = now / 1000 + 48 * 3600;
  return a;
}
test("expiry mode preempts healthy weekly-only quota and prefers the earliest five-hour deadline", () => {
  const accounts = [account("active", 90), shortAccount("later", 95, 50), shortAccount("earlier", 40, 20)];
  assert.equal(selectAutoQuotaOption(accounts, now, excluded, expiryPolicy)?.account.id, "earlier");
  assert.equal(selectAutoQuotaOption(accounts, now)?.account.id, "earlier");
  assert.equal(selectAutoQuotaOption(accounts, now, excluded, {useExpiringFiveHourQuota:false, leadMinutes:60}), undefined);
});
test("expiry mode stays below 10 percent until either limit is exhausted", () => {
  const active = shortAccount("active", 2);
  assert.equal(selectAutoQuotaOption([active, account("reserve", 90), shortAccount("earlier", 50, 10)], now, excluded, expiryPolicy), undefined);
  active.usage!.primary_used_percent = 100;
  assert.equal(selectAutoQuotaOption([active, account("reserve", 90)], now, excluded, expiryPolicy)?.account.id, "reserve");
  active.usage!.primary_used_percent = 20;
  active.usage!.secondary_used_percent = 100;
  assert.equal(selectAutoQuotaOption([active, account("reserve", 90)], now, excluded, expiryPolicy)?.account.id, "reserve");
});
test("five-hour expiry requires live usage, both limits, and a known future deadline", () => {
  const weeklyBlocked = shortAccount("blocked", 90, 20, 0);
  const missing = shortAccount("missing"); missing.usage!.primary_resets_at = null;
  const stale = shortAccount("stale", 90, 0);
  for (const a of [weeklyBlocked, missing, stale, account("weeklyOnly", 90, 0.5)]) {
    assert.equal(expiringFiveHourReset(a, now, expiryPolicy), null, a.id);
  }
});
test("lead time boundary and returning-account cooldown are respected", () => {
  const target = shortAccount("target", 80, 60);
  assert.notEqual(expiringFiveHourReset(target, now, expiryPolicy), null);
  assert.equal(expiringFiveHourReset(target, now, {...expiryPolicy, leadMinutes:30}), null);
  assert.equal(selectAutoQuotaOption([account("active", 90), target], now, new Set(["target"]), expiryPolicy), undefined);
});
test("five-hour metadata works in either slot independent of plan label", () => {
  const a = account("target", 60);
  a.usage!.secondary_window_minutes = 300;
  a.usage!.secondary_used_percent = 10;
  a.usage!.secondary_resets_at = now / 1000 + 20 * 60;
  assert.equal(expiringFiveHourReset(a, now, expiryPolicy), now + 20 * 60000);
});
test("a refreshed five-hour window releases the stay-until-exhausted policy", () => {
  const active = shortAccount("active", 90, 300);
  assert.equal(selectAutoQuotaOption([active, shortAccount("next", 50, 20)], now, excluded, expiryPolicy)?.account.id, "next");
});
test("expiry scanner scans alternatives even when active quota is healthy", async () => {
  const inputs = source([account("active", 90), shortAccount("target")]);
  const result = await findAutoQuotaSwitch(inputs, excluded, expiryPolicy);
  assert.equal(result?.to.id, "target");
  assert.equal(result?.reason, "expiring_five_hour");
});
test("expiry scanner stops if the selected target resets during verification", async () => {
  const inputs = source([account("active", 90), shortAccount("target")]);
  let targetReads = 0;
  inputs.getUsage = async id => id === "active" ? account(id, 90).usage! : shortAccount(id, 80, ++targetReads === 1 ? 20 : 300).usage!;
  assert.equal(await findAutoQuotaSwitch(inputs, excluded, expiryPolicy), undefined);
});
test("expiry scanner does not repeatedly scan alternatives while draining the active window", async () => {
  const inputs = source([shortAccount("active", 2), account("reserve", 90)]);
  const reads: string[] = [];
  const read = inputs.getUsage;
  inputs.getUsage = async id => { reads.push(id); return read(id); };
  assert.equal(await findAutoQuotaSwitch(inputs, excluded, expiryPolicy), undefined);
  assert.deepEqual(reads, ["active"]);
});
test("missing expiry preference defaults on while explicit off is preserved", () => {
  assert.deepEqual(normalizeAutoQuotaPolicy({useExpiringFiveHourQuota:false, leadMinutes:60}), {useExpiringFiveHourQuota:false, leadMinutes:60});
  assert.deepEqual(normalizeAutoQuotaPolicy(null), {useExpiringFiveHourQuota:true, leadMinutes:60});
  assert.deepEqual(normalizeAutoQuotaPolicy({useExpiringFiveHourQuota:"true", leadMinutes:-1}), {useExpiringFiveHourQuota:false, leadMinutes:60});
  assert.deepEqual(normalizeAutoQuotaPolicy({useExpiringFiveHourQuota:true, leadMinutes:30}), {useExpiringFiveHourQuota:true, leadMinutes:30});
});


test("normal mode uses all positive quota, including fractional percentages", async () => {
  for (const remaining of [10, 1, 0.5, 0.01]) {
    const accounts = [account("active", remaining), account("best", 90)];
    assert.equal(selectAutoQuotaOption(accounts, now), undefined);
    assert.equal(await findAutoQuotaSwitch(source(accounts), excluded), undefined);
  }
  assert.equal(selectAutoQuotaOption([account("active", 0), account("tiny", 0.01)], now)?.account.id, "tiny");
});

test("either limiting window at zero triggers a switch", () => {
  const a = shortAccount("active", 50, 120, 0);
  assert.equal(selectAutoQuotaOption([a, account("other", 50)], now)?.account.id, "other");
  a.usage!.secondary_used_percent = 50;
  a.usage!.primary_used_percent = 100;
  assert.equal(selectAutoQuotaOption([a, account("other", 50)], now)?.account.id, "other");
});
