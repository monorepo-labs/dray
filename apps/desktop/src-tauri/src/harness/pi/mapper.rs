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
    usage::ContextWindow, AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent,
    ErrorSource, SessionInfo, ToolResult, ToolType, TurnStatus, Usage,
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
    /// The running model's context window, the ring's denominator. `0` until
    /// the handshake fills it, and forever on a pi that answered `get_state`
    /// with no window on its model.
    ///
    /// Shared rather than passed because the reader is running *before* the
    /// handshake it settles the answer for — nothing but a line off stdout
    /// resolves a request, so the mapper exists a moment before its window
    /// does. Shared for a second reason too: Dray respawns for a model change
    /// (`applies_model_in_place: false`) but a pi extension calling `setModel`
    /// does not, so [`super::pi`] re-reads this on `model_changed`.
    context_window: Arc<AtomicU64>,
    /// Whether a compaction has landed since the reading in `usage` was taken.
    ///
    /// A compaction *lowers* occupancy and publishes what it kept on
    /// `context_compacted`, so a turn closing after one must not re-attach the
    /// message total from before it — the ring is settled by the newest event
    /// carrying a figure, and a stale one there jumps it back to its
    /// pre-compaction level and keeps it there for the rest of the session.
    /// Claude Code's mapper clears its own tracked reading at a boundary for
    /// exactly this.
    ///
    /// Cleared by the next committed message, whose total is post-compaction
    /// and honest again.
    ///
    /// Never armed by a compaction that *aborted*: nothing left the window, so
    /// the held total still describes it — and withholding a window there
    /// leaves the reader settling on that compaction's own absent count, which
    /// blanks the gauge outright.
    compacted_since_usage: bool,
}

#[derive(Debug, Clone)]
struct Outcome {
    stop_reason: Option<String>,
    error_message: Option<String>,
}

impl Mapper {
    pub fn new(session_id: String, seq: Arc<AtomicU64>, context_window: Arc<AtomicU64>) -> Self {
        Self {
            session_id,
            seq,
            message_id: None,
            open_calls: std::collections::HashMap::new(),
            outcome: None,
            usage: None,
            context_window,
            compacted_since_usage: false,
        }
    }

    /// The slot holding the ring's denominator, for the one caller that has to
    /// write it: a model changing under a running child leaves the window
    /// describing the model that left.
    pub fn context_window(&self) -> Arc<AtomicU64> {
        self.context_window.clone()
    }

