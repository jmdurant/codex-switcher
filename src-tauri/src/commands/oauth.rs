//! OAuth login Tauri commands

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tiny_http::Server;
use tokio::sync::oneshot;

use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::{
    add_account, get_account, load_accounts, replace_account_after_relogin, switch_to_account,
    touch_account, AUTH_OPERATION_LOCK,
};
use crate::types::{AccountInfo, AuthData, OAuthLoginInfo};

#[derive(Clone)]
enum PendingOAuthTarget {
    Add,
    Relogin(String),
}

/// A newly added account should become active only when there was no active
/// account before the add flow started. Re-login is handled separately and
/// already preserves the selected account.
fn should_initialize_added_account(active_account_id: Option<&str>) -> bool {
    active_account_id.is_none()
}

struct PendingOAuth {
    rx: Option<oneshot::Receiver<anyhow::Result<OAuthLoginResult>>>,
    cancelled: Arc<AtomicBool>,
    server: Arc<Server>,
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
    use super::{
        cancel_login, complete_login, email_from_account_name, should_initialize_added_account,
        PendingOAuth, PendingOAuthTarget, PENDING_OAUTH,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tiny_http::Server;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn cancel_reaches_a_relogin_waiting_for_the_browser() {
        let (tx, rx) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        *PENDING_OAUTH.lock().unwrap() = Some(PendingOAuth {
            rx: Some(rx),
            cancelled: Arc::clone(&cancelled),
            server,
            target: PendingOAuthTarget::Relogin("account-id".to_string()),
        });
        let waiter = tokio::spawn(complete_login());
        for _ in 0..20 {
            if PENDING_OAUTH
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|flow| flow.rx.is_none())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(PENDING_OAUTH
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|flow| flow.rx.is_none()));
        cancel_login().await.unwrap();
        assert!(cancelled.load(Ordering::Relaxed));
        drop(tx);
        assert!(waiter.await.unwrap().is_err());
        assert!(PENDING_OAUTH.lock().unwrap().is_none());
    }

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

    #[test]
    fn adding_account_only_initializes_an_empty_active_selection() {
        assert!(should_initialize_added_account(None));
        assert!(!should_initialize_added_account(Some("existing-account")));
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
        previous.server.unblock();
    }

    let (info, rx, cancelled, server) = start_oauth_login(account_name, login_hint)
        .await
        .map_err(|e| e.to_string())?;

    // Store the receiver for later
    {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        *pending = Some(PendingOAuth {
            rx: Some(rx),
            cancelled,
            server,
            target,
        });
    }

    Ok(info)
}

/// Wait for OAuth to complete, then add or replace the requested account.
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let (rx, target, cancelled) = {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        let flow = pending
            .as_mut()
            .ok_or_else(|| "No pending OAuth login".to_string())?;
        (
            flow.rx
                .take()
                .ok_or_else(|| "OAuth login is already being completed".to_string())?,
            flow.target.clone(),
            Arc::clone(&flow.cancelled),
        )
    };

    let result = wait_for_oauth_login(rx).await.map_err(|e| e.to_string());
    {
        let mut pending = PENDING_OAUTH.lock().unwrap();
        if cancelled.load(Ordering::Relaxed)
            || pending
                .as_ref()
                .is_none_or(|flow| !Arc::ptr_eq(&flow.cancelled, &cancelled))
        {
            return Err("OAuth login cancelled or replaced".to_string());
        }
        pending.take();
    }
    let account = result?;

    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;

    let stored = match target {
        PendingOAuthTarget::Add => {
            let active_before_add = load_accounts()
                .map_err(|e| e.to_string())?
                .active_account_id;
            let stored = add_account(account).map_err(|e| e.to_string())?;
            if should_initialize_added_account(active_before_add.as_deref()) {
                // `add_account` assigns the first account as active. Only in
                // that empty-store case should the new credentials be written
                // to Codex; adding another account must leave the current
                // login and active-account selection untouched.
                switch_to_account(&stored).map_err(|e| e.to_string())?;
            }
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
        pending_oauth.server.unblock();
    }
    Ok(())
}
