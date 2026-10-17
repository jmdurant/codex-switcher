//! Claude Code subscription logins. Only the OAuth login and account metadata
//! are switched; MCP credentials, settings, projects and history stay in place.
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Duration,
};

use super::{atomic::write_private, operation::lock_file};

#[derive(Clone)]
pub(crate) struct ClaudePaths {
    pub config: PathBuf,
    pub metadata: PathBuf,
    pub data: PathBuf,
    pub keychain_service: String,
}

impl ClaudePaths {
    pub fn current() -> Result<Self> {
        anyhow::ensure!(std::env::var_os("CLAUDE_SECURESTORAGE_CONFIG_DIR").is_none(),
            "Claude Code uses a separate secure-storage directory. Start the switcher without CLAUDE_SECURESTORAGE_CONFIG_DIR to manage standard logins.");
        let home = dirs::home_dir().context("Could not find home directory")?;
        Self::resolve(
            &home,
            std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
            &super::get_config_dir()?,
        )
    }

    fn resolve(home: &Path, custom: Option<&str>, root: &Path) -> Result<Self> {
        let config = custom
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        anyhow::ensure!(
            config.is_absolute(),
            "CLAUDE_CONFIG_DIR must be an absolute path"
        );
        let metadata = if config.join(".config.json").is_file() {
            config.join(".config.json")
        } else {
            custom.map_or_else(
                || home.join(".claude.json"),
                |_| config.join(".claude.json"),
            )
        };
        let keychain_service = match custom {
            Some(value) => format!("Claude Code-credentials-{}", &hash(value)[..8]),
            None => "Claude Code-credentials".into(),
        };
        let scope = hash(&format!(
            "{}\n{}\n{}",
            config.display(),
            metadata.display(),
            keychain_service
        ));
        Ok(Self {
            config,
            metadata,
            data: root.join("claude").join(scope),
            keychain_service,
        })
    }

    pub(crate) fn lock(&self) -> Result<(fs::File, fs::File)> {
        // Also coordinate configurations that share the credential directory
        // through an alias, or use different metadata locations.
        let credential_lock = lock_file(&self.config.join(".account-switcher.lock"))?;
        let store_lock = lock_file(&self.data.join("operation.lock"))?;
        Ok((credential_lock, store_lock))
    }
}

pub(crate) fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(crate) fn read_json(path: &Path) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)
                .with_context(|| format!("Invalid JSON in {}", path.display()))?;
            anyhow::ensure!(
                value.is_object(),
                "Expected a JSON object in {}",
                path.display()
            );
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error).with_context(|| format!("Could not read {}", path.display())),
    }
}

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_private(path, &serde_json::to_vec_pretty(value)?)
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct Login {
    oauth: Value,
    account: Value,
}

impl Login {
    fn identity(&self) -> Option<String> {
        identity(&self.account)
    }
    fn validate(&self) -> Result<()> {
        anyhow::ensure!(self.identity().is_some(), "Claude Code account metadata is missing. Run claude auth login, quit Claude Code, then capture again.");
        anyhow::ensure!(self.oauth.get("accessToken").and_then(Value::as_str).is_some_and(|s| !s.is_empty()),
            "No Claude Code subscription login found. Run claude auth login, quit Claude Code, then capture again.");
        Ok(())
    }
}

pub(crate) fn identity(account: &Value) -> Option<String> {
    let user = account
        .get("accountUuid")?
        .as_str()
        .filter(|v| !v.is_empty())?;
    let org = account
        .get("organizationUuid")?
        .as_str()
        .filter(|v| !v.is_empty())?;
    Some(format!("{user}:{org}"))
}

#[derive(Clone, Serialize, Deserialize)]
struct Account {
    id: String,
    name: String,
    login: Login,
    created_at: String,
    last_used_at: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    selected: Option<String>,
    #[serde(default)]
    accounts: Vec<Account>,
}

#[derive(Serialize)]
pub struct ClaudeAccountInfo {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub is_selected: bool,
    pub matches_login: bool,
    pub needs_login: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Serialize)]
pub struct ClaudeState {
    pub accounts: Vec<ClaudeAccountInfo>,
    pub current_email: Option<String>,
    pub config_directory: String,
    pub warning: Option<String>,
    pub usage_tracking_enabled: bool,
    pub usage: Option<super::claude_usage::ClaudeUsage>,
}

