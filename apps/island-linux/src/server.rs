//! This computer's Dray server, as the Mac island and the iOS app reach it:
//! one WebSocket to `dray --serve`, address and token read from `serve-port`
//! and `serve-token` in the home Dray hands over as `DRAY_HOME`. The wire is
//! `serve.rs`'s; see its module comment.

use crate::asks::Ask;
use futures::channel::oneshot;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;
use tungstenite::{Message, WebSocket};

/// `serve.rs`'s `PROTOCOL`. The server refuses any other.
const PROTOCOL: u32 = 1;

/// One session as the index lists it: the fields the island reads, each
/// lenient, so a renamed one shows up as a missing value and not a dead socket.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub session_id: String,
    pub title: String,
    pub project_path: String,
    pub status: String,
    pub modified: String,
    pub hidden: Option<bool>,
    pub archived: Option<bool>,
    /// Set aside by the reader: started, not wanted now. Out of the switcher.
    pub aside: Option<bool>,
    // What a reply is sent with: the session's own settings, read fresh.
    pub harness: String,
    pub model: String,
    pub effort: Option<String>,
    pub permission_mode: String,
    pub fast: Option<bool>,
    pub cwd: String,
}

impl Session {
    pub fn project(&self) -> &str {
        Path::new(&self.project_path).file_name().and_then(|n| n.to_str()).unwrap_or("")
    }
}

#[derive(Debug)]
pub enum Update {
    /// No server to reach: Dray has not started one, or it is restarting.
    Unreachable,
    /// The server turned the hello away, with its own sentence.
    Refused(String),
    Sessions(Vec<Session>),
    /// One session's entry, new or changed.
    Session(Session),
    Status { session_id: String, status: String, modified: Option<String> },
    Title { session_id: String, title: String },
    /// The cards waiting and background tasks running, as the server holds
    /// them on every connect.
    Live { asks: Vec<Ask>, tasks: HashMap<String, usize> },
    Asked(Ask),
    Decided { session_id: String, request_id: String },
    Tasks { session_id: String, count: usize },
}

/// What a call answers: the `ok` value, or the server's own sentence.
pub type Reply = Result<Value, String>;

enum Outbound {
    List,
    Call(String, Value, oneshot::Sender<Reply>),
}

/// The home Dray's server lives in: `DRAY_HOME` as the app hands it over, or
/// a release's `~/.dray`.
fn home() -> Option<PathBuf> {
    std::env::var_os("DRAY_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|h| h.join(".dray")))
}

/// Read at every connect, since a restarted server listens on a fresh port.
/// `serve-port`'s first line is the port; later lines are the server's own.
fn address() -> Option<(String, String)> {
    let home = home()?;
    let port = std::fs::read_to_string(home.join("serve-port")).ok()?;
    let port = port.lines().next()?.trim().to_string();
    let token = std::fs::read_to_string(home.join("serve-token")).ok()?.trim().to_string();
    (!port.is_empty() && !token.is_empty()).then(|| (format!("ws://127.0.0.1:{port}"), token))
}

/// Hands calls to the connection thread.
pub struct Server {
    asks: Sender<Outbound>,
}

impl Server {
    /// The index changes without telling other clients — the sidebar's own
    /// settle and delete emit nothing — so the panel asks again on each open.
    pub fn relist(&self) {
        let _ = self.asks.send(Outbound::List);
    }

    /// One command, answered once the server replies. With no connection up
    /// it answers at once, so a click never waits on a socket that is down.
    pub fn call(&self, cmd: &str, args: Value) -> oneshot::Receiver<Reply> {
        let (tx, rx) = oneshot::channel();
        let _ = self.asks.send(Outbound::Call(cmd.to_string(), args, tx));
        rx
    }
}

/// Keeps a connection up for the island's life on a thread of its own,
/// calling `on_update` from that thread.
pub fn run(on_update: impl Fn(Update) + Send + 'static) -> Server {
    let (sender, asks) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("island-server".into())
        .spawn(move || {
            loop {
                // A call made while no socket is up is refused now, not held:
                // a held answer could land on a card the reader already left.
                while let Ok(ask) = asks.try_recv() {
                    if let Outbound::Call(_, _, reply) = ask {
                        let _ = reply.send(Err("Dray's server isn't reachable.".into()));
                    }
                }
                let wait = match connect(&on_update, &asks) {
                    Ok(()) => Duration::from_secs(1),
                    Err(Gone::Refused(why)) => {
                        on_update(Update::Refused(why));
                        // A refused token is fixed by Dray writing a new one,
                        // which the next read picks up; no need to hammer.
                        Duration::from_secs(5)
                    }
                    Err(Gone::Unreachable) => {
                        on_update(Update::Unreachable);
                        Duration::from_secs(2)
                    }
                };
                std::thread::sleep(wait);
            }
        })
        .expect("server thread");
    Server { asks: sender }
}

enum Gone {
    Unreachable,
    Refused(String),
}

/// How often a quiet socket checks for calls to send.
const POLL: Duration = Duration::from_millis(200);

/// One connection, from hello to the socket dropping.
fn connect(on_update: &impl Fn(Update), asks: &Receiver<Outbound>) -> Result<(), Gone> {
    let (url, token) = address().ok_or(Gone::Unreachable)?;
    let stream = TcpStream::connect(url.trim_start_matches("ws://")).map_err(|_| Gone::Unreachable)?;
    let (mut socket, _) = tungstenite::client(url.as_str(), stream).map_err(|_| Gone::Unreachable)?;
    // `client` is what the server counts the island's use by, and is what
    // `island_links` answers to.
    let hello = json!({ "v": PROTOCOL, "token": token, "client": "island" });
    socket.send(Message::text(hello.to_string())).map_err(|_| Gone::Unreachable)?;
    let welcome = next_json(&mut socket).ok_or(Gone::Unreachable)?;
    if let Some(err) = welcome.get("err").and_then(Value::as_str) {
        return Err(Gone::Refused(err.to_string()));
    }
    // Only after the handshake: a timeout mid-handshake fails it.
    socket.get_ref().set_read_timeout(Some(POLL)).map_err(|_| Gone::Unreachable)?;
    let mut calls = Calls::default();
    if !calls.send(&mut socket, Outbound::List) {
        return Ok(());
    }
    let result = loop {
        // Every pass, not only after a quiet read: a session streaming
        // deltas never lets the socket go quiet, and an answer held back
        // would leave its agent blocked.
        if !send_waiting(&mut socket, &mut calls, asks) {
            break Ok(());
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                    if let Some(update) = calls.answer(id, frame) {
                        on_update(update);
                    }
                } else if let Some(update) = read(frame) {
                    on_update(update);
                }
            }
            Ok(Message::Close(_)) => break Ok(()),
            Ok(_) => {}
            // tungstenite keeps a half-read frame buffered, so a timeout
            // mid-frame resumes where it left off; the next pass sends.
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break Ok(()),
        }
    };
    // Whatever was waiting on this socket learns it went.
    for (_, reply) in calls.waiting.drain() {
        let _ = reply.send(Err("The connection to Dray's server dropped.".into()));
    }
    result
}

