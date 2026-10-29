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

/// A remote socket can die without closing — the Mac sleeps, the network
/// moves, a tunnel drops it — and then nothing reaches `run`'s retry and a
/// call waits forever. So a remote is pinged, and one silent for `SILENCE`
/// is dropped. The server answers pings from its read loop, which never
/// blocks on a command.
const PING: Duration = if cfg!(test) { Duration::from_millis(100) } else { Duration::from_secs(15) };
const SILENCE: Duration = if cfg!(test) { Duration::from_millis(500) } else { Duration::from_secs(45) };

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
    /// The server takes beta releases, which also means stable ones. Its own,
    /// never the app's. A bool rather than a channel enum: a value an older
    /// build cannot spell fails the line, and one line is the whole list.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    beta: bool,
    /// A release the reader chose to ignore. Only that one: a newer release
    /// is offered again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ignored: Option<String>,
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
    /// The CLI release the server runs, once it has said. `None` from a server
    /// that never connected, predates saying, or is a local build.
    pub release: Option<String>,
    /// The server takes beta releases.
    pub beta: bool,
    /// The newer release out on its channel, while the server is behind it.
    pub latest: Option<String>,
    /// An update landed on the server and it restarts onto it once idle.
    pub restarting: bool,
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
    /// Dev-server ports forwarded for the Mac's browser, by remote port. They
    /// last as long as the connection does.
    forwards: HashMap<u16, ssh::Forward>,
    /// What the server said when last admitted, kept across a drop so the row
    /// still says what it last knew. `None` until it first connects.
    met: Option<Welcome>,
}

impl Conn {
    /// A connection to `saved`, running unless it is turned off.
    fn new(saved: Saved) -> Self {
        let status = ServerStatus::Disconnected;
        let mut conn = Conn {
            saved,
            status,
            stage: None,
            error: None,
            fix: None,
            live: None,
            outgoing: None,
            pending: HashMap::new(),
            task: None,
            forwards: HashMap::new(),
            met: None,
        };
        conn.restart();
        conn
    }

    /// Stops the loop and, unless off, starts it again from scratch.
    fn restart(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        for (_, call) in self.pending.drain() {
            let _ = call.send(Err(json!(format!("lost the connection to {}", self.saved.name))));
        }
        self.outgoing = None;
        self.live = None;
        self.forwards.clear();
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
        release: conn.met.as_ref().and_then(|w| w.release.clone()),
        beta: conn.saved.beta,
        latest: latest(conn),
        restarting: conn.met.as_ref().is_some_and(|w| w.stale),
    }
}

/// The newer release out on a server's channel, unless it is the one the
/// reader ignored or the server is not behind it.
fn latest(conn: &Conn) -> Option<String> {
    let releases = releases();
    let newest = releases.newest(conn.saved.beta)?.to_string();
    let behind = conn.met.as_ref().is_some_and(|w| behind(w, conn.saved.beta, &releases));
    (behind && conn.saved.ignored.as_ref() != Some(&newest)).then_some(newest)
}

/// The newest CLI releases out, each channel's. A `dray-serve` ships in them.
#[derive(Debug, Clone, Default)]
struct Releases {
    stable: Option<semver::Version>,
    beta: Option<semver::Version>,
}

impl Releases {
    /// From GitHub's tags, the way install.sh reads them: `cli-v` and a
    /// version, a prerelease one being a beta. Newest by semver, so a beta
    /// sorts below its own release.
    fn from_tags<'a>(tags: impl Iterator<Item = &'a str>) -> Self {
        let mut out = Releases::default();
        for v in tags.filter_map(|t| semver::Version::parse(t.strip_prefix("cli-v")?).ok()) {
            let slot = if v.pre.is_empty() { &mut out.stable } else { &mut out.beta };
            if slot.as_ref().is_none_or(|have| v > *have) {
                *slot = Some(v);
            }
        }
        out
    }

    /// The newest a server on this channel would install. Beta takes stable
    /// releases too, so whichever is newer.
    fn newest(&self, beta: bool) -> Option<&semver::Version> {
        if beta { self.stable.as_ref().max(self.beta.as_ref()) } else { self.stable.as_ref() }
    }
}

/// Whether a newer release than the one a server runs is out on its channel.
/// One that says no version predates saying, so anything out is newer; one
/// with a version and no release is a local build and is never offered one.
/// A server ahead of its channel — beta left behind — is not behind, so
/// leaving beta never downgrades.
fn behind(met: &Welcome, beta: bool, releases: &Releases) -> bool {
    let Some(newest) = releases.newest(beta) else { return false };
    if met.version.is_none() {
        return true;
    }
    met.release.as_deref().and_then(|r| semver::Version::parse(r).ok()).is_some_and(|r| r < *newest)
}

/// How long one reading of GitHub's releases stands. Unauthenticated, the API
/// allows 60 reads an hour from one address, shared with the installer.
const RELEASES_FRESH: Duration = Duration::from_secs(60 * 60);

static RELEASES: Mutex<Option<(std::time::Instant, Releases)>> = Mutex::new(None);

fn releases() -> Releases {
    RELEASES.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(_, r)| r.clone()).unwrap_or_default()
}

/// Reads GitHub's releases again where the last reading is older than
/// `fresh`, then redraws the rows. A failed read keeps the last reading, and
/// says why for a caller the reader is waiting on.
async fn refresh_releases(fresh: Duration) -> Result<(), String> {
    let held = RELEASES.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|(at, _)| at.elapsed() < fresh);
    if held {
        return Ok(());
    }
    let read = async {
        let list: Vec<Value> = crate::http()
            .get("https://api.github.com/repos/monorepo-labs/dray/releases?per_page=100")
            .header("User-Agent", "dray")
            .timeout(Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok::<_, reqwest::Error>(Releases::from_tags(list.iter().filter_map(|r| r["tag_name"].as_str())))
    };
    match read.await {
        Ok(found) => {
            *RELEASES.lock().unwrap_or_else(|e| e.into_inner()) = Some((std::time::Instant::now(), found));
            announce();
            Ok(())
        }
        Err(e) => {
            eprintln!("[servers] could not read releases: {e}");
            Err(format!("Couldn't check for updates: {e}"))
        }
    }
}

