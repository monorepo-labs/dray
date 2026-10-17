//! Standard ACP onto Dray's vocabulary.
//!
//! grok's mapper with every grok-ism taken out. A turn opens on its first
//! update and closes on the prompt's answer; chunks carry no id, so one block
//! runs until a chunk of the other kind arrives.

use crate::events::{
    usage::ContextWindow, AgentEvent, AgentEventPayload, BlockType, DeltaEvent, SessionInfo, ToolResult,
    TurnStatus, Usage,
};
use crate::harness::acp::{self, block_ref, OpenBlock};
use crate::harness::{mentions_any, Harness};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

use super::parser::{AcpEvent, PromptResponse, SessionUpdate, ToolContent, ToolKind, ToolStatus};

/// Written to under-match, for [`mentions_any`]'s reason.
const LOGIN_NEEDLES: &[&str] = &["authentication required", "not authenticated", "not logged in", "log in"];

/// What a call opened with, so a permission card can name its subject — a
/// request often carries the call id and nothing else.
#[derive(Debug, Clone)]
pub struct KnownCall {
    pub title: Option<String>,
    pub input: Value,
}

pub struct Mapper {
    session_id: String,
    harness: Harness,
    seq: Arc<AtomicU64>,
    pub(super) turn_open: bool,
    open: Option<OpenBlock>,
    blocks: u64,
    occupancy: Option<ContextWindow>,
    /// The newest non-empty text a running call streamed, by call id.
    outputs: HashMap<String, String>,
    /// An exit code by call id. Devin reports it on an in-progress update and
    /// closes the call with an empty one, so it has to outlive the update.
    exits: HashMap<String, i32>,
    /// Calls opened with no arguments yet, held until an update brings some.
    undrawn: HashMap<String, ToolKind>,
    calls: HashMap<String, KnownCall>,
}

impl Mapper {
    pub fn new(session_id: String, harness: Harness, seq: Arc<AtomicU64>) -> Self {
        Self {
            session_id,
            harness,
            seq,
            turn_open: false,
            open: None,
            blocks: 0,
            occupancy: None,
            outputs: HashMap::new(),
            exits: HashMap::new(),
            undrawn: HashMap::new(),
            calls: HashMap::new(),
        }
    }

    pub fn call(&self, id: &str) -> Option<&KnownCall> {
        self.calls.get(id)
    }

    pub fn map(&mut self, event: AcpEvent) -> Vec<AgentEvent> {
        match event {
            AcpEvent::Update(update) => self.update(update),
            AcpEvent::PromptDone(response) => self.prompt_done(response),
            AcpEvent::PromptFailed { message } => self.prompt_failed(message),
        }
    }

