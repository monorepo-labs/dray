//! Remote Dray servers the desktop app is connected to, beside its own
//! in-process core. Each is a `dray-serve` reached over its WebSocket; this
//! module holds the connections so the token never leaves Rust, and the
//! frontend reaches a server through `server_invoke` and hears it through
//! `server_event`. See SERVERS-PLAN.md.
//!
//! The list is device-local: `servers.json` holds id, name and address, and
//! each token sits in `credentials.json` under `server:<id>`, never on a
//! struct the frontend is handed.

use crate::{sink::Sink, ssh, store};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use ts_rs::TS;

/// Stated again from serve.rs's `PROTOCOL`, which this build may not compile.
const PROTOCOL: u32 = 1;

/// How long a probe or a reconnect may take to be admitted.
const ADMIT: Duration = Duration::from_secs(5);

/// Reconnect backoff ceiling. Agents keep running on a server the app cannot
/// reach, so coming back soon matters more than sparing a refused connect.
const MAX_BACKOFF: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Saved {
    id: String,
    name: String,
    /// Empty for an SSH server, whose address is a port forwarded per connect.
    /// Always written: a build from before SSH requires it, and one entry it
    /// cannot parse is the whole list gone.
    #[serde(default)]
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh: Option<ssh::Target>,
    /// The reader turned the connection off; the row stays.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    off: bool,
    /// Fields a newer build wrote, carried back untouched — the index's own
    /// `unknown` bargain, since this file is rewritten whole too.
    #[serde(flatten)]
    unknown: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum ServerStatus {
    Connecting,
    Connected,
    Disconnected,
}

/// A remote server as the frontend sees it. No token: that stays here.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    /// Whether the reader chose `name`, rather than it being the address's
    /// host — so Rename can open empty instead of on a name nobody picked.
    pub named: bool,
    pub url: String,
    /// `ssh user@host` for a server reached through a login, else `None`.
    pub ssh: Option<String>,
    pub on: bool,
    pub status: ServerStatus,
    /// Which step a connect through SSH is on.
    pub stage: Option<ssh::Stage>,
    /// Why the last connect failed, in the server's words where it gave any.
    pub error: Option<String>,
    /// What the reader can do about `error`.
    pub fix: Option<ssh::Fix>,
}

type Reply = Result<Value, Value>;

struct Conn {
    saved: Saved,
    status: ServerStatus,
    stage: Option<ssh::Stage>,
    error: Option<String>,
    fix: Option<ssh::Fix>,
    /// The address and token the open socket was admitted with — for an SSH
    /// server both exist only for the life of one login.
    live: Option<(String, String)>,
    /// Frames to the socket, while one is admitted.
    outgoing: Option<mpsc::UnboundedSender<String>>,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Conn {
    /// A connection to `saved`, running unless it is turned off.
    fn new(saved: Saved) -> Self {
        let status = ServerStatus::Disconnected;
        let mut conn = Conn { saved, status, stage: None, error: None, fix: None, live: None, outgoing: None, pending: HashMap::new(), task: None };
        conn.restart();
        conn
    }

    /// Stops the loop and, unless off, starts it again from scratch.
    fn restart(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.outgoing = None;
        self.live = None;
        self.stage = None;
        self.error = None;
        self.fix = None;
        self.status = ServerStatus::Disconnected;
        if !self.saved.off {
            self.status = ServerStatus::Connecting;
            self.task = Some(tokio::spawn(run(self.saved.id.clone())));
        }
    }
}

/// In `servers.json` order.
static CONNS: LazyLock<Mutex<Vec<Conn>>> = LazyLock::new(Default::default);
static SINK: OnceLock<Sink> = OnceLock::new();
static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
/// Serializes `servers.json` rewrites, like every other whole-file write here.
static SAVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn conns() -> std::sync::MutexGuard<'static, Vec<Conn>> {
    CONNS.lock().unwrap_or_else(|e| e.into_inner())
}

fn credential_name(id: &str) -> String {
    format!("server:{id}")
}

fn info(conn: &Conn) -> ServerInfo {
    ServerInfo {
        id: conn.saved.id.clone(),
        name: conn.saved.name.clone(),
        named: conn.saved.name != unnamed(&conn.saved),
        url: conn.saved.url.clone(),
        ssh: conn.saved.ssh.as_ref().map(ssh::Target::line),
        on: !conn.saved.off,
        status: conn.status,
        stage: conn.stage,
        error: conn.error.clone(),
        fix: conn.fix.clone(),
    }
}