/// "This Mac": the background server launchd runs from this app's own
/// binary, held here like any remote one so the frontend reaches both the
/// same way. Never saved and never on the Servers page's list. Its id is
/// `transport.ts`'s `LOCAL`. See MAC-SERVER-PLAN.md.
pub const LOCAL: &str = "local";

/// The remote servers, in `servers.json` order.
fn snapshot() -> Vec<ServerInfo> {
    conns().iter().filter(|c| c.saved.id != LOCAL).map(info).collect()
}

/// Every change — status, add, remove — goes out as the whole list, so the
/// frontend replaces rather than reconciles. This Mac rides its own event.
fn announce() {
    if let Some(sink) = SINK.get() {
        let _ = sink.emit("servers_changed", snapshot());
        let _ = sink.emit("local_server_changed", local_server());
    }
}

/// This Mac's server, as the remote ones are drawn.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn local_server() -> Option<ServerInfo> {
    conns().iter().find(|c| c.saved.id == LOCAL).map(info)
}

/// Where this Mac's server is listening and its token, both read again each
/// connect since a restart may pick a new port — and whether it runs a binary
/// older than this one's, per the stamp it wrote under the port.
async fn local_address() -> Result<(String, String, bool), String> {
    let home = store::get_home_app_dir().await.map_err(|e| e.to_string())?;
    let port_file = tokio::fs::read_to_string(home.join(crate::serve::PORT_FILE)).await.unwrap_or_default();
    let mut lines = port_file.lines();
    let port: u16 = lines.next().and_then(|p| p.trim().parse().ok()).ok_or("The server on this Mac is starting.")?;
    let stale = crate::serve::exe_stamp().is_some_and(|now| lines.next().map(str::trim) != Some(now.as_str()));
    let token = tokio::fs::read_to_string(home.join("serve-token")).await.map_err(|_| "The server on this Mac is starting.")?;
    Ok((format!("ws://127.0.0.1:{port}"), token.trim().to_string(), stale))
}

async fn servers_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(store::get_home_app_dir().await?.join("servers.json"))
}

async fn save() -> Result<(), String> {
    let _guard = SAVE.lock().await;
    let list: Vec<Saved> = conns().iter().filter(|c| c.saved.id != LOCAL).map(|c| c.saved.clone()).collect();
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
        let this_mac = Saved {
            id: LOCAL.into(),
            name: "This Mac".into(),
            url: String::new(),
            ssh: None,
            off: false,
            beta: false,
            ignored: None,
            unknown: Default::default(),
        };
        list.push(Conn::new(this_mac));
        list.extend(saved.into_iter().map(Conn::new));
    }
    announce();
    // Hourly, for an app left open for days on a connection that never drops.
    tokio::spawn(async {
        loop {
            if conns().iter().any(|c| c.saved.id != LOCAL) {
                let _ = refresh_releases(RELEASES_FRESH).await;
            }
            tokio::time::sleep(RELEASES_FRESH).await;
        }
    });
}

