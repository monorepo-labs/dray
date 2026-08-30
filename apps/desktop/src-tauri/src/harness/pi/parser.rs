//! `pi --mode rpc`'s wire format, typed.
//!
//! Same conventions as the other two parsers: every enum that can grow carries
//! `#[serde(other)]`, fields pi may omit carry `#[serde(default)]`, and
//! genuinely volatile payloads stay as `Value`. A shape we have not modelled
//! must cost one field or one line, never the connection.
//!
//! Structurally pi sits between the other two. Claude Code is a pipe with a
//! control channel bolted on; `codex app-server` is a JSON-RPC peer. pi is a
//! peer that does **not** speak JSON-RPC: commands go in as JSON lines with an
//! optional `id`, responses come back tagged `type: "response"` carrying that
//! id, and events stream out untagged by anything but their own `type`. So one
//! `#[serde(tag = "type")]` enum covers both directions of the inbound stream,
//! which is Claude Code's shape rather than Codex's.
//!
//! Every shape here was taken from a live capture against
//! `@earendil-works/pi-coding-agent 0.84.4` under `fixtures/`, not from the
//! docs. Two things the docs would have got wrong: an aborted turn reports
//! `stopReason: "error"` with the sentence in `errorMessage`, not the
//! `"aborted"` the docs list, and `usage` on a streaming update is all zeros on
//! a real provider whatever the stub does.

use serde::Deserialize;
use serde_json::Value;

/// One line pi wrote, typed.
///
/// `Unknown` is a coverage gap and is filed as one. It is deliberately not the
/// same thing as a line we have modelled and chosen to draw nothing for — see
/// [`PiEvent::is_ignored`] — because folding the two turns the failure log from
/// a signal into noise, which is the `tool_progress` lesson from Claude Code.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PiEvent {
    /// The answer to a command, carrying the id it was sent with.
    ///
    /// Thin by design for `prompt`: pi answers `success: true` the moment the
    /// prompt is *accepted*, and its docs say failures after acceptance are
    /// reported through the event stream rather than as a second response. So
    /// awaiting this proves the prompt was taken and nothing else.
    Response(ResponseLine),

    /// Dray's turn opens. One per prompt, however many model calls it takes.
    AgentStart,
    /// **Not** a turn boundary. pi may still retry after this, so a reader that
    /// closes the turn here reopens it on the next attempt — which draws as the
    /// session finishing and then starting again on its own.
    AgentEnd,
    /// Dray's turn closes. Landed in pi 0.80.6; on an older CLI it does not
    /// exist at all and a turn never ends, which is what the version gate in
    /// [`super::pi`] exists to catch.
    AgentSettled,

    /// One model call opens. Several per `agent_start` on any turn that calls a
    /// tool.
    TurnStart,
    TurnEnd {
        #[serde(default)]
        message: Option<PiMessage>,
    },

    /// A message opens. The `user` and `toolResult` ones are echoes of what Dray
    /// already knows and are dropped by the mapper.
    MessageStart { message: PiMessage },
    /// The committed message. This wins over the deltas that preceded it, the
    /// same bargain Claude Code's `assistant` event makes.
    MessageEnd { message: PiMessage },
    /// One streaming frame. `usage` rides every one and is all zeros on a real
    /// provider until the message completes, so nothing reads it here — the
    /// context ring pulls `get_session_stats` instead.
    MessageUpdate {
        assistant_message_event: AssistantEvent,
    },

    /// A tool is about to run. Distinct from the `toolcall_end` block above it:
    /// that one is the model *asking*, this one is pi *doing*.
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    /// Partial output while a tool runs. Modelled and drawn as nothing: the
    /// tool row already shimmers for exactly as long as the call is pending,
    /// so there is no row for this to fill.
    ///
    /// Modelled rather than left to `Unknown` for the reason Claude Code's
    /// `tool_progress` was: a high-volume line nothing draws would be a third
    /// of the parse-failure file, and that file is only useful while
    /// everything in it is a real gap.
    ToolExecutionUpdate,

    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        is_error: bool,
    },

    /// The only line that travels inbound expecting an answer, and only when an
    /// extension asks. pi blocks the tool call until an `extension_ui_response`
    /// carrying this id comes back, and `ctx.ui.confirm` has no default
    /// timeout — so silence is not neutral, it stalls the session forever.
    ExtensionUiRequest {
        id: String,
        method: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        options: Option<Vec<Value>>,
    },

    /// pi confirming a setting moved, whether Dray asked or the reader typed a
    /// command into pi itself.
    ///
    /// Not read back into `Session`'s copy, deliberately, and that is the same
    /// call Claude Code's `system/init` documents: reconciling app state *from*
    /// a report quietly fails, because the app's own record is what the picker
    /// draws and what a resume replays. Modelled so the failure log stays a
    /// list of real gaps.
    ModelChanged {
        #[serde(default)]
        model: Option<String>,
    },
    ThinkingLevelChanged {
        #[serde(default)]
        level: Option<String>,
    },

    /// pi's own view of what is queued behind the running turn.
    ///
    /// Dray keeps its own queue in `Session` and draws from that, so this is
    /// pi's copy of a fact the app already owns. Modelled to keep the failure
    /// log honest; whether the two should be reconciled is PI-PLAN.md §12.
    QueueUpdate {
        #[serde(default)]
        steering: Vec<String>,
        #[serde(default)]
        follow_up: Vec<String>,
    },

    CompactionStart,
    CompactionEnd {
        #[serde(default)]
        result: Option<Value>,
    },

    /// A failed model request being tried again.
    AutoRetryStart {
        #[serde(default)]
        attempt: Option<u32>,
        #[serde(default)]
        max_retries: Option<u32>,
    },
    AutoRetryEnd,

    /// A line this build has never seen. Filed, and costs nothing else.
    #[serde(other)]
    Unknown,
}

