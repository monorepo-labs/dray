//! `dray-serve`: the core over one WebSocket, with no Tauri in the process.
//! The wire mirrors Tauri's own `invoke` and `listen`, so the frontend reaches
//! either through one wrapper. See SERVE-PLAN.md.
//!
//! ```text
//! → {"v":1,"token":"…"}                         first frame, always
//! ← {"v":1}                                     or {"err":"…"} and close
//! → {"id":1,"cmd":"send_msg","args":{…}}        args exactly as `invoke` sends them
//! ← {"id":1,"ok":…}  or  {"id":1,"err":…}       err as a rejected `invoke` carries it
//! ← {"event":"agent_event","payload":{…}}       every event, to every client
//! ```
//!
//! The Mac app connects to its own server with `"host":{"browser":…}` in the
//! hello, which lets the server call back into it — see [`host_call`]:
//!
//! ```text
//! ← {"call":1,"cmd":"request","args":{…}}       the server asking the app
//! → {"reply":1,"ok":…}  or  {"reply":1,"err":"…"}
//! ```

use crate::{
    files, git,
    github::{self, MergeMethod},
    harness::Harness,
    issues::{self, IssuePriority, IssueQuery, IssueTracker},
    events::ApprovalPolicy,
    models::{Effort, ModelId},
    sink::Sink,
    store,
};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{broadcast, mpsc},
};
use tokio_tungstenite::tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
    Message,
};

/// The serve wire's version, checked in the first frame before anything else
/// is read. Bump it when a change would leave the other side doing the wrong
/// thing without saying so — the rule `dray_proto::PROTOCOL_VERSION` follows.
/// The frontend states it again in `transport.ts`.
pub const PROTOCOL: u32 = 1;

/// How far one client may fall behind the event stream before it is dropped.
/// A dropped client reconnects and re-reads; a silently skipped `agent_event`
/// would leave a transcript wrong with nothing to say so.
const EVENT_BACKLOG: usize = 4096;

/// How long a connection may take to prove itself — the `/file` head, or the
/// handshake plus hello — before it is dropped. Everything before the token is
/// checked is somebody unknown spending this process's memory.
const ADMIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The most a `/file` request head may hold. Its URL carries a token and a
/// path; nothing a real client sends comes near this.
const FILE_HEAD_LIMIT: u64 = 16 * 1024;

/// Where a server writes the port it listens on for the app, then its
/// [`exe_stamp`], then its pid. The Mac's background server lets the OS pick
/// its port each start, so it never collides with a `dray-serve` on 7317.
pub const PORT_FILE: &str = "serve-port";

/// Where launchd writes the Mac server's stdout and stderr.
pub const SERVER_LOG: &str = "server.log";

/// Runs the server until the process ends.
pub async fn run(port: u16) -> Result<()> {
    if let Ok(exe) = std::env::current_exe() {
        let _ = STARTED_FROM.set((exe.clone(), stamp_of(&exe)));
    }
    let sink = Sink::new(|event, payload| HUB.publish(event, &payload));
    let home = start_core(sink.clone()).await?;

    let (token, token_path) = mint_token().await?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("could not bind {addr}"))?;
    write_port_file(&home, listener.local_addr()?.port()).await?;
    // Remote access fronts this listener rather than binding one of its own.
    crate::remote_access::fronts(listener.local_addr()?.port());
    tokio::spawn(crate::remote_access::start(sink.clone()));
    tokio::spawn(crate::tunnel::warm(crate::tunnel::SHARE));

    eprintln!(
        "dray-serve listening on ws://{}, token in {}",
        listener.local_addr()?,
        token_path.display()
    );

    listen(listener, HUB.clone(), sink, token.into(), home.join(dray_proto::TUNNEL_URL_FILE).into(), false).await
}

/// The Mac's background server: the app's own binary, run by launchd with
/// `--serve`. It is [`run`] on a port the OS picks, written to [`PORT_FILE`]
/// for the app, with Remote access served from the setting as the app used to.
/// See MAC-SERVER-PLAN.md.
#[cfg(feature = "desktop")]
pub async fn run_mac() -> Result<()> {
    let sink = Sink::new(|event, payload| HUB.publish(event, &payload));
    let home = start_core(sink.clone()).await?;
    // launchd appends stdout and stderr here for the life of the login, so
    // past 10MB it starts over. The fd launchd opened is `O_APPEND`, so the
    // next line lands at the start of the emptied file.
    let log = home.join(SERVER_LOG);
    if std::fs::metadata(&log).is_ok_and(|m| m.len() > 10 << 20) {
        let _ = std::fs::OpenOptions::new().write(true).open(&log).and_then(|f| f.set_len(0));
    }

    let (token, _) = mint_token().await?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.context("could not bind a local port")?;
    let port = listener.local_addr()?.port();
    write_port_file(&home, port).await?;
    tokio::spawn(crate::remote_access::start(sink.clone()));

    // launchd, and Quit and stop sessions in dev, stop the server with SIGTERM.
    tokio::spawn(async {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        shut_down(0).await;
    });

    eprintln!("dray --serve listening on 127.0.0.1:{port}, home {}", home.display());
    listen(listener, HUB.clone(), sink, token.into(), home.join(dray_proto::TUNNEL_URL_FILE).into(), true).await
}

/// Written by `dray-serve` too, so a Dray app installed later on a Mac
/// already serving finds this server rather than starting one of its own.
async fn write_port_file(home: &Path, port: u16) -> Result<()> {
    let stamp = exe_stamp().unwrap_or_default();
    store::write_atomic(&home.join(PORT_FILE), format!("{port}\n{stamp}\n{}\n", std::process::id())).await
}

/// The executable's modified time, which moves when an update lands or cargo
/// rebuilds. The server writes the one it started from under its port; the
/// app compares it with the file now to tell a server running old code.
pub fn exe_stamp() -> Option<String> {
    stamp_of(&std::env::current_exe().ok()?)
}

fn stamp_of(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}.{:09}", since.as_secs(), since.subsec_nanos()))
}

/// `dray-serve`'s binary and its stamp when it started. Taken at start, since
/// once an update renames over the file Linux's `current_exe` names the
/// deleted inode rather than the path.
static STARTED_FROM: std::sync::OnceLock<(PathBuf, Option<String>)> = std::sync::OnceLock::new();

/// Whether the binary on disk has moved since `dray-serve` started: an update
/// landed and this process still runs the old code. False on the Mac's
/// server, which the app judges by the port file instead.
fn stale() -> bool {
    STARTED_FROM.get().is_some_and(|(path, then)| stamp_of(path) != *then)
}

/// How a restart exits. launchd's `KeepAlive` on a failed exit and systemd's
/// `Restart=on-failure` both bring back a non-zero exit alone, which is also
/// what keeps a stopped `dray-serve` stopped. The Mac app's agent restarts on
/// any exit.
const RESTART_CODE: i32 = if cfg!(feature = "desktop") { 0 } else { 75 };

