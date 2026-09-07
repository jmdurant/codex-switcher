import { useEffect, useRef, useState } from "react";
import type { AccountResetCredits, AccountUsageStats, AccountWithUsage, UsageInfo } from "../types";
import { invokeBackend } from "../lib/platform";
import { expiringFiveHourReset, quotaOption, rankQuotaOptions, type AutoQuotaPolicy } from "../lib/quotaOptions";
import { formatResetCreditDateTime, getAvailableResetCredits } from "../lib/resetCredits";

interface Props {
  accounts: AccountWithUsage[];
  maskedAccountIds: Set<string>;
  busy: boolean;
  autoEnabled: boolean;
  autoPolicy: AutoQuotaPolicy;
  autoStatus: string;
  onSwitch: (id: string) => Promise<void>;
}
const buttonClass = "rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-gray-600";
const date = (value: number) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function QuotaOptions({ accounts, maskedAccountIds, busy, onSwitch, autoEnabled, autoPolicy, autoStatus }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<AccountWithUsage[]>([]);
  const [resets, setResets] = useState<Record<string, AccountResetCredits | null>>({});
  const [checkedAt, setCheckedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState("");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const generation = useRef(0);
  const refreshLock = useRef(false);
  const revision = accounts.map(a => `${a.id}:${a.is_active}`).join(",");
  useEffect(() => {
    generation.current += 1;
    refreshLock.current = false;
    setSnapshot([]);
    setResets({});
    setCheckedAt(0);
    setLoading(false);
    setReviewId(null);
    return () => { generation.current += 1; };
  }, [revision]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [open]);

  const refresh = async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    const request = ++generation.current;
    setLoading(true);
    setMessage("");
    const fresh: AccountWithUsage[] = [];
    const resetMap: Record<string, AccountResetCredits | null> = {};
    const eligible = accounts.filter(a => a.auth_mode === "chat_g_p_t");
    try {
      // Bound requests so opening the advisor doesn't overwhelm account refresh.
      for (let i = 0; i < eligible.length; i += 3) {
        await Promise.all(eligible.slice(i, i + 3).map(async account => {
          let usage: UsageInfo | undefined;
          try {
            const result = await invokeBackend<UsageInfo>("get_usage", { accountId: account.id });
            if (result.account_id === account.id) usage = result;
          } catch { /* Missing usage is shown as unavailable, never inferred. */ }
          fresh.push({ ...account, usage, usageLoading: false });
          try {
            const stats = await invokeBackend<AccountUsageStats>("get_account_usage_stats", { accountId: account.id });
            resetMap[account.id] = stats.account_id === account.id ? stats.reset_credits : null;
          } catch { resetMap[account.id] = null; }
        }));
        if (request !== generation.current) return;
      }
      setSnapshot(fresh);
      setResets(resetMap);
      setCheckedAt(Date.now());
      setNow(Date.now());
    } finally {
      if (request === generation.current) {
        setLoading(false);
        refreshLock.current = false;
      }
    }
  };
  const choose = async (id: string) => {
    if (switching || busy || loading) return;
    setSwitching(true);
    setMessage("");
    try {
      const account = accounts.find(a => a.id === id);
      if (!account || account.is_active) return;
      const usage = await invokeBackend<UsageInfo>("get_usage", { accountId: id });
      if (usage.account_id !== id || !quotaOption({ ...account, usage, usageLoading: false }).available) {
        setCheckedAt(0);
        setMessage("This account's quota changed or could not be verified. Refresh options before choosing again.");
        return;
      }
      await onSwitch(id);
    } catch (error) {
      setMessage(`Could not switch: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setSwitching(false); }
  };

  const current = accounts.find(a => a.is_active);
  const currentOption = current ? quotaOption(current, now) : null;
  const stale = !checkedAt || now - checkedAt > 2 * 60 * 1000;
  const options = rankQuotaOptions(snapshot, now);
  const suggested = options.find(o => !o.account.is_active && o.available && !o.low);
  const name = (account: AccountWithUsage) => maskedAccountIds.has(account.id) ? "Masked account" : account.name;
  if (!accounts.length) return null;
  return <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4 text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">Quota options</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">{currentOption?.low ? "Your active account is running low. Compare accounts or review a banked reset." : "Compare remaining quota, upcoming resets, and banked resets. Manage automation in Settings → Quota & switching."}</p>
      </div>
      <button className={buttonClass} aria-expanded={open} aria-controls="quota-options-content" onClick={() => {
        setOpen(!open);
        if (!open) void refresh();
      }}>{open ? "Hide options" : "Compare options"}</button>
    </div>
    <p role="status" className="mt-3 text-xs text-gray-500 dark:text-gray-400">
      {autoEnabled ? `Auto-switch on · ${autoPolicy.useExpiringFiveHourQuota ? `5-hour priority (${autoPolicy.leadMinutes} min) · ` : ""}${autoStatus}` : "Auto-switch off · Configure in Settings → Quota & switching."}
    </p>
    {open && <div id="quota-options-content" className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p>{loading ? "Checking usage and banked resets…" : checkedAt ? `Checked ${date(checkedAt)}${stale ? " — refresh needed" : ""}` : "Refresh to compare current availability."}</p>
        <button className={buttonClass} disabled={loading || busy || switching} onClick={() => void refresh()}>Refresh options</button>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">Options with more than 10% in every reported window come first, favoring quota that resets within 24 hours. Percentages describe each plan's allowance; they do not estimate equal amounts of work across plans.</p>
      {currentOption?.available && !currentOption.low && <p className="text-sm">Staying on your current account is also reasonable while its quota lasts.</p>}
      {message && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{message}</p>}
      {!loading && checkedAt > 0 && !options.some(o => !o.account.is_active && o.available) && <p className="text-sm">No verified alternative is available right now. Review banked resets or the recovery times below.</p>}
      {options.map(option => {
        const account = accounts.find(a => a.id === option.account.id) ?? option.account;
        const credits = getAvailableResetCredits(resets[account.id] ?? null, now);
        const firstExpiry = credits[0]?.expires_at ? Date.parse(credits[0].expires_at) : NaN;
        const urgent = Number.isFinite(firstExpiry) && firstExpiry <= now + 3 * 86400000;
        return <article key={account.id} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{name(account)}{account.is_active ? " · Active" : ""} <span className="font-normal text-gray-500">{account.plan_type ?? "Unknown plan"}</span></h3>
            {!account.is_active && <button className={buttonClass} disabled={busy || switching || loading || stale || !option.available} onClick={() => void choose(account.id)}>Switch to this account</button>}
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {option.windows.map(w => <li key={w.label}>{w.label}: {Number(w.remaining.toFixed(1))}% remaining · {w.resetsAt ? `resets ${date(w.resetsAt)}` : "reset time unavailable"}</li>)}
          </ul>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{option.needsRefresh ? "Usage unavailable or a reset time has passed; refresh to verify." : !option.available ? `Plan quota exhausted.${option.recoveryAt ? ` Availability expected after ${date(option.recoveryAt)}; refresh then.` : ""}` : option.low ? "Low headroom in at least one window." : suggested?.account.id === account.id ? "Suggested alternative: usable headroom" + (option.nextReset <= now + 86400000 ? " and quota replenishes within 24 hours." : ".") : "Available based on reported plan quota."}</p>
          {autoEnabled && expiringFiveHourReset(option.account, now, autoPolicy) !== null && <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">5-hour quota resets soon · {account.is_active ? "Auto mode will use this window until a limit exhausts or it resets." : "Eligible for early auto-selection, subject to cooldowns."}</p>}
          <div className="mt-2 text-sm">
            {resets[account.id] == null ? <p>Banked resets could not be checked.</p> : credits.length ? <>
              <p className={urgent ? "text-amber-700 dark:text-amber-300" : ""}>{credits.length} banked reset{credits.length === 1 ? "" : "s"}{urgent ? " · Expiring within 3 days" : ""}</p>
              {urgent && option.available && !option.low && <p>Consider using this account's existing quota before reviewing its expiring reset.</p>}
              <button className={`${buttonClass} mt-2`} onClick={() => setReviewId(reviewId === account.id ? null : account.id)} aria-expanded={reviewId === account.id}>Review banked resets</button>
              {reviewId === account.id && <div className="mt-2 space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
                {credits.map(credit => <p key={credit.id}>{credit.title ?? credit.reset_type} · {credit.expires_at ? `Expires ${formatResetCreditDateTime(credit.expires_at)}` : "Expiry not provided; verify in Codex"}</p>)}
                <p>In Codex, open Settings → Usage for <strong>{name(account)}</strong> and the matching workspace, select the available reset, and review its terms before confirming. Choose the earliest expiry if a choice is offered.</p>
                <p>{option.needsRefresh ? "Refresh usage before deciding whether a reset would help." : option.low ? "A reset may restore useful quota now." : "Using a reset now may forfeit remaining quota; consider using that quota first."} Compare its expiry with the natural reset times above.</p>
                <p>A reset may change the weekly reset date. After redeeming, refresh these options to read the actual new limits and times. Switching here does not change your browser's signed-in account.</p>
                <button className={buttonClass} disabled={loading || busy || switching} onClick={() => void refresh()}>I've used a reset — refresh</button>
              </div>}
            </> : <p>No available banked resets.</p>}
          </div>
        </article>;
      })}
    </div>}
  </section>;
}
