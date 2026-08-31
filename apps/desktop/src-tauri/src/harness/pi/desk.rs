//! Where a pi dialog is answered from, reachable without the session map.
//!
//! Every other harness answers through [`SessionManager`]'s
//! `HashMap<String, Session>`, and for every other harness that is fine. pi
//! breaks it because pi can ask a *blocking* question at two moments when the
//! session is not in that map, or when the lock guarding it is held:
//!
//! - **Before the first prompt is accepted.** `resolveProjectTrusted` calls
//!   `ctx.ui.select` during startup for any directory holding `.pi` resources
//!   with no stored decision, so the first pi session in a project asks before
//!   the handshake has even answered — and a new session is inserted into the
//!   map only after its first `send_msg` returns.
//! - **During any prompt's preflight.** pi answers a `prompt` command only
//!   after `_tryExecuteExtensionCommand`, `emitInput` and `emitBeforeAgentStart`
//!   have run, and each of those can call `ctx.ui.confirm`. `send_msg` for a
//!   live session runs under the session map's own lock, so the answer that
//!   would release pi waits on the lock the send holds while it waits on the
//!   answer.
//!
//! Both ended the same way: the card was drawn, its buttons did nothing, and
//! the prompt failed 30 seconds later when the request timed out — taking every
//! other session's controls with it in the second case, since that lock is one
//! lock for the whole app.
//!
//! So the answer does not go through the session at all. Everything it needs is
//! a handle the read loop already holds — the pending map, the client, the id
//! and the sequence counter — and all four are cheap to clone, so they are
//! registered here the moment the reader starts and looked up directly.
//!
//! [`SessionManager`]: crate::session::SessionManager

use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

use super::rpc::PiClient;
use crate::events::AgentEvent;
use crate::harness::claude_code::permissions::PendingPermissions;

/// One session's answering handles.
///
/// Cloned out of the registry before anything is done with it, so no lock here
/// is ever held across the write to pi or the emit.
#[derive(Clone)]
pub struct Desk {
    session_id: String,
    client: PiClient,
    pending: PendingPermissions,
    seq: Arc<AtomicU64>,
}

/// Module-level for [`crate::hooks`]-shaped reasons: the two halves sit far
/// apart — registered inside `pi::init`, read from a Tauri command — and
/// threading a handle between them would put pi's own concern through every
/// signature in between.
static DESKS: LazyLock<Mutex<HashMap<String, Desk>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Opens one, before the reader starts.
///
/// Before, not after: the reader is what draws the card, so a desk registered
/// second leaves a window in which a question is asked and cannot be answered.
/// Re-registering the same id replaces it, which is what a respawn wants.
pub fn open(session_id: &str, client: PiClient, pending: PendingPermissions, seq: Arc<AtomicU64>) {
    DESKS.lock().expect("desk registry poisoned").insert(
        session_id.to_string(),
        Desk {
            session_id: session_id.to_string(),
            client,
            pending,
            seq,
        },
    );
}

/// Closes one, when its child goes.
///
/// A desk left behind is not dangerous — its client writes to a closed pipe and
/// the answer fails — but it would report "no pending request" where "no running
/// session" is the true sentence, so it is closed rather than left for the next
/// spawn to overwrite.
pub fn close(session_id: &str) {
    DESKS
        .lock()
        .expect("desk registry poisoned")
        .remove(session_id);
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
            guard
                .remove(request_id)
                .with_context(|| format!("no pending permission request {request_id}"))?
        };

        let method = pending
            .pi_dialog_method
            .as_deref()
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
    use crate::harness::claude_code::permissions::PendingRequest;

    fn desk_holding(request_id: &str, method: &str) -> (String, Desk, PendingPermissions) {
        let id = format!("desk-test-{}", uuid::Uuid::now_v7());
        let pending: PendingPermissions = Default::default();

        pending.lock().unwrap().insert(
            request_id.to_string(),
            PendingRequest {
                tool_use_id: request_id.to_string(),
                tool_name: method.to_string(),
                input: Value::Null,
                options: HashMap::new(),
                rpc_id: None,
                pi_dialog_method: Some(method.to_string()),
            },
        );

        open(
            &id,
            PiClient::detached(),
            pending.clone(),
            Arc::new(AtomicU64::new(0)),
        );
        let desk = find(&id).expect("just opened");
        (id, desk, pending)
    }

    /// A desk is findable from the moment the reader starts until the child has
    /// gone, which is the whole of what it promises.
    #[test]
    fn a_desk_lives_from_open_to_close() {
        let id = format!("desk-test-{}", uuid::Uuid::now_v7());
        assert!(find(&id).is_none(), "nothing is registered yet");

        open(
            &id,
            PiClient::detached(),
            Default::default(),
            Arc::new(AtomicU64::new(0)),
        );
        assert!(find(&id).is_some(), "the reader has started");

        close(&id);
        assert!(find(&id).is_none(), "the child has gone");
    }

    /// One dialog, one answer. The second click finds nothing rather than
    /// writing a reply pi has already stopped waiting for.
    #[test]
    fn a_dialog_is_answered_exactly_once() {
        let (id, desk, _pending) = desk_holding("d-1", "confirm");
        let answers = HashMap::from([("Confirm?".to_string(), "Yes".to_string())]);

        let (reply, _) = desk.compose("d-1", &answers).expect("the first answer");
        assert_eq!(reply["confirmed"], Value::Bool(true));

        assert!(
            desk.compose("d-1", &answers).is_err(),
            "the second click has nothing left to answer"
        );

        close(&id);
    }

    /// The reply is shaped by the method that asked, not by what came back.
    ///
    /// A reply in the wrong shape is dropped by pi in silence and the turn stays
    /// blocked, so this is the half that has to travel with the request.
    #[test]
    fn the_reply_is_shaped_by_the_method_that_asked() {
        let (id, desk, _pending) = desk_holding("d-2", "input");
        let answers = HashMap::from([("Name it".to_string(), "typed".to_string())]);

        let (reply, decided) = desk.compose("d-2", &answers).expect("answered");
        assert_eq!(reply["value"], Value::String("typed".into()));
        assert_eq!(reply["id"], Value::String("d-2".into()));
        assert_eq!(decided.harness, crate::harness::Harness::Pi);

        close(&id);
    }

    /// A skip still answers, and says so.
    #[test]
    fn a_skip_cancels_and_is_labelled_as_one() {
        let (id, desk, _pending) = desk_holding("d-3", "select");

        let (reply, _) = desk.compose("d-3", &HashMap::new()).expect("answered");
        assert_eq!(reply["cancelled"], Value::Bool(true));

        close(&id);
    }
}
