import { useCallback, useEffect, useState } from "react";
import type { AntigravityAccountInfo, AntigravityUsageInfo } from "../types";
import { invokeBackend, isTauriRuntime } from "../lib/platform";

const HIDDEN_MODELS_STORAGE_KEY = "antigravity-hidden-model-ids";

interface AntigravityProcessInfo {
  count: number;
  can_switch: boolean;
  process_names: string[];
}

interface KillAntigravityProcessesResult {
  targeted_count: number;
  killed_process_names: string[];
  failed_process_names: string[];
}

function readHiddenModelIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(HIDDEN_MODELS_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function formatCredits(value: number | null): string {
  return value === null ? "--" : new Intl.NumberFormat().format(value);
}

function formatModelReset(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function compareModelVersions(left: string, right: string): number {
  const leftParts = left.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const rightParts = right.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function defaultVisibleModelIds(models: AntigravityUsageInfo["models"]): Set<string> {
  const groups = ["flash", "pro", "claude"];
  return new Set(
    groups.flatMap((group) => {
      const matches = models.filter((model) => model.label.toLowerCase().includes(group));
      if (matches.length === 0) return [];
      const latest = matches.reduce((current, candidate) =>
        compareModelVersions(candidate.label, current.label) > 0 ? candidate : current
      );
      return [latest.model_id];
    })
  );
}

export function AntigravityAccounts() {
  const [accounts, setAccounts] = useState<AntigravityAccountInfo[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<AntigravityUsageInfo | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [hiddenModelIds, setHiddenModelIds] = useState<Set<string>>(readHiddenModelIds);
  const [forceCloseCandidate, setForceCloseCandidate] = useState<string | null>(null);
  const [processInfo, setProcessInfo] = useState<AntigravityProcessInfo | null>(null);
  const [forceClosing, setForceClosing] = useState(false);
  const [modelSelectionInitialized, setModelSelectionInitialized] = useState(
    () => window.localStorage.getItem(HIDDEN_MODELS_STORAGE_KEY) !== null
  );

  const loadAccounts = useCallback(async () => {
    try {
      setError(null);
      setAccounts(await invokeBackend<AntigravityAccountInfo[]>("list_antigravity_accounts"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const refreshUsage = useCallback(async () => {
    try {
      setRefreshingUsage(true);
      setUsageError(null);
      setUsage(await invokeBackend<AntigravityUsageInfo>("get_antigravity_usage"));
    } catch (err) {
      setUsage(null);
      setUsageError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingUsage(false);
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
    const timer = window.setInterval(() => void refreshUsage(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshUsage]);

  useEffect(() => {
    if (!usage?.models.length || modelSelectionInitialized) return;

    const visibleIds = defaultVisibleModelIds(usage.models);
    const hiddenIds = usage.models
      .filter((model) => !visibleIds.has(model.model_id))
      .map((model) => model.model_id);
    setHiddenModelIds(new Set(hiddenIds));
    window.localStorage.setItem(HIDDEN_MODELS_STORAGE_KEY, JSON.stringify(hiddenIds));
    setModelSelectionInitialized(true);
  }, [modelSelectionInitialized, usage]);

  const toggleModelVisibility = (modelId: string) => {
    setHiddenModelIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      window.localStorage.setItem(HIDDEN_MODELS_STORAGE_KEY, JSON.stringify(Array.from(next)));
      setModelSelectionInitialized(true);
      return next;
    });
  };

  const visibleModels = usage?.models.filter((model) => !hiddenModelIds.has(model.model_id)) ?? [];

  const capture = async () => {
    try {
      setCapturing(true);
      setError(null);
      await invokeBackend("capture_current_antigravity_account", { name: name.trim() });
      setName("");
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  };

  const switchAccount = async (accountId: string, force = false) => {
    try {
      setWorkingId(accountId);
      setError(null);
      await invokeBackend("switch_antigravity_account", { accountId, force });
      await loadAccounts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!force && message.includes("before switching the Antigravity account")) {
        try {
          setProcessInfo(await invokeBackend<AntigravityProcessInfo>("check_antigravity_processes"));
          setForceCloseCandidate(accountId);
        } catch {
          setError(message);
        }
      } else {
        setError(message);
      }
    } finally {
      setWorkingId(null);
    }
  };

  const forceCloseAndSwitch = async () => {
    const accountId = forceCloseCandidate;
    if (!accountId) return;

    try {
      setForceClosing(true);
      setError(null);
      const result = await invokeBackend<KillAntigravityProcessesResult>("kill_antigravity_processes");
      if (result.failed_process_names.length > 0) {
        setError(`Could not close ${result.failed_process_names.join(", ")}.`);
        return;
      }
      const latest = await invokeBackend<AntigravityProcessInfo>("check_antigravity_processes");
      if (!latest.can_switch) {
        setProcessInfo(latest);
        setError("Antigravity processes are still running.");
        return;
      }
      await switchAccount(accountId, true);
      setForceCloseCandidate(null);
      setProcessInfo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setForceClosing(false);
    }
  };

  const deleteAccount = async (accountId: string) => {
    if (deleteCandidate !== accountId) {
      setDeleteCandidate(accountId);
      return;
    }

    try {
      setWorkingId(accountId);
      setError(null);
      await invokeBackend("delete_antigravity_account", { accountId });
      setDeleteCandidate(null);
      await loadAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingId(null);
    }
  };

  if (!isTauriRuntime()) return null;

  return (
    <section className="mt-10 border-t border-gray-200 pt-8 dark:border-gray-800">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Antigravity / Gemini
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Capture the current Antigravity desktop session, then switch it after quitting the desktop app.
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Account name (optional)"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 sm:w-52"
          />
          <button
            onClick={() => void capture()}
            disabled={capturing}
            className="shrink-0 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {capturing ? "Capturing..." : "Capture Session"}
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-emerald-400 bg-white p-5 shadow-sm dark:bg-gray-900">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2">
                <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
              <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                Antigravity desktop
              </div>
            </div>
            <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {usage?.plan_name ?? "Live model quota"}
            </div>
          </div>
          <button
            onClick={() => void refreshUsage()}
            disabled={refreshingUsage}
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {refreshingUsage ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {usage && (usage.prompt_credits_monthly !== null || usage.flow_credits_monthly !== null) && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            {usage.prompt_credits_monthly !== null && (
              <div className="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/70">
                <div className="text-xs text-gray-500 dark:text-gray-400">Monthly prompt credits</div>
                <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {formatCredits(usage.prompt_credits_available)} <span className="font-normal text-gray-400">/ {formatCredits(usage.prompt_credits_monthly)}</span>
                </div>
              </div>
            )}
            {usage.flow_credits_monthly !== null && (
              <div className="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800/70">
                <div className="text-xs text-gray-500 dark:text-gray-400">Monthly flow credits</div>
                <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {formatCredits(usage.flow_credits_available)} <span className="font-normal text-gray-400">/ {formatCredits(usage.flow_credits_monthly)}</span>
                </div>
              </div>
            )}
          </div>
        )}
        {usage?.models.length ? (
          <>
          <details className="mb-3">
            <summary className="cursor-pointer text-xs font-medium text-gray-500 dark:text-gray-400">
              Choose displayed models ({visibleModels.length} of {usage.models.length})
            </summary>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {usage.models.map((model) => (
                <label key={model.model_id} className="flex min-w-0 items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={!hiddenModelIds.has(model.model_id)}
                    onChange={() => toggleModelVisibility(model.model_id)}
                    className="h-3.5 w-3.5 accent-gray-900 dark:accent-gray-100"
                  />
                  <span className="truncate">{model.label}</span>
                </label>
              ))}
            </div>
          </details>
          <div className="space-y-2">
            {visibleModels.map((model) => (
              <div key={`${model.model_id}-${model.label}`} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3 text-xs">
                <div className="min-w-0">
                  <div className="mb-1 flex justify-between gap-2 text-gray-600 dark:text-gray-300">
                    <span className="truncate">{model.label}</span>
                    {formatModelReset(model.reset_at) && <span className="shrink-0 text-gray-400 dark:text-gray-500">resets {formatModelReset(model.reset_at)}</span>}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                    <div className="h-full bg-emerald-500" style={{ width: `${model.remaining_percent}%` }} />
                  </div>
                </div>
                <span className="text-right font-medium text-gray-700 dark:text-gray-200">{Math.round(model.remaining_percent)}%</span>
              </div>
            ))}
            {visibleModels.length === 0 && <p className="text-xs text-gray-500 dark:text-gray-400">No models selected.</p>}
          </div>
          </>
        ) : usageError ? (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Open Antigravity desktop to load live quota.</p>
        ) : (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">No model quota is available from the current Antigravity session.</p>
        )}
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      )}

      {!loading && accounts.length === 0 && !error && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          No Antigravity sessions captured yet.
        </p>
      )}

      {accounts.length > 0 && (
        <div className="mt-4 space-y-4">
          {accounts.map((account) => (
            <div
              key={account.id}
              className={`rounded-xl border p-5 transition-all duration-200 ${
                account.is_active
                  ? "border-emerald-400 bg-white shadow-sm dark:bg-gray-900"
                  : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600"
              }`}
            >
              <div className="flex min-w-0 flex-1 items-start gap-2">
                {account.is_active && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-green-500" />}
                <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {account.name}
                  </span>
                  {account.is_active && (
                    <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                      Active
                    </span>
                  )}
                </div>
                {account.email && <p className="truncate text-xs text-gray-500 dark:text-gray-400">{account.email}</p>}
                </div>
              </div>
              {!account.is_active && (
                <button
                  onClick={() => void switchAccount(account.id)}
                  disabled={workingId !== null}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  {workingId === account.id ? "Switching..." : "Switch"}
                </button>
              )}
              <button
                onClick={() => void deleteAccount(account.id)}
                disabled={workingId !== null}
                className="rounded-lg px-2 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                {deleteCandidate === account.id ? "Confirm remove" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}

      {forceCloseCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-100 p-5 dark:border-gray-800">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Close Antigravity before switching?
              </h2>
            </div>
            <div className="space-y-3 p-5 text-sm text-gray-600 dark:text-gray-300">
              <p>
                This will force close {processInfo?.count ?? 0} Antigravity or agy process{(processInfo?.count ?? 0) === 1 ? "" : "es"} before switching accounts.
              </p>
              {processInfo?.process_names.length ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">{processInfo.process_names.join(", ")}</p>
              ) : null}
              <p className="text-red-600 dark:text-red-300">Unsaved desktop work or CLI output may be lost.</p>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-100 p-5 dark:border-gray-800">
              <button
                onClick={() => {
                  setForceCloseCandidate(null);
                  setProcessInfo(null);
                }}
                disabled={forceClosing}
                className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={() => void forceCloseAndSwitch()}
                disabled={forceClosing}
                className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {forceClosing ? "Closing..." : "Close & Switch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}