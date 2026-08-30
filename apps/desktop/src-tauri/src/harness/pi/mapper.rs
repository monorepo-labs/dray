//! pi's typed events → Dray's [`AgentEvent`] vocabulary.
//!
//! Three facts shape everything here, and all three come from PI-PLAN.md §2 and
//! §9.
//!
//! **pi has three nested lifecycles and only the outer one is Dray's turn.**
//! `agent_start` … `agent_settled` is one prompt; `turn_start`/`turn_end` is one
//! *model call*, of which a tool-using prompt has several. Reading Dray's turn
//! off the inner pair would end the turn at the first tool call and reopen it a
//! moment later, which draws as the session finishing and restarting itself.
//!
//! **`agent_end` is not the boundary either.** pi may retry after it, so only
//! `agent_settled` closes the turn — and that line landed in pi 0.80.6, which is
//! why an older CLI leaves a turn open forever.
//!
//! **Nothing on the wire is identified.** No thread id, no turn id, no message
//! id, no block id. `contentIndex` within one streaming message is the whole of
//! pi's correlation, so [`BlockRef::message_id`] has to be minted here — one id
//! per assistant message, so two messages in one turn cannot collide on index
//! `0`.

use crate::events::{
    AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent, SessionInfo, ToolResult,
    ToolType, TurnStatus, Usage,
};
use crate::harness::Harness;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use uuid::Uuid;

use super::parser::{AssistantEvent, ContentBlock, PiEvent, PiMessage};

/// What pi calls the tools it ships, folded onto Dray's vocabulary.
///
/// Unknown names read as [`ToolType::Other`] rather than being guessed at: an
/// extension may register a tool under any name, and a wrong `tool_type` draws
/// the wrong row — a shell card for a file read, say — where `Other` draws a
/// plain one that is merely less specific.
fn tool_type(name: &str) -> ToolType {
    match name {
        "bash" | "shell" | "powershell" => ToolType::Shell,
        "read" | "cat" => ToolType::FileRead,
        "edit" | "write" | "apply_patch" => ToolType::FileEdit,
        "glob" | "grep" | "find" | "ls" => ToolType::Search,
        "web_search" | "web_fetch" => ToolType::Web,
        _ => ToolType::Other,
    }
}

pub struct Mapper {
    session_id: String,
    seq: Arc<AtomicU64>,
    /// The assistant message being streamed, minted on `message_start`.
    ///
    /// pi identifies messages by nothing at all, so without this every message
    /// in a turn would stream under the same `BlockRef` and the second one's
    /// blocks would land on the first one's previews.
    message_id: Option<String>,
    /// Which `contentIndex` values are open as a tool call, and the tool id
    /// each carries.
    ///
    /// `toolcall_start` names the tool id; `toolcall_delta` does not, carrying
    /// only the index. Without this the argument fragments could not be
    /// attributed to the call they belong to.
    open_calls: std::collections::HashMap<u32, String>,
    /// The stop reason and sentence from the newest committed assistant
    /// message, held until `agent_settled` closes the turn.
    ///
    /// pi has no error *event*: a failed turn is an assistant message carrying
    /// `stopReason: "error"` and the whole sentence in `errorMessage`, and that
    /// sentence is the only place the cure is named.
    outcome: Option<Outcome>,
    /// Token counts off the newest committed assistant message.
    ///
    /// Not from the streaming frames beside them: `usage` rides every
    /// `message_update` and is **all zeros on a real provider** for the whole
    /// run. Reading those would draw a ring that never fills.
    usage: Option<Usage>,
}

#[derive(Debug, Clone)]
struct Outcome {
    stop_reason: Option<String>,
    error_message: Option<String>,
}

impl Mapper {
    pub fn new(session_id: String, seq: Arc<AtomicU64>) -> Self {
        Self {
            session_id,
            seq,
            message_id: None,
            open_calls: std::collections::HashMap::new(),
            outcome: None,
            usage: None,
        }
    }

