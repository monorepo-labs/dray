//! Other machines a Dray server reaches for `dray --machine`, in every server
//! — a Linux `dray-serve`, a headless Mac, the Mac app's own background one
//! (#760). The list is `servers.json` beside this server's sessions, tokens in
//! `credentials.json` under `server:<id>`. Trust is per token: a machine
//! reaches whatever it was handed a token for, in either direction.
//!
//! A link is made per call — one socket, one request, closed — so nothing here
//! reconnects or pings. An SSH machine's login is the slow part and is kept
//! while `ssh` lives. The Mac app holds live connections of its own over the
//! same file for its screens ([`crate::servers`]); on a Mac the file has one
//! writer at a time, the app while it is open.

use crate::{ssh, store};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

/// How long a probe or a reconnect may take to be admitted.
pub const ADMIT: Duration = Duration::from_secs(5);

/// A forwarded `dray session new` makes a worktree and spawns an agent before
/// it answers.
const CALL: Duration = Duration::from_secs(120);

/// What asking every machine at once gives each: a cold SSH login included,
/// so a typo'd session id or a dead machine costs this and no more.
pub const SWEEP: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Saved {
    pub id: String,
    pub name: String,
    /// Empty for an SSH server, whose address is a port forwarded per connect.
    /// Always written: a build from before SSH requires it, and one entry it
    /// cannot parse is the whole list gone.
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<ssh::Target>,
    /// The reader turned the connection off; the row stays.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub off: bool,
    /// The server takes beta releases, which also means stable ones. Its own,
    /// never the app's. A bool rather than a channel enum: a value an older
    /// build cannot spell fails the line, and one line is the whole list.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub beta: bool,
    /// A release the reader chose to ignore. Only that one: a newer release
    /// is offered again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignored: Option<String>,
    /// The boat sandbox this machine is, once it has said and boat agreed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boat: Option<BoatLink>,
    /// The Dray Cloud machine this is, by its sandbox id (#857). Listed by the
    /// control plane, never added by hand, and drawn as no row of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud: Option<String>,
    /// Fields a newer build wrote, carried back untouched — the index's own
    /// `unknown` bargain, since this file is rewritten whole too.
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, Value>,
}

/// Which boat sandbox a saved machine is, and where its login last reached it.
/// The address is how an alias is known to still be this sandbox's: one that no
/// longer points there has been aimed elsewhere and is left alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoatLink {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

impl Saved {
    /// What a reader typed to add it: the SSH line, else the address.
    pub fn address(&self) -> String {
        self.ssh.as_ref().map(ssh::Target::line).unwrap_or_else(|| self.url.clone())
    }

    /// The name it gets when the reader gives none.
    pub fn unnamed(&self) -> String {
        match &self.ssh {
            Some(target) => target.host().to_string(),
            None => default_name(&self.url),
        }
    }
}

pub fn credential_name(id: &str) -> String {
    format!("server:{id}")
}

async fn path() -> anyhow::Result<std::path::PathBuf> {
    Ok(store::get_home_app_dir().await?.join("servers.json"))
}

/// Serializes `servers.json` rewrites, like every other whole-file write here.
static SAVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The saved list, read fresh: the Mac app may have changed it since.
pub async fn load() -> Vec<Saved> {
    try_load().await.unwrap_or_else(|e| {
        eprintln!("[servers read err] {e:#}");
        Vec::new()
    })
}

/// [`load`], telling a file that failed to read from one that lists none.
pub async fn try_load() -> anyhow::Result<Vec<Saved>> {
    store::read_json(&path().await?).await
}

pub async fn save(list: &[Saved]) -> Result<(), String> {
    let _guard = SAVE.lock().await;
    write(list).await
}

/// The server's own write, made only while no app is connected to it. One
/// that connected meanwhile read its list before this landed, so it is told
/// to read again; [`crate::serve`] tells every app that connects the same.
async fn write(list: &[Saved]) -> Result<(), String> {
    let path = path().await.map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    store::write_atomic(&path, body).await.map_err(|e| format!("{e:#}"))?;
    tokio::spawn(crate::serve::host_call("reload_servers", Value::Null));
    tokio::spawn(announce_sharing());
    Ok(())
}

