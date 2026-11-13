//! One session's transcript as rows, folded from its logged events and the
//! live ones after them. A small port of transcript.ts: the main thread only,
//! deltas as a preview the committed event takes over in place.
//!
//! Rows are only ever appended or changed in place, never removed or moved,
//! so the view can hand GPUI's `list` a splice at the end and a remeasure.

use std::collections::HashSet;

use dray_core::events::{AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent, ToolType, TurnStatus};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    User { text: String },
    /// `block` names the stream this row previews, while it still streams.
    Assistant { text: String, block: Option<BlockRef>, streaming: bool },
    Tool(Tool),
    /// A failed turn's own sentence, drawn red.
    Failed { text: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub call_id: String,
    pub name: String,
    pub tool_type: ToolType,
    pub summary: Option<String>,
    pub done: bool,
    pub error: bool,
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
    pub fn apply(&mut self, event: &AgentEvent, change: &mut Change) {
        if event.subagent.is_some() || !self.seen.insert(event.id.clone()) {
            return;
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
                let at = block.as_ref().and_then(|b| self.streaming(b));
                match at {
                    Some(i) => {
                        self.rows[i] = Row::Assistant { text: text.clone(), block: None, streaming: false };
                        change.changed.push(i);
                    }
                    // Whitespace-only blocks draw nothing in the web app either.
                    None if !text.trim().is_empty() => {
                        self.rows.push(Row::Assistant { text: text.clone(), block: None, streaming: false })
                    }
                    None => {}
                }
            }
            AgentEventPayload::Delta(delta) => self.delta(delta, change),
            AgentEventPayload::ToolCallStarted { call_id, name, tool_type, input, .. } => {
                let tool = Tool {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    tool_type: *tool_type,
                    summary: summary(name, *tool_type, input),
                    done: false,
                    error: false,
                };
                match self.tool(call_id) {
                    Some(i) => {
                        self.rows[i] = Row::Tool(tool);
                        change.changed.push(i);
                    }
                    None => self.rows.push(Row::Tool(tool)),
                }
            }
            AgentEventPayload::ToolCallCompleted { call_id, result } => {
                if let Some(i) = self.tool(call_id)
                    && let Row::Tool(tool) = &mut self.rows[i]
                {
                    tool.done = true;
                    tool.error = result.is_error;
                    change.changed.push(i);
                }
            }
            AgentEventPayload::TurnCompleted { status: TurnStatus::Error, stop_reason, final_text, .. } => {
                // Aborts draw nothing; otherwise the harness's own sentence,
                // which replaces an identical last block rather than repeating it.
                if stop_reason.as_deref() != Some("aborted") {
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
    }

    fn delta(&mut self, delta: &DeltaEvent, change: &mut Change) {
        match delta {
            DeltaEvent::BlockStart { block, block_type: BlockType::Text }
                if !self.committed.contains(&(block.message_id.clone(), block.index)) =>
            {
                self.rows.push(Row::Assistant { text: String::new(), block: Some(block.clone()), streaming: true });
            }
            // A tool call is drawn before its arguments arrive; the committed
            // `tool_call_started` fills the row in place.
            DeltaEvent::BlockStart { block_type: BlockType::ToolUse { id, name }, .. } => {
                if self.tool(id).is_none() {
                    self.rows.push(Row::Tool(Tool {
                        call_id: id.clone(),
                        name: name.clone(),
                        tool_type: ToolType::Other,
                        summary: None,
                        done: false,
                        error: false,
                    }));
                }
            }
            DeltaEvent::TextDelta { block, text } => {
                if let Some(i) = self.streaming(block)
                    && let Row::Assistant { text: held, .. } = &mut self.rows[i]
                {
                    held.push_str(text);
                    change.changed.push(i);
                }
            }
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
        assert_eq!(t.rows[1], Row::Assistant { text: "Hello".into(), block: None, streaming: false });
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
        assert!(tool.done && tool.error);
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
        assert_eq!(t.rows, [Row::Failed { text: "Credit balance is too low".into() }]);
    }
}
