//! Collect documented Claude Code status-line rate limits without sending an
//! OAuth credential to an undocumented endpoint. Full status-line input is
//! forwarded to an existing renderer, but only quota fields are saved here.
use super::{
    claude::{hash, identity, read_json, write_json, ClaudePaths},
    operation::lock_file,
};
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct ClaudeWindow {
    pub used_percent: f64,
    pub resets_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ClaudeUsage {
    pub observed_at: i64,
    pub stale: bool,
    pub five_hour: Option<ClaudeWindow>,
    pub seven_day: Option<ClaudeWindow>,
}

#[derive(Serialize, Deserialize)]
struct UsageRecord {
    identity: String,
    usage: ClaudeUsage,
}

#[derive(Serialize, Deserialize)]
struct Tracker {
    previous: Option<Value>,
    command: String,
    metadata: PathBuf,
    shell: PathBuf,
}

fn tracker_path(paths: &ClaudePaths) -> PathBuf {
    paths.data.join("statusline.json")
}

pub(crate) fn enabled(paths: &ClaudePaths) -> Result<bool> {
    let path = tracker_path(paths);
    if !path.try_exists()? {
        return Ok(false);
    }
    let tracker: Tracker = serde_json::from_value(read_json(&path)?)?;
    let settings = read_json(&paths.config.join("settings.json"))?;
    Ok(settings
        .pointer("/statusLine/command")
        .and_then(Value::as_str)
        == Some(&tracker.command))
}

fn shell() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH")
            .map(PathBuf::from)
            .filter(|v| v.is_file())
        {
            return Ok(path);
        }
        for variable in ["ProgramFiles", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(variable) {
                for suffix in ["Git/bin/bash.exe", "Programs/Git/bin/bash.exe"] {
                    let path = PathBuf::from(&root).join(suffix);
                    if path.is_file() {
                        return Ok(path);
                    }
                }
            }
        }
        anyhow::bail!("Set CLAUDE_CODE_GIT_BASH_PATH to your Git Bash executable before enabling usage tracking");
    }
    #[cfg(unix)]
    {
        for path in ["/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash"] {
            if Path::new(path).is_file() {
                return Ok(PathBuf::from(path));
            }
        }
        anyhow::bail!("Bash is required to preserve the Claude Code status line");
    }
}

fn shell_quote(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    let text = text.replace('\\', "/");
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}

pub fn set_enabled(enable: bool) -> Result<()> {
    let paths = ClaudePaths::current()?;
    if enable {
        set_enabled_at(&paths, Some((&std::env::current_exe()?, &shell()?)))
    } else {
        set_enabled_at(&paths, None)
    }
}

fn set_enabled_at(paths: &ClaudePaths, target: Option<(&Path, &Path)>) -> Result<()> {
    let _guard = paths.lock()?;
    let settings_path = paths.config.join("settings.json");
    let original = read_json(&settings_path)?;
    let mut settings = original.clone();
    let path = tracker_path(&paths);
    let old_tracker = if path.try_exists()? {
        Some(fs::read(&path)?)
    } else {
        None
    };
    if let Some((executable, renderer_shell)) = target {
        let command = format!(
            "{} --claude-statusline {}",
            shell_quote(executable),
            shell_quote(&path)
        );
        let previous = if enabled(&paths)? {
            serde_json::from_value::<Tracker>(read_json(&path)?)?.previous
        } else {
            settings.get("statusLine").cloned()
        };
        if let Some(prior) = previous.as_ref().filter(|v| !v.is_null()) {
            anyhow::ensure!(
                prior.get("type").and_then(Value::as_str) == Some("command")
                    && prior.get("command").and_then(Value::as_str).is_some(),
                "The current Claude status line has an unsupported format; it was left unchanged"
            );
            anyhow::ensure!(!prior["command"].as_str().unwrap().contains("--claude-statusline"),
                "An existing switcher status line is already configured; disable that integration first");
        }
        let tracker = Tracker {
            previous,
            command: command.clone(),
            metadata: paths.metadata.clone(),
            shell: renderer_shell.to_owned(),
        };
        write_json(&path, &tracker)?;
        if !settings.get("statusLine").is_some_and(Value::is_object) {
            settings["statusLine"] = json!({});
        }
        settings["statusLine"]["type"] = "command".into();
        settings["statusLine"]["command"] = command.into();
    } else {
        if !enabled(&paths)? {
            return Ok(());
        }
        let tracker: Tracker = serde_json::from_value(read_json(&path)?)?;
        match tracker.previous {
            Some(previous) => settings["statusLine"] = previous,
            None => {
                settings.as_object_mut().unwrap().remove("statusLine");
            }
        }
    }
    let result = (|| {
        anyhow::ensure!(
            read_json(&settings_path)? == original,
            "Claude settings changed; retry enabling usage tracking"
        );
        write_json(&settings_path, &settings)
    })();
    if result.is_err() && target.is_some() {
        if let Some(bytes) = old_tracker {
            super::atomic::write_private(&path, &bytes)?;
        } else if path.try_exists()? {
            fs::remove_file(&path)?;
        }
    }
    result
}

