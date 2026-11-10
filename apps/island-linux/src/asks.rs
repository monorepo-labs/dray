//! The cards sessions are blocked on — a permission or a set of questions —
//! across every live session, and which of them the reader has put away. The
//! Mac island's `Store.asks` plus `Composer`'s attention rules, in one place.

use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub behavior: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Permission {
    pub tool_name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub input: Value,
    pub options: Vec<PermissionOption>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Question {
    pub question: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
    /// The CLI promises the reader a box of their own; off only where it says so.
    pub free_text: bool,
}

impl Default for Question {
    fn default() -> Self {
        Self { question: String::new(), multi_select: false, options: Vec::new(), free_text: true }
    }
}

#[derive(Clone, Debug)]
pub enum AskKind {
    Permission(Permission),
    Questions(Vec<Question>),
}

/// One waiting card: an `agent_event` whose payload is `permission_requested`
/// or `questions_asked`.
#[derive(Clone, Debug)]
pub struct Ask {
    /// The event's own id, which a card's UI state is keyed on.
    pub id: String,
    pub session_id: String,
    /// What an answer and `permission_decided` name.
    pub request_id: String,
    pub kind: AskKind,
}

impl Ask {
    /// `None` for any other event, or one too malformed to answer.
    pub fn from_event(event: &Value) -> Option<Ask> {
        let payload = event.get("payload")?;
        let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
        let kind = match payload.get("type")?.as_str()? {
            "permission_requested" => AskKind::Permission(serde_json::from_value(payload.clone()).ok()?),
            "questions_asked" => {
                let questions: Vec<Question> = serde_json::from_value(payload.get("questions")?.clone()).ok()?;
                if questions.is_empty() {
                    return None;
                }
                AskKind::Questions(questions)
            }
            _ => return None,
        };
        Some(Ask {
            id: text(event, "id")?,
            session_id: text(event, "sessionId")?,
            request_id: text(payload, "requestId")?,
            kind,
        })
    }
}

/// A permission as one line: the tool, and beside it the file, else what the
/// agent says it is for, else the argument. A command is long and rarely the
/// question, so it waits behind a click (`hidden`); a path is short and is.
pub struct ToolLine {
    pub tool: String,
    pub beside: Option<String>,
    pub hidden: Option<String>,
}

impl ToolLine {
    pub fn new(p: &Permission) -> Self {
        let field = |key: &str| p.input.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let path = ["file_path", "path", "notebook_path", "target_file", "target_directory"]
            .iter()
            .find_map(|k| field(k))
            .map(|p| shorten(&p));
        let command = field("command");
        let argument = path.clone().or_else(|| {
            ["command", "pattern", "query", "url", "skill"].iter().find_map(|k| field(k))
        });
        let beside = path.or_else(|| p.description.clone()).or(argument);
        let hidden = command.filter(|c| Some(c) != beside.as_ref());
        ToolLine { tool: p.display_name.clone().unwrap_or_else(|| p.tool_name.clone()), beside, hidden }
    }
}

/// The last two segments: enough to know a file by, beside the tool.
fn shorten(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 { path.to_string() } else { parts[parts.len() - 2..].join("/") }
}

/// What a permission answer says as the panel closes on it.
pub fn answered_label(option: &PermissionOption) -> &'static str {
    match option.kind.as_str() {
        "once" => "Allowed once",
        "always_rule" | "always_directory" | "switch_mode" => "Always allowed",
        "deny" => "Denied",
        _ if option.behavior == "deny" => "Denied",
        _ => "Allowed once",
    }
}

/// Every waiting ask, the order they came in, and what the reader dismissed.
#[derive(Default)]
pub struct Asks {
    by_session: HashMap<String, Vec<Ask>>,
    /// Request ids in arrival order: the order sessions are offered in.
    order: Vec<String>,
    /// Put away by the reader: still waiting in Dray, out of the pill and the
    /// cards until a new ask comes.
    dismissed: HashSet<String>,
    /// Background tasks per session. A session with one running can still
    /// answer an ask after its turn ends, so its asks are not stranded.
    tasks: HashMap<String, usize>,
}

impl Asks {
    /// Adds one; `true` where it is new, which is news worth a chime.
    pub fn add(&mut self, ask: Ask) -> bool {
        let list = self.by_session.entry(ask.session_id.clone()).or_default();
        if list.iter().any(|a| a.request_id == ask.request_id) {
            return false;
        }
        let id = ask.request_id.clone();
        list.push(ask);
        self.settle(&[id])
    }

    /// Answered, here or in Dray, or taken back by the CLI.
    pub fn decided(&mut self, session_id: &str, request_id: &str) {
        if let Some(list) = self.by_session.get_mut(session_id) {
            list.retain(|a| a.request_id != request_id);
        }
        self.settle(&[]);
    }