fn snapshot() -> Vec<ServerInfo> {
    conns().iter().map(info).collect()
}

/// Every change — status, add, remove — goes out as the whole list, so the
/// frontend replaces rather than reconciles.
fn announce() {
    if let Some(sink) = SINK.get() {
        let _ = sink.emit("servers_changed", snapshot());
    }
}

async fn servers_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(store::get_home_app_dir().await?.join("servers.json"))
}

async fn save() -> Result<(), String> {
    let _guard = SAVE.lock().await;
    let list: Vec<Saved> = conns().iter().map(|c| c.saved.clone()).collect();
    let path = servers_path().await.map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    store::write_atomic(&path, body).await.map_err(|e| format!("{e:#}"))
}

/// Reads `servers.json` and opens a connection to each. Called once, at setup.
pub async fn start(sink: Sink) {
    let _ = SINK.set(sink);
    let saved: Vec<Saved> = match servers_path().await {
        Ok(path) => store::read_json(&path).await.unwrap_or_else(|e| {
            eprintln!("[servers read err] {e:#}");
            Vec::new()
        }),
        Err(_) => Vec::new(),
    };
    {
        let mut list = conns();
        list.extend(saved.into_iter().map(Conn::new));
    }
    announce();
}

/// Spelled the way a reader types it — `host:port`, `http://…`, `ws://…` —
/// and answered as the `ws://` URL the socket opens.
fn normalize(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let url = if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if url.starts_with("https://") || url.starts_with("wss://") {
        return Err("wss:// is not supported yet — reach the server over an SSH tunnel or Tailscale".into());
    } else if url.starts_with("ws://") {
        url.to_string()
    } else {
        format!("ws://{url}")
    };
    let request = url.as_str().into_client_request().map_err(|e| format!("not an address: {e}"))?;
    if request.uri().host().is_none() {
        return Err("not an address: no host".into());
    }
    Ok(url)
}

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// Connects and says hello. Answers the admitted socket, or why not.
async fn admit(url: &str, token: &str) -> Result<Socket, String> {
    let request = url.into_client_request().map_err(|e| e.to_string())?;
    let host = request.uri().host().unwrap_or_default().trim_matches(['[', ']']).to_string();
    let port = request.uri().port_u16().unwrap_or(80);
    let attempt = async {
        let stream = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("could not reach {url}: {e}"))?;
        let (mut ws, _) = tokio_tungstenite::client_async(request, stream)
            .await
            .map_err(|e| format!("handshake with {url} failed: {e}"))?;
        ws.send(Message::text(json!({ "v": PROTOCOL, "token": token }).to_string()))
            .await
            .map_err(|e| e.to_string())?;
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).unwrap_or_default();
                    return match frame.get("err").and_then(Value::as_str) {
                        Some(err) => Err(format!("the server refused: {err}")),
                        None => Ok(ws),
                    };
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Err(e)) => return Err(e.to_string()),
                _ => return Err("the server closed the connection".to_string()),
            }
        }
    };
    tokio::time::timeout(ADMIT, attempt)
        .await
        .unwrap_or_else(|_| Err(format!("{url} did not answer in time")))
}

fn set_status(id: &str, status: ServerStatus, error: Option<String>) {
    set(id, status, None, error, None);
}

fn set(id: &str, status: ServerStatus, stage: Option<ssh::Stage>, error: Option<String>, fix: Option<ssh::Fix>) {
    {
        let mut list = conns();
        let Some(conn) = list.iter_mut().find(|c| c.saved.id == id) else {
            return;
        };
        conn.status = status;
        conn.stage = stage;
        conn.error = error;
        conn.fix = fix;
        if status != ServerStatus::Connected {
            conn.outgoing = None;
            conn.live = None;
            // A call in flight on a dropped socket has no answer coming.
            for (_, call) in conn.pending.drain() {
                let _ = call.send(Err(json!(format!("lost the connection to {}", conn.saved.name))));
            }
        }
    }
    announce();
}

