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

/// Reads `null` as the type's default, which `#[serde(default)]` alone will not.
///
/// `default` answers for a key that is *absent* and does nothing for one that is
/// present and null. Codex does both on the same field: `webSearch` arrives
/// twice, and the opening one sends `"results": null` where the closing one
/// sends an array. That failed the whole line, so a search drew no row at all.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

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
    /// The model rewrote its own plan.
    PlanUpdated(PlanNotification),
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

impl CodexEvent {
    /// The thread this line belongs to, where it names one.
    ///
    /// A Codex subagent runs on its **own thread over the same connection**, so
    /// this is what tells a subagent's work apart from the main conversation's.
    /// Read once, in `Mapper::map`, rather than at each arm — a new event kind
    /// that forgets to check would put a subagent's output in the transcript.
    ///
    /// `None` means the notification names no thread, which is read as the main
    /// conversation: every line that could belong to a subagent carries one.
    pub fn thread_id(&self) -> Option<&str> {
        match self {
            Self::TurnStarted(t) | Self::TurnCompleted(t) => Some(t.thread_id.as_str()),
            Self::ItemStarted(i) | Self::ItemCompleted(i) => Some(i.thread_id.as_str()),
            Self::Delta(d) => d.thread_id.as_deref(),
            Self::TokenUsage(u) => u.thread_id.as_deref(),
            Self::PlanUpdated(p) => p.thread_id.as_deref(),
            Self::Error(_) | Self::Ignored | Self::Unknown => None,
        }
    }
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
    /// Which conversation this belongs to. A subagent streams on a thread of
    /// its own over the same connection, so without this its text lands in the
    /// main transcript as though the primary agent said it.
    #[serde(default)]
    pub thread_id: Option<String>,
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
        #[serde(default, deserialize_with = "null_as_default")]
        summary: Vec<String>,
        /// Raw reasoning blocks, which open-weight models emit instead.
        #[serde(default, deserialize_with = "null_as_default")]
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
        #[serde(default, deserialize_with = "null_as_default")]
        changes: Vec<FileChangeEntry>,
        #[serde(default)]
        status: ItemStatus,
    },
    /// The model searched the web.
    ///
    /// Arrives twice and the first one is empty — `item/started` carries
    /// `query: ""` with null `action` and `results`, and only `item/completed`
    /// has anything in it. So the started row has nothing to title itself with,
    /// the same shape Claude's half-arrived tool arguments have.
    #[serde(rename_all = "camelCase")]
    WebSearch {
        id: String,
        #[serde(default, deserialize_with = "null_as_default")]
        query: String,
        #[serde(default, deserialize_with = "null_as_default")]
        results: Vec<WebSearchResult>,
    },
    /// The model looked at an image on disk.
    ///
    /// Carries a path and no bytes, so the transcript has to copy the file the
    /// way `archive_result_images` copies decoded ones — a screenshot in `/tmp`
    /// is gone by the next boot. Captured bare (`/tmp/…`) here and as a
    /// `file://` URL in a connector-driven session, so both spellings reach us.
    ImageView { id: String, path: String },
    #[serde(rename_all = "camelCase")]
    McpToolCall {
        id: String,
        #[serde(default)]
        server: String,
        #[serde(default)]
        tool: String,
        #[serde(default)]
        status: ItemStatus,
        #[serde(default)]
        arguments: Option<Value>,
        /// Whole, because the two captures disagree about what is in it: one
        /// carries `connectorId`/`appName`/`duration{secs,nanos}`, the other
        /// `appContext`/`pluginId`/`durationMs`. Reading it field by field
        /// would pick a side.
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<Value>,
    },
    /// A subagent Codex started, and what it is doing.
    ///
    /// `agent_path` is the agent's own name (`/root/count_to_three`), not a
    /// filesystem path.
    #[serde(rename_all = "camelCase")]
    SubAgentActivity {
        id: String,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        agent_thread_id: Option<String>,
        #[serde(default)]
        agent_path: Option<String>,
    },
    /// The calls that drive subagents — `spawn_agent`, `send_message`, `wait`,
    /// `list_agents`, `interrupt_agent`, `followup_task`.
    #[serde(rename_all = "camelCase")]
    CollabAgentToolCall {
        id: String,
        #[serde(default)]
        tool: String,
        #[serde(default)]
        status: ItemStatus,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default, deserialize_with = "null_as_default")]
        receiver_thread_ids: Vec<String>,
    },
    /// A tool belonging to a connector rather than to Codex itself.
    ///
    /// **This is the second web-search route**, and the reason the native
    /// `WebSearch` above is not enough: a session running under the ChatGPT
    /// connectors searches through `extension` with `kind: "web.search"`,
    /// carrying the same `query` and `results`, while a plain `app-server`
    /// session emits `WebSearch`. Both were captured. Building to either alone
    /// draws half the searches a reader makes.
    #[serde(rename_all = "camelCase")]
    Extension {
        id: String,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        query: Option<String>,
        #[serde(default, deserialize_with = "null_as_default")]
        results: Vec<WebSearchResult>,
    },
    /// Codex compacted the conversation. Can happen without being asked.
    ContextCompaction { id: String },
    #[serde(other)]
    Other,
}

/// One hit from either search route. Every field optional — this is somebody
/// else's payload and a missing snippet must cost a line of the card, never the
/// item it arrived on.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub snippet: Option<String>,
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
    /// Load-bearing: a subagent reports its own occupancy on its own thread,
    /// and folding that into the main reading makes the context ring describe
    /// a conversation the reader is not having.
    #[serde(default)]
    pub thread_id: Option<String>,
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