impl PiEvent {
    /// Whether this is a line we have seen and decided says nothing worth a row.
    ///
    /// Kept apart from [`PiEvent::Unknown`] so the parse-failure log stays a
    /// list of real coverage gaps.
    pub fn is_ignored(&self) -> bool {
        matches!(
            self,
            PiEvent::AutoRetryEnd
                | PiEvent::CompactionStart
                | PiEvent::ToolExecutionUpdate
                | PiEvent::ModelChanged { .. }
                | PiEvent::ThinkingLevelChanged { .. }
                | PiEvent::QueueUpdate { .. }
        )
    }
}

/// The answer to one command.
///
/// `id` is optional because pi allows a command to be sent without one, in
/// which case the response carries none either and nothing can be matched to
/// it. Dray always sends one; this stays `Option` so a reply we did not cause
/// cannot fail the line.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseLine {
    #[serde(default)]
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default)]
    pub data: Value,
    /// The sentence, on failure. Names exactly what was wrong — `Model not
    /// found: nope/nope` — which is why `models.rs` leaves pi's model ids
    /// unvalidated and lets this report them.
    #[serde(default)]
    pub error: Option<String>,
}

/// A message, by whose turn it is.
///
/// `toolResult` is a second copy of what `tool_execution_end` already said and
/// is dropped, the same way Claude Code's replayed user lines are.
#[derive(Debug, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum PiMessage {
    User {
        #[serde(default)]
        content: Vec<ContentBlock>,
    },
    #[serde(rename_all = "camelCase")]
    Assistant {
        #[serde(default)]
        content: Vec<ContentBlock>,
        /// `toolUse` on a call, `stop` on a plain answer, `error` on a failure
        /// — **including an abort**, which the docs say arrives as `"aborted"`
        /// and does not.
        #[serde(default)]
        stop_reason: Option<String>,
        /// The whole sentence a failed turn should draw. `No API key for
        /// provider: openai-codex` is the captured one, and it is the only
        /// place the cure is named.
        #[serde(default)]
        error_message: Option<String>,
        #[serde(default)]
        usage: Option<Usage>,
        #[serde(default)]
        model: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_call_id: String,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Unknown,
}

