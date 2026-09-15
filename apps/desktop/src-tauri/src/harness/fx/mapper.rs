//! fx's ACP vocabulary onto Dray's.
//!
//! Three things are synthesized rather than read, and each is noted where it
//! is minted. fx sends no turn-started line — the turn opens when the prompt
//! request is written and closes when it answers — so `TurnStarted` is minted
//! on the first update after a prompt. It sends no "requesting" ping, so
//! `ModelRequestStarted` is minted with it and after every tool result. And a
//! thought chunk carries no id, so one thinking block runs until the next
//! non-thought update.

use crate::events::{
    usage::ContextWindow, AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent,
    SessionInfo, Subagent, ToolResult, ToolType, TurnStatus, Usage,
};
use crate::harness::{mentions_any, Harness};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

use super::parser::{
    FxEvent, PromptResponse, SessionUpdate, ToolContent, ToolKind, ToolStatus,
};

/// What fx says when the session's provider wants a login. Written to
/// under-match: a wording missed costs the login button and keeps the
/// sentence. Read off the live refusal `fx needs a Grok subscription login for
/// this model. Run fx login grok.`
const LOGIN_NEEDLES: &[&str] = &["login", "log in", "sign in", "not authenticated"];

/// fx's own diagnostics, which it emits into the agent message stream rather
/// than to stderr: context-limit truncation and skill-discovery warnings, each
/// a chunk of its own before the answer. Matched on their fixed machine
/// prefixes — a real reply opens with neither.
///
// ponytail: prefix match on the two observed shapes; a new diagnostic prefix fx
// adds later shows through until it is listed here.
fn is_fx_diagnostic(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("[context]") || t.starts_with("skill discovery warning:")
}

/// A streamed block still open, and the text it has accumulated so far — the
/// committed event supersedes the deltas, so the whole text is kept.
struct OpenBlock {
    id: String,
    kind: BlockType,
    text: String,
}

/// Per-session state the mapping needs across lines.
pub struct Mapper {
    /// Dray's own id, never fx's. Every event the frontend routes is keyed on
    /// this, and the two are only joined on the index entry.
    session_id: String,
    seq: Arc<AtomicU64>,
    /// Whether a prompt is running. Read by the read loop too: a title landing
    /// outside a turn is `session/resume` restating one Dray already holds.
    turn_open: bool,
    /// The one block streaming right now. fx interleaves thought and text
    /// chunks with no ids on the thoughts, so at most one block is open and a
    /// chunk of the other kind closes it.
    open: Option<OpenBlock>,
    /// Ids handed to thought blocks, which carry none of their own.
    thoughts: u64,
    /// The newest occupancy reading, folded onto the turn's own
    /// `TurnCompleted` — the composer's ring reads it back out of the log, and
    /// `UsageUpdate` is not persisted.
    occupancy: Option<ContextWindow>,
    /// Text a running call has streamed, by call id. A shell's stdout arrives
    /// one `in_progress` update per line and its closing update carries only
    /// fx's replay blob, so the result is what accumulated here.
    outputs: HashMap<String, String>,
    /// Message ids whose chunks are fx diagnostics, not the answer — kept so a
    /// diagnostic streamed over several chunks is dropped whole, not only its
    /// first fragment.
    suppressed: HashSet<String>,
    /// Calls that opened a subagent run, so the closing update can close it —
    /// a `tool_call_update` names an id and nothing else.
    ///
    /// The run is Dray's, not fx's: nothing about a child streams over ACP, so
    /// the spawning call *is* the whole account and the panel row holds only
    /// what that call already said. Filed anyway, since a session that
    /// delegated six times otherwise reports none of them; the chat draws the
    /// tool row rather than a link into the panel, which is what
    /// `SubagentRun.inline` is for.
    subagents: HashSet<String>,
}

impl Mapper {
    pub fn new(session_id: String, seq: Arc<AtomicU64>) -> Self {
        Self {
            session_id,
            seq,
            turn_open: false,
            open: None,
            thoughts: 0,
            occupancy: None,
            outputs: HashMap::new(),
            suppressed: HashSet::new(),
            subagents: HashSet::new(),
        }
    }

    /// Whether a prompt is running.
    pub fn turn_open(&self) -> bool {
        self.turn_open
    }

