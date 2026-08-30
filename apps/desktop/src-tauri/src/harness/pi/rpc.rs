//! Talking to `pi --mode rpc`.
//!
//! pi is a peer that does **not** speak JSON-RPC. Commands go out as JSON lines
//! carrying an `id` and a `type`; answers come back tagged
//! `type: "response"` with that id and the `command` it answers; everything
//! else on the pipe is an event tagged by nothing but its own `type`.
//!
//! So the framing differs from [`codex::rpc`](crate::harness::codex::rpc) and
//! the *correlation* does not: outbound requests carrying an id, a pending map,
//! and a demux that settles answers before anything else sees the line. That
//! shared core is what CODEX-PLAN.md said would lift when a second correlated
//! harness existed. It has not been lifted yet — three fields and forty lines,
//! where the typing around them is entirely per-harness — but this is the
//! second user, and a third is the point at which it should be.
//!
//! **Records split on `\n` only.** `U+2028` and `U+2029` are legal inside JSON
//! strings, so a reader treating them as line breaks corrupts any record
//! containing one. Rust's `BufRead::lines` is correct here by construction;
//! naming it because the day someone reaches for a "smarter" reader is the day
//! this breaks silently.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::Duration;

/// How long a command may go unanswered before it is given up on.
///
/// Nothing here waits on *work*: pi answers `prompt` the moment it accepts one,
/// and its docs say failures after acceptance arrive through the event stream
/// rather than as a second response. So an unanswered command means pi has
/// stopped listening.
///
/// A dead child needs none of this — the pipe closes and every waiter wakes.
/// This covers the child that stays alive and goes quiet, where a send would
/// otherwise hang with nothing on screen saying why.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The handshake's own bound, tighter than the rest.
///
/// pi says **nothing at all** on spawn — no banner, no ready line — so silence
/// is indistinguishable from a slow start, and the first command is the only
/// thing that proves the child is alive. Thirty seconds of a blank composer is
/// long enough to read as broken.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// One line read off pi, sorted by what it is rather than what it says.
pub enum Incoming {
    /// An event. Handed on for the parser to type.
    Event(String),
    /// An answer to something we sent. Already routed to its waiter; carried
    /// here only so a stray one can be filed.
    Response { matched: bool },
    /// Not JSON at all.
    Malformed,
}

/// The write side of the connection, plus the map of what we are waiting on.
///
/// Cloneable because the read loop needs it: pi's one inbound request —
/// `extension_ui_request` — has to be answered from where it is read, exactly
/// as Claude's unanswerable `control_request` is, and pi blocks the tool call
/// until it is.
#[derive(Clone, Debug)]
pub struct PiClient {
    tx: mpsc::UnboundedSender<String>,
    next_id: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
}