/// Sends whatever the island has asked for since the last pass; `false`
/// once the socket has gone.
fn send_waiting(socket: &mut WebSocket<TcpStream>, calls: &mut Calls, asks: &Receiver<Outbound>) -> bool {
    let mut listed = false;
    while let Ok(ask) = asks.try_recv() {
        // A burst of relists is one list.
        if matches!(ask, Outbound::List) && std::mem::replace(&mut listed, true) {
            continue;
        }
        if !calls.send(socket, ask) {
            return false;
        }
    }
    true
}

/// Calls sent on one connection and not yet answered.
#[derive(Default)]
struct Calls {
    next: u64,
    lists: Vec<u64>,
    waiting: HashMap<u64, oneshot::Sender<Reply>>,
}

impl Calls {
    /// `false` once the socket has gone.
    fn send(&mut self, socket: &mut WebSocket<TcpStream>, ask: Outbound) -> bool {
        self.next += 1;
        let id = self.next;
        let frame = match ask {
            Outbound::List => {
                self.lists.push(id);
                json!({ "id": id, "cmd": "list_session_index_items", "args": { "archived": false } })
            }
            Outbound::Call(cmd, args, reply) => {
                self.waiting.insert(id, reply);
                json!({ "id": id, "cmd": cmd, "args": args })
            }
        };
        socket.send(Message::text(frame.to_string())).is_ok()
    }

    fn answer(&mut self, id: u64, mut frame: Value) -> Option<Update> {
        if let Some(at) = self.lists.iter().position(|l| *l == id) {
            self.lists.remove(at);
            return serde_json::from_value(frame.get_mut("ok")?.take()).ok().map(Update::Sessions);
        }
        let reply = self.waiting.remove(&id)?;
        let answer = match frame.get_mut("err") {
            Some(err) => Err(err.as_str().map(str::to_string).unwrap_or_else(|| err.to_string())),
            None => Ok(frame.get_mut("ok").map(Value::take).unwrap_or(Value::Null)),
        };
        let _ = reply.send(answer);
        None
    }
}

/// The next text frame as JSON, skipping pings and anything unparseable.
/// `None` once the socket has closed.
fn next_json(socket: &mut WebSocket<TcpStream>) -> Option<Value> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => match serde_json::from_str(&text) {
                Ok(value) => return Some(value),
                Err(_) => continue,
            },
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => continue,
        }
    }
}

/// What one event means to the island; most mean nothing yet.
fn read(mut frame: Value) -> Option<Update> {
    let name = frame.get("event")?.as_str()?.to_string();
    let payload = frame.get_mut("payload")?.take();
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_string);
    match name.as_str() {
        "session_created" | "session_changed" => serde_json::from_value(payload).ok().map(Update::Session),
        "session_status" => Some(Update::Status {
            session_id: text("sessionId")?,
            status: text("status")?,
            modified: text("modified"),
        }),
        "session_title" => Some(Update::Title { session_id: text("sessionId")?, title: text("title")? }),
        "agent_event" => agent_event(&payload),
        "live_state" => {
            let list = |key: &str| payload.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
            let asks = list("asks").iter().filter_map(Ask::from_event).collect();
            let tasks = list("tasks")
                .iter()
                .filter_map(|e| match agent_event(e)? {
                    Update::Tasks { session_id, count } => Some((session_id, count)),
                    _ => None,
                })
                .collect();
            Some(Update::Live { asks, tasks })
        }
        _ => None,
    }
}

/// The few agent events the island reads: asks coming and going, and
/// background tasks, which keep a finished turn's asks answerable.
fn agent_event(event: &Value) -> Option<Update> {
    let payload = event.get("payload")?;
    let session_id = event.get("sessionId")?.as_str()?.to_string();
    match payload.get("type")?.as_str()? {
        "permission_requested" | "questions_asked" => Ask::from_event(event).map(Update::Asked),
        "permission_decided" => Some(Update::Decided {
            session_id,
            request_id: payload.get("requestId")?.as_str()?.to_string(),
        }),
        "background_tasks_changed" => Some(Update::Tasks {
            session_id,
            count: payload.get("tasks").and_then(Value::as_array).map_or(0, Vec::len),
        }),
        _ => None,
    }
}
