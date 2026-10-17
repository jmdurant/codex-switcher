//! Recoverable credential replacement. Caller holds the auth/switch locks.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use crate::{auth, types::{AccountsStore, StoredAccount}};

pub(crate) trait RuntimeAuth {
    async fn activate(&self, account: &StoredAccount) -> Result<bool>;
    async fn clear(&self) -> Result<()>;
}
pub(crate) struct Daemon;
impl RuntimeAuth for Daemon {
    async fn activate(&self, account: &StoredAccount) -> Result<bool> { super::daemon_auth::activate(account).await }
    async fn clear(&self) -> Result<()> { super::daemon_auth::clear().await }
}

pub(crate) struct ActivationFiles { auth: PathBuf, accounts: PathBuf, journal: PathBuf }
impl ActivationFiles {
    pub(crate) fn local() -> Result<Self> {
        Ok(Self { auth: std::path::absolute(auth::get_codex_auth_file()?)?, accounts: auth::get_accounts_file()?,
            journal: auth::get_config_dir()?.join("pending-switch.json") })
    }
    fn auth(&self) -> Result<Option<String>> {
        match fs::read_to_string(&self.auth) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn store(&self) -> Result<AccountsStore> { Ok(serde_json::from_slice(&fs::read(&self.accounts)?)?) }
    fn save_journal(&self, journal: &Journal) -> Result<()> {
        auth::atomic::write_private(&self.journal, &serde_json::to_vec(journal)?)
    }
}

// This private file contains credentials for crash recovery; it must never be
// returned to frontend IPC or included in diagnostic exports.
#[derive(Serialize, Deserialize)]
struct Journal {
    version: u8,
    auth_path: PathBuf,
    target: StoredAccount,
    previous_active: Option<String>,
    previous_auth: Option<String>,
    target_auth: String,
    activation_started: bool,
    #[serde(default)]
    clear: bool,
}
impl Journal {
    fn next_auth(&self) -> Option<&str> { if self.clear { None } else { Some(&self.target_auth) } }
    fn next_active(&self) -> Option<&str> { if self.clear { None } else { Some(&self.target.id) } }
}

fn remove_auth(files: &ActivationFiles) -> Result<()> {
    match fs::remove_file(&files.auth) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn same_credentials(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).ok();
            match (parse(a), parse(b)) {
                (Some(a), Some(b)) => {
                    if a["OPENAI_API_KEY"].is_string() || b["OPENAI_API_KEY"].is_string() {
                        a["OPENAI_API_KEY"] == b["OPENAI_API_KEY"]
                    } else {
                        a["tokens"]["access_token"].is_string()
                            && a["tokens"] == b["tokens"]
                    }
                }
                _ => a == b,
            }
        }
        _ => false,
    }
}

async fn rollback(files: &ActivationFiles, journal: &Journal, runtime: &impl RuntimeAuth) -> Result<()> {
    if files.store()?.active_account_id != journal.previous_active {
        bail!("The selected account changed outside this switch; recovery requires reconciliation");
    }
    let current = files.auth()?;
    if !same_credentials(current.as_deref(), journal.next_auth()) && !same_credentials(current.as_deref(), journal.previous_auth.as_deref()) {
        bail!("Codex credentials changed outside this switch. The newer login was preserved; capture the current login before retrying");
    }
    if journal.activation_started {
        if let Some(previous) = &journal.previous_auth {
            let mut account = auth::import_from_auth_json_contents(previous, "Previous Codex login".into())?;
            // Match the actual prior credential, which may differ from the UI selection.
            if let Some(stored) = files.store()?.accounts.into_iter().find(|stored| {
                auth::switcher::create_auth_json(stored).ok()
                    .and_then(|auth| serde_json::to_string(&auth).ok())
                    .is_some_and(|auth| same_credentials(Some(&auth), Some(previous)))
            }) { account = stored; }
            runtime.activate(&account).await.context("Could not restore the previous runtime credential")?;
        } else { runtime.clear().await?; }
    }
    let current = files.auth()?;
    if !same_credentials(current.as_deref(), journal.next_auth()) && !same_credentials(current.as_deref(), journal.previous_auth.as_deref()) {
        bail!("Codex login changed during runtime recovery; the newer credential file was preserved");
    }
    match &journal.previous_auth {
        Some(previous) => auth::atomic::write_private(&files.auth, previous.as_bytes())?,
        None => remove_auth(files)?,
    }
    fs::remove_file(&files.journal)?;
    Ok(())
}

