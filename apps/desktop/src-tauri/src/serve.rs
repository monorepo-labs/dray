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

/// Runs the server until the process ends.
pub async fn run(port: u16) -> Result<()> {
    // Two processes on one home reset each other's sessions at start, take
    // each other's socket and rewrite one index whole, each over the other.
    // A socket that answers is a Dray already living here.
    let home = store::get_home_app_dir().await?;
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

    let (events, _) = broadcast::channel::<Arc<str>>(EVENT_BACKLOG);
    let live = Arc::new(Mutex::new(Live::default()));
    let sink = {
        let (events, live) = (events.clone(), live.clone());
        Sink::new(move |event, payload| {
            // Noted and sent under one lock, which is what lets a connecting
            // client take a snapshot and subscribe with nothing falling
            // between the two or landing in both.
            let mut live = live.lock().unwrap_or_else(|e| e.into_inner());
            live.note(event, &payload);
            let frame = json!({ "event": event, "payload": payload }).to_string();
            // No receivers is ordinary: nobody connected yet.
            let _ = events.send(frame.into());
        })
    };

    // Agents this server spawns reach it through `dray`, so it serves the
    // socket the desktop app does — under `DRAY_HOME` where that is set.
    let orchestration = sink.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::orchestration::serve(orchestration).await {
            eprintln!("[orchestration err] {e:#}");
        }
    });

    let (token, token_path) = mint_token().await?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("could not bind {addr}"))?;

    eprintln!(
        "dray-serve listening on ws://{}, token in {}",
        listener.local_addr()?,
        token_path.display()
    );

    let token: Arc<str> = token.into();
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                eprintln!("[serve accept err] {e}");
                continue;
            }
        };
        let (sink, events, live, token) = (sink.clone(), events.clone(), live.clone(), token.clone());
        tokio::spawn(async move {
            let served = match request_line(&stream).await {
                Some(line) if line.starts_with("GET /file?") => file(stream, &token).await,
                Some(_) => connection(stream, sink, events, live, &token).await,
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
async fn mint_token() -> Result<(String, PathBuf)> {
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
        let tasks: Vec<&Value> = self.tasks.values().collect();
        json!({ "event": "live_state", "payload": { "asks": self.asks, "tasks": tasks } }).to_string()
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

/// `GET /file?token=…&path=…`: what `convertFileSrc` serves inside the desktop
/// app — attached images and browser recordings — for a client elsewhere. An
/// `<img>` cannot set a header, hence the token in the query; a client that
/// can sends `Authorization: Bearer …` instead and leaves it out of the URL.
///
/// Confined to those two directories, plus videos `read_file` handed out, by
/// **canonical** path, so neither `..` nor a symlink inside one reaches
/// anything else.
// ponytail: no Range support, so a long video plays but cannot seek; add it
// when recordings are viewed remotely.
async fn file(stream: TcpStream, token: &str) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let mut reader = BufReader::new(stream.take(FILE_HEAD_LIMIT));
    let mut line = String::new();
    let mut bearer = None;
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
                }
            }
        }
    };
    tokio::time::timeout(ADMIT, head).await.context("request head timed out")??;
    if reader.get_ref().limit() == 0 {
        anyhow::bail!("request head over {FILE_HEAD_LIMIT} bytes");
    }
    let target = line.split(' ').nth(1).unwrap_or_default().to_string();
    let mut stream = reader.into_inner().into_inner();

    let query = target.split_once('?').map(|(_, q)| q).unwrap_or_default();
    // A header where the client can set one — the desktop app's proxy — so the
    // token rides no URL; the query for an `<img>` in a plain browser.
    let mut given = (bearer.unwrap_or_default(), String::new());
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
    for root in [home.join("attachments"), home.join("browser").join("recordings")] {
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
    events: broadcast::Sender<Arc<str>>,
    live: Arc<Mutex<Live>>,
    token: &str,
) -> Result<()> {
    let admitted = tokio::time::timeout(ADMIT, async {
        let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, resp: Response| {
            match req.headers().get("origin").map(|o| o.to_str().unwrap_or_default()) {
                Some(origin) if !local_origin(origin) => {
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
        let live = live.lock().unwrap_or_else(|e| e.into_inner());
        (events.subscribe(), live.snapshot())
    };
    write
        .send(Message::text(json!({ "v": PROTOCOL }).to_string()))
        .await?;
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

    while let Some(frame) = read.next().await {
        let text = match frame? {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let call: Call = match serde_json::from_str(&text) {
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

    drop(replies);
    writer.abort();
    Ok(())
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

/// Every core command the desktop exposes, minus the ones that act on the
/// server's own desktop: opening apps and terminals, and the pasteboard.
/// Mac-only modules are not compiled here.
async fn dispatch(cmd: &str, args: Value, sink: Sink) -> Result<Value, Value> {
    table! { cmd, args;
        // Sessions.
        send_msg(
            session_id: String, prompt: String, attachment_paths: Vec<String>,
            harness: Harness, model: ModelId, effort: Option<Effort>,
            permission_mode: ApprovalPolicy, fast: bool, cwd: String,
            branch: Option<String>, use_worktree: bool, worktree_name: Option<String>,
            is_new_session: bool,
        ) => crate::send_msg(
            &session_id, &prompt, attachment_paths, harness, model, effort,
            permission_mode, fast, &cwd, branch.as_deref(), use_worktree,
            worktree_name.as_deref(), is_new_session, sink,
        ).await;
        interrupt_session(session_id: String) => crate::interrupt_session(&session_id, sink).await;
        stop_task(session_id: String, task_id: String) => crate::stop_task(&session_id, &task_id).await;
        cancel_queued(session_id: String) => crate::cancel_queued(&session_id).await;
        respond_permission(session_id: String, request_id: String, option_id: String) =>
            crate::respond_permission(&session_id, &request_id, &option_id, sink).await;
        answer_questions(session_id: String, request_id: String, answers: HashMap<String, String>) =>
            crate::answer_questions(&session_id, &request_id, answers, sink).await;
        mark_session_read(session_id: String, read: bool) => crate::mark_session_read(&session_id, read).await;
        set_session_flags(session_id: String, archived: Option<bool>, pinned: Option<bool>, hidden: Option<bool>) =>
            crate::set_session_flags(&session_id, archived, pinned, hidden).await;
        rename_session(session_id: String, title: String) => crate::rename_session(session_id, title, sink).await;
        delete_session(session_id: String) => crate::delete_session(&session_id).await;
        fork_session(session_id: String, fork_id: String, worktree: bool) =>
            crate::fork_session(&session_id, &fork_id, worktree).await;
        session_index_item(session_id: String) => crate::session_index_item(&session_id).await;
        worktree_disposition(session_id: String) => crate::worktree_disposition(&session_id).await;
        remove_session_worktree(session_id: String) => crate::remove_session_worktree(&session_id).await;
        detach_session(session_id: String) => store::detach_session(&session_id).await;
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
        remove_project(path: String) => crate::projects::remove_project(&path).await;
        set_last_selected_project(path: String) => crate::projects::set_last_selected_project(&path).await;
        set_project_space(path: String, space: Option<String>) => crate::projects::set_project_space(&path, space).await;
        move_project(path: String, delta: isize) => crate::projects::move_project(&path, delta).await;
        retag_space(from: String, to: Option<String>) => crate::projects::retag_space(&from, to).await;
        get_settings() => ok(crate::settings::get_settings().await);
        set_analytics_enabled(enabled: bool) => crate::set_analytics_enabled(enabled).await;
        analytics_identity() => ok(crate::analytics::analytics_identity().await);
        track_feature(feature: String) => ok(crate::track_feature(feature));
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
        read_attachments(paths: Vec<String>) => ok(crate::attachments::read_attachments(paths).await);
        list_drafts() => crate::drafts::list_drafts().await;
        save_draft(draft: Value) => crate::drafts::save_draft(draft).await;
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

    #[tokio::test]
    async fn unknown_and_malformed_commands_answer_err() {
        let sink = Sink::new(|_, _| {});
        let err = dispatch("browser_open", Value::Null, sink.clone()).await.unwrap_err();
        assert_eq!(err, json!("unknown command browser_open"));
        let err = dispatch("stop_task", json!({ "sessionId": 1 }), sink).await.unwrap_err();
        assert!(err.as_str().unwrap().starts_with("invalid arguments to stop_task"));
    }
}
