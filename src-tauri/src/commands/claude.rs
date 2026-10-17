use crate::auth::{claude, claude_usage};

#[tauri::command]
pub async fn get_claude_state() -> Result<claude::ClaudeState, String> {
    tokio::task::spawn_blocking(claude::state)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn capture_claude_account(name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || claude::capture(name))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn switch_claude_account(account_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || claude::switch(&account_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn delete_claude_account(account_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || claude::remove(&account_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn set_claude_usage_tracking(enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || claude_usage::set_enabled(enabled))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}
