//! This computer's Dray server, as the Mac island and the iOS app reach it:
//! one WebSocket to `dray --serve`, address and token read from `serve-port`
//! and `serve-token` in the home Dray hands over as `DRAY_HOME`. The wire is
//! `serve.rs`'s; see its module comment.

use serde::Deserialize;
use serde_json::{Value, json};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
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

/// Keeps a connection up for the island's life on a thread of its own,
/// calling `on_update` from that thread.
pub fn run(on_update: impl Fn(Update) + Send + 'static) {
    std::thread::Builder::new()
        .name("island-server".into())
        .spawn(move || {
            loop {
                let wait = match connect(&on_update) {
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
}

enum Gone {
    Unreachable,
    Refused(String),
}

/// One connection, from hello to the socket dropping.
fn connect(on_update: &impl Fn(Update)) -> Result<(), Gone> {
    let (url, token) = address().ok_or(Gone::Unreachable)?;
    let (mut socket, _) = tungstenite::connect(&url).map_err(|_| Gone::Unreachable)?;
    // `client` is what the server counts the island's use by, and is what
    // `island_links` answers to.
    let hello = json!({ "v": PROTOCOL, "token": token, "client": "island" });
    socket.send(Message::text(hello.to_string())).map_err(|_| Gone::Unreachable)?;
    let welcome = next_json(&mut socket).ok_or(Gone::Unreachable)?;
    if let Some(err) = welcome.get("err").and_then(Value::as_str) {
        return Err(Gone::Refused(err.to_string()));
    }
    let list = json!({ "id": 1, "cmd": "list_session_index_items", "args": { "archived": false } });
    socket.send(Message::text(list.to_string())).map_err(|_| Gone::Unreachable)?;
    while let Some(frame) = next_json(&mut socket) {
        if let Some(update) = read(frame) {
            on_update(update);
        }
    }
    Ok(())
}

/// The next text frame as JSON, skipping pings and anything unparseable.
/// `None` once the socket has closed.
fn next_json(socket: &mut WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>) -> Option<Value> {
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

/// What one frame means to the island; most mean nothing yet.
fn read(mut frame: Value) -> Option<Update> {
    if frame.get("id").and_then(Value::as_u64) == Some(1) {
        return serde_json::from_value(frame.get_mut("ok")?.take()).ok().map(Update::Sessions);
    }
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
        _ => None,
    }
}