/// One server's connection, for as long as it is on the list: connect, serve,
/// and on any drop retry with backoff.
///
/// An SSH server opens a fresh login each time round, which also reads the
/// token, so a cut pipe is this same loop plus one `ssh`. A failure retrying
/// cannot fix — a refused key, an unknown host — parks the row instead.
async fn run(id: String) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let Some(saved) = conns().iter().find(|c| c.saved.id == id).map(|c| c.saved.clone()) else {
            return;
        };
        set(&id, ServerStatus::Connecting, saved.ssh.as_ref().map(|_| ssh::Stage::Connecting), None, None);
        let (url, token, tunnel) = match &saved.ssh {
            Some(target) => match ssh::open(target, |stage| set(&id, ServerStatus::Connecting, Some(stage), None, None)).await {
                Ok(tunnel) => (format!("ws://127.0.0.1:{}", tunnel.port), tunnel.token.clone(), Some(tunnel)),
                Err(failure) => {
                    set(&id, ServerStatus::Disconnected, None, Some(failure.message), failure.fix);
                    if failure.permanent {
                        return;
                    }
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            },
            None => (saved.url, crate::issues::credential(&credential_name(&id)).await.unwrap_or_default(), None),
        };
        // Through a tunnel, a refused admit is usually ssh refusing the forward,
        // and ssh's own sentence says that better than a closed socket does.
        let said = |fallback: String| tunnel.as_ref().and_then(ssh::Tunnel::said).unwrap_or(fallback);
        match admit(&url, &token).await {
            Ok(ws) => {
                backoff = Duration::from_secs(1);
                if let Some(conn) = conns().iter_mut().find(|c| c.saved.id == id) {
                    conn.live = Some((url.clone(), token.clone()));
                }
                serve(&id, ws).await;
                set_status(&id, ServerStatus::Disconnected, Some("connection lost".into()));
            }
            Err(e) => set_status(&id, ServerStatus::Disconnected, Some(said(e))),
        }
        drop(tunnel);
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn serve(id: &str, ws: Socket) {
    let (mut write, mut read) = ws.split();
    let (outgoing, mut frames) = mpsc::unbounded_channel::<String>();
    {
        let mut list = conns();
        let Some(conn) = list.iter_mut().find(|c| c.saved.id == id) else {
            return;
        };
        conn.outgoing = Some(outgoing);
        conn.status = ServerStatus::Connected;
        conn.stage = None;
        conn.error = None;
        conn.fix = None;
    }
    announce();
    let writer = tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if write.send(Message::text(frame)).await.is_err() {
                break;
            }
        }
        write.close().await.ok();
    });
    while let Some(Ok(message)) = read.next().await {
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(call) = frame.get("id").and_then(Value::as_u64) {
            let reply = match frame.get("err") {
                Some(err) => Err(err.clone()),
                None => Ok(frame.get("ok").cloned().unwrap_or(Value::Null)),
            };
            let waiter = conns()
                .iter_mut()
                .find(|c| c.saved.id == id)
                .and_then(|c| c.pending.remove(&call));
            if let Some(waiter) = waiter {
                let _ = waiter.send(reply);
            }
        } else if let (Some(event), Some(sink)) = (frame.get("event").and_then(Value::as_str), SINK.get()) {
            let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
            let _ = sink.emit("server_event", json!({ "server": id, "event": event, "payload": payload }));
        }
    }
    writer.abort();
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn list_servers() -> Vec<ServerInfo> {
    snapshot()
}

/// Adds a server once it has admitted the token, so a typo is refused here
/// rather than saved as a row that never connects. An address already on the
/// list is updated in place, which is how a reader reconnects after rotating
/// the server's token.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn add_server(url: String, token: String, name: Option<String>) -> Result<ServerInfo, String> {
    let url = normalize(&url)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("a token is required — it is in the server's serve-token file".into());
    }
    admit(&url, &token).await?.close(None).await.ok();

    let existing = conns().iter().find(|c| c.saved.url == url).map(|c| c.saved.id.clone());
    let id = existing.clone().unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()[..8].to_string());
    crate::issues::set_credential(&credential_name(&id), Some(&token)).await?;
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| default_name(&url));

    {
        let mut list = conns();
        if let Some(conn) = list.iter_mut().find(|c| c.saved.id == id) {
            conn.saved.name = name;
            conn.restart();
        } else {
            list.push(Conn::new(Saved { id: id.clone(), name, url, ssh: None, off: false, unknown: Default::default() }));
        }
    }
    save().await?;
    announce();
    let added = conns().iter().find(|c| c.saved.id == id).map(info);
    added.ok_or_else(|| "the server was removed while it was being added".into())
}

