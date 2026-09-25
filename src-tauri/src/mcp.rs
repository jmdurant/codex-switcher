//! Local stdio MCP facade. The GUI owns execution; SQLite commits precede acknowledgement.
//! No account credentials are returned or copied into this journal.
use crate::{
    auth, commands,
    types::{AccountInfo, AuthMode, UsageInfo},
};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Emitter;
use uuid::Uuid;

const MAX_MESSAGE: usize = 64 * 1024;
const PROTOCOL: &str = "2025-11-25";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AgentAccess {
    pub enabled: bool,
    pub allow_switch: bool,
    pub allow_interrupt: bool,
    pub allow_resets: bool,
    pub allow_all_accounts: bool,
    pub allowed_account_ids: Vec<String>,
    pub reset_max_remaining_percent: f64,
    pub cooldown_seconds: u64,
}
impl Default for AgentAccess {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_switch: false,
            allow_interrupt: false,
            allow_resets: false,
            allow_all_accounts: true,
            allowed_account_ids: vec![],
            reset_max_remaining_percent: 10.0,
            cooldown_seconds: 60,
        }
    }
}
impl AgentAccess {
    fn permits(&self, id: &str) -> bool {
        self.allow_all_accounts || self.allowed_account_ids.iter().any(|v| v == id)
    }
    fn validate(&self) -> Result<()> {
        if !self.reset_max_remaining_percent.is_finite()
            || !(0.0..=100.0).contains(&self.reset_max_remaining_percent)
        {
            bail!("Reset threshold must be between 0 and 100 percent");
        }
        if !(60..=86400).contains(&self.cooldown_seconds) {
            bail!("Cooldown must be between 60 and 86400 seconds");
        }
        for id in &self.allowed_account_ids {
            validate_id(id)?;
        }
        Ok(())
    }
}
fn root() -> Result<PathBuf> {
    let dir = auth::get_config_dir()?.join("agent-control");
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}
fn database_at(path: &Path) -> Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS heartbeat (id INTEGER PRIMARY KEY CHECK(id=1), updated INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, name TEXT NOT NULL, args TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', result TEXT);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, name TEXT NOT NULL, args TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT);")?;
    Ok(db)
}
fn database() -> Result<Connection> {
    database_at(&root()?.join("journal.sqlite"))
}
fn access(db: &Connection) -> Result<AgentAccess> {
    let body: Option<String> = db
        .query_row("SELECT body FROM settings WHERE id=1", [], |r| r.get(0))
        .optional()?;
    let settings = body
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or_default();
    Ok(settings)
}
fn enabled(db: &Connection) -> Result<AgentAccess> {
    let settings = access(db)?;
    if !settings.enabled {
        bail!("Agent access is disabled. Enable it in Settings → Quota & switching → Agent connection.");
    }
    Ok(settings)
}

pub(crate) fn check_switch_policy(
    account_id: &str,
    interrupt: bool,
) -> std::result::Result<(), String> {
    (|| -> Result<()> {
        let settings = enabled(&database()?)?;
        if !settings.allow_switch || !settings.permits(account_id) {
            bail!("Agent switching permission changed");
        }
        if interrupt && !settings.allow_interrupt {
            bail!("Agent session interruption permission changed");
        }
        Ok(())
    })()
    .map_err(|e| e.to_string())
}
fn alive(db: &Connection) -> bool {
    db.query_row("SELECT updated FROM heartbeat WHERE id=1", [], |r| {
        r.get::<_, i64>(0)
    })
    .is_ok_and(|t| Utc::now().timestamp_millis().saturating_sub(t) < 10000)
}
fn validate_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_err() {
        bail!("Expected a UUID");
    }
    Ok(())
}

