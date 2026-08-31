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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
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

/// The first command's own bound, wider than the rest.
///
/// pi says **nothing at all** on spawn — no banner, no ready line — so the
/// first command is the only thing that proves the child is alive, and this is
/// how long it may take to prove it.
///
/// It was 10s, on the reasoning that silence reads as broken. Measured, that
/// number could not work: pi takes `~/.pi/agent/auth.json.lock` while it runs,
/// and a pi that did not release it — one killed, or crashed, or the reader's
/// own in a terminal — leaves the next start waiting **~30s** on it before it
/// answers anything. So a bound under that turned one stale lock into a session
/// that could not be started at all, and the kill on the way out left the lock
/// for the retry to fail on too.
///
/// [`PiClient::close`] is the half that stops Dray *causing* this. The width
/// here is the half that survives somebody else causing it: a slow start the
/// reader waits out, rather than a failure they can do nothing about.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(45);

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
    tx: mpsc::UnboundedSender<Outbound>,
    next_id: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    /// Set from the moment a Stop starts until the next run begins, so an
    /// extension dialog raised in that gap is refused rather than drawn.
    ///
    /// It lives here because the client is already the one thing both halves
    /// hold: [`Session::interrupt`](crate::session::Session::interrupt) sets it
    /// and the read loop reads it, and neither has another handle on the other.
    /// A field on `Session` would put a pi-only flag on the struct every
    /// harness shares.
    stopping: Arc<AtomicBool>,
}

/// What the writer task accepts.
///
/// [`Outbound::Close`] exists because dropping the client cannot close stdin:
/// every clone holds a sender, and the read loop holds one for the life of the
/// session. So the only way to hand pi an EOF is to say so.
enum Outbound {
    Line(String),
    Close,
}

impl PiClient {
    /// Takes the child's stdin and spawns the one task allowed to write to it.
    ///
    /// A queue rather than a lock, for the reason Codex's client documents: the
    /// read loop writes too, and with a mutex it could block on a write whose
    /// unblocking depends on a line it has not read yet.
    pub fn new(mut stdin: ChildStdin) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();

        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let Outbound::Line(line) = message else {
                    // Falling out of the loop drops `stdin`, which closes it —
                    // the EOF pi ends on. See [`PiClient::close`].
                    break;
                };

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
            stopping: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// A client with nothing on the other end, for tests.
    ///
    /// The writer task is spawned as usual and its receiver dropped, so a
    /// `send` fails the way one to a closed pipe does. That is what a test of
    /// the *shape* of a line wants: it builds the line and never needs it to
    /// arrive.
    #[cfg(test)]
    pub fn detached() -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        Self {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            stopping: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Opens the window in which extension dialogs are refused on sight.
    ///
    /// Stop drains the dialogs already registered, and that drain is a snapshot:
    /// pi is several lines ahead by the time the abort is written, so cancelling
    /// a `select` can let the extension's very next `confirm` through. Registered
    /// after the drain, it is a card raised by a run the reader has just stopped,
    /// holding the session open behind a question they did not want asked.
    pub fn begin_stop(&self) {
        self.stopping.store(true, Relaxed);
    }

    /// Closes it again, at the next run's first line.
    ///
    /// The next run is the earliest moment a dialog can honestly be drawn again,
    /// and it is the only boundary safe to key on: an aborted run is not promised
    /// to settle, so clearing on a turn ending could leave the window open for
    /// the life of the session.
    pub fn end_stop(&self) {
        self.stopping.store(false, Relaxed);
    }

    /// Whether a dialog arriving now belongs to a run the reader stopped.
    pub fn stopping(&self) -> bool {
        self.stopping.load(Relaxed)
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
            .send(Outbound::Line(serde_json::to_string(line)?))
            .context("pi's stdin writer has stopped")
    }

    /// Closes pi's stdin, which is how pi is asked to exit.
    ///
    /// **Not a nicety.** pi takes `~/.pi/agent/auth.json.lock` — a mkdir lock —
    /// while it runs, and a `SIGKILL`ed pi leaves it behind. The next pi to
    /// start then waits that stale lock out before it answers anything, which
    /// is **~30s**, measured. So killing a pi does not cost that pi, it costs
    /// the next one: a model probe that killed its child made the session spawn
    /// after it look hung, and a failed spawn that killed its child made the
    /// retry fail the same way. An EOF releases the lock; nothing else does.
    ///
    /// Best effort by construction — a writer that has already stopped means
    /// the child is gone, which is the state this was asking for.
    pub fn close(&self) {
        let _ = self.tx.send(Outbound::Close);
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
        let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
        tokio::spawn(async move { while rx.recv().await.is_some() {} });

        PiClient {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            stopping: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// A real child, ended by EOF rather than by force.
    ///
    /// The one behaviour worth a live process in this file: pi's auth lock is
    /// released on a clean exit and left behind on a kill, and the cost of
    /// leaving it lands on the *next* pi as a ~30s wait. `cat` stands in for
    /// pi — what is being pinned is that [`PiClient::close`] closes stdin, and
    /// a reader that ends on EOF is the only witness to that.
    #[tokio::test]
    async fn close_ends_the_child_rather_than_leaving_it_running() {
        let mut child = tokio::process::Command::new("/bin/cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn cat");

        let client = PiClient::new(child.stdin.take().expect("stdin"));

        // Held like the read loop holds one, so this proves `close` rather than
        // the last clone being dropped.
        let reader = client.clone();

        client.close();

        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("the child outlived its EOF")
            .expect("wait");

        assert!(status.success());
        drop(reader);
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
        let (tx, rx) = mpsc::unbounded_channel::<Outbound>();
        drop(rx);

        let client = PiClient {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            stopping: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        };

        client
            .request("get_state", Value::Null)
            .await
            .expect_err("the pipe is closed");

        assert!(client.pending.lock().await.is_empty());
    }

    /// The refusal window is shared, which is the whole reason it lives here.
    ///
    /// `Session::interrupt` opens it and the read loop closes it, and they hold
    /// nothing in common but a clone of this client — so a flag that did not
    /// travel across the clone would leave Stop refusing dialogs in one half and
    /// drawing them in the other.
    #[tokio::test]
    async fn the_stop_window_is_shared_by_every_clone() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let client = PiClient {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            stopping: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        };
        let reader = client.clone();

        assert!(!reader.stopping(), "a fresh session refuses nothing");

        client.begin_stop();
        assert!(reader.stopping(), "the reader has to see the Stop");

        reader.end_stop();
        assert!(!client.stopping(), "the next run reopens it for both");
    }
}
