use std::format;

use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// Reads an explicit `null` as the type's default.
///
/// `#[serde(default)]` covers a field that is *absent*; it does nothing for one
/// that is present and null, which fails against any non-`Option` type. The CLI
/// does both — a synthetic message (the reply to a built-in slash command) sends
/// `"iterations": null` where an ordinary one omits the key — so a collection
/// that can arrive either way needs this as well as `default`.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClaudeCodeEvent {
    System(SystemEvent),
    StreamEvent {
        event: StreamFrame,
        session_id: String,
        parent_tool_use_id: Option<String>,
        uuid: String,
        #[serde(default)]
        ttft_ms: Option<u64>,
    },
    Assistant {
        message: AssistantMessage,
        parent_tool_use_id: Option<String>,
        session_id: String,
        uuid: String,
        #[serde(default)]
        request_id: Option<String>,
        #[serde(default)]
        subagent_type: Option<String>,
        #[serde(default)]
        task_description: Option<String>,
    },
    User {
        message: UserMessage,
        parent_tool_use_id: Option<String>,
        session_id: String,
        uuid: String,
        #[serde(default)]
        timestamp: Option<String>,
        #[serde(default)]
        tool_use_result: Option<Value>,
        #[serde(default)]
        subagent_type: Option<String>,
        #[serde(default)]
        task_description: Option<String>,
        /// A message the CLI replayed into its own context rather than one the
        /// user typed. Both flags are needed and neither implies the other: a
        /// compaction emits its summary as `isSynthetic` and the `/compact`
        /// command echo as `isReplay`. No tool result in any fixture carries
        /// either, so the pair cleanly separates the CLI's own bookkeeping from
        /// real conversation.
        #[serde(default, rename = "isReplay")]
        is_replay: bool,
        #[serde(default, rename = "isSynthetic")]
        is_synthetic: bool,
    },
    Result(ResultEvent),
    RateLimitEvent {
        rate_limit_info: RateLimitInfo,
        uuid: String,
        session_id: String,
    },
    /// The CLI's reply to a `control_request` we wrote to stdin — the ack for
    /// `interrupt`, `set_model`, `set_permission_mode`. Kept as a raw `Value`:
    /// the inner shape varies per request subtype, and nothing correlates
    /// request ids yet.
    ControlResponse { response: Value },
    /// The only line that travels *into* the app expecting an answer: every
    /// other event is a report. The CLI blocks the tool call until a
    /// `control_response` carrying this `request_id` comes back on stdin, so an
    /// unhandled one stalls the turn rather than merely losing information.
    ///
    /// Only arrives when the child was spawned with `--permission-prompt-tool
    /// stdio`; without it the CLI auto-denies and reports `system`/
    /// `permission_denied` instead.
    ControlRequest {
        request_id: String,
        request: ControlRequest,
    },
    /// The CLI withdrawing a question it already asked — the tool call was
    /// abandoned before anyone answered, so the request no longer exists on its
    /// side.
    ///
    /// It names an *inbound* `request_id`, not one of ours. The two id spaces
    /// are told apart by UUID version: every captured cancel carries a v4, the
    /// version the CLI's own `can_use_tool` ids use, where [`ControlLine`]
    /// mints v7. Answering one would be writing to a request that is gone.
    ///
    /// Unhandled, this stranded the card: `pending_permissions` is keyed by
    /// request id and only a reply removes an entry, so the buttons stayed on
    /// screen answering nothing and the "waiting on you" rail stayed lit.
    ControlCancelRequest { request_id: String },
    /// A liveness ping for a tool call that has been running a while, emitted
    /// every 30s with `heartbeat: true` and a rising `elapsed_time_seconds`.
    ///
    /// Modelled only so it stops being filed as a parse failure — it was a
    /// third of `parse_failures.jsonl`, which is a log that is only useful
    /// while everything in it is a real gap. Nothing renders from it: the tool
    /// row already shimmers for as long as the call is pending, so the ping
    /// says nothing the transcript isn't showing.
    ToolProgress {
        tool_use_id: String,
        tool_name: String,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        elapsed_time_seconds: u64,
        #[serde(default)]
        heartbeat: bool,
        session_id: String,
        uuid: String,
    },
}

/// A question from the CLI. Externally tagged on `subtype`, like the control
/// requests we send in the other direction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequest {
    CanUseTool(PermissionRequest),
    /// A subtype this build doesn't answer. Distinct from a parse failure: the
    /// line is understood well enough to know it needs a reply we can't give,
    /// which the mapper turns into an automatic denial so the turn proceeds.
    #[serde(other)]
    Unsupported,
}

/// A tool call held pending the user's decision. Most fields are absent most of
/// the time — the shape is one union across every reason a call can escalate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: String,
    /// Pre-built rules the host may apply alongside its answer. These are what
    /// "always allow" and "switch mode" offer — the CLI composes them, so the
    /// app never has to author a rule itself.
    #[serde(default)]
    pub permission_suggestions: Vec<PermissionUpdate>,
    /// The path that triggered a working-directory escalation.
    #[serde(default)]
    pub blocked_path: Option<String>,
    /// Human-readable reason the call escalated. May carry ANSI escapes.
    #[serde(default)]
    pub decision_reason: Option<String>,
    #[serde(default)]
    pub decision_reason_type: Option<String>,
    /// Set when a safety check is involved: `false` means at least one check
    /// wants a human, `true` that a classifier could approve it.
    #[serde(default)]
    pub classifier_approvable: Option<bool>,
    /// The ask's own verb is narrower than a whole-tool rule would be, so
    /// offering "always allow" here would grant more than the question asked.
    #[serde(default)]
    pub suppress_always_allow_rule: bool,
    /// The tool's own card is the interaction surface, so a one-tap answer
    /// isn't enough — the user has to open the session.
    #[serde(default)]
    pub requires_user_interaction: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Set when the call came from inside a subagent.
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// The name the CLI gives its own question-asking tool. It arrives as an
/// ordinary `can_use_tool` request and there is no channel of its own: the CLI's
/// `request_user_dialog` subtype exists but is gated on a `supportedDialogKinds`
/// handshake this app doesn't do, and no dialog kind covers questions anyway.
pub const ASK_USER_QUESTION: &str = "AskUserQuestion";