    pub fn map(&mut self, event: FxEvent) -> Vec<AgentEvent> {
        match event {
            FxEvent::Update(update) => self.update(update),
            FxEvent::PromptDone(response) => self.prompt_done(response),
            FxEvent::PromptFailed { message } => self.prompt_failed(message),
            FxEvent::Unknown => Vec::new(),
        }
    }

    fn update(&mut self, update: SessionUpdate) -> Vec<AgentEvent> {
        match update {
            SessionUpdate::AgentMessageChunk {
                message_id,
                content,
            } => {
                let Some(text) = content.text() else {
                    return Vec::new();
                };
                let id = message_id.unwrap_or_else(|| "message".to_string());
                // fx writes its own startup diagnostics — context-limit
                // truncation, skill-discovery warnings — into the message
                // stream as chunks of their own ahead of the answer. Drop them,
                // remembering the id so a diagnostic split across chunks goes
                // whole rather than leaving its tail on screen.
                if self.suppressed.contains(&id) || is_fx_diagnostic(text) {
                    self.suppressed.insert(id);
                    return Vec::new();
                }
                let mut out = self.ensure_turn();
                out.extend(self.stream(id, BlockType::Text, text));
                out
            }

            SessionUpdate::AgentThoughtChunk { content } => {
                let Some(text) = content.text() else {
                    return Vec::new();
                };
                let mut out = self.ensure_turn();
                // Thoughts carry no id, so one block runs until something else
                // arrives. A thought after a text block is a new block; a
                // thought after a thought continues it.
                let id = match &self.open {
                    Some(block) if block.kind == BlockType::Thinking => block.id.clone(),
                    _ => {
                        self.thoughts += 1;
                        format!("thought-{}", self.thoughts)
                    }
                };
                out.extend(self.stream(id, BlockType::Thinking, text));
                out
            }

            SessionUpdate::ToolCall {
                tool_call_id,
                name,
                kind,
                raw_input,
                ..
            } => {
                let mut out = self.ensure_turn();
                out.extend(self.close_open());
                let name = name.unwrap_or_else(|| kind_name(kind).to_string());
                let tool_type = tool_type(kind, &name);
                let input = tool_input(kind, raw_input);
                let task = (name == "subagent").then(|| subagent_task(&input)).flatten();
                out.push(self.event(AgentEventPayload::ToolCallStarted {
                    call_id: tool_call_id.clone(),
                    name,
                    tool_type,
                    input,
                    raw_input: None,
                    // fx's own title is a bare verb — "Writing", "Running" —
                    // and the row already conjugates the tool name. Left unset
                    // so it falls through to `toolSummary`, which draws the
                    // path or command off the input.
                    title: None,
                }));
                // fx sends no subagent lifecycle of its own, so the run is
                // minted from the call that spawned it — otherwise the panel
                // lists nothing however many children a session delegates to.
                // See [`Self::subagents`] for what this costs.
                if let Some(task) = task {
                    self.subagents.insert(tool_call_id.clone());
                    out.push(self.subagent_event(
                        &tool_call_id,
                        AgentEventPayload::SubagentStarted {
                            // Empty, and that is the honest answer: `agent_id`
                            // is the handle a stop request names, and fx
                            // publishes none for a child. Filled with the call
                            // id it would read as stoppable and the panel would
                            // offer a button whose request fx cannot take.
                            agent_id: String::new(),
                            label: SUBAGENT_LABEL.to_string(),
                            description: Some(task),
                            prompt: None,
                        },
                    ));
                }
                out
            }

            SessionUpdate::ToolCallUpdate {
                tool_call_id,
                status,
                content,
                command_result,
            } => {
                let text: String = content
                    .iter()
                    .filter_map(|c| match c {
                        ToolContent::Content { content } => content.text(),
                        _ => None,
                    })
                    .collect();

                let Some(status) = status.filter(|s| s.is_final()) else {
                    // Streamed output. Kept for the result rather than drawn
                    // — the row draws the committed result, and a shell's
                    // stdout is what these carry.
                    if !text.is_empty() {
                        self.outputs
                            .entry(tool_call_id)
                            .or_default()
                            .push_str(&text);
                    }
                    return Vec::new();
                };

                let streamed = self.outputs.remove(&tool_call_id).unwrap_or_default();
                let result = ToolResult {
                    text: result_text(streamed, text),
                    is_error: status == ToolStatus::Failed,
                    structured: None,
                    exit_code: command_result
                        .as_ref()
                        .and_then(|r| r.exit_code)
                        .map(|code| code as i32),
                    duration_ms: command_result.as_ref().and_then(|r| r.duration_ms),
                    images: Vec::new(),
                };

                let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: tool_call_id.clone(),
                    result,
                })];
                // Closes the run the spawning call opened, or the panel row
                // shimmers for the rest of the session.
                if self.subagents.remove(&tool_call_id) {
                    out.push(self.subagent_event(
                        &tool_call_id,
                        AgentEventPayload::SubagentCompleted {
                            agent_id: String::new(),
                            status: status_word(status).to_string(),
                            summary: None,
                            // fx reports no per-child usage; the turn's own
                            // figures cover the parent and child together.
                            usage: None,
                        },
                    ));
                }
                // The model reads the result next. Same reading Codex's mapper
                // makes, for the same working indicator.
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            SessionUpdate::UsageUpdate { used, size } => {
                let window = match (used, size) {
                    (Some(used), Some(size)) if size > 0 => Some(ContextWindow {
                        used_tokens: used,
                        max_tokens: size,
                    }),
                    _ => None,
                };
                if window.is_some() {
                    self.occupancy = window;
                }
                vec![self.event(AgentEventPayload::UsageUpdate(Usage {
                    context_window: window,
                    ..Default::default()
                }))]
            }

