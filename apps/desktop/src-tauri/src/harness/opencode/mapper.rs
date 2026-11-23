//! OpenCode's ACP vocabulary onto Dray's.
//!
//! grok's reading of the same protocol, minus grok's extensions. Three things
//! are synthesized: `TurnStarted` on the first update after a prompt, since the
//! turn opens on a request rather than a line; `ModelRequestStarted` with it
//! and after every tool result; and block ids, since a chunk carries none and
//! one block runs until an update of another kind arrives.

use crate::events::{
    usage::ContextWindow, AgentEvent, AgentEventPayload, BlockType, DeltaEvent, SessionInfo, ToolResult, ToolType,
    TurnStatus, Usage,
};
use crate::harness::acp::{self, block_ref, OpenBlock};
use crate::harness::{mentions_any, Harness};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

use super::parser::{OpenCodeEvent, OpenCodeUpdate, PromptResponse, RawOutput, ToolContent, ToolKind, ToolStatus};

/// What a refused prompt says when the provider credential is the problem.
/// Written to under-match for [`mentions_any`]'s reason; read off the live
/// refusal, which named a reset API key.
const LOGIN_NEEDLES: &[&str] = &["api key", "unauthorized", "authentication", "auth login"];

/// A call seen opening and not yet drawn: the row waits for its arguments.
struct OpeningCall {
    name: String,
    kind: ToolKind,
}

/// Per-session state the mapping needs across lines.
pub struct Mapper {
    session_id: String,
    seq: Arc<AtomicU64>,
    pub(super) turn_open: bool,
    open: Option<OpenBlock>,
    blocks: u64,
    /// The newest `usage_update`, folded onto the turn's own `TurnCompleted` —
    /// the composer's ring reads it back out of the log.
    occupancy: Option<ContextWindow>,
    /// Calls opened by `tool_call` whose row has not been drawn yet.
    opening: HashMap<String, OpeningCall>,
}

impl Mapper {
    pub fn new(session_id: String, seq: Arc<AtomicU64>) -> Self {
        Self {
            session_id,
            seq,
            turn_open: false,
            open: None,
            blocks: 0,
            occupancy: None,
            opening: HashMap::new(),
        }
    }

    pub fn map(&mut self, event: OpenCodeEvent) -> Vec<AgentEvent> {
        match event {
            OpenCodeEvent::Update(update) => self.update(update),
            OpenCodeEvent::PromptDone(response) => self.prompt_done(*response),
            OpenCodeEvent::PromptFailed { message } => self.prompt_failed(message),
        }
    }

