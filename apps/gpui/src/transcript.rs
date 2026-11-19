//! One session's transcript as rows, folded from its logged events and the
//! live ones after them. A small port of transcript.ts: the main thread only,
//! deltas as a preview the committed event takes over in place.
//!
//! Rows are only ever appended or changed in place, never removed or moved,
//! so the view can hand GPUI's `list` a splice at the end and a remeasure.

use std::collections::HashSet;

use dray_core::events::{
    AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent, FileEdit, ToolResult, ToolType, TurnStatus, has_text,
};
use serde_json::Value;

#[derive(Debug, Clone)]
pub enum Row {
    User { text: String },
    /// `block` names the stream this row previews, while it still streams.
    /// `key` is stable for the row's life, the commit and a page's refold
    /// included: the stream's `message_id:index` where there is one, else
    /// the event's id. The markdown view keeps its parse and selection by it.
    Assistant { key: String, text: String, block: Option<BlockRef>, streaming: bool },
    Tool(Tool),
    /// A failed turn's own sentence, drawn red.
    Failed { text: String },
}

/// One tool call as the row draws it: the call, and its result and file edits
/// once they land, all joined on the call id.
#[derive(Debug, Clone)]
pub struct Tool {
    pub call_id: String,
    pub name: String,
    pub tool_type: ToolType,
    pub summary: Option<String>,
    pub done: bool,
    pub error: bool,
    /// `Null` while only the stream has named the call.
    pub input: Value,
    pub raw_input: Option<String>,
    pub title: Option<String>,
    pub result: Option<ToolResult>,
    pub edits: Vec<FileEdit>,
}

impl Tool {
    fn streaming(call_id: &str, name: &str) -> Tool {
        Tool {
            call_id: call_id.to_string(),
            name: name.to_string(),
            tool_type: ToolType::Other,
            summary: None,
            done: false,
            error: false,
            input: Value::Null,
            raw_input: None,
            title: None,
            result: None,
            edits: Vec::new(),
        }
    }
}

/// What applying events changed, for the view to pass to its list.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Change {
    /// Rows appended at the end.
    pub added: usize,
    /// Rows changed in place, by index.
    pub changed: Vec<usize>,
}

#[derive(Default)]
pub struct Transcript {
    pub rows: Vec<Row>,
    /// Event ids already folded, since a live event can also arrive in a read.
    seen: HashSet<String>,
    /// Blocks already committed, so a delta held behind the read that
    /// delivered its committed event opens no preview nothing would retire.
    committed: HashSet<(String, u32)>,
}

impl Transcript {
    /// Folds one event; `false` where it was a subagent's or already folded.
    pub fn apply(&mut self, event: &AgentEvent, change: &mut Change) -> bool {
        if event.subagent.is_some() || !self.seen.insert(event.id.clone()) {
            return false;
        }
        let before = self.rows.len();
        match &event.payload {
            AgentEventPayload::UserMessage { text, kickoff: false, .. } => {
                self.rows.push(Row::User { text: text.clone() });
            }
            AgentEventPayload::AssistantText { block, text } => {
                if let Some(b) = block {
                    self.committed.insert((b.message_id.clone(), b.index));
                }
                let key = block.as_ref().map(block_key).unwrap_or_else(|| event.id.clone());
                let at = block.as_ref().and_then(|b| self.streaming(b));
                match at {
                    Some(i) => {
                        self.rows[i] = Row::Assistant { key, text: text.clone(), block: None, streaming: false };
                        change.changed.push(i);
                    }
                    // Blocks with nothing visible draw nothing in the web app either.
                    None if has_text(text) => {
                        self.rows.push(Row::Assistant { key, text: text.clone(), block: None, streaming: false })
                    }
                    None => {}
                }
            }
            AgentEventPayload::Delta(delta) => self.delta(delta, change),
            AgentEventPayload::ToolCallStarted { call_id, name, tool_type, input, raw_input, title } => {
                let i = match self.tool(call_id) {
                    Some(i) => {
                        change.changed.push(i);
                        i
                    }
                    None => {
                        self.rows.push(Row::Tool(Tool::streaming(call_id, name)));
                        self.rows.len() - 1
                    }
                };
                if let Row::Tool(tool) = &mut self.rows[i] {
                    tool.name = name.clone();
                    tool.tool_type = *tool_type;
                    tool.summary = summary(name, *tool_type, input);
                    tool.input = input.clone();
                    tool.raw_input = raw_input.clone();
                    tool.title = title.clone();
                }
            }
            AgentEventPayload::FileEdits { call_id: Some(call_id), edits } => {
                if let Some(i) = self.tool(call_id)
                    && let Row::Tool(tool) = &mut self.rows[i]
                {
                    tool.edits.extend(edits.iter().cloned());
                    change.changed.push(i);
                }
            }
            AgentEventPayload::ToolCallCompleted { call_id, result } => {
                if let Some(i) = self.tool(call_id)
                    && let Row::Tool(tool) = &mut self.rows[i]
                {
                    tool.done = true;
                    tool.error = result.is_error;
                    tool.result = Some(result.clone());
                    change.changed.push(i);
                }
            }
            AgentEventPayload::TurnCompleted { status: TurnStatus::Error, stop_reason, final_text, .. } => {
                // Aborts draw nothing; otherwise the harness's own sentence,
                // which replaces an identical last block rather than repeating it.
                if !stop_reason.as_deref().is_some_and(|r| r.starts_with("aborted")) {
                    let text = final_text.clone().filter(|t| !t.trim().is_empty()).unwrap_or("Turn failed".into());
                    if let Some(Row::Assistant { text: last, .. }) = self.rows.last()
                        && last.trim() == text.trim()
                    {
                        let i = self.rows.len() - 1;
                        self.rows[i] = Row::Failed { text };
                        change.changed.push(i);
                    } else {
                        self.rows.push(Row::Failed { text });
                    }
                }
            }
            _ => {}
        }
        change.added += self.rows.len() - before;
        true
    }