    /// The server's own account on every connect, replacing what was held:
    /// a card answered while the socket was down goes. `true` where an ask is
    /// new to the island.
    pub fn replace(&mut self, asks: Vec<Ask>, tasks: HashMap<String, usize>) -> bool {
        self.by_session.clear();
        let arrived: Vec<String> = asks.iter().map(|a| a.request_id.clone()).collect();
        for ask in asks {
            let list = self.by_session.entry(ask.session_id.clone()).or_default();
            if !list.iter().any(|a| a.request_id == ask.request_id) {
                list.push(ask);
            }
        }
        self.tasks = tasks;
        self.settle(&arrived)
    }

    pub fn set_tasks(&mut self, session_id: &str, count: usize, busy: bool) {
        self.tasks.insert(session_id.to_string(), count);
        if count == 0 && !busy {
            self.strand(session_id);
        }
    }

    /// A turn that ended with nothing left running can never take an answer,
    /// so its asks go.
    pub fn strand(&mut self, session_id: &str) {
        if self.tasks.get(session_id).copied().unwrap_or(0) == 0 {
            self.by_session.remove(session_id);
            self.settle(&[]);
        }
    }

    /// Brings `order` and `dismissed` in line with what is held, new asks
    /// taking their place in `arrived`, the order the server sent them in —
    /// never the map's, which would pick the oldest card at random. A new ask
    /// brings back every one put away: dismissing quiets the pill, it answers
    /// nothing.
    fn settle(&mut self, arrived: &[String]) -> bool {
        self.by_session.retain(|_, list| !list.is_empty());
        let ids: Vec<String> = self.by_session.values().flatten().map(|a| a.request_id.clone()).collect();
        let fresh: Vec<String> = arrived.iter().filter(|id| ids.contains(id) && !self.order.contains(id)).cloned().collect();
        self.order.retain(|id| ids.contains(id));
        self.order.extend(fresh.iter().cloned());
        if fresh.is_empty() {
            self.dismissed.retain(|id| ids.contains(id));
        } else {
            self.dismissed.clear();
        }
        !fresh.is_empty()
    }

    /// A session's asks still offered, oldest first.
    pub fn waiting(&self, session_id: &str) -> Vec<&Ask> {
        let mut list: Vec<&Ask> = self
            .by_session
            .get(session_id)
            .map(|l| l.iter().filter(|a| !self.dismissed.contains(&a.request_id)).collect())
            .unwrap_or_default();
        list.sort_by_key(|a| self.position(&a.request_id));
        list
    }

    fn position(&self, request_id: &str) -> usize {
        self.order.iter().position(|id| id == request_id).unwrap_or(usize::MAX)
    }

    /// Sessions waiting on the reader, oldest ask first.
    pub fn attention(&self) -> Vec<String> {
        let mut keys: Vec<(usize, &String)> = self
            .by_session
            .keys()
            .filter_map(|k| self.waiting(k).first().map(|a| (self.position(&a.request_id), k)))
            .collect();
        keys.sort();
        keys.into_iter().map(|(_, k)| k.clone()).collect()
    }

    /// One session's asks put away, or every session's with none named.
    pub fn dismiss(&mut self, session_id: Option<&str>) {
        for (key, list) in &self.by_session {
            if session_id.is_none_or(|s| s == key) {
                self.dismissed.extend(list.iter().map(|a| a.request_id.clone()));
            }
        }
    }

    /// Whether the server still holds this one, so an answer that failed can
    /// put the card back.
    pub fn holds(&self, session_id: &str, request_id: &str) -> bool {
        self.by_session.get(session_id).is_some_and(|l| l.iter().any(|a| a.request_id == request_id))
    }
}