/// The `AskUserQuestion` tool's arguments, read out of
/// [`PermissionRequest::input`] when the tool name matches.
///
/// The answer travels back the same way: an *allow* whose `updatedInput` is this
/// object with an `answers` map added, keyed by each question's own text. So the
/// question is never whether the call may run — it always may — but what it
/// should return. Allowing without answers is what produces the CLI's "The user
/// did not answer the questions."
#[derive(Debug, Clone, Deserialize)]
pub struct AskUserQuestionInput {
    pub questions: Vec<AskQuestion>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestion {
    /// The full question, and the key its answer is filed under.
    pub question: String,
    /// A short chip label — "Indentation", "Auth method".
    #[serde(default)]
    pub header: Option<String>,
    /// Whether several options may be picked. A multi-select answer is one
    /// comma-separated string, not a list.
    #[serde(default)]
    pub multi_select: bool,
    pub options: Vec<AskOption>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AskOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Markdown the CLI expects rendered in a monospace box. Only ever set on
    /// single-select questions.
    #[serde(default)]
    pub preview: Option<String>,
}

/// A change to the session's permission state, applied by sending it back on the
/// decision. Camel-cased on the wire — this is SDK-facing rather than
/// transcript-facing, and the two halves of the CLI disagree on case.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PermissionUpdate {
    #[serde(rename_all = "camelCase")]
    AddRules {
        rules: Vec<PermissionRule>,
        behavior: String,
        destination: String,
    },
    #[serde(rename_all = "camelCase")]
    ReplaceRules {
        rules: Vec<PermissionRule>,
        behavior: String,
        destination: String,
    },
    #[serde(rename_all = "camelCase")]
    RemoveRules {
        rules: Vec<PermissionRule>,
        behavior: String,
        destination: String,
    },
    #[serde(rename_all = "camelCase")]
    SetMode { mode: String, destination: String },
    #[serde(rename_all = "camelCase")]
    AddDirectories {
        directories: Vec<String>,
        destination: String,
    },
    #[serde(rename_all = "camelCase")]
    RemoveDirectories {
        directories: Vec<String>,
        destination: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub tool_name: String,
    /// The specific invocation the rule covers — a command for `Bash`, a path
    /// glob for the file tools. Absent means the whole tool.
    #[serde(default)]
    pub rule_content: Option<String>,
}

/// Camel-cased on the wire, unlike every other Claude Code payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitInfo {
    #[serde(default)]
    pub status: Option<String>,
    /// Unix seconds, not RFC3339 like [`crate::events::RateLimit::resets_at`].
    #[serde(default)]
    pub resets_at: Option<i64>,
    #[serde(default)]
    pub rate_limit_type: Option<String>,
    #[serde(default)]
    pub overage_status: Option<String>,
    #[serde(default)]
    pub overage_disabled_reason: Option<String>,
    #[serde(default)]
    pub is_using_overage: Option<bool>,
    /// Fraction of the window spent, `0.93` at 93%. Only sent alongside
    /// `allowed_warning`.
    #[serde(default)]
    pub utilization: Option<f64>,
    /// The threshold that tripped the warning — `0.9` observed.
    #[serde(default)]
    pub surpassed_threshold: Option<f64>,
}

/// Statuses that mean work continues and nothing needs saying.
///
/// `allowed_warning` is the one that has to be listed rather than inferred: it
/// arrives with `utilization` around 0.93 and means the window is *approaching*
/// full, not spent. Reading it as trouble put "Usage limit reached" on screen
/// during an ordinary turn.
const HEALTHY_STATUSES: [&str; 2] = ["allowed", "allowed_warning"];

impl RateLimitInfo {
    /// Whether this is worth surfacing. The CLI reports the limit on roughly
    /// every turn, almost always to say everything is fine, so emitting each
    /// one would bury the report that matters.
    ///
    /// Still written as "not a known-good state" rather than as a list of bad
    /// ones, so an unrecognized status — or a missing one — surfaces instead of
    /// being assumed healthy. The known-good list is what grows: it started at
    /// `allowed` alone because that was the only value captured, and
    /// `allowed_warning` showed up the moment a session ran near its ceiling.
    /// Add to it only from a capture, never from a guess about the naming.
    pub fn is_noteworthy(&self) -> bool {
        let healthy = self
            .status
            .as_deref()
            .is_some_and(|status| HEALTHY_STATUSES.contains(&status));

        self.is_using_overage.unwrap_or(false) || !healthy
    }

}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum SystemEvent {
    HookStarted {
        session_id: String,
    },
    HookResponse {
        session_id: String,
    },
    Init {
        cwd: String,
        session_id: String,
        tools: Vec<String>,
        mcp_servers: Vec<McpServer>,
        model: String,
        #[serde(rename = "permissionMode")]
        permission_mode: PermissionMode,
        claude_code_version: String,
        agents: Vec<String>,
        fast_mode_state: String,
    },
    Status {
        status: Option<String>,
        #[serde(default, rename = "permissionMode")]
        permission_mode: Option<PermissionMode>,
        uuid: String,
        session_id: String,
    },
    TaskStarted {
        task_id: String,
        tool_use_id: String,
        description: String,
        /// Absent for non-agent tasks — a `local_bash` task (an interrupted or
        /// backgrounded shell command) has no agent type to name.
        #[serde(default)]
        subagent_type: Option<String>,
        task_type: String,
        #[serde(default)]
        prompt: Option<String>,
        uuid: String,
        session_id: String,
    },
    TaskProgress {
        task_id: String,
        tool_use_id: String,
        description: String,
        subagent_type: String,
        usage: TaskUsage,
        last_tool_name: String,
        uuid: String,
        session_id: String,
    },
    TaskUpdated {
        session_id: String,
    },
    TaskNotification {
        task_id: String,
        tool_use_id: String,
        status: String,
        output_file: String,
        summary: String,
        /// Absent for `local_bash` tasks, which spend no agent tokens.
        #[serde(default)]
        usage: Option<TaskUsage>,
        uuid: String,
        session_id: String,
    },
    /// A one-line recap of the turn that just ended, emitted just before its
    /// `result`.
    PostTurnSummary {
        session_id: String,
    },
    /// The full set of outstanding background tasks, republished whenever it
    /// changes — an empty `tasks` means everything has drained. A turn's
    /// `result` can arrive while this is non-empty, so the two together are what
    /// say whether the session is idle.
    BackgroundTasksChanged {
        tasks: Vec<BackgroundTask>,
        uuid: String,
        session_id: String,
    },
    /// A running estimate of the current thinking block's size, emitted every
    /// few tokens while the model reasons. `estimated_tokens` is the block's
    /// total so far, `_delta` the increment since the last line.
    ThinkingTokens {
        estimated_tokens: u64,
        estimated_tokens_delta: u64,
        uuid: String,
        session_id: String,
    },
    /// The seam where a compaction dropped the earlier conversation. Arrives
    /// *after* the fresh `init`, and is the only line carrying what the
    /// compaction cost — `status: "compacting"` opens the window, this closes
    /// it.
    CompactBoundary {
        compact_metadata: CompactMetadata,
        uuid: String,
        session_id: String,
    },
    /// A tool call refused without ever being asked about. Two causes, and the
    /// wire doesn't distinguish them: the working-directory sandbox blocked a
    /// path, or the permission mode wanted an approval the host couldn't be
    /// asked for. The second disappears once the child runs with
    /// `--permission-prompt-tool stdio`; the first can't be answered at all, so
    /// this stays a report rather than becoming a question.
    ///
    /// `message` is what the model receives back as the tool's error, so it is
    /// the same text the transcript already shows on the failed call — carried
    /// anyway because the denial is the reason, and the tool result is only the
    /// symptom.
    PermissionDenied {
        tool_name: String,
        tool_use_id: String,
        message: String,
        uuid: String,
        session_id: String,
    },
    /// A model request failed and the CLI is trying it again, one line per
    /// attempt. `attempt` counts from 1 toward `max_retries` (10 in every
    /// capture), and it does climb — attempts of 7 and beyond appear in real
    /// sessions, which is minutes of a turn drawing nothing.
    ///
    /// The cause is best-effort and usually absent: of 154 captured lines, 90
    /// carry `error_status: null` with `error: "unknown"` and only 64 name a
    /// status (529 `overloaded`, 500 `server_error`). So the attempt count is
    /// the only thing always worth reporting, and anything reading these has
    /// to treat the cause as an optional extra rather than the headline.
    ApiRetry {
        attempt: u32,
        max_retries: u32,
        #[serde(default, deserialize_with = "null_as_default")]
        retry_delay_ms: u64,
        #[serde(default)]
        error_status: Option<u32>,
        #[serde(default)]
        error: Option<String>,
        uuid: String,
        session_id: String,
    },
    /// A subtype this build doesn't model. The CLI adds subtypes over time
    /// (`thinking_tokens` arrived unannounced), and without this every such
    /// line failed whole — the loop logged a parse error and dropped it.
    #[serde(other)]
    Unrecognized,
}

