//! Discover the local Codex login without changing its credentials or processes.

use crate::{
    auth::{
        import_from_auth_json_contents, load_accounts, read_current_auth, with_accounts_store,
        AUTH_OPERATION_LOCK,
    },
    types::{AccountInfo, AccountsStore, AuthData, AuthDotJson, StoredAccount},
};

#[derive(serde::Serialize)]
pub struct CurrentCodexLogin {
    pub account: AccountInfo,
    pub is_managed: bool,
}

fn read_live_account() -> anyhow::Result<Option<StoredAccount>> {
    account_from_live_auth(read_current_auth()?)
}

fn account_from_live_auth(auth: Option<AuthDotJson>) -> anyhow::Result<Option<StoredAccount>> {
    let Some(mut auth) = auth else {
        return Ok(None);
    };
    auth.openai_api_key = auth.openai_api_key.filter(|key| !key.trim().is_empty());
    if auth
        .openai_api_key
        .as_ref()
        .is_none_or(|key| key.trim().is_empty())
        && auth.tokens.is_none()
    {
        return Ok(None);
    }
    let account = import_from_auth_json_contents(&serde_json::to_string(&auth)?, String::new())?;
    let complete = match &account.auth_data {
        AuthData::ApiKey { key } => !key.trim().is_empty(),
        AuthData::ChatGPT {
            id_token,
            access_token,
            refresh_token,
            ..
        } => !id_token.is_empty() && !access_token.is_empty() && !refresh_token.is_empty(),
    };
    anyhow::ensure!(
        complete,
        "The local Codex login is incomplete; sign in to Codex again"
    );
    Ok(Some(account))
}

