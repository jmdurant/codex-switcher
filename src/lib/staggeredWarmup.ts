import type { AccountWithUsage } from "../types/index.ts";
import { quotaOption } from "./quotaOptions.ts";

export const STAGGER_MS = 60 * 60000;
export const STAGGER_STORAGE_KEY = "ai-account-switcher.staggered-warmup-v1";
export interface StaggerLedger { lastAttemptAt: number; accounts: Record<string, { attemptedAt: number; nextEligibleAt: number }> }
export const emptyStaggerLedger = (): StaggerLedger => ({lastAttemptAt:0,accounts:{}});
export function readStaggerLedger(text: string | null): StaggerLedger {
  if (text === null) return emptyStaggerLedger();
  const value = JSON.parse(text);
  if (!value || !Number.isFinite(value.lastAttemptAt) || !value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts) ||
      Object.values(value.accounts).some((v: any) => !v || !Number.isFinite(v.attemptedAt) || !Number.isFinite(v.nextEligibleAt))) throw Error("Invalid warm-up schedule");
  return value;
}
export function hasFiveHourWindow(account: AccountWithUsage): boolean {
  return account.usage?.primary_window_minutes === 300 || account.usage?.secondary_window_minutes === 300;
}
export function canStaggerWarm(account: AccountWithUsage, ledger: StaggerLedger, now: number): boolean {
  if (account.auth_mode !== "chat_g_p_t" || account.is_active || now - ledger.lastAttemptAt < STAGGER_MS) return false;
  const option = quotaOption(account, now);
  const short = option.windows.find(w => w.label === "5-hour");
  const weekly = option.windows.find(w => w.label === "Weekly");
  // Only fresh, unused short windows with verified weekly headroom. Never warm
  // already-running windows merely to align their deadlines.
  return option.available && !!weekly && weekly.remaining > 0 && !!short && short.remaining === 100 && short.resetsAt !== null &&
    short.resetsAt - now >= 295 * 60000 && short.resetsAt - now <= 305 * 60000 &&
    now >= (ledger.accounts[account.id]?.nextEligibleAt ?? 0);
}
export function selectStaggerWarmup(accounts: AccountWithUsage[], ledger: StaggerLedger, now: number) {
  return accounts.filter(a => canStaggerWarm(a,ledger,now)).sort((a,b) =>
    (ledger.accounts[a.id]?.attemptedAt ?? 0) - (ledger.accounts[b.id]?.attemptedAt ?? 0) || a.id.localeCompare(b.id))[0];
}
export function reserveStaggerWarmup(ledger: StaggerLedger, id: string, now: number): StaggerLedger {
  return {lastAttemptAt:now,accounts:{...ledger.accounts,[id]:{attemptedAt:now,nextEligibleAt:now+300*60000}}};
}