fn window(value: Option<&Value>, now: i64) -> Option<ClaudeWindow> {
    let value = value?;
    let used = value.get("used_percentage")?.as_f64()?;
    let resets_at = value.get("resets_at")?.as_i64()?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) || resets_at <= now {
        return None;
    }
    Some(ClaudeWindow {
        used_percent: used,
        resets_at,
    })
}

fn collect(data: &Path, metadata: &Path, input: &Value, now: i64) -> Result<()> {
    let _guard = lock_file(&data.join("operation.lock"))?;
    if data.join("pending-switch.json").try_exists()? {
        return Ok(());
    }
    let Some(current) = identity(&read_json(metadata)?["oauthAccount"]) else {
        return Ok(());
    };
    let Some(session_id) = input
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    else {
        return Ok(());
    };
    let binding_path = data
        .join("sessions")
        .join(format!("{}.json", hash(session_id)));
    let binding = read_json(&binding_path)?;
    if let Some(bound) = binding.get("identity").and_then(Value::as_str) {
        if bound != current {
            return Ok(());
        }
    } else {
        write_json(&binding_path, &json!({"identity": current}))?;
    }
    let usage = ClaudeUsage {
        observed_at: now,
        stale: false,
        five_hour: window(input.pointer("/rate_limits/five_hour"), now),
        seven_day: window(input.pointer("/rate_limits/seven_day"), now),
    };
    // No fabricated zeros when Claude omits usage, including API-key sessions.
    if usage.five_hour.is_none() && usage.seven_day.is_none() {
        return Ok(());
    }
    write_json(
        &data.join("usage.json"),
        &UsageRecord {
            identity: current,
            usage,
        },
    )
}

pub(crate) fn read_usage(
    paths: &ClaudePaths,
    current: Option<&str>,
) -> Result<Option<ClaudeUsage>> {
    let path = paths.data.join("usage.json");
    if current.is_none() || !path.try_exists()? {
        return Ok(None);
    }
    let mut record: UsageRecord = serde_json::from_value(read_json(&path)?)?;
    if Some(record.identity.as_str()) != current {
        return Ok(None);
    }
    let now = Utc::now().timestamp();
    record.usage.stale = now.saturating_sub(record.usage.observed_at) > 300;
    record.usage.five_hour = record.usage.five_hour.filter(|w| w.resets_at > now);
    record.usage.seven_day = record.usage.seven_day.filter(|w| w.resets_at > now);
    if record.usage.five_hour.is_none() && record.usage.seven_day.is_none() {
        return Ok(None);
    }
    Ok(Some(record.usage))
}

/// Executed by Claude, before the desktop app starts. No model requests or
/// credential changes are performed. An existing renderer gets identical stdin.
pub fn run_statusline(path: &Path) -> Result<()> {
    let tracker: Tracker = serde_json::from_value(read_json(path)?)?;
    let mut input = Vec::new();
    std::io::stdin()
        .take(2 * 1024 * 1024)
        .read_to_end(&mut input)?;
    let parsed = serde_json::from_slice::<Value>(&input).ok();
    if let Some(value) = &parsed {
        // A busy account lock must not make the user's original status line fail.
        let _ = collect(
            path.parent().context("Invalid status-line path")?,
            &tracker.metadata,
            value,
            Utc::now().timestamp(),
        );
    }
    if let Some(command) = tracker
        .previous
        .as_ref()
        .and_then(|v| v.get("command"))
        .and_then(Value::as_str)
    {
        anyhow::ensure!(
            !command.contains("--claude-statusline"),
            "Recursive status line"
        );
        std::io::stdout().write_all(&render_previous(&tracker.shell, command, &input)?)?;
    } else {
        let value = parsed.unwrap_or(Value::Null);
        let now = Utc::now().timestamp();
        let parts = [
            ("5h", window(value.pointer("/rate_limits/five_hour"), now)),
            ("7d", window(value.pointer("/rate_limits/seven_day"), now)),
        ]
        .into_iter()
        .filter_map(|(name, window)| {
            window.map(|w| format!("{name}: {:.0}% left", 100.0 - w.used_percent))
        })
        .collect::<Vec<_>>();
        println!(
            "{}",
            if parts.is_empty() {
                "Claude Code".into()
            } else {
                parts.join(" | ")
            }
        );
    }
    Ok(())
}