/// One block of a message's content.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text {
        #[serde(default)]
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        arguments: Value,
    },
    #[serde(other)]
    Unknown,
}

/// A streaming frame from the assistant message being written.
///
/// Keyed by `contentIndex` within one message, which with the message itself
/// unidentified is the whole of pi's correlation — so `BlockRef.message_id` has
/// to be minted by the mapper rather than read off the wire.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AssistantEvent {
    TextStart {
        content_index: u32,
    },
    TextDelta {
        content_index: u32,
        delta: String,
    },
    TextEnd {
        content_index: u32,
        #[serde(default)]
        content: String,
    },

    ThinkingStart {
        content_index: u32,
    },
    ThinkingDelta {
        content_index: u32,
        delta: String,
    },
    ThinkingEnd {
        content_index: u32,
        #[serde(default)]
        content: String,
    },

    /// Names the tool before any argument has arrived, which is what lets the
    /// header of a tool row be drawn from the stream while its body waits for
    /// the committed block.
    ToolcallStart {
        content_index: u32,
        id: String,
        tool_name: String,
    },
    /// The raw argument JSON, in fragments. On the captured provider this
    /// arrived as **one** frame carrying the whole object — so the streaming
    /// preview works, it is simply worth 2ms here rather than the 39.5s it is
    /// worth on Claude Code. How much it buys is a property of the provider.
    ToolcallDelta {
        content_index: u32,
        delta: String,
    },
    ToolcallEnd {
        content_index: u32,
        tool_call: ToolCallBlock,
    },

    #[serde(other)]
    Unknown,
}

