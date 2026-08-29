//! Tauri commands for Antigravity desktop account snapshots.

use crate::auth::{
    capture_antigravity_account, check_antigravity_processes as check_processes,
    delete_antigravity_account as delete_snapshot, get_live_antigravity_usage,
    kill_antigravity_processes as kill_processes, list_antigravity_accounts as list_snapshots,
    switch_antigravity_account as switch_snapshot, AntigravityAccountInfo, AntigravityProcessInfo,
    AntigravityUsageInfo, KillAntigravityProcessesResult,
};

#[tauri::command]
pub async fn list_antigravity_accounts() -> Result<Vec<AntigravityAccountInfo>, String> {
    list_snapshots().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn capture_current_antigravity_account(
    name: String,
) -> Result<AntigravityAccountInfo, String> {
    capture_antigravity_account(name).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn switch_antigravity_account(
    account_id: String,
    force: Option<bool>,
) -> Result<(), String> {
    switch_snapshot(&account_id, force.unwrap_or(false)).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_antigravity_account(account_id: String) -> Result<(), String> {
    delete_snapshot(&account_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_antigravity_usage() -> Result<AntigravityUsageInfo, String> {
    get_live_antigravity_usage()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn check_antigravity_processes() -> Result<AntigravityProcessInfo, String> {
    check_processes().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn kill_antigravity_processes() -> Result<KillAntigravityProcessesResult, String> {
    kill_processes().map_err(|error| error.to_string())
}
