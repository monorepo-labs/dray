//! Where a pi dialog is answered from, reachable without the session map.
//!
//! Every other harness answers through [`SessionManager`]'s
//! `HashMap<String, Session>`, and for every other harness that is fine. pi
//! breaks it because pi can ask a *blocking* question at two moments when the
//! session is not in that map, or when the lock guarding it is held:
//!
//! - **On a *new* session's first prompt.** pi answers a `prompt` command only
//!   after `_tryExecuteExtensionCommand`, `emitInput` and `emitBeforeAgentStart`
//!   have run, and each can call `ctx.ui.confirm`. A new session is inserted
//!   into the map only after that first `send_msg` returns, so the question
//!   arrives while nothing there holds it.
//! - **On a live session's, under the map's own lock.** `send_msg` runs holding
//!   it, so the answer that would release pi waits on the lock the send holds
//!   while it waits on the answer — and that lock is one lock for the whole app,
//!   so every other session's controls wait with it.
//!
//! Both ended the same way: the card was drawn, its buttons did nothing, and
//! the prompt failed 30 seconds later when the request timed out.
//!
//! Project trust looked like a third and is not, which is worth writing down
//! because the source reads that way until the last step. `resolveProjectTrusted`
//! does call `ctx.ui.select` — but only past `if (!hasUI) return false`, and
//! `main.js` sets `hasUI` to `isInitialRuntime && trustPromptMode ===
//! "interactive"`, where `trustPromptMode` is the app mode. Under `--mode rpc`
//! it is `"rpc"`, so pi never asks and answers *untrusted* instead: a project
//! holding `.pi` resources with no stored decision silently does not load
//! them.
//!
//! So the answer does not go through the session at all. Everything it needs is
//! a handle the read loop already holds — the pending map, the client, the id
//! and the sequence counter — and all four are cheap to clone, so they are
//! registered here the moment the reader starts and looked up directly.
//!
//! [`SessionManager`]: crate::session::SessionManager

use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::rpc::PiClient;
use crate::events::AgentEvent;
use crate::harness::claude_code::permissions::{PendingPermissions, PendingRequest};

/// One session's answering handles.
///
/// Cloned out of the registry before anything is done with it, so no lock here
/// is ever held across the write to pi or the emit.
#[derive(Clone)]
pub struct Desk {
    session_id: String,
    /// Which desk this is, not merely whose. A session id is reused across a
    /// respawn, and the reader it replaces is a task nobody joins — so an old
    /// one reaching its teardown after the new desk is open would otherwise
    /// retire the *new* pi's dialog and unregister it.
    token: u64,
    client: PiClient,
    pending: PendingPermissions,
    seq: Arc<AtomicU64>,
    /// Set the moment teardown begins, and read under [`Desk::pending`]'s lock
    /// so a click and a dying child cannot both believe they won.
    closed: Arc<AtomicBool>,
}

/// Module-level for [`crate::hooks`]-shaped reasons: the two halves sit far
/// apart — registered inside `pi::init`, read from a Tauri command — and
/// threading a handle between them would put pi's own concern through every
/// signature in between.
static DESKS: LazyLock<Mutex<HashMap<String, Desk>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Hands out [`Desk::token`]. Only ever increments, so no two desks in one run
/// of the app can share one.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Opens one, before the reader starts, and answers which one it is.
///
/// Before, not after: the reader is what draws the card, so a desk registered
/// second leaves a window in which a question is asked and cannot be answered.
/// Re-registering the same id replaces it, which is what a respawn wants — and
/// the token is what lets the reader it replaced know that is what happened.
pub fn open(
    session_id: &str,
    client: PiClient,
    pending: PendingPermissions,
    seq: Arc<AtomicU64>,
) -> u64 {
    let token = NEXT_TOKEN.fetch_add(1, Relaxed);

    DESKS.lock().expect("desk registry poisoned").insert(
        session_id.to_string(),
        Desk {
            session_id: session_id.to_string(),
            token,
            client,
            pending,
            seq,
            closed: Arc::new(AtomicBool::new(false)),
        },
    );

    token
}