pub(crate) async fn recover(files: &ActivationFiles, runtime: &impl RuntimeAuth) -> Result<()> {
    if !files.journal.exists() { return Ok(()); }
    let journal: Journal = serde_json::from_slice(&fs::read(&files.journal)?)
        .context("The pending switch record could not be read")?;
    if journal.version != 1 { bail!("Unsupported pending switch record"); }
    if journal.auth_path != files.auth { bail!("Pending switch belongs to a different CODEX_HOME; reopen the switcher with that home to recover it"); }
    let store = files.store()?;
    if store.active_account_id.as_deref() == journal.next_active()
        && same_credentials(files.auth()?.as_deref(), journal.next_auth()) {
        // Selection was committed before shutdown. Complete verification instead
        // of rolling the already committed account back to an older selection.
        if journal.clear { runtime.clear().await?; } else { runtime.activate(&journal.target).await?; }
        fs::remove_file(&files.journal)?;
        return Ok(());
    }
    if store.active_account_id != journal.previous_active {
        bail!("The selected account changed since the interrupted switch; recovery requires reconciliation");
    }
    rollback(files, &journal, runtime).await
}

/// Explicitly capturing the current login resolves a competing external login.
/// Verify that the captured store and file still agree before retiring recovery.
pub(crate) fn accept_captured_login(files: &ActivationFiles) -> Result<()> {
    if !files.journal.exists() { return Ok(()); }
    let journal: Journal = serde_json::from_slice(&fs::read(&files.journal)?)?;
    if journal.auth_path != files.auth { bail!("Pending switch belongs to a different CODEX_HOME"); }
    let store = files.store()?;
    let selected = store.accounts.iter().find(|account| Some(&account.id) == store.active_account_id.as_ref())
        .context("No captured account is selected")?;
    let selected_auth = serde_json::to_string(&auth::switcher::create_auth_json(selected)?)?;
    if !same_credentials(files.auth()?.as_deref(), Some(&selected_auth)) {
        bail!("Codex login changed while it was being captured; pending switch recovery was retained");
    }
    fs::remove_file(&files.journal)?;
    Ok(())
}

pub(crate) async fn activate(files: &ActivationFiles, account: &StoredAccount, runtime: &impl RuntimeAuth) -> Result<bool> {
    transition(files, account, runtime, false).await
}

pub(crate) async fn deactivate(files: &ActivationFiles, account: &StoredAccount, runtime: &impl RuntimeAuth) -> Result<()> {
    transition(files, account, runtime, true).await.map(|_| ())
}