    pub fn map(&mut self, event: PiEvent) -> Vec<AgentEvent> {
        match event {
            PiEvent::AgentStart => {
                // A fresh run, so last run's verdict must not survive into it —
                // a turn that fails and is prompted again would otherwise
                // report the old failure a second time.
                self.outcome = None;
                self.usage = None;
                vec![self.event(AgentEventPayload::TurnStarted(SessionInfo::default()))]
            }

            // Deliberately nothing. pi may still retry after this, so closing
            // the turn here reopens it on the next attempt.
            PiEvent::AgentEnd => Vec::new(),

            PiEvent::AgentSettled => {
                let outcome = self.outcome.take();
                let usage = self.usage.take();

                let (status, stop_reason, final_text) = match outcome {
                    Some(o) if o.stop_reason.as_deref() == Some("error") => {
                        (TurnStatus::Error, o.stop_reason, o.error_message)
                    }
                    other => (TurnStatus::Success, other.and_then(|o| o.stop_reason), None),
                };

                vec![self.event(AgentEventPayload::TurnCompleted {
                    status,
                    stop_reason,
                    // Never claimed for pi. Its providers each fail in their
                    // own words, so there is no one sentence to recognise —
                    // and there is nothing to offer if we did, since pi has no
                    // login command: credentials come from the environment or
                    // from `pi config`. The prose still reaches the reader on
                    // the failed-turn row, which is the half that matters.
                    auth_failed: false,
                    final_text,
                    usage,
                    duration_ms: None,
                    // The session layer freezes this: only it knows the cwd to
                    // snapshot.
                    head: None,
                })]
            }

            // One model call inside the run. Dray's transcript groups by user
            // message, so these draw nothing — the turn they sit inside is the
            // one the reader sees.
            PiEvent::TurnStart | PiEvent::TurnEnd { .. } => Vec::new(),

            PiEvent::MessageStart { message } => match message {
                // Minted per message so two in one turn cannot collide on
                // `contentIndex` 0.
                PiMessage::Assistant { .. } => {
                    self.message_id = Some(Uuid::now_v7().to_string());
                    self.open_calls.clear();
                    Vec::new()
                }
                // The prompt Dray itself sent, echoed back, and the tool result
                // `tool_execution_end` already reported. Both are second copies
                // of what the app already knows.
                _ => Vec::new(),
            },

            PiEvent::MessageEnd { message } => self.committed(message),

            PiEvent::MessageUpdate {
                assistant_message_event,
            } => self.streamed(assistant_message_event),

            PiEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
            } => vec![self.event(AgentEventPayload::ToolCallStarted {
                call_id: tool_call_id,
                tool_type: tool_type(&tool_name),
                name: tool_name,
                input: if args.is_object() {
                    args
                } else {
                    Value::Object(Default::default())
                },
                raw_input: None,
                title: None,
            })],

            PiEvent::ToolExecutionEnd {
                tool_call_id,
                result,
                is_error,
                ..
            } => vec![self.event(AgentEventPayload::ToolCallCompleted {
                call_id: tool_call_id,
                result: ToolResult {
                    text: flatten_content(&result),
                    is_error,
                    structured: Some(result),
                    exit_code: None,
                    duration_ms: None,
                    images: Vec::new(),
                },
            })],

            // Modelled, drawn as nothing. See `PiEvent::is_ignored` for why each
            // is here rather than left unknown.
            other if other.is_ignored() => Vec::new(),

            // Everything else is either not wired yet — approvals, compaction,
            // retries — or a line this build has never seen. Neither draws a
            // row, and the read loop files the unknown ones.
            _ => Vec::new(),
        }
    }

    /// A committed message. This wins over whatever the deltas accumulated, the
    /// same bargain Claude Code's `assistant` event makes.
    fn committed(&mut self, message: PiMessage) -> Vec<AgentEvent> {
        let PiMessage::Assistant {
            content,
            stop_reason,
            error_message,
            usage,
            ..
        } = message
        else {
            // A user or toolResult echo. Dropped: the app sent one and already
            // reported the other.
            return Vec::new();
        };

        // Held rather than emitted: the turn is not over — pi may make several
        // model calls, and only the last one's verdict is the turn's.
        self.outcome = Some(Outcome {
            stop_reason,
            error_message,
        });
        if let Some(u) = usage {
            self.usage = Some(Usage {
                input_tokens: Some(u.input),
                output_tokens: Some(u.output),
                cached_input_tokens: Some(u.cache_read),
                cache_write_tokens: Some(u.cache_write),
                reasoning_tokens: Some(u.reasoning),
                total_tokens: Some(u.total_tokens),
                ..Usage::default()
            });
        }

        let message_id = self.message_id.clone();
        let mut out = Vec::new();

        for (index, block) in content.into_iter().enumerate() {
            let block_ref = message_id.as_ref().map(|id| BlockRef {
                message_id: id.clone(),
                index: index as u32,
            });

            match block {
                ContentBlock::Text { text } => {
                    out.push(self.event(AgentEventPayload::AssistantText {
                        block: block_ref,
                        text,
                    }));
                }
                ContentBlock::Thinking { thinking } => {
                    out.push(self.event(AgentEventPayload::Reasoning {
                        block: block_ref,
                        text: thinking,
                        encrypted: false,
                    }));
                }
                // The model *asking* for a tool. The call itself is
                // `tool_execution_start`, which is what draws the row — emitting
                // one here too would draw every call twice.
                ContentBlock::ToolCall { .. } | ContentBlock::Unknown => {}
            }
        }

        out
    }

    /// One streaming frame. A preview, superseded by the committed message.
    fn streamed(&mut self, frame: AssistantEvent) -> Vec<AgentEvent> {
        // A frame before any `message_start` has nothing to hang off. Dropping
        // it beats minting a `BlockRef` the committed message will never match,
        // which would leave a preview on screen that nothing retires.
        let Some(message_id) = self.message_id.clone() else {
            return Vec::new();
        };

        let Some(index) = frame.content_index() else {
            return Vec::new();
        };
        let block = BlockRef { message_id, index };

        let delta = match frame {
            AssistantEvent::TextStart { .. } => DeltaEvent::BlockStart {
                block,
                block_type: BlockType::Text,
            },
            AssistantEvent::ThinkingStart { .. } => DeltaEvent::BlockStart {
                block,
                block_type: BlockType::Thinking,
            },
            AssistantEvent::ToolcallStart { id, tool_name, .. } => {
                self.open_calls.insert(index, id.clone());
                DeltaEvent::BlockStart {
                    block,
                    block_type: BlockType::ToolUse {
                        id,
                        name: tool_name,
                    },
                }
            }

            AssistantEvent::TextDelta { delta, .. }
            | AssistantEvent::ThinkingDelta { delta, .. } => {
                DeltaEvent::TextDelta { block, text: delta }
            }
            AssistantEvent::ToolcallDelta { delta, .. } => DeltaEvent::InputDelta {
                block,
                partial_json: delta,
            },

            AssistantEvent::TextEnd { .. }
            | AssistantEvent::ThinkingEnd { .. }
            | AssistantEvent::ToolcallEnd { .. } => DeltaEvent::BlockStop { block },

            AssistantEvent::Unknown => return Vec::new(),
        };

        vec![self.event(AgentEventPayload::Delta(delta))]
    }

    /// Builds an event outside the wire, for the session layer's own
    /// synthesized ones.
    pub fn synthesize(&self, payload: AgentEventPayload) -> AgentEvent {
        self.event(payload)
    }

    fn event(&self, payload: AgentEventPayload) -> AgentEvent {
        AgentEvent {
            id: Uuid::now_v7().to_string(),
            session_id: self.session_id.clone(),
            harness: Harness::Pi,
            seq: self.seq.fetch_add(1, Relaxed),
            ts: crate::events::now_rfc3339(),
            // pi has no turn identifier on the wire, and Dray's transcript
            // groups by user message anyway — the reasoning Claude Code already
            // documents.
            turn_id: None,
            // pi ships no subagents. One arrives only through an extension, and
            // its work reaches the wire as ordinary tool calls with nothing to
            // correlate them by.
            subagent: None,
            payload,
            raw: None,
        }
    }
}

