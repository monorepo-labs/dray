//! Codex's vocabulary onto Dray's.
//!
//! One notification can be several events — an `agentMessage` closing is both
//! the end of its streamed block and the committed text that supersedes it — so
//! this returns a `Vec` where [`claude_code::mapper`](crate::harness::claude_code::mapper)
//! returns an `Option`.
//!
//! Two events are synthesized rather than read, and both are noted where they
//! are minted: Codex sends no "requesting" ping and no user-message echo Dray
//! can use.

use crate::events::{
    usage::ContextWindow, AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent, FileEdit,
    SessionInfo, ToolResult, ToolType, TurnStatus, Usage,
};
use crate::harness::Harness;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use uuid::Uuid;

use super::parser::{
    CodexEvent, DeltaNotification, ErrorNotification, FileChangeEntry, ItemNotification, ItemStatus,
    ThreadItem, TokenUsageNotification, TurnNotification, TurnStatus as CodexTurnStatus,
};

/// Per-session state the mapping needs across lines.
pub struct Mapper {
    /// Dray's own id, never Codex's thread id. Every event the frontend routes
    /// is keyed on this, and the two are only joined on the index entry.
    session_id: String,
    seq: Arc<AtomicU64>,
    /// The open turn, so events inside it can name it. Codex is the first
    /// harness to give Dray this at all.
    turn_id: Option<String>,
    /// The newest occupancy reading, folded onto the turn's own
    /// `TurnCompleted` — the composer's ring reads it back out of the log, and
    /// `thread/tokenUsage/updated` is not persisted.
    occupancy: Option<ContextWindow>,
    /// Item ids currently open as a streamed block, so a delta for an item we
    /// never saw start cannot mint a block the transcript has no header for.
    open_blocks: std::collections::HashSet<String>,
}

impl Mapper {
    pub fn new(session_id: String, seq: Arc<AtomicU64>) -> Self {
        Self {
            session_id,
            seq,
            turn_id: None,
            occupancy: None,
            open_blocks: std::collections::HashSet::new(),
        }
    }

    pub fn map(&mut self, event: CodexEvent) -> Vec<AgentEvent> {
        match event {
            CodexEvent::TurnStarted(turn) => self.turn_started(turn),
            CodexEvent::TurnCompleted(turn) => self.turn_completed(turn),
            CodexEvent::ItemStarted(item) => self.item_started(item),
            CodexEvent::ItemCompleted(item) => self.item_completed(item),
            CodexEvent::Delta(delta) => self.delta(delta),
            CodexEvent::TokenUsage(usage) => self.token_usage(usage),
            CodexEvent::Error(err) => self.error(err),
            CodexEvent::Ignored | CodexEvent::Unknown => Vec::new(),
        }
    }