/// Exits once no turn is running, for launchd or systemd to start the binary
/// now on disk. Asked by the app when the server it met is older than its
/// binary, and by an update. Twice is once.
async fn restart_when_idle() {
    static ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if ASKED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    tokio::spawn(async {
        while !crate::session::manager().close_if_idle().await {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        eprintln!("[serve] restarting onto the binary now on disk");
        shut_down(RESTART_CODE).await;
    });
}

/// Runs `dray update` from beside this binary, then restarts once idle where
/// it brought a new one. Answers `"restarting"`, or `"current"` where the
/// channel had nothing newer. The `dray` there shipped in the same archive, so
/// it always knows `--channel`.
#[cfg(not(feature = "desktop"))]
async fn update_server(channel: String) -> Result<&'static str, String> {
    // One at a time: two apps on different channels would otherwise run two
    // installers over one binary, and the slower could land the older one.
    // Queued, the second runs the `dray` the first installed, which reports
    // the newer version, and the installer keeps a newer install.
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = ONE.lock().await;
    let dray =STARTED_FROM.get().map(|(exe, _)| exe.with_file_name("dray")).ok_or("could not find this server's binary")?;
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new(&dray)
        .args(["update", "--channel", &channel])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", dray.display()))?;
    let mut stderr = child.stderr.take();
    let said = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut text).await;
        }
        text
    });
    let status = match tokio::time::timeout(std::time::Duration::from_secs(300), child.wait()).await {
        Ok(status) => status.map_err(|e| format!("dray update did not finish: {e}"))?,
        // The installer is `sh` running curl under `dray`, so killing `dray`
        // alone leaves a download that could still land a binary after this
        // answered — and nothing would restart onto it. Walked while `dray`
        // is alive, or its children are reparented out of reach.
        Err(_) => {
            if let Some(root) = child.id() {
                crate::local_servers::kill_descendants(root).await;
            }
            let _ = child.kill().await;
            return Err("dray update did not finish in 5 minutes".into());
        }
    };
    if !status.success() {
        let said = said.await.unwrap_or_default();
        return Err(said.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("dray update failed").trim().to_string());
    }
    if !stale() {
        return Ok("current");
    }
    restart_when_idle().await;
    Ok("restarting")
}

/// Restarts now, stopping every running turn. After a beat, so the reply
/// reaches the app first.
#[cfg(not(feature = "desktop"))]
fn restart_now() {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        eprintln!("[serve] restarting now, as asked");
        shut_down(RESTART_CODE).await;
    });
}

/// Ends the server and everything under it: the Remote access address file,
/// which would name a server that is gone, and every session's tree, which a
/// dev server or watcher would otherwise outlive.
///
/// Agents get 3s to exit the way a settle ends them, since pi and fx release
/// locks on a clean exit and a killed one stalls the next start. Then
/// whatever is left is killed off the process table, walked *before* the
/// agents went, so their reparented children are still named — and never off
/// the session map alone, whose locks a stuck send can hold forever.
async fn shut_down(code: i32) -> ! {
    crate::session::hold_sends();
    #[cfg(feature = "desktop")]
    crate::remote_access::stop_on_exit();
    let me = std::process::id();
    let walk = move || tokio::task::spawn_blocking(move || crate::local_servers::descendants(me));
    let mut tree = walk().await.unwrap_or_default();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), crate::session::manager().stop_all()).await;
    // Again, for whatever a send already under way started meanwhile.
    tree.extend(walk().await.unwrap_or_default());
    // ponytail: a pid that exited in those 3s could be reused; a process
    // group per agent would make this one signal.
    for pid in tree.into_iter().filter(|&p| p != me) {
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
    // `_exit`, not `process::exit`: once a phone's dictation has loaded a
    // model, ggml-metal's atexit handler aborts (lib.rs's `RunEvent::Exit`
    // says how), which would end every stop and restart as 134, not `code`.
    unsafe { libc::_exit(code) }
}

/// Removes the browser profiles of deleted and settled sessions, the backlog
/// from before settle removed them itself. Temporary: drop it once releases
/// that settle without cleaning up are gone (#482).
///
/// An empty index sweeps nothing, since a missing file reads as no sessions
/// and would take every profile. The CEF root ignores `DRAY_HOME`, so a
/// server on a home of its own leaves it alone: that index is not the one
/// those profiles belong to.
async fn sweep_browser_profiles() {
    let Ok(index) = store::read_index().await else { return };
    if index.is_empty() {
        return;
    }
    let live: std::collections::HashSet<String> =
        index.into_iter().filter(|item| !item.archived).map(|item| item.session_id).collect();
    // Awaited, so nothing is served while the sweep judges against `live`: a
    // session made or unsettled meanwhile would lose a profile it just opened.
    // Only the renames are waited on; the removals run on.
    let _ = tokio::task::spawn_blocking(move || {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        if std::env::var_os("DRAY_HOME").is_none() {
            crate::cef::automation::sweep_profiles(&live);
        }
        crate::headless::automation::sweep_profiles(&live);
    })
    .await;
}

/// What every server does before it listens: refuse a home another Dray
/// holds, reset what no child survived, and serve the orchestration socket.
async fn start_core(sink: Sink) -> Result<PathBuf> {
    crate::SERVER.store(true, std::sync::atomic::Ordering::Relaxed);
    // Two processes on one home reset each other's sessions at start, take
    // each other's socket and rewrite one index whole, each over the other.
    // A socket that answers is a Dray already living here.
    let home = store::get_home_app_dir().await?;
    // Held for the life of the process. The socket check below alone lets
    // two servers starting at once both pass it, since neither has bound yet.
    let held = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join("serve.lock"))
        .context("could not open serve.lock")?;
    if unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&held), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        anyhow::bail!("a Dray server is already running on {}", home.display());
    }
    std::mem::forget(held);
    for name in [dray_proto::SOCKET_NAME, dray_proto::SOCKET_NAME_DEV] {
        let socket = home.join(name);
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
            anyhow::bail!(
                "a Dray is already running on {} ({} answers). Quit it, or start \
                 dray-serve with DRAY_HOME set to a directory of its own.",
                home.display(),
                socket.display()
            );
        }
    }

    if let Err(e) = store::reset_in_progress_sessions().await {
        eprintln!("[status reset err] {e}");
    }
    if let Err(e) = store::backfill_removed_worktrees().await {
        eprintln!("[worktree backfill err] {e}");
    }
    sweep_browser_profiles().await;
    crate::auto_continue::rearm(&sink).await;

    // Agents this server spawns reach it through `dray`, so it serves the
    // socket the desktop app does — under `DRAY_HOME` where that is set.
    tokio::spawn(async move {
        if let Err(e) = crate::orchestration::serve(sink).await {
            eprintln!("[orchestration err] {e:#}");
        }
    });
    Ok(home)
}

/// What every client of this process hears: each event the core emits, and
/// [`Live`] beside it for a client that connects later. `dray-serve` builds
/// its `Sink` on one; the desktop app's `Sink` publishes into [`HUB`] as well
/// as its webview, so the app can serve the same stream.
#[derive(Clone)]
pub struct Hub {
    events: broadcast::Sender<Arc<str>>,
    live: Arc<Mutex<Live>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self { events: broadcast::channel(EVENT_BACKLOG).0, live: Default::default() }
    }
}