fn render_previous(shell: &Path, command: &str, input: &[u8]) -> Result<Vec<u8>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        use tokio::io::AsyncWriteExt;
        let mut command_process = tokio::process::Command::new(shell);
        command_process
            .args(["-c", command])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command_process.creation_flags(crate::commands::process::CREATE_NO_WINDOW);
        let mut child = command_process.spawn()?;
        let mut stdin = child.stdin.take().context("Missing renderer stdin")?;
        tokio::time::timeout(Duration::from_secs(4), async {
            let (_written, output) = tokio::join!(
                async {
                    let result = stdin.write_all(input).await;
                    // ChildStdin::shutdown does not close the OS handle. Drop it
                    // before waiting so scripts reading until EOF can finish.
                    drop(stdin);
                    result
                },
                child.wait_with_output()
            );
            // Renderers that ignore stdin can close it early; their valid
            // stdout must survive a broken pipe from the writer.
            Ok::<_, anyhow::Error>(output?.stdout)
        })
        .await
        .context("Previous status line timed out")?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_receives_eof_and_preserves_output_when_stdin_is_ignored() {
        let shell = shell().expect("Bash is required for the status-line integration test");
        let input = b"{\"model\":\"test\",\"transcript_path\":\"unchanged input\"}\n";
        assert_eq!(render_previous(&shell, "cat", input).unwrap(), input);
        assert_eq!(
            render_previous(&shell, "printf 'my status'", &vec![b'x'; 1_000_000]).unwrap(),
            b"my status"
        );
    }

    #[test]
    fn quota_handles_zero_missing_invalid_and_expired_values() {
        assert_eq!(
            window(Some(&json!({"used_percentage":0,"resets_at":200})), 100)
                .unwrap()
                .used_percent,
            0.0
        );
        for value in [
            json!({}),
            json!({"used_percentage":101,"resets_at":200}),
            json!({"used_percentage":5,"resets_at":99}),
        ] {
            assert!(window(Some(&value), 100).is_none());
        }
    }

    #[test]
    fn collector_saves_only_quota_and_rejects_a_session_after_account_changes() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = dir.path().join("metadata.json");
        write_json(
            &metadata,
            &json!({"oauthAccount":{"accountUuid":"a","organizationUuid":"org"}}),
        )
        .unwrap();
        let input = json!({"session_id":"session", "transcript_path":"private", "secret":"not persisted", "rate_limits":{"five_hour":{"used_percentage":25,"resets_at":200}}});
        collect(dir.path(), &metadata, &input, 100).unwrap();
        let first = fs::read_to_string(dir.path().join("usage.json")).unwrap();
        assert!(
            !first.contains("private") && !first.contains("secret") && !first.contains("session")
        );
        write_json(
            &metadata,
            &json!({"oauthAccount":{"accountUuid":"b","organizationUuid":"org"}}),
        )
        .unwrap();
        collect(dir.path(), &metadata, &input, 101).unwrap();
        assert_eq!(
            first,
            fs::read_to_string(dir.path().join("usage.json")).unwrap()
        );
    }

    #[test]
    fn tracker_preserves_and_restores_existing_statusline_and_settings() {
        let dir = tempfile::tempdir().unwrap();
        let paths = ClaudePaths {
            config: dir.path().join("config"),
            metadata: dir.path().join("metadata.json"),
            data: dir.path().join("data"),
            keychain_service: "test".into(),
        };
        let original = json!({"statusLine":{"type":"command","command":"printf 'my status'","padding":2},"permissions":{"allow":["Read"]},"model":"opus"});
        let settings = paths.config.join("settings.json");
        write_json(&settings, &original).unwrap();
        let exe = dir.path().join("switcher with ' quote.exe");
        let shell = dir.path().join("bash");
        set_enabled_at(&paths, Some((&exe, &shell))).unwrap();
        assert!(enabled(&paths).unwrap());
        assert_eq!(read_json(&settings).unwrap()["statusLine"]["padding"], 2);
        set_enabled_at(&paths, Some((&exe, &shell))).unwrap();
        set_enabled_at(&paths, None).unwrap();
        assert_eq!(read_json(&settings).unwrap(), original);
        assert!(!enabled(&paths).unwrap());
    }

    #[test]
    fn disabling_tracking_preserves_a_replacement_configured_by_the_user() {
        let dir = tempfile::tempdir().unwrap();
        let paths = ClaudePaths {
            config: dir.path().join("config"),
            metadata: dir.path().join("metadata.json"),
            data: dir.path().join("data"),
            keychain_service: "test".into(),
        };
        set_enabled_at(
            &paths,
            Some((&dir.path().join("switcher"), &dir.path().join("bash"))),
        )
        .unwrap();
        let settings = paths.config.join("settings.json");
        let replacement = json!({"statusLine":{"type":"command","command":"my-new-renderer"}});
        write_json(&settings, &replacement).unwrap();
        set_enabled_at(&paths, None).unwrap();
        assert_eq!(read_json(&settings).unwrap(), replacement);
    }
}