/// What `share_machines` answers and `machines_shared` carries: whether this
/// server shares its machines (#847), and which, by id and name. None while off.
pub async fn sharing() -> Value {
    let on = crate::settings::read().await.share_machines;
    let machines: Vec<Value> = match on {
        true => load().await.iter().filter(|s| !s.off).map(|s| json!({ "id": s.id, "name": s.name })).collect(),
        false => Vec::new(),
    };
    json!({ "on": on, "machines": machines })
}

/// The switch on Settings → Servers and `dray machine share`.
pub async fn set_sharing(on: bool) -> Result<Value, String> {
    crate::settings::update(|s| s.share_machines = on).await.map_err(|e| format!("{e:#}"))?;
    announce_sharing().await;
    Ok(sharing().await)
}

/// Tells every client what is shared now. The Mac app's own list writes have
/// no hub to tell, so a phone catches those up on its next connect.
async fn announce_sharing() {
    crate::serve::HUB.publish("machines_shared", &sharing().await);
    SHARING_MOVED.notify_waiters();
}

/// Woken on every change to what is shared, so a live relay can stop at once.
pub static SHARING_MOVED: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Whether `id` is shared still: sharing on, and the machine listed and on.
pub async fn still_shared(id: &str) -> bool {
    shared(id).await.is_ok()
}

/// A shared machine by id, refusing everything while sharing is off.
async fn shared(id: &str) -> Result<Saved, String> {
    if !crate::settings::read().await.share_machines {
        return Err("this server does not share its machines".into());
    }
    load().await.into_iter().find(|s| s.id == id && !s.off).ok_or_else(|| "this server shares no such machine".into())
}

/// A socket to shared machine `id` that has said `hello` under that machine's
/// token and read nothing back, so its welcome or refusal reaches the client
/// the relay is for.
pub async fn relay(id: &str, mut hello: Value) -> Result<Socket, String> {
    let saved = shared(id).await?;
    let (url, token) = reach(&saved).await?;
    hello["token"] = token.into();
    let attempt = async {
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| format!("could not reach {}: {e}", saved.name))?;
        ws.send(Message::text(hello.to_string())).await.map_err(|e| e.to_string())?;
        Ok(ws)
    };
    let opened = tokio::time::timeout(ADMIT, attempt).await.unwrap_or_else(|_| Err(format!("{} did not answer in time", saved.name)));
    if opened.is_err() {
        drop_login(&saved.id, &url);
    }
    opened
}

/// Where shared machine `id` serves `/file` and `/upload`, and its token.
pub async fn relay_http(id: &str) -> Result<(String, String), String> {
    let (url, token) = reach(&shared(id).await?).await?;
    let base = match url.strip_prefix("wss://") {
        Some(rest) => format!("https://{rest}"),
        None => url.replacen("ws://", "http://", 1),
    };
    Ok((base, token))
}