    fn update(&mut self, update: SessionUpdate) -> Vec<AgentEvent> {
        match update {
            SessionUpdate::AgentMessageChunk { content } => match content.text() {
                Some(text) => self.chunk(BlockType::Text, text),
                None => Vec::new(),
            },
            SessionUpdate::AgentThoughtChunk { content } => match content.text() {
                Some(text) => self.chunk(BlockType::Thinking, text),
                None => Vec::new(),
            },

            SessionUpdate::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                content,
                raw_input,
            } => {
                let finished = status.filter(|s| s.is_final());
                let input = tool_input(raw_input, &content);
                // An edit announced before its arguments is drawn by the update
                // that brings them, or its row keeps an empty input for good.
                if finished.is_none() && is_empty(&input) {
                    self.calls.insert(tool_call_id.clone(), KnownCall { title, input });
                    self.undrawn.insert(tool_call_id, kind);
                    return Vec::new();
                }
                let mut out = self.open_call(tool_call_id.clone(), title, kind, input);
                // A quick call can arrive finished on its opening line. Not a
                // replay: the read loop drops those before the session opens.
                if finished.is_some() {
                    out.extend(self.update(SessionUpdate::ToolCallUpdate {
                        tool_call_id,
                        title: None,
                        status: finished,
                        content,
                        raw_input: None,
                        meta: None,
                    }));
                }
                out
            }

            SessionUpdate::ToolCallUpdate {
                tool_call_id,
                title,
                status,
                content,
                raw_input,
                meta,
            } => {
                // Some agents open a call with its first update, and some open
                // one before its arguments. Either is drawn once there is
                // something to draw, or at the latest when it finishes.
                let mut out = Vec::new();
                let undrawn = self.undrawn.remove(&tool_call_id);
                if undrawn.is_some() || !self.calls.contains_key(&tool_call_id) {
                    let known = self.calls.remove(&tool_call_id);
                    let mut input = tool_input(raw_input, &content);
                    if is_empty(&input) {
                        input = known.as_ref().map(|k| k.input.clone()).unwrap_or(input);
                    }
                    let title = title.or_else(|| known.and_then(|k| k.title));
                    let kind = undrawn.unwrap_or_default();
                    if is_empty(&input) && !status.is_some_and(ToolStatus::is_final) {
                        self.calls.insert(tool_call_id.clone(), KnownCall { title, input });
                        self.undrawn.insert(tool_call_id.clone(), kind);
                    } else {
                        out.extend(self.open_call(tool_call_id.clone(), title, kind, input));
                    }
                }

                let text: String = content
                    .iter()
                    .filter_map(|c| match c {
                        ToolContent::Content { content } => content.text(),
                        _ => None,
                    })
                    .collect();
                let has_diff = content.iter().any(|c| matches!(c, ToolContent::Diff { .. }));
                if let Some(code) = exit_code(meta.as_ref()) {
                    self.exits.insert(tool_call_id.clone(), code);
                }

                let Some(status) = status.filter(|s| s.is_final()) else {
                    if !text.is_empty() {
                        self.outputs.insert(tool_call_id, text);
                    }
                    return out;
                };

                let streamed = self.outputs.remove(&tool_call_id).unwrap_or_default();
                let exit_code = self.exits.remove(&tool_call_id);
                let text = match (has_diff, text.is_empty()) {
                    // The diff is what the row draws; a sentence about it is noise.
                    (true, _) => String::new(),
                    (false, false) => text,
                    (false, true) => streamed,
                };
                out.push(self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: tool_call_id,
                    result: ToolResult {
                        text,
                        is_error: status == ToolStatus::Failed,
                        structured: None,
                        exit_code,
                        duration_ms: None,
                        images: Vec::new(),
                    },
                }));
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            SessionUpdate::UsageUpdate { used, size } => {
                if let (Some(used), Some(size)) = (used, size) {
                    self.occupancy = Some(ContextWindow {
                        used_tokens: used,
                        max_tokens: size,
                    });
                }
                Vec::new()
            }