fn load_store(paths: &ClaudePaths) -> Result<Store> {
    serde_json::from_value(read_json(&paths.data.join("accounts.json"))?)
        .context("Invalid Claude account store")
}

fn save_store(paths: &ClaudePaths, store: &Store) -> Result<()> {
    write_json(&paths.data.join("accounts.json"), store)
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
enum CredentialBackend {
    File,
    Keychain,
}

#[cfg(target_os = "macos")]
fn keychain_user() -> Result<String> {
    if let Ok(user) = std::env::var("USER") {
        if !user.is_empty() {
            return Ok(user);
        }
    }
    let output = run_command(Command::new("/usr/bin/id").arg("-un"), 5)?;
    anyhow::ensure!(
        output.status.success(),
        "Could not determine the Keychain account"
    );
    Ok(String::from_utf8(output.stdout)?.trim().into())
}

fn credentials(paths: &ClaudePaths) -> Result<(CredentialBackend, Value)> {
    #[cfg(target_os = "macos")]
    {
        match security_framework::passwords::get_generic_password(
            &paths.keychain_service,
            &keychain_user()?,
        ) {
            Ok(bytes) => {
                let value: Value =
                    serde_json::from_slice(&bytes).context("Invalid Claude Code Keychain entry")?;
                anyhow::ensure!(value.is_object(), "Invalid Claude Code Keychain entry");
                return Ok((CredentialBackend::Keychain, value));
            }
            Err(error) if error.code() == -25300 => {} // item not found: official file fallback
            Err(_) => anyhow::bail!(
                "Could not read the Claude Code Keychain entry. Unlock Keychain and allow access."
            ),
        }
    }
    Ok((
        CredentialBackend::File,
        read_json(&paths.config.join(".credentials.json"))?,
    ))
}

fn put_credentials(paths: &ClaudePaths, backend: &CredentialBackend, value: &Value) -> Result<()> {
    match backend {
        CredentialBackend::File => write_json(&paths.config.join(".credentials.json"), value),
        CredentialBackend::Keychain => {
            #[cfg(target_os = "macos")]
            {
                security_framework::passwords::set_generic_password(
                    &paths.keychain_service,
                    &keychain_user()?,
                    &serde_json::to_vec(value)?,
                )
                .context("Could not update the Claude Code Keychain entry")
            }
            #[cfg(not(target_os = "macos"))]
            {
                anyhow::bail!("This Claude snapshot requires macOS Keychain")
            }
        }
    }
}

fn read_login(paths: &ClaudePaths) -> Result<(CredentialBackend, Login)> {
    let (backend, value) = credentials(paths)?;
    let metadata = read_json(&paths.metadata)?;
    Ok((
        backend,
        Login {
            oauth: value.get("claudeAiOauth").cloned().unwrap_or(Value::Null),
            account: metadata.get("oauthAccount").cloned().unwrap_or(Value::Null),
        },
    ))
}

fn replace_field(document: &mut Value, field: &str, value: &Value) {
    if value.is_null() {
        document.as_object_mut().unwrap().remove(field);
    } else {
        document[field] = value.clone();
    }
}

fn replace_oauth(
    paths: &ClaudePaths,
    backend: &CredentialBackend,
    expected: &Value,
    target: &Value,
) -> Result<()> {
    let (actual_backend, mut document) = credentials(paths)?;
    anyhow::ensure!(
        &actual_backend == backend,
        "Claude credential storage changed; capture the current login before switching"
    );
    anyhow::ensure!(
        document.get("claudeAiOauth").unwrap_or(&Value::Null) == expected,
        "Claude credentials changed during the operation; the newer login was preserved"
    );
    replace_field(&mut document, "claudeAiOauth", target);
    put_credentials(paths, backend, &document)
}

fn replace_account(paths: &ClaudePaths, expected: &Value, target: &Value) -> Result<()> {
    let mut document = read_json(&paths.metadata)?;
    anyhow::ensure!(
        document.get("oauthAccount").unwrap_or(&Value::Null) == expected,
        "Claude account metadata changed during the operation; the newer login was preserved"
    );
    replace_field(&mut document, "oauthAccount", target);
    // These values describe a particular login; Claude repopulates them. Keep
    // project trust, preferences, MCP servers and all other fields untouched.
    for key in [
        "cachedExtraUsageDisabledReason",
        "modelAccessCache",
        "orgModelDefaultCache",
        "additionalModelOptionsCache",
        "additionalModelCostsCache",
        "s1mAccessCache",
        "groveConfigCache",
        "metricsStatusCache",
        "penguinModeOrgEnabled",
    ] {
        document.as_object_mut().unwrap().remove(key);
    }
    write_json(&paths.metadata, &document)
}

#[derive(Serialize, Deserialize)]
struct PendingSwitch {
    target_id: String,
    backend: CredentialBackend,
    before: Login,
    after: Login,
}

fn recover(paths: &ClaudePaths, store: &Store) -> Result<()> {
    let path = paths.data.join("pending-switch.json");
    if !path.try_exists()? {
        return Ok(());
    }
    let pending: PendingSwitch =
        serde_json::from_value(read_json(&path)?).context("Invalid pending Claude switch")?;
    let (backend, live) = read_login(paths)?;
    anyhow::ensure!(
        backend == pending.backend,
        "Claude credential storage changed during a pending switch"
    );
    if store.selected.as_deref() == Some(&pending.target_id) && live == pending.after {
        fs::remove_file(path)?;
        return Ok(());
    }
    anyhow::ensure!((live.oauth == pending.before.oauth || live.oauth == pending.after.oauth)
        && (live.account == pending.before.account || live.account == pending.after.account),
        "Claude login changed after an interrupted switch. The newer login was preserved; use Capture Session to keep it and clear the pending switch.");
    replace_oauth(paths, &backend, &live.oauth, &pending.before.oauth)?;
    replace_account(paths, &live.account, &pending.before.account)?;
    fs::remove_file(path)?;
    Ok(())
}

fn needs_login(login: &Login, now: i64) -> bool {
    let refresh = login
        .oauth
        .get("refreshToken")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty());
    let refresh_expired = login
        .oauth
        .get("refreshTokenExpiresAt")
        .and_then(Value::as_i64)
        .is_some_and(|v| v <= now);
    let access_expired = login
        .oauth
        .get("expiresAt")
        .and_then(Value::as_i64)
        .is_none_or(|v| v <= now);
    access_expired && (!refresh || refresh_expired)
}