    /// Puts the ring's pair on a turn's usage: the committed message's
    /// `totalTokens` against the model's window.
    ///
    /// `totalTokens` **is** the occupancy, not a per-turn sum — it is one model
    /// call's prompt plus its answer, so the last call of a turn describes the
    /// context that turn left behind. Pinned against pi's own arithmetic in
    /// `the_turn_carries_pis_own_occupancy_figure`, which reads the
    /// `get_session_stats` answer captured beside it.
    ///
    /// Both halves must be real. A window of `0` is a pi that never said, and a
    /// count of `0` is a turn that reached no model at all — an auth failure
    /// reports zeros where pi's own reading is the system prompt alone, and a
    /// ring drawn empty there claims a fresh context rather than an unknown one.
    ///
    /// Two turns carry no reading at all rather than a wrong one, both matching
    /// what pi's own `getContextUsage` does: one that **failed or was aborted**,
    /// whose message describes a call that did not land, and one closing
    /// **after a compaction** the message predates. In both the previous
    /// reading stands, which is the safe direction — under-reporting occupancy
    /// costs nothing where over-reporting claims a context that was thrown
    /// away.
    fn with_occupancy(&self, mut usage: Usage, status: TurnStatus) -> Usage {
        let max = self.context_window.load(Relaxed);

        if self.compacted_since_usage || !matches!(status, TurnStatus::Success) {
            return usage;
        }

        if let Some(used) = usage.total_tokens.filter(|used| *used > 0 && max > 0) {
            usage.context_window = Some(ContextWindow {
                used_tokens: used,
                max_tokens: max,
            });
        }

        usage
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

                let (status, stop_reason, final_text) = match outcome {
                    Some(o) if o.stop_reason.as_deref() == Some("error") => {
                        (TurnStatus::Error, o.stop_reason, o.error_message)
                    }
                    other => (TurnStatus::Success, other.and_then(|o| o.stop_reason), None),
                };

                // Read after the verdict, since a failed turn's counts describe
                // a model call that did not land.
                let usage = self.usage.take().map(|u| self.with_occupancy(u, status));

                vec![self.event(AgentEventPayload::TurnCompleted {
                    status,
                    stop_reason,
                    auth_failed: matches!(status, TurnStatus::Error)
                        && final_text.as_deref().is_some_and(is_auth_failure),
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

            // A failed model request being tried again. It drives the retry
            // indicator, which takes the working one's place — the turn is
            // genuinely open and drawing nothing, so every working test passes,
            // but the agent is not thinking, it is waiting on a retry.
            //
            // Both counts are defaulted rather than dropped: the indicator's
            // whole message is "attempt N of M", and a retry that arrives
            // without them still has to draw something. `1` is the honest floor
            // for an attempt nobody numbered.
            PiEvent::AutoRetryStart {
                attempt,
                max_attempts,
                error_message,
            } => vec![self.event(AgentEventPayload::ApiRetry {
                // Defaulted rather than dropped: the indicator's whole message
                // is "attempt N of M", so a retry that arrives without them
                // still has to draw something, and `1` is the honest floor for
                // a count nobody sent.
                attempt: attempt.unwrap_or(1),
                max_retries: max_attempts.unwrap_or(1),
                // pi reports no HTTP status, and a cause it could not name is
                // one absence rather than two spellings of it — the same reading
                // that drops Claude Code's literal `unknown` on the way in.
                status: None,
                reason: error_message.filter(|m| !m.trim().is_empty()),
            })],

            PiEvent::CompactionStart => {
                vec![self.event(AgentEventPayload::ContextCompactionStarted)]
            }

            // Closes the indicator its start opened, always — an aborted
            // compaction and one whose shape this build cannot read both end
            // here, and either left unmapped spins the indicator forever.
            PiEvent::CompactionEnd {
                reason,
                result,
                aborted,
            } => {
                // Dropped where the compaction did not finish: the numbers
                // describe a context that was kept, and reporting a saving for
                // one that was thrown away is worse than reporting none.
                let saved = result.filter(|_| !aborted);

                // Whatever the mapper is holding describes the context a
                // compaction that *landed* has just replaced, so it must not
                // close the turn as an occupancy reading.
                //
                // Only where one landed, and the difference is the ring going
                // blank: an aborted compaction still publishes
                // `context_compacted`, whose `post_tokens` is `None`, and the
                // reader settles `used` on the newest event carrying a figure
                // — so a turn withholding its window leaves that `None` as the
                // answer and the gauge draws nothing. Nothing left the window
                // in that case anyway, so the held total is still the truth.
                self.compacted_since_usage = saved.is_some();

                vec![self.event(AgentEventPayload::ContextCompacted {
                    trigger: reason,
                    pre_tokens: saved.as_ref().and_then(|r| r.tokens_before),
                    post_tokens: saved.as_ref().and_then(|r| r.estimated_tokens_after),
                    // pi times no compaction. Absent rather than zero, which the
                    // UI would draw as one that took no time at all.
                    duration_ms: None,
                })]
            }

            // An extension threw, and pi carried on. Drawn where the rest of
            // that group is not, because nothing else on screen will say so —
            // a permission extension that throws simply stops gating, which
            // looks exactly like it working. `fatal: false` is the literal
            // truth: the session is still running, and this is the reader's
            // own tooling to fix.
            PiEvent::ExtensionError {
                extension_path,
                error,
            } => {
                let said = error.unwrap_or_else(|| "the extension failed".to_string());
                let message = match extension_path {
                    Some(path) => format!("{path}: {said}"),
                    None => said,
                };

                vec![self.event(AgentEventPayload::Error {
                    source: ErrorSource::Harness,
                    message,
                    fatal: false,
                })]
            }

            // Modelled, drawn as nothing. See `PiEvent::is_ignored` for why each
            // is here rather than left unknown.
            other if other.is_ignored() => Vec::new(),

            // Everything else is either not wired yet — approvals — or a line
            // this build has never seen. Neither draws a row, and the read loop
            // files the unknown ones.
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
            // This reading is newer than any compaction before it, so the
            // suppression that one armed is spent.
            self.compacted_since_usage = false;
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
        // No turn id: pi has no turn identifier on the wire, and Dray's
        // transcript groups by user message anyway — the reasoning Claude Code
        // already documents. No subagent: pi ships none, and one arriving
        // through an extension reaches the wire as ordinary tool calls with
        // nothing to correlate them by.
        AgentEvent::mint(
            self.session_id.clone(),
            Harness::Pi,
            self.seq.fetch_add(1, Relaxed),
            None,
            None,
            payload,
        )
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

/// Whether a failed turn died for want of a login.
///
/// Matched on **pi's own wrapper**, not on the provider's prose. Every provider
/// fails in its own words — the body of one of these is OpenAI's JSON, and xai
/// or Anthropic would put something else there — but the sentence pi puts in
/// front is pi's, and it is the same for all of them:
///
/// ```text
/// OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): {…}
/// ```
///
/// Deliberately narrow. This blocks sending, so a false positive costs the
/// reader a composer they cannot use over an error a retry would have cleared —
/// worse than the missed notice it replaces. A bare `401` would match a
/// provider that is up but refusing this one call; pi's wrapper only appears
/// when the credential itself could not be renewed.
///
/// Nothing else is matched yet, and that is a gap rather than a claim: pi can
/// also fail with no credential at all, and no capture of that exists. Widen
/// from a real one, never from a guess.
fn is_auth_failure(text: &str) -> bool {
    crate::harness::mentions_any(text, &["oauth refresh failed"])
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
        mapped_within(fixture, 0)
    }

    /// The same, on a session that learned its model's context window at the
    /// handshake — which is where the ring's denominator comes from.
    fn mapped_within(fixture: &str, context_window: u64) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new(
            "s".into(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(context_window)),
        );

        fixture
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Record>(l).expect("fixture record"))
            .filter(|r| r.dir == "out")
            .filter_map(|r| super::super::parser::parse_line(&r.line).ok())
            .flat_map(|e| mapper.map(e))
            .collect()
    }

    /// What a captured command answered, so a test can check this build's
    /// arithmetic against pi's own rather than against a number typed here.
    fn answered(fixture: &str, command: &str) -> Value {
        fixture
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Record>(l).expect("fixture record"))
            .filter(|r| r.dir == "out")
            .filter_map(|r| serde_json::from_str::<Value>(&r.line).ok())
            .find(|v| v["type"] == "response" && v["command"] == command)
            .map(|v| v["data"].clone())
            .unwrap_or_else(|| panic!("the capture has no {command} answer in it"))
    }

    const LIVE_TURN: &str = include_str!("fixtures/live_turn.jsonl");
    const EXTENSION_TOOL: &str = include_str!("fixtures/extension_tool_and_dialogs.jsonl");
    const ABORT: &str = include_str!("fixtures/abort_and_queue.jsonl");
    const FAILED: &str = include_str!("fixtures/failed_turn_live.jsonl");
    const NO_APPROVALS: &str = include_str!("fixtures/no_approvals.jsonl");

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

    /// The predicate blocks the composer, so the case that matters is the one
    /// where it must stay quiet. This is a real captured failure — an abort —
    /// and reading it as a login problem would leave the reader unable to send
    /// after pressing Stop.
    #[test]
    fn an_ordinary_failed_turn_is_not_a_login_problem() {
        let events = mapped(ABORT);

        let auth_failed = events
            .iter()
            .find_map(|e| match &e.payload {
                AgentEventPayload::TurnCompleted { auth_failed, .. } => Some(*auth_failed),
                _ => None,
            })
            .expect("the turn closed");

        assert!(!auth_failed);
    }

    /// Verbatim from a live failure: pi holding an OpenAI refresh token that
    /// Codex had already rotated. Both hold their own copy of a single-use
    /// token, so one refreshing kills the other — and the sentence pi wraps it
    /// in is the part that is pi's rather than the provider's.
    #[test]
    fn a_spent_refresh_token_reads_as_a_login_problem() {
        assert!(is_auth_failure(
            "OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401): \
             { \"error\": { \"message\": \"Your refresh token has already been used to generate \
             a new access token. Please try signing in again.\", \"code\": \
             \"refresh_token_reused\" } }"
        ));
    }

    /// Matched on pi's wrapper, never on the status code inside it. A provider
    /// that is up and refusing one call answers 401 too, and a retry clears
    /// that where a login does nothing for it.
    #[test]
    fn a_bare_provider_failure_is_left_alone() {
        assert!(!is_auth_failure("Request failed (401): rate limited"));
        assert!(!is_auth_failure("This operation was aborted"));
        assert!(!is_auth_failure("connection reset by peer"));
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

    /// The committed message's `totalTokens` **is** pi's own occupancy reading,
    /// which is the whole reason the ring needs no round trip of its own.
    ///
    /// Checked against the `get_session_stats` answer captured in the same
    /// session rather than a number written here: `contextUsage.tokens` is what
    /// pi's own UI draws, so agreeing with it is the claim being made. Two
    /// captures, one live and one stubbed, since a single-message turn would
    /// hide a sum where these each close after three model calls.
    #[test]
    fn the_turn_carries_pis_own_occupancy_figure() {
        for fixture in [LIVE_TURN, NO_APPROVALS] {
            let stats = answered(fixture, "get_session_stats");
            let occupancy = stats["contextUsage"]["tokens"]
                .as_u64()
                .expect("the capture answered with an occupancy");
            let max = stats["contextUsage"]["contextWindow"]
                .as_u64()
                .expect("the capture answered with a window");

            let window = mapped_within(fixture, max)
                .iter()
                .find_map(|e| match &e.payload {
                    AgentEventPayload::TurnCompleted { usage, .. } => {
                        usage.as_ref().and_then(|u| u.context_window)
                    }
                    _ => None,
                })
                .expect("the turn closed with a window on it");

            assert_eq!(
                window.used_tokens, occupancy,
                "the ring disagrees with pi's own arithmetic"
            );
            assert_eq!(window.max_tokens, max);
        }
    }

    /// A compaction lowers occupancy, so the message total from before it must
    /// not close the turn as a reading.
    ///
    /// The ring settles on the newest event carrying a figure. Left attached,
    /// the stale total lands *after* `context_compacted`'s own count and jumps
    /// the ring back to its pre-compaction level — where it then stays, since
    /// nothing later contradicts it. The next committed message clears the
    /// suppression, which is the ordinary case: a compaction exists to make
    /// room for a call that follows it.
    #[test]
    fn a_turn_closing_after_a_compaction_carries_no_stale_reading() {
        let mut mapper = Mapper::new(
            "s".into(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(500_000)),
        );

        feed(&mut mapper, r#"{"type":"agent_start"}"#);
        feed(
            &mut mapper,
            r#"{"type":"message_end","message":{"role":"assistant","content":[],
                "usage":{"input":180000,"output":16,"cacheRead":0,"cacheWrite":0,
                         "reasoning":0,"totalTokens":180016}}}"#,
        );
        feed(
            &mut mapper,
            r#"{"type":"compaction_end","reason":"threshold","aborted":false,
                "result":{"tokensBefore":180016,"estimatedTokensAfter":20000}}"#,
        );
        let settled = feed(&mut mapper, r#"{"type":"agent_settled"}"#);

        assert!(
            settled_usage(&settled).context_window.is_none(),
            "the ring would jump back to the context the compaction threw away"
        );
    }

    /// A compaction that *aborted* changed nothing, so the turn closing after
    /// one keeps its reading.
    ///
    /// Withholding it there does not leave the ring on its last figure — it
    /// blanks it. `context_compacted` still lands, carrying no count, and the
    /// reader settles `used` on the newest event that carries one either way,
    /// so an absent window on the turn above it makes that `None` the answer.
    #[test]
    fn an_aborted_compaction_leaves_the_reading_alone() {
        let mut mapper = Mapper::new(
            "s".into(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(500_000)),
        );

        feed(&mut mapper, r#"{"type":"agent_start"}"#);
        feed(
            &mut mapper,
            r#"{"type":"message_end","message":{"role":"assistant","content":[],
                "usage":{"input":180000,"output":16,"cacheRead":0,"cacheWrite":0,
                         "reasoning":0,"totalTokens":180016}}}"#,
        );
        feed(
            &mut mapper,
            r#"{"type":"compaction_end","reason":"threshold","aborted":true,
                "errorMessage":"Nothing to compact (session too small)"}"#,
        );
        let settled = feed(&mut mapper, r#"{"type":"agent_settled"}"#);

        let window = settled_usage(&settled)
            .context_window
            .expect("the gauge would draw nothing at all");

        assert_eq!(window.used_tokens, 180016);
    }