            // Read by the read loop, not drawn.
            SessionUpdate::SessionInfoUpdate { .. }
            | SessionUpdate::AvailableCommandsUpdate { .. }
            | SessionUpdate::CurrentModeUpdate { .. }
            | SessionUpdate::ConfigOptionUpdate { .. }
            | SessionUpdate::UserMessageChunk
            | SessionUpdate::Plan
            | SessionUpdate::Unknown => Vec::new(),
        }
    }

    fn chunk(&mut self, kind: BlockType, text: &str) -> Vec<AgentEvent> {
        let mut out = self.ensure_turn();
        out.extend(self.stream(kind, text));
        out
    }

    fn open_call(
        &mut self,
        id: String,
        title: Option<String>,
        kind: ToolKind,
        input: Value,
    ) -> Vec<AgentEvent> {
        self.calls.insert(
            id.clone(),
            KnownCall {
                title: title.clone(),
                input: input.clone(),
            },
        );
        let mut out = self.ensure_turn();
        out.extend(self.close_open());
        out.push(self.event(AgentEventPayload::ToolCallStarted {
            call_id: id,
            tool_type: kind.tool_type(),
            name: kind.name().to_string(),
            input,
            raw_input: None,
            // Standard ACP's title is a sentence about the call ("Wrote
            // ./hello.txt"), which is what the row should say.
            title,
        }));
        out
    }

    fn prompt_done(&mut self, response: PromptResponse) -> Vec<AgentEvent> {
        let mut out = self.close_open();
        let (status, final_text) = match response.stop_reason.as_str() {
            "refusal" | "refused" => (TurnStatus::Error, Some("The agent refused this prompt.".to_string())),
            "max_tokens" => (
                TurnStatus::Error,
                Some("The agent stopped: the model hit its output token limit.".to_string()),
            ),
            "max_turn_requests" => (
                TurnStatus::Error,
                Some("The agent stopped: the turn hit its request limit.".to_string()),
            ),
            // `end_turn`, and `cancelled` — the reader's own Stop. A call left
            // open by a cancel is closed by the transcript's abandoned rule.
            _ => (TurnStatus::Success, None),
        };
        let usage = response.usage.map(|u| Usage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_input_tokens: u.cached_read_tokens,
            reasoning_tokens: u.thought_tokens,
            context_window: self.occupancy,
            ..Default::default()
        });
        out.push(self.turn_completed(status, Some(response.stop_reason), final_text, false, usage));
        out
    }

    fn prompt_failed(&mut self, message: String) -> Vec<AgentEvent> {
        let mut out = self.close_open();
        let auth_failed = mentions_any(&message, LOGIN_NEEDLES);
        out.push(self.turn_completed(TurnStatus::Error, None, Some(message), auth_failed, None));
        out
    }

    fn turn_completed(
        &mut self,
        status: TurnStatus,
        stop_reason: Option<String>,
        final_text: Option<String>,
        auth_failed: bool,
        usage: Option<Usage>,
    ) -> AgentEvent {
        let event = self.event(AgentEventPayload::TurnCompleted {
            status,
            stop_reason,
            auth_failed,
            final_text,
            usage: usage.or_else(|| {
                self.occupancy.map(|window| Usage {
                    context_window: Some(window),
                    ..Default::default()
                })
            }),
            duration_ms: None,
            head: None,
        });
        self.turn_open = false;
        self.outputs.clear();
        self.exits.clear();
        self.undrawn.clear();
        self.calls.clear();
        event
    }

    fn ensure_turn(&mut self) -> Vec<AgentEvent> {
        if self.turn_open {
            return Vec::new();
        }
        self.turn_open = true;
        vec![
            self.event(AgentEventPayload::TurnStarted(SessionInfo::default())),
            self.event(AgentEventPayload::ModelRequestStarted),
        ]
    }

    fn stream(&mut self, kind: BlockType, text: &str) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        let id = match &self.open {
            Some(block) if block.kind == kind => block.id.clone(),
            _ => {
                out.extend(self.close_open());
                self.blocks += 1;
                let id = format!("block-{}", self.blocks);
                out.push(self.event(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                    block: block_ref(&id),
                    block_type: kind.clone(),
                })));
                self.open = Some(OpenBlock {
                    id: id.clone(),
                    kind,
                    text: String::new(),
                });
                id
            }
        };
        if let Some(block) = &mut self.open {
            block.text.push_str(text);
        }
        out.push(self.event(AgentEventPayload::Delta(DeltaEvent::TextDelta {
            block: block_ref(&id),
            text: text.to_string(),
        })));
        out
    }

    fn close_open(&mut self) -> Vec<AgentEvent> {
        match self.open.take() {
            Some(block) => acp::commit(block, |payload| self.event(payload)),
            None => Vec::new(),
        }
    }

    /// For events raised from a JSON-RPC request rather than an update.
    pub fn synthesize(&self, payload: AgentEventPayload) -> AgentEvent {
        self.event(payload)
    }

    fn event(&self, payload: AgentEventPayload) -> AgentEvent {
        AgentEvent::mint(self.session_id.clone(), self.harness, self.seq.fetch_add(1, Relaxed), None, None, payload)
    }
}

/// The call's arguments as the row draws them, always an object.
///
/// An edit's sides come from the `diff` content where `rawInput` lacks them,
/// under the names Dray's diff rows read (`file_path`, `old_string`,
/// `new_string`, `content`) — so an edit draws as a diff on any agent that
/// follows the protocol, whatever it calls its own fields.
fn tool_input(raw: Option<Value>, content: &[ToolContent]) -> Value {
    let mut input = match raw {
        Some(Value::Object(map)) => Value::Object(map),
        Some(Value::Null) | None => json!({}),
        Some(other) => json!({ "_unparsed": other.to_string() }),
    };
    let Some(map) = input.as_object_mut() else {
        return input;
    };
    if let Some(ToolContent::Diff { path, old_text, new_text }) =
        content.iter().find(|c| matches!(c, ToolContent::Diff { .. }))
    {
        map.entry("file_path").or_insert_with(|| json!(path));
        match old_text {
            Some(old) => {
                map.entry("old_string").or_insert_with(|| json!(old));
                map.entry("new_string").or_insert_with(|| json!(new_text));
            }
            None => {
                map.entry("content").or_insert_with(|| json!(new_text));
            }
        }
    }
    input
}

fn is_empty(input: &Value) -> bool {
    input.as_object().is_some_and(|map| map.is_empty())
}