/// Spelled the way a reader types it — `host:port`, `http://…`, `ws://…`, or
/// a tunnel's `https://…`/`wss://…` — and answered as the URL the socket opens.
fn normalize(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let url = if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if url.starts_with("ws://") || url.starts_with("wss://") {
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

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The server's first frame once admitted: its core version, the CLI release
/// it shipped in, and whether an update already landed on disk that it is not
/// running yet. A server from before sends none of them.
#[derive(Debug, Default, Deserialize)]
struct Welcome {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    release: Option<String>,
    #[serde(default)]
    stale: bool,
    /// `std::env::consts::OS` on the server.
    #[serde(default)]
    os: Option<String>,
}

/// Connects and says hello. Answers the admitted socket, or why not.
async fn admit(url: &str, token: &str) -> Result<(Socket, Welcome), String> {
    // `counts`: this app reports the sessions it starts there, so the server
    // must not. This Mac's own server is reached through `admit_as_host`
    // instead and counts its sessions itself.
    admit_with(url, json!({ "v": PROTOCOL, "token": token, "counts": true })).await
}

/// This Mac's own server, which may call back into the app: browser steps go
/// to the app's Chromium where this build has one.
async fn admit_as_host(url: &str, token: &str) -> Result<(Socket, Welcome), String> {
    let browser = cfg!(all(feature = "cef", target_os = "macos"));
    admit_with(url, json!({ "v": PROTOCOL, "token": token, "host": { "browser": browser } })).await
}

async fn admit_with(url: &str, hello: Value) -> Result<(Socket, Welcome), String> {
    let attempt = async {
        let (mut ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| format!("could not reach {url}: {e}"))?;
        ws.send(Message::text(hello.to_string()))
            .await
            .map_err(|e| e.to_string())?;
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).unwrap_or_default();
                    return match frame.get("err").and_then(Value::as_str) {
                        Some(err) => Err(format!("the server refused: {err}")),
                        None => Ok((ws, serde_json::from_value(frame).unwrap_or_default())),
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
            conn.forwards.clear();
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
        if id == LOCAL {
            match local_address().await {
                Ok((url, token, stale)) => match admit_as_host(&url, &token).await {
                    Ok((mut ws, _)) => {
                        if stale || crate::launchd::reload_pending() {
                            // The reply has no waiter and is dropped.
                            let restart = json!({ "id": 0, "cmd": "restart_when_idle", "args": {} });
                            let _ = ws.send(Message::text(restart.to_string())).await;
                        }
                        if let Some(conn) = conns().iter_mut().find(|c| c.saved.id == id) {
                            conn.live = Some((url, token));
                        }
                        serve(&id, ws).await;
                        set_status(&id, ServerStatus::Disconnected, Some("The server on this Mac restarted.".into()));
                        if let Err(e) = crate::launchd::reload_if_pending().await {
                            eprintln!("[launchd] could not load the new agent: {e:#}");
                        }
                    }
                    Err(e) => set_status(&id, ServerStatus::Disconnected, Some(e)),
                },
                Err(e) => set_status(&id, ServerStatus::Disconnected, Some(e)),
            }
            // launchd brings it back within seconds; a dev build, or one off
            // a Mac, has to ask.
            if crate::launchd::as_child() {
                let _ = crate::launchd::ensure().await;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        let kept_token = crate::issues::credential(&credential_name(&id)).await.unwrap_or_default();
        // `admitted` is a socket the SSH fallback already opened, kept rather
        // than thrown away and opened a second time.
        let (url, token, tunnel, admitted) = match &saved.ssh {
            Some(target) => match ssh::open(target, |stage| set(&id, ServerStatus::Connecting, Some(stage), None, None)).await {
                Ok(tunnel) => {
                    remember_address(&id, tunnel.address.as_deref(), &tunnel.token).await;
                    (format!("ws://127.0.0.1:{}", tunnel.port), tunnel.token.clone(), Some(tunnel), None)
                }
                Err(failure) => {
                    // No login, but the server's tunnel address from the last
                    // one that worked, with the token it read.
                    let fallback =
                        if saved.url.is_empty() { None } else { admit(&saved.url, &kept_token).await.ok() };
                    if let Some(ws) = fallback {
                        (saved.url, kept_token, None, Some(ws))
                    } else {
                        set(&id, ServerStatus::Disconnected, None, Some(failure.message), failure.fix);
                        if failure.permanent {
                            return;
                        }
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                        continue;
                    }
                }
            },
            None => (saved.url, kept_token, None, None),
        };
        // Through a tunnel, a refused admit is usually ssh refusing the forward,
        // and ssh's own sentence says that better than a closed socket does.
        let said = |fallback: String| tunnel.as_ref().and_then(ssh::Tunnel::said).unwrap_or(fallback);
        let admitted = match admitted {
            Some(ws) => Ok(ws),
            None => admit(&url, &token).await,
        };
        match admitted {
            Ok((mut ws, welcome)) => {
                backoff = Duration::from_secs(1);
                // Once a day per route, so it reads as servers in use rather
                // than as reconnects. Tags alone: never the address or name.
                let via = if tunnel.is_some() { "ssh" } else { "address" };
                crate::analytics::track_daily(
                    "feature_used",
                    format!("server_connected:{via}"),
                    json!({ "feature": "server_connected", "via": via }),
                );
                // This Mac's rule: a server running older code than its own
                // binary restarts once idle. Covers a `dray update` run by
                // hand there too.
                if welcome.stale {
                    let restart = json!({ "id": 0, "cmd": "restart_when_idle", "args": {} });
                    let _ = ws.send(Message::text(restart.to_string())).await;
                }
                if let Some(conn) = conns().iter_mut().find(|c| c.saved.id == id) {
                    conn.live = Some((url.clone(), token.clone()));
                    conn.met = Some(welcome);
                }
                // The hourly read skips a launch with no servers, so a server
                // added since would wait an hour for its row to say anything.
                tokio::spawn(refresh_releases(RELEASES_FRESH));
                serve(&id, ws).await;
                set_status(&id, ServerStatus::Disconnected, Some("connection lost".into()));
            }
            Err(_) if tunnel.is_none() && saved.ssh.is_none() && tunnel_gone(&url).await => {
                // Retrying an address Cloudflare has let go of fixes nothing.
                set(
                    &id,
                    ServerStatus::Disconnected,
                    None,
                    Some("The server's tunnel has a new address. Paste it here: dray service status on the server prints it.".into()),
                    Some(ssh::Fix::NewAddress),
                );
                return;
            }
            Err(e) => set_status(&id, ServerStatus::Disconnected, Some(said(e))),
        }
        drop(tunnel);
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// Keeps an SSH server's tunnel address beside its login, with the token the
/// login read, so the next connect can go by tunnel where SSH cannot. No
/// tunnel up there forgets both: a stale address would only ever fail.
async fn remember_address(id: &str, address: Option<&str>, token: &str) {
    let url = address.and_then(|a| normalize(a).ok()).unwrap_or_default();
    let moved = {
        let mut list = conns();
        let Some(conn) = list.iter_mut().find(|c| c.saved.id == id) else { return };
        let moved = conn.saved.url != url;
        conn.saved.url = url.clone();
        moved
    };
    let stored = (!url.is_empty()).then_some(token);
    if crate::issues::credential(&credential_name(id)).await.as_deref() != stored {
        let _ = crate::issues::set_credential(&credential_name(id), stored).await;
    }
    if moved {
        let _ = save().await;
    }
}

/// Whether a Cloudflare quick tunnel's address is one Cloudflare no longer
/// serves — rather than this Mac being offline, or the server behind a live
/// address being down. Servers tunnelled that way before #518, which come back
/// under an OpenTunnel address once updated. Measured: a stopped tunnel's
/// host answers 530 while its DNS lingers, then stops resolving at all; a live
/// tunnel with nothing behind it answers 502.
async fn tunnel_gone(url: &str) -> bool {
    // The host alone, or a port or a trailing slash fails the suffix check.
    let host = reqwest::Url::parse(url).ok().filter(|u| u.scheme() == "wss").and_then(|u| u.host_str().map(str::to_owned));
    let Some(host) = host.filter(|h| h.ends_with(".trycloudflare.com")) else {
        return false;
    };
    let probe = crate::http().get(format!("https://{host}/")).timeout(ADMIT).send().await;
    match probe {
        Ok(answer) => answer.status().as_u16() == 530,
        // Unresolvable, while Cloudflare's own name resolves: the address,
        // not the network.
        Err(e) if e.is_connect() => {
            tokio::net::lookup_host((host.as_str(), 443)).await.is_err()
                && tokio::net::lookup_host(("trycloudflare.com", 443)).await.is_ok()
        }
        Err(_) => false,
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
    // This Mac's server is loopback, which cannot die silently.
    let remote = id != LOCAL;
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING);
        loop {
            let message = tokio::select! {
                frame = frames.recv() => match frame {
                    Some(frame) => Message::text(frame),
                    None => break,
                },
                _ = ping.tick(), if remote => Message::Ping(Default::default()),
            };
            if write.send(message).await.is_err() {
                break;
            }
        }
        write.close().await.ok();
    });
    let silence = if remote { SILENCE } else { Duration::MAX };
    while let Ok(Some(Ok(message))) = tokio::time::timeout(silence, read.next()).await {
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        // The server calling back into the app, which only its own may.
        if let (Some(call), true) = (frame.get("call").and_then(Value::as_u64), id == LOCAL) {
            let outgoing = conns().iter().find(|c| c.saved.id == id).and_then(|c| c.outgoing.clone());
            let (cmd, args) = (frame["cmd"].as_str().unwrap_or_default().to_string(), frame["args"].clone());
            tokio::spawn(async move {
                let reply = match crate::orchestration::answer_host(&cmd, args).await {
                    Ok(ok) => json!({ "reply": call, "ok": ok }),
                    Err(err) => json!({ "reply": call, "err": err }),
                };
                if let Some(outgoing) = outgoing {
                    let _ = outgoing.send(reply.to_string());
                }
            });
        } else if let Some(call) = frame.get("id").and_then(Value::as_u64) {
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
    let existing = conns().iter().find(|c| c.saved.url == url).map(|c| c.saved.id.clone());
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| default_name(&url));
    refuse_taken(&conns(), &name, existing.as_deref())?;
    admit(&url, &token).await?.0.close(None).await.ok();

    let id = existing.clone().unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()[..8].to_string());
    crate::issues::set_credential(&credential_name(&id), Some(&token)).await?;

    let placed = {
        let mut list = conns();
        // Again under the lock: the admit above awaits, and another add may
        // have taken the name, or saved this address, meanwhile.
        let raced = existing.is_none() && list.iter().any(|c| c.saved.url == url);
        let free = match raced {
            true => Err(format!("{url} was added while this was connecting")),
            false => refuse_taken(&list, &name, Some(&id)),
        };
        free.map(|()| {
            if let Some(conn) = list.iter_mut().find(|c| c.saved.id == id) {
                conn.saved.name = name;
                conn.restart();
            } else {
                list.push(Conn::new(Saved { id: id.clone(), name, url, ssh: None, off: false, beta: false, ignored: None, unknown: Default::default() }));
            }
        })
    };
    if let Err(e) = placed {
        // A new machine's token has no row to be removed from, so it goes now.
        if existing.is_none() {
            crate::issues::set_credential(&credential_name(&id), None).await.ok();
        }
        return Err(e);
    }
    save().await?;
    announce();
    crate::analytics::track("feature_used", json!({ "feature": "server_added", "via": "address" }));
    let added = conns().iter().find(|c| c.saved.id == id).map(info);
    added.ok_or_else(|| "the server was removed while it was being added".into())
}

/// Points a server added by address at a new one, keeping its token: what a
/// quick tunnel restarting asks of the reader. Admitted before it is saved,
/// like an add.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_server_address(id: String, url: String) -> Result<(), String> {
    let url = normalize(&url)?;
    let token = crate::issues::credential(&credential_name(&id)).await.unwrap_or_default();
    admit(&url, &token).await?.0.close(None).await.ok();
    {
        let mut list = conns();
        let conn = list.iter_mut().find(|c| c.saved.id == id).ok_or("no such server")?;
        let was_default = conn.saved.name == unnamed(&conn.saved);
        conn.saved.url = url;
        // A name nobody picked was the old address's host; it follows.
        if was_default {
            conn.saved.name = unnamed(&conn.saved);
        }
        conn.saved.off = false;
        conn.restart();
    }
    announce();
    save().await
}

/// A name is how `dray --machine <name>` picks one server, so two may not
/// share it. `except` is the server being renamed or re-added, which may keep
/// its own.
fn refuse_taken(list: &[Conn], name: &str, except: Option<&str>) -> Result<(), String> {
    match list.iter().any(|c| c.saved.id != LOCAL && Some(c.saved.id.as_str()) != except && c.saved.name == name) {
        true => Err(format!("another server is already named {name} — pick another name")),
        false => Ok(()),
    }
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
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| target.host().to_string());
    let existing = conns().iter().find(|c| c.saved.ssh.as_ref() == Some(&target)).map(|c| c.saved.id.clone());
    refuse_taken(&conns(), &name, existing.as_deref()).map_err(failed)?;
    let tunnel = ssh::open(&target, |stage| {
        if let Some(sink) = SINK.get() {
            let _ = sink.emit("server_adding", stage);
        }
    })
    .await?;
    let url = format!("ws://127.0.0.1:{}", tunnel.port);
    match admit(&url, &tunnel.token).await {
        Ok((mut ws, _)) => drop(ws.close(None).await),
        Err(e) => return Err(failed(tunnel.said().unwrap_or(e))),
    }
    drop(tunnel);

    let id = {
        let mut list = conns();
        // Again under the lock, for the token form's reason.
        let existing = list.iter().find(|c| c.saved.ssh.as_ref() == Some(&target)).map(|c| c.saved.id.clone());
        refuse_taken(&list, &name, existing.as_deref()).map_err(failed)?;
        if let Some(conn) = list.iter_mut().find(|c| c.saved.ssh.as_ref() == Some(&target)) {
            conn.saved.name = name;
            conn.saved.off = false;
            conn.restart();
            conn.saved.id.clone()
        } else {
            let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
            list.push(Conn::new(Saved { id: id.clone(), name, url: String::new(), ssh: Some(target), off: false, beta: false, ignored: None, unknown: Default::default() }));
            id
        }
    };
    save().await.map_err(failed)?;
    announce();
    crate::analytics::track("feature_used", json!({ "feature": "server_added", "via": "ssh" }));
    let added = conns().iter().find(|c| c.saved.id == id).map(info);
    added.ok_or_else(|| failed("the server was removed while it was being added".into()))
}

/// What a server with no Dray on it already has, for the install dialog.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn survey_server(line: String) -> Result<ssh::Survey, ssh::Failure> {
    let target = ssh::parse(&line).map_err(|message| ssh::Failure { message, fix: None, permanent: true })?;
    ssh::survey(&target).await
}

/// Installs Dray and the picked tools on a server and starts it there. Its
/// output streams as `server_installing`, keyed by the line, so a dialog
/// closed meanwhile simply stops listening.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn install_on_server(line: String, picks: Vec<String>) -> Result<(), ssh::Failure> {
    let target = ssh::parse(&line).map_err(|message| ssh::Failure { message, fix: None, permanent: true })?;
    ssh::install(&target, &picks, |text| {
        if let Some(sink) = SINK.get() {
            let _ = sink.emit("server_installing", json!({ "line": line, "text": text }));
        }
    })
    .await
}

