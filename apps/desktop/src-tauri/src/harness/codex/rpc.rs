//! The JSON-RPC 2.0 half of talking to `codex app-server`.
//!
//! Claude Code is a one-way pipe with a control side-channel bolted on; this is
//! a peer. Both sides send requests and both sides answer, so three things have
//! no equivalent in [`claude_code`](crate::harness::claude_code): our sends have
//! responses worth waiting for, their questions carry an id we must answer, and
//! a reply from the read loop must not interleave with a prompt from the
//! composer.
//!
//! Deliberately not shared with Claude Code. Its control channel is its own
//! envelope — `type: control_request`, a UUID `request_id`, double-wrapped
//! responses — and adapting two working modules to serve one real user is the
//! bar CLAUDE.md sets for `packages/`. The generic core here is small; lift it
//! into `harness/jsonrpc.rs` when a second JSON-RPC harness exists.

use anyhow::{bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering::Relaxed};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, Mutex};

/// A JSON-RPC error object, kept whole rather than flattened to a string.
///
/// `code` is what tells a retryable failure from a permanent one — `-32001` is
/// documented as "retry later" — and a message alone would lose that.
#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

/// One line read off the server, sorted by what it is rather than what it says.
///
/// JSON-RPC tells the three apart structurally: a request has both an id and a
/// method, a notification has a method alone, a response has an id alone. The
/// distinction is the whole of the demux, so it is made once here rather than
/// guessed at by each reader of the line.
pub enum Incoming {
    /// The server is asking us something and is blocked until we answer.
    Request {
        id: i64,
        method: String,
        params: Value,
    },
    /// The server is telling us something. Nothing to answer.
    Notification { method: String, params: Value },
    /// An answer to something we sent. Already routed to its waiter; carried
    /// here only so the caller can log a stray one.
    Response { id: i64, matched: bool },
    /// Not JSON, or JSON in none of the three shapes.
    Malformed,
}

/// The write side of the connection, plus the map of what we are waiting on.
///
/// Cloneable because the read loop needs it too: a server request is answered
/// from where it is read, exactly as Claude's unanswerable control request is.
#[derive(Clone, Debug)]
pub struct RpcClient {
    tx: mpsc::UnboundedSender<String>,
    next_id: Arc<AtomicI64>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>>,
}