/// Spelled the way a reader types it — `host:port`, `http://…`, `ws://…`, or
/// a tunnel's `https://…`/`wss://…` — and answered as the URL the socket opens.
pub fn normalize(url: &str) -> Result<String, String> {
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

/// The host, which is what a reader would call it if asked.
pub fn default_name(url: &str) -> String {
    url.into_client_request()
        .ok()
        .and_then(|r| r.uri().host().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

pub type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The server's first frame once admitted: its core version, the CLI release
/// it shipped in, and whether an update already landed on disk that it is not
/// running yet. A server from before sends none of them.
#[derive(Debug, Default, Deserialize)]
pub struct Welcome {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub release: Option<String>,
    #[serde(default)]
    pub stale: bool,
    /// `std::env::consts::OS` on the server.
    #[serde(default)]
    pub os: Option<String>,
    /// The server took a hello's `forward`. One from before reads that hello as
    /// an ordinary client's and says nothing of it.
    #[serde(default)]
    pub forwarding: bool,
    /// Only a desktop build serves dictation, so this marks Dray.app's own
    /// server — the one signal a 0.29 app already sends.
    #[serde(default)]
    pub dictation: bool,
    #[serde(default)]
    pub dev: bool,
}

impl Welcome {
    /// Dray.app's server on another Mac: it follows that app's updater, so it
    /// is measured against app releases and has no `update_server`.
    pub fn is_mac_app(&self) -> bool {
        self.dictation && self.release.is_none() && !self.dev
    }
}

/// How `admit_with` opens a refusal: the server answered, so retrying cannot help.
pub const REFUSED: &str = "the server refused: ";

/// Connects and says `hello`. Answers the admitted socket, or why not.
pub async fn admit_with(url: &str, hello: Value) -> Result<(Socket, Welcome), String> {
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
                        Some(err) => Err(format!("{REFUSED}{err}")),
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

/// SSH logins kept up between calls, by machine id. Dropping one kills `ssh`.
static TUNNELS: LazyLock<Mutex<HashMap<String, ssh::Tunnel>>> = LazyLock::new(Default::default);

/// Held across a login, per machine, so two calls at once share one rather
/// than the second replacing — and killing — the tunnel the first is using.
/// Per machine, or asking every machine at once logs into them in turn.
static OPENING: LazyLock<Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);

fn tunnels() -> std::sync::MutexGuard<'static, HashMap<String, ssh::Tunnel>> {
    TUNNELS.lock().unwrap_or_else(|e| e.into_inner())
}

fn opening(id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    OPENING.lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().clone()
}

/// Drops `id`'s kept login, after any login still opening for it, so one
/// finishing late cannot put itself back.
async fn forget(id: &str) {
    let opening = opening(id);
    let _opening = opening.lock().await;
    tunnels().remove(id);
}

/// A live tunnel's address and token.
fn kept(id: &str) -> Option<(String, String)> {
    let mut tunnels = tunnels();
    let tunnel = tunnels.get_mut(id)?;
    match tunnel.alive() {
        true => Some((format!("ws://127.0.0.1:{}", tunnel.port), tunnel.token.clone())),
        false => {
            tunnels.remove(id);
            None
        }
    }
}

/// Where `saved` answers and the token it takes, logging in first for an SSH
/// machine. One whose login fails still answers at the Remote access address
/// its last login read, where it had one.
async fn reach(saved: &Saved) -> Result<(String, String), String> {
    let token = crate::issues::credential(&credential_name(&saved.id)).await.unwrap_or_default();
    let Some(target) = &saved.ssh else {
        return Ok((saved.url.clone(), token));
    };
    let opening = opening(&saved.id);
    let _opening = opening.lock().await;
    if let Some(reach) = kept(&saved.id) {
        return Ok(reach);
    }
    match ssh::open(target, |_| {}).await {
        Ok(tunnel) => {
            let reach = (format!("ws://127.0.0.1:{}", tunnel.port), tunnel.token.clone());
            // Removed or turned off while this logged in: used once, not kept.
            if load().await.iter().any(|s| s.id == saved.id && !s.off) {
                tunnels().insert(saved.id.clone(), tunnel);
            } else {
                tokio::spawn(async move {
                    tokio::time::sleep(CALL).await;
                    drop(tunnel);
                });
            }
            Ok(reach)
        }
        Err(_) if !saved.url.is_empty() => Ok((saved.url.clone(), token)),
        Err(failure) => Err(explain(failure, &target.line())),
    }
}

/// A failed login as words, since nothing here draws a fix as a control.
/// Trusting a host key stays a person's decision, made in their own `ssh`,
/// never on an agent's say-so.
pub fn explain(failure: ssh::Failure, login: &str) -> String {
    let message = failure.message;
    match failure.fix {
        Some(ssh::Fix::Copy { command }) => format!("{message}\n  {command}"),
        Some(ssh::Fix::TrustHost { key_type, fingerprint, .. }) => format!(
            "{message} Its {key_type} key is {fingerprint}. If that is right, run `{login}` once in a \
             terminal to trust it, then add it again."
        ),
        Some(ssh::Fix::Install) if cfg!(feature = "desktop") => {
            format!("{message} Add it from the app's Settings → Servers, which can install it.")
        }
        Some(ssh::Fix::Install) => {
            format!("{message} Install it there first: curl -fsSL https://www.drayhq.com/install.sh | sh")
        }
        // A reconnect's fix, never an add's; the sentence already says it.
        Some(ssh::Fix::NewAddress) | None => message,
    }
}

async fn admit(url: &str, token: &str) -> Result<(Socket, Welcome), String> {
    admit_with(url, json!({ "v": crate::serve::PROTOCOL, "token": token })).await
}

/// An admitted socket to `saved`. A kept login the server refuses — its token
/// moved, its forward died — is dropped, so the next call logs in afresh.
async fn connect(saved: &Saved) -> Result<Socket, String> {
    let (url, token) = reach(saved).await?;
    match admit(&url, &token).await {
        Ok((ws, _)) => Ok(ws),
        Err(e) => {
            drop_login(&saved.id, &url);
            Err(e)
        }
    }
}

/// Drops `id`'s kept login if it is the one at `url` — only the login that
/// failed, since a retry may have replaced it with a working one meanwhile.
fn drop_login(id: &str, url: &str) {
    let mut tunnels = tunnels();
    if tunnels.get(id).is_some_and(|t| format!("ws://127.0.0.1:{}", t.port) == url) {
        tunnels.remove(id);
    }
}

/// Runs serve command `cmd` on `saved`: connect, ask, close.
pub async fn call(saved: &Saved, cmd: &str, args: Value) -> Result<Value, String> {
    let mut ws = connect(saved).await.map_err(|e| format!("{}: {e}", saved.name))?;
    ws.send(Message::text(json!({ "id": 1, "cmd": cmd, "args": args }).to_string()))
        .await
        .map_err(|e| e.to_string())?;
    // Events and the opening `live_state` frame come first and are not ours.
    let answer = async {
        while let Some(message) = ws.next().await {
            let Some(text) = crate::serve::frame_in(message.map_err(|e| e.to_string())?) else { continue };
            let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
            if frame.get("id") != Some(&json!(1)) {
                continue;
            }
            return match frame.get("err") {
                Some(err) => Err(err.as_str().map(str::to_string).unwrap_or_else(|| err.to_string())),
                None => Ok(frame.get("ok").cloned().unwrap_or(Value::Null)),
            };
        }
        Err(format!("{} closed the connection before it answered", saved.name))
    };
    let answered = tokio::time::timeout(CALL, answer)
        .await
        .unwrap_or_else(|_| Err(format!("{} did not answer in time", saved.name)));
    ws.close(None).await.ok();
    answered
}

/// By name, or by id where two machines share one. An id wins outright, or a
/// machine renamed to another's id would make the cure ambiguous too.
pub fn find(list: &[Saved], name: &str) -> Result<Saved, String> {
    if let Some(saved) = list.iter().find(|s| s.id == name) {
        return Ok(saved.clone());
    }
    let matches: Vec<_> = list.iter().filter(|s| s.name == name).collect();
    match matches.as_slice() {
        [] => Err(format!("no machine named {name} — `dray machine ls` lists them")),
        [one] => Ok((*one).clone()),
        many => Err(format!(
            "{} machines are named {name} — name one by id: {}",
            many.len(),
            many.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// A machine to send a request to, refusing one turned off.
pub async fn on(name: &str) -> Result<Saved, String> {
    let saved = find(&load().await, name)?;
    match saved.off {
        true => Err(format!("{} is turned off — `dray machine connect {}` turns it on", saved.name, saved.name)),
        false => Ok(saved),
    }
}

/// A machine as `dray machine` answers it.
pub struct Row {
    pub saved: Saved,
    /// `connected`, `disconnected` or `off`, the app's own words.
    pub status: &'static str,
    pub error: Option<String>,
}

/// Whether `saved` answers now. Nothing here holds a connection open, so
/// "connected" means it admitted us just now.
async fn probe(saved: Saved) -> Row {
    if saved.off {
        return Row { saved, status: "off", error: None };
    }
    match connect(&saved).await {
        Ok(mut ws) => {
            ws.close(None).await.ok();
            Row { saved, status: "connected", error: None }
        }
        Err(e) => Row { saved, status: "disconnected", error: Some(e) },
    }
}

/// Every machine, each asked at once whether it answers.
pub async fn list() -> Vec<Row> {
    futures_util::future::join_all(load().await.into_iter().map(probe)).await
}

/// Sessions this server can message on other machines, for the `&` picker of a
/// session running here. Ids rather than machines, since this server and the
/// app each have their own name and id for one machine. One that fails to
/// answer reaches nothing: a tag on it would fail too.
pub async fn reachable_sessions() -> Vec<String> {
    let list: Vec<_> = load().await.into_iter().filter(|m| !m.off).collect();
    let asks = list
        .iter()
        .map(|m| tokio::time::timeout(SWEEP, call(m, "list_session_index_items", json!({ "archived": false }))));
    futures_util::future::join_all(asks)
        .await
        .into_iter()
        .filter_map(|answer| answer.ok()?.ok())
        .flat_map(session_ids)
        .collect()
}

fn session_ids(rows: Value) -> Vec<String> {
    let Value::Array(rows) = rows else { return Vec::new() };
    rows.iter().filter_map(|row| Some(row["sessionId"].as_str()?.to_string())).collect()
}

/// A name is how `--machine` picks one, so two may not share it. `except` is
/// the machine being renamed or re-added, which may keep its own.
fn refuse_taken(list: &[Saved], name: &str, except: Option<&str>) -> Result<(), String> {
    match list.iter().any(|s| Some(s.id.as_str()) != except && s.name == name) {
        true => Err(format!("another machine is already named {name} — pick another name")),
        false => Ok(()),
    }
}

/// Adds a machine by address and token, or by SSH login where `token` is
/// `None`. It must admit us first; only a machine that did is saved.
pub async fn add(name: String, address: String, token: Option<String>) -> Result<Row, String> {
    let name = Some(name.trim().to_string()).filter(|n| !n.is_empty());
    // A fresh login, which replaces any kept one once the row is saved.
    let mut fresh = None;
    let (mut saved, token) = match token {
        Some(token) => {
            let url = normalize(&address)?;
            let token = token.trim().to_string();
            if token.is_empty() {
                return Err("a token is required — it is in the server's serve-token file".into());
            }
            admit(&url, &token).await?.0.close(None).await.ok();
            let saved = Saved {
                id: String::new(),
                name: String::new(),
                url,
                ssh: None,
                off: false,
                beta: false,
                ignored: None,
                boat: None,
                cloud: None,
                unknown: Default::default(),
            };
            (saved, Some(token))
        }
        None => {
            let target = ssh::parse(&address)?;
            let tunnel = ssh::open(&target, |_| {}).await.map_err(|f| explain(f, &target.line()))?;
            let url = format!("ws://127.0.0.1:{}", tunnel.port);
            if let Err(e) = admit(&url, &tunnel.token).await.map(|(ws, _)| drop(ws)) {
                return Err(tunnel.said().unwrap_or(e));
            }
            // The Remote access address, with the token, is the way in when a
            // later login fails; without one there is nothing to keep.
            let url = tunnel.address.as_deref().and_then(|a| normalize(a).ok()).unwrap_or_default();
            let token = (!url.is_empty()).then(|| tunnel.token.clone());
            fresh = Some(tunnel);
            let saved = Saved {
                id: String::new(),
                name: String::new(),
                url,
                ssh: Some(target),
                off: false,
                beta: false,
                ignored: None,
                boat: None,
                cloud: None,
                unknown: Default::default(),
            };
            (saved, token)
        }
    };
    let _guard = SAVE.lock().await;
    let mut list = load().await;
    let same = |s: &Saved| match &saved.ssh {
        Some(target) => s.ssh.as_ref() == Some(target),
        None => s.ssh.is_none() && s.url == saved.url,
    };
    let existing = list.iter().position(same);
    saved.name = name.unwrap_or_else(|| saved.unnamed());
    refuse_taken(&list, &saved.name, existing.map(|at| list[at].id.as_str()))?;
    match existing {
        Some(at) => {
            saved.id = list[at].id.clone();
            saved.beta = list[at].beta;
            // Kept as the app's own re-add keeps it: without the link a stopped
            // sandbox has no Resume until some later login relearns it.
            saved.boat = saved.boat.take().or(list[at].boat.take());
            saved.ignored = list[at].ignored.take();
            saved.unknown = std::mem::take(&mut list[at].unknown);
            list[at] = saved.clone();
        }
        None => {
            saved.id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
            list.push(saved.clone());
        }
    }
    crate::issues::set_credential(&credential_name(&saved.id), token.as_deref()).await?;
    write(&list).await?;
    drop(_guard);
    forget(&saved.id).await;
    if let Some(tunnel) = fresh {
        tunnels().insert(saved.id.clone(), tunnel);
    }
    Ok(Row { saved, status: "connected", error: None })
}

/// Takes the token and any open login with it.
pub async fn remove(name: &str) -> Result<Row, String> {
    let _guard = SAVE.lock().await;
    let mut list = load().await;
    let saved = find(&list, name)?;
    list.retain(|s| s.id != saved.id);
    write(&list).await?;
    crate::issues::set_credential(&credential_name(&saved.id), None).await?;
    drop(_guard);
    forget(&saved.id).await;
    Ok(Row { saved, status: "off", error: None })
}

/// An empty name puts back the default, its host.
pub async fn rename(name: &str, new_name: &str) -> Result<Row, String> {
    let saved = {
        let _guard = SAVE.lock().await;
        let mut list = load().await;
        let id = find(&list, name)?.id;
        let at = list.iter().position(|s| s.id == id).expect("found above");
        let new_name =
            Some(new_name.trim()).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| list[at].unnamed());
        refuse_taken(&list, &new_name, Some(&id))?;
        list[at].name = new_name;
        write(&list).await?;
        list.swap_remove(at)
    };
    Ok(probe(saved).await)
}

/// Off keeps the row, its name and its token; requests to it are refused. On
/// answers whether it answers now.
pub async fn set_on(name: &str, on: bool) -> Result<Row, String> {
    let saved = {
        let _guard = SAVE.lock().await;
        let mut list = load().await;
        let id = find(&list, name)?.id;
        let at = list.iter().position(|s| s.id == id).expect("found above");
        list[at].off = !on;
        write(&list).await?;
        list.swap_remove(at)
    };
    if !on {
        forget(&saved.id).await;
    }
    Ok(probe(saved).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_what_a_reader_types() {
        assert_eq!(normalize("127.0.0.1:7317").unwrap(), "ws://127.0.0.1:7317");
        assert_eq!(normalize("http://box:7317/").unwrap(), "ws://box:7317");
        assert_eq!(normalize(" ws://box:7317 ").unwrap(), "ws://box:7317");
        assert_eq!(normalize("https://a-b.trycloudflare.com/").unwrap(), "wss://a-b.trycloudflare.com");
        assert_eq!(normalize("wss://a-b.trycloudflare.com").unwrap(), "wss://a-b.trycloudflare.com");
        assert!(normalize("").is_err());
    }

    #[test]
    fn a_name_finds_one_machine_and_an_id_wins() {
        let saved = |id: &str, name: &str| Saved {
            id: id.into(),
            name: name.into(),
            url: format!("ws://{name}:7317"),
            ssh: None,
            off: false,
            beta: false,
            ignored: None,
            boat: None,
            cloud: None,
            unknown: Default::default(),
        };
        let list = [saved("a1", "vps"), saved("b2", "box"), saved("c3", "box"), saved("d4", "a1")];
        assert_eq!(find(&list, "vps").unwrap().id, "a1");
        assert_eq!(find(&list, "a1").unwrap().name, "vps");
        assert!(find(&list, "box").unwrap_err().contains("b2, c3"));
        assert!(find(&list, "nope").is_err());
    }

    #[test]
    fn reachable_ids_tolerate_a_shape_they_cannot_read() {
        let rows = json!([{ "sessionId": "a" }, { "title": "no id" }, { "sessionId": "b" }]);
        assert_eq!(session_ids(rows), ["a", "b"]);
        assert!(session_ids(json!({ "err": "nope" })).is_empty());
    }

    #[test]
    fn trust_advice_names_the_whole_login() {
        let fix = ssh::Fix::TrustHost { host: "box".into(), key_type: "ED25519".into(), fingerprint: "SHA256:x".into() };
        let said = explain(ssh::Failure { message: "Never met box.".into(), fix: Some(fix), permanent: true }, "ssh -p 2222 me@box");
        assert!(said.contains("run `ssh -p 2222 me@box` once"), "{said}");
    }
}