    /// A failed or aborted turn describes a call that did not land, so it
    /// carries no reading either — pi's own `getContextUsage` skips those
    /// messages for the same reason, and the previous reading standing is the
    /// safe direction.
    #[test]
    fn a_failed_turn_carries_no_reading() {
        let mut mapper = Mapper::new(
            "s".into(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(500_000)),
        );

        feed(&mut mapper, r#"{"type":"agent_start"}"#);
        feed(
            &mut mapper,
            r#"{"type":"message_end","message":{"role":"assistant","content":[],
                "stopReason":"error","errorMessage":"the provider gave up",
                "usage":{"input":2000,"output":8,"cacheRead":0,"cacheWrite":0,
                         "reasoning":0,"totalTokens":2008}}}"#,
        );
        let settled = feed(&mut mapper, r#"{"type":"agent_settled"}"#);

        assert!(settled_usage(&settled).context_window.is_none());
    }

    fn feed(mapper: &mut Mapper, line: &str) -> Vec<AgentEvent> {
        mapper.map(super::super::parser::parse_line(line).expect("parses"))
    }

    /// The usage riding a turn that just closed, so a test asserting about the
    /// ring cannot pass on a turn that never closed at all.
    fn settled_usage(events: &[AgentEvent]) -> Usage {
        match &events[0].payload {
            AgentEventPayload::TurnCompleted { usage, .. } => {
                usage.clone().expect("the counts still ride the turn")
            }
            other => panic!("the turn did not close: {other:?}"),
        }
    }