/// Renames a server; an empty name puts back the default, its host. The id is
/// what everything keys on, so nothing else moves.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn rename_server(id: String, name: String) -> Result<(), String> {
    {
        let mut list = conns();
        let saved = &list.iter().find(|c| c.saved.id == id).ok_or("no such server")?.saved;
        let name = Some(name.trim()).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| unnamed(saved));
        refuse_taken(&list, &name, Some(&id))?;
        list.iter_mut().find(|c| c.saved.id == id).expect("found above").saved.name = name;
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
/// the webview reaches a shell. No `auth` is the composer's logged-out notice,
/// which names a harness alone and runs the login line it shows.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn run_server_login(
    server: String,
    harness: crate::harness::Harness,
    provider: Option<String>,
    auth: Option<String>,
) -> Result<(), String> {
    let command = match auth {
        Some(auth) => crate::accounts::login_command(harness, provider, &auth)?,
        None => harness.login_command().to_string(),
    };
    run_on_server(&server, &command).await
}

/// Sign `gh` in, on this Mac (`None`) or on a server, in Terminal the way
/// [`run_server_login`] signs in an agent. Takes no command: `gh` is not a
/// harness, and the line is fixed here.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn run_gh_login(server: Option<String>) -> Result<(), String> {
    match server {
        Some(server) => run_on_server(&server, GH_LOGIN).await,
        None => crate::apps::run_in_terminal(GH_LOGIN, "").await,
    }
}

