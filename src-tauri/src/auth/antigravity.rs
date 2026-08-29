//! Antigravity desktop session snapshots.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::get_config_dir;

const AUTH_STATUS_KEY: &str = "antigravityAuthStatus";
const OAUTH_TOKEN_KEY: &str = "antigravityUnifiedStateSync.oauthToken";
const CREDENTIAL_TARGET: &str = "gemini:antigravity";
const CREDENTIAL_USER: &str = "antigravity";
const USER_STATUS_PATH: &str = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

static OPERATION_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone)]
struct AntigravitySessionSnapshot {
    email: Option<String>,
    auth_status: String,
    oauth_token: String,
    credential_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AntigravityAccount {
    id: String,
    name: String,
    email: Option<String>,
    auth_status: String,
    oauth_token: String,
    credential_base64: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AntigravityAccountsStore {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    active_account_id: Option<String>,
    #[serde(default)]
    accounts: Vec<AntigravityAccount>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
pub struct AntigravityAccountInfo {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

impl AntigravityAccountInfo {
    fn from_account(account: &AntigravityAccount, active_id: Option<&str>) -> Self {
        Self {
            id: account.id.clone(),
            name: account.name.clone(),
            email: account.email.clone(),
            is_active: active_id == Some(account.id.as_str()),
            created_at: account.created_at,
            last_used_at: account.last_used_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AntigravityProcessInfo {
    pub count: usize,
    pub can_switch: bool,
    pub process_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KillAntigravityProcessesResult {
    pub targeted_count: usize,
    pub killed_process_names: Vec<String>,
    pub failed_process_names: Vec<String>,
}

pub fn list_antigravity_accounts() -> Result<Vec<AntigravityAccountInfo>> {
    let store = load_store()?;
    let active_id = store.active_account_id.as_deref();
    Ok(store
        .accounts
        .iter()
        .map(|account| AntigravityAccountInfo::from_account(account, active_id))
        .collect())
}

pub fn capture_antigravity_account(name: String) -> Result<AntigravityAccountInfo> {
    with_store(|store| {
        let snapshot = account_from_snapshot(name, read_current_session_snapshot()?);
        if store
            .accounts
            .iter()
            .any(|account| account.name == snapshot.name)
        {
            anyhow::bail!(
                "An Antigravity account named '{}' already exists",
                snapshot.name
            );
        }
        if snapshot.email.as_ref().is_some_and(|email| {
            store
                .accounts
                .iter()
                .any(|account| account.email.as_ref() == Some(email))
        }) {
            anyhow::bail!("This Antigravity account has already been captured");
        }

        let is_first = store.accounts.is_empty();
        store.accounts.push(snapshot.clone());
        if is_first {
            store.active_account_id = Some(snapshot.id.clone());
        }
        Ok(AntigravityAccountInfo::from_account(
            &snapshot,
            store.active_account_id.as_deref(),
        ))
    })
}

pub fn switch_antigravity_account(account_id: &str, force: bool) -> Result<()> {
    let _lock = lock_operations()?;
    if !force {
        ensure_antigravity_not_running()?;
    }

    let mut store = load_store()?;
    if store.active_account_id.as_deref() == Some(account_id) {
        return Ok(());
    }

    let live_snapshot = if store.active_account_id.is_some() {
        Some(
            read_current_session_snapshot()
                .context("Failed to preserve the active Antigravity session before switching")?,
        )
    } else {
        read_current_session_snapshot().ok()
    };

    if let Some(snapshot) = live_snapshot.as_ref() {
        reconcile_active_account_snapshot(&mut store, snapshot)?;
    }

    let target = store
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()
        .context("Antigravity account not found")?;
    validate_account_identity(&target)?;

    // Persist the freshly reconciled active snapshot before overwriting the
    // desktop session. Atomic replacement keeps the previous store intact on error.
    save_store(&store)?;
    let rollback_account = store
        .active_account_id
        .as_deref()
        .and_then(|id| store.accounts.iter().find(|account| account.id == id))
        .cloned()
        .or_else(|| {
            live_snapshot
                .clone()
                .map(|snapshot| account_from_snapshot("rollback".to_string(), snapshot))
        });

    write_session(&target)?;

    store.active_account_id = Some(target.id.clone());
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == account_id)
    {
        account.last_used_at = Some(Utc::now());
    }

    if let Err(save_error) = save_store(&store) {
        let rollback_error = rollback_account
            .as_ref()
            .and_then(|account| write_session(account).err());
        return match rollback_error {
            Some(rollback_error) => Err(anyhow::anyhow!(
                "Failed to save the selected Antigravity account: {save_error:#}. Session rollback also failed: {rollback_error:#}"
            )),
            None => Err(save_error.context(
                "Failed to save the selected Antigravity account; the previous session was restored",
            )),
        };
    }

    Ok(())
}

pub fn check_antigravity_processes() -> Result<AntigravityProcessInfo> {
    let process_names = running_antigravity_processes()?;
    Ok(AntigravityProcessInfo {
        count: process_names.len(),
        can_switch: process_names.is_empty(),
        process_names,
    })
}

pub fn kill_antigravity_processes() -> Result<KillAntigravityProcessesResult> {
    let process_names = running_antigravity_processes()?;
    let targeted_count = process_names.len();
    let mut killed_process_names = Vec::new();
    let mut failed_process_names = Vec::new();

    #[cfg(windows)]
    for process_name in process_names {
        let killed = crate::commands::process::windows_system32_command("taskkill.exe")
            .creation_flags(crate::commands::process::CREATE_NO_WINDOW)
            .args(["/F", "/T", "/IM", &process_name])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if killed {
            killed_process_names.push(process_name);
        } else {
            failed_process_names.push(process_name);
        }
    }

    #[cfg(not(windows))]
    let _ = &process_names;

    Ok(KillAntigravityProcessesResult {
        targeted_count,
        killed_process_names,
        failed_process_names,
    })
}

pub fn delete_antigravity_account(account_id: &str) -> Result<()> {
    with_store(|store| {
        let previous_len = store.accounts.len();
        store.accounts.retain(|account| account.id != account_id);
        if store.accounts.len() == previous_len {
            anyhow::bail!("Antigravity account not found");
        }
        if store.active_account_id.as_deref() == Some(account_id) {
            store.active_account_id = None;
        }
        Ok(())
    })
}

fn with_store<T>(operation: impl FnOnce(&mut AntigravityAccountsStore) -> Result<T>) -> Result<T> {
    let _lock = lock_operations()?;
    let mut store = load_store()?;
    let result = operation(&mut store)?;
    save_store(&store)?;
    Ok(result)
}

fn lock_operations() -> Result<std::sync::MutexGuard<'static, ()>> {
    OPERATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Antigravity account operation lock was poisoned"))
}

fn store_path() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("antigravity-accounts.json"))
}

fn load_store() -> Result<AntigravityAccountsStore> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(AntigravityAccountsStore {
            version: default_version(),
            ..Default::default()
        });
    }
    let contents = fs::read_to_string(&path).with_context(|| {
        format!(
            "Failed to read Antigravity account store: {}",
            path.display()
        )
    })?;
    serde_json::from_str(&contents).context("Failed to parse Antigravity account store")
}

fn save_store(store: &AntigravityAccountsStore) -> Result<()> {
    let path = store_path()?;
    save_store_to_path(store, &path)
}

fn save_store_to_path(store: &AntigravityAccountsStore, path: &Path) -> Result<()> {
    let contents = serde_json::to_vec_pretty(store)?;
    atomic_write_sensitive(path, &contents).with_context(|| {
        format!(
            "Failed to write Antigravity account store: {}",
            path.display()
        )
    })
}

fn atomic_write_sensitive(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("Antigravity account store path has no parent directory")?;
    fs::create_dir_all(parent)?;
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("antigravity-accounts"),
        Uuid::new_v4()
    ));

