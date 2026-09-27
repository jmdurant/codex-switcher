use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

static LOG_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn log_auto_quota_event(
    app: tauri::AppHandle,
    event: String,
    detail: serde_json::Value,
) -> Result<(), String> {
    if event.len() > 80 || detail.to_string().len() > 4096 {
        return Err("Auto-quota log event is too large".into());
    }
    let _guard = LOG_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("auto-quota.jsonl");
    if path.metadata().map(|m| m.len() > 2_000_000).unwrap_or(false) {
        let previous = dir.join("auto-quota.previous.jsonl");
        let _ = fs::remove_file(&previous);
        fs::rename(&path, previous).map_err(|e| e.to_string())?;
    }
    let line = serde_json::json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "event": event,
        "detail": detail,
    });
    let mut file = OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}
