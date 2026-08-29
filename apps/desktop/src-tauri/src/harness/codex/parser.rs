//! `codex app-server`'s wire format, typed.
//!
//! Same conventions as [`claude_code::parser`](crate::harness::claude_code::parser):
//! every enum that can grow carries `#[serde(other)]`, fields the server may
//! omit carry `#[serde(default)]`, and genuinely volatile payloads stay as
//! `Value`. A shape we have not modelled must cost one field or one line, never
//! the connection.
//!
//! One structural difference from Claude Code: the envelope arrives already
//! split into a method and a params object by [`rpc`](super::rpc), so the
//! dispatch is a function on the method string rather than a `#[serde(tag)]`
//! enum. That also means an unknown method is cheap to name in the failure log.
//!
//! Every shape here was taken from a live capture against `codex-cli
//! 0.148.0-alpha.21`, not from the README — which is wrong about the casing of
//! `sandbox` and `askForApproval`, about `turn/completed` carrying no items,
//! and about who names the options on an approval.

use serde::Deserialize;
use serde_json::Value;

/// A notification we act on, or a marker saying why we don't.
pub enum CodexEvent {
    TurnStarted(TurnNotification),
    TurnCompleted(TurnNotification),
    ItemStarted(ItemNotification),
    ItemCompleted(ItemNotification),
    /// Streamed text for an open `agentMessage` or `reasoning` item.
    Delta(DeltaNotification),
    TokenUsage(TokenUsageNotification),
    Error(ErrorNotification),
    /// Modelled on purpose and drawn as nothing.
    ///
    /// The distinction from [`Self::Unknown`] is the whole point: this build
    /// has seen the line and decided it says nothing worth a row, where an
    /// unknown one is a coverage gap. Folding them together is what turns the
    /// failure log from a signal into noise — the `tool_progress` lesson.
    Ignored,
    /// A method this build has never seen. Filed, and costs nothing else.
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnNotification {
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    #[serde(default)]
    pub status: TurnStatus,
    #[serde(default)]
    pub error: Option<TurnError>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// How a turn ended.
///
/// `Interrupted` is the user's own Stop, so it is not a failure — the mapper
/// reports it as a success carrying a stop reason, the same way Claude's
/// `aborted_*` terminal reasons are drawn as nothing.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    #[default]
    InProgress,
    Completed,
    Interrupted,
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    pub message: String,
    /// The classified cause — `ContextWindowExceeded`, `UsageLimitExceeded`,
    /// `Unauthorized`. A tagged union on the wire, kept whole because only its
    /// discriminant is read and a new variant must not cost the line.
    #[serde(default)]
    pub codex_error_info: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemNotification {
    pub thread_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    pub item: ThreadItem,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaNotification {
    #[serde(default)]
    pub turn_id: Option<String>,
    pub item_id: String,
    pub delta: String,
}

/// One unit of work inside a turn.
///
/// Only the kinds slice 1 draws are typed. Everything else lands in
/// [`Self::Other`], which is `Ignored` rather than `Unknown` — the item kinds
/// exist in the schema and we have chosen not to draw them yet.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadItem {
    /// Our own prompt, echoed back.
    ///
    /// Dropped by the mapper: Dray mints its own `UserMessage` carrying the
    /// tree baseline, the images and the issue links, none of which this
    /// carries. Drawing both would double every prompt in the transcript.
    UserMessage { id: String },
    AgentMessage {
        id: String,
        #[serde(default)]
        text: String,
        /// `commentary` for the running narration, `final_answer` for the
        /// answer. Read but not drawn — noted because nothing in Claude Code
        /// distinguishes the two, so a surface for it would be new.
        #[serde(default)]
        phase: Option<String>,
    },
    Reasoning {
        id: String,
        /// Readable summaries, which is what most OpenAI models emit.
        #[serde(default)]
        summary: Vec<String>,
        /// Raw reasoning blocks, which open-weight models emit instead.
        #[serde(default)]
        content: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    CommandExecution {
        id: String,
        #[serde(default)]
        command: String,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        status: ItemStatus,
        #[serde(default)]
        aggregated_output: Option<String>,
        #[serde(default)]
        exit_code: Option<i64>,
        #[serde(default)]
        duration_ms: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    FileChange {
        id: String,
        #[serde(default)]
        changes: Vec<FileChangeEntry>,
        #[serde(default)]
        status: ItemStatus,
    },
    /// Codex compacted the conversation. Can happen without being asked.
    ContextCompaction { id: String },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEntry {
    pub path: String,
    #[serde(default)]
    pub kind: Option<Value>,
    #[serde(default)]
    pub diff: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    #[default]
    InProgress,
    Completed,
    Failed,
    /// The user said no. Terminal, and an error as far as the row is concerned.
    Declined,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageNotification {
    #[serde(default)]
    pub turn_id: Option<String>,
    pub token_usage: TokenUsage,
}

/// Two readings of the same turn, and picking the wrong one is the trap.
///
/// Measured across a three-call turn: `total` ran 15593 → 31298 → 47083 while
/// `last` ran 15593 → 15705 → 15785. `total` sums every model call in the turn,
/// so it reports the context multiplied by the number of steps — the exact
/// thing CLAUDE.md documents about Claude's `result.usage`. **`last` is the
/// occupancy**, and `model_context_window` is the denominator, handed over
/// rather than looked up per model.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(default)]
    pub total: Option<TokenCounts>,
    #[serde(default)]
    pub last: Option<TokenCounts>,
    #[serde(default)]
    pub model_context_window: Option<u64>,
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorNotification {
    pub error: TurnError,
    /// Set when the server intends to try the same request again, which makes
    /// this a retry notice rather than a failure.
    #[serde(default)]
    pub will_retry: bool,
}

/// A server request asking the user to approve something, in the one shape both
/// kinds share.
///
/// Two methods land here — `item/commandExecution/requestApproval` and
/// `item/fileChange/requestApproval` — because what the card needs from them is
/// the same: which call is held, why, and what the server will accept as an
/// answer. Every field past the id is optional, since the two kinds carry
/// different subsets and neither is documented as stable.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// The item being held. It is the same id the mapper used as the tool
    /// call's, so the card renders against the row already on screen.
    pub item_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Set on a file-change request the agent wants a whole root for.
    #[serde(default)]
    pub grant_root: Option<String>,
    /// What the server says it will take back, in its own words — a bare string
    /// like `"accept"`, or a single-key object like
    /// `{"acceptWithExecpolicyAmendment": {…}}`.
    ///
    /// **Not in the generated schema**, which lists neither this nor the field
    /// on the command params; it is on the wire, and the capture is what proves
    /// it. Kept as raw values because the answer echoes one back untouched: a
    /// decision Dray retyped would be a decision it could get wrong.
    #[serde(default)]
    pub available_decisions: Vec<Value>,
}

/// Sorts one notification into [`CodexEvent`].
///
/// Errors only where a method we *do* act on carried params we could not read;
/// an unrecognised method is [`CodexEvent::Unknown`], not an error, so the
/// connection survives a server newer than this build.
pub fn parse_notification(method: &str, params: Value) -> Result<CodexEvent, serde_json::Error> {
    Ok(match method {
        "turn/started" => CodexEvent::TurnStarted(serde_json::from_value(params)?),
        "turn/completed" => CodexEvent::TurnCompleted(serde_json::from_value(params)?),
        "item/started" => CodexEvent::ItemStarted(serde_json::from_value(params)?),
        "item/completed" => CodexEvent::ItemCompleted(serde_json::from_value(params)?),
        "item/agentMessage/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta" => CodexEvent::Delta(serde_json::from_value(params)?),
        "thread/tokenUsage/updated" => CodexEvent::TokenUsage(serde_json::from_value(params)?),
        "error" => CodexEvent::Error(serde_json::from_value(params)?),

        // Seen, understood, drawn as nothing.
        //
        // `thread/status/changed` is a second opinion on a question
        // `StatusTracker` already answers from the turn lifecycle, and taking
        // both would let them disagree. `turn/diff/updated` is the
        // transcript-derived diff Dray's snapshot design deliberately rejects.
        // The rest are chatter with no row to draw.
        "thread/started"
        | "thread/status/changed"
        | "thread/closed"
        | "thread/archived"
        | "thread/unarchived"
        | "thread/name/updated"
        | "thread/queue/changed"
        | "turn/diff/updated"
        | "turn/plan/updated"
        | "item/reasoning/summaryPartAdded"
        | "item/commandExecution/outputDelta"
        | "item/fileChange/patchUpdated"
        | "serverRequest/resolved"
        | "account/rateLimits/updated"
        | "account/updated"
        | "mcpServer/startupStatus/updated"
        | "remoteControl/status/changed"
        | "model/safetyBuffering/updated"
        | "model/rerouted"
        | "model/verification"
        | "project/changed"
        | "skills/changed"
        | "fs/changed"
        | "configWarning"
        | "warning" => CodexEvent::Ignored,

        _ => CodexEvent::Unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The capture that settled which figure the context ring reads. If this
    /// ever asserts `total`, the ring reports several times the real occupancy
    /// and looks like a model with a much smaller window.
    #[test]
    fn last_is_occupancy_and_total_is_cumulative() {
        let params = json!({
            "threadId": "t", "turnId": "u",
            "tokenUsage": {
                "total": {"totalTokens": 47083, "inputTokens": 47000, "outputTokens": 83,
                          "cachedInputTokens": 0, "reasoningOutputTokens": 0},
                "last": {"totalTokens": 15785, "inputTokens": 15700, "outputTokens": 85,
                         "cachedInputTokens": 11008, "reasoningOutputTokens": 0},
                "modelContextWindow": 258400
            }
        });

        let CodexEvent::TokenUsage(usage) = parse_notification("thread/tokenUsage/updated", params)
            .expect("token usage should parse")
        else {
            panic!("wrong variant");
        };

        assert_eq!(usage.token_usage.last.unwrap().total_tokens, 15785);
        assert_eq!(usage.token_usage.total.unwrap().total_tokens, 47083);
        assert_eq!(usage.token_usage.model_context_window, Some(258400));
    }

    /// A method from a newer server must cost nothing. Read as an error it
    /// would file a parse failure per line, and the busiest of those fire
    /// dozens of times a turn.
    #[test]
    fn unknown_method_is_not_an_error() {
        assert!(matches!(
            parse_notification("turn/somethingNew", json!({})).unwrap(),
            CodexEvent::Unknown
        ));
    }

    /// An item kind we have not typed must not fail the line it arrived on —
    /// the turn around it still has to draw.
    #[test]
    fn unmodelled_item_kind_degrades() {
        let params = json!({
            "threadId": "t", "turnId": "u",
            "item": {"type": "webSearch", "id": "ws_1", "query": "rust"}
        });

        let CodexEvent::ItemStarted(started) =
            parse_notification("item/started", params).expect("should parse")
        else {
            panic!("wrong variant");
        };
        assert!(matches!(started.item, ThreadItem::Other));
    }

    /// Verified live: a turn the user stopped reports `interrupted`, which is
    /// not a failure and must not be drawn as one.
    #[test]
    fn interrupted_is_its_own_status() {
        let params = json!({
            "threadId": "t",
            "turn": {"id": "u", "status": "interrupted", "items": [], "error": null}
        });

        let CodexEvent::TurnCompleted(turn) =
            parse_notification("turn/completed", params).expect("should parse")
        else {
            panic!("wrong variant");
        };
        assert_eq!(turn.turn.status, TurnStatus::Interrupted);
    }

    /// A status vocabulary the server grows later reads as `Unknown` rather
    /// than failing the line that closes the turn — and a dropped
    /// `turn/completed` loses the tree snapshot the changes panel needs.
    #[test]
    fn unknown_turn_status_degrades() {
        let params = json!({"threadId": "t", "turn": {"id": "u", "status": "abandoned"}});
        let CodexEvent::TurnCompleted(turn) =
            parse_notification("turn/completed", params).expect("should parse")
        else {
            panic!("wrong variant");
        };
        assert_eq!(turn.turn.status, TurnStatus::Unknown);
    }

    /// The real shape off the wire, including the `phase` field the docs do not
    /// mention.
    #[test]
    fn agent_message_carries_phase() {
        let params = json!({
            "threadId": "t", "turnId": "u",
            "item": {"type": "agentMessage", "id": "msg_1", "text": "ok",
                     "phase": "final_answer", "memoryCitation": null}
        });

        let CodexEvent::ItemCompleted(done) =
            parse_notification("item/completed", params).expect("should parse")
        else {
            panic!("wrong variant");
        };
        match done.item {
            ThreadItem::AgentMessage { text, phase, .. } => {
                assert_eq!(text, "ok");
                assert_eq!(phase.as_deref(), Some("final_answer"));
            }
            _ => panic!("wrong item"),
        }
    }
}