/// The name a server gets when the reader gives none.
fn unnamed(saved: &Saved) -> String {
    match &saved.ssh {
        Some(target) => target.host().to_string(),
        None => default_name(&saved.url),
    }
}

/// The host, which is what a reader would call it if asked.
fn default_name(url: &str) -> String {
    url.into_client_request()
        .ok()
        .and_then(|r| r.uri().host().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

/// Forgets a server and its token. Its agents keep running there; only this
/// app stops listening.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn remove_server(id: String) -> Result<(), String> {
    let removed = {
        let mut list = conns();
        let at = list.iter().position(|c| c.saved.id == id);
        at.map(|at| list.remove(at))
    };
    let Some(conn) = removed else {
        return Ok(());
    };
    if let Some(task) = conn.task {
        task.abort();
    }
    save().await?;
    crate::issues::set_credential(&credential_name(&id), None).await?;
    announce();
    Ok(())
}

/// Adds a server from the line the reader logs in with. One whole connect runs
/// first — login, start the server if stopped, token, admit — and only a
/// server that admitted us is saved, the token form's own rule. Each step goes
/// out as `server_adding` so the dialog can say where it is.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn add_ssh_server(line: String, name: Option<String>) -> Result<ServerInfo, ssh::Failure> {
    let failed = |message: String| ssh::Failure { message, fix: None, permanent: true };
    let target = ssh::parse(&line).map_err(failed)?;
    let tunnel = ssh::open(&target, |stage| {
        if let Some(sink) = SINK.get() {
            let _ = sink.emit("server_adding", stage);
        }
    })
    .await?;
    let url = format!("ws://127.0.0.1:{}", tunnel.port);
    match admit(&url, &tunnel.token).await {
        Ok(mut ws) => drop(ws.close(None).await),
        Err(e) => return Err(failed(tunnel.said().unwrap_or(e))),
    }
    drop(tunnel);

    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| target.host().to_string());
    let id = {
        let mut list = conns();
        if let Some(conn) = list.iter_mut().find(|c| c.saved.ssh.as_ref() == Some(&target)) {
            conn.saved.name = name;
            conn.saved.off = false;
            conn.restart();
            conn.saved.id.clone()
        } else {
            let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
            list.push(Conn::new(Saved { id: id.clone(), name, url: String::new(), ssh: Some(target), off: false, unknown: Default::default() }));
            id
        }
    };
    save().await.map_err(failed)?;
    announce();
    let added = conns().iter().find(|c| c.saved.id == id).map(info);
    added.ok_or_else(|| failed("the server was removed while it was being added".into()))
}

/// Renames a server; an empty name puts back the default, its host. The id is
/// what everything keys on, so nothing else moves.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn rename_server(id: String, name: String) -> Result<(), String> {
    {
        let mut list = conns();
        let saved = &mut list.iter_mut().find(|c| c.saved.id == id).ok_or("no such server")?.saved;
        saved.name = Some(name.trim()).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| unnamed(saved));
    }
    save().await?;
    announce();
    Ok(())
}

/// Turns a server's connection off or back on. Off keeps the row, its name and
/// its token; the app simply stops connecting. On, for a server already on, is
/// Try again: a parked row reconnects, a backoff is skipped.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_server_on(id: String, on: bool) -> Result<(), String> {
    {
        let mut list = conns();
        let conn = list.iter_mut().find(|c| c.saved.id == id).ok_or("no such server")?;
        conn.saved.off = !on;
        conn.restart();
    }
    // The row moves now; the file can follow.
    announce();
    save().await
}

/// The reader said yes to `fingerprint` in the host-key dialog. `line` is the
/// SSH line, from the Add dialog or the row.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn trust_host_key(line: String, fingerprint: String) -> Result<(), String> {
    ssh::trust(&ssh::parse(&line)?, &fingerprint).await
}

/// Sign in on a server: Terminal, already logged in to it, running the
/// agent's login. Same closed set `run_agent_login` takes, so nothing typed in
/// the webview reaches a shell.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn run_server_login(
    server: String,
    harness: crate::harness::Harness,
    provider: Option<String>,
    auth: String,
) -> Result<(), String> {
    let target = conns()
        .iter()
        .find(|c| c.saved.id == server)
        .ok_or("no such server")?
        .saved
        .ssh
        .clone()
        .ok_or("This server was added by address, so there is no login to open. Run the command on it yourself.")?;
    let command = crate::accounts::login_command(harness, provider, &auth)?;
    crate::apps::run_in_terminal(&ssh::terminal_line(&target, &command), "").await
}

