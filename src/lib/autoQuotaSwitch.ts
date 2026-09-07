import type { AccountWithUsage, UsageInfo } from "../types/index.ts";
import { DEFAULT_AUTO_QUOTA_POLICY, expiringFiveHourReset, quotaOption, selectAutoQuotaOption, type AutoQuotaPolicy } from "./quotaOptions.ts";

export interface AutoQuotaSource {
  listAccounts: () => Promise<AccountWithUsage[]>;
  getUsage: (id: string) => Promise<UsageInfo>;
  cancelled: () => boolean;
  now: () => number;
}

/** Revalidate both sides after scanning; a failed account never blocks other candidates. */
export async function findAutoQuotaSwitch(source: AutoQuotaSource, excludedIds: ReadonlySet<string>, policy: AutoQuotaPolicy = DEFAULT_AUTO_QUOTA_POLICY) {
  const accounts = await source.listAccounts();
  const active = accounts.find(a => a.is_active && a.auth_mode === "chat_g_p_t");
  if (!active || source.cancelled()) return undefined;
  const read = async (account: AccountWithUsage): Promise<AccountWithUsage> => {
    try {
      const usage = await source.getUsage(account.id);
      return { ...account, usage: usage.account_id === account.id ? usage : undefined, usageLoading: false };
    } catch { return { ...account, usage: undefined, usageLoading: false }; }
  };
  const current = await read(active);
  const state = quotaOption(current, source.now());
  if (source.cancelled() || state.needsRefresh || (state.available && !policy.useExpiringFiveHourQuota)) return undefined;
  if (expiringFiveHourReset(current, source.now(), policy) !== null) return undefined;
  const candidates = accounts.filter(a => !a.is_active && a.auth_mode === "chat_g_p_t" && !excludedIds.has(a.id));
  const refreshed = [current];
  for (let i = 0; i < candidates.length; i += 3) {
    refreshed.push(...await Promise.all(candidates.slice(i, i + 3).map(read)));
    if (source.cancelled()) return undefined;
  }
  const choice = selectAutoQuotaOption(refreshed, source.now(), excludedIds, policy);
  if (!choice || source.cancelled()) return undefined;
  const [freshActive, freshTarget] = await Promise.all([read(active), read(choice.account)]);
  const latestAccounts = await source.listAccounts();
  if (source.cancelled() || latestAccounts.find(a => a.is_active)?.id !== active.id || !latestAccounts.some(a => a.id === choice.account.id)) return undefined;
  const verified = selectAutoQuotaOption([freshActive, freshTarget], source.now(), excludedIds, policy);
  return verified ? { from: active, to: verified.account, reason: expiringFiveHourReset(verified.account, source.now(), policy) !== null ? "expiring_five_hour" as const : "exhausted_quota" as const } : undefined;
}