fn override_warning(paths: &ClaudePaths) -> Result<Option<String>> {
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_PROFILE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_HOST_CREDS_FILE",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_OAUTH_CLIENT_ID",
        "CLAUDE_CODE_CUSTOM_OAUTH_URL",
        "CLAUDE_CODE_USE_ANTHROPIC_PROFILE",
    ] {
        if std::env::var(key).is_ok_and(|v| !v.is_empty() && v != "0" && v != "false") {
            return Ok(Some(format!("{key} overrides Claude authentication. Subscription switching is disabled in this environment.")));
        }
    }
    let settings = read_json(&paths.config.join("settings.json"))?;
    if read_json(&paths.metadata)?
        .get("primaryApiKey")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return Ok(Some("Claude has a saved Console API key. Sign in to a Claude subscription before capturing or switching subscription accounts.".into()));
    }
    if settings.get("apiKeyHelper").is_some_and(|v| !v.is_null())
        || settings
            .get("forceLoginMethod")
            .and_then(Value::as_str)
            .is_some_and(|v| v != "claudeai")
    {
        return Ok(Some("Claude settings select a different authentication method. Subscription switching is disabled.".into()));
    }
    if settings
        .get("env")
        .and_then(Value::as_object)
        .is_some_and(|env| {
            env.keys().any(|key| {
                key.starts_with("ANTHROPIC_")
                    || key.starts_with("CLAUDE_CODE_OAUTH")
                    || key.starts_with("CLAUDE_CODE_USE_")
            })
        })
    {
        return Ok(Some("Claude settings contain authentication overrides. Review them before switching subscriptions.".into()));
    }
    Ok(None)
}