/// What a compaction cost. Every field is optional despite all being present in
/// the one capture we have: a missing field would otherwise fail the line, and
/// this is the only event that closes the compacting indicator — so a shape we
/// haven't seen would leave the UI spinning rather than merely under-reporting.
/// The wire also carries `preserved_segment`/`preserved_messages`, uuid sets
/// naming what survived, and `cumulative_dropped_tokens`. None is carried:
/// nothing can act on the uuids, and the cumulative count sums every compaction
/// in the session, so what *this* one saved is `pre_tokens - post_tokens`. The
/// two are equal on a first compaction and diverge after — reading it as the
/// saving would overstate every compaction but the first.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompactMetadata {
    /// `manual` for `/compact`, `auto` when the window filled. Only `manual` is
    /// captured.
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub pre_tokens: Option<u64>,
    #[serde(default)]
    pub post_tokens: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundTask {
    pub task_id: String,
    pub task_type: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ResultEvent {
    Success {
        is_error: bool,
        #[serde(default)]
        api_error_status: Option<Value>,
        duration_ms: u64,
        duration_api_ms: u64,
        #[serde(default)]
        ttft_ms: Option<u64>,
        #[serde(default)]
        ttft_stream_ms: Option<u64>,
        #[serde(default)]
        time_to_request_ms: Option<u64>,
        num_turns: u32,
        result: String,
        /// Null on the `result` that closes a compaction — the CLI ran no
        /// inference of its own, so nothing stopped. A required `String` here
        /// failed that whole line, and since `result` is what closes a turn, the
        /// session then sat on `in_progress` until the user typed again.
        #[serde(default)]
        stop_reason: Option<String>,
        session_id: String,
        total_cost_usd: f64,
        usage: Usage,
        /// Per-model breakdown, keyed by model name — a different shape from
        /// [`Usage`], and nothing consumes it yet.
        #[serde(rename = "modelUsage")]
        model_usage: Value,
        permission_denials: Vec<Value>,
        /// Absent on a compaction's `result`, present on an ordinary turn's.
        #[serde(default)]
        terminal_reason: Option<String>,
        fast_mode_state: String,
        #[serde(default)]
        origin: Option<ResultOrigin>,
        uuid: String,
    },
    /// A turn that ended without completing — today, the user interrupting a
    /// streaming response.
    ///
    /// Not a field-optional [`Success`]: there is no `result` text to report,
    /// `stop_reason` is null where `Success` always carries one, and `errors`
    /// exists nowhere else. Branch on `terminal_reason`, not on the prose the
    /// CLI emits alongside it as a `user` text block.
    ///
    /// [`Success`]: Self::Success
    ErrorDuringExecution {
        is_error: bool,
        duration_ms: u64,
        duration_api_ms: u64,
        num_turns: u32,
        #[serde(default)]
        stop_reason: Option<String>,
        session_id: String,
        total_cost_usd: f64,
        usage: Usage,
        #[serde(rename = "modelUsage")]
        model_usage: Value,
        permission_denials: Vec<Value>,
        terminal_reason: String,
        fast_mode_state: String,
        /// Diagnostic strings; free-form, and not meant for display.
        #[serde(default)]
        errors: Vec<String>,
        uuid: String,
    },
}

/// One Anthropic SSE frame, as carried in `stream_event.event`.
///
/// These stream the assistant's response as it is produced. Frames address
/// content blocks by `index` within the message opened by [`MessageStart`], and
/// a block's identity (`id`/`name` for a tool call) arrives up front in
/// [`ContentBlockStart`] — only its *contents* are streamed.
///
/// [`MessageStart`]: Self::MessageStart
/// [`ContentBlockStart`]: Self::ContentBlockStart
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamFrame {
    MessageStart {
        message: StreamMessage,
    },
    ContentBlockStart {
        index: u32,
        content_block: ContentBlock,
    },
    ContentBlockDelta {
        index: u32,
        delta: ContentDelta,
    },
    ContentBlockStop {
        index: u32,
    },
    MessageDelta {
        delta: MessageDelta,
        #[serde(default)]
        usage: Option<Usage>,
        #[serde(default)]
        context_management: Option<Value>,
    },
    MessageStop,
    /// A frame type this build doesn't model. Anthropic adds frame types over
    /// time, and dropping the whole line over one unknown frame would lose
    /// content we *can* read.
    #[serde(other)]
    Unrecognized,
}

/// A committed assistant message.
///
/// Claude Code emits one `assistant` event **per content block**, not per
/// message: `content` is always length 1, and several events share one `id`.
/// Since the wire carries no block index, a consumer needing one derives it by
/// counting blocks per `id` in arrival order.
///
/// The blocks are the same shapes the stream frames carry, so [`ContentBlock`]
/// is reused — a streamed block and its committed counterpart deserialize into
/// the same type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub id: String,
    pub model: String,
    pub role: String,
    pub content: Vec<ContentBlock>,
    /// Null on every fixture event; the terminal reason arrives on `result`.
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

/// A `user` event's message.
///
/// Two unrelated things share this event type: what the human typed, which
/// arrives as a bare string, and what the CLI feeds back to the model — tool
/// results, abort notices — which arrives as a block array.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    pub role: String,
    pub content: UserContent,
}