            // Read by the read loop off the parsed update, not mapped: a title
            // is a fact about the index row, not a transcript event.
            SessionUpdate::SessionInfoUpdate { .. } => Vec::new(),

            SessionUpdate::AvailableCommandsUpdate
            | SessionUpdate::UserMessageChunk
            | SessionUpdate::CurrentModeUpdate
            | SessionUpdate::Plan
            | SessionUpdate::Unknown => Vec::new(),
        }
    }

    fn prompt_done(&mut self, response: PromptResponse) -> Vec<AgentEvent> {
        let mut out = self.close_open();

        let (status, final_text) = match response.stop_reason.as_str() {
            // `refused` answered a prompt fx declined to run at all — an image
            // on a provider that takes none, on capture. Nothing else on the
            // wire says so, so the sentence is minted here.
            "refused" | "refusal" => (
                TurnStatus::Error,
                Some("fx refused this prompt.".to_string()),
            ),
            // ACP's two other terminal reasons: the turn ended with the work
            // unfinished, and fx sends no sentence saying so.
            "max_tokens" => (
                TurnStatus::Error,
                Some("fx stopped: the model hit its output token limit.".to_string()),
            ),
            "max_turn_requests" => (
                TurnStatus::Error,
                Some("fx stopped: the turn hit its request limit.".to_string()),
            ),
            // `end_turn`, and `cancelled` — the reader's own Stop, reported as
            // a success carrying a reason nothing draws, the reading Codex's
            // `interrupted` makes.
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
                cached_input_tokens: usage.cache_read_tokens,
                cache_write_tokens: usage.cache_write_tokens,
                reasoning_tokens: usage.reasoning_tokens,
                context_window: self.occupancy,
                ..Default::default()
            }),
        ));
        out
    }

    /// `session/prompt` refused outright. The sentence is fx's own and usually
    /// names its cure (`Run fx login grok.`), so it is the row's text.
    fn prompt_failed(&mut self, message: String) -> Vec<AgentEvent> {
        let mut out = self.close_open();
        let auth_failed = mentions_any(&message, LOGIN_NEEDLES);
        out.push(self.turn_completed(
            TurnStatus::Error,
            None,
            Some(message),
            auth_failed,
            None,
        ));
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
        self.outputs.clear();
        event
    }

    /// Opens the turn on its first update. fx has no turn-started line: the
    /// prompt request is the start and its answer the end, and neither passes
    /// through here — so the first thing the model says is what opens it.
    fn ensure_turn(&mut self) -> Vec<AgentEvent> {
        if self.turn_open {
            return Vec::new();
        }
        self.turn_open = true;
        vec![
            self.event(AgentEventPayload::TurnStarted(SessionInfo {
                cwd: None,
                model: None,
                harness_version: None,
                tools: Vec::new(),
                mcp_servers: Vec::new(),
                subagent_types: Vec::new(),
                settings: None,
            })),
            self.event(AgentEventPayload::ModelRequestStarted),
        ]
    }

    /// Appends a chunk to the block `id`, opening it first where it is not the
    /// one already open.
    fn stream(&mut self, id: String, kind: BlockType, text: &str) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        let same = self
            .open
            .as_ref()
            .is_some_and(|block| block.id == id && block.kind == kind);
        if !same {
            out.extend(self.close_open());
            out.push(self.event(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                block: block_ref(&id),
                block_type: kind.clone(),
            })));
            self.open = Some(OpenBlock {
                id: id.clone(),
                kind,
                text: String::new(),
            });
        }
        if let Some(block) = &mut self.open {
            block.text.push_str(text);
        }
        out.push(self.event(AgentEventPayload::Delta(DeltaEvent::TextDelta {
            block: block_ref(&id),
            text: text.to_string(),
        })));
        out
    }

    /// Closes the streaming block, committing its whole text: the deltas were
    /// a preview and this is what the transcript keeps.
    fn close_open(&mut self) -> Vec<AgentEvent> {
        let Some(block) = self.open.take() else {
            return Vec::new();
        };
        let stop = self.event(AgentEventPayload::Delta(DeltaEvent::BlockStop {
            block: block_ref(&block.id),
        }));
        let committed = match block.kind {
            BlockType::Thinking => self.event(AgentEventPayload::Reasoning {
                block: Some(block_ref(&block.id)),
                encrypted: block.text.is_empty(),
                text: block.text,
            }),
            _ => self.event(AgentEventPayload::AssistantText {
                block: Some(block_ref(&block.id)),
                text: block.text,
            }),
        };
        vec![stop, committed]
    }

    /// Mints an event the read loop needs but no update carried — a permission
    /// request arrives as a JSON-RPC *request* and never reaches [`Self::map`].
    pub fn synthesize(&self, payload: AgentEventPayload) -> AgentEvent {
        self.event(payload)
    }

    /// A lifecycle event belonging to a run rather than to the conversation.
    /// The envelope's `id` is the spawning call's, which is what the transcript
    /// correlates a run on.
    fn subagent_event(&self, call_id: &str, payload: AgentEventPayload) -> AgentEvent {
        let mut event = self.event(payload);
        event.subagent = Some(Subagent {
            id: call_id.to_string(),
            label: Some(SUBAGENT_LABEL.to_string()),
        });
        event
    }

    fn event(&self, payload: AgentEventPayload) -> AgentEvent {
        AgentEvent::mint(
            self.session_id.clone(),
            Harness::Fx,
            self.seq.fetch_add(1, Relaxed),
            // fx names no turn on the wire, and minting one here would split
            // what the reader sees as one exchange.
            None,
            None,
            payload,
        )
    }
}