/// HTTPS and the browser flow named up front, so the only questions left are
/// the device code and whether git should use the token, which agents pushing
/// from a server want. A headless server cannot open the browser itself; gh
/// says so and prints the URL, which Terminal on this Mac makes clickable.
const GH_LOGIN: &str = "gh auth login --hostname github.com --git-protocol https --web";

async fn run_on_server(server: &str, command: &str) -> Result<(), String> {
    let target = conns()
        .iter()
        .find(|c| c.saved.id == server)
        .ok_or("no such server")?
        .saved
        .ssh
        .clone()
        .ok_or("This server was added by address, so there is no login to open. Run the command on it yourself.")?;
    crate::apps::run_in_terminal(&ssh::terminal_line(&target, command), "").await
}

/// Reopens every connection, so each server sends a fresh `live_state`. The
/// frontend calls this once its listeners exist: connections opened at setup
/// sent theirs to a webview that was not listening yet, and open cards ride
/// that frame alone.
///
/// This Mac's server is asked for the frame instead: the webview's first
/// reads are already waiting on that connection, and dropping it would fail
/// every one of them.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn reconnect_servers() {
    for conn in conns().iter_mut().filter(|c| c.saved.id != LOCAL) {
        conn.restart();
    }
    announce();
    tokio::spawn(async {
        let Ok(state) = server_invoke(LOCAL.into(), "live_state".into(), Value::Null).await else {
            return;
        };
        if let Some(sink) = SINK.get() {
            let _ = sink.emit("server_event", json!({ "server": LOCAL, "event": "live_state", "payload": state }));
        }
    });
}

/// `invoke` on a remote server: the same command, the same arguments, and the
/// answer or rejection as the server gave it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn server_invoke(server: String, cmd: String, args: Value) -> Result<Value, Value> {
    // This Mac's server is down only while it starts or restarts — seconds —
    // and every screen reads it at launch, so a call waits for it rather
    // than failing into an error the reader sees for nothing.
    // ponytail: polled; a Notify on connect if the 100ms ever shows.
    if server == LOCAL {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !conns().iter().any(|c| c.saved.id == LOCAL && c.outgoing.is_some())
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let counts = server != LOCAL && cmd == "send_msg";
    // The server skips both for this app, which reports them instead. Only
    // the webview reaches this command, so a send here is somebody pressing it.
    let created = (counts && args["isNewSession"] == true).then(|| args["sessionId"].as_str().map(str::to_string)).flatten();
    if counts {
        crate::analytics::track_active_day();
    }
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
    let answer = answer
        .await
        .unwrap_or_else(|_| Err(json!("the connection closed before the server answered")));
    // A created session answers with its snapshot, `null` otherwise. One the
    // server wrote in a shape this build cannot read goes uncounted.
    if let Some(id) = created {
        let item = match &answer {
            Ok(ok) => store::SessionIndexItem::deserialize(&ok["snapshot"]).ok(),
            // The row is written before the spawn, so a create failing after
            // it still started a session — the rule the local count follows.
            Err(_) => Box::pin(server_invoke(server.clone(), "session_index_item".into(), json!({ "sessionId": id })))
                .await
                .ok()
                .and_then(|row| store::SessionIndexItem::deserialize(&row).ok()),
        };
        if let Some(item) = item {
            let os = conns().iter().find(|c| c.saved.id == server).and_then(|c| c.met.as_ref()?.os.clone());
            crate::analytics::remote_session_started(&item, os.as_deref());
        }
    }
    answer
}

