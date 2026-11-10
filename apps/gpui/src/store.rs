//! What the server has said about every session, and the rules for folding its
//! events in — kept apart from the view so the races can be tested.
//!
//! The rules are the React app's (useSessions.ts) and the server's own
//! (`Live` in serve.rs): a decision retires its request, a turn over with no
//! task left strands its asks, and `live_state` replaces what is held.

use std::collections::{HashMap, HashSet};

use dray_core::projects::Project;
use dray_core::store::{SessionIndexItem, SessionStatus};
use serde_json::Value;

use crate::sessions::Live;

/// What applying an event asks of the view.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// Something drawn moved.
    pub redraw: bool,
    /// The list and projects want reading again (every connect).
    pub reload: bool,
}

#[derive(Default)]
pub struct Store {
    pub items: Vec<SessionIndexItem>,
    pub projects: Vec<Project>,
    pub live: Live,
    /// Open permission and question requests by session, so a decision retires
    /// its own request and the row stops reading as asking only with the last.
    asks: HashMap<String, HashSet<String>>,
    /// Sessions holding background tasks, whose asks outlive the turn.
    tasked: HashSet<String>,
    /// Index events seen while a list read is in flight, laid over its answer.
    replay: Option<Vec<(String, Value)>>,
    /// Counts list reads, so only the newest one's answer lands.
    reads: u64,
    /// Sessions whose last task ended while their running state was unknown.
    deferred: HashSet<String>,
}