/// fx has no message/block split — one message id is one block — so the index
/// is always zero.
fn block_ref(id: &str) -> BlockRef {
    BlockRef {
        message_id: id.to_string(),
        index: 0,
    }
}

/// ACP's kind onto Dray's, which is what lets a tool fx renames tomorrow still
/// draw as what it is.
///
/// The name is consulted for the two calls ACP's kinds get wrong, and each is
/// wrong in a way that costs the row something:
///
/// - `subagent` is `other`, so a run of them collapsed into "subagent 2 calls"
///   and hid the two tasks, which is the whole of what a delegated run is.
/// - `glob_files` is `read`, and a successful file read is drawn as a dead end
///   — no body, no output — since its result is the file the agent just pulled
///   into context. A glob's result is a list of matches and the only thing the
///   row has to show, so typed that way it drew nothing at all.
///
/// Keyed on the name because there is no kind to key on; a rename costs these
/// two readings and nothing else.
fn tool_type(kind: ToolKind, name: &str) -> ToolType {
    match name {
        "subagent" => return ToolType::SubagentSpawn,
        "glob_files" => return ToolType::Search,
        _ => {}
    }
    match kind {
        ToolKind::Read => ToolType::FileRead,
        ToolKind::Edit | ToolKind::Delete | ToolKind::Move => ToolType::FileEdit,
        ToolKind::Search => ToolType::Search,
        ToolKind::Execute => ToolType::Shell,
        ToolKind::Fetch => ToolType::Web,
        ToolKind::Think | ToolKind::SwitchMode | ToolKind::Other => ToolType::Other,
    }
}

/// What a delegated run is called where a label is wanted. fx names its tool
/// `subagent` and nothing on the wire names the child.
const SUBAGENT_LABEL: &str = "Subagent";

