//! macOS integration for the shared Antigravity/agy session.

use anyhow::{Context, Result};
use std::{collections::HashSet, path::Path, process::Command};

pub fn read_credential() -> Result<Vec<u8>> {
    let credential = security_framework::passwords::get_generic_password("gemini", "antigravity")
        .context("Could not read the Antigravity session from Keychain; sign in to Antigravity or agy and allow Keychain access")?;
    anyhow::ensure!(
        !credential.is_empty(),
        "The Antigravity Keychain session is empty; sign in again"
    );
    Ok(credential)
}

pub fn write_credential(value: &[u8]) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty(),
        "The stored Antigravity credential is empty"
    );
    // Update in place through Security.framework; never put tokens in argv.
    security_framework::passwords::set_generic_password("gemini", "antigravity", value)
        .context("Could not update the Antigravity session in Keychain")
}

#[derive(Debug)]
struct Process {
    pid: u32,
    parent: u32,
    uid: u32,
    executable: String,
}

fn parse_process(line: &str) -> Option<Process> {
    let mut rest = line.trim();
    let mut number = || {
        let (head, tail) = rest.split_once(char::is_whitespace)?;
        rest = tail.trim_start();
        head.parse::<u32>().ok()
    };
    let (pid, parent, uid) = (number()?, number()?, number()?);
    (!rest.is_empty()).then(|| Process {
        pid,
        parent,
        uid,
        executable: rest.to_owned(),
    })
}

fn processes() -> Result<Vec<Process>> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,uid=,comm="])
        .output()
        .context("Failed to inspect Antigravity processes")?;
    anyhow::ensure!(
        output.status.success(),
        "Antigravity process inspection failed"
    );
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_process)
        .collect())
}

fn current_uid() -> Result<u32> {
    let output = Command::new("/usr/bin/id").arg("-u").output()?;
    anyhow::ensure!(
        output.status.success(),
        "Could not determine the current user"
    );
    Ok(String::from_utf8_lossy(&output.stdout).trim().parse()?)
}

fn is_antigravity(executable: &str) -> bool {
    let name = Path::new(executable)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("");
    name == "agy"
        || executable.contains("/Antigravity.app/Contents/")
        || executable.contains("/Antigravity IDE.app/Contents/")
}

pub fn running() -> Result<Vec<String>> {
    let uid = current_uid()?;
    Ok(processes()?
        .into_iter()
        .filter(|p| p.uid == uid && is_antigravity(&p.executable))
        .map(|p| format!("{} (PID {})", p.executable, p.pid))
        .collect())
}

fn termination_targets(snapshot: &[Process], uid: u32) -> (usize, HashSet<u32>) {
    let mut targets: HashSet<u32> = snapshot
        .iter()
        .filter(|p| p.uid == uid && is_antigravity(&p.executable))
        .map(|p| p.pid)
        .collect();
    let targeted_count = targets.len();
    // Include terminal agents/helpers owned by this user, never another login.
    loop {
        let previous = targets.len();
        for p in snapshot {
            if p.uid == uid && targets.contains(&p.parent) {
                targets.insert(p.pid);
            }
        }
        if targets.len() == previous {
            break;
        }
    }
    (targeted_count, targets)
}

pub fn kill() -> Result<super::antigravity::KillAntigravityProcessesResult> {
    let uid = current_uid()?;
    let snapshot = processes()?;
    let (targeted_count, targets) = termination_targets(&snapshot, uid);
    anyhow::ensure!(!targets.contains(&std::process::id()),
        "Run AI Account Switcher outside Antigravity's integrated terminal before force-closing Antigravity");
    for pid in &targets {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &pid.to_string()])
            .output();
    }
    std::thread::sleep(std::time::Duration::from_millis(100));
    let remaining: HashSet<u32> = processes()?.iter().map(|p| p.pid).collect();
    let mut result = super::antigravity::KillAntigravityProcessesResult {
        targeted_count,
        killed_process_names: Vec::new(),
        failed_process_names: Vec::new(),
    };
    for p in snapshot.iter().filter(|p| targets.contains(&p.pid)) {
        let name = format!("{} (PID {})", p.executable, p.pid);
        if remaining.contains(&p.pid) {
            result.failed_process_names.push(name);
        } else {
            result.killed_process_names.push(name);
        }
    }
    Ok(result)
}

fn argument(command: &str, flag: &str) -> Option<String> {
    let mut tokens = command.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == flag {
            return tokens
                .next()
                .map(|v| v.trim_matches(['\'', '"']).to_owned());
        }
        if let Some(value) = token.strip_prefix(&format!("{flag}=")) {
            return Some(value.trim_matches(['\'', '"']).to_owned());
        }
    }
    None
}

