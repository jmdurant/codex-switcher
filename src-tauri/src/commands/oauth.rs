//! OAuth login Tauri commands

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::{
    add_account, get_account, load_accounts, replace_account_after_relogin, set_active_account,
    switch_to_account, touch_account, AUTH_OPERATION_LOCK,
};
use crate::types::{AccountInfo, AuthData, OAuthLoginInfo};

enum PendingOAuthTarget {
    Add,
    Relogin(String),
}

struct PendingOAuth {
    rx: oneshot::Receiver<anyhow::Result<OAuthLoginResult>>,
    cancelled: Arc<AtomicBool>,
    target: PendingOAuthTarget,
}

// Global state for pending OAuth login
static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::new(None);

/// Start the OAuth login flow
#[tauri::command]
pub async fn start_login(account_name: String) -> Result<OAuthLoginInfo, String> {
    let login_hint = email_from_account_name(&account_name);
    start_login_for_target(
        account_name.trim().to_string(),
        PendingOAuthTarget::Add,
        login_hint,
    )
    .await
}

// The optional name field also accepts an email for the browser sign-in.
// Leave display names alone rather than treating them as login identifiers.
fn email_from_account_name(name: &str) -> Option<String> {
    let email = name.trim();
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || email.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some(email.to_string())
}

#[cfg(test)]
mod tests {
    use super::email_from_account_name;

    #[test]
    fn add_account_carries_email_forward_without_changing_it() {
        assert_eq!(
            email_from_account_name(" Person+team@example.com "),
            Some("Person+team@example.com".to_string())
        );
    }

    #[test]
    fn display_names_and_blank_names_do_not_become_login_hints() {
        for name in [
            "",
            "  ",
            "Work",
            "Work account",
            "Team @ work",
            "@example.com",
            "a@@example.com",
            "a@",
        ] {
            assert_eq!(email_from_account_name(name), None, "{name}");
        }
    }
}

/// Start an OAuth flow that replaces an existing ChatGPT account in place.
#[tauri::command]
pub async fn start_relogin(account_id: String) -> Result<OAuthLoginInfo, String> {
    let account = get_account(&account_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Account not found: {account_id}"))?;
    if !matches!(account.auth_data, AuthData::ChatGPT { .. }) {
        return Err("Only ChatGPT OAuth accounts can be re-authenticated".to_string());
    }

    start_login_for_target(
        account.name,
        PendingOAuthTarget::Relogin(account_id),
        account.email,
    )
    .await
}

async fn start_login_for_target(
    account_name: String,
    target: PendingOAuthTarget,
    login_hint: Option<String>,
) -> Result<OAuthLoginInfo, String> {
    // Cancel any previous pending flow so it does not keep the callback port occupied.
    if let Some(previous) = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending.take()
    } {
        previous.cancelled.store(true, Ordering::Relaxed);
    }

    let (info, rx, cancelled) = start_oauth_login(account_name, login_hint)
        .await
        .map_err(|e| e.to_string())?;

    // Store the receiver for later
    {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        *pending = Some(PendingOAuth {
            rx,
            cancelled,
            target,
        });
    }

    Ok(info)
}

/// Wait for OAuth to complete, then add or replace the requested account.
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let pending = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        pending
            .take()
            .ok_or_else(|| "No pending OAuth login".to_string())?
    };

    let account = wait_for_oauth_login(pending.rx)
        .await
        .map_err(|e| e.to_string())?;

    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;

    let stored = match pending.target {
        PendingOAuthTarget::Add => {
            let stored = add_account(account).map_err(|e| e.to_string())?;
            set_active_account(&stored.id).map_err(|e| e.to_string())?;
            switch_to_account(&stored).map_err(|e| e.to_string())?;
            touch_account(&stored.id).map_err(|e| e.to_string())?;
            stored
        }
        PendingOAuthTarget::Relogin(account_id) => {
            let was_active = load_accounts()
                .map_err(|e| e.to_string())?
                .active_account_id
                .as_deref()
                == Some(account_id.as_str());
            let stored =
                replace_account_after_relogin(&account_id, account).map_err(|e| e.to_string())?;
            if was_active {
                switch_to_account(&stored).map_err(|e| e.to_string())?;
            }
            stored
        }
    };

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    Ok(AccountInfo::from_stored(&stored, active_id))
}

/// Cancel a pending OAuth login
#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    let mut pending = PENDING_OAUTH.lock().unwrap();
    if let Some(pending_oauth) = pending.take() {
        pending_oauth.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}