/// The model's own plan for the turn, rewritten each time it changes.
///
/// `update_plan` produces **no item at all** — it is the one tool whose only
/// trace is this notification, which is why it drew nothing while every other
/// tool at least had an item kind to miss.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanNotification {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    /// The model's own sentence about why the plan looks like this.
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub plan: Vec<PlanStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    #[serde(default)]
    pub step: String,
    /// `pending`, `inProgress`, `completed` — **camelCase**, where the same
    /// tool's arguments in Codex's own rollout log spell it `in_progress`.
    /// Captured rather than guessed at, for exactly that reason.
    #[serde(default)]
    pub status: Option<String>,
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
    #[serde(default, deserialize_with = "null_as_default")]
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
        "turn/plan/updated" => CodexEvent::PlanUpdated(serde_json::from_value(params)?),

        // Seen, understood, drawn as nothing.
        //
        // Taken from the server's own `ServerNotification` enum, read out of
        // the `codex` binary rather than guessed at from what has happened to
        // fire here — a method reaches this arm the first time it arrives, not
        // the second. What is *left* out is the rule: surfaces Dray never opens
        // (`thread/realtime/*` voice, `fuzzyFileSearch/*` sessions, Windows
        // sandbox setup, `externalAgentConfig/import/*`, login completion) stay
        // `Unknown`, because one of those arriving would mean this app started
        // speaking a protocol it does not know it speaks. That is news. A
        // command execution narrating itself is not.
        //
        // `thread/status/changed` is a second opinion on a question
        // `StatusTracker` already answers from the turn lifecycle, and taking
        // both would let them disagree. `turn/diff/updated` is the
        // transcript-derived diff Dray's snapshot design deliberately rejects.
        // `rawResponse*` is the model's own wire echo of items already drawn.
        // The rest are chatter with no row to draw.
        "thread/started"
        | "thread/status/changed"
        | "thread/closed"
        | "thread/deleted"
        | "thread/archived"
        | "thread/unarchived"
        | "thread/reverted"
        | "thread/name/updated"
        | "thread/queue/changed"
        | "thread/goal/updated"
        | "thread/goal/cleared"
        | "thread/project/updated"
        | "thread/settings/updated"
        | "thread/environment/connected"
        | "thread/environment/disconnected"
        | "turn/diff/updated"
        | "turn/moderationMetadata"
        | "hook/started"
        | "hook/completed"
        | "item/plan/delta"
        | "item/reasoning/summaryPartAdded"
        | "item/commandExecution/outputDelta"
        // Codex writing into a running command's terminal, and saying so.
        // `stdin` is the bytes it sent — `Ctrl-C` where Stop interrupted the
        // command. The row already shows the command and its output, and the
        // interrupt reaches the transcript on `turn/completed`.
        | "item/commandExecution/terminalInteraction"
        | "item/fileChange/outputDelta"
        | "item/fileChange/patchUpdated"
        | "item/mcpToolCall/progress"
        // The pass that decides whether a call can be auto-approved. Its
        // outcome is already visible: the call either runs or raises a card.
        | "item/autoApprovalReview/started"
        | "item/autoApprovalReview/completed"
        | "autoApprovalReview/strictReviewRequired"
        | "rawResponseItem/completed"
        | "rawResponse/completed"
        // Connection-scoped exec, which Dray does not use — it runs commands
        // through the agent, not around it.
        | "command/exec/outputDelta"
        | "process/outputDelta"
        | "process/exited"
        | "serverRequest/resolved"
        | "account/rateLimits/updated"
        | "account/updated"
        | "mcpServer/startupStatus/updated"
        | "mcpServer/oauthLogin/completed"
        | "mcpServer/event/stream/notification"
        | "remoteControl/status/changed"
        | "model/safetyBuffering/updated"
        | "model/rerouted"
        | "model/verification"
        | "project/changed"
        | "skills/changed"
        | "fs/changed"
        | "configWarning"
        | "deprecationNotice"
        | "guardianWarning"
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

    /// Captured off the wire, and the reason the ignore list was taken from the
    /// server's own enum rather than grown one failure at a time: this fired on
    /// an ordinary Stop, so every interrupted command was filing a coverage gap
    /// against a line there is nothing to draw for.
    #[test]
    fn terminal_interaction_is_ignored_not_unknown() {
        let params = json!({
            "threadId": "t", "turnId": "u", "itemId": "exec-1",
            "processId": "38400", "stdin": "\u{3}"
        });

        assert!(matches!(
            parse_notification("item/commandExecution/terminalInteraction", params).unwrap(),
            CodexEvent::Ignored
        ));
    }

    /// The other half of that rule. A surface Dray never opens has to stay
    /// `Unknown`, because one arriving means this build is speaking a protocol
    /// it does not know it speaks — which is a gap, not chatter.
    #[test]
    fn unopened_surface_stays_unknown() {
        assert!(matches!(
            parse_notification("thread/realtime/outputAudio/delta", json!({})).unwrap(),
            CodexEvent::Unknown
        ));
    }

    /// An item kind we have not typed must not fail the line it arrived on —
    /// the turn around it still has to draw.
    #[test]
    fn unmodelled_item_kind_degrades() {
        // `imageGeneration` is in the server's own variant list and Dray draws
        // nothing for it. Pick a kind from that list rather than an invented
        // one, so this keeps testing the case that actually happens.
        let params = json!({
            "threadId": "t", "turnId": "u",
            "item": {"type": "imageGeneration", "id": "ig_1", "prompt": "a cat"}
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