/// The brief a `subagent` call was given, which is the run's own description.
/// fx nests it under `request` beside the dispatch fields.
fn subagent_task(input: &Value) -> Option<String> {
    let task = input.get("request")?.get("task")?.as_str()?.trim();
    (!task.is_empty()).then(|| task.to_string())
}

/// How a run ended, in the vocabulary [`AgentEventPayload::SubagentCompleted`]
/// already uses.
fn status_word(status: ToolStatus) -> &'static str {
    if status == ToolStatus::Failed {
        "failed"
    } else {
        "completed"
    }
}

/// A name for a call that arrived without one — fx sends one on every capture,
/// so this is the line-survives-anything fallback.
fn kind_name(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "shell",
        ToolKind::Fetch => "fetch",
        ToolKind::Think => "think",
        ToolKind::SwitchMode => "switch_mode",
        ToolKind::Other => "tool",
    }
}

/// The call's arguments as the row draws them. Always an object.
///
/// A shell call carries fx's own dispatch fields beside the command —
/// `action`, `profile`, `yield_time_ms`, and the session's own `cwd` — which
/// gave every shell row an expanded body of machinery under one line of
/// command. The command is the whole input, and it is already the summary.
fn tool_input(kind: ToolKind, raw: Option<Value>) -> Value {
    let mut input = match raw {
        Some(Value::Object(map)) => Value::Object(map),
        Some(Value::Null) | None => json!({}),
        Some(other) => json!({ "_unparsed": other.to_string() }),
    };
    if kind == ToolKind::Execute {
        if let Some(map) = input.as_object_mut() {
            for key in ["action", "profile", "yield_time_ms", "cwd"] {
                map.remove(key);
            }
        }
    }
    input
}

/// What a finished call reports: its closing text, falling back to what it
/// streamed where the closing update carried nothing a reader wants.
///
/// The closing text wins because a streamed update is not always output. A
/// shell's is — stdout arrives line by line and its closing update carries only
/// `{"session_id":null,"state":"completed","backend":"captured",…}`, fx's own
/// bookkeeping for `fx background`, which drawn read as the command having
/// printed JSON it never printed. But `web_fetch` streams `Fetching <url>` and
/// `Converting <url>` as progress and puts the page in its closing update, so
/// preferring the stream drew the progress chatter and dropped the answer.
fn result_text(streamed: String, closing: String) -> String {
    if !closing.is_empty() && !is_replay_blob(&closing) {
        return unwrap_report(&closing).unwrap_or(closing);
    }
    streamed
}