    fn delta(&mut self, delta: &DeltaEvent, change: &mut Change) {
        match delta {
            DeltaEvent::BlockStart { block, block_type: BlockType::Text }
                if !self.committed.contains(&(block.message_id.clone(), block.index)) =>
            {
                self.rows.push(Row::Assistant {
                    key: block_key(block),
                    text: String::new(),
                    block: Some(block.clone()),
                    streaming: true,
                });
            }
            // A tool call is drawn before its arguments arrive; the committed
            // `tool_call_started` fills the row in place.
            DeltaEvent::BlockStart { block_type: BlockType::ToolUse { id, name }, .. } => {
                if self.tool(id).is_none() {
                    self.rows.push(Row::Tool(Tool::streaming(id, name)));
                }
            }
            DeltaEvent::TextDelta { block, text } => match self.streaming(block) {
                Some(i) => {
                    if let Row::Assistant { text: held, .. } = &mut self.rows[i] {
                        held.push_str(text);
                        change.changed.push(i);
                    }
                }
                // Opened mid-block: its `block_start` went by before the
                // session was on screen, so the first delta seen opens it.
                None if !self.committed.contains(&(block.message_id.clone(), block.index)) => {
                    self.rows.push(Row::Assistant {
                        key: block_key(block),
                        text: text.clone(),
                        block: Some(block.clone()),
                        streaming: true,
                    });
                }
                None => {}
            },
            _ => {}
        }
    }

    fn streaming(&self, block: &BlockRef) -> Option<usize> {
        self.rows.iter().rposition(|r| matches!(r, Row::Assistant { block: Some(b), .. } if b == block))
    }

    fn tool(&self, call_id: &str) -> Option<usize> {
        self.rows.iter().rposition(|r| matches!(r, Row::Tool(t) if t.call_id == call_id))
    }
}

fn block_key(block: &BlockRef) -> String {
    format!("{}:{}", block.message_id, block.index)
}

/// tools.ts's `toolSummary`: the argument that identifies the work.
pub fn summary(name: &str, tool_type: ToolType, input: &Value) -> Option<String> {
    let field = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    match name {
        "Skill" => return field(input, "skill"),
        "skill" => return field(input, "location").and_then(|l| l.rsplit('/').next().map(str::to_string)),
        "use_tool" => return field(input, "tool_name"),
        _ => {}
    }
    if let Some(p) = field(input, "pattern") {
        return Some(p);
    }
    if let Some(p) = ["file_path", "path", "notebook_path", "target_file", "target_directory"]
        .iter()
        .find_map(|k| field(input, k))
    {
        return Some(shorten_path(&p));
    }
    if let Some(request) = input.get("request").filter(|r| r.is_object()) {
        return field(request, "task").or_else(|| field(request, "query"));
    }
    let typed = match tool_type {
        ToolType::Shell => field(input, "command"),
        ToolType::Search => field(input, "query"),
        ToolType::Web => field(input, "url").or_else(|| field(input, "query")),
        ToolType::SubagentSpawn => field(input, "description").or_else(|| field(input, "subagent_type")),
        _ => None,
    };
    typed.or_else(|| ["description", "command", "query", "prompt"].iter().find_map(|k| field(input, k)))
}

/// The last two components of a path, as tools.ts's `shortenPath` keeps them.
fn shorten_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() <= 2 { path.to_string() } else { parts[parts.len() - 2..].join("/") }
}