/// Answers keyed by each question's own text, which is how the CLI matches
/// them. Picks in option order, typed text last; a single pick gives way to
/// typed text; a question with neither is left out, which is Skip.
pub fn answers(questions: &[Question], picks: &[Vec<String>], typed: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (i, q) in questions.iter().enumerate() {
        let text = typed.get(i).map(|t| t.trim().to_string()).unwrap_or_default();
        let typed_answer: Vec<String> = if !text.is_empty() && q.free_text { vec![text] } else { vec![] };
        let chosen = picks.get(i).cloned().unwrap_or_default();
        let picked: Vec<String> = q.options.iter().map(|o| o.label.clone()).filter(|l| chosen.contains(l)).collect();
        let parts = if q.multi_select {
            [picked, typed_answer].concat()
        } else if typed_answer.is_empty() {
            picked
        } else {
            typed_answer
        };
        if !parts.is_empty() {
            out.insert(q.question.clone(), parts.join(", "));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn permission(session: &str, request: &str) -> Ask {
        Ask::from_event(&json!({
            "id": format!("e-{request}"),
            "sessionId": session,
            "payload": {
                "type": "permission_requested", "requestId": request, "toolUseId": "t", "toolName": "Bash",
                "displayName": null, "description": "List files", "input": { "command": "ls -la" },
                "options": [{ "id": "o1", "label": "Allow once", "kind": "once", "behavior": "allow" }],
            },
        }))
        .unwrap()
    }

    #[test]
    fn reads_both_kinds_and_skips_the_rest() {
        let q = Ask::from_event(&json!({
            "id": "e", "sessionId": "s",
            "payload": { "type": "questions_asked", "requestId": "r", "toolUseId": "t",
                "questions": [{ "question": "Which?", "header": null, "multiSelect": false,
                    "options": [{ "label": "A", "description": null, "preview": null }] }] },
        }))
        .unwrap();
        assert!(matches!(&q.kind, AskKind::Questions(qs) if qs[0].free_text && qs[0].options[0].label == "A"));
        assert!(matches!(permission("s", "r").kind, AskKind::Permission(_)));
        assert!(Ask::from_event(&json!({ "id": "e", "sessionId": "s", "payload": { "type": "turn_completed" } })).is_none());
    }

    #[test]
    fn a_command_waits_behind_its_description() {
        let AskKind::Permission(p) = permission("s", "r").kind else { unreachable!() };
        let line = ToolLine::new(&p);
        assert_eq!(line.tool, "Bash");
        assert_eq!(line.beside.as_deref(), Some("List files"));
        assert_eq!(line.hidden.as_deref(), Some("ls -la"));
    }

    #[test]
    fn a_path_sits_beside_the_tool_shortened() {
        let p = Permission { tool_name: "Write".into(), input: json!({ "file_path": "/a/b/c/d.rs" }), ..Default::default() };
        let line = ToolLine::new(&p);
        assert_eq!(line.beside.as_deref(), Some("c/d.rs"));
        assert!(line.hidden.is_none());
    }

    #[test]
    fn sessions_come_oldest_ask_first() {
        let mut asks = Asks::default();
        assert!(asks.add(permission("b", "1")));
        assert!(asks.add(permission("a", "2")));
        assert!(!asks.add(permission("a", "2")));
        assert_eq!(asks.attention(), ["b", "a"]);
        asks.decided("b", "1");
        assert_eq!(asks.attention(), ["a"]);
    }

    #[test]
    fn dismissed_asks_come_back_with_a_new_one() {
        let mut asks = Asks::default();
        asks.add(permission("a", "1"));
        asks.add(permission("b", "2"));
        asks.dismiss(Some("a"));
        assert_eq!(asks.attention(), ["b"]);
        asks.dismiss(None);
        assert!(asks.attention().is_empty());
        asks.add(permission("c", "3"));
        assert_eq!(asks.attention(), ["a", "b", "c"]);
    }

    #[test]
    fn a_reconnect_replaces_and_keeps_order() {
        let mut asks = Asks::default();
        asks.add(permission("a", "1"));
        asks.add(permission("b", "2"));
        assert!(!asks.replace(vec![permission("b", "2"), permission("a", "1")], HashMap::new()));
        assert_eq!(asks.attention(), ["a", "b"]);
        assert!(asks.replace(vec![permission("c", "3")], HashMap::new()));
        assert_eq!(asks.attention(), ["c"]);
    }

    #[test]
    fn a_reconnect_takes_the_server_s_order() {
        for _ in 0..20 {
            let mut asks = Asks::default();
            let list = ["s1", "s2", "s3", "s4", "s5"].iter().enumerate().map(|(n, s)| permission(s, &n.to_string())).collect();
            asks.replace(list, HashMap::new());
            assert_eq!(asks.attention(), ["s1", "s2", "s3", "s4", "s5"]);
        }
    }

    #[test]
    fn an_ended_turn_strands_its_asks_unless_a_task_runs() {
        let mut asks = Asks::default();
        asks.add(permission("a", "1"));
        asks.set_tasks("a", 1, false);
        asks.strand("a");
        assert_eq!(asks.attention(), ["a"]);
        asks.set_tasks("a", 0, false);
        assert!(asks.attention().is_empty());
    }

    #[test]
    fn answers_take_the_cli_s_three_shapes() {
        let q = |name: &str, multi: bool| Question {
            question: name.into(),
            multi_select: multi,
            options: vec![
                QuestionOption { label: "A".into(), description: None },
                QuestionOption { label: "B".into(), description: None },
            ],
            free_text: true,
        };
        let qs = [q("pick", false), q("many", true), q("typed", false), q("skipped", false)];
        let picks = vec![vec!["B".into()], vec!["B".into(), "A".into()], vec!["A".into()], vec![]];
        let typed = vec![String::new(), "C".into(), "  own  ".into(), String::new()];
        let out = answers(&qs, &picks, &typed);
        assert_eq!(out["pick"], "B");
        assert_eq!(out["many"], "A, B, C");
        assert_eq!(out["typed"], "own");
        assert!(!out.contains_key("skipped"));
    }
}
