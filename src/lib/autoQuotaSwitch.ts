import type { AccountWithUsage, UsageInfo } from "../types/index.ts";
import { DEFAULT_AUTO_QUOTA_POLICY, expiringFiveHourReset, quotaOption, selectAutoQuotaOption, type AutoQuotaPolicy } from "./quotaOptions.ts";

export interface AutoQuotaSource {
  listAccounts: () => Promise<AccountWithUsage[]>;
  getCurrentLogin?: () => Promise<{ account: { id: string }; is_managed: boolean } | null>;
  getUsage: (id: string) => Promise<UsageInfo>;
  cancelled: () => boolean;
  now: () => number;
  trace?: (event: string, detail?: Record<string, unknown>) => void;
}

/** Revalidate both sides after scanning; a failed account never blocks other candidates. */
export async function findAutoQuotaSwitch(source: AutoQuotaSource, excludedIds: ReadonlySet<string>, policy: AutoQuotaPolicy = DEFAULT_AUTO_QUOTA_POLICY) {
  const trace = (event: string, detail?: Record<string, unknown>) => source.trace?.(event, detail);
  const accounts = await source.listAccounts();
  const active = accounts.find(a => a.is_active && a.auth_mode === "chat_g_p_t");
  if (!active) { trace("no_active_chatgpt_account"); return undefined; }
  if (source.cancelled()) { trace("cancelled_after_list", { activeId: active.id }); return undefined; }
  if (source.getCurrentLogin) {
    try {
      const live = await source.getCurrentLogin();
      if (!live?.is_managed || live.account.id !== active.id) {
        trace("live_login_mismatch", { selectedId: active.id, liveId: live?.is_managed ? live.account.id : null });
        return undefined;
      }
    } catch (error) {
      trace("live_login_check_failed", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
  const read = async (account: AccountWithUsage): Promise<AccountWithUsage> => {
    try {
      const usage = await source.getUsage(account.id);
      if (usage.account_id !== account.id) trace("usage_account_mismatch", { accountId: account.id, returnedId: usage.account_id });
      return { ...account, usage: usage.account_id === account.id ? usage : undefined, usageLoading: false };
    } catch (error) {
      trace("usage_read_failed", { accountId: account.id, error: error instanceof Error ? error.message : String(error) });
      return { ...account, usage: undefined, usageLoading: false };
    }
  };
  const current = await read(active);
  const state = quotaOption(current, source.now());
  trace("active_quota", { activeId: active.id, remaining: state.remaining, available: state.available, needsRefresh: state.needsRefresh, windows: state.windows });
  if (source.cancelled()) { trace("cancelled_after_active_usage", { activeId: active.id }); return undefined; }
  if (state.needsRefresh) { trace("active_usage_unusable", { activeId: active.id }); return undefined; }
  if (state.available && !policy.useExpiringFiveHourQuota) { trace("active_quota_available", { activeId: active.id }); return undefined; }
  if (expiringFiveHourReset(current, source.now(), policy) !== null) { trace("draining_active_five_hour_window", { activeId: active.id }); return undefined; }
  const candidates = accounts.filter(a => !a.is_active && a.auth_mode === "chat_g_p_t" && !excludedIds.has(a.id));
  const refreshed = [current];
  for (let i = 0; i < candidates.length; i += 3) {
    refreshed.push(...await Promise.all(candidates.slice(i, i + 3).map(read)));
    if (source.cancelled()) { trace("cancelled_during_candidate_scan", { activeId: active.id }); return undefined; }
  }
  trace("candidate_quotas", { candidates: refreshed.slice(1).map(account => {
    const quota = quotaOption(account, source.now());
    return { accountId: account.id, remaining: quota.remaining, available: quota.available, needsRefresh: quota.needsRefresh };
  }), excludedIds: [...excludedIds] });
  const choice = selectAutoQuotaOption(refreshed, source.now(), excludedIds, policy);
  if (!choice) { trace("no_eligible_candidate", { activeId: active.id }); return undefined; }
  if (source.cancelled()) { trace("cancelled_before_verification", { activeId: active.id }); return undefined; }
  const [freshActive, freshTarget] = await Promise.all([read(active), read(choice.account)]);
  const latestAccounts = await source.listAccounts();
  if (source.cancelled()) { trace("cancelled_during_verification", { activeId: active.id }); return undefined; }
  if (latestAccounts.find(a => a.is_active)?.id !== active.id || !latestAccounts.some(a => a.id === choice.account.id)) {
    trace("accounts_changed_during_verification", { activeId: active.id, targetId: choice.account.id }); return undefined;
  }
  if (source.getCurrentLogin) {
    try {
      const live = await source.getCurrentLogin();
      if (!live?.is_managed || live.account.id !== active.id) {
        trace("live_login_changed_during_verification", { selectedId: active.id, liveId: live?.is_managed ? live.account.id : null });
        return undefined;
      }
    } catch (error) {
      trace("live_login_check_failed", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
  const verified = selectAutoQuotaOption([freshActive, freshTarget], source.now(), excludedIds, policy);
  if (!verified) {
    trace("verification_rejected", { activeId: active.id, targetId: choice.account.id,
      active: quotaOption(freshActive, source.now()).remaining, target: quotaOption(freshTarget, source.now()).remaining });
    return undefined;
  }
  trace("switch_selected", { activeId: active.id, targetId: verified.account.id });
  return { from: active, to: verified.account, reason: expiringFiveHourReset(verified.account, source.now(), policy) !== null ? "expiring_five_hour" as const : "exhausted_quota" as const };
}