/// Untagged: nothing labels which shape a line uses, so serde picks the arm by
/// JSON type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Blocks(Vec<UserContentBlock>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserContentBlock {
    Text {
        text: String,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: ToolResultContent,
        /// Absent on success rather than `false`, so this can't be a bare bool.
        #[serde(default)]
        is_error: Option<bool>,
    },
    /// What a `Read` of a screenshot comes back as. The same bytes also arrive
    /// on the line's `tool_use_result` sidecar; this side is read instead
    /// because it is the API's own shape and names its type `media_type`.
    Image {
        source: ImageSource,
    },
    #[serde(other)]
    Unrecognized,
}

/// An image block's payload. Only `base64` is ever sent here — a `url` source
/// exists in the API and would arrive with an empty `data`, which
/// [`ToolResultContent::images`] drops rather than emit an empty picture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSource {
    #[serde(default)]
    pub data: String,
    #[serde(default)]
    pub media_type: Option<String>,
}

/// A tool result's payload: usually one flat string, but tools that return
/// structured output send a block array instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolResultContent {
    Text(String),
    Blocks(Vec<UserContentBlock>),
    #[default]
    Missing,
}

impl ToolResultContent {
    /// Every image the result carried, as `(media_type, base64)`.
    pub fn images(&self) -> Vec<(String, String)> {
        let Self::Blocks(blocks) = self else {
            return Vec::new();
        };

        blocks
            .iter()
            .filter_map(|block| match block {
                UserContentBlock::Image { source } if !source.data.is_empty() => Some((
                    source
                        .media_type
                        .clone()
                        .unwrap_or_else(|| "image/png".to_string()),
                    source.data.clone(),
                )),
                _ => None,
            })
            .collect()
    }

    /// Flattens either shape to displayable text, dropping non-text blocks.
    pub fn as_text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    UserContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
            Self::Missing => String::new(),
        }
    }
}

/// The message envelope opened by [`StreamFrame::MessageStart`]. `content` is
/// always empty here — blocks arrive as subsequent frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamMessage {
    pub id: String,
    pub model: String,
    pub role: String,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

/// A content block's identity, known when the block opens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
        #[serde(default)]
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        caller: Option<Value>,
    },
    #[serde(other)]
    Unrecognized,
}

/// An incremental update to an open content block.
///
/// `input_json_delta` fragments are *not* individually parseable — they only
/// form valid JSON once every fragment for the block has been concatenated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentDelta {
    TextDelta {
        text: String,
    },
    InputJsonDelta {
        partial_json: String,
    },
    ThinkingDelta {
        thinking: String,
    },
    SignatureDelta {
        signature: String,
    },
    #[serde(other)]
    Unrecognized,
}

/// Terminal metadata for a message, carried on
/// [`StreamFrame::MessageDelta`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDelta {
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_sequence: Option<String>,
    #[serde(default)]
    pub stop_details: Option<Value>,
}

/// Anthropic's token accounting, as it appears on `result`, `assistant.message`,
/// and the `message_start`/`message_delta` stream frames.
///
/// The four token counts are present everywhere; the rest varies by location
/// (`message_delta` omits the cache-tier breakdown, only `result` carries
/// `server_tool_use` and `speed`), so everything beyond them is optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Tokens served from cache — cheap, and the bulk of a long session.
    pub cache_read_input_tokens: u64,
    /// Tokens written *into* the cache, billed at a premium.
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_creation: Option<CacheCreation>,
    #[serde(default)]
    pub server_tool_use: Option<ServerToolUse>,
    #[serde(default)]
    pub service_tier: Option<String>,
    #[serde(default)]
    pub speed: Option<String>,
    #[serde(default)]
    pub inference_geo: Option<String>,
    /// Per-request breakdown when a turn took several model calls. Sent as an
    /// explicit `null` on a synthetic message, hence `null_as_default` — without
    /// it every built-in slash command's reply failed the whole line, so the
    /// command appeared to do nothing at all.
    #[serde(default, deserialize_with = "null_as_default")]
    pub iterations: Vec<UsageIteration>,
}

