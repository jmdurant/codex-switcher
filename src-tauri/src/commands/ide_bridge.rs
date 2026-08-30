//! File-based coordination with the optional VS Code/Antigravity companion extension.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const PROTOCOL_VERSION: u8 = 1;
const CLIENT_MAX_AGE_MS: u64 = 6_000;
const PREPARE_TIMEOUT: Duration = Duration::from_millis(1_500);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const CLEANUP_MAX_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdeBridgeRequest {
    version: u8,
    request_id: String,
    tool: String,
    phase: String,
    created_at_ms: u64,
    completed_at_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdeBridgeClient {
    version: u8,
    client_id: String,
    ide_kind: String,
    updated_at_ms: u64,
    #[serde(default)]
    active_tools: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdeBridgeResponse {
    version: u8,
    request_id: String,
    client_id: String,
    ide_kind: String,
    #[serde(default)]
    captured_sessions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeResumePreparation {
    pub request_id: Option<String>,
    pub captured_sessions: usize,
    pub responding_clients: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeResumeCompletion {
    pub resumed_sessions: usize,
    pub reopened_antigravity: bool,
}

fn bridge_dir() -> Result<PathBuf> {
    Ok(crate::auth::get_config_dir()?.join("ide-bridge"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn validate_tool(tool: &str) -> Result<()> {
    if matches!(tool, "codex" | "agy") {
        Ok(())
    } else {
        anyhow::bail!("Unsupported IDE resume tool: {tool}")
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("IDE bridge file has no parent")?;
    fs::create_dir_all(parent).with_context(|| {
        format!(
            "Failed to create IDE bridge directory: {}",
            parent.display()
        )
    })?;
    let contents = serde_json::to_vec(value).context("Failed to serialize IDE bridge state")?;
    fs::write(path, contents)
        .with_context(|| format!("Failed to write IDE bridge state: {}", path.display()))
}

fn live_clients(root: &Path, tool: &str, current_ms: u64) -> Vec<IdeBridgeClient> {
    let clients_dir = root.join("clients");
    let Ok(entries) = fs::read_dir(clients_dir) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_json::<IdeBridgeClient>(&entry.path()))
        .filter(|client| {
            client.version == PROTOCOL_VERSION
                && matches!(client.ide_kind.as_str(), "vscode" | "antigravity")
                && current_ms.saturating_sub(client.updated_at_ms) <= CLIENT_MAX_AGE_MS
                && client.active_tools.iter().any(|active| active == tool)
        })
        .collect()
}

fn request_responses(
    root: &Path,
    request_id: &str,
    expected_clients: &HashSet<String>,
) -> Vec<IdeBridgeResponse> {
    let responses_dir = root.join("responses");
    let Ok(entries) = fs::read_dir(responses_dir) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_json::<IdeBridgeResponse>(&entry.path()))
        .filter(|response| {
            response.version == PROTOCOL_VERSION
                && response.request_id == request_id
                && (expected_clients.is_empty()
                    || expected_clients.contains(response.client_id.as_str()))
        })
        .collect()
}

fn cleanup_old_files(root: &Path) {
    for directory in ["clients", "requests", "responses", "claims"] {
        let Ok(entries) = fs::read_dir(root.join(directory)) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let is_old = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age > CLEANUP_MAX_AGE);
            if is_old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// Ask active companion extensions to persist their running terminal sessions.
/// If no extension reports the requested tool, this returns immediately.
#[tauri::command]
pub async fn prepare_ide_resume(tool: String) -> Result<IdeResumePreparation, String> {
    validate_tool(&tool).map_err(|error| error.to_string())?;
    let root = bridge_dir().map_err(|error| error.to_string())?;
    cleanup_old_files(&root);

    let clients = live_clients(&root, &tool, now_ms());
    if clients.is_empty() {
        return Ok(IdeResumePreparation {
            request_id: None,
            captured_sessions: 0,
            responding_clients: 0,
        });
    }

    let request_id = Uuid::new_v4().to_string();
    let request = IdeBridgeRequest {
        version: PROTOCOL_VERSION,
        request_id: request_id.clone(),
        tool,
        phase: "prepare".to_string(),
        created_at_ms: now_ms(),
        completed_at_ms: None,
    };
    let request_path = root.join("requests").join(format!("{request_id}.json"));
    write_json(&request_path, &request).map_err(|error| error.to_string())?;

    let expected_clients: HashSet<String> =
        clients.into_iter().map(|client| client.client_id).collect();
    let deadline = tokio::time::Instant::now() + PREPARE_TIMEOUT;
    let responses = loop {
        let responses = request_responses(&root, &request_id, &expected_clients);
        let responding: HashSet<&str> = responses
            .iter()
            .map(|response| response.client_id.as_str())
            .collect();
        if expected_clients
            .iter()
            .all(|client| responding.contains(client.as_str()))
            || tokio::time::Instant::now() >= deadline
        {
            break responses;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };

    Ok(IdeResumePreparation {
        request_id: Some(request_id),
        captured_sessions: responses
            .iter()
            .map(|response| response.captured_sessions)
            .sum(),
        responding_clients: responses.len(),
    })
}

/// Release captured IDE terminals after the profile operation. A successful or
/// rolled-back switch both use `resume=true`; `false` discards the capture.
#[tauri::command]
pub async fn complete_ide_resume(
    request_id: String,
    resume: bool,
) -> Result<IdeResumeCompletion, String> {
    let parsed_request_id =
        Uuid::parse_str(&request_id).map_err(|_| "IDE resume request ID is invalid".to_string())?;
    if parsed_request_id.to_string() != request_id {
        return Err("IDE resume request ID is invalid".to_string());
    }
    let root = bridge_dir().map_err(|error| error.to_string())?;
    let request_path = root.join("requests").join(format!("{request_id}.json"));
    let mut request: IdeBridgeRequest = read_json(&request_path)
        .ok_or_else(|| format!("IDE resume request not found: {request_id}"))?;
    if request.request_id != request_id || request.version != PROTOCOL_VERSION {
        return Err("IDE resume request is invalid".to_string());
    }

    let responses = request_responses(&root, &request_id, &HashSet::new());
    request.phase = if resume { "ready" } else { "cancelled" }.to_string();
    request.completed_at_ms = Some(now_ms());
    write_json(&request_path, &request).map_err(|error| error.to_string())?;

    let resumed_sessions = if resume {
        responses
            .iter()
            .map(|response| response.captured_sessions)
            .sum()
    } else {
        0
    };
    let should_reopen_antigravity = resume
        && responses
            .iter()
            .any(|response| response.captured_sessions > 0 && response.ide_kind == "antigravity");
    let reopened_antigravity = should_reopen_antigravity && open_antigravity_ide();

    Ok(IdeResumeCompletion {
        resumed_sessions,
        reopened_antigravity,
    })
}

#[cfg(windows)]
fn open_antigravity_ide() -> bool {
    let mut candidates = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Antigravity IDE")
                .join("Antigravity IDE.exe"),
        );
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Antigravity IDE")
                .join("Antigravity IDE.exe"),
        );
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .is_some_and(|path| Command::new(path).spawn().is_ok())
}

#[cfg(not(windows))]
fn open_antigravity_ide() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{
        live_clients, request_responses, validate_tool, write_json, IdeBridgeClient,
        IdeBridgeResponse, CLIENT_MAX_AGE_MS, PROTOCOL_VERSION,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_bridge_dir() -> PathBuf {
        std::env::temp_dir().join(format!("codex-switcher-ide-bridge-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn only_supported_resume_tools_are_accepted() {
        assert!(validate_tool("codex").is_ok());
        assert!(validate_tool("agy").is_ok());
        assert!(validate_tool("powershell").is_err());
    }

    #[test]
    fn client_schema_tracks_tool_and_freshness_fields() {
        let client = IdeBridgeClient {
            version: PROTOCOL_VERSION,
            client_id: "client".into(),
            ide_kind: "vscode".into(),
            updated_at_ms: 10,
            active_tools: vec!["codex".into()],
        };
        assert_eq!(client.ide_kind, "vscode");
        assert!(client.active_tools.iter().any(|tool| tool == "codex"));
        assert!(CLIENT_MAX_AGE_MS > 0);
    }

    #[test]
    fn discovers_only_fresh_clients_running_the_requested_tool() {
        let root = temp_bridge_dir();
        let clients_dir = root.join("clients");
        let now = 50_000;
        let fresh = IdeBridgeClient {
            version: PROTOCOL_VERSION,
            client_id: "fresh".into(),
            ide_kind: "vscode".into(),
            updated_at_ms: now,
            active_tools: vec!["codex".into()],
        };
        let stale = IdeBridgeClient {
            version: PROTOCOL_VERSION,
            client_id: "stale".into(),
            ide_kind: "antigravity".into(),
            updated_at_ms: now - CLIENT_MAX_AGE_MS - 1,
            active_tools: vec!["codex".into()],
        };
        write_json(&clients_dir.join("fresh.json"), &fresh).unwrap();
        write_json(&clients_dir.join("stale.json"), &stale).unwrap();

        let clients = live_clients(&root, "codex", now);

        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].client_id, "fresh");
        assert!(live_clients(&root, "agy", now).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn response_collection_is_scoped_to_request_and_expected_client() {
        let root = temp_bridge_dir();
        let responses_dir = root.join("responses");
        let response = IdeBridgeResponse {
            version: PROTOCOL_VERSION,
            request_id: "request-a".into(),
            client_id: "client-a".into(),
            ide_kind: "vscode".into(),
            captured_sessions: 1,
        };
        write_json(&responses_dir.join("response.json"), &response).unwrap();

        let expected = HashSet::from(["client-a".to_string()]);
        assert_eq!(request_responses(&root, "request-a", &expected).len(), 1);
        assert!(request_responses(&root, "request-b", &expected).is_empty());
        assert!(
            request_responses(&root, "request-a", &HashSet::from(["client-b".to_string()]))
                .is_empty()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