    fn update(&mut self, update: OpenCodeUpdate) -> Vec<AgentEvent> {
        match update {
            OpenCodeUpdate::AgentMessageChunk { content } => self.chunk(BlockType::Text, content.text()),
            OpenCodeUpdate::AgentThoughtChunk { content } => self.chunk(BlockType::Thinking, content.text()),

            // Held rather than drawn: the opening line carries the tool's name
            // and no arguments, and a row drawn now has no subject beside it.
            OpenCodeUpdate::ToolCall {
                tool_call_id,
                title,
                kind,
            } => {
                let mut out = self.ensure_turn();
                out.extend(self.close_open());
                let name = title.filter(|t| !t.is_empty()).unwrap_or_else(|| kind.name().to_string());
                self.opening.insert(tool_call_id, OpeningCall { name, kind });
                out
            }

            OpenCodeUpdate::ToolCallUpdate {
                tool_call_id,
                status,
                kind,
                raw_input,
                content,
                raw_output,
            } => {
                let mut out = Vec::new();
                // The first update with a status past `pending` carries the
                // whole input, so that is where the row is drawn. A call that
                // closes with no `in_progress` before it is drawn on its close.
                if status.is_some_and(|s| s != ToolStatus::Pending) {
                    if let Some(call) = self.opening.remove(&tool_call_id) {
                        out.extend(self.ensure_turn());
                        out.extend(self.close_open());
                        let kind = kind.unwrap_or(call.kind);
                        out.push(self.event(AgentEventPayload::ToolCallStarted {
                            call_id: tool_call_id.clone(),
                            tool_type: tool_type(&call.name, kind),
                            input: tool_input(raw_input),
                            name: call.name,
                            raw_input: None,
                            // Left unset so the row draws its subject off the
                            // input, which is what OpenCode's title says too.
                            title: None,
                        }));
                    }
                }

                let Some(status) = status.filter(|s| s.is_final()) else {
                    return out;
                };

                let closing: String = content
                    .iter()
                    .filter_map(|c| match c {
                        ToolContent::Content { content } => content.text(),
                        _ => None,
                    })
                    .collect();
                let has_diff = content.iter().any(|c| matches!(c, ToolContent::Diff));

                out.push(self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: tool_call_id,
                    result: ToolResult {
                        text: result_text(raw_output.as_ref(), closing, has_diff),
                        is_error: status == ToolStatus::Failed,
                        structured: None,
                        exit_code: raw_output.as_ref().and_then(RawOutput::exit_code).map(|c| c as i32),
                        duration_ms: None,
                        images: Vec::new(),
                    },
                }));
                // The model reads the result next.
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            OpenCodeUpdate::UsageUpdate { used, size } => {
                if used > 0 && size > 0 {
                    self.occupancy = Some(ContextWindow {
                        used_tokens: used,
                        max_tokens: size,
                    });
                }
                Vec::new()
            }

            // Read by the read loop: a command list is a fact about the picker,
            // not a transcript event.
            OpenCodeUpdate::AvailableCommandsUpdate { .. }
            | OpenCodeUpdate::ConfigOptionUpdate
            | OpenCodeUpdate::CurrentModeUpdate
            | OpenCodeUpdate::UserMessageChunk
            | OpenCodeUpdate::SessionInfoUpdate
            | OpenCodeUpdate::Plan
            | OpenCodeUpdate::Unknown => Vec::new(),
        }
    }

    fn chunk(&mut self, kind: BlockType, text: Option<&str>) -> Vec<AgentEvent> {
        let Some(text) = text else {
            return Vec::new();
        };
        let mut out = self.ensure_turn();
        out.extend(self.stream(kind, text));
        out
    }

    fn prompt_done(&mut self, response: PromptResponse) -> Vec<AgentEvent> {
        let mut out = self.close_open();

        let (status, final_text) = match response.stop_reason.as_str() {
            "refusal" => (TurnStatus::Error, Some("The model refused this prompt.".to_string())),
            "max_tokens" => (
                TurnStatus::Error,
                Some("OpenCode stopped: the model hit its output token limit.".to_string()),
            ),
            "max_turn_requests" => (
                TurnStatus::Error,
                Some("OpenCode stopped: the turn hit its request limit.".to_string()),
            ),
            // `end_turn`, and `cancelled` — the reader's own Stop. A cancelled
            // shell closes `completed` with "User aborted the command" first.
            _ => (TurnStatus::Success, None),
        };

        let usage = response.usage;
        out.push(self.turn_completed(
            status,
            Some(response.stop_reason),
            final_text,
            false,
            Some(Usage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cached_input_tokens: usage.cached_read_tokens,
                reasoning_tokens: usage.thought_tokens,
                context_window: self.occupancy,
                ..Default::default()
            }),
        ));
        out
    }

    /// `session/prompt` refused outright. The sentence is OpenCode's own.
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
            // Filled by `session::ingest`, the only layer that knows the tree.
            head: None,
        });
        self.turn_open = false;
        // A call that never got past `pending` draws nothing; its id must not
        // leak into the next turn.
        self.opening.clear();
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

    /// Appends a chunk to the open block of `kind`, opening a new one where the
    /// kind has changed.
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

    /// Mints an event the read loop needs but no update carried — a permission
    /// request arrives as a JSON-RPC *request* and never reaches [`Self::map`].
    pub fn synthesize(&self, payload: AgentEventPayload) -> AgentEvent {
        self.event(payload)
    }

    fn event(&self, payload: AgentEventPayload) -> AgentEvent {
        AgentEvent::mint(
            self.session_id.clone(),
            Harness::OpenCode,
            self.seq.fetch_add(1, Relaxed),
            None,
            None,
            payload,
        )
    }
}