pub fn state() -> Result<ClaudeState> {
    let paths = ClaudePaths::current()?;
    let _guard = paths.lock()?;
    let store = load_store(&paths)?;
    let mut warning = override_warning(&paths)?;
    let live = match read_login(&paths) {
        Ok((_, login)) => Some(login),
        Err(error) => {
            warning = Some(error.to_string());
            None
        }
    };
    if paths.data.join("pending-switch.json").try_exists()? {
        warning = Some("A Claude switch was interrupted. Quit Claude Code and retry switching, or capture the current login to keep it.".into());
    }
    let current_identity = live.as_ref().and_then(Login::identity);
    if warning.is_none()
        && store
            .selected
            .as_ref()
            .and_then(|id| store.accounts.iter().find(|a| &a.id == id))
            .is_some_and(|account| account.login.identity() != current_identity)
    {
        warning = Some("The saved Claude login differs from the selected account. Capture Session to save the current login before switching.".into());
    }
    let accounts = store
        .accounts
        .iter()
        .map(|account| ClaudeAccountInfo {
            id: account.id.clone(),
            name: account.name.clone(),
            email: account
                .login
                .account
                .get("emailAddress")
                .and_then(Value::as_str)
                .map(str::to_owned),
            plan: account
                .login
                .oauth
                .get("subscriptionType")
                .and_then(Value::as_str)
                .map(str::to_owned),
            is_selected: store.selected.as_deref() == Some(&account.id),
            matches_login: current_identity.is_some()
                && current_identity == account.login.identity()
                && live.as_ref().is_some_and(|v| v.validate().is_ok()),
            needs_login: needs_login(
                live.as_ref()
                    .filter(|v| v.identity().is_some() && v.identity() == account.login.identity())
                    .unwrap_or(&account.login),
                Utc::now().timestamp_millis(),
            ),
            created_at: account.created_at.clone(),
            last_used_at: account.last_used_at.clone(),
        })
        .collect();
    let usage = super::claude_usage::read_usage(&paths, current_identity.as_deref())?;
    Ok(ClaudeState {
        accounts,
        current_email: live.and_then(|v| {
            v.account
                .get("emailAddress")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }),
        config_directory: paths.config.display().to_string(),
        warning,
        usage_tracking_enabled: super::claude_usage::enabled(&paths)?,
        usage,
    })
}

pub fn capture(name: String) -> Result<()> {
    let paths = ClaudePaths::current()?;
    let _guard = paths.lock()?;
    if let Some(warning) = override_warning(&paths)? {
        anyhow::bail!(warning);
    }
    ensure_stopped()?;
    let mut store = load_store(&paths)?;
    let (_, live) = read_login(&paths)?;
    live.validate()?;
    // An explicit capture adopts an external login. A partial pending switch
    // must first be rolled back, rather than capturing mismatched credentials.
    let pending = paths.data.join("pending-switch.json");
    if pending.try_exists()? {
        let transaction: PendingSwitch = serde_json::from_value(read_json(&pending)?)?;
        if live.oauth == transaction.before.oauth || live.oauth == transaction.after.oauth {
            recover(&paths, &store)?;
        }
    }
    let (_, live) = read_login(&paths)?;
    live.validate()?;
    let identity = live.identity();
    let name = name.trim();
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|v| v.login.identity() == identity)
    {
        account.login = live;
        if !name.is_empty() {
            account.name = name.into();
        }
        store.selected = Some(account.id.clone());
    } else {
        let name = if name.is_empty() {
            live.account
                .get("emailAddress")
                .and_then(Value::as_str)
                .unwrap_or("Claude account")
        } else {
            name
        }
        .to_owned();
        let id = uuid::Uuid::new_v4().to_string();
        store.accounts.push(Account {
            id: id.clone(),
            name,
            login: live,
            created_at: Utc::now().to_rfc3339(),
            last_used_at: None,
        });
        store.selected = Some(id);
    }
    save_store(&paths, &store)?;
    if pending.try_exists()? {
        fs::remove_file(pending)?;
    }
    Ok(())
}

pub fn switch(account_id: &str) -> Result<()> {
    let paths = ClaudePaths::current()?;
    let _guard = paths.lock()?;
    if let Some(warning) = override_warning(&paths)? {
        anyhow::bail!(warning);
    }
    ensure_stopped()?;
    let mut store = load_store(&paths)?;
    recover(&paths, &store)?;
    switch_with(&paths, &mut store, account_id, save_store)
}

