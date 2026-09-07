import { useEffect, useRef } from "react";
import type { AutoQuotaPolicy } from "../lib/quotaOptions";

interface Props {
  open: boolean;
  onClose: () => void;
  autoEnabled: boolean;
  autoPolicy: AutoQuotaPolicy;
  onAutoEnabledChange: (enabled: boolean) => void;
  onAutoPolicyChange: (policy: AutoQuotaPolicy) => void;
}

export function QuotaSettings({ open, onClose, autoEnabled, autoPolicy, onAutoEnabledChange, onAutoPolicyChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <dialog ref={dialog} onCancel={onClose} onClose={onClose} aria-labelledby="quota-settings-title"
    className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 text-gray-900 shadow-xl backdrop:bg-black/40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
    <div className="flex items-center justify-between gap-4">
      <h2 id="quota-settings-title" className="text-lg font-semibold">Quota &amp; switching</h2>
      <button autoFocus onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1 text-sm dark:border-gray-600">Done</button>
    </div>
    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Changes are saved automatically.</p>
    <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={autoEnabled} onChange={event => onAutoEnabledChange(event.target.checked)} />
        Auto-select the best available account
      </label>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Waits until a reported quota window reaches 0% remaining, then switches to a verified available alternative. May close running Codex sessions and attempt to resume supported IDE sessions. Banked resets stay manual. Runs while this app is open.</p>
      <fieldset disabled={!autoEnabled} className="mt-3 space-y-2 border-l-2 border-gray-200 pl-3 disabled:opacity-50 dark:border-gray-700">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={autoPolicy.useExpiringFiveHourQuota} onChange={event => onAutoPolicyChange({ ...autoPolicy, useExpiringFiveHourQuota: event.target.checked })} />
          Use expiring 5-hour quota first
        </label>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Switch when the reset is within
          <select className="rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-900" disabled={!autoPolicy.useExpiringFiveHourQuota} value={autoPolicy.leadMinutes} onChange={event => onAutoPolicyChange({ ...autoPolicy, leadMinutes: Number(event.target.value) })}>
            <option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option>
          </select>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400">Can switch early even while your current account has plenty of quota. Uses the earliest eligible 5-hour reset, then stays until either limit is exhausted or that window resets, using all remaining quota. Weekly quota must still be available and is consumed too. Cooldowns still apply. This routes your work; it does not generate extra work to spend quota.</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">Fresh unused five-hour accounts are warmed one at a time, at least one hour apart. This manages their automatic and timed warm-ups; individual warm-up toggles are not required. Weekly-only accounts fill gaps between expiring five-hour accounts. Already-running windows keep their existing reset times.</p>
      </fieldset>

    </div>
  </dialog>;
}