fn listening_ports(output: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = output
        .lines()
        .filter_map(|line| {
            let address = line.strip_prefix('n')?;
            address
                .rsplit_once(':')?
                .1
                .parse::<u16>()
                .ok()
                .filter(|p| *p != 0)
        })
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

pub fn discover_language_servers() -> Result<Vec<(Vec<u16>, String)>> {
    let uid = current_uid()?;
    let mut servers = Vec::new();
    for process in processes()?
        .iter()
        .filter(|p| p.uid == uid && is_antigravity(&p.executable))
    {
        let name = Path::new(&process.executable)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("");
        if !name.starts_with("language_server") {
            continue;
        }
        let output = Command::new("/bin/ps")
            .args(["-p", &process.pid.to_string(), "-o", "command="])
            .output()?;
        if !output.status.success() {
            continue;
        }
        let command = String::from_utf8_lossy(&output.stdout);
        let Some(csrf) = argument(&command, "--csrf_token").filter(|v| !v.is_empty()) else {
            continue;
        };
        // Query the language server's own sockets. extension_server_port belongs
        // to the editor extension host and is not the quota endpoint.
        let sockets = Command::new("/usr/sbin/lsof")
            .args([
                "-nP",
                "-a",
                "-p",
                &process.pid.to_string(),
                "-iTCP",
                "-sTCP:LISTEN",
                "-Fn",
            ])
            .output()
            .context("Failed to discover Antigravity listening ports")?;
        let ports = listening_ports(&String::from_utf8_lossy(&sockets.stdout));
        if !ports.is_empty() {
            servers.push((ports, csrf));
        }
    }
    anyhow::ensure!(
        !servers.is_empty(),
        "Open Antigravity or Antigravity IDE to retrieve live usage"
    );
    Ok(servers)
}

pub fn open_ide() -> bool {
    Command::new("/usr/bin/open")
        .args(["-b", "com.google.antigravity-ide"])
        .output()
        .is_ok_and(|output| output.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn termination_includes_descendants_but_not_other_users_or_unrelated_apps() {
        let snapshot: Vec<Process> = [
            "10 1 501 /Applications/Antigravity IDE.app/Contents/MacOS/Electron",
            "11 10 501 /bin/zsh",
            "12 11 501 /usr/bin/python3",
            "13 10 502 /bin/zsh",
            "14 1 502 /Users/Other/bin/agy",
            "15 1 501 /Applications/Other.app/Contents/MacOS/Electron",
        ]
        .iter()
        .filter_map(|line| parse_process(line))
        .collect();
        let (count, targets) = termination_targets(&snapshot, 501);
        assert_eq!(count, 1);
        assert_eq!(targets, HashSet::from([10, 11, 12]));
    }

    #[tokio::test]
    #[ignore = "requires a running signed-in Antigravity language server; read-only"]
    async fn live_usage_smoke() {
        let usage = super::super::antigravity::get_live_antigravity_usage()
            .await
            .unwrap();
        println!("Retrieved {} model quota entries", usage.models.len());
    }

    #[test]
    #[ignore = "requires an existing Antigravity Keychain session; read-only"]
    fn keychain_read_smoke() {
        assert!(!read_credential().unwrap().is_empty());
    }
    #[test]
    fn process_paths_preserve_spaces_and_do_not_match_unrelated_apps() {
        let p =
            parse_process(" 123 1 501 /Applications/Antigravity IDE.app/Contents/MacOS/Electron")
                .unwrap();
        assert_eq!((p.pid, p.parent, p.uid), (123, 1, 501));
        assert!(is_antigravity(&p.executable));
        assert!(is_antigravity("/Users/Test User/bin/agy"));
        assert!(!is_antigravity(
            "/Applications/Other.app/Contents/MacOS/Electron"
        ));
        assert!(!is_antigravity("/usr/bin/agy-helper"));
        assert!(parse_process("invalid snapshot").is_none());
    }
    #[test]
    fn extracts_exact_flags_and_ipv4_ipv6_ports() {
        assert_eq!(
            argument(
                "server --csrf_token=abc --extension_server_port 123",
                "--csrf_token"
            )
            .as_deref(),
            Some("abc")
        );
        assert_eq!(
            argument("server --csrf_token 'abc'", "--csrf_token").as_deref(),
            Some("abc")
        );
        assert_eq!(
            argument("server --csrf_token_extra abc", "--csrf_token"),
            None
        );
        assert_eq!(
            listening_ports("p123\nn127.0.0.1:3210\nn[::1]:3210\nn*:1234\nn*:0\n"),
            vec![1234, 3210]
        );
    }
}