impl Store {
    /// Folds one server event in.
    pub fn apply(&mut self, name: &str, payload: Value) -> Applied {
        let redraw = Applied { redraw: true, reload: false };
        match name {
            // Opens every connect and replaces what is held. Status lives in
            // the index rather than in this frame, so the list is read again.
            "live_state" => {
                self.asks.clear();
                for ask in payload["asks"].as_array().into_iter().flatten() {
                    self.note_ask(ask);
                }
                self.tasked = payload["tasks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["sessionId"].as_str().map(str::to_string))
                    .collect();
                self.live.status.clear();
                self.deferred.clear();
                self.sync_asking();
                Applied { redraw: true, reload: true }
            }
            "agent_event" => match payload["payload"]["type"].as_str() {
                Some("permission_requested" | "questions_asked") => {
                    self.note_ask(&payload);
                    self.sync_asking();
                    redraw
                }
                Some("permission_decided") => {
                    let session = payload["sessionId"].as_str().unwrap_or_default();
                    let request = payload["payload"]["requestId"].as_str().unwrap_or_default();
                    if let Some(open) = self.asks.get_mut(session) {
                        open.remove(request);
                    }
                    self.sync_asking();
                    redraw
                }
                // A turn that ended with a task open kept its asks, since the
                // task's subagent could be the one asking; this is the other half.
                Some("background_tasks_changed") => {
                    let session = payload["sessionId"].as_str().unwrap_or_default().to_string();
                    if payload["payload"]["tasks"].as_array().is_some_and(|t| !t.is_empty()) {
                        self.tasked.insert(session);
                        return redraw;
                    }
                    self.tasked.remove(&session);
                    match self.running(&session) {
                        Some(false) => {
                            self.asks.remove(&session);
                            self.sync_asking();
                        }
                        // Settled once the list being read says whether it runs.
                        None => {
                            self.deferred.insert(session);
                        }
                        Some(true) => {}
                    }
                    redraw
                }
                // Deltas and the rest: nothing the sidebar draws.
                _ => Applied::default(),
            },
            "session_status" => {
                let status = serde_json::from_value::<SessionStatus>(payload["status"].clone());
                if let (Some(session), Ok(status)) = (payload["sessionId"].as_str(), status) {
                    // A turn over with no task left strands its asks, as the server does.
                    if status != SessionStatus::InProgress && !self.tasked.contains(session) {
                        self.asks.remove(session);
                        self.sync_asking();
                    }
                    self.live.status.insert(session.to_string(), status);
                }
                self.index_event(name, payload);
                redraw
            }
            "session_created" | "session_changed" | "session_title" => {
                self.index_event(name, payload);
                redraw
            }
            _ => Applied::default(),
        }
    }

    /// An event's index half: applied now, and kept to lay over the answer of a
    /// list read in flight, which reflects the index from before it.
    fn index_event(&mut self, name: &str, payload: Value) {
        if let Some(replay) = &mut self.replay {
            replay.push((name.to_string(), payload.clone()));
        }
        self.apply_index_fields(name, payload);
    }

    /// What an event changes in the index. Index fields alone: a replay repeats
    /// this, and must not repeat what the event did to live state such as asks.
    fn apply_index_fields(&mut self, name: &str, payload: Value) {
        match name {
            "session_status" => {
                let session = payload["sessionId"].as_str().unwrap_or_default();
                if let Some(modified) = payload["modified"].as_str()
                    && let Some(item) = self.items.iter_mut().find(|i| i.session_id == session)
                {
                    item.modified = modified.to_string();
                }
            }
            "session_created" | "session_changed" => {
                let Ok(item) = serde_json::from_value::<SessionIndexItem>(payload) else {
                    return;
                };
                self.items.retain(|i| i.session_id != item.session_id);
                // The live list holds active rows; one settled from anywhere leaves it.
                if !item.archived {
                    self.items.push(item);
                }
            }
            "session_title" => {
                let id = payload["sessionId"].as_str().unwrap_or_default();
                let locked = payload["titleLocked"].as_bool().unwrap_or(false);
                if let (Some(item), Some(title)) =
                    (self.items.iter_mut().find(|i| i.session_id == id), payload["title"].as_str())
                    && (locked || !item.title_locked)
                {
                    item.title = title.to_string();
                    item.title_locked = locked;
                }
            }
            _ => {}
        }
    }

    /// Opens a list read; the number names it to [`Self::finish_read`].
    pub fn begin_read(&mut self) -> u64 {
        self.reads += 1;
        self.replay = Some(Vec::new());
        self.reads
    }

    /// Lands a list read's answer, unless a later read has started since.
    /// Answers whether it landed.
    pub fn finish_read(&mut self, read: u64, list: Result<Vec<SessionIndexItem>, String>) -> bool {
        if read != self.reads {
            return false;
        }
        let replay = self.replay.take().unwrap_or_default();
        match list {
            Ok(items) => {
                self.items = items;
                for (name, payload) in replay {
                    self.apply_index_fields(&name, payload);
                }
            }
            Err(e) => log::error!("list_session_index_items: {e}"),
        }
        for session in std::mem::take(&mut self.deferred) {
            if !self.tasked.contains(&session) && self.running(&session) == Some(false) {
                self.asks.remove(&session);
            }
        }
        self.sync_asking();
        true
    }

    /// Whether a session's turn is running, or `None` while that is unknown:
    /// between a reconnect and the list it re-reads, the list held is stale and
    /// no live reading has arrived yet.
    fn running(&self, session: &str) -> Option<bool> {
        if let Some(status) = self.live.status.get(session) {
            return Some(*status == SessionStatus::InProgress);
        }
        if self.replay.is_some() {
            return None;
        }
        self.items.iter().find(|i| i.session_id == session).map(|i| i.status == SessionStatus::InProgress)
    }

    fn note_ask(&mut self, frame: &Value) {
        let session = frame["sessionId"].as_str().unwrap_or_default().to_string();
        let request = frame["payload"]["requestId"].as_str().unwrap_or_default().to_string();
        self.asks.entry(session).or_default().insert(request);
    }

    fn sync_asking(&mut self) {
        self.live.asking = self.asks.iter().filter(|(_, open)| !open.is_empty()).map(|(s, _)| s.clone()).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str, status: &str) -> SessionIndexItem {
        serde_json::from_value(json!({
            "sessionId": id, "harness": "claude_code", "cwd": "/r", "projectPath": "/r", "branch": null,
            "worktreeName": null, "title": id, "created": "2026-11-10T10:00:00Z",
            "modified": "2026-11-10T10:00:00Z", "archived": false, "pinned": false, "status": status,
        }))
        .unwrap()
    }

    fn ask(session: &str, request: &str) -> Value {
        json!({ "sessionId": session, "payload": { "type": "permission_requested", "requestId": request } })
    }

    fn status(session: &str, status: &str) -> Value {
        json!({ "sessionId": session, "status": status, "modified": null })
    }

    fn tasks(session: &str, n: usize) -> Value {
        json!({ "sessionId": session, "payload": { "type": "background_tasks_changed", "tasks": vec![json!({}); n] } })
    }

    fn asking(store: &Store, session: &str) -> bool {
        store.live.asking.contains(session)
    }

    #[test]
    fn a_decision_retires_only_its_own_request() {
        let mut s = Store::default();
        s.apply("agent_event", ask("a", "r1"));
        s.apply("agent_event", ask("a", "r2"));
        s.apply(
            "agent_event",
            json!({ "sessionId": "a", "payload": { "type": "permission_decided", "requestId": "r1" } }),
        );
        assert!(asking(&s, "a"));
    }

    #[test]
    fn a_turn_ending_with_a_task_open_keeps_its_asks() {
        let mut s = Store::default();
        s.apply("agent_event", tasks("a", 1));
        s.apply("agent_event", ask("a", "r1"));
        s.apply("session_status", status("a", "completed"));
        assert!(asking(&s, "a"));
        s.apply("agent_event", tasks("a", 0));
        assert!(!asking(&s, "a"));
    }

    #[test]
    fn events_during_a_read_are_laid_over_its_answer() {
        let mut s = Store::default();
        let read = s.begin_read();
        s.apply("session_created", serde_json::to_value(item("new", "idle")).unwrap());
        s.apply("session_title", json!({ "sessionId": "old", "title": "Renamed", "titleLocked": true }));
        assert!(s.finish_read(read, Ok(vec![item("old", "idle")])));
        let titles: Vec<_> = s.items.iter().map(|i| (i.session_id.as_str(), i.title.as_str())).collect();
        assert_eq!(titles, [("old", "Renamed"), ("new", "new")]);
    }

    #[test]
    fn an_older_read_does_not_land() {
        let mut s = Store::default();
        let first = s.begin_read();
        let second = s.begin_read();
        assert!(!s.finish_read(first, Ok(vec![item("stale", "idle")])));
        assert!(s.items.is_empty());
        assert!(s.finish_read(second, Ok(vec![item("fresh", "idle")])));
        assert_eq!(s.items[0].session_id, "fresh");
    }

    #[test]
    fn a_replayed_status_does_not_retire_a_newer_ask() {
        let mut s = Store::default();
        let read = s.begin_read();
        s.apply("session_status", status("a", "completed"));
        s.apply("session_status", status("a", "in_progress"));
        s.apply("agent_event", ask("a", "r1"));
        s.finish_read(read, Ok(vec![item("a", "in_progress")]));
        assert!(asking(&s, "a"));
    }

    #[test]
    fn a_task_set_drained_while_status_is_unknown_is_settled_by_the_list() {
        let mut s = Store::default();
        s.apply("live_state", json!({ "asks": [ask("a", "r1")], "tasks": [{ "sessionId": "a" }] }));
        let read = s.begin_read();
        s.apply("agent_event", tasks("a", 0));
        assert!(asking(&s, "a"), "kept while nothing says whether the turn runs");
        s.finish_read(read, Ok(vec![item("a", "completed")]));
        assert!(!asking(&s, "a"));
    }

    #[test]
    fn a_running_turn_keeps_its_ask_through_the_read() {
        let mut s = Store::default();
        s.apply("live_state", json!({ "asks": [ask("a", "r1")], "tasks": [{ "sessionId": "a" }] }));
        let read = s.begin_read();
        s.apply("agent_event", tasks("a", 0));
        s.finish_read(read, Ok(vec![item("a", "in_progress")]));
        assert!(asking(&s, "a"));
    }

    #[test]
    fn deltas_ask_for_no_redraw() {
        let mut s = Store::default();
        let delta = json!({ "sessionId": "a", "payload": { "type": "delta" } });
        assert_eq!(s.apply("agent_event", delta), Applied::default());
    }
}