    fn turn_started(&mut self, turn: TurnNotification) -> Vec<AgentEvent> {
        self.turn_id = Some(turn.turn.id.clone());

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
            // Codex has no `status: requesting`. Without one minted here the
            // working indicator would fire once and never again, which is the
            // exact bug CLAUDE.md describes fixing for Claude: an indicator
            // that could only ever describe a turn's *first* wait.
            self.event(AgentEventPayload::ModelRequestStarted),
        ]
    }

    fn turn_completed(&mut self, turn: TurnNotification) -> Vec<AgentEvent> {
        let usage = self.occupancy.take().map(|window| Usage {
            context_window: Some(window),
            ..Default::default()
        });

        let (status, stop_reason, final_text) = match turn.turn.status {
            // The user's own Stop. Reported as a success carrying a reason
            // nothing draws, the same way Claude's `aborted_*` are: telling a
            // reader their own interrupt failed is noise.
            CodexTurnStatus::Interrupted => {
                (TurnStatus::Success, Some("interrupted".to_string()), None)
            }
            CodexTurnStatus::Failed => (
                TurnStatus::Error,
                turn.turn
                    .error
                    .as_ref()
                    .and_then(|e| e.codex_error_info.as_ref())
                    .map(error_kind),
                // The sentence the row draws. Codex writes a real one —
                // "You've hit your usage limit", "Not logged in" — and the
                // wire token beside it says nothing to a reader.
                turn.turn.error.as_ref().map(|e| e.message.clone()),
            ),
            _ => (TurnStatus::Success, None, None),
        };

        let event = self.event(AgentEventPayload::TurnCompleted {
            status,
            stop_reason,
            final_text,
            usage,
            duration_ms: turn.turn.duration_ms,
            // Filled by `session::ingest`, which is the only layer that knows
            // the session's tree.
            head: None,
        });

        self.turn_id = None;
        vec![event]
    }

    fn item_started(&mut self, started: ItemNotification) -> Vec<AgentEvent> {
        match started.item {
            // Dropped, and this is the one mapping that would double something
            // visible. Codex echoes our prompt back as an item; Dray already
            // minted its own carrying the tree baseline, the images and the
            // issue links, none of which the echo has.
            ThreadItem::UserMessage { .. } => Vec::new(),

            ThreadItem::AgentMessage { id, .. } => {
                self.open_blocks.insert(id.clone());
                vec![self.event(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                    block: block_ref(&id),
                    block_type: BlockType::Text,
                }))]
            }

            ThreadItem::Reasoning { id, .. } => {
                self.open_blocks.insert(id.clone());
                vec![self.event(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                    block: block_ref(&id),
                    block_type: BlockType::Thinking,
                }))]
            }

            ThreadItem::CommandExecution {
                id, command, cwd, ..
            } => {
                vec![self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id,
                    name: "shell".to_string(),
                    tool_type: ToolType::Shell,
                    input: json!({"command": command, "cwd": cwd}),
                    raw_input: None,
                    title: Some(command),
                })]
            }

            ThreadItem::FileChange { id, changes, .. } => {
                let started = self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id.clone(),
                    name: "apply_patch".to_string(),
                    tool_type: ToolType::FileEdit,
                    input: json!({"paths": changes.iter().map(|c| &c.path).collect::<Vec<_>>()}),
                    raw_input: None,
                    title: Some(edit_title(&changes)),
                });
                // `FileEdits` exists for exactly this and Claude never emits
                // one: Codex hands over a real unified diff per file, where
                // `Edit` carries only the fragment it replaced.
                let edits = self.event(AgentEventPayload::FileEdits {
                    call_id: Some(id),
                    edits: changes.iter().map(file_edit).collect(),
                });
                vec![started, edits]
            }

            ThreadItem::ContextCompaction { .. } => {
                vec![self.event(AgentEventPayload::ContextCompactionStarted)]
            }

            ThreadItem::Other => Vec::new(),
        }
    }

    fn item_completed(&mut self, done: ItemNotification) -> Vec<AgentEvent> {
        match done.item {
            ThreadItem::UserMessage { .. } | ThreadItem::Other => Vec::new(),

            ThreadItem::AgentMessage { id, text, .. } => {
                let mut out = self.close_block(&id);
                out.push(self.event(AgentEventPayload::AssistantText {
                    block: Some(block_ref(&id)),
                    text,
                }));
                out
            }

            ThreadItem::Reasoning {
                id,
                summary,
                content,
            } => {
                let mut out = self.close_block(&id);
                // Summaries where the model emits them, raw blocks where it
                // does not. A reader cannot tell the two apart and shouldn't.
                let text = if summary.is_empty() {
                    content.join("\n\n")
                } else {
                    summary.join("\n\n")
                };
                out.push(self.event(AgentEventPayload::Reasoning {
                    block: Some(block_ref(&id)),
                    // `encrypted` is the existing "reasoning happened, there is
                    // nothing to show" flag. Claude never sets it; a Codex model
                    // that reasons without emitting a summary is what it was for.
                    encrypted: text.is_empty(),
                    text,
                }));
                out
            }

            ThreadItem::CommandExecution {
                id,
                status,
                aggregated_output,
                exit_code,
                duration_ms,
                ..
            } => {
                let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: id,
                    result: ToolResult {
                        text: aggregated_output.unwrap_or_default(),
                        is_error: status != ItemStatus::Completed,
                        structured: None,
                        exit_code: exit_code.map(|code| code as i32),
                        duration_ms,
                        images: Vec::new(),
                    },
                })];
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            ThreadItem::FileChange { id, status, .. } => {
                let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: id,
                    result: ToolResult {
                        text: String::new(),
                        is_error: status != ItemStatus::Completed,
                        structured: None,
                        exit_code: None,
                        duration_ms: None,
                        images: Vec::new(),
                    },
                })];
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            ThreadItem::ContextCompaction { .. } => {
                // Codex reports no before/after counts. Every one is already
                // `Option`, so the panel drops the saving line rather than
                // drawing a wrong one.
                vec![self.event(AgentEventPayload::ContextCompacted {
                    trigger: None,
                    pre_tokens: None,
                    post_tokens: None,
                    duration_ms: None,
                })]
            }
        }
    }

    fn delta(&mut self, delta: DeltaNotification) -> Vec<AgentEvent> {
        // A delta for an item that never opened would mint a block with no
        // header. Dropped rather than guessed at: deltas are a preview, and the
        // committed item still draws the whole text.
        if !self.open_blocks.contains(&delta.item_id) {
            return Vec::new();
        }

        vec![self.event(AgentEventPayload::Delta(DeltaEvent::TextDelta {
            block: block_ref(&delta.item_id),
            text: delta.delta,
        }))]
    }

    fn token_usage(&mut self, usage: TokenUsageNotification) -> Vec<AgentEvent> {
        let counts = usage.token_usage.last;
        let window = match (counts, usage.token_usage.model_context_window) {
            // `last`, never `total`: `total` sums every model call in the turn,
            // so on a three-call turn it reads three times the real occupancy.
            (Some(counts), Some(max)) if max > 0 => Some(ContextWindow {
                used_tokens: counts.total_tokens,
                max_tokens: max,
            }),
            _ => None,
        };

        if window.is_some() {
            self.occupancy = window.clone();
        }

        vec![self.event(AgentEventPayload::UsageUpdate(Usage {
            input_tokens: counts.map(|c| c.input_tokens),
            output_tokens: counts.map(|c| c.output_tokens),
            cached_input_tokens: counts.map(|c| c.cached_input_tokens),
            reasoning_tokens: counts.map(|c| c.reasoning_output_tokens),
            total_tokens: counts.map(|c| c.total_tokens),
            context_window: window,
            ..Default::default()
        }))]
    }

    fn error(&mut self, err: ErrorNotification) -> Vec<AgentEvent> {
        if err.will_retry {
            return vec![self.event(AgentEventPayload::ApiRetry {
                // Codex reports neither an attempt number nor a ceiling, where
                // Claude carries both. Zero is the existing "unknown" for the
                // ceiling; the indicator reads it as an uncounted retry.
                attempt: 0,
                max_retries: 0,
                status: None,
                reason: err.error.codex_error_info.as_ref().map(error_kind),
            })];
        }

        vec![self.event(AgentEventPayload::Error {
            source: crate::events::ErrorSource::Harness,
            message: err.error.message,
            fatal: false,
        })]
    }

    /// Closes a streamed block, if one was open.
    ///
    /// Returns nothing when the item never opened — which happens for real: an
    /// item that completes in one frame emits no `item/started` we saw first.
    fn close_block(&mut self, item_id: &str) -> Vec<AgentEvent> {
        if !self.open_blocks.remove(item_id) {
            return Vec::new();
        }
        vec![self.event(AgentEventPayload::Delta(DeltaEvent::BlockStop {
            block: block_ref(item_id),
        }))]
    }

    /// Mints an event the read loop needs but no notification carried — a
    /// permission request, which arrives as a JSON-RPC *request* rather than a
    /// notification and so never reaches [`Self::map`].
    ///
    /// Through the same counter and the same turn id, because an event numbered
    /// outside them would sort into the transcript at the wrong place.
    pub fn synthesize(&self, payload: AgentEventPayload) -> AgentEvent {
        self.event(payload)
    }

    fn event(&self, payload: AgentEventPayload) -> AgentEvent {
        AgentEvent {
            id: Uuid::now_v7().to_string(),
            session_id: self.session_id.clone(),
            harness: Harness::Codex,
            seq: self.seq.fetch_add(1, Relaxed),
            ts: crate::events::now_rfc3339(),
            turn_id: self.turn_id.clone(),
            subagent: None,
            payload,
            raw: None,
        }
    }
}