impl Hub {
    pub fn publish(&self, event: &str, payload: &Value) {
        // Noted and sent under one lock, which is what lets a connecting
        // client take a snapshot and subscribe with nothing falling between
        // the two or landing in both.
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        live.note(event, payload);
        // No receivers is ordinary — nobody connected, or the app not
        // serving — and the frame would be built for nobody.
        if self.events.receiver_count() > 0 {
            let _ = self.events.send(json!({ "event": event, "payload": payload }).to_string().into());
        }
    }
}

/// Every server's hub, a static because Remote access serves it from a
/// second listener that comes and goes with the setting, and `live_state`
/// reads it from the command table.
pub static HUB: std::sync::LazyLock<Hub> = std::sync::LazyLock::new(Hub::default);

/// Serves `listener` until the future is dropped, which also drops every
/// connection it accepted — how the desktop app turns serving off.
/// `tunnel_file` holds the address whose origin is let through. `hosts` lets a
/// client offer itself as [`host_call`]'s answerer: the Mac server's own
/// listener alone, so a Mac reaching it through the tunnel is never handed
/// this Mac's browser.
pub async fn listen(
    listener: TcpListener,
    hub: Hub,
    sink: Sink,
    token: Arc<str>,
    tunnel_file: Arc<Path>,
    hosts: bool,
) -> Result<()> {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let (stream, peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(e) => {
                    eprintln!("[serve accept err] {e}");
                    continue;
                }
            },
            // Reaps finished connections, so the set holds live ones alone.
            Some(_) = connections.join_next() => continue,
        };
        let (sink, hub, token, tunnel_file) = (sink.clone(), hub.clone(), token.clone(), tunnel_file.clone());
        connections.spawn(async move {
            let served = match request_line(&stream).await {
                Some(line) if line.starts_with("GET /file?") => file(stream, &token).await,
                Some(line) if line.starts_with("POST /upload?") => upload(stream, &token).await,
                Some(_) => connection(stream, sink, hub, &token, &tunnel_file, hosts).await,
                None => Ok(()),
            };
            if let Err(e) = served {
                eprintln!("[serve conn {peer}] {e:#}");
            }
        });
    }
}

/// The server's token, written where only this account can read it.
///
/// Localhost is not a boundary the way `dray.sock` is: the socket sits in a
/// `0700` directory, but a TCP port on `127.0.0.1` is open to every account on
/// the machine, and a VPS is often shared. The file is `0600` from its create.
pub async fn mint_token() -> Result<(String, PathBuf)> {
    let path = store::get_home_app_dir().await?.join("serve-token");
    let token = token_at(&path)?;
    Ok((token, path))
}

/// The token already in `path`, or a fresh one where it is missing or not one
/// this server wrote. Kept across starts: the server runs as a service that
/// restarts on reboot, update and crash, and a per-start token broke every
/// saved server each time. Deleting the file is how a reader rotates it.
/// Written back either way, so the file is `0600` whatever it was left at.
fn token_at(path: &Path) -> Result<String> {
    let kept = std::fs::read_to_string(path)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()));
    let token = kept.unwrap_or_else(|| {
        format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
    });
    store::write_private_atomic(path, token.as_bytes())
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(token)
}