/// Asks `server` to update itself on its own channel. Answers `"restarting"` —
/// marked on the row at once, since nothing else will say so until the
/// restart — or `"current"`, where the channel had nothing newer.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_server(server: String) -> Result<String, String> {
    let beta = conns().iter().find(|c| c.saved.id == server).is_some_and(|c| c.saved.beta);
    let channel = if beta { "beta" } else { "stable" };
    let reply = server_invoke(server.clone(), "update_server".into(), json!({ "channel": channel })).await;
    let answer = match reply {
        Ok(answer) => answer.as_str().unwrap_or_default().to_string(),
        Err(err) => {
            let err = err.as_str().map_or_else(|| err.to_string(), str::to_owned);
            return Err(if err.starts_with("unknown command") {
                "This server is too old to update from the app. Update it once on the server: dray update, then restart it.".into()
            } else {
                err
            });
        }
    };
    if answer == "restarting" {
        if let Some(met) = conns().iter_mut().find(|c| c.saved.id == server).and_then(|c| c.met.as_mut()) {
            met.stale = true;
        }
        announce();
    }
    Ok(answer)
}

/// Restarts `server` now, stopping every turn running there.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn restart_server_now(server: String) -> Result<(), String> {
    match server_invoke(server, "restart_now".into(), Value::Null).await {
        Ok(_) => Ok(()),
        Err(err) => Err(err.as_str().map_or_else(|| err.to_string(), str::to_owned)),
    }
}

/// The connected servers an app update offers to update beside itself: behind
/// on their own channel, and on beta where the app is, since a beta app's
/// release says nothing about the stable channel. Releases are read again
/// first, as the app's own release is usually what just came out. One from
/// before `update_server` is left to its row, which says how.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn servers_behind(beta: bool) -> Vec<String> {
    // A failed read leaves the last one, which still answers.
    let _ = refresh_releases(Duration::from_secs(60)).await;
    conns()
        .iter()
        .filter(|c| c.saved.id != LOCAL && c.status == ServerStatus::Connected && (c.saved.beta || !beta))
        .filter(|c| c.met.as_ref().is_some_and(|w| w.version.is_some()) && latest(c).is_some())
        .map(|c| c.saved.id.clone())
        .collect()
}

/// Stops offering `version` on a server's row and in an app update.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ignore_server_update(id: String, version: String) -> Result<(), String> {
    {
        let mut list = conns();
        let conn = list.iter_mut().find(|c| c.saved.id == id).ok_or("no such server")?;
        conn.saved.ignored = Some(version);
    }
    announce();
    save().await
}

/// Reads the releases again now and answers the newer one out, or `None` for
/// up to date. Asked for by the reader, so an ignored release is offered again.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn check_server_update(id: String) -> Result<Option<String>, String> {
    let unignored = {
        let mut list = conns();
        let conn = list.iter_mut().find(|c| c.saved.id == id).ok_or("no such server")?;
        conn.saved.ignored.take().is_some()
    };
    if unignored {
        save().await?;
    }
    announce();
    refresh_releases(Duration::ZERO).await?;
    Ok(conns().iter().find(|c| c.saved.id == id).and_then(latest))
}

/// Puts a server on beta or back on stable. Leaving beta keeps the build it
/// has until a stable release passes it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_server_beta(id: String, beta: bool) -> Result<(), String> {
    {
        let mut list = conns();
        let conn = list.iter_mut().find(|c| c.saved.id == id).ok_or("no such server")?;
        conn.saved.beta = beta;
    }
    announce();
    save().await
}

/// A local port carrying dev-server `port` on `server`, for the Mac's own
/// browser to open. One per port for the life of the connection, so clicking
/// the row again reuses it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn forward_port(server: String, port: u16) -> Result<u16, String> {
    let target = {
        let mut list = conns();
        let conn = list.iter_mut().find(|c| c.saved.id == server).ok_or("that server is no longer on the list")?;
        if let Some(open) = live_forward(conn, port) {
            return Ok(open);
        }
        if conn.status != ServerStatus::Connected {
            return Err(format!("{} is not connected", conn.saved.name));
        }
        conn.saved.ssh.clone().ok_or_else(|| {
            format!(
                "{} was added by address, so there is no SSH login to forward port {port} over. \
                 Add it again from its SSH line to open its dev servers here.",
                conn.saved.name
            )
        })?
    };
    let forward = ssh::forward(&target, port).await?;
    let mut list = conns();
    let conn = list
        .iter_mut()
        .find(|c| c.saved.id == server && c.status == ServerStatus::Connected)
        .ok_or("lost the connection to the server")?;
    // Two clicks racing: the first forward to land wins, so a page already
    // open on it keeps working.
    if let Some(open) = live_forward(conn, port) {
        return Ok(open);
    }
    let local = forward.port;
    conn.forwards.insert(port, forward);
    Ok(local)
}

/// The local port of a forward still running; one whose `ssh` died is
/// replaced.
fn live_forward(conn: &mut Conn, port: u16) -> Option<u16> {
    let forward = conn.forwards.get_mut(&port)?;
    forward.alive().then_some(forward.port)
}