async fn transition(files: &ActivationFiles, account: &StoredAccount, runtime: &impl RuntimeAuth, clear: bool) -> Result<bool> {
    recover(files, runtime).await?;
    let previous_active = files.store()?.active_account_id;
    let mut journal = Journal { version: 1, auth_path: files.auth.clone(), target: account.clone(), previous_active,
        previous_auth: files.auth()?, target_auth: serde_json::to_string_pretty(&auth::switcher::create_auth_json(account)?)?, activation_started: false, clear };
    files.save_journal(&journal)?;
    let result = async {
        if !same_credentials(files.auth()?.as_deref(), journal.previous_auth.as_deref()) {
            bail!("Codex login changed before credential replacement");
        }
        if clear { remove_auth(files)?; } else { auth::atomic::write_private(&files.auth, journal.target_auth.as_bytes())?; }
        journal.activation_started = true;
        files.save_journal(&journal)?;
        let verified = if clear { runtime.clear().await?; false } else { runtime.activate(account).await? };
        if !same_credentials(files.auth()?.as_deref(), journal.next_auth()) {
            bail!("Codex credentials changed during activation; selection was not committed");
        }
        auth::storage::with_accounts_store_at(&files.accounts, |store| {
            if store.active_account_id != journal.previous_active { bail!("Selected account changed during activation"); }
            let target = store.accounts.iter_mut().find(|a| a.id == account.id).context("Target account was removed during activation")?;
            if !clear { target.last_used_at = Some(chrono::Utc::now()); }
            store.active_account_id = journal.next_active().map(str::to_owned);
            Ok(())
        })?;
        Ok::<_, anyhow::Error>(verified)
    }.await;
    match result {
        Ok(verified) => {
            // A leftover record is safe: recovery recognizes the committed target.
            let _ = fs::remove_file(&files.journal);
            Ok(verified)
        },
        Err(error) => match rollback(files, &journal, runtime).await {
            Ok(()) => Err(error.context("Switch failed; the previous credentials were restored")),
            Err(recovery) => Err(anyhow::anyhow!("Switch failed: {error}. Recovery remains pending: {recovery}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct FakeRuntime { fail: bool, calls: Mutex<Vec<String>> }
    impl RuntimeAuth for FakeRuntime {
        async fn activate(&self, account: &StoredAccount) -> Result<bool> {
            self.calls.lock().unwrap().push(account.name.clone());
            if self.fail && account.name == "target" { bail!("injected activation failure"); }
            Ok(true)
        }
        async fn clear(&self) -> Result<()> { self.calls.lock().unwrap().push("signed out".into()); Ok(()) }
    }
    fn fixture() -> (tempfile::TempDir, ActivationFiles, StoredAccount) {
        let dir = tempfile::tempdir().unwrap();
        let files = ActivationFiles { auth:dir.path().join("auth.json"), accounts:dir.path().join("accounts.json"), journal:dir.path().join("pending-switch.json") };
        let old = StoredAccount::new_api_key("previous".into(), "old-key".into());
        let target = StoredAccount::new_api_key("target".into(), "new-key".into());
        let mut store = AccountsStore::default();
        store.active_account_id = Some(old.id.clone()); store.accounts = vec![old.clone(), target.clone()];
        auth::atomic::write_private(&files.accounts, &serde_json::to_vec(&store).unwrap()).unwrap();
        auth::atomic::write_private(&files.auth, &serde_json::to_vec(&auth::switcher::create_auth_json(&old).unwrap()).unwrap()).unwrap();
        (dir, files, target)
    }
    #[tokio::test]
    async fn failed_activation_restores_file_and_does_not_commit_selection() {
        let (_dir, files, target) = fixture();
        let original = files.auth().unwrap(); let selected = files.store().unwrap().active_account_id;
        let runtime = FakeRuntime {fail:true,calls:Mutex::new(vec![])};
        assert!(activate(&files, &target, &runtime).await.is_err());
        assert_eq!(files.auth().unwrap(), original);
        assert_eq!(files.store().unwrap().active_account_id, selected);
        assert_eq!(runtime.calls.lock().unwrap().len(), 2);
        assert!(!files.journal.exists());
    }
    #[tokio::test]
    async fn successful_activation_commits_selection_and_cleans_journal() {
        let (_dir, files, target) = fixture();
        let runtime = FakeRuntime {fail:false,calls:Mutex::new(vec![])};
        assert!(activate(&files, &target, &runtime).await.unwrap());
        assert_eq!(files.store().unwrap().active_account_id, Some(target.id));
        assert!(!files.journal.exists());
    }
    #[tokio::test]
    async fn interrupted_file_replacement_is_recovered_before_the_next_switch() {
        let (_dir, files, target) = fixture(); let old = files.auth().unwrap();
        let journal = Journal {version:1,auth_path:files.auth.clone(),target:target.clone(),previous_active:files.store().unwrap().active_account_id,
            previous_auth:old.clone(),target_auth:serde_json::to_string_pretty(&auth::switcher::create_auth_json(&target).unwrap()).unwrap(),activation_started:true,clear:false};
        files.save_journal(&journal).unwrap();
        auth::atomic::write_private(&files.auth,journal.target_auth.as_bytes()).unwrap();
        let runtime = FakeRuntime {fail:false,calls:Mutex::new(vec![])};
        recover(&files,&runtime).await.unwrap();
        assert_eq!(files.auth().unwrap(),old);
        assert!(!files.journal.exists());
    }

    struct MutatingRuntime<'a> { files: &'a ActivationFiles, action: &'a str }
    impl RuntimeAuth for MutatingRuntime<'_> {
        async fn activate(&self, account: &StoredAccount) -> Result<bool> {
            if self.action == "fail_all" { bail!("injected runtime unavailable"); }
            if account.name == "target" {
                match self.action {
                    "external_login" => {
                        auth::atomic::write_private(&self.files.auth, br#"{"OPENAI_API_KEY":"external-key"}"#)?;
                        bail!("injected competing login");
                    }
                    "commit_failure" => {
                        auth::storage::with_accounts_store_at(&self.files.accounts, |store| {
                            store.accounts.retain(|stored| stored.id != account.id); Ok(())
                        })?;
                    }
                    "reformat" => {
                        auth::atomic::write_private(&self.files.auth, br#"{"auth_mode":"apikey","OPENAI_API_KEY":"new-key"}"#)?;
                    }
                    _ => {},
                }
            }
            Ok(true)
        }
        async fn clear(&self) -> Result<()> { Ok(()) }
    }
    #[tokio::test]
    async fn commit_failure_restores_previous_runtime_and_file() {
        let (_dir, files, target) = fixture(); let original = files.auth().unwrap();
        let runtime = MutatingRuntime {files:&files,action:"commit_failure"};
        assert!(activate(&files,&target,&runtime).await.is_err());
        assert_eq!(files.auth().unwrap(),original);
        assert!(!files.journal.exists());
    }
    #[tokio::test]
    async fn external_login_is_preserved_and_requires_reconciliation() {
        let (_dir, files, target) = fixture();
        let runtime = MutatingRuntime {files:&files,action:"external_login"};
        assert!(activate(&files,&target,&runtime).await.is_err());
        assert!(same_credentials(files.auth().unwrap().as_deref(),Some(r#"{"OPENAI_API_KEY":"external-key"}"#)));
        assert!(files.journal.exists());
        assert!(recover(&files,&runtime).await.is_err());
    }
    #[tokio::test]
    async fn failed_rollback_is_recoverable_when_runtime_returns() {
        let (_dir, files, target) = fixture(); let original = files.auth().unwrap();
        assert!(activate(&files,&target,&MutatingRuntime {files:&files,action:"fail_all"}).await.is_err());
        assert!(files.journal.exists());
        recover(&files,&FakeRuntime {fail:false,calls:Mutex::new(vec![])}).await.unwrap();
        assert_eq!(files.auth().unwrap(),original);
    }
    #[tokio::test]
    async fn daemon_reformatting_does_not_look_like_a_different_login() {
        let (_dir, files, target) = fixture();
        assert!(activate(&files,&target,&MutatingRuntime {files:&files,action:"reformat"}).await.unwrap());
    }
    #[tokio::test]
    async fn failure_after_signed_out_state_restores_signed_out_state() {
        let (_dir, files, target) = fixture(); fs::remove_file(&files.auth).unwrap();
        let runtime = FakeRuntime {fail:true,calls:Mutex::new(vec![])};
        assert!(activate(&files,&target,&runtime).await.is_err());
        assert!(files.auth().unwrap().is_none());
        assert!(runtime.calls.lock().unwrap().iter().any(|call|call == "signed out"));
    }
    #[tokio::test]
    async fn deleting_last_active_account_clears_runtime_file_and_selection() {
        let (_dir, files, _) = fixture();
        let store = files.store().unwrap();
        let account = store.accounts.iter().find(|a|Some(&a.id)==store.active_account_id.as_ref()).unwrap();
        let runtime = FakeRuntime {fail:false,calls:Mutex::new(vec![])};
        deactivate(&files,account,&runtime).await.unwrap();
        assert!(files.auth().unwrap().is_none());
        assert!(files.store().unwrap().active_account_id.is_none());
        assert!(!files.journal.exists());
    }
    #[tokio::test]
    async fn recovery_never_applies_a_journal_to_another_codex_home() {
        let (_dir, files, target) = fixture();
        assert!(activate(&files,&target,&MutatingRuntime {files:&files,action:"fail_all"}).await.is_err());
        let other = ActivationFiles {auth:files.auth.with_file_name("other-auth.json"),accounts:files.accounts.clone(),journal:files.journal.clone()};
        let error = recover(&other,&FakeRuntime {fail:false,calls:Mutex::new(vec![])}).await.unwrap_err();
        assert!(error.to_string().contains("different CODEX_HOME"));
        assert!(!other.auth.exists());
        assert!(files.journal.exists());
    }
}
