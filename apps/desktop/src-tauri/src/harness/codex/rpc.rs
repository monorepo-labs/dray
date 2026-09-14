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
//! responses. The writer and the pending map are shared with pi through
//! [`crate::harness::rpc`]; the JSON-RPC framing is what stays here.

use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering::Relaxed};
use std::sync::Arc;
use tokio::process::ChildStdin;
use tokio::sync::mpsc;
use tokio::time::Duration;

use crate::harness::rpc::{spawn_writer, Outbound, Pending};


/// How long any request may go unanswered before it is given up on.
///
/// Every request this client sends is an *acknowledgement*: `turn/start`
/// answers before the turn has produced anything, and `turn/interrupt` answers
/// before the turn has actually stopped. So nothing here is ever waiting on
/// work, and a server that has not answered inside this has stopped listening.
///
/// A dead child needs none of this — the pipe closes and every waiter wakes with
/// an error. The case this covers is the child that stays alive and stops
/// answering, where Send and Stop would otherwise hang with nothing on screen
/// saying why.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
    tx: mpsc::UnboundedSender<Outbound>,
    next_id: Arc<AtomicI64>,
    pending: Pending<i64, RpcError>,
}

impl RpcClient {
    /// Takes the child's stdin and spawns the one task allowed to write to it.
    pub fn new(stdin: ChildStdin) -> Self {
        Self::over(spawn_writer(stdin))
    }

    fn over(tx: mpsc::UnboundedSender<Outbound>) -> Self {
        Self {
            tx,
            next_id: Arc::new(AtomicI64::new(1)),
            pending: Pending::new(),
        }
    }

    /// Sends a request and waits for its answer, up to [`REQUEST_TIMEOUT`].
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_within(method, params, REQUEST_TIMEOUT).await
    }

    /// [`Self::request`] with the bound named, so a test need not wait it out.
    pub async fn request_within(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Relaxed);
        let rx = self.pending.register(id);

        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;

        self.pending.wait(&id, rx, timeout, method, "the agent").await
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

                let matched = self.pending.settle(&id, outcome);
                Incoming::Response { id, matched }
            }
            (None, None) => Incoming::Malformed,
        }
    }

    fn send(&self, value: &impl Serialize) -> Result<()> {
        let line = serde_json::to_string(value)?;
        self.tx
            .send(Outbound::Line(line))
            .map_err(|_| anyhow::anyhow!("the agent's input pipe is closed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A client with no child behind it. The writer task drains into nothing,
    /// which is all these need — every assertion here is about the demux.
    fn detached() -> RpcClient {
        let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        RpcClient::over(tx)
    }

    /// A live server that stops answering is the one failure a closed pipe
    /// cannot report: the child is alive, so nothing wakes the waiter. Without
    /// the bound, Send and Stop hang there forever.
    #[tokio::test]
    async fn an_unanswered_request_gives_up_and_frees_its_slot() {
        let client = detached();

        let error = client
            .request_within("turn/start", json!({}), Duration::from_millis(20))
            .await
            .expect_err("nothing is going to answer this");
        assert!(error.to_string().contains("turn/start"));

        // The slot goes with it, or one unresponsive server leaks an entry per
        // attempt for as long as the session is open.
        assert!(client.pending.is_empty());
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