/// A file on a remote server — an attachment, a recording — fetched through
/// its `/file` route with the token in a header, for the webview's
/// `drayserver://` scheme. The token stays out of every URL the page holds.
pub async fn fetch_file(server: &str, path: &str) -> Result<(String, Vec<u8>), String> {
    let (base, token) = http_base(server)?;
    let response = crate::http()
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

/// The `http(s)://` address and token of a connected server, for the routes
/// it serves beside its socket.
fn http_base(server: &str) -> Result<(String, String), String> {
    let (url, token) = conns()
        .iter()
        .find(|c| c.saved.id == server)
        .ok_or("no such server")?
        .live
        .clone()
        .ok_or("the server is not connected")?;
    let base = match url.strip_prefix("wss://") {
        Some(rest) => format!("https://{rest}"),
        None => url.replacen("ws://", "http://", 1),
    };
    Ok((base, token))
}

/// Copies a file on this Mac to `server` and answers where it landed there —
/// what a send names in its place, since the server cannot read a path on this
/// Mac. Streamed, with `upload_progress` `{id, sent, total}` per chunk read, so
/// the composer's tile can say how far it has got.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn upload_attachment(server: String, path: String, id: String) -> Result<String, String> {
    use tokio::io::AsyncReadExt;

    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let unreadable = |e: std::io::Error| format!("Could not read {name}: {e}");
    let file = tokio::fs::File::open(&path).await.map_err(unreadable)?;
    let total = file.metadata().await.map_err(unreadable)?.len();
    if total > crate::attachments::MAX_UPLOAD_BYTES {
        return Err(format!("{name} is over 100MB, the most a remote server takes."));
    }
    let (base, token) = http_base(&server)?;

    let chunks = futures_util::stream::unfold((file, 0u64), move |(mut file, sent)| {
        let id = id.clone();
        async move {
            let mut buf = vec![0; 256 * 1024];
            let n = match file.read(&mut buf).await {
                Ok(0) => return None,
                Ok(n) => n,
                Err(e) => return Some((Err(e), (file, sent))),
            };
            buf.truncate(n);
            let sent = sent + n as u64;
            if let Some(sink) = SINK.get() {
                let _ = sink.emit("upload_progress", json!({ "id": id, "sent": sent, "total": total }));
            }
            Some((Ok(buf), (file, sent)))
        }
    });
    let failed = |e: reqwest::Error| format!("Could not upload {name}: {e}");
    let response = crate::http()
        .post(format!("{base}/upload"))
        .query(&[("name", name.as_str())])
        .bearer_auth(&token)
        // The route reads exactly this many bytes and refuses a chunked body.
        .header(reqwest::header::CONTENT_LENGTH, total)
        .body(reqwest::Body::wrap_stream(chunks))
        .send()
        .await
        .map_err(failed)?;
    // A server older than this route reads the request as a socket handshake
    // and refuses it, which is the one cure worth naming.
    if !response.status().is_success() {
        return Err(format!(
            "Could not upload {name} ({}). Update Dray on the server if it is older than this app.",
            response.status()
        ));
    }
    response.text().await.map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_server_behind_its_channel() {
        let out = Releases::from_tags(
            ["v0.29.0", "cli-v0.12.0-beta.2", "cli-v0.11.1", "cli-v0.12.0-beta.10", "cli-v0.9.0", "nonsense"].into_iter(),
        );
        assert_eq!(out.stable.as_ref().map(ToString::to_string).as_deref(), Some("0.11.1"));
        assert_eq!(out.beta.as_ref().map(ToString::to_string).as_deref(), Some("0.12.0-beta.10"), "numeric, not lexical");

        let on = |release: &str| Welcome { version: Some("0.28.0".into()), release: Some(release.into()), stale: false, os: None };
        assert!(behind(&on("0.11.0"), false, &out));
        assert!(!behind(&on("0.11.1"), false, &out));
        assert!(!behind(&on("0.11.1"), false, &Releases::default()), "nothing out is nothing to update to");
        assert!(behind(&on("0.11.1"), true, &out), "beta takes betas");
        assert!(behind(&on("0.12.0-beta.2"), true, &out));
        assert!(!behind(&on("0.12.0-beta.10"), false, &out), "leaving beta never downgrades");

        let released = Releases::from_tags(["cli-v0.12.0", "cli-v0.12.0-beta.10"].into_iter());
        assert!(behind(&on("0.12.0-beta.10"), true, &released), "a beta sorts below its own release");

        let old = Welcome::default();
        assert!(behind(&old, false, &out), "a server that says nothing predates saying");
        let local = Welcome { version: Some("0.28.0".into()), release: None, stale: false, os: None };
        assert!(!behind(&local, true, &out), "a local build is never offered one");
    }

    /// Against GitHub itself, which refuses a request with no User-Agent.
    #[tokio::test]
    #[ignore]
    async fn reads_the_live_releases() {
        refresh_releases(Duration::ZERO).await.unwrap();
        let found = releases();
        assert!(found.stable.is_some(), "{found:?}");
        eprintln!("{found:?}");
    }

    #[test]
    fn normalizes_what_a_reader_types() {
        assert_eq!(normalize("127.0.0.1:7317").unwrap(), "ws://127.0.0.1:7317");
        assert_eq!(normalize("http://box:7317/").unwrap(), "ws://box:7317");
        assert_eq!(normalize(" ws://box:7317 ").unwrap(), "ws://box:7317");
        assert_eq!(normalize("https://a-b.trycloudflare.com/").unwrap(), "wss://a-b.trycloudflare.com");
        assert_eq!(normalize("wss://a-b.trycloudflare.com").unwrap(), "wss://a-b.trycloudflare.com");
        assert!(normalize("").is_err());
    }

    /// A name picks one server for `--machine`, so a second one may not take
    /// it — but the server already holding it may, which is a rename to itself
    /// or a re-add after rotating a token. This Mac's row is no name to route to.
    #[test]
    fn a_name_belongs_to_one_server() {
        let saved = |id: &str, name: &str| Saved { id: id.into(), name: name.into(), url: String::new(), ssh: None, off: true, beta: false, ignored: None, unknown: Default::default() };
        let list = vec![Conn::new(saved("a", "vps")), Conn::new(saved(LOCAL, "This Mac"))];
        assert!(refuse_taken(&list, "vps", None).is_err());
        assert!(refuse_taken(&list, "vps", Some("b")).is_err());
        assert!(refuse_taken(&list, "vps", Some("a")).is_ok());
        assert!(refuse_taken(&list, "This Mac", None).is_ok());
    }

    /// Turning a server off must answer the calls already sent to it: no run
    /// loop is left to drain them, so they would wait for ever.
    #[test]
    fn turning_off_answers_calls_in_flight() {
        let saved = Saved { id: "s".into(), name: "box".into(), url: String::new(), ssh: None, off: true, beta: false, ignored: None, unknown: Default::default() };
        let mut conn = Conn::new(saved);
        let (reply, mut answer) = oneshot::channel();
        conn.pending.insert(1, reply);
        conn.restart();
        assert!(answer.try_recv().unwrap().is_err());
    }

    /// A server that admits, then either reads (so tungstenite answers our
    /// pings) or goes quiet the way a dead tunnel does.
    async fn fake_server(answers: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            ws.next().await;
            ws.send(Message::text(json!({ "v": PROTOCOL }).to_string())).await.unwrap();
            if answers {
                while ws.next().await.is_some() {}
            } else {
                std::future::pending::<()>().await;
            }
        });
        url
    }

    async fn served_for(id: &str, answers: bool) -> Option<()> {
        let saved = Saved { id: id.into(), name: id.into(), url: String::new(), ssh: None, off: true, beta: false, ignored: None, unknown: Default::default() };
        conns().push(Conn::new(saved));
        let (ws, _) = admit(&fake_server(answers).await, "t").await.unwrap();
        let served = tokio::time::timeout(SILENCE * 3, serve(id, ws)).await.ok();
        // `CONNS` is shared, and the live tests read it from row 0.
        conns().retain(|c| c.saved.id != id);
        served
    }

    #[tokio::test]
    async fn drops_a_server_gone_silent() {
        assert!(served_for("silent", false).await.is_some(), "a silent server is dropped");
        assert!(served_for("alive", true).await.is_none(), "a server answering pings is kept");
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

        // Idle past `SILENCE`: the server's pongs keep the connection.
        tokio::time::sleep(SILENCE * 3).await;
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

    /// Against a server running `dray server tunnel on`, reached over SSH only
    /// to restart it. A server added by its tunnel address comes back at the
    /// same address after a restart, with nothing asked of the reader; an SSH
    /// server records the address and connects by it when the login fails.
    ///
    /// ```text
    /// DRAY_TEST_SSH="ssh root@host" cargo test servers::tests::keeps_the_tunnels_address -- --ignored --nocapture
    /// ```
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn keeps_the_tunnels_address() {
        let line = std::env::var("DRAY_TEST_SSH").expect("DRAY_TEST_SSH");
        let target = ssh::parse(&line).unwrap();
        let on_server = |cmd: &str| {
            let out = std::process::Command::new("ssh").args(["-o", "BatchMode=yes", "--", &target.dest, cmd]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let address = || on_server("cat ~/.dray/tunnel-url");
        let connected = |what: &str| {
            let t0 = std::time::Instant::now();
            while list_servers()[0].status != ServerStatus::Connected {
                assert!(t0.elapsed() < Duration::from_secs(90), "never connected {what}: {:?}", list_servers()[0].error);
                std::thread::sleep(Duration::from_millis(200));
            }
            eprintln!("connected {what} in {:?}", t0.elapsed());
        };
        let home = std::env::temp_dir().join(format!("dray-tunnel-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("DRAY_HOME", &home);
        start(Sink::new(|_, _| {})).await;
        let token = on_server("cat ~/.dray/serve-token");
        let first = address();
        assert!(first.ends_with(".opentunnel.xyz"), "is the tunnel on? {first}");

        // By address alone, as another Mac with no SSH would add it.
        let added = add_server(first.clone(), token.clone(), Some("tunnel".into())).await.unwrap();
        connected("by address");
        assert!(server_invoke(added.id.clone(), "list_projects".into(), json!({})).await.is_ok());

        // A restart: the same address, and the row reconnects on its own.
        on_server("systemctl --user restart dray");
        let t0 = std::time::Instant::now();
        while address() != first {
            assert!(t0.elapsed() < Duration::from_secs(60), "the address moved or never came back: {}", address());
            std::thread::sleep(Duration::from_millis(500));
        }
        eprintln!("same address after a restart, in {:?}", t0.elapsed());
        // No Try again: a call fails on the dead socket until the row has
        // found its own way back.
        let t0 = std::time::Instant::now();
        let call = || tokio::time::timeout(Duration::from_secs(5), server_invoke(added.id.clone(), "list_projects".into(), json!({})));
        while !matches!(call().await, Ok(Ok(_))) {
            assert!(t0.elapsed() < Duration::from_secs(90), "never came back: {:?}", list_servers()[0].error);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        eprintln!("answered after the restart in {:?}", t0.elapsed());
        assert!(list_servers()[0].fix.is_none(), "asked the reader for something");
        remove_server(added.id).await.unwrap();

        // Over SSH: the address rides the login.
        let added = add_ssh_server(line, Some("vps".into())).await.map_err(|f| f.message).unwrap();
        connected("by SSH");
        assert_eq!(list_servers()[0].url, first.replacen("https://", "wss://", 1));
        assert!(!std::fs::read_to_string(home.join("servers.json")).unwrap().contains(&token));

        // No login: a destination that answers nothing, and the tunnel instead.
        conns().iter_mut().find(|c| c.saved.id == added.id).unwrap().saved.ssh =
            Some(ssh::Target { dest: "root@192.0.2.1".into(), port: None });
        set_server_on(added.id.clone(), true).await.unwrap();
        connected("by tunnel, the login failing");
        let live = conns().iter().find(|c| c.saved.id == added.id).unwrap().live.clone();
        assert!(live.is_some_and(|l| l.0.starts_with("wss://")), "connected by tunnel");
        remove_server(added.id).await.unwrap();
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
        // Stored only beside a tunnel address, for connecting without a login.
        let stored = crate::issues::credential(&credential_name(&added.id)).await;
        assert_eq!(stored.is_some(), !list_servers()[0].url.is_empty(), "a token only beside a tunnel");
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
