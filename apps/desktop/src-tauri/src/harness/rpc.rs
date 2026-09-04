//! The correlation core the two peer harnesses share: one task owning the
//! child's stdin, and the map of requests waiting on an answer.
//!
//! Framing stays with each harness — JSON-RPC for Codex, pi's flat `id`/`type`
//! lines — since that is where the two differ. What they do not differ on is
//! here: a request registers a slot before its line is written, an answer
//! settles the slot from wherever it was read, and giving up on an answer gives
//! up the slot too.

use anyhow::{bail, Result};
use serde_json::Value;
use std::{
    collections::HashMap,
    fmt::Display,
    hash::Hash,
    sync::{Arc, Mutex},
};
use tokio::{
    io::AsyncWriteExt,
    process::ChildStdin,
    sync::{mpsc, oneshot},
    time::Duration,
};

/// What the writer task accepts.
///
/// `Close` exists because dropping a client cannot close stdin: every clone
/// holds a sender, and the read loop holds one for the life of the session. So
/// the only way to hand the child an EOF is to say so. Codex never does.
pub enum Outbound {
    Line(String),
    Close,
}

/// Spawns the one task allowed to write to `stdin`.
///
/// A queue rather than a lock because the read loop writes too. With a mutex
/// the reader would hold it across a line while answering an approval, and a
/// prompt arriving from the composer would wait behind it; worse, the reader
/// could block on a write while the thing unblocking that write is a line it
/// has not read yet.
pub fn spawn_writer(mut stdin: ChildStdin) -> mpsc::UnboundedSender<Outbound> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();

    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Outbound::Line(line) = message else {
                // Falling out of the loop drops `stdin`, which closes it — the
                // EOF pi ends on.
                break;
            };

            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                // The child is gone. The read loop sees the same thing and is
                // what reports it; there is nothing useful to say twice.
                break;
            }
        }
    });

    tx
}

/// The requests waiting on an answer, keyed by whatever id the harness mints.
///
/// A std mutex: nothing awaits under it, and the read loop settling an answer
/// must never park behind a request registering one.
pub struct Pending<K, E>(Arc<Mutex<HashMap<K, oneshot::Sender<Result<Value, E>>>>>);

impl<K, E> Clone for Pending<K, E> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<K, E> std::fmt::Debug for Pending<K, E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pending")
    }
}

impl<K: Eq + Hash, E: Display> Pending<K, E> {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }

    /// Opens a slot for `id`, before its line is written — what closes the race
    /// against an answer arriving before the write returns.
    pub fn register(&self, id: K) -> oneshot::Receiver<Result<Value, E>> {
        let (tx, rx) = oneshot::channel();
        self.0.lock().unwrap().insert(id, tx);
        rx
    }

    /// Hands `id`'s slot back, for a line that was never written.
    pub fn forget(&self, id: &K) {
        self.0.lock().unwrap().remove(id);
    }

    /// Delivers an answer to whoever waits on `id`. `false` for an id nobody
    /// waits on, which is odd but never fatal: the caller may have given up,
    /// or the child may be confused. Reported, never panicked on.
    pub fn settle(&self, id: &K, outcome: Result<Value, E>) -> bool {
        match self.0.lock().unwrap().remove(id) {
            // The receiver is gone when the caller timed out. Nothing to
            // report: it has already failed with a sentence naming the request.
            Some(waiter) => waiter.send(outcome).is_ok(),
            None => false,
        }
    }

    /// Waits on a registered slot, up to `timeout`. `what` names the request
    /// and `who` the child, for the sentence a failure carries.
    pub async fn wait(
        &self,
        id: &K,
        rx: oneshot::Receiver<Result<Value, E>>,
        timeout: Duration,
        what: &str,
        who: &str,
    ) -> Result<Value> {
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(err))) => bail!("{what} failed: {err}"),
            // The sender was dropped without answering, which only happens when
            // the child died and took the pending map with it.
            Ok(Err(_)) => bail!("{what} was never answered — {who} exited"),
            // Giving up on the answer has to give up the slot too, or an
            // unresponsive child leaks one entry per attempt.
            Err(_) => {
                self.forget(id);
                bail!("{what} went unanswered for {}s", timeout.as_secs())
            }
        }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }
}