    let result = (|| -> Result<()> {
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp.write_all(contents)?;
        temp.sync_all()?;
        drop(temp);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))?;
        }

        replace_file(&temp_path, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn replace_file(temp_path: &Path, path: &Path) -> Result<()> {
    if !path.exists() {
        return fs::rename(temp_path, path).context("Failed to install Antigravity account store");
    }

    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let destination = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to atomically replace Antigravity account store");
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(temp_path: &Path, path: &Path) -> Result<()> {
    fs::rename(temp_path, path).context("Failed to atomically replace Antigravity account store")
}

fn read_current_session_snapshot() -> Result<AntigravitySessionSnapshot> {
    let connection = open_state_db()?;
    let auth_status = read_state_value(&connection, AUTH_STATUS_KEY)?;
    let oauth_token = read_state_value(&connection, OAUTH_TOKEN_KEY)?;
    let credential = read_antigravity_credential()?;

    Ok(AntigravitySessionSnapshot {
        email: email_from_auth_status(&auth_status),
        auth_status,
        oauth_token,
        credential_base64: BASE64.encode(credential),
    })
}

fn account_from_snapshot(name: String, snapshot: AntigravitySessionSnapshot) -> AntigravityAccount {
    let display_name = name.trim();
    let name = if display_name.is_empty() {
        snapshot
            .email
            .clone()
            .unwrap_or_else(|| "Antigravity account".to_string())
    } else {
        display_name.to_string()
    };

    AntigravityAccount {
        id: Uuid::new_v4().to_string(),
        name,
        email: snapshot.email,
        auth_status: snapshot.auth_status,
        oauth_token: snapshot.oauth_token,
        credential_base64: snapshot.credential_base64,
        created_at: Utc::now(),
        last_used_at: None,
    }
}

fn email_from_auth_status(auth_status: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(auth_status)
        .ok()
        .and_then(|value| value.get("email")?.as_str().map(str::to_owned))
        .map(|email| email.trim().to_lowercase())
        .filter(|email| !email.is_empty())
}

fn validate_account_identity(account: &AntigravityAccount) -> Result<()> {
    let snapshot_email = email_from_auth_status(&account.auth_status);
    ensure_identity_matches(
        account.email.as_deref(),
        snapshot_email.as_deref(),
        &account.name,
    )
}

fn ensure_identity_matches(
    expected_email: Option<&str>,
    actual_email: Option<&str>,
    account_name: &str,
) -> Result<()> {
    let normalize = |email: &str| email.trim().to_lowercase();
    if let (Some(expected), Some(actual)) = (expected_email, actual_email) {
        if normalize(expected) != normalize(actual) {
            anyhow::bail!(
                "Antigravity session identity mismatch for '{account_name}': expected {expected}, found {actual}"
            );
        }
    }
    Ok(())
}

fn reconcile_active_account_snapshot(
    store: &mut AntigravityAccountsStore,
    snapshot: &AntigravitySessionSnapshot,
) -> Result<()> {
    let Some(active_id) = store.active_account_id.as_deref() else {
        return Ok(());
    };
    let active = store
        .accounts
        .iter_mut()
        .find(|account| account.id == active_id)
        .context("Stored active Antigravity account was not found")?;

    ensure_identity_matches(active.email.as_deref(), snapshot.email.as_deref(), &active.name)
        .context(
            "The live Antigravity session does not match the stored active account; capture the live session separately before switching",
        )?;
    if active.email.is_none() {
        active.email.clone_from(&snapshot.email);
    }
    active.auth_status.clone_from(&snapshot.auth_status);
    active.oauth_token.clone_from(&snapshot.oauth_token);
    active
        .credential_base64
        .clone_from(&snapshot.credential_base64);
    Ok(())
}

fn write_session(account: &AntigravityAccount) -> Result<()> {
    validate_account_identity(account)?;
    let mut connection = open_state_db()?;
    write_session_with(
        &mut connection,
        account,
        read_antigravity_credential,
        write_antigravity_credential,
    )
}

fn write_session_with(
    connection: &mut Connection,
    account: &AntigravityAccount,
    read_credential: impl FnOnce() -> Result<Vec<u8>>,
    mut write_credential: impl FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    let credential = BASE64
        .decode(&account.credential_base64)
        .context("Stored Antigravity credential is invalid")?;
    let previous_credential = read_credential()?;
    let transaction = connection.transaction()?;
    write_state_value(&transaction, AUTH_STATUS_KEY, &account.auth_status)?;
    write_state_value(&transaction, OAUTH_TOKEN_KEY, &account.oauth_token)?;
    write_credential(&credential).context(
        "Failed to update the Antigravity credential; database changes were rolled back",
    )?;

    if let Err(commit_error) = transaction.commit() {
        let rollback_error = write_credential(&previous_credential).err();
        return match rollback_error {
            Some(rollback_error) => Err(anyhow::anyhow!(
                "Failed to commit the Antigravity session database: {commit_error}. Credential rollback also failed: {rollback_error:#}"
            )),
            None => Err(commit_error).context(
                "Failed to commit the Antigravity session database; the previous credential was restored",
            ),
        };
    }
    Ok(())
}

fn open_state_db() -> Result<Connection> {
    let path = antigravity_profile_dir()?
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    if !path.exists() {
        anyhow::bail!(
            "Antigravity desktop profile was not found at {}",
            path.display()
        );
    }
    Connection::open(path).context("Failed to open Antigravity desktop state database")
}

fn antigravity_profile_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let app_data = std::env::var_os("APPDATA").context("APPDATA is not set")?;
        return Ok(PathBuf::from(app_data).join("Antigravity"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().context("Could not find home directory")?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("Antigravity"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let config_dir = dirs::config_dir().context("Could not find config directory")?;
        return Ok(config_dir.join("Antigravity"));
    }
}

fn read_state_value(connection: &Connection, key: &str) -> Result<String> {
    connection
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?
        .with_context(|| format!("Antigravity session field '{key}' was not found"))
}

fn write_state_value(connection: &Connection, key: &str, value: &str) -> Result<()> {
    connection.execute(
        "INSERT INTO ItemTable (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(windows)]
fn read_antigravity_credential() -> Result<Vec<u8>> {
    use std::{ptr, slice};
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = wide_null(CREDENTIAL_TARGET);
    let mut credential: *mut CREDENTIALW = ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to read the Antigravity credential from Windows Credential Manager");
    }

    let value = unsafe {
        let credential = &*credential;
        slice::from_raw_parts(
            credential.CredentialBlob as *const u8,
            credential.CredentialBlobSize as usize,
        )
        .to_vec()
    };
    unsafe { CredFree(credential.cast()) };
    Ok(value)
}

#[cfg(windows)]
fn write_antigravity_credential(value: &[u8]) -> Result<()> {
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let mut target = wide_null(CREDENTIAL_TARGET);
    let mut user = wide_null(CREDENTIAL_USER);
    let mut blob = value.to_vec();
    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target.as_mut_ptr();
    credential.CredentialBlobSize = blob
        .len()
        .try_into()
        .context("Antigravity credential is too large")?;
    credential.CredentialBlob = blob.as_mut_ptr();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = user.as_mut_ptr();

    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to write the Antigravity credential to Windows Credential Manager");
    }
    Ok(())
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(not(windows))]
fn read_antigravity_credential() -> Result<Vec<u8>> {
    anyhow::bail!("Antigravity credential capture is currently supported on Windows only")
}

#[cfg(not(windows))]
fn write_antigravity_credential(_value: &[u8]) -> Result<()> {
    anyhow::bail!("Antigravity credential switching is currently supported on Windows only")
}

fn ensure_antigravity_not_running() -> Result<()> {
    let running = running_antigravity_processes()?;
    if !running.is_empty() {
        anyhow::bail!(
            "Quit {} before switching the Antigravity account",
            running.join(" and ")
        );
    }
    Ok(())
}

fn running_antigravity_processes() -> Result<Vec<String>> {
    #[cfg(windows)]
    {
        let mut running = Vec::new();
        for executable in ["Antigravity IDE.exe", "Antigravity.exe", "agy.exe"] {
            let output = crate::commands::process::windows_system32_command("tasklist.exe")
                .creation_flags(crate::commands::process::CREATE_NO_WINDOW)
                .args([
                    "/FI",
                    &format!("IMAGENAME eq {executable}"),
                    "/FO",
                    "CSV",
                    "/NH",
                ])
                .output()
                .context("Failed to check for running Antigravity processes")?;
            if String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.trim_start().starts_with('"'))
            {
                running.push(executable.to_string());
            }
        }
        return Ok(running);
    }

    #[cfg(not(windows))]
    Ok(Vec::new())
}

#[derive(Debug, Clone, Serialize)]
pub struct AntigravityModelUsage {
    pub label: String,
    pub model_id: String,
    pub remaining_percent: f64,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AntigravityUsageInfo {
    pub plan_name: Option<String>,
    pub prompt_credits_available: Option<f64>,
    pub prompt_credits_monthly: Option<f64>,
    pub flow_credits_available: Option<f64>,
    pub flow_credits_monthly: Option<f64>,
    pub models: Vec<AntigravityModelUsage>,
}

/// Read live quota data from the running Antigravity desktop language server.
pub async fn get_live_antigravity_usage() -> Result<AntigravityUsageInfo> {
    let servers = discover_language_servers()?;
    let body = serde_json::json!({ "wrapper_data": {} });
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .context("Failed to create Antigravity quota client")?;
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("connect-protocol-version"),
        HeaderValue::from_static("1"),
    );

    let mut last_error = None;
    for (ports, csrf_token) in servers {
        headers.insert(
            HeaderName::from_static("x-codeium-csrf-token"),
            HeaderValue::from_str(&csrf_token).context("Invalid Antigravity CSRF token")?,
        );
        for port in ports {
            for scheme in ["https", "http"] {
                let url = format!("{scheme}://127.0.0.1:{port}{USER_STATUS_PATH}");
                match client
                    .post(&url)
                    .headers(headers.clone())
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => {
                        let value = response
                            .json::<serde_json::Value>()
                            .await
                            .context("Failed to parse Antigravity quota response")?;
                        return parse_live_usage(&value);
                    }
                    Ok(response) => {
                        last_error = Some(anyhow::anyhow!(
                            "Antigravity quota server returned {}",
                            response.status()
                        ));
                    }
                    Err(error) => last_error = Some(error.into()),
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Antigravity quota server is unavailable")))
}

fn parse_live_usage(value: &serde_json::Value) -> Result<AntigravityUsageInfo> {
    let status = value
        .get("userStatus")
        .context("Antigravity quota response did not include userStatus")?;
    let plan_status = status.get("planStatus");
    let plan_info = plan_status.and_then(|plan| plan.get("planInfo"));
    let models = status
        .pointer("/cascadeModelConfigData/clientModelConfigs")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let quota = item.get("quotaInfo")?;
                    let fraction = quota.get("remainingFraction")?.as_f64()?;
                    Some(AntigravityModelUsage {
                        label: item
                            .get("label")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Unknown model")
                            .to_string(),
                        model_id: item
                            .pointer("/modelOrAlias/model")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        remaining_percent: (fraction * 100.0).clamp(0.0, 100.0),
                        reset_at: quota
                            .get("resetTime")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(AntigravityUsageInfo {
        plan_name: plan_info
            .and_then(|plan| plan.get("planName"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        prompt_credits_available: number_at(plan_status, "availablePromptCredits"),
        prompt_credits_monthly: number_at(plan_info, "monthlyPromptCredits"),
        flow_credits_available: number_at(plan_status, "availableFlowCredits"),
        flow_credits_monthly: number_at(plan_info, "monthlyFlowCredits"),
        models,
    })
}

fn number_at(value: Option<&serde_json::Value>, key: &str) -> Option<f64> {
    value
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct LanguageServerProcess {
    command_line: String,
    ports: Vec<u16>,
}

#[cfg(windows)]
fn discover_language_servers() -> Result<Vec<(Vec<u16>, String)>> {
    let output = crate::commands::process::windows_powershell_command()
        .creation_flags(crate::commands::process::CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$servers = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--extension_server_port' -and $_.CommandLine -match '--app_data_dir(?:=|\\s+)antigravity(?:-ide)?' }; $servers | ForEach-Object { [PSCustomObject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; Ports = @(Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) } } | ConvertTo-Json -Compress",
        ])
        .output()
        .context("Failed to inspect Antigravity language-server processes")?;
    let output = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value =
        serde_json::from_str(&output).context("Open Antigravity desktop to retrieve live usage")?;
    let processes: Vec<LanguageServerProcess> = match value {
        serde_json::Value::Array(_) => serde_json::from_value(value)?,
        serde_json::Value::Object(_) => vec![serde_json::from_value(value)?],
        _ => Vec::new(),
    };
    let servers = processes
        .into_iter()
        .filter_map(|process| {
            let csrf_token = process
                .command_line
                .split("--csrf_token")
                .nth(1)
                .and_then(parse_argument_value)?;
            let mut ports = process.ports;
            if let Some(port) = process
                .command_line
                .split("--extension_server_port")
                .nth(1)
                .and_then(parse_argument_value)
                .and_then(|value| value.parse().ok())
            {
                ports.push(port);
            }
            ports.retain(|port| *port != 0);
            ports.sort_unstable();
            ports.dedup();
            (!ports.is_empty()).then_some((ports, csrf_token))
        })
        .collect::<Vec<_>>();
    if servers.is_empty() {
        anyhow::bail!("Open Antigravity desktop to retrieve live usage");
    }
    Ok(servers)
}

#[cfg(windows)]
fn parse_argument_value(value: &str) -> Option<String> {
    value
        .trim_start()
        .strip_prefix('=')
        .unwrap_or(value.trim_start())
        .split_whitespace()
        .next()
        .map(|value| value.trim_matches(['\'', '"']).to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(windows))]
fn discover_language_servers() -> Result<Vec<(Vec<u16>, String)>> {
    anyhow::bail!("Live Antigravity usage is currently supported on Windows only")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn snapshot(email: Option<&str>, suffix: &str) -> AntigravitySessionSnapshot {
        AntigravitySessionSnapshot {
            email: email.map(str::to_string),
            auth_status: email
                .map(|email| serde_json::json!({ "email": email }).to_string())
                .unwrap_or_else(|| "{}".to_string()),
            oauth_token: format!("oauth-{suffix}"),
            credential_base64: BASE64.encode(format!("credential-{suffix}")),
        }
    }

    fn account(email: Option<&str>, suffix: &str) -> AntigravityAccount {
        let mut account =
            account_from_snapshot(format!("Account {suffix}"), snapshot(email, suffix));
        account.id = format!("account-{suffix}");
        account
    }

    fn state_database(auth_status: &str, oauth_token: &str) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute(
                "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
        write_state_value(&connection, AUTH_STATUS_KEY, auth_status).unwrap();
        write_state_value(&connection, OAUTH_TOKEN_KEY, oauth_token).unwrap();
        connection
    }

    #[test]
    fn identity_matching_is_case_insensitive_but_rejects_other_accounts() {
        ensure_identity_matches(
            Some(" Person@Example.com "),
            Some("person@example.com"),
            "Personal",
        )
        .unwrap();

        let error = ensure_identity_matches(
            Some("person@example.com"),
            Some("other@example.com"),
            "Personal",
        )
        .unwrap_err();
        assert!(error.to_string().contains("identity mismatch"));
    }

    #[test]
    fn active_snapshot_reconciliation_preserves_new_live_credentials() {
        let stored = account(Some("person@example.com"), "old");
        let active_id = stored.id.clone();
        let mut store = AntigravityAccountsStore {
            version: 1,
            active_account_id: Some(active_id),
            accounts: vec![stored],
        };
        let live = snapshot(Some("PERSON@example.com"), "new");

        reconcile_active_account_snapshot(&mut store, &live).unwrap();

        let updated = &store.accounts[0];
        assert_eq!(updated.oauth_token, "oauth-new");
        assert_eq!(
            BASE64.decode(&updated.credential_base64).unwrap(),
            b"credential-new"
        );
    }

    #[test]
    fn active_snapshot_reconciliation_rejects_mismatched_identity_without_mutating() {
        let stored = account(Some("person@example.com"), "old");
        let active_id = stored.id.clone();
        let mut store = AntigravityAccountsStore {
            version: 1,
            active_account_id: Some(active_id),
            accounts: vec![stored],
        };
        let live = snapshot(Some("other@example.com"), "new");

        assert!(reconcile_active_account_snapshot(&mut store, &live).is_err());
        assert_eq!(store.accounts[0].oauth_token, "oauth-old");
        assert_eq!(
            BASE64.decode(&store.accounts[0].credential_base64).unwrap(),
            b"credential-old"
        );
    }

    #[test]
    fn failed_credential_write_rolls_back_database_transaction() {
        let mut connection = state_database("old-auth", "old-oauth");
        let target = account(Some("person@example.com"), "new");
        let attempted_credentials = RefCell::new(Vec::new());

        let result = write_session_with(
            &mut connection,
            &target,
            || Ok(b"credential-old".to_vec()),
            |credential| {
                attempted_credentials.borrow_mut().push(credential.to_vec());
                anyhow::bail!("simulated credential failure")
            },
        );

        assert!(result.is_err());
        assert_eq!(
            read_state_value(&connection, AUTH_STATUS_KEY).unwrap(),
            "old-auth"
        );
        assert_eq!(
            read_state_value(&connection, OAUTH_TOKEN_KEY).unwrap(),
            "old-oauth"
        );
        assert_eq!(attempted_credentials.borrow().len(), 1);
    }

    #[test]
    fn successful_session_write_updates_database_and_credential_together() {
        let mut connection = state_database("old-auth", "old-oauth");
        let target = account(Some("person@example.com"), "new");
        let written_credential = RefCell::new(Vec::new());

        write_session_with(
            &mut connection,
            &target,
            || Ok(b"credential-old".to_vec()),
            |credential| {
                written_credential.replace(credential.to_vec());
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            read_state_value(&connection, AUTH_STATUS_KEY).unwrap(),
            target.auth_status
        );
        assert_eq!(
            read_state_value(&connection, OAUTH_TOKEN_KEY).unwrap(),
            "oauth-new"
        );
        assert_eq!(&*written_credential.borrow(), b"credential-new");
    }

    #[test]
    fn atomic_store_replacement_always_leaves_valid_json() {
        let directory = std::env::temp_dir().join(format!(
            "codex-switcher-antigravity-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("accounts.json");
        let mut store = AntigravityAccountsStore {
            version: 1,
            active_account_id: None,
            accounts: vec![account(Some("first@example.com"), "first")],
        };

        save_store_to_path(&store, &path).unwrap();
        store.accounts = vec![account(Some("second@example.com"), "second")];
        save_store_to_path(&store, &path).unwrap();

        let parsed: AntigravityAccountsStore =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed.accounts.len(), 1);
        assert_eq!(
            parsed.accounts[0].email.as_deref(),
            Some("second@example.com")
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
