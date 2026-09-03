import test from "node:test";
import assert from "node:assert/strict";
import { classifyAccount, isUsageExhausted, selectFallbackAccount } from "../src/lib/accountPriority.ts";
import type { AccountWithUsage, UsageInfo } from "../src/types/index.ts";

function usage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    account_id: "id",
    plan_type: "team",
    primary_used_percent: 10,
    primary_window_minutes: 300,
    primary_resets_at: 1,
    secondary_used_percent: 10,
    secondary_window_minutes: 10080,
    secondary_resets_at: 1,
    has_credits: true,
    unlimited_credits: null,
    credits_balance: null,
    error: null,
    ...overrides,
  };
}

function account(id: string, plan_type: string, u = usage()): AccountWithUsage {
  return { id, name: id, email: null, plan_type, subscription_expires_at: null, auth_mode: "chat_g_p_t", is_active: false, created_at: "", last_used_at: null, usage: u, usageLoading: false };
}

test("classifies current plan values", () => {
  assert.equal(classifyAccount("self_serve_business_prolite"), "team_10x");
  assert.equal(classifyAccount("team"), "team");
  assert.equal(classifyAccount("quorum"), "quorum");
});

test("detects exhausted credits or windows", () => {
  assert.equal(isUsageExhausted(usage({ has_credits: false })), true);
  assert.equal(isUsageExhausted(usage({ primary_used_percent: 100 })), true);
  assert.equal(isUsageExhausted(usage({ primary_used_percent: 50, secondary_used_percent: 50 })), false);
});

test("selects the highest-priority available fallback", () => {
  const selected = selectFallbackAccount([
    account("team", "team"),
    account("tenx", "self_serve_business_prolite"),
    account("quorum", "quorum"),
  ], "active");
  assert.equal(selected?.id, "tenx");
});

test("skips exhausted fallbacks", () => {
  const selected = selectFallbackAccount([
    account("tenx", "self_serve_business_prolite", usage({ primary_used_percent: 100 })),
    account("team", "team"),
  ], "active");
  assert.equal(selected?.id, "team");
});