/// fx wraps a subagent's report in `{"ok":true,"result":"…","error_code":null}`,
/// and its report is the only account of the run there is: nothing about the
/// child streams over ACP, and the whole transcript fx keeps for it lives in
/// its own session store, which Dray does not read.
///
/// Unwrapped by **shape rather than by parsing**, because fx caps tool content
/// at 200 characters and that cut usually lands mid-string — so the envelope is
/// invalid JSON exactly when it carries something worth reading, and the row
/// drew the brace and the escapes instead of the sentences. A failed report
/// (`"ok":false`) is left whole: the envelope is then the whole of what it said.
fn unwrap_report(text: &str) -> Option<String> {
    let body = text.strip_prefix(r#"{"ok":true,"result":""#)?;
    let body = body.strip_suffix(r#"","error_code":null}"#).unwrap_or(body);
    // serde does the unescaping, by making the fragment a JSON string again. A
    // cut landing inside an escape leaves a tail nothing can read, so the last
    // few bytes are dropped until it parses — `\uXXXX` and its surrogate pair
    // are the longest either can be.
    (0..=body.len())
        .rev()
        .take(13)
        .filter(|end| body.is_char_boundary(*end))
        .find_map(|end| serde_json::from_str::<String>(&format!("\"{}\"", &body[..end])).ok())
}

// ponytail: prefix sniff on fx's private blob shape; a typed field would need
// fx to promote it out of the text content first.
fn is_replay_blob(text: &str) -> bool {
    text.starts_with("{\"session_id\":") && text.contains("\"backend\":")
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::parser::ContentBlock;
    use crate::events::AgentEventPayload as P;
    use serde_json::Value;

    const LIVE_TURN: &str = include_str!("fixtures/live_turn.jsonl");
    const CANCEL: &str = include_str!("fixtures/cancel.jsonl");
    const EDIT: &str = include_str!("fixtures/edit_file.jsonl");
    const TOOLS: &str = include_str!("fixtures/tools.jsonl");

    /// Replays one capture's first prompt through the mapper: every
    /// `session/update`, then the prompt's own response.
    fn replay(fixture: &str) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)));
        let mut out = Vec::new();
        for line in fixture.lines().filter_map(|l| l.strip_prefix("<< ")) {
            let value: Value = serde_json::from_str(line).unwrap();
            let method = value.get("method").and_then(Value::as_str);
            if method == Some("session/update") {
                let event = super::super::parser::parse_notification(
                    "session/update",
                    value["params"].clone(),
                )
                .unwrap();
                out.extend(mapper.map(event));
            } else if method.is_none() && value.get("result").and_then(|r| r.get("stopReason")).is_some() {
                let response: PromptResponse =
                    serde_json::from_value(value["result"].clone()).unwrap();
                out.extend(mapper.map(FxEvent::PromptDone(response)));
                break;
            }
        }
        out
    }

    /// The whole lifecycle off the first capture: a turn opens on the first
    /// chunk, both tool calls draw and close, the text commits whole, the
    /// turn closes with an occupancy on it.
    #[test]
    fn a_live_turn_maps_to_one_exchange() {
        let events = replay(LIVE_TURN);

        assert!(matches!(events[0].payload, P::TurnStarted(_)));
        assert!(matches!(events[1].payload, P::ModelRequestStarted));

        let starts: Vec<&str> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallStarted { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(starts, ["write_file", "shell"]);

        let results: Vec<&ToolResult> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallCompleted { result, .. } => Some(result),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].text, "wrote hello.txt (5 bytes)");
        // The shell's stdout streamed through `in_progress`; its closing
        // update carried only the replay blob, which is not drawn.
        assert_eq!(results[1].text, "       5\n");
        assert_eq!(results[1].exit_code, Some(0));

        let texts: Vec<&str> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::AssistantText { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(texts.last().unwrap().starts_with("Created `hello.txt`"));

        let last = events.last().unwrap();
        let P::TurnCompleted { status, usage, .. } = &last.payload else {
            panic!("the turn closes");
        };
        assert_eq!(*status, TurnStatus::Success);
        let window = usage.as_ref().unwrap().context_window.unwrap();
        assert_eq!((window.used_tokens, window.max_tokens), (7567, 272000));
    }

    /// Stop: the shell's update comes back `failed` and the prompt answers
    /// `cancelled`, which is a success carrying that word — the reader's own
    /// interrupt is not a failed turn.
    #[test]
    fn a_cancelled_prompt_is_not_a_failure() {
        let events = replay(CANCEL);
        let last = events.last().unwrap();
        let P::TurnCompleted {
            status, stop_reason, ..
        } = &last.payload
        else {
            panic!("the turn closes");
        };
        assert_eq!(*status, TurnStatus::Success);
        assert_eq!(stop_reason.as_deref(), Some("cancelled"));
        assert!(events.iter().any(|e| matches!(
            &e.payload,
            P::ToolCallCompleted { result, .. } if result.is_error
        )));
    }

    /// The editor's sides reach the row under the keys `diff.ts` reads, and
    /// the shell's dispatch fields do not reach it at all.
    #[test]
    fn edit_input_keeps_its_sides_and_shell_input_drops_its_machinery() {
        let events = replay(EDIT);
        let edit = events
            .iter()
            .find_map(|e| match &e.payload {
                P::ToolCallStarted { name, input, tool_type, .. } if name == "edit_file" => {
                    Some((input, *tool_type))
                }
                _ => None,
            })
            .expect("an edit_file row");
        assert_eq!(edit.1, ToolType::FileEdit);
        assert!(edit.0.get("old_string").is_some());
        assert_eq!(edit.0["path"], "greet.py");

        let events = replay(LIVE_TURN);
        let shell = events
            .iter()
            .find_map(|e| match &e.payload {
                P::ToolCallStarted { name, input, .. } if name == "shell" => Some(input),
                _ => None,
            })
            .expect("a shell row");
        assert!(shell.get("command").is_some());
        assert!(shell.get("yield_time_ms").is_none());
        assert!(shell.get("cwd").is_none());
    }

    /// A thought after a thought is one block; text after it is another.
    #[test]
    fn thoughts_run_as_one_block_until_text_arrives() {
        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)));
        let thought = |t: &str| {
            FxEvent::Update(SessionUpdate::AgentThoughtChunk {
                content: ContentBlock::Text { text: t.into() },
            })
        };
        let mut out = mapper.map(thought("**Planning**"));
        out.extend(mapper.map(thought("\n\n")));
        out.extend(mapper.map(FxEvent::Update(SessionUpdate::AgentMessageChunk {
            message_id: Some("m1".into()),
            content: ContentBlock::Text { text: "Done".into() },
        })));

        let reasoning: Vec<&str> = out
            .iter()
            .filter_map(|e| match &e.payload {
                P::Reasoning { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(reasoning, ["**Planning**\n\n"]);
    }

    /// fx's own refusal sentence names its cure, so it is the row's text and
    /// the login button lights where it names a login.
    #[test]
    fn a_refused_prompt_draws_fxs_sentence() {
        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)));
        let out = mapper.map(FxEvent::PromptFailed {
            message: "fx needs a Grok subscription login for this model. Run fx login grok.".into(),
        });
        let P::TurnCompleted {
            status,
            final_text,
            auth_failed,
            ..
        } = &out[0].payload
        else {
            panic!("closes the turn");
        };
        assert_eq!(*status, TurnStatus::Error);
        assert!(final_text.as_ref().unwrap().contains("fx login grok"));
        assert!(auth_failed);
    }

    /// The tools beyond read/write/edit/shell, off one capture that runs all
    /// seven. What it pins is the split `result_text` makes: `web_fetch`
    /// streams progress and answers in its closing update, `shell` streams its
    /// stdout and closes with fx's replay blob, and each has to draw the half
    /// the other does not.
    #[test]
    fn fxs_remaining_tools_map_to_named_rows_carrying_their_answers() {
        let events = replay(TOOLS);
        let calls: Vec<(&str, ToolType)> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallStarted {
                    name, tool_type, ..
                } => Some((name.as_str(), *tool_type)),
                _ => None,
            })
            .collect();
        assert_eq!(
            calls,
            [
                ("grep_files", ToolType::Search),
                ("web_fetch", ToolType::Web),
                ("skill", ToolType::Other),
                ("capability_search", ToolType::Other),
                // ACP calls this `other`; the name is what says otherwise, and
                // it is what keeps a run of them from collapsing into a count.
                ("subagent", ToolType::SubagentSpawn),
                ("shell", ToolType::Shell),
                ("read_tool_result", ToolType::Other),
            ]
        );

        let results: Vec<&str> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallCompleted { result, .. } => Some(result.text.as_str()),
                _ => None,
            })
            .collect();
        assert!(results[0].starts_with("[grep] 1 matches"));
        // The page, not the `Fetching …`/`Converting …` the call streamed
        // while it worked.
        assert!(results[1].starts_with("Web fetch result."));
        assert!(results[2].contains("skill_content name=\"find-skills\""));
        // The subagent's own words, with fx's envelope taken off.
        assert_eq!(results[4], "hi");
        // The shell's own stdout, which arrived before a closing update
        // carrying only the replay blob.
        assert_eq!(results[5].trim(), "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40");
        assert!(results[6].starts_with("<command_output_query"));
    }

    /// A delegated run is filed as a run, so the panel lists it — fx sends no
    /// lifecycle of its own, so both ends are minted here. The envelope's id is
    /// the spawning call's, which is what the transcript correlates on, and
    /// `agent_id` is empty because fx names no handle a stop could use.
    #[test]
    fn a_subagent_call_opens_and_closes_a_run() {
        let events = replay(TOOLS);
        let lifecycle: Vec<(&str, Option<&str>)> = events
            .iter()
            .filter_map(|e| {
                let id = e.subagent.as_ref()?.id.as_str();
                match &e.payload {
                    P::SubagentStarted {
                        agent_id,
                        description,
                        ..
                    } => {
                        assert!(agent_id.is_empty(), "fx publishes no stoppable handle");
                        Some((id, description.as_deref()))
                    }
                    P::SubagentCompleted { status, .. } => Some((id, Some(status.as_str()))),
                    _ => None,
                }
            })
            .collect();

        let call_id = events
            .iter()
            .find_map(|e| match &e.payload {
                P::ToolCallStarted { name, call_id, .. } if name == "subagent" => Some(call_id),
                _ => None,
            })
            .expect("a subagent row");

        assert_eq!(
            lifecycle,
            [
                (
                    call_id.as_str(),
                    Some("Reply with exactly: hi")
                ),
                (call_id.as_str(), Some("completed")),
            ]
        );
    }

    /// The two names that outrank the kind fx sends with them. No capture here
    /// holds a glob, and the kind it arrives under is what makes the reading
    /// wrong — so the rule is pinned directly rather than through a fixture.
    #[test]
    fn two_names_outrank_the_kind_fx_sends() {
        assert_eq!(tool_type(ToolKind::Other, "subagent"), ToolType::SubagentSpawn);
        assert_eq!(tool_type(ToolKind::Read, "glob_files"), ToolType::Search);
        assert_eq!(tool_type(ToolKind::Read, "read_file"), ToolType::FileRead);
        assert_eq!(tool_type(ToolKind::Execute, "shell"), ToolType::Shell);
    }

    #[test]
    fn the_replay_blob_is_not_a_result() {
        const BLOB: &str = r#"{"session_id":null,"state":"completed","backend":"captured"}"#;
        assert_eq!(result_text(String::new(), BLOB.into()), "");
        assert_eq!(result_text(String::new(), "wrote x".into()), "wrote x");
        // The stream is what a shell says; the blob is what closes it.
        assert_eq!(result_text("out\n".into(), BLOB.into()), "out\n");
        // And the other way for a call that streams progress and answers at the
        // close — the answer wins over what it said while working.
        assert_eq!(
            result_text("Fetching x".into(), "the page".into()),
            "the page"
        );
    }

    /// A subagent's report, which is all fx says about the run. Both strings are
    /// real, out of `~/.dray/sessions`: the second is what fx's 200-character
    /// cap does to the first kind, and it is the one that has to work — an
    /// envelope short enough to parse is an envelope with nothing much in it.
    #[test]
    fn a_subagent_report_is_unwrapped_whether_or_not_the_envelope_survived() {
        assert_eq!(
            unwrap_report(r#"{"ok":true,"result":"/tmp/repo","error_code":null}"#).unwrap(),
            "/tmp/repo"
        );
        assert_eq!(
            unwrap_report(
                r#"{"ok":true,"result":"Completed successfully. All commands exited 0.\n\nCommands run:\n- `pwd`\n- `git status --short`\n- Created `report.txt`\n"#
            )
            .unwrap(),
            "Completed successfully. All commands exited 0.\n\nCommands run:\n- `pwd`\n- `git status --short`\n- Created `report.txt`\n"
        );
        // Cut inside an escape: the tail nothing can read is dropped, the rest
        // still arrives.
        assert_eq!(
            unwrap_report(r#"{"ok":true,"result":"done\"#).unwrap(),
            "done"
        );
        // A failure keeps its envelope, and anything else is left alone.
        assert!(unwrap_report(r#"{"ok":false,"result":null,"error_code":"x"}"#).is_none());
        assert!(unwrap_report("wrote hello.txt").is_none());
    }

    /// fx leaks context and skill-discovery diagnostics into the message stream
    /// as their own chunks before the answer — dropped, and the real reply is
    /// the first thing to open the turn.
    #[test]
    fn fx_diagnostics_are_dropped_and_never_open_the_turn() {
        assert!(is_fx_diagnostic(
            "[context] project instructions omitted 1 source"
        ));
        assert!(is_fx_diagnostic("skill discovery warning: candidate x skipped"));
        assert!(!is_fx_diagnostic("Hi"));
        assert!(!is_fx_diagnostic("Here is the context I gathered"));

        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)));
        let chunk = |id: &str, text: &str| SessionUpdate::AgentMessageChunk {
            message_id: Some(id.to_string()),
            content: ContentBlock::Text {
                text: text.to_string(),
            },
        };

        assert!(mapper
            .update(chunk("m1", "[context] project instructions omitted 1 source"))
            .is_empty());
        assert!(mapper
            .update(chunk("m2", "skill discovery warning: candidate x skipped"))
            .is_empty());
        // A continuation of a suppressed id stays dropped, not only its head.
        assert!(mapper
            .update(chunk("m2", " ...and another was skipped"))
            .is_empty());

        let out = mapper.update(chunk("m3", "Hi"));
        assert!(matches!(
            out.first().map(|e| &e.payload),
            Some(P::TurnStarted(_))
        ));
        assert!(out.iter().any(|e| matches!(&e.payload, P::Delta(_))));
    }
}
