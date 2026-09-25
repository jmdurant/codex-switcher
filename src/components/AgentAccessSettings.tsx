import { useEffect, useState } from "react";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import type { AccountInfo } from "../types";

interface Access {
  enabled: boolean;
  allow_switch: boolean;
  allow_interrupt: boolean;
  allow_resets: boolean;
  allow_all_accounts: boolean;
  allowed_account_ids: string[];
  reset_max_remaining_percent: number;
  cooldown_seconds: number;
}
interface Connection { settings: Access; command: string; args: string[]; backend_alive: boolean }
interface Operation { operation_id: string; tool: string; state: string; error: string | null; result: { resume_requested_sessions?: number; resume_verified?: boolean } | null }

export function AgentAccessSettings({ accounts }: { accounts: AccountInfo[] }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [config, history] = await Promise.all([
          invokeBackend<Connection>("get_agent_access"), invokeBackend<Operation[]>("get_agent_operations"),
        ]);
        if (!cancelled) { setConnection(config); setOperations(history); }
      } catch (e) { if (!cancelled) setError(String(e)); }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!saving) void refresh(); }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [saving]);
  if (!isTauriRuntime()) return <p className="mt-4 text-xs text-gray-500">Configure the agent connection in the desktop app.</p>;
  const update = async (patch: Partial<Access>) => {
    if (!connection || saving) return;
    const settings = { ...connection.settings, ...patch };
    setSaving(true); setError("");
    try { await invokeBackend("set_agent_access", { settings }); setConnection({ ...connection, settings }); }
    catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };
  const settings = connection?.settings;
  const config = connection ? `[mcp_servers.account_switcher]\ncommand = ${JSON.stringify(connection.command)}\nargs = ["--mcp"]\ntool_timeout_sec = 120\n` : "";
  return <section className="mt-5 border-t border-gray-200 pt-4 dark:border-gray-700" aria-labelledby="agent-connection-title">
    <h3 id="agent-connection-title" className="font-semibold">Agent connection (MCP)</h3>
    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Local agents can inspect quota and request operations. Keep this app running; it finishes accepted requests if the agent disconnects.</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {!settings ? <p className="mt-2 text-sm">Loading connection…</p> : <>
      <fieldset disabled={saving} className="mt-3 space-y-3 disabled:opacity-60">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={settings.enabled} onChange={e => void update({ enabled: e.target.checked })} />Enable local agent access</label>
        <fieldset disabled={!settings.enabled} className="space-y-3 border-l-2 border-gray-200 pl-3 disabled:opacity-50 dark:border-gray-700">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.allow_switch} onChange={e => void update({ allow_switch: e.target.checked })} />Allow account switching</label>
          <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={settings.allow_interrupt} onChange={e => void update({ allow_interrupt: e.target.checked })} />Allow stopping and resuming captured IDE sessions</label>
          <p className="text-xs text-gray-500 dark:text-gray-400">Switching affects the shared local Codex login. Agent requests are refused if any running Codex process lacks an exact captured IDE session. The native Codex desktop app is not automatically resumed.</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.allow_resets} onChange={e => void update({ allow_resets: e.target.checked })} />Allow spending banked resets</label>
          <p className="text-xs text-gray-500 dark:text-gray-400">Spends a specific reset on the active account. May forfeit remaining quota and change reset dates. These settings provide standing permission; each request is recorded below.</p>
          <label className="flex flex-wrap items-center gap-2 text-sm">Spend only when a quota window has at most
            <select className="rounded border bg-white px-1 dark:bg-gray-900" value={settings.reset_max_remaining_percent} onChange={e => void update({ reset_max_remaining_percent: Number(e.target.value) })}>
              {[0,5,10,20,50,100].map(n => <option key={n} value={n}>{n}%</option>)}
            </select> remaining
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">Minimum time between operations
            <select className="rounded border bg-white px-1 dark:bg-gray-900" value={settings.cooldown_seconds} onChange={e => void update({ cooldown_seconds: Number(e.target.value) })}>
              {[60,120,300,600].map(n => <option key={n} value={n}>{n / 60} min</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.allow_all_accounts} onChange={e => void update({ allow_all_accounts: e.target.checked })} />Allow all ChatGPT accounts</label>
          {!settings.allow_all_accounts && <div className="max-h-40 space-y-2 overflow-y-auto">
            {accounts.filter(a => a.auth_mode === "chat_g_p_t").map(a => <label key={a.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={settings.allowed_account_ids.includes(a.id)} onChange={e => void update({ allowed_account_ids: e.target.checked ? [...settings.allowed_account_ids,a.id] : settings.allowed_account_ids.filter(id => id !== a.id) })} />{a.name}</label>)}
          </div>}
        </fieldset>
      </fieldset>
      <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Connect Codex or another MCP client</summary>
        <p className="mt-2 text-xs text-gray-500">Add this to Codex’s config.toml, then restart the client. Other local MCP clients use the same command and arguments.</p>
        <pre className="mt-2 overflow-x-auto rounded bg-gray-100 p-2 text-xs dark:bg-gray-950">{config}</pre>
        <button className="mt-2 rounded border px-2 py-1 text-xs" onClick={() => { void navigator.clipboard.writeText(config).then(() => setCopied(true)).catch(e => setError(String(e))); }}>{copied ? "Copied" : "Copy configuration"}</button>
        <p className="mt-2 text-xs">App worker: {connection.backend_alive ? "ready" : "unavailable"}</p>
      </details>
      <h4 className="mt-4 text-sm font-medium">Recent agent operations</h4>
      {operations.length === 0 ? <p className="mt-1 text-xs text-gray-500">No operations yet.</p> : <ul className="mt-2 max-h-44 space-y-2 overflow-y-auto text-xs">
        {operations.map(op => <li key={op.operation_id} className="rounded border border-gray-200 p-2 dark:border-gray-700"><span className="font-medium">{op.tool} · {op.state}</span><div className="break-all text-gray-500">{op.operation_id}</div>{op.error && <p className="mt-1 text-red-600 dark:text-red-400">{op.error}</p>}{!!op.result?.resume_requested_sessions && <p className="mt-1">{op.result.resume_verified ? "Session startup verified" : `Resume requested for ${op.result.resume_requested_sessions} session(s); startup not verified`}.</p>}</li>)}
      </ul>}
    </>}
  </section>;
}