/// Reopens every connection, so each server sends a fresh `live_state`. The
/// frontend calls this once its listeners exist: connections opened at setup
/// sent theirs to a webview that was not listening yet, and open cards ride
/// that frame alone.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn reconnect_servers() {
    for conn in conns().iter_mut() {
        conn.restart();
    }
    announce();
}

/// `invoke` on a remote server: the same command, the same arguments, and the
/// answer or rejection as the server gave it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn server_invoke(server: String, cmd: String, args: Value) -> Result<Value, Value> {
    let call = NEXT_CALL.fetch_add(1, Ordering::Relaxed);
    let (reply, answer) = oneshot::channel();
    {
        let mut list = conns();
        let Some(conn) = list.iter_mut().find(|c| c.saved.id == server) else {
            return Err(json!(format!("no server named {server}")));
        };
        let Some(outgoing) = &conn.outgoing else {
            return Err(json!(format!("{} is not connected", conn.saved.name)));
        };
        let frame = json!({ "id": call, "cmd": cmd, "args": args }).to_string();
        if outgoing.send(frame).is_err() {
            return Err(json!(format!("{} is not connected", conn.saved.name)));
        }
        conn.pending.insert(call, reply);
    }
    answer
        .await
        .unwrap_or_else(|_| Err(json!("the connection closed before the server answered")))
}

