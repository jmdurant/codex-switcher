import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeState, ClaudeUsage } from "../types";
import { invokeBackend, openExternalUrl } from "../lib/platform";

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function ClaudeUsageView({ usage }: { usage: ClaudeUsage }) {
  const windows = [{ label: "5-hour", value: usage.five_hour }, { label: "Weekly", value: usage.seven_day }];
  return <div className="space-y-2">
    {windows.map(({ label, value }) => {
      if (!value) return null;
      const remaining = Math.max(0, Math.min(100, 100 - value.used_percent));
      return <div key={label}>
        <div className="flex justify-between gap-2 text-xs text-gray-600 dark:text-gray-300">
          <span>{label}</span><span>{Math.round(remaining)}% left</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
          <div className={`h-full rounded-full ${remaining <= 10 ? "bg-red-500" : remaining <= 30 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${remaining}%` }} />
        </div>
        <p className="mt-1 text-[11px] text-gray-500">Resets {new Date(value.resets_at * 1000).toLocaleString()}</p>
      </div>;
    })}
    <p className={`text-[11px] ${usage.stale ? "text-amber-600 dark:text-amber-400" : "text-gray-500"}`}>
      {usage.stale ? "Last reported" : "Reported"} {new Date(usage.observed_at * 1000).toLocaleString()}
      {usage.stale ? " · waiting for a fresh Claude response" : " · from Claude Code"}
    </p>
  </div>;
}

export function ClaudeAccounts() {
  const [state, setState] = useState<ClaudeState | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const request = useRef(0);
  const working = useRef(false);
  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const result = await invokeBackend<ClaudeState>("get_claude_state");
      if (id === request.current) { setState(result); setError(null); }
    } catch (error) {
      if (id === request.current) setError(message(error));
    } finally { if (id === request.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!working.current) void load(); }, 60_000);
    return () => { window.clearInterval(timer); request.current += 1; };
  }, [load]);

  const run = async (command: string, args: Record<string, unknown>, success: string) => {
    if (working.current) return;
    working.current = true;
    request.current += 1;
    setBusy(true); setError(null); setNotice(null);
    try {
      await invokeBackend(command, args);
      if (command === "capture_claude_account") setName("");
      setRemoveId(null);
      await load();
      setNotice(success);
    } catch (error) { setError(message(error)); }
    finally { working.current = false; setBusy(false); }
  };

  const button = "rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800";
  return <section className="mt-8 border-t border-gray-200 pt-6 dark:border-gray-800" aria-labelledby="claude-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="claude-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Claude Code</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-400">
          Sign in with <code>claude auth login</code>, quit Claude Code, then capture the session. Quit all Claude sessions before switching and restart them afterwards.
        </p>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void run("capture_claude_account", { name: name.trim() }, "Claude login captured. Capturing the same account updates its saved login."); }}>
        <input aria-label="Claude account name" placeholder="Account name (optional)" value={name} onChange={(e) => setName(e.target.value)} disabled={busy}
          className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        <button type="submit" disabled={busy} className={button}>{busy ? "Working…" : "Capture Session"}</button>
      </form>
    </div>
    <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Subscription usage</h3>
          <p className="mt-1 text-xs text-gray-500">Saved login: {state?.current_email ?? "No subscription login found"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || loading} className={button} onClick={() => void load()}>Refresh</button>
          <button disabled={busy || !state} className={button} onClick={() => void run("set_claude_usage_tracking", { enabled: !state?.usage_tracking_enabled }, state?.usage_tracking_enabled ? "Usage tracking disabled; your previous status line was restored." : "Usage tracking enabled. Restart Claude Code and send a message to report usage.")}>
            {state?.usage_tracking_enabled ? "Disable usage tracking" : "Enable usage tracking"}
          </button>
          <button className={button} onClick={() => void openExternalUrl("https://claude.ai/settings/usage").catch((e) => setError(message(e)))}>Open Claude usage</button>
        </div>
      </div>
      {state?.usage ? <ClaudeUsageView usage={state.usage} /> : <p className="text-sm text-gray-500">
        {loading ? "Checking Claude Code…" : state?.usage_tracking_enabled ? "Waiting for Claude Code to report its 5-hour and weekly limits after a response." : "Enable usage tracking to collect limits reported by Claude Code. Your existing status line is preserved."}
      </p>}
      <p className="mt-3 text-xs text-gray-500">Usage updates while Claude Code is active. API keys and cloud-provider logins use their own billing and limits.</p>
    </div>
    {state?.warning && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">{state.warning}</p>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
    {!loading && state?.accounts.length === 0 && <p className="mt-4 text-sm text-gray-500">No Claude Code accounts captured yet.</p>}
    <div className="mt-4 space-y-3">
      {state?.accounts.map((account) => <div key={account.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4 dark:bg-gray-900 ${account.matches_login ? "border-emerald-400" : "border-gray-200 dark:border-gray-700"}`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            <span>{account.name}</span>
            {account.is_selected && <span className="text-xs text-emerald-600 dark:text-emerald-400">Selected</span>}
            {account.matches_login && <span className="text-xs text-gray-500">Matches saved login</span>}
          </div>
          <p className="mt-1 text-xs text-gray-500">{[account.email, account.plan].filter(Boolean).join(" · ")}</p>
          {account.needs_login && <p className="mt-1 text-xs text-amber-600">Sign in and capture again to renew this login.</p>}
        </div>
        <div className="flex gap-2">
          <button className={button} disabled={busy || account.needs_login} onClick={() => void run("switch_claude_account", { accountId: account.id }, "Claude credentials saved and checked. Start Claude Code to use this account.")}>Switch</button>
          <button className={button} disabled={busy} onClick={() => {
            if (removeId !== account.id) { setRemoveId(account.id); return; }
            void run("delete_claude_account", { accountId: account.id }, "Saved account removed. Your Claude login is unchanged.");
          }}>{removeId === account.id ? "Confirm remove" : "Remove"}</button>
          {removeId === account.id && <button className={button} onClick={() => setRemoveId(null)}>Cancel</button>}
        </div>
      </div>)}
    </div>
    <p className="mt-3 text-xs text-gray-500">Switching manages subscription logins for the current Claude configuration. Terminal or project authentication overrides still take precedence.</p>
  </section>;
}