/// Whether a browser `Origin` names this machine. Any page can open a
/// WebSocket to localhost, so without this check a website the reader has
/// open could try tokens against the port. No `Origin` at all is a client
/// that is not a browser, which the token alone answers for.
fn local_origin(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let host = if let Some(v6) = rest.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        rest.split([':', '/']).next().unwrap_or_default()
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Whether `origin` is the Remote access address. A page there can only be
/// one this server answered, since the route forwards nowhere else, and a
/// phone's WebSocket names it as the origin it connected to. Read per
/// handshake, since Remote access comes and goes.
fn tunnel_origin(origin: &str, tunnel_file: &Path) -> bool {
    std::fs::read_to_string(tunnel_file).is_ok_and(|url| {
        let url = url.trim();
        !url.is_empty() && origin.trim_end_matches('/') == url.trim_end_matches('/')
    })
}

/// Equal-time compare, so the token cannot be read back a byte at a time off
/// how quickly a wrong one is refused.
fn same_token(given: &str, token: &str) -> bool {
    given.len() == token.len()
        && given
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

#[derive(Deserialize)]
struct Hello {
    v: u32,
    #[serde(default)]
    token: String,
    #[serde(default)]
    host: Option<HostOffer>,
}

/// What the app can answer when it connects as the host.
#[derive(Deserialize)]
struct HostOffer {
    #[serde(default)]
    browser: bool,
}

/// The app connected to its own server, and the calls waiting on it. One at a
/// time: a second app on one home replaces the first.
struct Host {
    connection: u64,
    browser: bool,
    frames: mpsc::UnboundedSender<String>,
    waiting: HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, Value>>>,
}

static HOST: Mutex<Option<Host>> = Mutex::new(None);
static NEXT_CALL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn host() -> std::sync::MutexGuard<'static, Option<Host>> {
    HOST.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the connected app runs browser steps itself.
pub fn host_browser() -> bool {
    host().as_ref().is_some_and(|h| h.browser)
}

/// Asks the app connected as host. `None` where no app is connected; an app
/// that leaves mid-call answers an error, since the step may have half run.
pub async fn host_call(cmd: &str, args: Value) -> Option<Result<Value, Value>> {
    let answer = {
        let mut host = host();
        let host = host.as_mut()?;
        let call = NEXT_CALL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        host.waiting.insert(call, tx);
        host.frames.send(json!({ "call": call, "cmd": cmd, "args": args }).to_string()).ok()?;
        rx
    };
    Some(answer.await.unwrap_or_else(|_| Err(json!("The Dray app closed before it answered."))))
}

/// The first frame's verdict: `None` admits the client. A version mismatch
/// names which side is behind, since the cure is opposite.
fn judge_hello(raw: &str, token: &str) -> Option<String> {
    let Ok(hello) = serde_json::from_str::<Hello>(raw) else {
        return Some(format!(
            "the first frame must be {{\"v\":{PROTOCOL},\"token\":\"…\"}}"
        ));
    };
    if hello.v != PROTOCOL {
        let cure = if hello.v < PROTOCOL {
            "update the Dray app"
        } else {
            "update dray-serve"
        };
        return Some(format!(
            "this client speaks serve protocol v{}, the server speaks v{PROTOCOL} — {cure}",
            hello.v
        ));
    }
    if !same_token(&hello.token, token) {
        return Some("wrong token".to_string());
    }
    None
}

#[derive(Deserialize)]
struct Call {
    id: Value,
    cmd: String,
    #[serde(default)]
    args: Value,
}

/// What lives in this process's memory and in no log, sent to every client as
/// it connects: open questions and permission requests, and each session's
/// background tasks. Status needs no copy here — every change is written to
/// the index, which a reconnecting client re-reads.
///
/// The retire rules are the frontend's own, so a client seeing this snapshot
/// draws what one connected the whole time would have: a decision answers its
/// request, and a turn that is over with no task left to ask strands the rest.
#[derive(Default)]
struct Live {
    asks: Vec<Value>,
    tasks: HashMap<String, Value>,
    running: std::collections::HashSet<String>,
}

impl Live {
    fn note(&mut self, event: &str, payload: &Value) {
        let session = payload["sessionId"].as_str().unwrap_or_default().to_string();
        match (event, payload["payload"]["type"].as_str()) {
            ("agent_event", Some("permission_requested" | "questions_asked")) => {
                self.asks.push(payload.clone());
            }
            ("agent_event", Some("permission_decided")) => {
                let id = &payload["payload"]["requestId"];
                self.asks
                    .retain(|a| !(a["sessionId"] == session.as_str() && &a["payload"]["requestId"] == id));
            }
            ("agent_event", Some("background_tasks_changed")) => {
                if payload["payload"]["tasks"].as_array().is_some_and(|t| t.is_empty()) {
                    self.tasks.remove(&session);
                    self.strand(&session);
                } else {
                    self.tasks.insert(session, payload.clone());
                }
            }
            ("session_status", _) => {
                if payload["status"] == "in_progress" {
                    self.running.insert(session);
                } else {
                    self.running.remove(&session);
                    self.strand(&session);
                }
            }
            _ => {}
        }
    }

    /// Drops a session's asks once nothing could answer them: no turn running,
    /// no background task whose subagent might be the one asking.
    fn strand(&mut self, session: &str) {
        if !self.running.contains(session) && !self.tasks.contains_key(session) {
            self.asks.retain(|a| a["sessionId"] != session);
        }
    }

    fn snapshot(&self) -> String {
        json!({ "event": "live_state", "payload": self.payload() }).to_string()
    }

    fn payload(&self) -> Value {
        let tasks: Vec<&Value> = self.tasks.values().collect();
        json!({ "asks": self.asks, "tasks": tasks })
    }
}

/// The request's first line, read without consuming it so the WebSocket
/// handshake still sees the whole request. `None` for a client that sent
/// nothing usable within a few seconds.
async fn request_line(stream: &TcpStream) -> Option<String> {
    let mut buf = [0u8; 2048];
    for _ in 0..300 {
        let n = stream.peek(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        if let Some(end) = buf[..n].windows(2).position(|w| w == b"\r\n") {
            return Some(String::from_utf8_lossy(&buf[..end]).into_owned());
        }
        if n == buf.len() {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    None
}

/// An HTTP request head: its target, the bearer token if one was sent, and
/// the body length it declared.
struct Head {
    target: String,
    bearer: Option<String>,
    length: Option<u64>,
}

/// Reads a request head off `stream`, bounded in size and time. The reader
/// comes back too, since it may already hold the start of a body.
async fn read_head(
    stream: TcpStream,
) -> Result<(Head, tokio::io::BufReader<tokio::io::Take<TcpStream>>)> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let mut reader = BufReader::new(stream.take(FILE_HEAD_LIMIT));
    let mut line = String::new();
    let (mut bearer, mut length) = (None, None);
    // The rest of the head is read too, so closing does not reset the
    // connection under a response the client has not finished reading.
    let head = async {
        reader.read_line(&mut line).await?;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).await? <= 2 {
                return Ok::<_, std::io::Error>(());
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("authorization") {
                    bearer = value.trim().strip_prefix("Bearer ").map(str::to_string);
                } else if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().ok();
                }
            }
        }
    };
    tokio::time::timeout(ADMIT, head).await.context("request head timed out")??;
    if reader.get_ref().limit() == 0 {
        anyhow::bail!("request head over {FILE_HEAD_LIMIT} bytes");
    }
    let target = line.split(' ').nth(1).unwrap_or_default().to_string();
    Ok((Head { target, bearer, length }, reader))
}

/// `POST /upload?name=…`: a file attached on another machine, written under
/// `attachments/uploads` so a send can name it. Answers the path it landed at.
/// Bearer token alone — nothing loads this from a URL.
async fn upload(stream: TcpStream, token: &str) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (head, reader) = read_head(stream).await?;
    // Whatever of the body arrived with the head sits in the reader's buffer.
    let early = reader.buffer().to_vec();
    let mut stream = reader.into_inner().into_inner();

    let query = head.target.split_once('?').map(|(_, q)| q).unwrap_or_default();
    let name = form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| *key == "name")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();

    let refuse = |status: &str| format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    if !same_token(head.bearer.as_deref().unwrap_or_default(), token) {
        stream.write_all(refuse("401 Unauthorized").as_bytes()).await?;
        return Ok(());
    }
    let Some(length) = head.length else {
        stream.write_all(refuse("411 Length Required").as_bytes()).await?;
        return Ok(());
    };
    if length > crate::attachments::MAX_UPLOAD_BYTES {
        stream.write_all(refuse("413 Content Too Large").as_bytes()).await?;
        return Ok(());
    }
    let Ok(path) = crate::attachments::upload_path(&name).await else {
        stream.write_all(refuse("400 Bad Request").as_bytes()).await?;
        return Ok(());
    };

    let mut out = tokio::fs::File::create(&path).await?;
    let mut body = (&early[..]).chain(&mut stream).take(length);
    // A dropped connection leaves no half a file behind to be named.
    let written = tokio::io::copy(&mut body, &mut out).await.unwrap_or(0);
    if written != length {
        let _ = tokio::fs::remove_file(&path).await;
        anyhow::bail!("upload ended at {written} of {length} bytes");
    }
    out.flush().await?;

    let path = path.to_string_lossy();
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{path}",
        path.len()
    );
    stream.write_all(reply.as_bytes()).await?;
    stream.shutdown().await.ok();
    Ok(())
}

/// `GET /file?token=…&path=…`: what `convertFileSrc` serves inside the desktop
/// app — attached images, browser recordings and screenshots — for a client
/// elsewhere. An
/// `<img>` cannot set a header, hence the token in the query; a client that
/// can sends `Authorization: Bearer …` instead and leaves it out of the URL.
///
/// Confined to those three directories, plus videos `read_file` handed out, by
/// **canonical** path, so neither `..` nor a symlink inside one reaches
/// anything else.
// ponytail: no Range support, so a long video plays but cannot seek; add it
// when recordings are viewed remotely.
async fn file(stream: TcpStream, token: &str) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    let (head, reader) = read_head(stream).await?;
    let mut stream = reader.into_inner().into_inner();
    let query = head.target.split_once('?').map(|(_, q)| q).unwrap_or_default();
    // A header where the client can set one — the desktop app's proxy — so the
    // token rides no URL; the query for an `<img>` in a plain browser.
    let mut given = (head.bearer.unwrap_or_default(), String::new());
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match &*key {
            "token" if given.0.is_empty() => given.0 = value.into_owned(),
            "path" => given.1 = value.into_owned(),
            _ => {}
        }
    }

    let refuse = |status: &str| format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    if !same_token(&given.0, token) {
        stream.write_all(refuse("401 Unauthorized").as_bytes()).await?;
        return Ok(());
    }
    let Some(path) = servable(&given.1).await else {
        stream.write_all(refuse("404 Not Found").as_bytes()).await?;
        return Ok(());
    };

    let mut body = tokio::fs::File::open(&path).await?;
    let len = body.metadata().await?.len();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
        content_type(&path)
    );
    stream.write_all(head.as_bytes()).await?;
    tokio::io::copy(&mut body, &mut stream).await?;
    stream.shutdown().await.ok();
    Ok(())
}