    /// `get_state` is what fills the denominator, and it is already the
    /// handshake — so the ring costs no round trip. Pinned because the field
    /// sits on the model rather than beside it, and reading the wrong level
    /// leaves a window of `0`, which draws as no ring at all.
    #[test]
    fn the_handshake_answer_carries_the_window() {
        let state = answered(NO_APPROVALS, "get_state");

        assert!(state["model"]["contextWindow"]
            .as_u64()
            .is_some_and(|w| w > 0));
    }

    /// Neither half may be guessed at. A window of `0` is a pi that never said;
    /// a count of `0` is a turn that reached no model — an auth failure reports
    /// zeros where the real occupancy is the system prompt — and a ring drawn
    /// there claims a fresh context rather than an unknown one.
    #[test]
    fn a_missing_half_draws_no_ring() {
        let counted = Usage {
            total_tokens: Some(2139),
            ..Usage::default()
        };
        let mapper = |window: u64| {
            Mapper::new(
                "s".into(),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(window)),
            )
        };

        assert!(mapper(0)
            .with_occupancy(counted.clone(), TurnStatus::Success)
            .context_window
            .is_none());
        assert!(mapper(500_000)
            .with_occupancy(
                Usage {
                    total_tokens: Some(0),
                    ..Usage::default()
                },
                TurnStatus::Success,
            )
            .context_window
            .is_none());
        assert!(mapper(500_000)
            .with_occupancy(Usage::default(), TurnStatus::Success)
            .context_window
            .is_none());
        assert!(mapper(500_000)
            .with_occupancy(counted, TurnStatus::Success)
            .context_window
            .is_some());
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