impl AssistantEvent {
    /// Which block within the message this frame belongs to.
    pub fn content_index(&self) -> Option<u32> {
        match self {
            AssistantEvent::TextStart { content_index }
            | AssistantEvent::TextDelta { content_index, .. }
            | AssistantEvent::TextEnd { content_index, .. }
            | AssistantEvent::ThinkingStart { content_index }
            | AssistantEvent::ThinkingDelta { content_index, .. }
            | AssistantEvent::ThinkingEnd { content_index, .. }
            | AssistantEvent::ToolcallStart { content_index, .. }
            | AssistantEvent::ToolcallDelta { content_index, .. }
            | AssistantEvent::ToolcallEnd { content_index, .. } => Some(*content_index),
            AssistantEvent::Unknown => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallBlock {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// Token counts on a committed message.
///
/// Read from the committed message alone. The same struct rides every streaming
/// frame and is **all zeros there** on a real provider — pi's own docs warn it
/// "may remain zero until completion", and the capture confirms it. Reading the
/// streaming copy would draw a ring that stays empty for the whole turn.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    #[serde(default)]
    pub reasoning: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

/// One line of pi's stdout, or `Err` with the line for the failure log.
pub fn parse_line(line: &str) -> Result<PiEvent, serde_json::Error> {
    serde_json::from_str(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixtures record **both** directions wrapped in an envelope, because
    /// pi is a peer rather than a pipe: a capture of only what pi said would
    /// lose half the protocol.
    #[derive(Deserialize)]
    struct Record {
        dir: String,
        line: String,
    }

    fn out_lines(fixture: &str) -> Vec<String> {
        fixture
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Record>(l).expect("fixture record"))
            .filter(|r| r.dir == "out")
            .map(|r| r.line)
            .collect()
    }

    const LIVE_TURN: &str = include_str!("fixtures/live_turn.jsonl");
    /// The same shape a version later, captured against pi 0.84.4 while
    /// wiring the spawn — the version floor `binpath` deliberately does not
    /// hardcode, so a corpus that is all 0.80 would say nothing about the pi a
    /// reader actually has.
    const LIVE_TURN_0_84: &str = include_str!("fixtures/live_turn_0_84.jsonl");
    const NO_APPROVALS: &str = include_str!("fixtures/no_approvals.jsonl");
    const ABORT: &str = include_str!("fixtures/abort_and_queue.jsonl");
    const FAILED_TURN: &str = include_str!("fixtures/failed_turn_live.jsonl");

    /// Every capture, so the coverage assertion below reads the whole corpus
    /// rather than the four a mapper happens to need.
    const EVERY_FIXTURE: &[(&str, &str)] = &[
        ("live_turn", LIVE_TURN),
        ("live_turn_0_84", LIVE_TURN_0_84),
        ("no_approvals", NO_APPROVALS),
        ("abort_and_queue", ABORT),
        ("failed_turn_live", FAILED_TURN),
        ("live_models", include_str!("fixtures/live_models.jsonl")),
        (
            "extension_approvals",
            include_str!("fixtures/extension_approvals.jsonl"),
        ),
        ("resume", include_str!("fixtures/resume.jsonl")),
        (
            "extension_tool_and_dialogs",
            include_str!("fixtures/extension_tool_and_dialogs.jsonl"),
        ),
        (
            "models_and_steering",
            include_str!("fixtures/models_and_steering.jsonl"),
        ),
        (
            "commands_and_clone",
            include_str!("fixtures/commands_and_clone.jsonl"),
        ),
        (
            "fork_flag_refused",
            include_str!("fixtures/fork_flag_refused.jsonl"),
        ),
        (
            "session_id_not_adopted",
            include_str!("fixtures/session_id_not_adopted.jsonl"),
        ),
    ];

    /// Every shape an extension can put on the wire when it wants the reader.
    ///
    /// `extension_ui_request` is the single channel every extension's UI goes
    /// through — there is no per-package protocol — so covering these five
    /// covers every package anyone installs, written or not yet written. Three
    /// block until they are answered (`select`, `confirm`, `input`) and two are
    /// announcements pi expects nothing back for (`notify`, `setStatus`).
    ///
    /// The distinction is the load-bearing half: an unanswered blocking request
    /// hangs the turn with nothing on screen saying why, which is why the read
    /// loop refuses what it cannot draw rather than ignoring it.
    #[test]
    fn an_extension_asks_the_reader_over_one_channel() {
        let asked: Vec<(String, Option<String>)> =
            out_lines(include_str!("fixtures/extension_tool_and_dialogs.jsonl"))
                .iter()
                .filter_map(|line| match parse_line(line) {
                    Ok(PiEvent::ExtensionUiRequest { method, title, .. }) => Some((method, title)),
                    _ => None,
                })
                .collect();

        let methods: Vec<&str> = asked.iter().map(|(m, _)| m.as_str()).collect();
        for wanted in ["setStatus", "notify", "select", "confirm", "input"] {
            assert!(
                methods.contains(&wanted),
                "the probe extension asked over {wanted}, and the parser lost it: {methods:?}"
            );
        }

        let select = asked
            .iter()
            .find(|(m, _)| m == "select")
            .expect("a select was asked");
        assert_eq!(
            select.1.as_deref(),
            Some("Allow probe_tool?"),
            "a blocking request names what it is asking, which is what a card draws"
        );
    }

    /// Every line of every capture parses, and none of them lands in `Unknown`.
    ///
    /// `Unknown` is the coverage gap, so this is the assertion that says the
    /// parser covers the wire it was written against rather than shrugging at
    /// it.
    #[test]
    fn every_captured_line_is_modelled() {
        for (name, fixture) in EVERY_FIXTURE {
            for line in out_lines(fixture) {
                let event = parse_line(&line)
                    .unwrap_or_else(|e| panic!("{name} did not parse: {e}\n  {line}"));

                assert!(
                    !matches!(event, PiEvent::Unknown),
                    "{name} carries a line this parser does not model:\n  {line}"
                );
            }
        }
    }

    /// The three nested lifecycles, in the order they have to be read.
    ///
    /// `agent_end` is not a boundary — pi may retry after it — so the count
    /// that matters is `agent_settled`. A turn read off `agent_end` reopens on
    /// the retry, which draws as a session finishing and restarting itself.
    #[test]
    fn one_prompt_is_one_agent_run_over_several_model_calls() {
        let mut starts = 0;
        let mut settled = 0;
        let mut turns = 0;

        for line in out_lines(LIVE_TURN) {
            match parse_line(&line).unwrap() {
                PiEvent::AgentStart => starts += 1,
                PiEvent::AgentSettled => settled += 1,
                PiEvent::TurnStart => turns += 1,
                _ => {}
            }
        }

        assert_eq!(starts, 1);
        assert_eq!(settled, 1);
        assert_eq!(turns, 3, "one prompt, three model calls");
    }

    /// The abort trap, and the reason this is pinned rather than trusted: the
    /// docs list `"aborted"` as a stop reason and pi does not send it. A reader
    /// matching on that word draws a user's own Stop as a failed turn.
    #[test]
    fn an_aborted_turn_reports_error_not_aborted() {
        let mut seen = None;

        for line in out_lines(ABORT) {
            if let PiEvent::MessageEnd {
                message:
                    PiMessage::Assistant {
                        stop_reason,
                        error_message,
                        ..
                    },
            } = parse_line(&line).unwrap()
            {
                if stop_reason.as_deref() == Some("error") {
                    seen = error_message;
                }
            }
        }

        assert_eq!(seen.as_deref(), Some("This operation was aborted"));
    }

    /// A failed turn has no error *event*: the sentence is on the assistant
    /// message, and it is the only place the cure is named.
    #[test]
    fn a_failed_turn_carries_its_own_sentence() {
        let mut sentence = None;

        for line in out_lines(FAILED_TURN) {
            if let PiEvent::MessageEnd {
                message: PiMessage::Assistant { error_message, .. },
            } = parse_line(&line).unwrap()
            {
                sentence = sentence.or(error_message);
            }
        }

        assert_eq!(
            sentence.as_deref(),
            Some("No API key for provider: openai-codex")
        );
    }

    /// Streaming `usage` is all zeros on a real provider for the whole run.
    ///
    /// Pinned because the stubbed captures populate it, so a reader written
    /// against those would build a context ring that never fills. The committed
    /// message is where the real counts are.
    #[test]
    fn a_committed_message_carries_the_counts_the_stream_does_not() {
        let mut committed = 0;

        for line in out_lines(LIVE_TURN) {
            if let PiEvent::MessageEnd {
                message: PiMessage::Assistant { usage: Some(u), .. },
            } = parse_line(&line).unwrap()
            {
                if u.total_tokens > 0 {
                    committed += 1;
                }
            }
        }

        assert!(committed > 0, "no committed message carried a token count");
    }

    /// A response is matched by the id it was sent with, and a failure is the
    /// same line with a sentence on it.
    #[test]
    fn a_response_carries_the_id_it_answers() {
        let ids: Vec<_> = out_lines(LIVE_TURN)
            .iter()
            .filter_map(|l| match parse_line(l) {
                Ok(PiEvent::Response(r)) => Some((r.id, r.command, r.success)),
                _ => None,
            })
            .collect();

        assert!(!ids.is_empty());
        assert!(
            ids.iter().all(|(id, _, _)| id.is_some()),
            "a response arrived with no id to match it to"
        );
    }

    /// A line pi grows later must cost one line, never the connection.
    #[test]
    fn an_unmodelled_line_reads_as_unknown_rather_than_failing() {
        let event = parse_line(r#"{"type":"something_pi_ships_later","data":{"a":1}}"#).unwrap();

        assert!(matches!(event, PiEvent::Unknown));
    }

    /// And an unmodelled *frame* costs one frame, not the message around it.
    #[test]
    fn an_unmodelled_frame_reads_as_unknown() {
        let event =
            parse_line(r#"{"type":"message_update","assistantMessageEvent":{"type":"nope"}}"#)
                .unwrap();

        match event {
            PiEvent::MessageUpdate {
                assistant_message_event,
            } => {
                assert!(matches!(assistant_message_event, AssistantEvent::Unknown));
                assert_eq!(assistant_message_event.content_index(), None);
            }
            other => panic!("expected a message_update, got {other:?}"),
        }
    }
}