/// The canonical path where it sits inside a servable directory, else `None`
/// — absent and forbidden answer alike, so the route does not say which files
/// exist outside them.
async fn servable(path: &str) -> Option<PathBuf> {
    if let Some(real) = servable_under(&store::get_home_app_dir().await.ok()?, path).await {
        return Some(real);
    }
    let real = tokio::fs::canonicalize(path).await.ok()?;
    let opened = OPENED_VIDEOS.lock().unwrap_or_else(|e| e.into_inner());
    opened.contains(&real).then_some(real)
}

/// Videos the Files view opened, by canonical path — the desktop app's
/// `allow_file` stated again. A video is too big to answer inline, so the
/// viewer streams it through `/file`, and nothing else would let a project
/// file through. Never shrinks, as the asset scope does not.
static OPENED_VIDEOS: std::sync::LazyLock<Mutex<std::collections::HashSet<PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

async fn read_file(path: &str) -> Result<files::FileBody, String> {
    let body = files::read_body(path).await?;
    if let files::FileBody::Video { path } = &body {
        OPENED_VIDEOS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(PathBuf::from(path));
    }
    Ok(body)
}

async fn servable_under(home: &std::path::Path, path: &str) -> Option<PathBuf> {
    let real = tokio::fs::canonicalize(path).await.ok()?;
    let browser = home.join("browser");
    for root in [home.join("attachments"), browser.join("recordings"), browser.join("shots")] {
        if let Ok(root) = tokio::fs::canonicalize(&root).await {
            if real.starts_with(&root) && real.is_file() {
                return Some(real);
            }
        }
    }
    None
}

fn content_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("mp4" | "m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

async fn connection(
    stream: TcpStream,
    sink: Sink,
    hub: Hub,
    token: &str,
    tunnel_file: &Path,
    hosts: bool,
) -> Result<()> {
    let admitted = tokio::time::timeout(ADMIT, async {
        let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, resp: Response| {
            match req.headers().get("origin").map(|o| o.to_str().unwrap_or_default()) {
                Some(origin) if !local_origin(origin) && !tunnel_origin(origin, tunnel_file) => {
                    let mut refused = ErrorResponse::new(Some("origin not allowed".to_string()));
                    *refused.status_mut() = StatusCode::FORBIDDEN;
                    Err(refused)
                }
                _ => Ok(resp),
            }
        })
        .await
        .context("handshake")?;
        let (write, mut read) = ws.split();
        loop {
            match read.next().await {
                Some(Ok(Message::Text(text))) => return Ok(Some((write, read, text.to_string()))),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                _ => return Ok::<_, anyhow::Error>(None),
            }
        }
    })
    .await
    .context("no hello in time")??;
    let Some((mut write, mut read, hello)) = admitted else {
        return Ok(());
    };
    if let Some(refusal) = judge_hello(&hello, token) {
        write
            .send(Message::text(json!({ "err": refusal }).to_string()))
            .await
            .ok();
        write.close().await.ok();
        return Ok(());
    }
    // Subscribed only once admitted, so nothing reaches a client the token
    // has not let in — and under the lock the sink notes events with, so the
    // snapshot and the stream meet exactly.
    let (mut events, snapshot) = {
        let live = hub.live.lock().unwrap_or_else(|e| e.into_inner());
        (hub.events.subscribe(), live.snapshot())
    };
    // `release` is the CLI release this binary shipped in, which is what the
    // app compares with the newest one out. Set by release-cli.yml alone, so a
    // local build says none and is never offered an update. `dictation` is
    // whether `transcribe_upload` exists here, so a phone knows to draw a mic.
    let welcome = json!({
        "v": PROTOCOL,
        "version": env!("CARGO_PKG_VERSION"),
        "release": option_env!("DRAY_CLI_VERSION"),
        "stale": stale(),
        "dictation": cfg!(feature = "desktop"),
    });
    write.send(Message::text(welcome.to_string())).await?;
    write.send(Message::text(snapshot)).await?;

    // Replies come back from concurrent tasks, so one writer owns the socket.
    let (replies, mut outgoing) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        loop {
            let frame: String = tokio::select! {
                reply = outgoing.recv() => match reply {
                    Some(reply) => reply,
                    None => break,
                },
                event = events.recv() => match event {
                    Ok(event) => event.to_string(),
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[serve] client fell {n} events behind; dropping it");
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            if write.send(Message::text(frame)).await.is_err() {
                break;
            }
        }
        write.close().await.ok();
    });

    let connection = NEXT_CALL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let offer = serde_json::from_str::<Hello>(&hello).ok().and_then(|h| h.host).filter(|_| hosts);
    if let Some(offer) = offer {
        *host() = Some(Host { connection, browser: offer.browser, frames: replies.clone(), waiting: HashMap::new() });
    }

    // Not `?`: a reset must still reach the cleanup below, or a call
    // waiting on this host waits forever.
    let mut failed = None;
    while let Some(frame) = read.next().await {
        let text = match frame {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(e) => {
                failed = Some(e);
                break;
            }
        };
        let frame: Value = serde_json::from_str(&text).unwrap_or_default();
        if frame.get("reply").is_some() {
            answered(connection, frame);
            continue;
        }
        let call: Call = match serde_json::from_value(frame) {
            Ok(call) => call,
            Err(e) => {
                eprintln!("[serve] unreadable frame: {e}");
                continue;
            }
        };
        // Concurrently, as Tauri runs async commands: a send that spawns a
        // child must not hold a permission reply behind it.
        let (sink, replies) = (sink.clone(), replies.clone());
        tokio::spawn(async move {
            let reply = match dispatch(&call.cmd, call.args, sink).await {
                Ok(ok) => json!({ "id": call.id, "ok": ok }),
                Err(err) => json!({ "id": call.id, "err": err }),
            };
            let _ = replies.send(reply.to_string());
        });
    }

    // Dropping its waiters answers every call still out on it.
    let mut host = host();
    if host.as_ref().is_some_and(|h| h.connection == connection) {
        *host = None;
    }
    drop(host);
    drop(replies);
    writer.abort();
    failed.map_or(Ok(()), |e| Err(e.into()))
}

/// A reply from the host, handed to the call waiting on it.
fn answered(connection: u64, frame: Value) {
    let reply = match frame.get("err") {
        Some(err) => Err(err.clone()),
        None => Ok(frame.get("ok").cloned().unwrap_or(Value::Null)),
    };
    let waiter = frame["reply"].as_u64().and_then(|call| {
        host().as_mut().filter(|h| h.connection == connection).and_then(|h| h.waiting.remove(&call))
    });
    if let Some(waiter) = waiter {
        let _ = waiter.send(reply);
    }
}