/// pi's tool results are `{content: [{type: "text", text: "…"}]}`. Flattened to
/// the one string [`ToolResult::text`] holds, with the whole payload kept beside
/// it in `structured`.
fn flatten_content(result: &Value) -> String {
    let Some(blocks) = result.get("content").and_then(Value::as_array) else {
        // A result shaped differently — an extension's own tool can return
        // anything. The raw JSON beats an empty row.
        return result
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| result.to_string());
    };

    blocks
        .iter()
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Record {
        dir: String,
        line: String,
    }

    fn mapped(fixture: &str) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)));

        fixture
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Record>(l).expect("fixture record"))
            .filter(|r| r.dir == "out")
            .filter_map(|r| super::super::parser::parse_line(&r.line).ok())
            .flat_map(|e| mapper.map(e))
            .collect()
    }

    const LIVE_TURN: &str = include_str!("fixtures/live_turn.jsonl");
    const EXTENSION_TOOL: &str = include_str!("fixtures/extension_tool_and_dialogs.jsonl");
    const ABORT: &str = include_str!("fixtures/abort_and_queue.jsonl");
    const FAILED: &str = include_str!("fixtures/failed_turn_live.jsonl");

    /// One prompt is one turn, however many model calls pi makes inside it.
    ///
    /// The capture has three `turn_start`/`turn_end` pairs. Reading Dray's turn
    /// off those would end it at the first tool call and reopen it, which draws
    /// as the session finishing and starting again on its own.
    #[test]
    fn three_model_calls_are_one_turn() {
        let events = mapped(LIVE_TURN);

        let started = events
            .iter()
            .filter(|e| matches!(e.payload, AgentEventPayload::TurnStarted(_)))
            .count();
        let completed = events
            .iter()
            .filter(|e| matches!(e.payload, AgentEventPayload::TurnCompleted { .. }))
            .count();

        assert_eq!(started, 1, "one prompt is one turn");
        assert_eq!(completed, 1);
    }

    /// The same run against a real pi a version later, which is the capture the
    /// spawn was wired with. A mapper that reads only the older shape draws a
    /// turn that opens and never closes — a session stuck `in_progress` with a
    /// complete transcript on screen, which reads as Dray having hung.
    #[test]
    fn a_real_0_84_turn_draws_its_answer_and_closes() {
        let events = mapped(include_str!("fixtures/live_turn_0_84.jsonl"));

        let kinds: Vec<&str> = events
            .iter()
            .map(|e| match &e.payload {
                AgentEventPayload::TurnStarted { .. } => "turn_started",
                AgentEventPayload::TurnCompleted { .. } => "turn_completed",
                AgentEventPayload::AssistantText { .. } => "assistant_text",
                AgentEventPayload::Reasoning { .. } => "reasoning",
                AgentEventPayload::ToolCallStarted { .. } => "tool_call_started",
                AgentEventPayload::ToolCallCompleted { .. } => "tool_call_completed",
                AgentEventPayload::Delta { .. } => "delta",
                _ => "other",
            })
            .collect();

        assert!(
            kinds.contains(&"turn_started") && kinds.contains(&"turn_completed"),
            "the turn never closed: {kinds:?}"
        );
        assert!(
            kinds.contains(&"assistant_text"),
            "the assistant's answer drew nothing: {kinds:?}"
        );
    }

    /// The tool rows a reader sees come from `tool_execution_*`, not from the
    /// `toolCall` block in the committed message — emitting both draws every
    /// call twice.
    #[test]
    fn each_tool_call_draws_exactly_one_row() {
        let events = mapped(LIVE_TURN);

        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match &e.payload {
                AgentEventPayload::ToolCallStarted { call_id, name, .. } => {
                    Some((call_id.clone(), name.clone()))
                }
                _ => None,
            })
            .collect();
        let completed = events
            .iter()
            .filter(|e| matches!(e.payload, AgentEventPayload::ToolCallCompleted { .. }))
            .count();

        assert_eq!(started.len(), 2, "the capture reads a file and writes one");
        assert_eq!(completed, 2);
        assert_eq!(started[0].1, "read");
        assert_eq!(started[1].1, "write");
    }

    /// The echoes are dropped. Dray sent the prompt itself and already reported
    /// the tool result, so both would be second copies of what it knows.
    #[test]
    fn the_user_and_tool_result_echoes_draw_nothing() {
        let events = mapped(LIVE_TURN);

        assert!(
            !events
                .iter()
                .any(|e| matches!(e.payload, AgentEventPayload::UserMessage { .. })),
            "pi's echo of Dray's own prompt reached the transcript"
        );
    }

    /// Every block gets a `BlockRef`, and two messages in one turn must not
    /// collide on index 0 — pi identifies messages by nothing at all, so the id
    /// is minted here.
    #[test]
    fn blocks_from_different_messages_do_not_collide() {
        let events = mapped(LIVE_TURN);

        let ids: std::collections::HashSet<_> = events
            .iter()
            .filter_map(|e| match &e.payload {
                AgentEventPayload::AssistantText { block, .. }
                | AgentEventPayload::Reasoning { block, .. } => {
                    block.as_ref().map(|b| b.message_id.clone())
                }
                _ => None,
            })
            .collect();

        assert!(
            ids.len() > 1,
            "every message shared one id, so their blocks would overwrite each other"
        );
    }

    /// A failed turn draws pi's own sentence rather than its stop reason. There
    /// is no error event on pi's wire, so `errorMessage` is the only place the
    /// cure is named — and `"error"` alone says nothing a reader can act on.
    ///
    /// Read off the abort capture rather than the failure one, because the
    /// failure one cannot close a turn at all — see below.
    #[test]
    fn a_failed_turn_carries_the_sentence_not_the_stop_reason() {
        let events = mapped(ABORT);

        let (status, final_text) = events
            .iter()
            .find_map(|e| match &e.payload {
                AgentEventPayload::TurnCompleted {
                    status, final_text, ..
                } => Some((*status, final_text.clone())),
                _ => None,
            })
            .expect("the turn closed");

        assert_eq!(status, TurnStatus::Error);
        assert_eq!(final_text.as_deref(), Some("This operation was aborted"));
    }

    /// The version problem, demonstrated rather than described.
    ///
    /// `failed_turn_live.jsonl` was captured against pi **0.74.2**, which sends
    /// `agent_end` and no `agent_settled`. So the turn opens and never closes:
    /// the session sits `in_progress` forever with a complete transcript on
    /// screen, which reads as Dray being broken rather than as a stale CLI.
    ///
    /// This is what the capability check in `binpath` is for. If this test ever
    /// starts failing because the turn *did* close, the floor can be dropped —
    /// so it is pinned here rather than left as a sentence in a doc.
    #[test]
    fn a_cli_without_agent_settled_never_closes_its_turn() {
        let events = mapped(FAILED);

        assert!(
            events
                .iter()
                .any(|e| matches!(e.payload, AgentEventPayload::TurnStarted(_))),
            "the turn never opened either, so this capture proves nothing"
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.payload, AgentEventPayload::TurnCompleted { .. })),
            "0.74.2 closed a turn without agent_settled — the version gate can go"
        );
    }

    /// The counts come off the committed message. `usage` rides every streaming
    /// frame too and is all zeros there on a real provider, so a ring fed from
    /// those would never fill.
    #[test]
    fn the_turn_reports_the_committed_token_counts() {
        let events = mapped(LIVE_TURN);

        let usage = events
            .iter()
            .find_map(|e| match &e.payload {
                AgentEventPayload::TurnCompleted { usage, .. } => usage.clone(),
                _ => None,
            })
            .expect("the turn closed with usage");

        assert!(
            usage.total_tokens.unwrap_or(0) > 0,
            "the ring would sit empty for the whole turn"
        );
    }

    /// An abort is a user's own Stop, and pi reports it as `stopReason: "error"`
    /// — the docs say `"aborted"` and it does not. Mapping it as a failure is
    /// honest here: the sentence pi gives is the one to draw.
    #[test]
    fn an_abort_closes_the_turn_rather_than_leaving_it_open() {
        let events = mapped(ABORT);

        assert!(
            events
                .iter()
                .any(|e| matches!(e.payload, AgentEventPayload::TurnCompleted { .. })),
            "the turn never closed, so the session would sit in_progress forever"
        );
    }

    /// A tool result is flattened for the row and kept whole beside it.
    #[test]
    fn a_tool_result_reads_as_text_and_keeps_its_payload() {
        let events = mapped(LIVE_TURN);

        let result = events
            .iter()
            .find_map(|e| match &e.payload {
                AgentEventPayload::ToolCallCompleted { result, .. } => Some(result.clone()),
                _ => None,
            })
            .expect("a tool completed");

        assert_eq!(result.text, "hello\nworld\n");
        assert!(result.structured.is_some());
        assert!(!result.is_error);
    }

    /// A tool an extension registered arrives as an ordinary tool call, under
    /// the name its author gave it.
    ///
    /// This is the whole of what Dray has to do to support one, and it is why
    /// there is no extension-tool code path: pi runs the tool itself and
    /// reports it on the same two lines a built-in uses, so a transcript draws
    /// it already. The capture is a probe extension registering `probe_tool`
    /// (`fixtures/extension_tool_and_dialogs.probe.js`), which is the only way
    /// to observe this — no shipped extension can be relied on to be installed.
    ///
    /// `ToolType::Other` is the honest classification and deliberately not a
    /// guess: only the author knows whether their tool edits a file, and a
    /// wrong type draws a diff viewer over something that is not a diff.
    #[test]
    fn an_extension_registered_tool_arrives_as_an_ordinary_tool_call() {
        let events = mapped(EXTENSION_TOOL);

        let (call_id, tool_type, input) = events
            .iter()
            .find_map(|e| match &e.payload {
                AgentEventPayload::ToolCallStarted {
                    call_id,
                    name,
                    tool_type,
                    input,
                    ..
                } if name == "probe_tool" => Some((call_id, tool_type, input)),
                _ => None,
            })
            .expect("the extension's own tool reaches the wire");

        assert_eq!(*tool_type, ToolType::Other);
        assert_eq!(
            input.get("note").and_then(|v| v.as_str()),
            Some("hello"),
            "its arguments ride the same field a built-in's do"
        );

        assert!(
            events.iter().any(|e| matches!(
                &e.payload,
                AgentEventPayload::ToolCallCompleted { call_id: done, .. } if done == call_id
            )),
            "and it completes like one, so the row settles"
        );
    }
}