/// Codex has no message/block split — one item is one block — so the index is
/// always zero and the item id is the message id.
fn block_ref(item_id: &str) -> BlockRef {
    BlockRef {
        message_id: item_id.to_string(),
        index: 0,
    }
}

/// The discriminant of `codexErrorInfo`, which is a string for simple causes
/// and an object for ones carrying an HTTP status.
fn error_kind(info: &serde_json::Value) -> String {
    match info {
        serde_json::Value::String(name) => name.clone(),
        serde_json::Value::Object(map) => map
            .keys()
            .next()
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    }
}

fn edit_title(changes: &[FileChangeEntry]) -> String {
    match changes {
        [] => "apply_patch".to_string(),
        [one] => one.path.clone(),
        many => format!("{} files", many.len()),
    }
}

fn file_edit(entry: &FileChangeEntry) -> FileEdit {
    FileEdit {
        path: entry.path.clone(),
        change: match entry.kind.as_ref().and_then(kind_name).as_deref() {
            Some("add") => crate::events::FileChange::Add,
            Some("delete") => crate::events::FileChange::Delete,
            _ => crate::events::FileChange::Update,
        },
        unified_diff: entry.diff.clone(),
    }
}

/// `kind` is a string for the simple cases and a tagged object for `update`,
/// which carries a move path.
fn kind_name(kind: &serde_json::Value) -> Option<String> {
    match kind {
        serde_json::Value::String(name) => Some(name.to_lowercase()),
        serde_json::Value::Object(map) => map.keys().next().map(|k| k.to_lowercase()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::codex::parser::parse_notification;
    use serde_json::json;

    fn mapper() -> Mapper {
        Mapper::new("dray-session".to_string(), Arc::new(AtomicU64::new(0)))
    }

    fn map_one(m: &mut Mapper, method: &str, params: serde_json::Value) -> Vec<AgentEvent> {
        m.map(parse_notification(method, params).expect("should parse"))
    }

    /// Codex echoes the prompt back as an item. Dray already minted its own
    /// carrying the baseline, images and issue links, so drawing this too would
    /// show every prompt twice.
    #[test]
    fn user_message_echo_is_dropped() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "turnId": "u",
                   "item": {"type": "userMessage", "id": "um_1", "content": []}}),
        );
        assert!(events.is_empty());
    }

    /// Every event inside a turn names it. Codex is the first harness to give
    /// Dray a turn id at all, and it is what scopes a row to its exchange.
    #[test]
    fn events_carry_the_open_turn_id() {
        let mut m = mapper();
        map_one(
            &mut m,
            "turn/started",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "inProgress"}}),
        );

        let events = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "turnId": "turn_1",
                   "item": {"type": "agentMessage", "id": "msg_1", "text": ""}}),
        );
        assert_eq!(events[0].turn_id.as_deref(), Some("turn_1"));

        map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "completed"}}),
        );
        let after = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t",
                   "item": {"type": "agentMessage", "id": "msg_2", "text": ""}}),
        );
        assert_eq!(after[0].turn_id, None, "the turn closed");
    }

    /// The ring reads `last` over `modelContextWindow`. Reading `total` would
    /// report three times the occupancy on a three-call turn.
    #[test]
    fn occupancy_reads_last_not_total() {
        let mut m = mapper();
        map_one(
            &mut m,
            "turn/started",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "inProgress"}}),
        );
        map_one(
            &mut m,
            "thread/tokenUsage/updated",
            json!({"threadId": "t", "turnId": "turn_1", "tokenUsage": {
                "total": {"totalTokens": 47083},
                "last": {"totalTokens": 15785},
                "modelContextWindow": 258400}}),
        );

        let closing = map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "completed"}}),
        );

        let AgentEventPayload::TurnCompleted { ref usage, .. } = closing[0].payload else {
            panic!("expected a closing turn");
        };
        let window = usage.as_ref().unwrap().context_window.as_ref().unwrap();
        assert_eq!(window.used_tokens, 15785);
        assert_eq!(window.max_tokens, 258400);
    }

    /// A stopped turn is the reader's own doing. Drawn as a failure it would
    /// put a red row under every interrupt.
    #[test]
    fn interrupted_turn_is_not_an_error() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "interrupted"}}),
        );

        let AgentEventPayload::TurnCompleted {
            ref status,
            ref stop_reason,
            ..
        } = events[0].payload
        else {
            panic!("expected a closing turn");
        };
        assert!(matches!(status, TurnStatus::Success));
        assert_eq!(stop_reason.as_deref(), Some("interrupted"));
    }

    /// A failed turn draws the harness's own sentence, never the wire token —
    /// the rule CLAUDE.md sets after `stop_sequence` was drawn instead of the
    /// message carrying the cure.
    #[test]
    fn failed_turn_draws_the_message_not_the_code() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "failed",
                   "error": {"message": "You've hit your usage limit.",
                             "codexErrorInfo": "UsageLimitExceeded"}}}),
        );

        let AgentEventPayload::TurnCompleted {
            ref final_text,
            ref stop_reason,
            ..
        } = events[0].payload
        else {
            panic!("expected a closing turn");
        };
        assert_eq!(final_text.as_deref(), Some("You've hit your usage limit."));
        assert_eq!(stop_reason.as_deref(), Some("UsageLimitExceeded"));
    }

    /// A message streams and then commits. Both have to arrive, and the
    /// committed one has to carry the same block so it supersedes the preview
    /// rather than drawing beside it.
    #[test]
    fn message_streams_then_commits_on_one_block() {
        let mut m = mapper();
        let start = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "item": {"type": "agentMessage", "id": "msg_1", "text": ""}}),
        );
        assert!(matches!(
            start[0].payload,
            AgentEventPayload::Delta(DeltaEvent::BlockStart { .. })
        ));

        let delta = map_one(
            &mut m,
            "item/agentMessage/delta",
            json!({"threadId": "t", "itemId": "msg_1", "delta": "ok"}),
        );
        assert!(matches!(
            delta[0].payload,
            AgentEventPayload::Delta(DeltaEvent::TextDelta { .. })
        ));

        let done = map_one(
            &mut m,
            "item/completed",
            json!({"threadId": "t", "item": {"type": "agentMessage", "id": "msg_1", "text": "ok"}}),
        );
        assert!(matches!(
            done[0].payload,
            AgentEventPayload::Delta(DeltaEvent::BlockStop { .. })
        ));
        match &done[1].payload {
            AgentEventPayload::AssistantText { block, text } => {
                assert_eq!(text, "ok");
                assert_eq!(block.as_ref().unwrap().message_id, "msg_1");
            }
            other => panic!("expected committed text, got {other:?}"),
        }
    }

    /// A delta for a block that never opened would draw text under no header.
    #[test]
    fn orphan_delta_is_dropped() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/agentMessage/delta",
            json!({"threadId": "t", "itemId": "never_started", "delta": "x"}),
        );
        assert!(events.is_empty());
    }

    /// Every gap between rows needs the working indicator, not just the first.
    /// Codex sends no `requesting` ping, so a tool finishing has to mint one or
    /// the indicator goes quiet for the rest of the turn.
    #[test]
    fn tool_completion_reopens_the_working_indicator() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/completed",
            json!({"threadId": "t", "item": {"type": "commandExecution", "id": "exec_1",
                   "command": "echo hi", "status": "completed",
                   "aggregatedOutput": "hi\n", "exitCode": 0}}),
        );

        assert!(matches!(
            events[0].payload,
            AgentEventPayload::ToolCallCompleted { .. }
        ));
        assert!(matches!(
            events[1].payload,
            AgentEventPayload::ModelRequestStarted
        ));
    }

    /// A declined command is a failure as far as the row is concerned — the
    /// reader said no and the tool did not run.
    #[test]
    fn declined_command_reads_as_an_error() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/completed",
            json!({"threadId": "t", "item": {"type": "commandExecution", "id": "exec_1",
                   "command": "rm -rf /", "status": "declined"}}),
        );

        let AgentEventPayload::ToolCallCompleted { ref result, .. } = events[0].payload else {
            panic!("expected a completed call");
        };
        assert!(result.is_error);
    }

    /// A file change is both a tool row and a diff. `FileEdits` is what draws
    /// the diff, and Claude never emits one — Codex hands over a real unified
    /// diff per file.
    #[test]
    fn file_change_emits_a_call_and_its_diff() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "item": {"type": "fileChange", "id": "fc_1",
                   "status": "inProgress",
                   "changes": [{"path": "src/main.rs", "kind": "add",
                                "diff": "@@ -0,0 +1 @@\n+fn main() {}"}]}}),
        );

        assert!(matches!(
            events[0].payload,
            AgentEventPayload::ToolCallStarted { .. }
        ));
        match &events[1].payload {
            AgentEventPayload::FileEdits { edits, .. } => {
                assert_eq!(edits[0].path, "src/main.rs");
                assert!(matches!(edits[0].change, crate::events::FileChange::Add));
                assert!(edits[0].unified_diff.is_some());
            }
            other => panic!("expected file edits, got {other:?}"),
        }
    }
}