/// Ends one, when the reader that served it does.
///
/// Takes the token and does nothing where it names a desk that has already been
/// replaced. That guard is the whole of it: `shutdown` waits for the child but
/// nobody joins the stdout task, so a respawn can open the next desk under the
/// same session id before the old reader reaches this line. Without the token
/// the old teardown retires the *new* pi's dialog as `Ended` and unregisters
/// its desk, and the new pi then waits on an answer nothing can send.
///
/// Retiring and closing happen together and only here, so there is one owner of
/// both. `Session::kill` used to close ahead of `shutdown`, which meant every
/// explicit kill — a respawn, a delete, a first send that failed — reached this
/// point with nothing left to retire and left its cards up.
pub fn end(session_id: &str, token: u64, app: &AppHandle) {
    let Some(desk) = current(session_id, token) else {
        return;
    };

    // Retired while still registered, and unregistered only after. Removing
    // first opened a gap in which an answer found no desk, fell through to the
    // session, and took the pending entry from the very map the retirement was
    // about to drain — so the card could neither be answered nor retired. While
    // it is still registered a click reaches `compose`, which refuses it under
    // the same lock this drains under.
    desk.retire_all(app);
    claim(session_id, token);
}

/// The desk registered under this id, if the token still names it.
fn current(session_id: &str, token: u64) -> Option<Desk> {
    DESKS
        .lock()
        .expect("desk registry poisoned")
        .get(session_id)
        .filter(|desk| desk.token == token)
        .cloned()
}

/// Takes a desk out of the registry, but only where the token still names the
/// one registered. `None` means it has been replaced or already ended, and in
/// both cases this reader owns nothing here any more.
///
/// Split from [`end`] because `end` needs an `AppHandle` to retire cards with
/// and a unit test has none, while this — the guard that stops an old reader
/// dismantling its replacement — is the half worth pinning.
fn claim(session_id: &str, token: u64) -> Option<Desk> {
    let mut registry = DESKS.lock().expect("desk registry poisoned");

    match registry.get(session_id) {
        Some(desk) if desk.token == token => registry.remove(session_id),
        _ => None,
    }
}

/// The desk for a session, if it has one.
///
/// A clone, deliberately: the caller writes to pi and emits an event, and
/// neither may happen with the registry locked.
pub fn find(session_id: &str) -> Option<Desk> {
    DESKS
        .lock()
        .expect("desk registry poisoned")
        .get(session_id)
        .cloned()
}

impl Desk {
    /// Answers one dialog, in the shape the method that asked reads.
    pub fn answer(
        &self,
        request_id: &str,
        answers: &HashMap<String, String>,
        app: &AppHandle,
    ) -> Result<()> {
        let (reply, decided) = self.compose(request_id, answers)?;
        self.client.send(&reply)?;
        app.emit("agent_event", &decided)?;
        Ok(())
    }

    /// Stops the run, and answers whatever it was asking first.
    ///
    /// Takes the desk's route for `answer`'s reason, and one more: the shell row
    /// the composer draws for a *new* session puts Stop on screen during the
    /// very window in which the backend `Session` is still a local inside
    /// `send_msg`, unreachable through `SessionManager`'s map. Reached that way
    /// Stop answered "no running session" and neither cancelled the dialog nor
    /// aborted pi — a button drawn over a blocked agent that provably did
    /// nothing.
    ///
    /// Order matters twice. The dialogs are cancelled **before** the abort,
    /// because `abort` ends the agent and leaves `pendingExtensionRequests`
    /// untouched — so a dialog left unanswered holds its extension open through
    /// a Stop that reported success. And `clear_queue` precedes `abort` inside
    /// [`interrupt`](super::interrupt), because aborting alone lets anything
    /// steered behind the run start the moment it ends.
    pub async fn stop(&self, app: &AppHandle) -> Result<()> {
        self.cancel_cards(app);
        super::interrupt(&self.client).await
    }

    /// Answers every card still up with a cancel, which is what unblocks the
    /// extension waiting on one.
    ///
    /// Best-effort throughout: the abort behind this is what the reader pressed
    /// and has to go out regardless, so a dialog that fails to be answered costs
    /// a stranded extension where a Stop that fails costs the session.
    fn cancel_cards(&self, app: &AppHandle) {
        for (request_id, request) in self.cancel_outstanding() {
            self.emit_decided(app, request_id, request.tool_use_id, "Stopped");
        }
    }