fn switch_with(
    paths: &ClaudePaths,
    store: &mut Store,
    account_id: &str,
    commit: impl FnOnce(&ClaudePaths, &Store) -> Result<()>,
) -> Result<()> {
    let (backend, before) = read_login(paths)?;
    // Preserve refreshed credentials by actual identity, even after an external login.
    if before.validate().is_ok() {
        if let Some(account) = store
            .accounts
            .iter_mut()
            .find(|v| v.login.identity() == before.identity())
        {
            account.login = before.clone();
        } else {
            anyhow::bail!("The current Claude login has not been captured. Capture Session before switching so it can be restored later.");
        }
    } else {
        anyhow::ensure!(before.oauth.is_null() && before.account.is_null(), "Claude credentials and account metadata are incomplete. Sign in and capture the current session before switching.");
    }
    let target = store
        .accounts
        .iter()
        .find(|v| v.id == account_id)
        .context("Claude account not found")?
        .clone();
    target.login.validate()?;
    anyhow::ensure!(
        !needs_login(&target.login, Utc::now().timestamp_millis()),
        "This saved Claude login has expired. Sign in with claude auth login and capture it again."
    );
    save_store(paths, store)?;
    let pending = PendingSwitch {
        target_id: target.id.clone(),
        backend,
        before,
        after: target.login,
    };
    write_json(&paths.data.join("pending-switch.json"), &pending)?;
    let result = (|| {
        replace_oauth(
            paths,
            &pending.backend,
            &pending.before.oauth,
            &pending.after.oauth,
        )?;
        replace_account(paths, &pending.before.account, &pending.after.account)?;
        anyhow::ensure!(
            read_login(paths)?.1 == pending.after,
            "Claude login verification failed"
        );
        store.selected = Some(target.id.clone());
        store
            .accounts
            .iter_mut()
            .find(|v| v.id == target.id)
            .unwrap()
            .last_used_at = Some(Utc::now().to_rfc3339());
        commit(paths, store)
    })();
    if let Err(error) = result {
        let persisted = load_store(paths)?;
        return match recover(paths, &persisted) {
            Ok(()) => Err(error.context("Claude switch failed; the previous login was restored")),
            Err(recovery) => Err(anyhow::anyhow!(
                "Claude switch failed: {error}. Recovery pending: {recovery}"
            )),
        };
    }
    fs::remove_file(paths.data.join("pending-switch.json"))?;
    Ok(())
}

pub fn remove(account_id: &str) -> Result<()> {
    let paths = ClaudePaths::current()?;
    let _guard = paths.lock()?;
    anyhow::ensure!(
        !paths.data.join("pending-switch.json").try_exists()?,
        "Resolve the interrupted Claude switch before removing a snapshot"
    );
    let mut store = load_store(&paths)?;
    anyhow::ensure!(
        store.accounts.iter().any(|v| v.id == account_id),
        "Claude account not found"
    );
    store.accounts.retain(|v| v.id != account_id);
    if store.selected.as_deref() == Some(account_id) {
        store.selected = None;
    }
    // Removing a snapshot never signs out the running CLI.
    save_store(&paths, &store)
}

pub(crate) fn run_command(command: &mut Command, seconds: u64) -> Result<Output> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::commands::process::CREATE_NO_WINDOW);
    }
    let mut async_command =
        tokio::process::Command::from(std::mem::replace(command, Command::new("unused")));
    async_command.kill_on_drop(true);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(seconds), async_command.output())
                .await
                .context("Claude process inspection timed out")?
                .context("Could not inspect Claude processes")
        })
}

fn is_claude_process(name: &str, command: &str) -> bool {
    if name
        .replace('\\', "/")
        .to_ascii_lowercase()
        .contains("/claude/versions/")
    {
        return true;
    }
    let name = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .to_ascii_lowercase();
    if matches!(name.as_str(), "claude" | "claude.exe" | "claude-code") {
        return true;
    }
    if command
        .replace('\\', "/")
        .to_ascii_lowercase()
        .contains("/claude/versions/")
    {
        return true;
    }
    if !matches!(name.as_str(), "node" | "node.exe" | "bun" | "bun.exe") {
        return false;
    }
    let command = command.replace('\\', "/").to_ascii_lowercase();
    command.contains("/@anthropic-ai/claude-code/")
        || command.split_whitespace().any(|part| {
            let part = part.trim_matches(['\'', '"']);
            part.ends_with("/bin/claude") || part.ends_with("/claude/cli.js")
        })
}

#[cfg(any(unix, test))]
fn ps_entries(output: &str) -> std::collections::HashMap<u32, String> {
    output
        .lines()
        .filter_map(|line| {
            let (pid, text) = line.trim().split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, text.trim().to_owned()))
        })
        .collect()
}