/// OpenCode's tool name onto Dray's row type, ACP's kind as the fallback.
/// `task` stays `other`: OpenCode's subagent runs as a child session whose
/// lifecycle this build does not map yet, and a spawn row with no run behind it
/// would shimmer for good.
fn tool_type(name: &str, kind: ToolKind) -> ToolType {
    match name {
        "bash" => ToolType::Shell,
        "read" => ToolType::FileRead,
        "edit" | "write" | "patch" | "multiedit" => ToolType::FileEdit,
        "glob" | "grep" | "list" => ToolType::Search,
        "webfetch" | "websearch" => ToolType::Web,
        "task" => ToolType::Other,
        _ => kind.tool_type(),
    }
}

/// The call's arguments as the row draws them, always an object.
///
/// OpenCode spells its fields camelCase (`filePath`, `oldString`), and the
/// frontend's diff and summary readers take Claude Code's snake spelling, so
/// the four that matter are renamed here once rather than taught to every
/// reader.
fn tool_input(raw: Option<Value>) -> Value {
    const RENAMES: [(&str, &str); 4] = [
        ("filePath", "file_path"),
        ("oldString", "old_string"),
        ("newString", "new_string"),
        ("replaceAll", "replace_all"),
    ];
    let mut map = match raw {
        Some(Value::Object(map)) => map,
        Some(Value::Null) | None => Map::new(),
        Some(other) => return json!({ "_unparsed": other.to_string() }),
    };
    for (from, to) in RENAMES {
        if let Some(value) = map.remove(from) {
            map.insert(to.to_string(), value);
        }
    }
    Value::Object(map)
}