    /// Opens the refusal window and answers everything outstanding, leaving the
    /// cards for the caller to retire.
    ///
    /// Split from the emit for `compose`'s reason: an `AppHandle` is the one
    /// thing a unit test cannot build, and everything worth pinning here — that
    /// a Stop *answers* rather than merely dropping, and that it leaves the desk
    /// open — happens on this side of the line.
    fn cancel_outstanding(&self) -> Vec<(String, PendingRequest)> {
        // Opened before the drain, and the drain is a snapshot: pi is several
        // lines ahead, so a dialog raised as the abort goes out would otherwise
        // survive the Stop. `register_dialog` reads this under the same lock it
        // registers into, which is what makes the pair total.
        self.client.begin_stop();

        let outstanding = self.drain();
        for (request_id, request) in &outstanding {
            let Some(method) = request.reply.dialog_method() else {
                continue;
            };

            if let Err(error) =
                self.client
                    .send(&super::dialog::response(method, request_id, &HashMap::new()))
            {
                eprintln!("[pi] could not cancel dialog {request_id}: {error}");
            }
        }

        outstanding
    }

    #[cfg(test)]
    fn cancel_cards_for_test(&self) {
        let _ = self.cancel_outstanding();
    }

    /// Retires every card still up, because the pi that asked has gone.
    ///
    /// Called when the reader ends, which is the one signal that covers every
    /// way a child can leave — asked to, killed, or crashed. Without it a stale
    /// desk answers: the click removes the entry, the line goes into a queue
    /// whose writer has already broken, and the card retires reporting
    /// "Answered" for a reply that reached nothing.
    ///
    fn retire_all(&self, app: &AppHandle) {
        // No reply goes out, unlike a Stop's cancellation: the child this would
        // answer has gone, so a line here could only be queued behind its own
        // death and dropped.
        for (request_id, request) in self.drain_closing() {
            self.emit_decided(app, request_id, request.tool_use_id, "Ended");
        }
    }

    /// Takes every outstanding card, leaving the desk open.
    fn drain(&self) -> Vec<(String, PendingRequest)> {
        self.pending
            .lock()
            .expect("pending permissions poisoned")
            .drain()
            .collect()
    }

    /// Takes them and shuts the desk in one critical section.
    ///
    /// One section, not two, and that is what makes the click race total rather
    /// than merely narrow: `compose` reads the same flag under the same lock it
    /// takes its entry from, so whichever section runs first decides. Flagged
    /// outside the lock the two are separate steps, and a click reading the flag
    /// a moment before it was set still claims a delivery into a writer that is
    /// already breaking.
    fn drain_closing(&self) -> Vec<(String, PendingRequest)> {
        let mut guard = self.pending.lock().expect("pending permissions poisoned");
        self.closed.store(true, Relaxed);
        guard.drain().collect()
    }

    /// The event that takes a card away without anyone having answered it.
    ///
    /// `Deny` and `automatic`: nobody decided anything, and the card is being
    /// removed rather than answered. Emitted and not persisted, like every other
    /// decision here — the request was never written either, since only the
    /// child that asked could answer it.
    fn emit_decided(&self, app: &AppHandle, request_id: String, tool_use_id: String, label: &str) {
        let decided = AgentEvent {
            id: uuid::Uuid::now_v7().to_string(),
            session_id: self.session_id.clone(),
            harness: crate::harness::Harness::Pi,
            seq: self.seq.fetch_add(1, Relaxed),
            ts: crate::events::now_rfc3339(),
            turn_id: None,
            subagent: None,
            payload: crate::events::AgentEventPayload::PermissionDecided {
                request_id,
                tool_use_id,
                behavior: crate::events::PermissionBehavior::Deny,
                label: label.to_string(),
                automatic: true,
            },
            raw: None,
        };

        if let Err(error) = app.emit("agent_event", &decided) {
            eprintln!("[pi] could not retire a dialog: {error}");
        }
    }