fn same_login(stored: &StoredAccount, live: &StoredAccount) -> bool {
    match (&stored.auth_data, &live.auth_data) {
        (AuthData::ApiKey { key: a }, AuthData::ApiKey { key: b }) => a == b,
        (
            AuthData::ChatGPT {
                account_id: a,
                id_token: ai,
                access_token: at,
                ..
            },
            AuthData::ChatGPT {
                account_id: b,
                id_token: bi,
                access_token: bt,
                ..
            },
        ) => {
            // Email alone is insufficient: one person may have personal and team
            // workspaces. A shared team ID alone must not merge different users.
            if let (Some(a), Some(b)) = (&stored.email, &live.email) {
                if !a.eq_ignore_ascii_case(b) {
                    return false;
                }
            }
            let a = crate::types::parse_chatgpt_id_token_claims(ai)
                .account_id
                .or_else(|| a.clone());
            let b = crate::types::parse_chatgpt_id_token_claims(bi)
                .account_id
                .or_else(|| b.clone());
            match (a, b) {
                (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => {
                    a == b
                        && ((stored.email.is_some() && live.email.is_some())
                            || (ai == bi && at == bt))
                }
                _ => ai == bi && at == bt,
            }
        }
        _ => false,
    }
}

/// Metadata only; tokens never cross the frontend IPC boundary.
#[tauri::command]
pub async fn get_current_codex_login() -> Result<Option<CurrentCodexLogin>, String> {
    let _guard = AUTH_OPERATION_LOCK.lock().await;
    let Some(live) = read_live_account().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let store = load_accounts().map_err(|e| e.to_string())?;
    let existing = store
        .accounts
        .iter()
        .find(|account| same_login(account, &live));
    Ok(Some(CurrentCodexLogin {
        account: AccountInfo::from_stored(
            existing.unwrap_or(&live),
            store.active_account_id.as_deref(),
        ),
        is_managed: existing.is_some(),
    }))
}

fn capture_into_store(store: &mut AccountsStore, mut live: StoredAccount) -> AccountInfo {
    let id = if let Some(existing) = store
        .accounts
        .iter_mut()
        .find(|account| same_login(account, &live))
    {
        // Preserve the user's name, stable ID, masking, and usage history.
        existing.auth_data = live.auth_data;
        if live.email.is_some() {
            existing.email = live.email;
        }
        if live.plan_type.is_some() {
            existing.plan_type = live.plan_type;
        }
        if live.subscription_expires_at.is_some() {
            existing.subscription_expires_at = live.subscription_expires_at;
        }
        existing.id.clone()
    } else {
        let base = live.name.clone();
        let mut suffix = 2;
        while store
            .accounts
            .iter()
            .any(|account| account.name == live.name)
        {
            live.name = format!("{base} ({suffix})");
            suffix += 1;
        }
        let id = live.id.clone();
        store.accounts.push(live);
        id
    };
    store.active_account_id = Some(id.clone());
    AccountInfo::from_stored(
        store
            .accounts
            .iter()
            .find(|account| account.id == id)
            .unwrap(),
        Some(&id),
    )
}

/// Save a snapshot of the current login. This never writes Codex's auth.json,
/// refreshes a token, launches a login flow, or terminates running sessions.
#[tauri::command]
pub async fn capture_current_codex_login() -> Result<AccountInfo, String> {
    let _guard = AUTH_OPERATION_LOCK.lock().await;
    let live = read_live_account()
        .map_err(|e| e.to_string())?
        .ok_or("No local Codex login was found")?;
    with_accounts_store(|store| Ok(capture_into_store(store, live))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_and_incomplete_logins_are_not_imported() {
        assert!(account_from_live_auth(None).unwrap().is_none());
        let empty = serde_json::from_value(serde_json::json!({"OPENAI_API_KEY": ""})).unwrap();
        assert!(account_from_live_auth(Some(empty)).unwrap().is_none());
        let incomplete = serde_json::from_value(serde_json::json!({"tokens": {
            "id_token": "id", "access_token": "", "refresh_token": "refresh"
        }}))
        .unwrap();
        assert!(account_from_live_auth(Some(incomplete)).is_err());
    }

    #[tokio::test]
    #[ignore = "requires an existing local Codex login; read-only"]
    async fn local_codex_detection_smoke() {
        let path = crate::auth::get_codex_auth_file().unwrap();
        let before = std::fs::read(&path).unwrap();
        let login = get_current_codex_login()
            .await
            .unwrap()
            .expect("Expected a local login");
        let metadata = serde_json::to_value(login).unwrap();
        assert!(metadata["account"].get("auth_data").is_none());
        assert_eq!(before, std::fs::read(&path).unwrap());
    }

    fn oauth(email: &str, workspace: &str, token: &str) -> StoredAccount {
        StoredAccount::new_chatgpt(
            String::new(),
            Some(email.into()),
            Some("plus".into()),
            None,
            "test-id-token".into(),
            token.into(),
            "refresh".into(),
            Some(workspace.into()),
        )
    }

    #[test]
    fn captures_current_login_and_reuses_saved_identity_after_token_rotation() {
        let mut store = AccountsStore::default();
        let first = capture_into_store(&mut store, oauth("person@example.com", "personal", "old"));
        store.accounts[0].name = "Personal".into();
        store.masked_account_ids.push(first.id.clone());
        let next = capture_into_store(
            &mut store,
            oauth("person@example.com", "personal", "rotated"),
        );
        assert_eq!(next.id, first.id);
        assert_eq!(next.name, "Personal");
        assert!(next.is_active);
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.masked_account_ids, vec![first.id]);
        assert!(
            matches!(&store.accounts[0].auth_data, AuthData::ChatGPT { access_token, .. } if access_token == "rotated")
        );
    }

    #[test]
    fn separates_workspaces_and_people_and_selects_the_live_login() {
        let mut store = AccountsStore::default();
        capture_into_store(&mut store, oauth("person@example.com", "personal", "a"));
        capture_into_store(&mut store, oauth("person@example.com", "team", "b"));
        let current = capture_into_store(&mut store, oauth("other@example.com", "team", "c"));
        assert_eq!(store.accounts.len(), 3);
        assert_eq!(store.accounts[1].name, "person@example.com (2)");
        assert_eq!(store.active_account_id, Some(current.id));
    }

    #[test]
    fn matches_api_keys_without_returning_them_as_metadata() {
        let mut store = AccountsStore::default();
        capture_into_store(
            &mut store,
            StoredAccount::new_api_key(String::new(), "secret-one".into()),
        );
        let info = capture_into_store(
            &mut store,
            StoredAccount::new_api_key(String::new(), "secret-one".into()),
        );
        assert_eq!(store.accounts.len(), 1);
        assert!(!serde_json::to_string(&info).unwrap().contains("secret-one"));
        capture_into_store(
            &mut store,
            StoredAccount::new_api_key(String::new(), "secret-two".into()),
        );
        assert_eq!(store.accounts.len(), 2);
    }
}
