import type { AccountWithUsage, UsageInfo } from "../types/index.ts";

export const LOW_QUOTA_PERCENT = 10;
export interface AutoQuotaPolicy {
  useExpiringFiveHourQuota: boolean;
  leadMinutes: number;
}
export const DEFAULT_AUTO_QUOTA_POLICY: AutoQuotaPolicy = { useExpiringFiveHourQuota: true, leadMinutes: 60 };
export function normalizeAutoQuotaPolicy(value: unknown): AutoQuotaPolicy {
  const stored = value && typeof value === "object" ? value as Partial<AutoQuotaPolicy> : {};
  return {
    useExpiringFiveHourQuota: stored.useExpiringFiveHourQuota === undefined ? true : stored.useExpiringFiveHourQuota === true,
    leadMinutes: [15, 30, 60, 120].includes(stored.leadMinutes ?? 0) ? stored.leadMinutes! : 60,
  };
}
export interface QuotaWindow {
  label: string;
  remaining: number;
  resetsAt: number | null;
}

/** Window shape comes from usage, not the account's marketing plan name. */
export function quotaWindows(usage?: UsageInfo): QuotaWindow[] {
  if (!usage || usage.error) return [];
  return (["primary", "secondary"] as const).flatMap((key) => {
    const used = usage[`${key}_used_percent`];
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return [];
    const minutes = usage[`${key}_window_minutes`];
    const reset = usage[`${key}_resets_at`];
    return [{
      label: minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : minutes ? `${minutes / 60}-hour` : `${key === "primary" ? "Primary" : "Secondary"} window`,
      remaining: 100 - used,
      resetsAt: typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
    }];
  });
}

export function quotaOption(account: AccountWithUsage, now = Date.now()) {
  const windows = quotaWindows(account.usage);
  const remaining = windows.length ? Math.min(...windows.map(w => w.remaining)) : null;
  const incomplete = (["primary", "secondary"] as const).some(key => {
    const usage = account.usage;
    const used = usage?.[`${key}_used_percent`];
    const reported = used != null || usage?.[`${key}_window_minutes`] != null || usage?.[`${key}_resets_at`] != null;
    return reported && (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100);
  });
  const needsRefresh = Boolean(account.usageLoading || incomplete || !windows.length || windows.some(w => w.resetsAt !== null && w.resetsAt <= now));
  const available = !needsRefresh && remaining !== null && remaining > 0;
  const low = remaining !== null && remaining <= LOW_QUOTA_PERCENT;
  const blocked = windows.filter(w => w.remaining <= 0);
  // All exhausted windows must recover before the account is usable again.
  const recoveryAt = blocked.length && blocked.every(w => w.resetsAt !== null)
    ? Math.max(...blocked.map(w => w.resetsAt!)) : null;
  const nextReset = windows.reduce((next, w) => Math.min(next, w.resetsAt ?? Infinity), Infinity);
  return { account, windows, remaining, available, low, needsRefresh, recoveryAt, nextReset };
}

/** A transparent heuristic, not an estimate of tokens or time left across plans. */
export function rankQuotaOptions(accounts: AccountWithUsage[], now = Date.now()) {
  return accounts.map(account => quotaOption(account, now)).sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.low !== b.low) return a.low ? 1 : -1;
    const soon = (value: number) => value > now && value <= now + 24 * 60 * 60 * 1000;
    if (a.available && b.available) {
      if (soon(a.nextReset) !== soon(b.nextReset)) return soon(a.nextReset) ? -1 : 1;
      if (soon(a.nextReset) && a.nextReset !== b.nextReset) return a.nextReset - b.nextReset;
      if (a.remaining !== b.remaining) return (b.remaining ?? -1) - (a.remaining ?? -1);
    }
    return a.account.name.localeCompare(b.account.name) || a.account.id.localeCompare(b.account.id);
  });
}

/** Only actual, live five-hour windows qualify, regardless of plan labels. */
export function expiringFiveHourReset(account: AccountWithUsage, now: number, policy: AutoQuotaPolicy): number | null {
  if (!policy.useExpiringFiveHourQuota || !Number.isFinite(policy.leadMinutes) || policy.leadMinutes <= 0 || account.auth_mode !== "chat_g_p_t") return null;
  const option = quotaOption(account, now);
  if (!option.available) return null;
  const window = option.windows.find(w => w.label === "5-hour" && w.resetsAt !== null && w.resetsAt > now && w.resetsAt <= now + policy.leadMinutes * 60000);
  return window?.resetsAt ?? null;
}

/** Normal mode waits for zero; optional expiry mode can preempt to use a short window. */
export function selectAutoQuotaOption(accounts: AccountWithUsage[], now = Date.now(), excludedIds: ReadonlySet<string> = new Set(), policy: AutoQuotaPolicy = DEFAULT_AUTO_QUOTA_POLICY) {
  const active = accounts.find(a => a.is_active);
  if (!active) return undefined;
  const current = quotaOption(active, now);
  if (current.needsRefresh) return undefined;
  const candidates = accounts.filter(a => a.auth_mode === "chat_g_p_t" && !a.is_active && !excludedIds.has(a.id));
  // Stay on an expiring window, even below 10%, until either limit exhausts.
  if (expiringFiveHourReset(active, now, policy) !== null) return undefined;
  const expiring = candidates.map(account => ({ account, reset: expiringFiveHourReset(account, now, policy) }))
    .filter((entry): entry is { account: AccountWithUsage; reset: number } => entry.reset !== null)
    .sort((a, b) => a.reset - b.reset || a.account.id.localeCompare(b.account.id))[0];
  if (expiring) return quotaOption(expiring.account, now);
  if (current.available) return undefined;
  if (policy.useExpiringFiveHourQuota) {
    const reserve = rankQuotaOptions(candidates, now).find(option => option.available && !option.windows.some(w => w.label === "5-hour"));
    if (reserve) return reserve;
  }
  return rankQuotaOptions(candidates, now)
    .find(option => option.available);
}