/// `cache_creation_input_tokens` split by TTL, which are priced differently.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct CacheCreation {
    #[serde(default)]
    pub ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    pub ephemeral_1h_input_tokens: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ServerToolUse {
    #[serde(default)]
    pub web_search_requests: u64,
    #[serde(default)]
    pub web_fetch_requests: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageIteration {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_creation: Option<CacheCreation>,
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUsage {
    pub total_tokens: u64,
    pub tool_uses: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultOrigin {
    pub kind: String,
}

// `McpServer` and `PermissionMode` are shared with the normalized model rather
// than duplicated here — the wire shapes match, so these deserialize straight
// into the `events` types.
pub use crate::events::{McpServer, PermissionMode};

pub fn parse_line(line: &str) -> Result<ClaudeCodeEvent> {
    serde_json::from_str(line).with_context(|| format!("Failed to parse {line}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_fixture(fixture: &str) -> Vec<ClaudeCodeEvent> {
        fixture
            .lines()
            .filter(|line| {
                let line = line.trim();
                !line.is_empty() && !line.starts_with("//")
            })
            .map(|line| parse_line(line).unwrap_or_else(|err| panic!("{err}\n{line}")))
            .collect()
    }

    #[test]
    fn parses_simple_fixture() {
        let events = parse_fixture(include_str!("fixtures/printed.jsonl"));
        assert!(!events.is_empty(), "expected at least one event");
    }

    #[test]
    fn parses_system_init_and_result() {
        let events = parse_fixture(include_str!("fixtures/printed.jsonl"));

        assert!(
            events
                .iter()
                .any(|e| matches!(e, ClaudeCodeEvent::System(SystemEvent::Init { .. }))),
            "missing system/init"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ClaudeCodeEvent::StreamEvent { .. })),
            "missing stream_event"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ClaudeCodeEvent::Assistant { .. })),
            "missing assistant"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ClaudeCodeEvent::Result(ResultEvent::Success { .. }))),
            "missing result/success"
        );
    }

    #[test]
    fn parses_complex_fixture() {
        let events = parse_fixture(include_str!("fixtures/complex.jsonl"));

        assert_eq!(events.len(), 177);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ClaudeCodeEvent::User { .. }))
                .count(),
            30
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    ClaudeCodeEvent::System(SystemEvent::TaskStarted { .. })
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    ClaudeCodeEvent::System(SystemEvent::TaskProgress { .. })
                ))
                .count(),
            29
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    ClaudeCodeEvent::System(SystemEvent::TaskUpdated { .. })
                ))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(
                    event,
                    ClaudeCodeEvent::System(SystemEvent::TaskNotification { .. })
                ))
                .count(),
            1
        );
    }

    #[test]
    fn parses_nullable_status_and_result_origin() {
        let events = parse_fixture(include_str!("fixtures/complex.jsonl"));

        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::System(SystemEvent::Status { status: None, .. })
        )));

        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::Result(ResultEvent::Success {
                origin: Some(ResultOrigin { kind }),
                ..
            }) if kind == "task-notification"
        )));
    }

    fn stream_frames(fixture: &str) -> Vec<StreamFrame> {
        parse_fixture(fixture)
            .into_iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::StreamEvent { event, .. } => Some(event),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn parses_every_stream_frame_variant() {
        let frames = stream_frames(include_str!("fixtures/complex.jsonl"));

        // No frame in the fixtures should land in the catch-all: if one does,
        // it's a shape this build doesn't model yet.
        assert!(
            !frames
                .iter()
                .any(|f| matches!(f, StreamFrame::Unrecognized)),
            "a stream frame fell through to Unrecognized"
        );

        for expected in [
            "message_start",
            "message_delta",
            "message_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
        ] {
            assert!(
                frames.iter().any(|f| match (f, expected) {
                    (StreamFrame::MessageStart { .. }, "message_start") => true,
                    (StreamFrame::MessageDelta { .. }, "message_delta") => true,
                    (StreamFrame::MessageStop, "message_stop") => true,
                    (StreamFrame::ContentBlockStart { .. }, "content_block_start") => true,
                    (StreamFrame::ContentBlockDelta { .. }, "content_block_delta") => true,
                    (StreamFrame::ContentBlockStop { .. }, "content_block_stop") => true,
                    _ => false,
                }),
                "missing {expected}"
            );
        }
    }

    #[test]
    fn stream_frames_expose_block_identity_and_content() {
        let frames = stream_frames(include_str!("fixtures/complex.jsonl"));

        // A tool call's id and name arrive when the block opens, before any of
        // its arguments have streamed — that's what lets the UI label a tool
        // call immediately.
        assert!(frames.iter().any(|f| matches!(
            f,
            StreamFrame::ContentBlockStart {
                content_block: ContentBlock::ToolUse { id, name, .. },
                ..
            } if id.starts_with("toolu_") && !name.is_empty()
        )));

        assert!(frames.iter().any(|f| matches!(
            f,
            StreamFrame::ContentBlockDelta {
                delta: ContentDelta::TextDelta { text },
                ..
            } if !text.is_empty()
        )));

        assert!(frames.iter().any(|f| matches!(
            f,
            StreamFrame::ContentBlockDelta {
                delta: ContentDelta::InputJsonDelta { .. },
                ..
            }
        )));

        assert!(frames.iter().any(|f| matches!(
            f,
            StreamFrame::MessageStart { message } if message.id.starts_with("msg_")
        )));
    }

    /// Concatenated `input_json_delta` fragments reconstruct the tool call's
    /// arguments. Individually they are not valid JSON.
    #[test]
    fn input_json_deltas_concatenate_into_valid_json() {
        let frames = stream_frames(include_str!("fixtures/complex.jsonl"));

        let mut by_index: std::collections::BTreeMap<u32, String> =
            std::collections::BTreeMap::new();
        for frame in &frames {
            if let StreamFrame::ContentBlockDelta {
                index,
                delta: ContentDelta::InputJsonDelta { partial_json },
            } = frame
            {
                by_index.entry(*index).or_default().push_str(partial_json);
            }
        }

        assert!(!by_index.is_empty(), "no input_json_delta frames");
        for (index, json) in by_index {
            serde_json::from_str::<Value>(&json)
                .unwrap_or_else(|e| panic!("block {index} did not reassemble: {e}\n{json}"));
        }
    }

    /// Unknown frame and delta types degrade instead of failing the line —
    /// `thinking` blocks appear in neither fixture, so this is the safety net
    /// for shapes we haven't captured.
    #[test]
    fn unknown_stream_shapes_degrade() {
        let line = r#"{"type":"stream_event","event":{"type":"some_future_frame"},"session_id":"s","parent_tool_use_id":null,"uuid":"u"}"#;
        assert!(matches!(
            parse_line(line).unwrap(),
            ClaudeCodeEvent::StreamEvent {
                event: StreamFrame::Unrecognized,
                ..
            }
        ));

        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"some_future_delta","x":1}},"session_id":"s","parent_tool_use_id":null,"uuid":"u"}"#;
        assert!(matches!(
            parse_line(line).unwrap(),
            ClaudeCodeEvent::StreamEvent {
                event: StreamFrame::ContentBlockDelta {
                    delta: ContentDelta::Unrecognized,
                    ..
                },
                ..
            }
        ));
    }

    /// `thinking` blocks stream as their own block and delta types. Neither
    /// fixture contains one, so this pins the shape from the documented format.
    #[test]
    fn parses_thinking_blocks() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":null}},"session_id":"s","parent_tool_use_id":null,"uuid":"u"}"#;
        assert!(matches!(
            parse_line(line).unwrap(),
            ClaudeCodeEvent::StreamEvent {
                event: StreamFrame::ContentBlockStart {
                    content_block: ContentBlock::Thinking { .. },
                    ..
                },
                ..
            }
        ));

        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}},"session_id":"s","parent_tool_use_id":null,"uuid":"u"}"#;
        assert!(matches!(
            parse_line(line).unwrap(),
            ClaudeCodeEvent::StreamEvent {
                event: StreamFrame::ContentBlockDelta {
                    delta: ContentDelta::ThinkingDelta { .. },
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn parses_assistant_messages_as_single_blocks() {
        let events = parse_fixture(include_str!("fixtures/complex.jsonl"));

        let messages: Vec<&AssistantMessage> = events
            .iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::Assistant { message, .. } => Some(message),
                _ => None,
            })
            .collect();

        assert_eq!(messages.len(), 48);

        // One event per content block, so several share an id — that's what
        // forces a consumer to derive block indices by arrival order.
        let distinct_ids: std::collections::HashSet<&str> =
            messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(distinct_ids.len(), 20);

        for message in &messages {
            assert_eq!(message.content.len(), 1, "expected exactly one block");
            assert_eq!(message.role, "assistant");
            assert!(message.usage.is_some());
        }

        assert!(messages.iter().any(|m| matches!(
            m.content.first(),
            Some(ContentBlock::Text { text }) if !text.is_empty()
        )));

        assert!(messages.iter().any(|m| matches!(
            m.content.first(),
            Some(ContentBlock::ToolUse { id, name, input, .. })
                if id.starts_with("toolu_") && !name.is_empty() && input.is_object()
        )));

        assert!(
            !messages
                .iter()
                .any(|m| matches!(m.content.first(), Some(ContentBlock::Unrecognized))),
            "an assistant content block fell through to Unrecognized"
        );
    }

    #[test]
    fn parses_usage_including_nested_breakdowns() {
        let events = parse_fixture(include_str!("fixtures/complex.jsonl"));

        let usages: Vec<&Usage> = events
            .iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::Result(ResultEvent::Success { usage, .. }) => Some(usage),
                _ => None,
            })
            .collect();

        assert_eq!(usages.len(), 2);
        for usage in &usages {
            assert!(usage.input_tokens > 0);
            assert!(usage.output_tokens > 0);
            assert!(usage.cache_read_input_tokens > 0);

            let cache = usage
                .cache_creation
                .expect("result usage carries a cache_creation breakdown");
            assert_eq!(
                cache.ephemeral_5m_input_tokens + cache.ephemeral_1h_input_tokens,
                usage.cache_creation_input_tokens,
                "tier split must sum to the total"
            );

            assert!(usage.server_tool_use.is_some());
            assert!(!usage.iterations.is_empty());
        }

        // message_delta omits the cache-tier breakdown, so the same struct has to
        // tolerate its absence.
        let stream_usage = events.iter().find_map(|event| match event {
            ClaudeCodeEvent::StreamEvent {
                event: StreamFrame::MessageDelta { usage, .. },
                ..
            } => usage.as_ref(),
            _ => None,
        });
        let stream_usage = stream_usage.expect("message_delta carries usage");
        assert!(stream_usage.output_tokens > 0);
        assert!(stream_usage.cache_creation.is_none());
    }

    /// A tool call interrupted via a `control_request` on stdin. Captured live:
    /// the CLI acks with `control_response`, ends the turn as
    /// `error_during_execution` with `terminal_reason: "aborted_tools"`, then
    /// opens a turn of its own to narrate the abort. Also the only capture with
    /// thinking enabled, so it pins `thinking_tokens` — the subtype whose
    /// arrival used to fail every carrying line.
    #[test]
    fn parses_an_interrupted_tool_call() {
        let events = parse_fixture(include_str!("fixtures/interrupted_tools.jsonl"));
        assert_eq!(events.len(), 45, "every line parses, none dropped");

        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::ControlResponse { response }
                if response["subtype"] == "success" && response["request_id"] == "req_test_1"
        )));

        let token_estimates: Vec<u64> = events
            .iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::System(SystemEvent::ThinkingTokens {
                    estimated_tokens, ..
                }) => Some(*estimated_tokens),
                _ => None,
            })
            .collect();
        assert!(token_estimates.len() > 20);
        assert!(token_estimates.iter().any(|&t| t > 0));

        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::Result(ResultEvent::ErrorDuringExecution { terminal_reason, .. })
                if terminal_reason == "aborted_tools"
        )));
        // The narration turn closes normally after the aborted one.
        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::Result(ResultEvent::Success { .. })
        )));
    }

    /// A `touch` under `--permission-mode manual --permission-prompt-tool
    /// stdio`, approved. The only capture of a control request travelling
    /// *inbound*, so it is what pins the field names the reply is built from.
    #[test]
    fn parses_an_inbound_permission_request() {
        let events = parse_fixture(include_str!("fixtures/permission_allow.jsonl"));
        assert_eq!(events.len(), 19, "every line parses, none dropped");

        let request = events
            .iter()
            .find_map(|event| match event {
                ClaudeCodeEvent::ControlRequest {
                    request_id,
                    request: ControlRequest::CanUseTool(request),
                } => Some((request_id, request)),
                _ => None,
            })
            .expect("the fixture holds one can_use_tool request");

        let (request_id, request) = request;
        assert!(!request_id.is_empty());
        assert_eq!(request.tool_name, "Bash");
        assert!(request.tool_use_id.starts_with("toolu_"));
        assert_eq!(request.input["command"], "touch ./marker.txt");
        assert!(request.blocked_path.is_some());

        // The three the CLI composed: a rule for this exact command, the
        // working directory, and the mode that stops it asking. They are what
        // the app's "always allow" options are built from — inventing them
        // locally is what this capture exists to prevent.
        assert_eq!(request.permission_suggestions.len(), 3);
        assert!(matches!(
            request.permission_suggestions[0],
            PermissionUpdate::AddRules { .. }
        ));
        assert!(matches!(
            request.permission_suggestions[1],
            PermissionUpdate::AddDirectories { .. }
        ));
        assert!(matches!(
            request.permission_suggestions[2],
            PermissionUpdate::SetMode { .. }
        ));
    }

    /// Denial leaves no `permission_denied` line — the request was answered, so
    /// the refusal is the tool's own error result. That absence is the whole
    /// difference between a denial the user made and one the CLI made alone.
    #[test]
    fn a_denied_request_reports_no_system_denial() {
        let events = parse_fixture(include_str!("fixtures/permission_deny.jsonl"));

        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::ControlRequest {
                request: ControlRequest::CanUseTool(_),
                ..
            }
        )));
        assert!(!events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::System(SystemEvent::PermissionDenied { .. })
        )));
    }

    /// The same `touch` with no answer channel open. The CLI refuses on its own
    /// and says so on a `system` line, which is the only signal there is.
    #[test]
    fn parses_a_denial_the_cli_made_alone() {
        let events = parse_fixture(include_str!("fixtures/permission_denied_system.jsonl"));

        let denial = events
            .iter()
            .find_map(|event| match event {
                ClaudeCodeEvent::System(SystemEvent::PermissionDenied {
                    tool_name,
                    tool_use_id,
                    message,
                    ..
                }) => Some((tool_name, tool_use_id, message)),
                _ => None,
            })
            .expect("the fixture holds one auto-denial");

        let (tool_name, tool_use_id, message) = denial;
        assert_eq!(tool_name, "Bash");
        assert!(tool_use_id.starts_with("toolu_"));
        assert!(message.contains("blocked"));

        assert!(!events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::ControlRequest { .. }
        )));
    }

    /// A live `/compact`. The replay log in `~/.claude/projects` writes this
    /// metadata in camelCase and stdout writes it in snake_case, so this fixture
    /// is the only thing that keeps the field names honest.
    #[test]
    fn parses_a_compaction() {
        let events = parse_fixture(include_str!("fixtures/compaction.jsonl"));
        assert_eq!(events.len(), 49, "every line parses, none dropped");

        assert!(
            events.iter().any(|event| matches!(
                event,
                ClaudeCodeEvent::System(SystemEvent::Status { status, .. })
                    if status.as_deref() == Some("compacting")
            )),
            "the window opens on a status line"
        );

        let boundary = events
            .iter()
            .find_map(|event| match event {
                ClaudeCodeEvent::System(SystemEvent::CompactBoundary {
                    compact_metadata,
                    ..
                }) => Some(compact_metadata),
                _ => None,
            })
            .expect("the window closes on a boundary");

        assert_eq!(boundary.trigger.as_deref(), Some("manual"));
        assert_eq!(boundary.pre_tokens, Some(31872));
        assert_eq!(boundary.post_tokens, Some(1318));
        assert_eq!(boundary.duration_ms, Some(6681));
    }

    /// The two lines a compaction leaves behind are flagged differently — the
    /// summary is synthetic, the `/compact` echo is a replay — so dropping them
    /// takes both flags. No tool result carries either.
    #[test]
    fn compaction_leftovers_carry_one_flag_each() {
        let events = parse_fixture(include_str!("fixtures/compaction.jsonl"));

        let flags: Vec<(bool, bool)> = events
            .iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::User {
                    is_replay,
                    is_synthetic,
                    ..
                } => Some((*is_replay, *is_synthetic)),
                _ => None,
            })
            .collect();

        assert_eq!(flags, vec![(false, true), (true, false)]);
    }

    /// A built-in slash command (`/rename`) answered by the CLI itself rather
    /// than by the model. The reply is a **synthetic** assistant message —
    /// `model: "<synthetic>"`, every token count zero — and it is the only
    /// capture where `usage.iterations` arrives as an explicit `null`.
    ///
    /// That null is what made every built-in command look broken: `iterations`
    /// is a `Vec` and `#[serde(default)]` only covers an absent key, so the
    /// whole line failed to parse, the reply never reached the transcript, and
    /// the command read as doing nothing. Skills were unaffected because they
    /// answer through an ordinary model turn.
    #[test]
    fn parses_a_builtin_commands_synthetic_reply() {
        let events = parse_fixture(include_str!("fixtures/builtin_command.jsonl"));
        assert_eq!(events.len(), 3, "every line parses, none dropped");

        let message = events
            .iter()
            .find_map(|event| match event {
                ClaudeCodeEvent::Assistant { message, .. } => Some(message),
                _ => None,
            })
            .expect("the command answers with an assistant message");

        assert_eq!(message.model, "<synthetic>");
        assert!(matches!(
            message.content.first(),
            Some(ContentBlock::Text { text }) if text.contains("renamed")
        ));

        let usage = message.usage.as_ref().expect("a synthetic message carries usage");
        assert!(usage.iterations.is_empty(), "a null list reads as an empty one");
        assert_eq!(usage.input_tokens, 0, "the CLI answered without the model");
    }

    /// Pinned apart from the fixture because the distinction is exactly the one
    /// that was missed: `default` answers for a key that isn't there, and does
    /// nothing at all for a key that is there and null.
    #[test]
    fn a_null_collection_is_not_the_same_as_a_missing_one() {
        let with_null: Usage =
            serde_json::from_str(r#"{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"iterations":null}"#)
                .expect("an explicit null must not fail the line");
        assert!(with_null.iterations.is_empty());

        let omitted: Usage =
            serde_json::from_str(r#"{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}"#)
                .unwrap();
        assert!(omitted.iterations.is_empty());
    }

    /// A subtype this build has never seen must degrade to `Unrecognized`, not
    /// fail the line — `thinking_tokens` arriving unannounced cost every
    /// thinking session its lines until it was modeled.
    #[test]
    fn unknown_system_subtypes_degrade_instead_of_failing() {
        let line = r#"{"type":"system","subtype":"from_the_future","payload":9001,"uuid":"u","session_id":"s"}"#;
        let event = parse_line(line).expect("unknown subtype still parses");
        assert!(matches!(
            event,
            ClaudeCodeEvent::System(SystemEvent::Unrecognized)
        ));
    }

    /// A real stdin-driven session: two prompts, an async subagent, and a third
    /// turn the agent started for itself when the subagent reported back.
    #[test]
    fn parses_a_multi_turn_session() {
        let events = parse_fixture(include_str!("fixtures/multi_turn.jsonl"));
        assert_eq!(events.len(), 382);

        // `init` is per turn, not per session — and the tool list grows between
        // them as deferred tools load.
        let tool_counts: Vec<usize> = events
            .iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::System(SystemEvent::Init { tools, .. }) => Some(tools.len()),
                _ => None,
            })
            .collect();
        assert_eq!(tool_counts.len(), 3);
        assert!(tool_counts[0] < tool_counts[1]);

        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::System(SystemEvent::PostTurnSummary { .. })
        )));

        // Published non-empty while the subagent runs, then empty once it
        // drains — the pair is what distinguishes "turn over" from "idle".
        let task_sets: Vec<usize> = events
            .iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::System(SystemEvent::BackgroundTasksChanged { tasks, .. }) => {
                    Some(tasks.len())
                }
                _ => None,
            })
            .collect();
        assert_eq!(task_sets, vec![1, 0]);

        assert!(events
            .iter()
            .any(|event| matches!(event, ClaudeCodeEvent::RateLimitEvent { .. })));

        // The turn the agent started for itself, rather than in response to a
        // prompt.
        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::Result(ResultEvent::Success {
                origin: Some(ResultOrigin { kind }),
                ..
            }) if kind == "task-notification"
        )));
    }

    /// Interrupting a streaming response ends the turn with a `result` line
    /// whose subtype is *not* `success`. Before this variant existed the line
    /// failed to parse, so an interrupted turn emitted no terminal event at
    /// all — the swallow-and-continue path turned it into a hung UI.
    #[test]
    fn parses_an_interrupted_turn() {
        let events = parse_fixture(include_str!("fixtures/interrupted.jsonl"));

        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::Result(ResultEvent::ErrorDuringExecution {
                terminal_reason,
                stop_reason: None,
                errors,
                ..
            }) if terminal_reason == "aborted_streaming" && !errors.is_empty()
        )));

        // The CLI also narrates the abort as a user text block, which is what
        // makes it indistinguishable from a prompt at the block level.
        assert!(events.iter().any(|event| matches!(
            event,
            ClaudeCodeEvent::User { message: UserMessage { content: UserContent::Blocks(blocks), .. }, .. }
                if matches!(
                    blocks.first(),
                    Some(UserContentBlock::Text { text }) if text.starts_with("[Request interrupted")
                )
        )));
    }

    fn user_messages(fixture: &str) -> Vec<UserMessage> {
        parse_fixture(fixture)
            .into_iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::User { message, .. } => Some(message),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn parses_user_tool_results() {
        let messages = user_messages(include_str!("fixtures/complex.jsonl"));
        assert_eq!(messages.len(), 30);

        let blocks: Vec<&UserContentBlock> = messages
            .iter()
            .flat_map(|message| match &message.content {
                UserContent::Blocks(blocks) => blocks.iter(),
                UserContent::Text(_) => [].iter(),
            })
            .collect();

        assert_eq!(
            blocks.len(),
            30,
            "every fixture user message is a tool result"
        );
        assert!(
            !blocks
                .iter()
                .any(|block| matches!(block, UserContentBlock::Unrecognized)),
            "a user content block fell through to Unrecognized"
        );

        // Both payload shapes appear, and the flattening covers each.
        assert!(blocks.iter().any(|block| matches!(
            block,
            UserContentBlock::ToolResult { content: ToolResultContent::Text(text), .. }
                if !text.is_empty()
        )));
        assert!(blocks.iter().any(|block| matches!(
            block,
            UserContentBlock::ToolResult { content: ToolResultContent::Blocks(inner), .. }
                if !inner.is_empty()
        )));
        for block in &blocks {
            if let UserContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } = block
            {
                assert!(tool_use_id.starts_with("toolu_"));
                assert!(!content.as_text().is_empty());
            }
        }

        // `is_error` is omitted on success rather than sent as false.
        assert_eq!(
            blocks
                .iter()
                .filter(|block| matches!(
                    block,
                    UserContentBlock::ToolResult {
                        is_error: Some(true),
                        ..
                    }
                ))
                .count(),
            2
        );
    }

    /// A typed prompt is a bare string, not a block array — the one shape the
    /// fixtures don't contain, since they start after the prompt was sent.
    #[test]
    fn parses_typed_prompts_as_bare_strings() {
        let line = r#"{"type":"user","message":{"role":"user","content":"hey"},"parent_tool_use_id":null,"session_id":"s","uuid":"u"}"#;
        let ClaudeCodeEvent::User { message, .. } = parse_line(line).unwrap() else {
            panic!("expected a user event");
        };
        assert!(matches!(message.content, UserContent::Text(text) if text == "hey"));
    }

    /// A block of a type this build has never seen must not cost the sibling
    /// text block on the same message.
    #[test]
    fn unknown_user_blocks_degrade() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"whatever_comes_next","payload":{}},{"type":"text","text":"what is this"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"u"}"#;
        let ClaudeCodeEvent::User { message, .. } = parse_line(line).unwrap() else {
            panic!("expected a user event");
        };
        let UserContent::Blocks(blocks) = message.content else {
            panic!("expected blocks");
        };
        assert!(matches!(blocks[0], UserContentBlock::Unrecognized));
        assert!(matches!(&blocks[1], UserContentBlock::Text { text } if text == "what is this"));
    }

    /// The whole of what a `Read` of a `.png` answers with. `as_text` sees
    /// nothing in it, so the image is the only thing the row can draw.
    #[test]
    fn parses_an_image_tool_result() {
        let results: Vec<ToolResultContent> = parse_fixture(include_str!("fixtures/image_read.jsonl"))
            .into_iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::User { message, .. } => Some(message),
                _ => None,
            })
            .filter_map(|message| match message.content {
                UserContent::Blocks(blocks) => blocks.into_iter().find_map(|block| match block {
                    UserContentBlock::ToolResult { content, .. } => Some(content),
                    _ => None,
                }),
                UserContent::Text(_) => None,
            })
            .collect();

        assert_eq!(results.len(), 1);
        assert!(results[0].as_text().is_empty());
        assert_eq!(
            results[0].images(),
            vec![("image/png".to_string(), IMAGE_BASE64.to_string())]
        );
    }

    /// The 8×8 PNG the fixture was captured against, as the CLI re-encoded it.
    const IMAGE_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAbElEQVR4nA3JQQEAMAgDMZzUCU7qpE6wcS+c4GbLN1WFii5cpJhiiyuqhEQLi4gRK04/GjXduEkzzTbXP4xMG5uYMWvOP4JCB4eECRsuPwYNPXjIMMMONz8WLb14yTLLLrc/Dh19+Mgxxx53PEKmY0EVp/9TAAAAAElFTkSuQmCC";

    #[test]
    fn parses_object_and_string_tool_results() {
        let events = parse_fixture(include_str!("fixtures/complex.jsonl"));
        let tool_results: Vec<&Value> = events
            .iter()
            .filter_map(|event| match event {
                ClaudeCodeEvent::User {
                    tool_use_result: Some(result),
                    ..
                } => Some(result),
                _ => None,
            })
            .collect();

        assert!(tool_results.iter().any(|result| result.is_object()));
        assert!(tool_results.iter().any(|result| result.is_string()));
    }
}