/// tools.ts's `TOOL_VERBS`, the present and past label of the built-in tools.
/// Anything else is labelled by its own name.
pub fn label(name: &str, pending: bool) -> &str {
    let (running, done) = match name {
        "Read" | "NotebookRead" => ("Reading", "Read"),
        "Edit" | "NotebookEdit" | "apply_patch" => ("Editing", "Edited"),
        "Write" => ("Writing", "Wrote"),
        "Bash" | "shell" | "bash" => ("Bash", "Bash"),
        "BashOutput" => ("Reading output", "Read output"),
        "KillShell" => ("Killing shell", "Killed shell"),
        "Grep" | "Glob" => ("Searching", "Searched"),
        "WebFetch" => ("Fetching", "Fetched"),
        "WebSearch" | "web_search" => ("Searching web", "Searched web"),
        "AskUserQuestion" => ("Asking", "Asked"),
        "Skill" => ("Reading Skill", "Read Skill"),
        "view_image" => ("Viewing", "Viewed"),
        _ => return name,
    };
    if pending { running } else { done }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(id: &str, payload: Value) -> AgentEvent {
        serde_json::from_value(json!({
            "id": id, "sessionId": "s", "harness": "claude_code", "seq": 0, "ts": "",
            "turnId": null, "subagent": null, "payload": payload,
        }))
        .unwrap()
    }

    fn block() -> Value {
        json!({ "messageId": "m", "index": 0 })
    }

    fn fold(events: &[AgentEvent]) -> (Transcript, Change) {
        let mut t = Transcript::default();
        let mut change = Change::default();
        for e in events {
            t.apply(e, &mut change);
        }
        (t, change)
    }

    #[test]
    fn the_committed_text_takes_over_its_preview_in_place() {
        let (t, _) = fold(&[
            event("1", json!({ "type": "user_message", "text": "hi" })),
            event("2", json!({ "type": "delta", "delta": "block_start", "block": block(), "blockType": { "type": "text" } })),
            event("3", json!({ "type": "delta", "delta": "text_delta", "block": block(), "text": "Hel" })),
            event("4", json!({ "type": "assistant_text", "block": block(), "text": "Hello" })),
        ]);
        assert_eq!(t.rows.len(), 2);
        assert!(matches!(&t.rows[1], Row::Assistant { key, text, block: None, streaming: false }
            if text == "Hello" && key == "m:0"));
    }

    #[test]
    fn a_tool_row_is_drawn_from_the_stream_and_filled_by_the_call() {
        let (t, change) = fold(&[
            event(
                "1",
                json!({ "type": "delta", "delta": "block_start", "block": block(),
                        "blockType": { "type": "tool_use", "id": "c1", "name": "Read" } }),
            ),
            event(
                "2",
                json!({ "type": "tool_call_started", "callId": "c1", "name": "Read", "toolType": "file_read",
                        "input": { "file_path": "/a/b/c/main.rs" }, "rawInput": null, "title": null }),
            ),
            event("3", json!({ "type": "tool_call_completed", "callId": "c1", "result": { "text": "", "isError": true,
                        "structured": null, "exitCode": null, "durationMs": null } })),
        ]);
        assert_eq!(change.added, 1);
        let Row::Tool(tool) = &t.rows[0] else { panic!() };
        assert_eq!(tool.summary.as_deref(), Some("c/main.rs"));
        assert_eq!(tool.input["file_path"], "/a/b/c/main.rs");
        assert!(tool.done && tool.error && tool.result.is_some());
    }

    #[test]
    fn a_delta_landing_after_its_committed_text_opens_no_preview() {
        let (t, _) = fold(&[
            event("1", json!({ "type": "assistant_text", "block": block(), "text": "Hello" })),
            event("2", json!({ "type": "delta", "delta": "block_start", "block": block(), "blockType": { "type": "text" } })),
            event("3", json!({ "type": "delta", "delta": "text_delta", "block": block(), "text": "Hel" })),
        ]);
        assert_eq!(t.rows.len(), 1);
    }

    #[test]
    fn a_delta_for_a_block_opened_before_the_session_was_seen_opens_a_preview() {
        let (t, _) = fold(&[event("1", json!({ "type": "delta", "delta": "text_delta", "block": block(), "text": "lo" }))]);
        assert!(matches!(&t.rows[..], [Row::Assistant { text, block: Some(_), streaming: true, .. }] if text == "lo"));
    }

    #[test]
    fn a_stop_draws_no_failure() {
        let (t, _) = fold(&[event("1", json!({ "type": "turn_completed", "status": "error",
            "stopReason": "aborted_streaming", "finalText": null, "usage": null, "durationMs": null }))]);
        assert!(t.rows.is_empty());
    }

    #[test]
    fn an_event_seen_twice_is_folded_once() {
        let e = event("1", json!({ "type": "user_message", "text": "hi" }));
        let (t, _) = fold(&[e.clone(), e]);
        assert_eq!(t.rows.len(), 1);
    }

    #[test]
    fn a_failed_turn_replaces_its_own_sentence() {
        let (t, _) = fold(&[
            event("1", json!({ "type": "assistant_text", "block": null, "text": "Credit balance is too low" })),
            event("2", json!({ "type": "turn_completed", "status": "error", "stopReason": "stop_sequence",
                        "finalText": "Credit balance is too low", "usage": null, "durationMs": null })),
        ]);
        assert!(matches!(&t.rows[..], [Row::Failed { text }] if text == "Credit balance is too low"));
    }
}