    fn map_one(line: &str) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new(
            "s".into(),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(0)),
        );
        mapper.map(super::super::parser::parse_line(line).expect("parses"))
    }

    /// A retry drives the indicator that already exists for one.
    ///
    /// The field names are the whole risk and none of them would fail loudly:
    /// pi sends `maxAttempts` where Claude Code sends `maxRetries`, and
    /// `#[serde(default)]` turns a misspelling into an absent count, so the
    /// indicator would read "attempt 1 of 1" on every retry instead of
    /// breaking. Taken from pi's own `agent-session.d.ts`, pinned here.
    #[test]
    fn a_retry_carries_its_count_and_the_cause_pi_named() {
        let events = map_one(
            r#"{"type":"auto_retry_start","attempt":3,"maxAttempts":10,
                "delayMs":2000,"errorMessage":"overloaded"}"#,
        );

        let [event] = &events[..] else {
            panic!("one retry, one row: {events:?}");
        };
        assert!(matches!(
            &event.payload,
            AgentEventPayload::ApiRetry {
                attempt: 3,
                max_retries: 10,
                status: None,
                reason: Some(cause),
            } if cause == "overloaded"
        ));
    }

    /// A retry that named nothing still draws, because the count is the message.
    #[test]
    fn a_retry_with_no_numbers_still_says_something() {
        let events = map_one(r#"{"type":"auto_retry_start"}"#);

        assert!(matches!(
            events[0].payload,
            AgentEventPayload::ApiRetry {
                attempt: 1,
                max_retries: 1,
                reason: None,
                ..
            }
        ));
    }

    /// A compaction closes its own indicator, and the trigger rides the event.
    ///
    /// `reason` is on `compaction_end` itself, not inside `result` — reading it
    /// from the result would have left every compaction unattributed while
    /// looking like it worked.
    #[test]
    fn a_compaction_reports_what_it_saved() {
        let events = map_one(
            r#"{"type":"compaction_end","reason":"threshold","aborted":false,
                "result":{"summary":"…","firstKeptEntryId":"e1",
                          "tokensBefore":120000,"estimatedTokensAfter":18000}}"#,
        );

        let [event] = &events[..] else {
            panic!("one boundary, one row: {events:?}");
        };
        assert!(matches!(
            &event.payload,
            AgentEventPayload::ContextCompacted {
                trigger: Some(reason),
                pre_tokens: Some(120000),
                post_tokens: Some(18000),
                duration_ms: None,
            } if reason == "threshold"
        ));
    }

    /// An aborted compaction closes the indicator and reports no saving.
    ///
    /// Both halves matter. Left unmapped the indicator spins forever, and the
    /// numbers describe a context that was thrown away — reporting a saving for
    /// one is worse than reporting none.
    #[test]
    fn an_aborted_compaction_still_closes_and_claims_nothing() {
        let events = map_one(
            r#"{"type":"compaction_end","reason":"manual","aborted":true,
                "result":{"tokensBefore":120000,"estimatedTokensAfter":18000}}"#,
        );

        assert!(matches!(
            events[0].payload,
            AgentEventPayload::ContextCompacted {
                pre_tokens: None,
                post_tokens: None,
                ..
            }
        ));
    }

    /// An extension that throws gets a row, because nothing else would say so.
    ///
    /// A permission extension that fails simply stops gating, which looks
    /// exactly like it working — and `fatal: false` is the literal truth, since
    /// pi carries on and so does the session.
    #[test]
    fn an_extension_that_throws_is_drawn_and_is_not_fatal() {
        let events = map_one(
            r#"{"type":"extension_error","extensionPath":"/e/gate.js",
                "event":"tool_call","error":"boom"}"#,
        );

        let [event] = &events[..] else {
            panic!("one failure, one row: {events:?}");
        };
        let AgentEventPayload::Error { message, fatal, .. } = &event.payload else {
            panic!("expected an error row: {:?}", event.payload);
        };

        assert!(message.contains("/e/gate.js"), "{message}");
        assert!(message.contains("boom"), "{message}");
        assert!(!fatal, "the session is still running");
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