impl PiClient {
    /// Takes the child's stdin and spawns the one task allowed to write to it.
    ///
    /// A queue rather than a lock, for the reason Codex's client documents: the
    /// read loop writes too, and with a mutex it could block on a write whose
    /// unblocking depends on a line it has not read yet.
    pub fn new(mut stdin: ChildStdin) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    // The child is gone. The read loop sees the same thing and
                    // is what reports it.
                    break;
                }
            }
        });

        Self {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Sends a command and waits for its answer, up to [`REQUEST_TIMEOUT`].
    pub async fn request(&self, command: &str, extra: Value) -> Result<Value> {
        self.request_within(command, extra, REQUEST_TIMEOUT).await
    }

    /// [`Self::request`] with the bound named, so the handshake can be tighter
    /// and a test need not wait one out.
    ///
    /// `extra` is merged into the line rather than nested under a `params` key:
    /// pi's commands are flat objects, so `prompt` carries its `message`
    /// alongside `id` and `type`.
    pub async fn request_within(
        &self,
        command: &str,
        extra: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let id = format!("d{}", self.next_id.fetch_add(1, Relaxed));

        let mut line = json!({"id": id, "type": command});
        if let (Some(target), Some(fields)) = (line.as_object_mut(), extra.as_object()) {
            for (key, value) in fields {
                target.insert(key.clone(), value.clone());
            }
        }

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        // The slot goes back if the write never happened. Registering first is
        // what closes the race against an answer arriving before this line
        // returns, but leaving the entry behind on a failed write leaks one per
        // attempt — and they are never collected, since the id that would clear
        // one was never sent.
        if let Err(err) = self.send(&line) {
            self.pending.lock().await.remove(&id);
            return Err(err);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            // pi names exactly what was wrong — `Model not found: nope/nope` —
            // which is why `models.rs` leaves pi's ids unvalidated and lets this
            // report them.
            Ok(Ok(Err(message))) => bail!("{command} failed: {message}"),
            Ok(Err(_)) => bail!("{command} was never answered — pi exited"),
            // Giving up on the answer has to give up the slot too, or an
            // unresponsive child leaks one entry per attempt.
            Err(_) => {
                self.pending.lock().await.remove(&id);
                bail!("{command} went unanswered for {}s", timeout.as_secs())
            }
        }
    }

    /// Writes a line built by the caller.
    ///
    /// For the one shape that is neither a command nor a response to one:
    /// `extension_ui_response`, which carries pi's *own* id rather than one
    /// this client minted, and so must not go near the pending map.
    pub fn send(&self, line: &Value) -> Result<()> {
        self.tx
            .send(serde_json::to_string(line)?)
            .context("pi's stdin writer has stopped")
    }

    /// Routes one line off pi's stdout.
    ///
    /// Answers are settled here and reported as [`Incoming::Response`] so a
    /// stray one can be filed; everything else is handed back for the parser.
    pub async fn accept(&self, line: &str) -> Incoming {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Incoming::Malformed;
        };

        if value.get("type").and_then(Value::as_str) != Some("response") {
            return Incoming::Event(line.to_string());
        }

        // A response with no id answers a command sent without one. Dray always
        // sends an id, so there is nothing of ours it could be settling.
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return Incoming::Response { matched: false };
        };

        let Some(waiter) = self.pending.lock().await.remove(id) else {
            return Incoming::Response { matched: false };
        };

        let answer = if value.get("success").and_then(Value::as_bool) == Some(true) {
            Ok(value.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("pi refused the command and said nothing about why")
                .to_string())
        };

        // The receiver is gone when the caller timed out. Nothing to report:
        // it has already failed with a sentence naming the command.
        let _ = waiter.send(answer);
        Incoming::Response { matched: true }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A client with no child behind it, writing into a drain.
    ///
    /// The drain is not decoration: dropping the receiver makes every `send`
    /// fail, so a client built without one exercises the write-failure path on
    /// every test rather than the demux these are about.
    fn detached() -> PiClient {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move { while rx.recv().await.is_some() {} });

        PiClient {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[tokio::test]
    async fn an_event_is_never_mistaken_for_an_answer() {
        let client = detached();

        for line in [
            r#"{"type":"agent_start"}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}"#,
            // Carries an id, and is still not a response: only `type` decides.
            r#"{"type":"extension_ui_request","id":"x1","method":"confirm"}"#,
        ] {
            assert!(matches!(client.accept(line).await, Incoming::Event(_)));
        }
    }

    #[tokio::test]
    async fn an_answer_reaches_the_caller_that_asked() {
        let client = detached();

        let waiting = {
            let client = client.clone();
            tokio::spawn(async move { client.request("get_state", Value::Null).await })
        };

        // The id is minted by the counter, so the first request is `d1`.
        let settled = {
            let client = client.clone();
            tokio::spawn(async move {
                // Loop rather than sleep: the request has to have registered its
                // slot before the answer can find it.
                loop {
                    let outcome = client
                        .accept(
                            r#"{"id":"d1","type":"response","command":"get_state",
                                "success":true,"data":{"model":"xai/grok-4.6"}}"#,
                        )
                        .await;
                    if matches!(outcome, Incoming::Response { matched: true }) {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            })
        };

        settled.await.unwrap();
        let answer = waiting.await.unwrap().expect("the request should settle");

        assert_eq!(answer["model"], "xai/grok-4.6");
    }

    /// A failure is the same line with `success: false`, and pi's sentence is
    /// the only place the cure is named — so it has to reach the caller rather
    /// than being flattened to "the command failed".
    #[tokio::test]
    async fn a_refusal_carries_pi_s_own_sentence() {
        let client = detached();

        let waiting = {
            let client = client.clone();
            tokio::spawn(async move { client.request("set_model", json!({"model": "nope"})).await })
        };

        let settled = {
            let client = client.clone();
            tokio::spawn(async move {
                loop {
                    let outcome = client
                        .accept(
                            r#"{"id":"d1","type":"response","command":"set_model",
                                "success":false,"error":"Model not found: nope/nope"}"#,
                        )
                        .await;
                    if matches!(outcome, Incoming::Response { matched: true }) {
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            })
        };

        settled.await.unwrap();
        let err = waiting.await.unwrap().expect_err("the command was refused");

        assert!(
            err.to_string().contains("Model not found: nope/nope"),
            "pi's sentence was lost: {err}"
        );
    }

    /// An answer to an id nobody is waiting on must cost one line, not a panic
    /// and not a hung caller. A reply landing after its caller timed out is the
    /// ordinary way this happens.
    #[tokio::test]
    async fn a_stray_answer_is_filed_rather_than_dropped_silently() {
        let client = detached();

        let outcome = client
            .accept(r#"{"id":"d99","type":"response","command":"prompt","success":true}"#)
            .await;

        assert!(matches!(outcome, Incoming::Response { matched: false }));
    }

    #[tokio::test]
    async fn a_line_that_is_not_json_is_reported_rather_than_parsed() {
        let client = detached();

        assert!(matches!(
            client.accept("pi wrote something that isn't JSON").await,
            Incoming::Malformed
        ));
    }

    /// Giving up on an answer has to give up the slot, or an unresponsive child
    /// leaks one entry per attempt for the life of the session.
    #[tokio::test]
    async fn a_timed_out_request_leaves_no_slot_behind() {
        let client = detached();

        let err = client
            .request_within("get_state", Value::Null, Duration::from_millis(20))
            .await
            .expect_err("nothing answered it");

        assert!(err.to_string().contains("get_state"));
        assert!(client.pending.lock().await.is_empty());
    }

    /// And so does a write that never happened. The slot is registered before
    /// the write, to close the race against an answer arriving first — so a
    /// failed write has to hand it back, or a dead pipe leaks one entry per
    /// attempt and none of them can ever be settled.
    #[tokio::test]
    async fn a_failed_write_leaves_no_slot_behind() {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        drop(rx);

        let client = PiClient {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        };

        client
            .request("get_state", Value::Null)
            .await
            .expect_err("the pipe is closed");

        assert!(client.pending.lock().await.is_empty());
    }
}
