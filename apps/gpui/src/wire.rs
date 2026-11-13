//! The app's half of the serve wire (SERVE-PLAN.md), for the one server it
//! attaches to: this Mac's, found through `serve-port` and `serve-token` in the
//! home dir. The app owns no server in milestone 1; it is a client only.
//!
//! Tokio lives on a thread of its own, since GPUI runs its own executor on the
//! main thread. What crosses back is a stream of [`Signal`]s and the futures
//! [`Wire::invoke`] returns, both runtime-agnostic.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dray_core::machines::admit_with;
use dray_core::serve::{PORT_FILE, PROTOCOL};
use futures::channel::mpsc as fmpsc;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

/// How long a call waits for the server to come back before failing — the
/// React transport's figure, since this server is down only while it restarts.
const CONNECT_WAIT: Duration = Duration::from_secs(20);
const RETRY: Duration = Duration::from_secs(1);

/// What the connection tells the UI.
#[derive(Debug)]
pub enum Signal {
    Up,
    Down(String),
    Event { name: String, payload: Value },
}

type Reply = Result<Value, Value>;

#[derive(Clone)]
pub struct Wire(Arc<Inner>);

struct Inner {
    runtime: tokio::runtime::Handle,
    /// The live connection's outbox, `None` while there is none.
    outbox: watch::Receiver<Option<mpsc::UnboundedSender<String>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next: AtomicU64,
}

impl Wire {
    /// Starts the runtime thread and the connection loop. The receiver is the
    /// only way events reach the UI, so it must be drained.
    pub fn start() -> (Wire, fmpsc::UnboundedReceiver<Signal>) {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("dray-wire")
            .enable_all()
            .build()
            .expect("tokio runtime");
        let handle = runtime.handle().clone();
        std::thread::Builder::new()
            .name("dray-wire".into())
            .spawn(move || runtime.block_on(std::future::pending::<()>()))
            .expect("wire thread");

        let (outbox_tx, outbox) = watch::channel(None);
        let (signals, events) = fmpsc::unbounded();
        let wire = Wire(Arc::new(Inner {
            runtime: handle.clone(),
            outbox,
            pending: Mutex::default(),
            next: AtomicU64::new(1),
        }));
        handle.spawn(connect_loop(wire.clone(), outbox_tx, signals));
        (wire, events)
    }

    /// `invoke` on the server: the same command and arguments the React app
    /// sends, answered with `ok` or rejected with `err` as the server gave it.
    pub fn invoke(&self, cmd: &str, args: Value) -> impl Future<Output = Reply> + 'static {
        let inner = self.0.clone();
        let cmd = cmd.to_string();
        let task = self.0.runtime.spawn(async move {
            let id = inner.next.fetch_add(1, Ordering::Relaxed);
            let (reply, answer) = oneshot::channel();
            // Registered before the outbox is read: a connection that drops
            // after this sees the entry and fails it, so no call waits forever.
            inner.pending().insert(id, reply);
            let frame = json!({ "id": id, "cmd": cmd, "args": args }).to_string();
            let mut outbox = inner.outbox.clone();
            let sent = match tokio::time::timeout(CONNECT_WAIT, outbox.wait_for(Option::is_some)).await {
                Ok(Ok(sender)) => sender.as_ref().is_some_and(|s| s.send(frame).is_ok()),
                _ => false,
            };
            if !sent {
                inner.pending().remove(&id);
                return Err(json!("The server on this Mac is not running."));
            }
            answer.await.unwrap_or_else(|_| Err(json!("the connection closed before the server answered")))
        });
        async move { task.await.unwrap_or_else(|e| Err(json!(e.to_string()))) }
    }
}

impl Inner {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Reply>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Where this Mac's server listens and its token, read again on every connect
/// since a restart may pick a new port.
async fn local_address() -> Result<(String, String), String> {
    let home = dray_core::store::get_home_app_dir().await.map_err(|e| e.to_string())?;
    let starting = || "The server on this Mac is starting.".to_string();
    let port_file = tokio::fs::read_to_string(home.join(PORT_FILE)).await.map_err(|_| starting())?;
    let port: u16 = port_file.lines().next().and_then(|p| p.trim().parse().ok()).ok_or_else(starting)?;
    let token = tokio::fs::read_to_string(home.join("serve-token")).await.map_err(|_| starting())?;
    Ok((format!("ws://127.0.0.1:{port}"), token.trim().to_string()))
}

async fn connect_loop(
    wire: Wire,
    outbox: watch::Sender<Option<mpsc::UnboundedSender<String>>>,
    mut signals: fmpsc::UnboundedSender<Signal>,
) {
    let mut last_error = None;
    loop {
        let admitted = match local_address().await {
            Ok((url, token)) => admit_with(&url, json!({ "v": PROTOCOL, "token": token })).await,
            Err(e) => Err(e),
        };
        let ws = match admitted {
            Ok((ws, _welcome)) => ws,
            Err(e) => {
                // Said once per distinct failure, not once a second.
                if last_error.as_ref() != Some(&e) {
                    log::info!("not connected: {e}");
                    let _ = signals.send(Signal::Down(e.clone())).await;
                    last_error = Some(e);
                }
                tokio::time::sleep(RETRY).await;
                continue;
            }
        };
        last_error = None;
        log::info!("connected");

        let (mut write, mut read) = ws.split();
        let (tx, mut frames) = mpsc::unbounded_channel::<String>();
        let writer = tokio::spawn(async move {
            while let Some(frame) = frames.recv().await {
                if write.send(Message::text(frame)).await.is_err() {
                    break;
                }
            }
        });
        outbox.send_replace(Some(tx));
        let _ = signals.send(Signal::Up).await;

        while let Some(Ok(message)) = read.next().await {
            let text = match message {
                Message::Text(text) => text.to_string(),
                Message::Close(_) => break,
                _ => continue,
            };
            let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                let reply = match frame.get("err") {
                    Some(err) => Err(err.clone()),
                    None => Ok(frame.get("ok").cloned().unwrap_or(Value::Null)),
                };
                if let Some(waiter) = wire.0.pending().remove(&id) {
                    let _ = waiter.send(reply);
                }
            } else if let Some(name) = frame.get("event").and_then(Value::as_str) {
                let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                let _ = signals.send(Signal::Event { name: name.to_string(), payload }).await;
            }
        }

        writer.abort();
        // Cleared before the drain, so a call either sees no outbox and waits
        // for the next connection, or registered early enough to be failed here.
        outbox.send_replace(None);
        for (_, waiter) in wire.0.pending().drain() {
            let _ = waiter.send(Err(json!("the connection closed before the server answered")));
        }
        log::info!("disconnected");
        let _ = signals.send(Signal::Down("The server on this Mac went away.".into())).await;
        tokio::time::sleep(RETRY).await;
    }
}
