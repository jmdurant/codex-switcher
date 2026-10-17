//! Account handoff to the existing Codex daemon. Never starts or stops a daemon.
use crate::types::{AuthData, StoredAccount};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

fn login_params(account: &StoredAccount) -> Result<Value> {
    match &account.auth_data {
        AuthData::ChatGPT { access_token, account_id: Some(workspace), .. }
            if !access_token.is_empty() && !workspace.is_empty() && account.email.as_ref().is_some_and(|e| !e.is_empty()) =>
            Ok(json!({"type":"chatgptAuthTokens", "accessToken":access_token,
                "chatgptAccountId":workspace, "chatgptPlanType":account.plan_type})),
        AuthData::ApiKey { key } => Ok(json!({"type":"apiKey","apiKey":key})),
        _ => bail!("Cannot activate daemon login without a verified email and workspace"),
    }
}

fn verify_identity(account: &StoredAccount, response: &Value) -> Result<()> {
    // Email cannot distinguish workspaces. Never log this response or pass its
    // token across frontend IPC: compare the exact runtime credential internally.
    let expected = match &account.auth_data {
        AuthData::ApiKey { key } => key,
        AuthData::ChatGPT { access_token, .. } => access_token,
    };
    if expected.is_empty() || response["authToken"].as_str() != Some(expected.as_str()) {
        bail!("Codex daemon did not confirm the selected credential; activation is unverified");
    }
    Ok(())
}