impl RpcClient {
    /// Takes the child's stdin and spawns the one task allowed to write to it.
    ///
    /// A queue rather than a lock because the read loop writes too. With a
    /// mutex the reader would hold it across a line while answering an
    /// approval, and a prompt arriving from the composer would wait behind it;
    /// worse, the reader could block on a write while the thing unblocking that
    /// write is a line it has not read yet.
    pub fn new(mut stdin: ChildStdin) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    // The child is gone. The read loop sees the same thing and
                    // is what reports it; there is nothing useful to say twice.
                    break;
                }
            }
        });

        Self {
            tx,
            next_id: Arc::new(AtomicI64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Sends a request and waits for its answer.
    ///
    /// No timeout here, deliberately. The one failure this cannot distinguish —
    /// a server that will never answer — is also the one where the child has
    /// died, and that closes the pipe, drops every pending sender, and wakes
    /// every waiter with an error. Callers that need a bound put it on
    /// themselves; see `codex::init`.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;

        match rx.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => bail!("{method} failed: {err}"),
            // The sender was dropped without answering, which only happens when
            // the child died and took the pending map with it.
            Err(_) => bail!("{method} was never answered — the agent exited"),
        }
    }

    /// Sends a notification: no id, so nothing to wait for.
    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    /// Answers a request the server made of us.
    ///
    /// Silence is not neutral — the server blocks its turn on this, the same
    /// way Claude's `can_use_tool` does — so every server request must reach
    /// either this or [`Self::respond_err`].
    pub fn respond(&self, id: i64, result: Value) -> Result<()> {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }

    /// Refuses a request the server made of us.
    ///
    /// A JSON-RPC *error*, not silence and not a made-up success: a request of
    /// a kind this build cannot put to the user has no honest answer, and
    /// inventing one decides on the user's behalf.
    pub fn respond_err(&self, id: i64, code: i64, message: &str) -> Result<()> {
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message},
        }))
    }

    /// Routes one line off the child's stdout.
    ///
    /// Answers to our own requests are settled here and reported as
    /// [`Incoming::Response`] so the caller can file a stray one; everything
    /// else is handed back for the parser to type.
    pub async fn accept(&self, line: &str) -> Incoming {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Incoming::Malformed;
        };

        let method = value.get("method").and_then(Value::as_str);
        // Absent and null are both "no id" here. Only an integer id can be
        // ours: the counter above mints nothing else.
        let id = value.get("id").and_then(Value::as_i64);

        match (id, method) {
            (Some(id), Some(method)) => Incoming::Request {
                id,
                method: method.to_string(),
                params: value.get("params").cloned().unwrap_or(Value::Null),
            },
            (None, Some(method)) => Incoming::Notification {
                method: method.to_string(),
                params: value.get("params").cloned().unwrap_or(Value::Null),
            },
            (Some(id), None) => {
                let outcome = match value.get("error") {
                    Some(err) => Err(RpcError {
                        code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                            .to_string(),
                    }),
                    None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                };

                // A response for an id nobody waits on is odd but never fatal:
                // the caller may have given up, or the server may be confused.
                // Reported, never panicked on.
                let matched = match self.pending.lock().await.remove(&id) {
                    Some(waiter) => waiter.send(outcome).is_ok(),
                    None => false,
                };
                Incoming::Response { id, matched }
            }
            (None, None) => Incoming::Malformed,
        }
    }

    fn send(&self, value: &impl Serialize) -> Result<()> {
        let line = serde_json::to_string(value)?;
        self.tx
            .send(line)
            .map_err(|_| anyhow::anyhow!("the agent's input pipe is closed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A client with no child behind it. The writer task drains into nothing,
    /// which is all these need — every assertion here is about the demux.
    fn detached() -> RpcClient {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        RpcClient {
            tx,
            next_id: Arc::new(AtomicI64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// The three shapes are told apart structurally, and getting this wrong is
    /// not a visible failure — a request read as a notification is simply never
    /// answered, and the turn hangs with nothing on screen saying why.
    #[tokio::test]
    async fn demuxes_on_id_and_method() {
        let client = detached();

        assert!(matches!(
            client
                .accept(r#"{"method":"item/started","params":{}}"#)
                .await,
            Incoming::Notification { .. }
        ));

        assert!(matches!(
            client
                .accept(r#"{"id":0,"method":"item/commandExecution/requestApproval","params":{}}"#)
                .await,
            Incoming::Request { id: 0, .. }
        ));

        assert!(matches!(
            client.accept(r#"{"id":7,"result":{}}"#).await,
            Incoming::Response { id: 7, .. }
        ));

        assert!(matches!(
            client.accept("not json").await,
            Incoming::Malformed
        ));
    }

    /// The server's own request ids start at 0 and live in their own space —
    /// verified against 0.148.0-alpha.21, where the first approval arrived as
    /// `id: 0` while our counter was already past it. Keying the pending map on
    /// anything but our own counter would let a server request steal the waiter
    /// belonging to one of our calls.
    #[tokio::test]
    async fn server_request_ids_do_not_settle_our_pending() {
        let client = detached();

        let waiting = {
            let client = client.clone();
            tokio::spawn(async move { client.request("thread/start", json!({})).await })
        };
        // Let the request register before the collision arrives.
        tokio::task::yield_now().await;

        // Same integer as our first outbound id, but it carries a method, so it
        // is a request from the server and must not be read as our answer.
        let incoming = client
            .accept(r#"{"id":1,"method":"item/fileChange/requestApproval","params":{}}"#)
            .await;
        assert!(matches!(incoming, Incoming::Request { .. }));
        assert!(!waiting.is_finished());

        client.accept(r#"{"id":1,"result":{"ok":true}}"#).await;
        assert_eq!(waiting.await.unwrap().unwrap(), json!({"ok": true}));
    }

    /// An error response has to reach the caller as an error. Read as a success
    /// it becomes an empty result, and the caller carries on with a thread id
    /// that is `null`.
    #[tokio::test]
    async fn error_response_fails_the_caller() {
        let client = detached();

        let waiting = {
            let client = client.clone();
            tokio::spawn(async move { client.request("thread/start", json!({})).await })
        };
        tokio::task::yield_now().await;

        client
            .accept(r#"{"id":1,"error":{"code":-32600,"message":"unknown variant `readOnly`"}}"#)
            .await;

        let err = waiting.await.unwrap().unwrap_err().to_string();
        assert!(err.contains("readOnly"), "{err}");
    }

    /// A response nobody waits on is reported rather than dropped in silence,
    /// so it can be filed as a parse failure like every other coverage gap.
    #[tokio::test]
    async fn stray_response_is_reported() {
        let client = detached();
        assert!(matches!(
            client.accept(r#"{"id":99,"result":{}}"#).await,
            Incoming::Response {
                id: 99,
                matched: false
            }
        ));
    }
}