fn ensure_stopped() -> Result<()> {
    #[cfg(windows)]
    let count = {
        let output = run_command(crate::commands::process::windows_powershell_command().args([
            "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='node.exe' OR Name='bun.exe'\" | ForEach-Object { @{name=$_.Name; command=$_.CommandLine} })"
        ]), 30)?;
        anyhow::ensure!(
            output.status.success(),
            "Could not check running Claude Code sessions; switching was cancelled"
        );
        let processes: Vec<Value> = serde_json::from_slice(&output.stdout)
            .context("Could not parse the Claude process list")?;
        processes
            .iter()
            .filter(|v| {
                is_claude_process(
                    v["name"].as_str().unwrap_or(""),
                    v["command"].as_str().unwrap_or(""),
                )
            })
            .count()
    };
    #[cfg(unix)]
    let count = {
        let uid = run_command(Command::new("/usr/bin/id").arg("-u"), 5)?;
        anyhow::ensure!(uid.status.success(), "Could not identify the current user");
        let output = run_command(
            Command::new("/bin/ps").args([
                "-ww",
                "-u",
                String::from_utf8_lossy(&uid.stdout).trim(),
                "-o",
                "pid=,comm=",
            ]),
            10,
        )?;
        anyhow::ensure!(
            output.status.success(),
            "Could not check running Claude Code sessions; switching was cancelled"
        );
        let commands = run_command(
            Command::new("/bin/ps").args([
                "-ww",
                "-u",
                String::from_utf8_lossy(&uid.stdout).trim(),
                "-o",
                "pid=,args=",
            ]),
            10,
        )?;
        anyhow::ensure!(
            commands.status.success(),
            "Could not inspect Claude command lines; switching was cancelled"
        );
        let arguments = ps_entries(&String::from_utf8_lossy(&commands.stdout));
        ps_entries(&String::from_utf8_lossy(&output.stdout))
            .iter()
            .filter(|(pid, name)| {
                is_claude_process(name, arguments.get(pid).map(String::as_str).unwrap_or(""))
            })
            .count()
    };
    anyhow::ensure!(count == 0, "Quit all Claude Code sessions and Claude windows before capturing or switching ({count} processes found). Restart Claude Code after switching.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(user: &str, token: &str) -> Login {
        Login {
            oauth: json!({"accessToken":token,"refreshToken":"test-refresh","expiresAt":4102444800000i64,"subscriptionType":"max"}),
            account: json!({"accountUuid":user,"organizationUuid":"org","emailAddress":format!("{user}@example.com")}),
        }
    }

    fn fixture() -> (tempfile::TempDir, ClaudePaths, Store) {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let paths = ClaudePaths::resolve(
            dir.path(),
            Some(config.to_str().unwrap()),
            &dir.path().join("switcher"),
        )
        .unwrap();
        let accounts = ["a", "b"]
            .map(|id| Account {
                id: id.into(),
                name: id.into(),
                login: login(id, id),
                created_at: "now".into(),
                last_used_at: None,
            })
            .to_vec();
        let store = Store {
            selected: Some("a".into()),
            accounts,
        };
        write_json(&paths.config.join(".credentials.json"), &json!({"claudeAiOauth":store.accounts[0].login.oauth,"mcpOAuth":{"keep":"private mcp token"}})).unwrap();
        write_json(&paths.metadata, &json!({"oauthAccount":store.accounts[0].login.account,"projects":{"keep":true},"theme":"dark"})).unwrap();
        save_store(&paths, &store).unwrap();
        (dir, paths, store)
    }

    #[test]
    fn claude_paths_separate_default_and_explicit_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let default = ClaudePaths::resolve(dir.path(), None, dir.path()).unwrap();
        assert_eq!(default.metadata, dir.path().join(".claude.json"));
        assert_eq!(default.keychain_service, "Claude Code-credentials");
        let custom = ClaudePaths::resolve(
            dir.path(),
            Some(default.config.to_str().unwrap()),
            dir.path(),
        )
        .unwrap();
        assert_eq!(custom.metadata, default.config.join(".claude.json"));
        assert_ne!(custom.keychain_service, default.keychain_service);
        assert_ne!(custom.data, default.data);
        assert!(ClaudePaths::resolve(dir.path(), Some("relative"), dir.path()).is_err());
    }

    #[test]
    fn claude_switch_preserves_mcp_preferences_and_refreshed_login() {
        let (_dir, paths, mut store) = fixture();
        let refreshed = login("a", "fresh-token");
        replace_oauth(
            &paths,
            &CredentialBackend::File,
            &store.accounts[0].login.oauth,
            &refreshed.oauth,
        )
        .unwrap();
        switch_with(&paths, &mut store, "b", save_store).unwrap();
        assert!(read_login(&paths).unwrap().1 == login("b", "b"));
        let persisted = load_store(&paths).unwrap();
        assert_eq!(persisted.selected.as_deref(), Some("b"));
        assert!(persisted.accounts[0].login == refreshed);
        assert_eq!(
            read_json(&paths.config.join(".credentials.json")).unwrap()["mcpOAuth"]["keep"],
            "private mcp token"
        );
        assert_eq!(
            read_json(&paths.metadata).unwrap()["projects"]["keep"],
            true
        );
        assert_eq!(read_json(&paths.metadata).unwrap()["theme"], "dark");
        assert!(!paths.data.join("pending-switch.json").exists());
    }

    #[test]
    fn claude_commit_failure_restores_previous_login() {
        let (_dir, paths, mut store) = fixture();
        let result = switch_with(&paths, &mut store, "b", |_, _| {
            anyhow::bail!("simulated full disk")
        });
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("previous login was restored"));
        assert!(read_login(&paths).unwrap().1 == login("a", "a"));
        assert_eq!(load_store(&paths).unwrap().selected.as_deref(), Some("a"));
        assert!(!paths.data.join("pending-switch.json").exists());
    }

    #[test]
    fn claude_partial_switch_recovers_without_losing_new_preferences() {
        let (_dir, paths, store) = fixture();
        let pending = PendingSwitch {
            target_id: "b".into(),
            backend: CredentialBackend::File,
            before: login("a", "a"),
            after: login("b", "b"),
        };
        write_json(&paths.data.join("pending-switch.json"), &pending).unwrap();
        replace_oauth(
            &paths,
            &pending.backend,
            &pending.before.oauth,
            &pending.after.oauth,
        )
        .unwrap();
        let mut metadata = read_json(&paths.metadata).unwrap();
        metadata["theme"] = "light".into();
        write_json(&paths.metadata, &metadata).unwrap();
        recover(&paths, &store).unwrap();
        assert!(read_login(&paths).unwrap().1 == pending.before);
        assert_eq!(read_json(&paths.metadata).unwrap()["theme"], "light");
    }

    #[test]
    fn claude_recovery_preserves_a_new_external_login() {
        let (_dir, paths, store) = fixture();
        let pending = PendingSwitch {
            target_id: "b".into(),
            backend: CredentialBackend::File,
            before: login("a", "a"),
            after: login("b", "b"),
        };
        write_json(&paths.data.join("pending-switch.json"), &pending).unwrap();
        let external = login("c", "external");
        replace_oauth(
            &paths,
            &pending.backend,
            &pending.before.oauth,
            &external.oauth,
        )
        .unwrap();
        replace_account(&paths, &pending.before.account, &external.account).unwrap();
        assert!(recover(&paths, &store).is_err());
        assert!(read_login(&paths).unwrap().1 == external);
        assert!(paths.data.join("pending-switch.json").exists());
    }

    #[test]
    fn claude_switch_refuses_to_lose_an_uncaptured_login() {
        let (_dir, paths, mut store) = fixture();
        store.accounts.remove(0);
        assert!(switch_with(&paths, &mut store, "b", save_store).is_err());
        assert!(read_login(&paths).unwrap().1 == login("a", "a"));
    }

    #[test]
    fn claude_login_expiry_allows_the_cli_to_refresh() {
        let mut value = login("a", "a");
        value.oauth["expiresAt"] = 1.into();
        assert!(!needs_login(&value, 100));
        value.oauth["refreshTokenExpiresAt"] = 2.into();
        assert!(needs_login(&value, 100));
    }

    #[test]
    fn claude_process_guard_recognizes_native_and_npm_installations() {
        let parsed = ps_entries(
            " 42 /Users/Test User/.local/share/claude/versions/2.1.207\n43 /usr/bin/node",
        );
        assert!(is_claude_process(&parsed[&42], ""));
        assert!(is_claude_process("claude.exe", ""));
        assert!(is_claude_process("/usr/local/bin/claude", ""));
        assert!(is_claude_process(
            "node.exe",
            r"node C:\Users\test\node_modules\@anthropic-ai\claude-code\cli.js"
        ));
        assert!(is_claude_process(
            "2.1.207",
            "/home/test/.local/share/claude/versions/2.1.207"
        ));
        assert!(!is_claude_process("node", "node other-cli.js claude"));
        assert!(!is_claude_process(
            "code",
            "code /project/claude-code/README.md"
        ));
    }
}
