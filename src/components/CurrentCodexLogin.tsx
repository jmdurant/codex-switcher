import { useCallback, useEffect, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import type { AccountInfo } from "../types";

interface DetectedLogin {
  account: AccountInfo;
  is_managed: boolean;
}

export function CurrentCodexLogin({ accountsRevision, maskedAccountIds, onCaptured }: {
  accountsRevision: string;
  maskedAccountIds: Set<string>;
  onCaptured: (account: AccountInfo) => Promise<void>;
}) {
  const [login, setLogin] = useState<DetectedLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const request = ++sequence.current;
    try {
      const result = await invokeBackend<DetectedLogin | null>("get_current_codex_login");
      if (request === sequence.current) { setLogin(result); setError(null); }
    } catch (err) {
      if (request === sequence.current) {
        setLogin(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      sequence.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, accountsRevision]);

  const capture = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await invokeBackend<AccountInfo>("capture_current_codex_login");
      setLogin({ account, is_managed: true });
      await onCaptured(account);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  if (!isTauriRuntime()) return null;
  const masked = login?.is_managed && maskedAccountIds.has(login.account.id);
  return (
    <section className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-900" aria-label="Current Codex login">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {login ? "Codex login detected" : "No local Codex login detected"}
        </p>
        {login && (
          <p className="break-all text-sm text-gray-500 dark:text-gray-400">
            {masked ? "Saved Codex account" : login.account.email ?? login.account.name}
            {login.account.plan_type ? ` · ${login.account.plan_type}` : ""}
          </p>
        )}
        {error && <p className="mt-1 text-sm text-red-600 dark:text-red-300" role="alert">{error}</p>}
      </div>
      {login && (login.is_managed && login.account.is_active ? (
        <span className="text-xs text-gray-500 dark:text-gray-400">Already added · Active</span>
      ) : (
        <button onClick={() => void capture()} disabled={busy}
          className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">
          {busy ? "Adding…" : login.is_managed ? "Use current login" : "Add current login"}
        </button>
      ))}
    </section>
  );
}