/// A file on a remote server — an attachment, a recording — fetched through
/// its `/file` route with the token in a header, for the webview's
/// `drayserver://` scheme. The token stays out of every URL the page holds.
pub async fn fetch_file(server: &str, path: &str) -> Result<(String, Vec<u8>), String> {
    let (url, token) = conns()
        .iter()
        .find(|c| c.saved.id == server)
        .ok_or("no such server")?
        .live
        .clone()
        .ok_or("the server is not connected")?;
    let base = url.replacen("ws://", "http://", 1);
    let response = reqwest::Client::new()
        .get(format!("{base}/file"))
        .query(&[("path", path)])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(response.status().to_string());
    }
    let kind = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let body = response.bytes().await.map_err(|e| e.to_string())?;
    Ok((kind, body.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_what_a_reader_types() {
        assert_eq!(normalize("127.0.0.1:7317").unwrap(), "ws://127.0.0.1:7317");
        assert_eq!(normalize("http://box:7317/").unwrap(), "ws://box:7317");
        assert_eq!(normalize(" ws://box:7317 ").unwrap(), "ws://box:7317");
        assert!(normalize("wss://box").is_err());
        assert!(normalize("").is_err());
    }

    #[test]
    fn names_a_server_by_its_host() {
        assert_eq!(default_name("ws://dray-vps:7317"), "dray-vps");
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<(String, Value)>, want: impl Fn(&str, &Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (event, payload) = rx.recv().await.expect("sink closed");
                if want(&event, &payload) {
                    return payload;
                }
            }
        })
        .await
        .expect("no such event in time")
    }

    /// Against a running `dray-serve`, in a throwaway `DRAY_HOME`:
    ///
    /// ```text
    /// DRAY_TEST_SERVER=127.0.0.1:7318 DRAY_TEST_TOKEN=$(cat …/serve-token) \
    ///   cargo test servers::tests::talks_to_a_live_server -- --ignored
    /// ```
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn talks_to_a_live_server() {
        let url = std::env::var("DRAY_TEST_SERVER").expect("DRAY_TEST_SERVER");
        let token = std::env::var("DRAY_TEST_TOKEN").expect("DRAY_TEST_TOKEN");
        let home = std::env::temp_dir().join(format!("dray-servers-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("DRAY_HOME", &home);

        let (tx, mut rx) = mpsc::unbounded_channel();
        start(Sink::new(move |event, payload| {
            let _ = tx.send((event.to_string(), payload));
        }))
        .await;

        let refused = add_server(url.clone(), "wrong".into(), None).await.unwrap_err();
        assert!(refused.contains("wrong token"), "{refused}");
        assert!(list_servers().is_empty(), "a refused token is not saved");

        let added = add_server(url, token.clone(), Some("vps".into())).await.unwrap();
        next_event(&mut rx, |e, p| e == "servers_changed" && p[0]["status"] == "connected").await;
        // Every connect opens with `live_state`, and it arrives tagged.
        let live = next_event(&mut rx, |e, p| e == "server_event" && p["event"] == "live_state").await;
        assert_eq!(live["server"], added.id.as_str());

        let projects = server_invoke(added.id.clone(), "list_projects".into(), json!({})).await.unwrap();
        assert!(projects.is_array());
        let unknown = server_invoke(added.id.clone(), "open_in_app".into(), json!({})).await.unwrap_err();
        assert!(unknown.as_str().unwrap().contains("unknown command"));

        // The token sits in credentials.json, never beside the address.
        let saved = std::fs::read_to_string(home.join("servers.json")).unwrap();
        assert!(!saved.contains(&token));
        assert_eq!(crate::issues::credential(&credential_name(&added.id)).await.as_deref(), Some(token.as_str()));

        reconnect_servers();
        next_event(&mut rx, |e, p| e == "server_event" && p["event"] == "live_state").await;

        remove_server(added.id.clone()).await.unwrap();
        assert!(list_servers().is_empty());
        assert_eq!(crate::issues::credential(&credential_name(&added.id)).await, None);
        let gone = server_invoke(added.id, "list_projects".into(), json!({})).await.unwrap_err();
        assert!(gone.as_str().unwrap().contains("no server"));
    }

    /// Through a real SSH login, in a throwaway `DRAY_HOME`. Kills the `ssh`
    /// process mid-connection and waits for the loop to log in again.
    ///
    /// ```text
    /// DRAY_TEST_SSH="ssh root@host" cargo test servers::tests::reconnects_through_ssh -- --ignored
    /// ```
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn reconnects_through_ssh() {
        let line = std::env::var("DRAY_TEST_SSH").expect("DRAY_TEST_SSH");
        let home = std::env::temp_dir().join(format!("dray-ssh-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("DRAY_HOME", &home);
        let (tx, mut rx) = mpsc::unbounded_channel();
        start(Sink::new(move |event, payload| {
            let _ = tx.send((event.to_string(), payload));
        }))
        .await;

        let added = add_ssh_server(line, Some("vps".into())).await.map_err(|f| f.message).unwrap();
        next_event(&mut rx, |e, p| e == "servers_changed" && p[0]["status"] == "connected").await;
        let saved = std::fs::read_to_string(home.join("servers.json")).unwrap();
        assert!(saved.contains("\"dest\""), "{saved}");
        assert_eq!(crate::issues::credential(&credential_name(&added.id)).await, None, "no token stored");
        assert!(server_invoke(added.id.clone(), "list_projects".into(), json!({})).await.is_ok());

        let port = conns()[0].live.clone().unwrap().0.rsplit(':').next().unwrap().to_string();
        let killed = std::process::Command::new("pkill")
            .args(["-f", &format!("127.0.0.1:{port}:127.0.0.1:7317")])
            .status()
            .unwrap();
        assert!(killed.success(), "no ssh to kill");
        next_event(&mut rx, |e, p| e == "servers_changed" && p[0]["status"] == "disconnected").await;
        next_event(&mut rx, |e, p| e == "servers_changed" && p[0]["stage"] == "finding").await;
        next_event(&mut rx, |e, p| e == "servers_changed" && p[0]["status"] == "connected").await;
        assert!(server_invoke(added.id.clone(), "list_projects".into(), json!({})).await.is_ok());

        rename_server(added.id.clone(), " box ".into()).await.unwrap();
        assert_eq!(list_servers()[0].name, "box");
        assert!(std::fs::read_to_string(home.join("servers.json")).unwrap().contains("\"box\""));
        assert!(list_servers()[0].named);
        rename_server(added.id.clone(), "  ".into()).await.unwrap();
        assert!(!list_servers()[0].named, "empty puts the host back");

        set_server_on(added.id.clone(), false).await.unwrap();
        assert!(!list_servers()[0].on);
        assert!(server_invoke(added.id.clone(), "list_projects".into(), json!({})).await.is_err());
        set_server_on(added.id.clone(), true).await.unwrap();
        next_event(&mut rx, |e, p| e == "servers_changed" && p[0]["status"] == "connected").await;
        remove_server(added.id).await.unwrap();
    }
}