mod runtime {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use std::{path::PathBuf, sync::OnceLock, time::Duration};
    use tokio::{io::{AsyncRead, AsyncWrite}, sync::{mpsc, oneshot, Mutex}};
    use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
    trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
    impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}
    type Socket = WebSocketStream<Box<dyn Transport>>;
    struct Connection { socket: Socket, _proxy: Option<tokio::process::Child> }
    struct Request { account: StoredAccount, verify_only: bool, reply: oneshot::Sender<Result<()>> }
    struct Client { path: PathBuf, tx: mpsc::Sender<Request> }
    static CLIENT: OnceLock<Mutex<Option<Client>>> = OnceLock::new();

    fn socket_path() -> Result<PathBuf> {
        Ok(crate::auth::get_codex_home()?.join("app-server-control/app-server-control.sock"))
    }

    async fn receive(socket: &mut Socket) -> Result<Value> {
        loop {
            match socket.next().await.context("Codex daemon disconnected")?? {
                Message::Text(text) => return serde_json::from_str(&text).context("Invalid daemon response"),
                Message::Ping(data) => socket.send(Message::Pong(data)).await?,
                Message::Close(_) => bail!("Codex daemon disconnected"),
                _ => {},
            }
        }
    }

    async fn rpc(socket: &mut Socket, id: u64, method: &str, params: Value) -> Result<Value> {
        socket.send(Message::Text(json!({"id":id,"method":method,"params":params}).to_string().into())).await?;
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let value = receive(socket).await?;
                if value["id"] == id && value.get("method").is_none() {
                    if value.get("error").is_some() {
                        // Never log server error bodies: they may contain credentials.
                        bail!("Codex rejected {method} (code {})", value["error"]["code"]);
                    }
                    return Ok(value["result"].clone());
                }
                if value.get("id").is_some() && value.get("method").is_some() {
                    socket.send(Message::Text(json!({"id":value["id"],"error":{"code":-32603,
                        "message":"Account activation in progress; retry authentication"}}).to_string().into())).await?;
                }
            }
        }).await.context("Codex account activation timed out")?
    }

    async fn connect(path: &std::path::Path) -> Result<Connection> {
        #[cfg(unix)]
        let (stream, proxy): (Box<dyn Transport>, Option<tokio::process::Child>) =
            (Box::new(tokio::net::UnixStream::connect(path).await.context("Could not connect to running Codex daemon")?), None);
        #[cfg(windows)]
        let (stream, proxy): (Box<dyn Transport>, Option<tokio::process::Child>) = {
            use std::process::Stdio;
            let mut child = tokio::process::Command::new(super::codex_executable()?)
                .args(["app-server", "proxy", "--sock"]).arg(path)
                .env("CODEX_HOME", crate::auth::get_codex_home()?)
                .creation_flags(crate::commands::process::CREATE_NO_WINDOW)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
                .kill_on_drop(true).spawn().context("Could not connect the Codex daemon proxy")?;
            let input = child.stdin.take().context("Daemon proxy input unavailable")?;
            let output = child.stdout.take().context("Daemon proxy output unavailable")?;
            (Box::new(tokio::io::join(output, input)), Some(child))
        };
        let (mut socket, _) = tokio_tungstenite::client_async("ws://localhost/", stream).await?;
        rpc(&mut socket, 1, "initialize", json!({"clientInfo":{"name":"ai-account-switcher","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true}})).await?;
        socket.send(Message::Text(json!({"method":"initialized"}).to_string().into())).await?;
        Ok(Connection { socket, _proxy: proxy })
    }

    async fn verify(socket: &mut Socket, account: &StoredAccount) -> Result<()> {
        let state = rpc(socket, 3, "getAuthStatus", json!({"includeToken":true,"refreshToken":false})).await?;
        verify_identity(account, &state)
    }

    async fn handoff(socket: &mut Socket, account: &StoredAccount) -> Result<()> {
        let params = login_params(account)?;
        let expected_type = params["type"].clone();
        let ack = rpc(socket, 2, "account/login/start", params).await?;
        if ack["type"] != expected_type { bail!("Codex did not acknowledge the requested login mode"); }
        verify(socket, account).await
    }

    async fn refresh_reply(socket: &mut Socket, request: Value, account: &mut Option<StoredAccount>) -> Result<()> {
        if request.get("id").is_none() || request.get("method").is_none() { return Ok(()); }
        let result = async {
            if request["method"] != "account/chatgptAuthTokens/refresh" { bail!("Unsupported request"); }
            let current = account.as_ref().context("No host-managed account")?;
            // A different client can replace external-token auth with another
            // external-token login, including another user in this workspace.
            verify(socket, current).await?;
            let params = login_params(current)?;
            if request["params"]["previousAccountId"].as_str()
                .is_some_and(|id| Some(id) != params["chatgptAccountId"].as_str()) {
                bail!("Account changed; refusing a refresh for a different workspace");
            }
            let refreshed = crate::auth::token_refresh::refresh_host_managed_tokens(current).await?;
            let mut result = login_params(&refreshed)?;
            result.as_object_mut().unwrap().remove("type");
            *account = Some(refreshed);
            Ok::<_, anyhow::Error>(result)
        }.await;
        let reply = match result {
            Ok(result) => json!({"id":request["id"],"result":result}),
            Err(_) => json!({"id":request["id"],"error":{"code":-32603,"message":"Unable to refresh selected account; sign in again"}}),
        };
        socket.send(Message::Text(reply.to_string().into())).await?;
        Ok(())
    }

    pub(super) async fn activate(account: &StoredAccount, verify_only: bool) -> Result<bool> {
        let path = socket_path()?;
        let mut guard = CLIENT.get_or_init(|| Mutex::new(None)).lock().await;
        if guard.as_ref().is_none_or(|client| client.path != path || client.tx.is_closed()) {
            if !super::daemon_running(&path).await? { *guard = None; return Ok(false); }
            let mut connection = tokio::time::timeout(Duration::from_secs(10), connect(&path)).await
                .context("Codex daemon connection timed out")??;
            let (tx, mut rx) = mpsc::channel::<Request>(4);
            tokio::spawn(async move {
                let mut current = None;
                loop {
                    tokio::select! {
                        request = rx.recv() => {
                            let Some(request) = request else { break; };
                            let result = if request.verify_only { verify(&mut connection.socket, &request.account).await }
                                else { handoff(&mut connection.socket, &request.account).await };
                            if result.is_ok() && !request.verify_only { current = Some(request.account); }
                            let failed = result.is_err();
                            let _ = request.reply.send(result);
                            if failed { break; }
                        },
                        message = receive(&mut connection.socket) => {
                            let Ok(message) = message else { break; };
                            if message["method"] == "account/updated" && message["params"]["authMode"] != "chatgptAuthTokens" {
                                current = None; // Respect a manual login/logout; never reapply the old account.
                            }
                            if refresh_reply(&mut connection.socket, message, &mut current).await.is_err() { break; }
                        }
                    }
                }
                eprintln!("[DaemonAuth] Account connection closed; the next activation will reconnect");
            });
            *guard = Some(Client { path, tx });
        }
        let (reply, response) = oneshot::channel();
        guard.as_ref().unwrap().tx.send(Request {account:account.clone(),verify_only,reply}).await
            .map_err(|_| anyhow::anyhow!("Codex account connection closed"))?;
        drop(guard);
        tokio::time::timeout(Duration::from_secs(25), response).await
            .context("Codex account handoff timed out")?.context("Codex account handoff interrupted")??;
        Ok(true)
    }

    pub(super) async fn clear() -> Result<()> {
        let path = socket_path()?;
        if !super::daemon_running(&path).await? { return Ok(()); }
        let mut connection = tokio::time::timeout(Duration::from_secs(10), connect(&path)).await
            .context("Codex daemon connection timed out")??;
        rpc(&mut connection.socket, 2, "account/logout", json!({})).await?;
        let status = rpc(&mut connection.socket, 3, "getAuthStatus", json!({"includeToken":true,"refreshToken":false})).await?;
        if !status["authToken"].is_null() { bail!("Codex did not confirm restoration of the signed-out state"); }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[tokio::test]
        #[ignore = "read-only probe requiring a locally running Codex daemon"]
        async fn local_daemon_transport_supports_exact_credential_verification() {
            let mut connection = connect(&socket_path().unwrap()).await.unwrap();
            let state = rpc(&mut connection.socket, 10, "getAuthStatus", json!({"includeToken":true,"refreshToken":false})).await.unwrap();
            let token = state["authToken"].as_str().expect("The local daemon must be signed in");
            // Verify the transport and token comparison without login/logout,
            // writing credentials, or printing the returned secret.
            let account = StoredAccount::new_api_key("read-only probe".into(), token.into());
            assert!(verify(&mut connection.socket,&account).await.is_ok());
        }
        #[tokio::test]
        async fn handoff_requires_login_ack_and_matching_live_identity() {
            for matches in [true,false] {
                let (client, server) = tokio::io::duplex(8192);
                let server = tokio::spawn(async move {
                    let transport: Box<dyn Transport> = Box::new(server);
                    let mut ws = tokio_tungstenite::accept_async(transport).await.unwrap();
                    let login = receive(&mut ws).await.unwrap();
                    assert_eq!(login["method"],"account/login/start");
                    assert_eq!(login["params"]["chatgptAccountId"],"workspace");
                    ws.send(Message::Text(json!({"id":2,"result":{"type":"chatgptAuthTokens"}}).to_string().into())).await.unwrap();
                    assert_eq!(receive(&mut ws).await.unwrap()["method"],"getAuthStatus");
                    ws.send(Message::Text(json!({"id":3,"result":{"authToken":if matches {"token"} else {"old-token"}}}).to_string().into())).await.unwrap();
                });
                let transport: Box<dyn Transport> = Box::new(client);
                let (mut ws,_) = tokio_tungstenite::client_async("ws://localhost/",transport).await.unwrap();
                assert_eq!(handoff(&mut ws,&super::super::tests::account()).await.is_ok(),matches);
                server.await.unwrap();
            }
        }
    }
}

pub(crate) async fn activate(account: &StoredAccount) -> Result<bool> {
    runtime::activate(account, false).await
}

pub(crate) async fn verify_active(account: &StoredAccount) -> Result<bool> {
    runtime::activate(account, true).await
}

pub(crate) async fn clear() -> Result<()> { runtime::clear().await }

#[cfg(windows)]
fn codex_executable() -> Result<std::path::PathBuf> {
    use std::path::PathBuf;
    let home = crate::auth::get_codex_home()?;
    let mut candidates = vec![home.join("packages/app-server-daemon/current/bin/codex.exe")];
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default();
    if let Some(roaming) = std::env::var_os("APPDATA") { directories.push(PathBuf::from(roaming).join("npm")); }
    for directory in directories {
        candidates.push(directory.join("codex.exe"));
        for (arch, triple) in [("x64", "x86_64-pc-windows-msvc"), ("arm64", "aarch64-pc-windows-msvc")] {
            let vendor = directory.join(format!("node_modules/@openai/codex/node_modules/@openai/codex-win32-{arch}/vendor/{triple}"));
            candidates.push(vendor.join("bin/codex.exe"));
            candidates.push(vendor.join("codex/codex.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file()).context("Codex CLI was not found; install it or add it to PATH")
}

async fn daemon_running(path: &std::path::Path) -> Result<bool> {
    #[cfg(unix)] { return Ok(path.exists()); }
    #[cfg(windows)] {
        // A managed Windows AF_UNIX endpoint may be absent from directory
        // listings, but its daemon ownership record remains on disk.
        if !path.exists() && !crate::auth::get_codex_home()?.join("app-server-daemon/daemon.pid").exists() {
            return Ok(false);
        }
        let output = tokio::time::timeout(std::time::Duration::from_secs(8),
            tokio::process::Command::new(codex_executable()?)
                .args(["app-server", "daemon", "version"])
                .env("CODEX_HOME", crate::auth::get_codex_home()?)
                .creation_flags(crate::commands::process::CREATE_NO_WINDOW)
                .kill_on_drop(true).output()).await.context("Codex daemon status timed out")??;
        if !output.status.success() { bail!("Could not inspect Codex daemon status; update the Codex CLI"); }
        let value: Value = serde_json::from_slice(&output.stdout).context("Invalid Codex daemon status")?;
        match value["status"].as_str() {
            Some("running") => Ok(true),
            Some("stopped" | "notRunning" | "not_running") => Ok(false),
            _ => bail!("Codex daemon state is unknown; activation was not attempted"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn account() -> StoredAccount {
        serde_json::from_value(json!({"id":"target","name":"target","email":"target@example.com", "plan_type":"team",
            "auth_mode":"chat_g_p_t", "auth_data":{"type":"chat_g_p_t","id_token":"id","access_token":"token",
            "refresh_token":"refresh","account_id":"workspace"},"created_at":"2026-01-01T00:00:00Z","last_used_at":null})).unwrap()
    }
    #[test]
    fn same_workspace_different_user_is_not_verified() {
        assert!(verify_identity(&account(), &json!({"account":{"type":"chatgpt","email":"other@example.com"}})).is_err());
    }
    #[test]
    fn same_email_is_not_proof_of_the_selected_workspace_credential() {
        assert!(verify_identity(&account(), &json!({"authToken":"other-token", "account":{"type":"chatgpt","email":"target@example.com"}})).is_err());
        assert!(verify_identity(&account(), &json!({"authToken":"token"})).is_ok());
    }
}