/// A command's answer as the wire carries it: the value, or the error as
/// Tauri would have serialized it for a rejected `invoke`.
trait IntoReply {
    fn into_reply(self) -> Result<Value, Value>;
}

impl<T: Serialize, E: Serialize> IntoReply for Result<T, E> {
    fn into_reply(self) -> Result<Value, Value> {
        match self {
            Ok(value) => serde_json::to_value(value).map_err(|e| json!(e.to_string())),
            Err(err) => Err(serde_json::to_value(err).unwrap_or_else(|e| json!(e.to_string()))),
        }
    }
}

/// For a command that cannot fail.
fn ok<T>(value: T) -> Result<T, ()> {
    Ok(value)
}

/// One arm per command: its name, its arguments as `invoke` names them, the
/// call. Rust cannot read a function's parameter names back, which is why the
/// arguments are stated here a second time.
macro_rules! table {
    ($cmd:expr, $args:expr; $( $name:ident ( $($arg:ident : $ty:ty),* $(,)? ) => $call:expr ;)*) => {
        match $cmd {
            $(stringify!($name) => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                #[allow(non_camel_case_types, dead_code)]
                struct Args { $($arg: $ty),* }
                let args = if $args.is_null() { json!({}) } else { $args };
                #[allow(unused_variables)]
                let Args { $($arg),* } = serde_json::from_value(args)
                    .map_err(|e| json!(format!("invalid arguments to {}: {e}", $cmd)))?;
                IntoReply::into_reply($call)
            })*
            // How a desktop-only command looks from here.
            _ => Err(json!(format!("unknown command {}", $cmd))),
        }
    };
}

/// What the Mac's server answers beyond the core: Remote access, which moved
/// into it from the app, and the restart an update asks for.
#[cfg(feature = "desktop")]
async fn dispatch_mac(cmd: &str, args: Value, sink: Sink) -> Result<Value, Value> {
    table! { cmd, args;
        get_remote_access() => ok(crate::remote_access::get_remote_access());
        set_remote_access(on: bool) => crate::remote_access::set_remote_access(sink, on).await;
        remote_access_token() => crate::remote_access::remote_access_token().await;
        remote_access_qr() => crate::remote_access::remote_access_qr().await;
        restart_when_idle() => ok(restart_when_idle().await);
        transcribe_upload(path: String) => crate::transcription::transcribe_upload(path).await;
    }
}

