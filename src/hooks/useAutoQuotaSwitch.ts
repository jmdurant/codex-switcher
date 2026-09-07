import { useEffect, useRef, useState } from "react";
import type { AccountWithUsage, UsageInfo } from "../types";
import { invokeBackend } from "../lib/platform";
import { findAutoQuotaSwitch } from "../lib/autoQuotaSwitch";
import type { AutoQuotaPolicy } from "../lib/quotaOptions";

interface Options {
  enabled: boolean;
  policy: AutoQuotaPolicy;
  busy: boolean;
  accounts: AccountWithUsage[];
  onSwitch: (id: string, cancelled: () => boolean) => Promise<boolean>;
  onError: (message: string) => void;
}

export function useAutoQuotaSwitch(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const running = useRef(false);
  const retryAfter = useRef(0);
  const recent = useRef(new Map<string, number>());
  const [switching, setSwitching] = useState(false);
  const [status, setStatus] = useState("Waiting for the next quota check.");
  useEffect(() => {
    if (!options.enabled) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || running.current || latest.current.busy || Date.now() < retryAfter.current) return;
      running.current = true;
      const activeId = latest.current.accounts.find(a => a.is_active)?.id;
      const cancelled = () => stopped || !latest.current.enabled || latest.current.busy || latest.current.accounts.find(a => a.is_active)?.id !== activeId;
      try {
        setStatus("Checking quota…");
        const now = Date.now();
        for (const [id, expiry] of recent.current) if (expiry <= now) recent.current.delete(id);
        const decision = await findAutoQuotaSwitch({
          listAccounts: () => invokeBackend<AccountWithUsage[]>("list_accounts"),
          getUsage: (accountId) => invokeBackend<UsageInfo>("get_usage", { accountId }),
          now: Date.now,
          cancelled,
        }, new Set(recent.current.keys()), options.policy);
        if (cancelled()) return;
        if (!decision) {
          setStatus("No switch needed or no suitable verified alternative. Checking every 30 seconds.");
          return;
        }
        // Back off even on failure, so a failed close/switch never becomes a loop.
        retryAfter.current = Date.now() + 60000;
        setSwitching(true);
        setStatus(decision.reason === "expiring_five_hour" ? "Switching to use five-hour quota before it resets…" : "Switching to the best verified alternative…");
        const switched = await latest.current.onSwitch(decision.to.id, cancelled);
        if (switched) {
          recent.current.set(decision.from.id, Date.now() + 5 * 60000);
          setStatus(decision.reason === "expiring_five_hour" ? "Using expiring five-hour quota until a limit exhausts or the window resets." : "Switched successfully. Cooling down for one minute.");
        } else setStatus("Switch could not complete. Will retry after one minute.");
      } catch (error) {
        retryAfter.current = Date.now() + 60000;
        if (!stopped) {
          setStatus("Quota check failed. Will retry after one minute.");
          latest.current.onError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        running.current = false;
        setSwitching(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 30000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [options.enabled, options.policy.useExpiringFiveHourQuota, options.policy.leadMinutes]);
  return { switching, status };
}
