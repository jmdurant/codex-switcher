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
    let actual = &response["account"];
    match &account.auth_data {
        AuthData::ApiKey { .. } if actual["type"] == "apiKey" => Ok(()),
        AuthData::ChatGPT { .. } if actual["type"] == "chatgpt"
            && actual["email"].as_str().zip(account.email.as_deref())
                .is_some_and(|(a,b)| a.eq_ignore_ascii_case(b)) => Ok(()),
        _ => bail!("Codex daemon did not confirm the selected account; activation is unverified"),
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use std::{path::PathBuf, sync::OnceLock, time::Duration};
    use tokio::{net::UnixStream, sync::{mpsc, oneshot, Mutex}};
    use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
    type Socket = WebSocketStream<UnixStream>;
    struct Request { account: StoredAccount, reply: oneshot::Sender<Result<()>> }
    static CLIENT: OnceLock<Mutex<Option<mpsc::Sender<Request>>>> = OnceLock::new();

    fn socket_path() -> Result<PathBuf> {
        // Same credential home as auth::switcher, including its default-home policy.
        Ok(dirs::home_dir().context("Home directory unavailable")?
            .join(".codex/app-server-control/app-server-control.sock"))
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

    async fn connect(path: &std::path::Path) -> Result<Socket> {
        let stream = UnixStream::connect(path).await.context("Could not connect to running Codex daemon")?;
        let (mut socket, _) = tokio_tungstenite::client_async("ws://localhost/", stream).await?;
        rpc(&mut socket, 1, "initialize", json!({"clientInfo":{"name":"ai-account-switcher","version":"0.2.13"},
            "capabilities":{"experimentalApi":true}})).await?;
        socket.send(Message::Text(json!({"method":"initialized"}).to_string().into())).await?;
        Ok(socket)
    }

    async fn handoff(socket: &mut Socket, account: &StoredAccount) -> Result<()> {
        rpc(socket, 2, "account/login/start", login_params(account)?).await?;
        let state = rpc(socket, 3, "account/read", json!({"refreshToken":false})).await?;
        verify_identity(account, &state)
    }

    async fn refresh_reply(socket: &mut Socket, request: Value, account: &mut Option<StoredAccount>) -> Result<()> {
        if request.get("id").is_none() || request.get("method").is_none() { return Ok(()); }
        let result = async {
            if request["method"] != "account/chatgptAuthTokens/refresh" { bail!("Unsupported request"); }
            let current = account.as_ref().context("No host-managed account")?;
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

    pub(super) async fn activate(account: &StoredAccount) -> Result<bool> {
        let path = socket_path()?;
        let mut guard = CLIENT.get_or_init(|| Mutex::new(None)).lock().await;
        if guard.as_ref().is_none_or(|tx| tx.is_closed()) {
            if !path.exists() { return Ok(false); }
            let mut socket = tokio::time::timeout(Duration::from_secs(10), connect(&path)).await
                .context("Codex daemon connection timed out")??;
            let (tx, mut rx) = mpsc::channel::<Request>(4);
            tokio::spawn(async move {
                let mut current = None;
                loop {
                    tokio::select! {
                        request = rx.recv() => {
                            let Some(request) = request else { break; };
                            let result = handoff(&mut socket, &request.account).await;
                            if result.is_ok() { current = Some(request.account); }
                            let failed = result.is_err();
                            let _ = request.reply.send(result);
                            if failed { break; }
                        },
                        message = receive(&mut socket) => {
                            let Ok(message) = message else { break; };
                            if message["method"] == "account/updated" && message["params"]["authMode"] != "chatgptAuthTokens" {
                                current = None; // Respect a manual login/logout; never reapply the old account.
                            }
                            if refresh_reply(&mut socket, message, &mut current).await.is_err() { break; }
                        }
                    }
                }
                eprintln!("[DaemonAuth] Account connection closed; the next activation will reconnect");
            });
            *guard = Some(tx);
        }
        let (reply, response) = oneshot::channel();
        guard.as_ref().unwrap().send(Request {account:account.clone(),reply}).await
            .map_err(|_| anyhow::anyhow!("Codex account connection closed"))?;
        drop(guard);
        response.await.context("Codex account handoff interrupted")??;
        println!("[DaemonAuth] Selected account {} verified by running daemon", account.id);
        Ok(true)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[tokio::test]
        async fn handoff_requires_login_ack_and_matching_live_identity() {
            for matches in [true,false] {
                let (client, server) = UnixStream::pair().unwrap();
                let server = tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(server).await.unwrap();
                    let login = receive(&mut ws).await.unwrap();
                    assert_eq!(login["method"],"account/login/start");
                    assert_eq!(login["params"]["chatgptAccountId"],"workspace");
                    ws.send(Message::Text(json!({"id":2,"result":{"type":"chatgptAuthTokens"}}).to_string().into())).await.unwrap();
                    assert_eq!(receive(&mut ws).await.unwrap()["method"],"account/read");
                    ws.send(Message::Text(json!({"id":3,"result":{"account":{"type":"chatgpt","email":if matches {"target@example.com"} else {"old@example.com"}}}}).to_string().into())).await.unwrap();
                });
                let (mut ws,_) = tokio_tungstenite::client_async("ws://localhost/",client).await.unwrap();
                assert_eq!(handoff(&mut ws,&super::super::tests::account()).await.is_ok(),matches);
                server.await.unwrap();
            }
        }
    }
}

pub(crate) async fn activate(account: &StoredAccount) -> Result<bool> {
    #[cfg(unix)] { unix::activate(account).await }
    #[cfg(not(unix))] { let _ = account; Ok(false) }
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
}