#[tauri::command]
pub fn get_agent_access() -> std::result::Result<Value, String> {
    (|| -> Result<Value> {
        let db = database()?;
        Ok(
            json!({"settings":access(&db)?, "command": std::env::current_exe()?,
        "args":["--mcp"], "backend_alive":alive(&db), "reset_redemption_supported":true}),
        )
    })()
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn set_agent_access(settings: AgentAccess) -> std::result::Result<(), String> {
    (|| -> Result<()> { settings.validate()?; database()?.execute("INSERT INTO settings(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [serde_json::to_string(&settings)?])?; Ok(()) })().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn get_agent_operations() -> std::result::Result<Value, String> {
    recent_operations(&database().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn operation(db: &Connection, id: &str) -> Result<Value> {
    validate_id(id)?;
    let mut value = db.query_row("SELECT id,name,created,updated,state,result,error FROM operations WHERE id=?1", [id], |r| {
        let result: Option<String> = r.get(5)?;
        Ok(json!({"operation_id":r.get::<_,String>(0)?, "tool":r.get::<_,String>(1)?,
            "created_at_ms":r.get::<_,i64>(2)?, "updated_at_ms":r.get::<_,i64>(3)?, "state":r.get::<_,String>(4)?,
            "result":result.and_then(|s| serde_json::from_str::<Value>(&s).ok()), "error":r.get::<_,Option<String>>(6)?}))
    }).optional()?.context("Operation not found")?;
    if let Some(request) = value["result"]["resume_request_id"].as_str() {
        let expected = value["result"]["resume_requested_sessions"]
            .as_u64()
            .unwrap_or(0) as usize;
        if let Ok(outcome) = commands::ide_bridge::resume_outcome(request, expected) {
            if let Some(result) = value["result"].as_object_mut() {
                for (key, item) in outcome.as_object().unwrap() {
                    result.insert(key.clone(), item.clone());
                }
            }
        }
    }
    Ok(value)
}
fn recent_operations(db: &Connection) -> Result<Value> {
    let mut stmt = db.prepare("SELECT id FROM operations ORDER BY created DESC LIMIT 30")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(json!(ids
        .iter()
        .map(|id| operation(db, id))
        .collect::<Result<Vec<_>>>()?))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SwitchArgs {
    account_id: String,
    expected_active_account_id: String,
    operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetArgs {
    account_id: String,
    credit_id: String,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuotaArgs {
    account_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusArgs {
    operation_id: String,
}

fn authorize(settings: &AgentAccess, name: &str, args: &Value) -> Result<String> {
    if !settings.enabled {
        bail!("Agent access is disabled");
    }
    let (id, op_id) = match name {
        "switch_and_resume" => {
            let a: SwitchArgs = serde_json::from_value(args.clone())?;
            if !settings.allow_switch {
                bail!("Agent switching is disabled");
            }
            validate_id(&a.expected_active_account_id)?;
            (a.account_id, a.operation_id)
        }
        "use_reset" => {
            let a: ResetArgs = serde_json::from_value(args.clone())?;
            if !settings.allow_resets {
                bail!("Agent reset spending is disabled");
            }
            if a.credit_id.is_empty() || a.credit_id.len() > 256 {
                bail!("Invalid credit ID");
            }
            (a.account_id, a.operation_id)
        }
        _ => bail!("Unsupported operation"),
    };
    validate_id(&id)?;
    validate_id(&op_id)?;
    if !settings.permits(&id) {
        bail!("Account is not allowed by agent settings");
    }
    Ok(op_id)
}
fn enqueue(db: &mut Connection, name: &str, args: &Value) -> Result<Value> {
    let settings = enabled(db)?;
    let id = authorize(&settings, name, args)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing: Option<(String, String)> = tx
        .query_row("SELECT name,args FROM operations WHERE id=?1", [&id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    if let Some((old_name, old_args)) = existing {
        if old_name != name || serde_json::from_str::<Value>(&old_args)? != *args {
            bail!("Operation ID already belongs to a different request");
        }
        return operation(&tx, &id);
    }
    let active: i64 = tx.query_row(
        "SELECT COUNT(*) FROM operations WHERE state IN ('queued','running')",
        [],
        |r| r.get(0),
    )?;
    if active > 0 {
        bail!("Another agent operation is pending; check its status first");
    }
    let last: Option<i64> = tx.query_row("SELECT MAX(updated) FROM operations WHERE state IN ('completed','uncertain','interrupted')", [], |r| r.get(0))?;
    if last.is_some_and(|t| {
        Utc::now().timestamp_millis() - t < settings.cooldown_seconds as i64 * 1000
    }) {
        bail!("Agent operation cooldown is active");
    }
    let now = Utc::now().timestamp_millis();
    tx.execute("INSERT INTO operations(id,name,args,created,updated,state) VALUES(?1,?2,?3,?4,?4,'queued')", params![id,name,serde_json::to_string(args)?,now])?;
    tx.commit()?;
    operation(db, &id)
}

pub fn tools_list() -> Value {
    let uuid = json!({"type":"string","format":"uuid"});
    let tool = |name: &str, description: &str, props: Value, required: Vec<&str>, read: bool| {
        json!({
        "name":name,"description":description,"inputSchema":{"type":"object","properties":props,"required":required,"additionalProperties":false},
        "annotations":{"readOnlyHint":read,"destructiveHint":!read,"idempotentHint":true,"openWorldHint":true}})
    };
    json!({"tools":[
        tool("get_quota_options", "Read allowed accounts, live quota, natural reset times and banked resets. Credentials are never returned. Optional account_id narrows the request.", json!({"account_id":uuid}), vec![],true),
        tool("switch_and_resume", "Queue an account switch in the running app. Save work first. May stop ALL local Codex sessions sharing auth; supported IDE terminals are captured and resume is requested. The app continues if this MCP connection dies. Supply a fresh UUID operation_id and reuse it for retries. expected_active_account_id prevents stale decisions. Check get_operation_status after reconnecting; resume requested is not verified continuation.", json!({"account_id":uuid,"expected_active_account_id":uuid,"operation_id":uuid}),vec!["account_id","expected_active_account_id","operation_id"],false),
        tool("get_operation_status", "Read a durable operation outcome using the SAME operation_id. Uncertain/interrupted outcomes need inspection, never a new spend request. Completed switching reports separately whether resume was verified.",json!({"operation_id":uuid}),vec!["operation_id"],true),
        tool("list_operations", "List recent durable operations, including requests made before the caller disconnected.",json!({}),vec![],true),
        tool("use_reset", "Spend one specific available banked reset on the active account, only if enabled in app settings and quota meets the configured threshold. Read quota options first. May forfeit remaining quota and change reset times. Supply a UUID operation_id, reused as the redemption idempotency key; never retry an uncertain result with a new ID. Does not restart sessions.",json!({"account_id":uuid,"credit_id":{"type":"string","minLength":1,"maxLength":256},"operation_id":uuid}),vec!["account_id","credit_id","operation_id"],false)
    ]})
}

pub fn run_stdio() -> Result<()> {
    let input = std::io::stdin();
    let mut input = input.lock();
    let output = std::io::stdout();
    let mut output = output.lock();
    let mut initialized = false;
    loop {
        let mut line = Vec::new();
        let count = input
            .by_ref()
            .take((MAX_MESSAGE + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if line.len() > MAX_MESSAGE {
            bail!("MCP request too large");
        }
        let response = match serde_json::from_slice::<Value>(&line) {
            Ok(request) => handle_rpc(request, &mut initialized),
            Err(_) => Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
            ),
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut output, &response)?;
            writeln!(output)?;
            output.flush()?;
        }
    }
    Ok(())
}
fn handle_rpc(request: Value, initialized: &mut bool) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str);
    let error = |code, message: &str| json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}});
    if request.get("jsonrpc") != Some(&json!("2.0"))
        || method.is_none()
        || id
            .as_ref()
            .is_some_and(|v| !v.is_string() && !v.is_number())
    {
        return Some(error(-32600, "Invalid request"));
    }
    if id.is_none() {
        return None;
    }
    let params = request.get("params").cloned().unwrap_or(json!({}));
    let result = match method.unwrap() {
        "initialize" => {
            if *initialized {
                return Some(error(-32600, "Already initialized"));
            }
            if !params["protocolVersion"].is_string() {
                return Some(error(-32602, "Missing protocolVersion"));
            }
            *initialized = true;
            let requested = params["protocolVersion"].as_str().unwrap();
            let version =
                if ["2024-11-05", "2025-03-26", "2025-06-18", PROTOCOL].contains(&requested) {
                    requested
                } else {
                    PROTOCOL
                };
            json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"ai-account-switcher","version":env!("CARGO_PKG_VERSION")},
                "instructions":"Use get_quota_options before acting. The running desktop app controls permissions and finishes queued operations independently. Save each operation_id before a switch; reconnect and check its status. Never interpret unavailable quota as zero. Never repeat an uncertain reset using a new operation_id."})
        }
        "ping" => json!({}),
        _ if !*initialized => return Some(error(-32002, "Initialize first")),
        "tools/list" => tools_list(),
        "tools/call" => {
            let Some(name) = params["name"].as_str() else {
                return Some(error(-32602, "Missing tool name"));
            };
            if !tools_list()["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == name)
            {
                return Some(error(-32602, "Unknown tool"));
            }
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let outcome = call_app(name, &args);
            match outcome {
                Ok(value) => {
                    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":{"data":value},"isError":false})
                }
                Err(e) => json!({"content":[{"type":"text","text":e.to_string()}],"isError":true}),
            }
        }
        _ => return Some(error(-32601, "Method not found")),
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
fn call_app(name: &str, args: &Value) -> Result<Value> {
    if !args.is_object() {
        bail!("Tool arguments must be an object");
    }
    let db = database()?;
    enabled(&db)?;
    // Status remains inspectable even after the app exits.
    if name == "get_operation_status" {
        let a: StatusArgs = serde_json::from_value(args.clone())?;
        return operation(&db, &a.operation_id);
    }
    if name == "list_operations" {
        if args != &json!({}) {
            bail!("No arguments expected");
        }
        return recent_operations(&db);
    }
    if !alive(&db) {
        bail!("Account Switcher is not running. Open the desktop app and retry with the same operation_id.");
    }
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM requests WHERE result IS NULL",
        [],
        |r| r.get(0),
    )?;
    if count >= 32 {
        bail!("Agent request queue is full");
    }
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO requests(id,name,args,created) VALUES(?1,?2,?3,?4)",
        params![id, name, args.to_string(), Utc::now().timestamp_millis()],
    )?;
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        let body: Option<String> =
            db.query_row("SELECT result FROM requests WHERE id=?1", [&id], |r| {
                r.get(0)
            })?;
        if let Some(body) = body {
            let value: Value = serde_json::from_str(&body)?;
            if let Some(error) = value["error"].as_str() {
                bail!("{error}");
            }
            return Ok(value["data"].clone());
        }
        if std::time::Instant::now() >= deadline || !alive(&db) {
            bail!("App response unavailable. A mutation may already be queued: check get_operation_status with the original operation_id before retrying.");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn start_worker(app: tauri::AppHandle) -> Result<()> {
    let dir = root()?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("worker.lock"))?;
    if lock.try_lock().is_err() {
        return Ok(());
    } // One owner across multiple GUI processes.
    let db = database()?;
    recover_operations(&db)?;
    db.execute("UPDATE requests SET result=?1 WHERE result IS NULL", [json!({"error":"App restarted; retry reads, inspect mutation status using original operation_id"}).to_string()])?;
    std::thread::Builder::new()
        .name("agent-control".into())
        .spawn(move || {
            let _lock = lock;
            let runtime = tokio::runtime::Runtime::new().expect("Agent control runtime");
            if let Err(error) = runtime.block_on(worker(app)) {
                eprintln!("Agent control stopped: {error}");
            }
        })?;
    Ok(())
}

fn recover_operations(db: &Connection) -> Result<()> {
    db.execute("UPDATE operations SET state='interrupted',error='App restarted before completion. Inspect active account and quota; this operation will not be replayed.',updated=?1 WHERE state IN ('queued','running')", [Utc::now().timestamp_millis()])?;
    Ok(())
}
async fn worker(app: tauri::AppHandle) -> Result<()> {
    let mut db = database()?;
    loop {
        let now = Utc::now().timestamp_millis();
        db.execute("INSERT INTO heartbeat(id,updated) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated",[now])?;
        let requests = {
            let mut stmt = db.prepare(
                "SELECT id,name,args FROM requests WHERE state='queued' AND result IS NULL LIMIT 4",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        for (id, name, args) in requests {
            db.execute("UPDATE requests SET state='running' WHERE id=?1", [&id])?;
            tokio::spawn(async move {
                let result = async {
                    let args: Value = serde_json::from_str(&args)?;
                    if name == "get_quota_options" {
                        quota_options(args).await
                    } else {
                        enqueue(&mut database()?, &name, &args)
                    }
                }
                .await;
                let body = match result {
                    Ok(value) => json!({"data":value}),
                    Err(e) => json!({"error":e.to_string()}),
                };
                if let Ok(db) = database() {
                    let _ = db.execute(
                        "UPDATE requests SET result=?1,state='done' WHERE id=?2",
                        params![body.to_string(), id],
                    );
                }
            });
        }
        let pending: Option<(String,String,String)> = db.query_row("SELECT id,name,args FROM operations WHERE state='queued' AND created<?1 ORDER BY created LIMIT 1",[now-2000],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((id, name, args)) = pending {
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            tx.execute(
                "UPDATE operations SET state='running',updated=?1 WHERE id=?2 AND state='queued'",
                params![now, id],
            )?;
            tx.commit()?;
            let app = app.clone();
            tokio::spawn(async move {
                let result = execute_operation(&id, &name, &args).await;
                if let Ok(db) = database() {
                    let (state, value, error) = match result {
                        Ok(value) => ("completed", Some(value.to_string()), None),
                        Err(e) => (
                            if e.to_string().starts_with("UNCERTAIN:") {
                                "uncertain"
                            } else {
                                "failed"
                            },
                            None,
                            Some(e.to_string()),
                        ),
                    };
                    let _ = db.execute(
                        "UPDATE operations SET state=?1,result=?2,error=?3,updated=?4 WHERE id=?5",
                        params![state, value, error, Utc::now().timestamp_millis(), id],
                    );
                }
                let _ = app.emit("accounts-changed", ());
                let _ = app.emit("agent-operation-completed", json!({"operation_id":id}));
            });
        }
        db.execute(
            "DELETE FROM requests WHERE created<?1 AND result IS NOT NULL",
            [now - 3600000],
        )?;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn quota_options(args: Value) -> Result<Value> {
    use futures::{stream, StreamExt};
    let args: QuotaArgs = serde_json::from_value(args)?;
    if let Some(id) = &args.account_id {
        validate_id(id)?;
    }
    let settings = enabled(&database()?)?;
    if args
        .account_id
        .as_ref()
        .is_some_and(|id| !settings.permits(id))
    {
        bail!("Account is not allowed");
    }
    let store = auth::load_accounts()?;
    let active = store.active_account_id.clone();
    let accounts: Vec<_> = store
        .accounts
        .iter()
        .filter(|a| {
            a.auth_mode == AuthMode::ChatGPT
                && settings.permits(&a.id)
                && args.account_id.as_ref().is_none_or(|id| id == &a.id)
        })
        .cloned()
        .collect();
    if args.account_id.is_some() && accounts.is_empty() {
        bail!("ChatGPT account not found");
    }
    let rows: Vec<Value> = stream::iter(accounts).map(|a| {
        let info = AccountInfo::from_stored(&a,active.as_deref());
        async move {
            let (usage,credits) = tokio::join!(commands::fetch_usage(&a.id), commands::account_stats::get_reset_credits(&a.id));
            json!({"account":info,"usage":usage.as_ref().ok(),"usage_error":usage.as_ref().err(),"reset_credits":credits.as_ref().ok(),"reset_credits_error":credits.as_ref().err().map(|e|e.to_string())})
        }
    }).buffer_unordered(4).collect().await;
    Ok(
        json!({"checked_at":Utc::now().to_rfc3339(),"active_account_id":active,"accounts":rows,"policy":settings}),
    )
}
fn remaining_windows(usage: &UsageInfo) -> Result<Vec<f64>> {
    if usage.error.is_some() {
        bail!("Live quota could not be verified");
    }
    let mut windows = vec![];
    for (used, minutes, reset) in [
        (
            usage.primary_used_percent,
            usage.primary_window_minutes,
            usage.primary_resets_at,
        ),
        (
            usage.secondary_used_percent,
            usage.secondary_window_minutes,
            usage.secondary_resets_at,
        ),
    ] {
        if used.is_none() && minutes.is_none() && reset.is_none() {
            continue;
        }
        let used = used.context("Incomplete quota window")?;
        if !used.is_finite()
            || !(0.0..=100.0).contains(&used)
            || reset.is_none_or(|t| t <= Utc::now().timestamp())
        {
            bail!("Quota window is stale or invalid");
        }
        windows.push(100.0 - used);
    }
    if windows.is_empty() {
        bail!("No verifiable quota windows");
    }
    Ok(windows)
}
async fn execute_operation(id: &str, name: &str, body: &str) -> Result<Value> {
    let _guard = commands::account::SWITCH_SEQUENCE_LOCK.lock().await;
    let settings = enabled(&database()?)?;
    let args: Value = serde_json::from_str(body)?;
    authorize(&settings, name, &args)?;
    match name {
        "switch_and_resume" => {
            let a: SwitchArgs = serde_json::from_value(args)?;
            let target = auth::get_account(&a.account_id)?.context("Account not found")?;
            if target.auth_mode != AuthMode::ChatGPT {
                bail!("Only ChatGPT accounts are supported");
            }
            let usage = commands::fetch_usage(&a.account_id)
                .await
                .map_err(anyhow::Error::msg)?;
            if remaining_windows(&usage)?.iter().any(|r| *r <= 0.0) {
                bail!("Target account has exhausted quota");
            }
            if !settings.allow_interrupt
                && !commands::check_codex_processes()
                    .await
                    .map_err(anyhow::Error::msg)?
                    .can_switch
            {
                bail!("Session interruption is disabled in agent settings");
            }
            // Persist resume preparation inside the companion bridge; never rely on the MCP child's lifetime.
            let outcome = commands::account::coordinated_switch(
                &a.account_id,
                Some(&a.expected_active_account_id),
                true,
            )
            .await
            .map_err(anyhow::Error::msg)?;
            Ok(serde_json::to_value(outcome)?)
        }
        "use_reset" => {
            let a: ResetArgs = serde_json::from_value(args)?;
            let store = auth::load_accounts()?;
            if store.active_account_id.as_deref() != Some(&a.account_id) {
                bail!("Reset spending is limited to the active account. Switch first, then inspect quota again.");
            }
            let usage = commands::fetch_usage(&a.account_id)
                .await
                .map_err(anyhow::Error::msg)?;
            if !remaining_windows(&usage)?
                .iter()
                .any(|r| *r <= settings.reset_max_remaining_percent)
            {
                bail!("Quota is above the configured reset-spending threshold");
            }
            let credits = commands::account_stats::get_reset_credits(&a.account_id).await?;
            let credit = credits
                .credits
                .iter()
                .find(|c| c.id == a.credit_id)
                .context("Reset credit not found on this account")?;
            if credit.status != "available"
                || credit.reset_type != "codex_rate_limits"
                || credit.expires_at.as_ref().is_some_and(|t| {
                    chrono::DateTime::parse_from_rfc3339(t).map_or(true, |d| d <= Utc::now())
                })
            {
                bail!("Reset is not available, has expired, or is not a Codex rate-limit reset");
            }
            // The durable operation UUID is also the backend redemption idempotency key.
            let current_settings = enabled(&database()?)?;
            authorize(&current_settings, name, &serde_json::to_value(&a)?)?;
            if !remaining_windows(&usage)?
                .iter()
                .any(|r| *r <= current_settings.reset_max_remaining_percent)
            {
                bail!("Reset spending threshold changed before redemption");
            }
            let outcome =
                commands::account_stats::consume_reset_credit(&a.account_id, &a.credit_id, id)
                    .await?;
            let refreshed = commands::fetch_usage(&a.account_id).await;
            let credits = commands::account_stats::get_reset_credits(&a.account_id).await;
            Ok(
                json!({"redemption":outcome,"usage":refreshed.as_ref().ok(),"usage_error":refreshed.as_ref().err(),"reset_credits":credits.as_ref().ok(),"reset_credits_error":credits.as_ref().err().map(|e|e.to_string()),"resume_requested":false}),
            )
        }
        _ => bail!("Unknown operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_db() -> Connection {
        database_at(Path::new(":memory:")).unwrap()
    }
    fn allowed(db: &Connection) -> AgentAccess {
        let settings = AgentAccess {
            enabled: true,
            allow_switch: true,
            allow_resets: true,
            ..Default::default()
        };
        db.execute(
            "INSERT INTO settings(id,body) VALUES(1,?1)",
            [serde_json::to_string(&settings).unwrap()],
        )
        .unwrap();
        settings
    }
    fn switch_args() -> Value {
        json!({"account_id":Uuid::new_v4().to_string(),"expected_active_account_id":Uuid::new_v4().to_string(),"operation_id":Uuid::new_v4().to_string()})
    }

    #[test]
    fn duplicate_mutations_return_original_operation_and_reject_conflicting_reuse() {
        let mut db = test_db();
        allowed(&db);
        let args = switch_args();
        let first = enqueue(&mut db, "switch_and_resume", &args).unwrap();
        assert_eq!(first, enqueue(&mut db, "switch_and_resume", &args).unwrap());
        let mut changed = args.clone();
        changed["account_id"] = json!(Uuid::new_v4().to_string());
        assert!(enqueue(&mut db, "switch_and_resume", &changed)
            .unwrap_err()
            .to_string()
            .contains("different request"));
        db.execute("UPDATE operations SET state='completed',result='{}'", [])
            .unwrap();
        assert_eq!(
            enqueue(&mut db, "switch_and_resume", &args).unwrap()["state"],
            "completed"
        );
        assert!(enqueue(&mut db, "switch_and_resume", &switch_args())
            .unwrap_err()
            .to_string()
            .contains("cooldown"));
    }
    #[test]
    fn only_one_pending_mutation_is_accepted() {
        let mut db = test_db();
        allowed(&db);
        enqueue(&mut db, "switch_and_resume", &switch_args()).unwrap();
        assert!(enqueue(&mut db, "switch_and_resume", &switch_args())
            .unwrap_err()
            .to_string()
            .contains("pending"));
    }
    #[test]
    fn permissions_are_enforced_before_queue_and_can_be_revoked() {
        let mut db = test_db();
        assert!(enqueue(&mut db, "switch_and_resume", &switch_args()).is_err());
        let mut settings = allowed(&db);
        let args = switch_args();
        assert!(authorize(&settings, "switch_and_resume", &args).is_ok());
        settings.allow_all_accounts = false;
        assert!(authorize(&settings, "switch_and_resume", &args).is_err());
        settings
            .allowed_account_ids
            .push(args["account_id"].as_str().unwrap().into());
        assert!(authorize(&settings, "switch_and_resume", &args).is_ok());
        settings.enabled = false;
        assert!(authorize(&settings, "switch_and_resume", &args).is_err());
        assert!(authorize(&AgentAccess::default(),"use_reset",&json!({"account_id":Uuid::new_v4().to_string(),"credit_id":"credit","operation_id":Uuid::new_v4().to_string()})).is_err());
    }
    #[test]
    fn restart_preserves_outcomes_without_replaying_incomplete_operations() {
        let dir = std::env::temp_dir().join(format!("switcher-mcp-test-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("journal.sqlite");
        let args = switch_args();
        {
            let mut db = database_at(&path).unwrap();
            allowed(&db);
            enqueue(&mut db, "switch_and_resume", &args).unwrap();
        }
        {
            let mut db = database_at(&path).unwrap();
            recover_operations(&db).unwrap();
            let outcome = enqueue(&mut db, "switch_and_resume", &args).unwrap();
            assert_eq!(outcome["state"], "interrupted");
            assert!(outcome["error"]
                .as_str()
                .unwrap()
                .contains("will not be replayed"));
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn strict_mutation_arguments_prevent_extra_controls_and_invalid_ids() {
        let db = test_db();
        let settings = allowed(&db);
        let mut args = switch_args();
        args["force"] = json!(true);
        assert!(authorize(&settings, "switch_and_resume", &args).is_err());
        args.as_object_mut().unwrap().remove("force");
        args["operation_id"] = json!("../../auth.json");
        assert!(authorize(&settings, "switch_and_resume", &args).is_err());
        assert!(operation(&db, "../../auth.json").is_err());
    }
    #[test]
    fn mcp_lifecycle_and_tool_schemas_do_not_expose_raw_backend_dispatch() {
        let mut initialized = false;
        let call = |id, method: &str, params: Value| json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        assert_eq!(
            handle_rpc(call(1, "tools/list", json!({})), &mut initialized).unwrap()["error"]
                ["code"],
            -32002
        );
        let response = handle_rpc(
            call(2, "initialize", json!({"protocolVersion":PROTOCOL})),
            &mut initialized,
        )
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL);
        assert!(handle_rpc(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            &mut initialized
        )
        .is_none());
        let list = handle_rpc(call(3, "tools/list", json!({})), &mut initialized).unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 5);
        assert_eq!(
            handle_rpc(
                call(
                    4,
                    "tools/call",
                    json!({"name":"export_accounts_full_encrypted_file"})
                ),
                &mut initialized
            )
            .unwrap()["error"]["code"],
            -32602
        );
        assert_eq!(
            handle_rpc(
                json!({"jsonrpc":"2.0","id":true,"method":"ping"}),
                &mut initialized
            )
            .unwrap()["error"]["code"],
            -32600
        );
    }
    #[test]
    fn unknown_or_stale_quota_never_qualifies_for_spending_or_switching() {
        let mut usage = UsageInfo {
            account_id: "account".into(),
            plan_type: None,
            primary_used_percent: Some(95.0),
            primary_window_minutes: Some(300),
            primary_resets_at: Some(Utc::now().timestamp() + 3600),
            secondary_used_percent: None,
            secondary_window_minutes: None,
            secondary_resets_at: None,
            has_credits: None,
            unlimited_credits: None,
            credits_balance: None,
            error: None,
        };
        assert_eq!(remaining_windows(&usage).unwrap(), vec![5.0]);
        usage.secondary_window_minutes = Some(10080);
        assert!(remaining_windows(&usage).is_err());
        usage.secondary_window_minutes = None;
        usage.primary_resets_at = Some(1);
        assert!(remaining_windows(&usage).is_err());
        usage.primary_resets_at = Some(Utc::now().timestamp() + 3600);
        usage.error = Some("unavailable".into());
        assert!(remaining_windows(&usage).is_err());
    }
}