    /// The reply and the event that retires the card, built together.
    ///
    /// Split out to be tested, like `prompt_request` next door: the emit needs
    /// an `AppHandle` a unit test has none of, and everything worth pinning —
    /// that a dialog is taken exactly once, and that its reply is shaped by the
    /// method that asked — happens here.
    ///
    /// The entry is removed before either is built, so a second click on a card
    /// that has not retired yet fails rather than answering twice. pi deletes
    /// its own waiter on the first reply, so the second would be dropped in
    /// silence and the reader could not tell which answer landed.
    fn compose(
        &self,
        request_id: &str,
        answers: &HashMap<String, String>,
    ) -> Result<(Value, AgentEvent)> {
        let pending = {
            let mut guard = self.pending.lock().expect("pending permissions poisoned");

            // Read under the same lock the entry is taken from. Without it a
            // click landing as the child dies takes its entry, misses the drain,
            // queues a line to a writer that has already broken, and retires the
            // card saying "Answered" for a reply that reached nothing.
            if self.closed.load(Relaxed) {
                bail!("that pi session is no longer running");
            }

            guard
                .remove(request_id)
                .with_context(|| format!("no pending permission request {request_id}"))?
        };

        let method = pending
            .reply
            .dialog_method()
            .context("that request did not come from a pi dialog")?;

        Ok((
            super::dialog::response(method, request_id, answers),
            crate::session::dialog_decided(
                &self.session_id,
                crate::harness::Harness::Pi,
                &self.seq,
                request_id,
                pending.tool_use_id,
                answers.is_empty(),
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(request_id: &str, method: &str) -> PendingRequest {
        PendingRequest {
            tool_use_id: request_id.to_string(),
            tool_name: method.to_string(),
            input: Value::Null,
            options: HashMap::new(),
            reply: crate::harness::claude_code::permissions::Reply::PiDialog(method.to_string()),
        }
    }

    fn desk_holding(request_id: &str, method: &str) -> (String, u64, Desk, PendingPermissions) {
        let id = format!("desk-test-{}", uuid::Uuid::now_v7());
        let pending: PendingPermissions = Default::default();

        pending
            .lock()
            .unwrap()
            .insert(request_id.to_string(), request(request_id, method));

        let token = open(
            &id,
            PiClient::detached(),
            pending.clone(),
            Arc::new(AtomicU64::new(0)),
        );
        let desk = find(&id).expect("just opened");
        (id, token, desk, pending)
    }

    /// A desk is findable from the moment the reader starts until its own reader
    /// ends, which is the whole of what it promises.
    #[test]
    fn a_desk_lives_from_open_to_end() {
        let id = format!("desk-test-{}", uuid::Uuid::now_v7());
        assert!(find(&id).is_none(), "nothing is registered yet");

        let token = open(
            &id,
            PiClient::detached(),
            Default::default(),
            Arc::new(AtomicU64::new(0)),
        );
        assert!(find(&id).is_some(), "the reader has started");

        assert!(claim(&id, token).is_some(), "its own reader ends it");
        assert!(find(&id).is_none(), "and it is gone");
    }

    /// An old reader cannot dismantle the desk that replaced it.
    ///
    /// `shutdown` waits for the child but nobody joins the stdout task, so a
    /// respawn opens the next desk under the same session id while the previous
    /// reader is still on its way to teardown. Keyed on the id alone that
    /// teardown retired the *new* pi's dialog as `Ended` and unregistered its
    /// desk, and the new pi then waited on an answer nothing could send.
    #[test]
    fn an_old_reader_cannot_end_the_desk_that_replaced_it() {
        let id = format!("desk-test-{}", uuid::Uuid::now_v7());

        let first = open(
            &id,
            PiClient::detached(),
            Default::default(),
            Arc::new(AtomicU64::new(0)),
        );
        let second = open(
            &id,
            PiClient::detached(),
            Default::default(),
            Arc::new(AtomicU64::new(0)),
        );
        assert_ne!(first, second, "two desks are never one");

        assert!(claim(&id, first).is_none(), "the old reader owns nothing");
        assert!(find(&id).is_some(), "the replacement is untouched");

        assert!(claim(&id, second).is_some(), "its own reader still ends it");
    }

    /// One dialog, one answer. The second click finds nothing rather than
    /// writing a reply pi has already stopped waiting for.
    #[test]
    fn a_dialog_is_answered_exactly_once() {
        let (id, token, desk, _pending) = desk_holding("d-1", "confirm");
        let answers = HashMap::from([("Confirm?".to_string(), "Yes".to_string())]);

        let (reply, _) = desk.compose("d-1", &answers).expect("the first answer");
        assert_eq!(reply["confirmed"], Value::Bool(true));

        assert!(
            desk.compose("d-1", &answers).is_err(),
            "the second click has nothing left to answer"
        );

        let _ = claim(&id, token);
    }

    /// The reply is shaped by the method that asked, not by what came back.
    ///
    /// A reply in the wrong shape is dropped by pi in silence and the turn stays
    /// blocked, so this is the half that has to travel with the request.
    #[test]
    fn the_reply_is_shaped_by_the_method_that_asked() {
        let (id, token, desk, _pending) = desk_holding("d-2", "input");
        let answers = HashMap::from([("Name it".to_string(), "typed".to_string())]);

        let (reply, decided) = desk.compose("d-2", &answers).expect("answered");
        assert_eq!(reply["value"], Value::String("typed".into()));
        assert_eq!(reply["id"], Value::String("d-2".into()));
        assert_eq!(decided.harness, crate::harness::Harness::Pi);

        let _ = claim(&id, token);
    }

    /// A skip still answers, and says so.
    #[test]
    fn a_skip_cancels_and_is_labelled_as_one() {
        let (id, token, desk, _pending) = desk_holding("d-3", "select");

        let (reply, _) = desk.compose("d-3", &HashMap::new()).expect("answered");
        assert_eq!(reply["cancelled"], Value::Bool(true));

        let _ = claim(&id, token);
    }

    /// A Stop answers the cards it takes, where a teardown only removes them.
    ///
    /// The difference is which end has gone. `abort` ends the *agent* and leaves
    /// `pendingExtensionRequests` untouched, so a dialog left unanswered holds
    /// its extension open through a Stop that reported success — the cancel is
    /// what unblocks it. A teardown has no child left to tell.
    #[test]
    fn a_stop_cancels_its_cards_where_a_teardown_only_takes_them() {
        let (id, token, desk, pending) = desk_holding("d-6", "confirm");

        desk.cancel_cards_for_test();
        assert!(
            pending.lock().unwrap().is_empty(),
            "a Stop clears what was outstanding"
        );
        assert!(
            desk.client.stopping(),
            "and refuses whatever the dying run raises next"
        );
        assert!(
            !desk.closed.load(Relaxed),
            "but the desk stays open — the session did not end"
        );

        let _ = claim(&id, token);
    }

    /// A click that lands after teardown began is refused, not claimed.
    ///
    /// Both halves read the same flag under the same lock the entry is taken
    /// from, so exactly one of them wins. Refused, the card stays up until the
    /// retirement retires it; claimed, it would queue a line to a writer that
    /// has already broken and report "Answered" for a reply that reached
    /// nothing.
    #[test]
    fn a_click_after_teardown_is_refused_rather_than_claimed() {
        let (id, token, desk, pending) = desk_holding("d-4", "confirm");

        // What `retire_all` does inside the lock, immediately before draining.
        desk.closed.store(true, Relaxed);

        assert!(
            desk.compose("d-4", &HashMap::new()).is_err(),
            "a dying desk must not claim a delivery"
        );
        assert!(
            pending.lock().unwrap().contains_key("d-4"),
            "and it must leave the entry for the retirement to take"
        );

        let _ = claim(&id, token);
    }

    /// A click and a teardown never both take the entry, and never both miss it.
    ///
    /// Narrower than it looks, and worth saying so: this pins that the two
    /// critical sections are mutually exclusive, not *which* of them the flag
    /// sends away. That half is deterministic and sits in the test above. Kept
    /// because the pair is what the card's correctness rests on, and because
    /// there is no await between reading the flag and taking the entry — so this
    /// is real parallelism, with no scheduling point anything could be argued
    /// from.
    #[test]
    fn a_click_and_a_teardown_never_both_win() {
        for round in 0..2_000 {
            let (id, token, desk, pending) = desk_holding("d-5", "confirm");

            let clicker = {
                let desk = desk.clone();
                std::thread::spawn(move || desk.compose("d-5", &HashMap::new()).is_ok())
            };

            let closer = {
                let desk = desk.clone();
                std::thread::spawn(move || {
                    desk.closed.store(true, Relaxed);
                    let mut guard = desk.pending.lock().expect("pending permissions poisoned");
                    guard.drain().count()
                })
            };

            let answered = clicker.join().expect("clicker thread");
            let retired = closer.join().expect("closer thread");

            assert_eq!(
                answered,
                retired == 0,
                "round {round}: the entry went to both or to neither"
            );
            assert!(
                pending.lock().unwrap().is_empty(),
                "round {round}: nothing may be left registered"
            );

            let _ = claim(&id, token);
        }
    }
}