/// A shell's exit code, where the agent says. Not ACP — Devin's
/// `_meta.terminal_exit` — but un-namespaced and cheap to read.
fn exit_code(meta: Option<&Value>) -> Option<i32> {
    meta?.pointer("/terminal_exit/exit_code")?.as_i64().map(|c| c as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::AgentEventPayload as P;
    use crate::harness::agents::parser::{parse_notification, AcpEvent};

    /// Replays a capture the way the read loop does: updates after the
    /// session opened, then the prompt's answer.
    fn replay(fixture: &str) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new("s".into(), Harness::Acp("devin"), Arc::new(AtomicU64::new(0)));
        let mut out = Vec::new();
        let mut opened = false;
        let mut prompt_id = None;

        for line in fixture.lines() {
            if let Some(sent) = line.strip_prefix(">> ") {
                let value: Value = serde_json::from_str(sent).unwrap();
                if value["method"] == "session/prompt" {
                    prompt_id = value["id"].as_i64();
                }
                continue;
            }
            let Some(line) = line.strip_prefix("<< ") else { continue };
            let value: Value = serde_json::from_str(line).unwrap();
            if !opened {
                opened = value.pointer("/result/configOptions").is_some();
                continue;
            }
            if let Some(method) = value["method"].as_str() {
                if value.get("id").is_some() {
                    continue;
                }
                if let Ok(note) = parse_notification(method, value["params"].clone()) {
                    out.extend(mapper.map(AcpEvent::Update(note.update)));
                }
            } else if value["id"].as_i64() == prompt_id && prompt_id.is_some() {
                let response = serde_json::from_value(value["result"].clone()).unwrap();
                out.extend(mapper.map(AcpEvent::PromptDone(response)));
            }
        }
        out
    }

    /// The write draws as a diff from the `diff` content, the shell's result is
    /// the listing it streamed, and its exit code survives.
    #[test]
    fn a_devin_turn_draws_its_edit_and_its_shell() {
        let events = replay(include_str!("fixtures/devin_turn.jsonl"));

        let write = events
            .iter()
            .find_map(|e| match &e.payload {
                P::ToolCallStarted { input, title, .. } if input.get("content").is_some() => Some((input, title)),
                _ => None,
            })
            .expect("the write opened");
        assert!(write.0["file_path"].as_str().unwrap().ends_with("hello.txt"));
        assert_eq!(write.0["content"], "hi");
        assert_eq!(write.1.as_deref(), Some("Wrote ./hello.txt"));

        let results: Vec<&ToolResult> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallCompleted { result, .. } => Some(result),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 2);
        let shell = results.iter().find(|r| r.text.contains("hello.txt")).expect("ls output kept");
        assert_eq!(shell.exit_code, Some(0));

        let last = events.last().expect("events");
        assert!(matches!(&last.payload, P::TurnCompleted { status: TurnStatus::Success, usage: Some(u), .. }
            if u.context_window.is_some()));
    }

    /// A cancelled turn is the reader's own Stop, not a failure.
    #[test]
    fn a_cancelled_turn_closes_quietly() {
        let events = replay(include_str!("fixtures/devin_cancel.jsonl"));
        assert!(matches!(
            &events.last().expect("events").payload,
            P::TurnCompleted { status: TurnStatus::Success, stop_reason: Some(r), .. } if r == "cancelled"
        ));
    }

    fn updates(lines: &[Value]) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new("s".into(), Harness::Acp("test"), Arc::new(AtomicU64::new(0)));
        lines
            .iter()
            .flat_map(|update| {
                let params = json!({ "sessionId": "x", "update": update });
                let Ok(note) = parse_notification("session/update", params) else { panic!("unparsed") };
                mapper.map(AcpEvent::Update(note.update))
            })
            .collect()
    }

    /// An edit announced bare is drawn by the update carrying its diff.
    #[test]
    fn a_call_opened_with_no_arguments_waits_for_them() {
        let events = updates(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"c","title":"Edit","kind":"edit","status":"pending"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"c","status":"in_progress",
                "content":[{"type":"diff","path":"/a.txt","oldText":"x","newText":"y"}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"c","status":"completed"}),
        ]);
        let starts: Vec<&Value> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallStarted { input, .. } => Some(input),
                _ => None,
            })
            .collect();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0]["new_string"], "y");
        assert!(events.iter().any(|e| matches!(e.payload, P::ToolCallCompleted { .. })));
    }

    /// A call that arrives finished is drawn whole, not dropped as a replay.
    #[test]
    fn a_call_opened_finished_is_drawn() {
        let events = updates(&[json!({"sessionUpdate":"tool_call","toolCallId":"c","title":"Read",
            "kind":"read","status":"failed","rawInput":{"path":"/a"},
            "content":[{"type":"content","content":{"type":"text","text":"no such file"}}]})]);
        assert!(events.iter().any(|e| matches!(e.payload, P::ToolCallStarted { .. })));
        assert!(events.iter().any(|e| matches!(&e.payload,
            P::ToolCallCompleted { result, .. } if result.is_error && result.text == "no such file")));
    }
}