/// Every core command the desktop exposes, minus the ones that act on the
/// server's own desktop: opening apps and terminals, and the pasteboard.
/// Mac-only modules are not compiled here.
async fn dispatch(cmd: &str, args: Value, sink: Sink) -> Result<Value, Value> {
    #[cfg(feature = "desktop")]
    if matches!(
        cmd,
        "get_remote_access"
            | "set_remote_access"
            | "remote_access_token"
            | "remote_access_qr"
            | "restart_when_idle"
            | "transcribe_upload"
    ) {
        return dispatch_mac(cmd, args, sink).await;
    }
    // The recorder and model live in the app, so a client with no microphone
    // of its own — the Island — dictates through the app's.
    #[cfg(feature = "desktop")]
    if crate::transcription::HOSTED.contains(&cmd) {
        return host_call(cmd, args).await.unwrap_or_else(|| Err(json!("Open Dray to dictate.")));
    }
    // The Island's title opens its session in the app's window, which only the app can raise.
    #[cfg(feature = "desktop")]
    if cmd == "show_session" {
        return host_call(cmd, args).await.unwrap_or_else(|| Err(json!("Dray's window is closed.")));
    }
    // A `dray-serve` updates itself; the Mac's server follows the app instead.
    #[cfg(not(feature = "desktop"))]
    if matches!(cmd, "update_server" | "restart_now" | "restart_when_idle") {
        return table! { cmd, args;
            update_server(channel: String) => update_server(channel).await;
            restart_now() => ok(restart_now());
            restart_when_idle() => ok(restart_when_idle().await);
        };
    }
    table! { cmd, args;
        // What a connect opens with, asked again by an app whose webview was
        // not yet listening when it connected — `dray-serve` included, which
        // an app installed after it meets as This Mac.
        live_state() => ok(HUB.live.lock().unwrap_or_else(|e| e.into_inner()).payload());
        // Sessions.
        send_msg(
            session_id: String, prompt: String, attachment_paths: Vec<String>,
            harness: Harness, model: ModelId, effort: Option<Effort>,
            permission_mode: ApprovalPolicy, fast: bool, cwd: String,
            branch: Option<String>, use_worktree: bool, worktree_name: Option<String>,
            base_ref: Option<String>, is_new_session: bool,
        ) => crate::send_msg(
            &session_id, &prompt, attachment_paths, harness, model, effort,
            permission_mode, fast, &cwd, branch.as_deref(), use_worktree,
            worktree_name.as_deref(), base_ref.as_deref(), is_new_session, sink,
        ).await;
        interrupt_session(session_id: String) => crate::interrupt_session(&session_id, sink).await;
        stop_task(session_id: String, task_id: String) => crate::stop_task(&session_id, &task_id).await;
        cancel_queued(session_id: String) => crate::cancel_queued(&session_id).await;
        respond_permission(session_id: String, request_id: String, option_id: String) =>
            crate::respond_permission(&session_id, &request_id, &option_id, sink).await;
        answer_questions(session_id: String, request_id: String, answers: HashMap<String, String>) =>
            crate::answer_questions(&session_id, &request_id, answers, sink).await;
        mark_session_read(session_id: String, read: bool) => crate::mark_session_read(&session_id, read, sink).await;
        set_session_flags(session_id: String, archived: Option<bool>, pinned: Option<bool>, hidden: Option<bool>, aside: Option<bool>) =>
            crate::set_session_flags(&session_id, archived, pinned, hidden, aside).await;
        rename_session(session_id: String, title: String) => crate::rename_session(session_id, title, sink).await;
        delete_session(session_id: String) => crate::delete_session(&session_id).await;
        fork_session(session_id: String, fork_id: String, worktree: bool) =>
            crate::fork_session(&session_id, &fork_id, worktree).await;
        session_index_item(session_id: String) => crate::session_index_item(&session_id).await;
        worktree_disposition(session_id: String) => crate::worktree_disposition(&session_id).await;
        remove_session_worktree(session_id: String) => crate::remove_session_worktree(&session_id).await;
        detach_session(session_id: String) => store::detach_session(&session_id).await;
        set_auto_continue(session_id: String, on: bool) => crate::auto_continue::set_auto_continue(session_id, on, sink).await;
        list_session_index_items(archived: bool) => store::list_session_index_items(archived).await;
        get_session_by_id(session_id: String, turns: Option<u32>) => store::get_session_by_id(&session_id, turns).await;
        get_session_page(session_id: String, before: u64, turns: u32) => store::get_session_page(&session_id, before, turns).await;

        // Agents and models.
        agent_availability() => ok(crate::agent_availability().await);
        list_models(harness: Option<Harness>) => ok(crate::list_models(sink, harness).await);
        refresh_models() => ok(crate::refresh_models().await);
        set_fx_provider(provider: String) => crate::set_fx_provider(provider).await;
        list_slash_commands(cwd: String, harness: Harness) => crate::list_slash_commands(&cwd, harness).await;
        agent_accounts(cwd: String) => ok(crate::accounts::agent_accounts(cwd).await);
        agent_auth_options(harness: Harness, provider: Option<String>) =>
            ok(crate::accounts::agent_auth_options(harness, provider));
        add_agent_account(harness: Harness, provider: Option<String>, auth: String, key: Option<String>) =>
            crate::accounts::add_agent_account(harness, provider, auth, key).await;
        sign_out_agent(harness: Harness, provider: Option<String>) =>
            crate::accounts::sign_out_agent(harness, provider).await;
        check_agent_updates() => ok(crate::agent_updates::check_agent_updates().await);
        update_agent(harness: Harness) => crate::agent_updates::update_agent(harness).await;

        // Projects and settings.
        list_projects() => crate::projects::list_projects().await;
        add_project(path: String) => crate::projects::add_project(&path).await;
        github_repos() => crate::projects::github_repos().await;
        clone_github_repo(slug: String) => crate::projects::clone_github_repo(slug, sink).await;
        remove_project(path: String) => crate::projects::remove_project(&path).await;
        set_last_selected_project(path: String) => crate::projects::set_last_selected_project(&path).await;
        set_project_space(path: String, space: Option<String>) => crate::projects::set_project_space(&path, space).await;
        move_project(path: String, delta: isize) => crate::projects::move_project(&path, delta).await;
        retag_space(from: String, to: Option<String>) => crate::projects::retag_space(&from, to).await;
        get_settings() => ok(crate::settings::get_settings().await);
        set_analytics_enabled(enabled: bool) => crate::set_analytics_enabled(enabled).await;
        analytics_identity() => ok(crate::analytics::analytics_identity().await);
        track_feature(feature: String) => ok(crate::track_feature(feature));
        track_render_error(code: Option<u32>, frames: Vec<String>) => ok(crate::track_render_error(code, frames));
        track_active_day() => ok(crate::analytics::track_active_day());

        // Git and files.
        list_branches(cwd: String) => git::list_branches(&cwd).await;
        checkout_branch(cwd: String, branch: String, stash: bool) => git::checkout_branch(&cwd, &branch, stash).await;
        changes_since(cwd: String, baseline: String, head: Option<String>) =>
            git::changes_since(&cwd, &baseline, head.as_deref()).await;
        file_change(cwd: String, base: String, head: String, path: String, old_path: Option<String>) =>
            git::file_change(&cwd, &base, &head, &path, old_path.as_deref()).await;
        head_tree(cwd: String) => ok(crate::head_tree(cwd).await);
        work_status(cwd: String) => ok(crate::work_status(cwd).await);
        log_commits(cwd: String, limit: u32, skip: u32) => git::log_commits(&cwd, limit, skip).await;
        log_branch_commits(cwd: String, limit: u32, skip: u32) => git::log_branch_commits(&cwd, limit, skip).await;
        warm_file_index(cwd: String) => files::warm_file_index(cwd).await;
        search_files(cwd: String, query: String, limit: usize) => files::search_files(cwd, query, limit).await;
        list_dir(cwd: String, dir: String) => files::list_dir(cwd, dir).await;
        read_file(path: String) => read_file(&path).await;
        // Servers listening on *this* machine, which is the one a forwarded
        // port reaches.
        list_local_servers(session_id: String) => crate::local_servers::list_local_servers(session_id).await;
        share_port(session_id: String, port: u16) => crate::share::share_port(session_id, port).await;
        stop_share(session_id: String, port: u16) => ok(crate::share::stop_share(session_id, port));
        share_ready() => ok(crate::share::share_ready().await);
        read_attachments(paths: Vec<String>) => ok(crate::attachments::read_attachments(paths).await);
        list_drafts() => crate::drafts::list_drafts().await;
        save_draft(draft: Value) => crate::drafts::save_draft(draft).await;
        // The island's ⌘S. Unlike `save_draft`, which the app's own autosave
        // calls on every pause in typing, it says so: nothing else tells the app.
        create_draft(draft: Value) => {
            let saved = crate::drafts::save_draft(draft).await;
            if saved.is_ok() {
                sink.emit(crate::drafts::DRAFTS_CHANGED, ()).ok();
            }
            saved
        };
        delete_draft(id: String) => crate::drafts::delete_draft(id).await;
        read_doc(path: String) => crate::docs::read_doc(path).await;
        save_doc(path: String, text: String, expect: Option<String>) => crate::docs::save_doc(path, text, expect).await;
        watch_docs(scope: String, paths: Vec<String>) => {
            let sink = sink.clone();
            // Synchronous and it joins a watcher thread on replace, so off
            // the runtime's workers — the desktop's `(async)` for the same reason.
            tokio::task::spawn_blocking(move || crate::docs::watch_docs(sink, scope, paths))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
        };

        // GitHub and issues.
        prs_for_branch(cwd: String, branch: String) => github::prs_for_branch(cwd, branch).await;
        pr_marks(cwd: String) => github::pr_marks(cwd).await;
        merge_pr(cwd: String, number: u64, method: MergeMethod) => github::merge_pr(cwd, number, method).await;
        delete_branch(cwd: String, number: u64) => github::delete_branch(cwd, number).await;
        reopen_pr(cwd: String, number: u64) => github::reopen_pr(cwd, number).await;
        mark_pr_ready(cwd: String, number: u64) => github::mark_pr_ready(cwd, number).await;
        recheck_gh() => ok(github::recheck_gh().await);
        get_integrations() => ok(issues::get_integrations().await);
        github_repo(cwd: String) => ok(issues::github_repo(cwd).await);
        connect_linear(key: String) => issues::connect_linear(key).await;
        disconnect_linear() => issues::disconnect_linear().await;
        list_issues(query: IssueQuery, limit: usize) => issues::list_issues(query, limit).await;
        get_issue(identifier: String, id: Option<String>) => issues::get_issue(identifier, id).await;
        update_issue(identifier: String, id: String, state_id: Option<String>, priority: Option<IssuePriority>) =>
            issues::update_issue(identifier, id, state_id, priority).await;
        fetch_issue_asset(url: String) => issues::fetch_issue_asset(url).await;
        list_issue_filters(tracker: IssueTracker, repo: Option<String>) => issues::list_issue_filters(tracker, repo).await;
        unlink_issue(session_id: String, key: String) => issues::unlink_issue(session_id, key).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_start_keeps_the_token() {
        let dir = std::env::temp_dir().join(format!("dray-serve-token-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("serve-token");

        let first = token_at(&path).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(token_at(&path).unwrap(), first);

        for broken in ["", "not a token", &first[..32]] {
            std::fs::write(&path, broken).unwrap();
            let minted = token_at(&path).unwrap();
            assert_ne!(minted, broken, "{broken:?} is not reused");
            assert_eq!(minted.len(), 64);
        }

        std::fs::remove_file(&path).unwrap();
        assert_ne!(token_at(&path).unwrap(), first, "deleting the file rotates");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn local_origins() {
        for origin in [
            "http://localhost:1420",
            "http://127.0.0.1:5173",
            "https://localhost",
            "http://[::1]:8080",
        ] {
            assert!(local_origin(origin), "{origin}");
        }
        for origin in [
            "https://evil.test",
            "http://localhost.evil.test",
            "http://127.0.0.1.evil.test:80",
            "http://evil.test/localhost",
            "file://localhost",
            "null",
        ] {
            assert!(!local_origin(origin), "{origin}");
        }
    }

    #[test]
    fn the_tunnels_own_origin_and_no_other() {
        let file = std::env::temp_dir().join(format!("dray-tunnel-url-{}", uuid::Uuid::new_v4().simple()));
        assert!(!tunnel_origin("https://a-b-c.trycloudflare.com", &file), "no tunnel, no origin");
        std::fs::write(&file, "https://a-b-c.trycloudflare.com\n").unwrap();
        assert!(tunnel_origin("https://a-b-c.trycloudflare.com", &file));
        for other in ["https://x-y-z.trycloudflare.com", "http://a-b-c.trycloudflare.com", "https://a-b-c.trycloudflare.com.evil.test", ""] {
            assert!(!tunnel_origin(other, &file), "{other}");
        }
        std::fs::write(&file, "").unwrap();
        assert!(!tunnel_origin("", &file), "an empty file names nothing");
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn hello_names_the_side_behind() {
        let token = "abc";
        assert_eq!(judge_hello(r#"{"v":1,"token":"abc"}"#, token), None);
        assert!(judge_hello(r#"{"v":0,"token":"abc"}"#, token)
            .unwrap()
            .contains("update the Dray app"));
        assert!(judge_hello(r#"{"v":2,"token":"abc"}"#, token)
            .unwrap()
            .contains("update dray-serve"));
        // Version is judged before the token, so an old client is told to
        // update rather than that its token is wrong.
        assert!(judge_hello(r#"{"v":0,"token":"nope"}"#, token)
            .unwrap()
            .contains("update the Dray app"));
        assert_eq!(judge_hello(r#"{"v":1,"token":"abd"}"#, token).as_deref(), Some("wrong token"));
        assert_eq!(judge_hello(r#"{"v":1}"#, token).as_deref(), Some("wrong token"));
        assert!(judge_hello("not json", token).is_some());
    }

    fn ask(session: &str, request: &str) -> Value {
        json!({ "sessionId": session, "payload": { "type": "permission_requested", "requestId": request } })
    }

    fn open(live: &Live) -> Vec<String> {
        live.asks.iter().map(|a| a["payload"]["requestId"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn live_state_keeps_only_answerable_asks() {
        let mut live = Live::default();
        live.note("session_status", &json!({ "sessionId": "s", "status": "in_progress" }));
        live.note("agent_event", &ask("s", "r1"));
        live.note("agent_event", &ask("s", "r2"));
        live.note(
            "agent_event",
            &json!({ "sessionId": "s", "payload": { "type": "permission_decided", "requestId": "r1" } }),
        );
        assert_eq!(open(&live), ["r2"]);

        // A background task outlives the turn and its subagent may be asking.
        live.note(
            "agent_event",
            &json!({ "sessionId": "s", "payload": { "type": "background_tasks_changed", "tasks": [{ "id": "t" }] } }),
        );
        live.note("session_status", &json!({ "sessionId": "s", "status": "completed" }));
        assert_eq!(open(&live), ["r2"]);

        // With the last task gone and no turn running, nothing can answer it.
        live.note(
            "agent_event",
            &json!({ "sessionId": "s", "payload": { "type": "background_tasks_changed", "tasks": [] } }),
        );
        assert!(open(&live).is_empty());
        assert!(live.tasks.is_empty());
        assert!(live.snapshot().contains("\"live_state\""));
    }

    #[tokio::test]
    async fn files_are_served_from_the_two_directories_alone() {
        let home = std::env::temp_dir().join(format!("dray-serve-test-{}", uuid::Uuid::new_v4()));
        let attachments = home.join("attachments/s");
        std::fs::create_dir_all(&attachments).unwrap();
        std::fs::write(attachments.join("a.png"), b"png").unwrap();
        std::fs::write(home.join("index.json"), b"{}").unwrap();
        let serve = |path: PathBuf| {
            let home = home.clone();
            async move { servable_under(&home, path.to_str().unwrap()).await }
        };

        let inside = attachments.join("a.png");
        assert!(serve(inside.clone()).await.is_some());
        assert!(serve(attachments.join("../../index.json")).await.is_none());
        assert!(serve(home.join("index.json")).await.is_none());
        assert!(serve(PathBuf::from("/etc/passwd")).await.is_none());
        assert_eq!(content_type(&inside), "image/png");
        std::fs::remove_dir_all(&home).ok();
    }

    /// A streamed body larger than one read lands whole under its own name, as
    /// the app sends it; a wrong token or a path for a name does not.
    #[tokio::test]
    async fn an_upload_lands_under_uploads() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/upload", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(upload(stream, "tok"));
            }
        });
        let body: Vec<u8> = (0..300_000u32).map(|i| i as u8).collect();
        let post = |token: &'static str, name: &'static str| {
            let (base, body) = (base.clone(), body.clone());
            async move {
                let len = body.len();
                let chunks = futures_util::stream::iter(
                    body.chunks(64 * 1024).map(|c| Ok::<_, std::io::Error>(c.to_vec())).collect::<Vec<_>>(),
                );
                crate::http()
                    .post(base)
                    .query(&[("name", name)])
                    .bearer_auth(token)
                    .header(reqwest::header::CONTENT_LENGTH, len)
                    .body(reqwest::Body::wrap_stream(chunks))
                    .send()
                    .await
                    .unwrap()
            }
        };

        let landed = post("tok", "data.csv").await.text().await.unwrap();
        let uploads = store::get_home_app_dir().await.unwrap().join("attachments/uploads");
        assert!(Path::new(&landed).starts_with(&uploads), "{landed}");
        assert!(landed.ends_with("/data.csv"));
        assert_eq!(std::fs::read(&landed).unwrap(), body);
        std::fs::remove_dir_all(Path::new(&landed).parent().unwrap()).ok();

        assert_eq!(post("nope", "data.csv").await.status(), 401);
        assert_eq!(post("tok", "..").await.status(), 400);
    }

    #[tokio::test]
    async fn unknown_and_malformed_commands_answer_err() {
        let sink = Sink::new(|_, _| {});
        let err = dispatch("browser_open", Value::Null, sink.clone()).await.unwrap_err();
        assert_eq!(err, json!("unknown command browser_open"));
        let err = dispatch("stop_task", json!({ "sessionId": 1 }), sink).await.unwrap_err();
        assert!(err.as_str().unwrap().starts_with("invalid arguments to stop_task"));
    }
}