/// What a finished call reports: the text the model was handed, or nothing
/// for an edit, whose diff is what the row draws and whose sentence ("Edit
/// applied successfully.") restates the row.
fn result_text(raw_output: Option<&RawOutput>, closing: String, has_diff: bool) -> String {
    if has_diff {
        return String::new();
    }
    match raw_output.and_then(|r| r.output.clone()) {
        Some(output) if !output.is_empty() => output,
        _ => closing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::AgentEventPayload as P;

    const LIVE_TURN: &str = include_str!("fixtures/live_turn.jsonl");
    const CANCEL: &str = include_str!("fixtures/cancel.jsonl");
    const AUTH_ERROR: &str = include_str!("fixtures/auth_error.jsonl");

    /// Replays a capture the way the read loop does: updates for the session
    /// the capture opened, then the answer to the last prompt sent.
    fn replay(fixture: &str) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)));
        let mut out = Vec::new();
        let mut session: Option<String> = None;
        let mut prompt_ids = Vec::new();

        for line in fixture.lines() {
            if let Some(sent) = line.strip_prefix(">> ") {
                let value: Value = serde_json::from_str(sent).unwrap();
                if value["method"] == "session/prompt" {
                    prompt_ids.push(value["id"].clone());
                }
                continue;
            }
            let Some(line) = line.strip_prefix("<< ") else { continue };
            let value: Value = serde_json::from_str(line).unwrap();

            if session.is_none() {
                if let Some(id) = value.pointer("/result/sessionId").and_then(Value::as_str) {
                    session = Some(id.to_string());
                    continue;
                }
            }

            if let Some(method) = value.get("method").and_then(Value::as_str) {
                if value.get("id").is_some() {
                    continue;
                }
                let Ok(note) = super::super::parser::parse_notification(method, value["params"].clone()) else {
                    continue;
                };
                if Some(&note.session_id) != session.as_ref() {
                    continue;
                }
                out.extend(mapper.map(OpenCodeEvent::Update(note.update)));
            } else if prompt_ids.contains(&value["id"]) {
                if let Some(error) = value.get("error") {
                    let message = error["message"].as_str().unwrap_or_default().to_string();
                    out.extend(mapper.map(OpenCodeEvent::PromptFailed { message }));
                } else {
                    let response: PromptResponse = serde_json::from_value(value["result"].clone()).unwrap();
                    out.extend(mapper.map(OpenCodeEvent::PromptDone(Box::new(response))));
                }
            }
        }
        out
    }

    fn tool_starts(events: &[AgentEvent]) -> Vec<(&str, ToolType, &Value)> {
        events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallStarted {
                    name, tool_type, input, ..
                } => Some((name.as_str(), *tool_type, input)),
                _ => None,
            })
            .collect()
    }

    fn results(events: &[AgentEvent]) -> Vec<&ToolResult> {
        events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallCompleted { result, .. } => Some(result),
                _ => None,
            })
            .collect()
    }

    /// The whole lifecycle at its smallest: three calls drawn as what they are,
    /// each with the arguments the opening line lacked, and a turn closing with
    /// the ring's reading on it.
    #[test]
    fn a_live_turn_maps_to_one_exchange() {
        let events = replay(LIVE_TURN);

        assert!(matches!(events[0].payload, P::TurnStarted(_)));
        assert!(matches!(events[1].payload, P::ModelRequestStarted));

        let starts = tool_starts(&events);
        let names: Vec<(&str, ToolType)> = starts.iter().map(|(n, t, _)| (*n, *t)).collect();
        assert_eq!(
            names,
            [("bash", ToolType::Shell), ("read", ToolType::FileRead), ("edit", ToolType::FileEdit)]
        );
        // Drawn off the `in_progress` update, never the empty opening line.
        assert_eq!(starts[0].2["command"], "ls");
        // And in Claude Code's spelling, which the diff reader takes.
        assert!(starts[2].2["file_path"].as_str().unwrap().ends_with("notes.txt"));
        assert_eq!(starts[2].2["old_string"], "hello");
        assert_eq!(starts[2].2["new_string"], "goodbye");

        let results = results(&events);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].text, "notes.txt\n");
        assert_eq!(results[0].exit_code, Some(0));
        // The edit's answer is its diff, which the row draws.
        assert_eq!(results[2].text, "");

        let reply = events.iter().find_map(|e| match &e.payload {
            P::AssistantText { text, .. } => Some(text.as_str()),
            _ => None,
        });
        assert_eq!(reply, Some("done"));

        let P::TurnCompleted { usage, status, .. } = &events.last().unwrap().payload else {
            panic!("the turn closes on the prompt's reply");
        };
        assert_eq!(*status, TurnStatus::Success);
        let window = usage.as_ref().and_then(|u| u.context_window).expect("the ring's reading");
        assert_eq!(window.max_tokens, 1_000_000);
        assert!(window.used_tokens > 0);
    }

    /// Stop answers `cancelled`, a success, and the killed shell closes on its
    /// own with OpenCode's sentence. The `used: 0` the cancel reports is not
    /// an empty context.
    #[test]
    fn a_cancelled_turn_closes_cleanly_and_keeps_the_last_reading() {
        let events = replay(CANCEL);

        let P::TurnCompleted { status, stop_reason, usage, .. } = &events.last().unwrap().payload else {
            panic!("the turn closes");
        };
        assert_eq!(*status, TurnStatus::Success);
        assert_eq!(stop_reason.as_deref(), Some("cancelled"));
        assert!(usage
            .as_ref()
            .and_then(|u| u.context_window)
            .is_some_and(|w| w.used_tokens > 0));

        let shell = results(&events).into_iter().last().expect("the shell closed");
        assert!(shell.text.contains("User aborted the command"));
    }

    /// A refused prompt is a failed turn carrying OpenCode's own sentence, and
    /// a dead key is a login problem.
    #[test]
    fn a_refused_prompt_is_a_failed_turn_that_asks_for_a_login() {
        let events = replay(AUTH_ERROR);

        let P::TurnCompleted {
            status,
            final_text,
            auth_failed,
            ..
        } = &events.last().unwrap().payload
        else {
            panic!("the refusal closes a turn");
        };
        assert_eq!(*status, TurnStatus::Error);
        assert!(final_text.as_deref().unwrap().contains("API key"));
        assert!(auth_failed);
    }

    #[test]
    fn opencode_fields_take_claude_codes_spelling() {
        let input = tool_input(Some(json!({"filePath": "/a", "oldString": "x", "newString": "y", "other": 1})));
        assert_eq!(input, json!({"file_path": "/a", "old_string": "x", "new_string": "y", "other": 1}));
        assert_eq!(tool_input(None), json!({}));
    }
}
