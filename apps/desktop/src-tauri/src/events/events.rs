//! Normalized, harness-agnostic event model.
//!
//! Every harness parses its own wire format, then maps it onto [`AgentEvent`].
//! The frontend, the on-disk log, and the session index only see this
//! vocabulary, so adding a harness means writing one mapper.
//!
//! # Log evolution rules
//!
//! Persisted `events.jsonl` outlives any single build, so:
//!
//! 1. Never remove, rename, or retype a shipped field — add alongside instead.
//! 2. Every field added from here on is `Option<T>` or `#[serde(default)]`, so
//!    new code reads old lines.
//! 3. Readers skip lines they cannot parse. Unknown payload kinds don't need
//!    that; they land in [`AgentEventPayload::Unrecognized`].

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub mod usage;

pub use usage::{ContextWindow, ModelUsage, RateLimit, Usage};

// `Harness` is a harness concept, not an event one; it lives in `crate::harness`
// and is used here only as a field type.
use crate::{harness::Harness, issues::IssueRef};

/// One normalized event: an envelope (who, when, what order, which conversation)
/// wrapping a [`payload`](Self::payload) (what happened).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub id: String,
    pub session_id: String,
    pub harness: Harness,
    /// Position in the session's event log, and the cursor for reconnecting a UI
    /// to a running session. One counter per session, shared by mapped stdout
    /// lines and events the app synthesizes itself, seeded from the persisted log
    /// on resume. Never sort by `ts` — most Claude Code events omit it.
    pub seq: u64,
    pub ts: String,
    pub turn_id: Option<String>,
    /// `None` = main conversation, `Some` = the subagent that produced this.
    pub subagent: Option<Subagent>,
    pub payload: AgentEventPayload,
    /// `None` on the emitted path — raw lines are archived separately — but
    /// always populated for [`AgentEventPayload::Unknown`], which is useless
    /// without it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

/// A running subagent, whose events interleave with the main conversation's on
/// one stdout stream.
///
/// Claude Code identifies these by `parent_tool_use_id` — the id of the tool
/// call that spawned it, so this equals the `call_id` of the corresponding
/// [`AgentEventPayload::ToolCallStarted`] and is what nests a subagent's work
/// under it. Codex uses `agent_path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub id: String,
    /// Drives the collapsed subagent card's title.
    pub label: Option<String>,
}

/// What happened.
///
/// Permission request/resolve is deliberately absent: no captured fixture shows
/// their shape, so the variants would be a guess. Add once captured.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEventPayload {
    // ---------- session / turn lifecycle ----------
    /// Claude Code emits one `init` per turn, not per session — the tool list
    /// grows between them as deferred tools load — so this carries whatever the
    /// turn was configured with. The first of a session is the session's.
    ///
    /// A turn is not the same as a prompt: the agent opens one for itself when
    /// an async subagent reports back.
    TurnStarted(SessionInfo),
    /// Not a session terminator — one arrives per completed turn.
    TurnCompleted {
        status: TurnStatus,
        stop_reason: Option<String>,
        final_text: Option<String>,
        usage: Option<Usage>,
        duration_ms: Option<u64>,
        /// The working tree as this turn finished, as a git tree id — the
        /// "after" side the changes panel diffs against once the turn is over.
        ///
        /// Without it the panel's head is always *now*, so an idle session
        /// keeps absorbing whatever later touches the same checkout — another
        /// session's turns, the user's editor — and describes them as this
        /// turn's work. Freezing the head here bounds the diff to the turn.
        ///
        /// Filled by the session layer, not the mapper: only it knows the
        /// session's cwd. `None` for a non-repo and for turns logged before
        /// the field existed, which the panel reads as "diff against now".
        #[serde(default)]
        head: Option<String>,
        /// The turn died for want of a login, so there is a cure to offer
        /// rather than only a sentence to read. Each harness decides for
        /// itself — Codex names the case outright, Claude Code only says it in
        /// prose — and the failed-turn row draws that prose either way, so a
        /// wording neither recognises costs the button, never the report.
        ///
        /// `#[serde(default)]` so turns logged before the field existed read
        /// as false, which is what a replayed log should say: no child
        /// survives a restart, so nothing on disk is still blocked on this.
        #[serde(default)]
        auth_failed: bool,
    },
    SettingsChanged(Settings),

    // ---------- conversation ----------
    UserMessage {
        text: String,
        #[serde(default)]
        images: Vec<ImageRef>,
        /// The issues this prompt was tagged with, resolved against the tracker
        /// as it was sent.
        ///
        /// A field rather than something to be parsed back out of `text`, for
        /// the reason `from` below gives: the block appended to the prompt is
        /// prose, and a transcript that recovered it with a pattern would fail
        /// silently the first time the wording moved. The bubble rebuilds the
        /// exact string from *these* and drops it only if the text ends with it.
        #[serde(default)]
        issues: Vec<IssueRef>,
        /// The working tree as it stood when this prompt was sent, as a git
        /// tree id — the "before" side the changes panel diffs against.
        ///
        /// Taken here rather than derived from the turn's own tool calls
        /// because those miss everything `Bash` does, and because an `Edit`
        /// carries only the fragment it replaced. A snapshot compares content,
        /// so several edits to one file — and any commit made mid-turn —
        /// collapse into the one net diff.
        ///
        /// `None` for a directory that isn't a repo, and for every prompt
        /// logged before this field existed. Both mean the same thing to the
        /// panel: nothing to show.
        #[serde(default)]
        baseline: Option<String>,
        /// Typed while a turn was already running, so the CLI folds it into that
        /// turn rather than starting a new one.
        ///
        /// Two transcript rules read this and both invert on it: a queued prompt
        /// does not abandon the tool calls open before it — it is not proof the
        /// turn stopped — and it does not cut a new turn, because the CLI answers
        /// it inside the running one and emits a single `result` for both.
        #[serde(default)]
        queued: bool,
        /// The Dray session that relayed this prompt, when one did.
        ///
        /// `None` — the ordinary case — means the user typed it. Carried as a
        /// field rather than named in `text` because the transcript draws the
        /// sender, and anything drawn from prose the model can write itself is
        /// a thing the model can forge.
        #[serde(default)]
        from: Option<MessageSender>,
        /// The working directory this prompt was written in, when it is not the
        /// one the session runs in now.
        ///
        /// `None` is the ordinary case and means "this session's own cwd" — the
        /// truth for every message a session logged itself, and for every
        /// message logged before this field existed.
        ///
        /// Set by [`fork`](crate::store::fork_session), because a fork is the
        /// one thing that carries a conversation into a *different* tree. An
        /// `@mention` is written relative to the tree it was typed in, so a
        /// copied one resolved against the fork's tree silently opens the fork's
        /// own copy of the file rather than the one the message named. The
        /// transcript is a record everywhere else in this app — a turn's
        /// baseline and closing tree are both frozen — and this is the same
        /// rule for the same reason.
        ///
        /// Deliberately not overwritten on a fork of a fork: the first ancestor
        /// to record one is the tree the message was actually written in.
        #[serde(default)]
        cwd: Option<String>,
    },
    AssistantText {
        /// `Some` only when this content was also streamed, naming the preview
        /// it supersedes. `None` — the common case, covering Claude Code
        /// subagents and all of Codex — means nothing was streamed and the
        /// event simply appends in `seq` order.
        #[serde(default)]
        block: Option<BlockRef>,
        text: String,
    },
    /// `encrypted` records that a reasoning step happened but its content is
    /// unreadable, which is how Codex reports reasoning it won't disclose.
    Reasoning {
        #[serde(default)]
        block: Option<BlockRef>,
        text: String,
        #[serde(default)]
        encrypted: bool,
    },

    // ---------- streaming ----------
    /// Incremental content, superseded by the committed event for the same
    /// [`BlockRef`]. See [`DeltaEvent`].
    Delta(DeltaEvent),

    // ---------- tools ----------
    ToolCallStarted {
        call_id: String,
        /// The harness's own tool name, verbatim (`"Bash"`, `"apply_patch"`).
        name: String,
        tool_type: ToolType,
        /// Always an object. JSON-encoded argument strings are parsed here;
        /// unparseable input becomes `{"_unparsed": "…"}` rather than dropped.
        input: Value,
        /// Input that isn't JSON at all — Codex's `custom_tool_call.input` is raw
        /// JS source.
        raw_input: Option<String>,
        title: Option<String>,
    },
    ToolCallCompleted {
        call_id: String,
        result: ToolResult,
    },
    /// Structured file changes. Codex reports these first-class; Claude Code
    /// does not, so its edits currently surface as ordinary
    /// [`ToolType::FileEdit`] calls.
    FileEdits {
        call_id: Option<String>,
        #[serde(default)]
        edits: Vec<FileEdit>,
    },

    // ---------- subagents ----------
    /// Which subagent these describe is on the envelope's [`Subagent`], as it is
    /// for every other event a subagent produces. `agent_id` is the harness's
    /// own internal handle — a *different* id, not a correlation key.
    SubagentStarted {
        agent_id: String,
        label: String,
        description: Option<String>,
        prompt: Option<String>,
    },
    SubagentProgress {
        agent_id: String,
        /// What the subagent is doing right now — Claude Code rewrites this per
        /// progress event, so it drives a live status line without expanding
        /// the subagent's own events.
        description: Option<String>,
        last_tool: Option<String>,
        usage: Option<Usage>,
    },
    SubagentCompleted {
        agent_id: String,
        status: String,
        summary: Option<String>,
        usage: Option<Usage>,
    },
    /// The full set of outstanding background tasks, republished whole on every
    /// change — an empty list means the session's async work has drained.
    /// Latest wins; consumers keep the last one rather than accumulating.
    ///
    /// Not redundant with the subagent lifecycle events above: those describe
    /// one task's own progress, this says how many are still open — which is
    /// half of "is the session done", since a turn's result can arrive while
    /// this is non-empty.
    BackgroundTasksChanged {
        #[serde(default)]
        tasks: Vec<BackgroundTask>,
    },

    // ---------- accounting / control ----------
    /// Debounce these in the mapper: harnesses emit token counts far more often
    /// than the figures meaningfully change.
    UsageUpdate(Usage),
    /// The plan's usage limit, emitted **only when there is something to act
    /// on** — the limit is reached, or requests have moved to usage billing. A
    /// session running comfortably under its limit reports the fact constantly
    /// and produces none of these.
    ///
    /// The status vocabulary is only partly known (`allowed` is the one value
    /// captured), so the wire's own strings are carried through rather than
    /// collapsed into a boolean the mapper would have to guess at.
    RateLimited {
        /// `allowed` is the steady state and never reaches here.
        status: Option<String>,
        /// When the window rolls over, RFC3339 — converted from the unix
        /// seconds the wire sends.
        resets_at: Option<String>,
        /// Which window. `five_hour` observed, and at least one longer window
        /// is believed to exist; not branched on anywhere.
        limit_type: Option<String>,
        /// Whether overage is available, which is what separates "blocked
        /// until it resets" from "still working, now billed as usage".
        overage_status: Option<String>,
        /// Requests are already being billed as usage rather than covered.
        #[serde(default)]
        using_overage: bool,
        /// Why overage isn't available — `org_level_disabled` observed.
        overage_disabled_reason: Option<String>,
    },
    // ---------- permissions ----------
    /// A tool call the agent cannot make without an answer. Unlike every other
    /// payload this one is a *question*: the harness is blocked until the app
    /// replies, so a consumer that renders it and offers no way to answer stalls
    /// the session rather than merely under-reporting it.
    ///
    /// [`options`](Self::PermissionRequested::options) is the whole answer
    /// surface. The harness composes it — "allow once" and "deny" always,
    /// plus whatever standing rules *this* call could establish — because what a
    /// rule may say is wire knowledge, not UI knowledge.
    PermissionRequested {
        /// Correlates the reply. Also what
        /// [`PermissionDecided`](Self::PermissionDecided) joins on, which is how
        /// a reloaded transcript knows an answered request from a live one.
        request_id: String,
        /// The call being held. The matching
        /// [`ToolCallStarted`](Self::ToolCallStarted) is already in the
        /// transcript, so a renderer can show the request against the call
        /// rather than repeating its arguments.
        tool_use_id: String,
        tool_name: String,
        /// Preferred over `tool_name` for display when present.
        display_name: Option<String>,
        title: Option<String>,
        description: Option<String>,
        input: Value,
        /// The path that caused a working-directory escalation.
        blocked_path: Option<String>,
        /// Why this escalated, in prose. May carry ANSI escapes — sanitize
        /// before rendering.
        decision_reason: Option<String>,
        /// Machine-readable counterpart to `decision_reason`: `safetyCheck`,
        /// `rule`, `mode`, `workingDir` and others. Lets a consumer treat a
        /// safety escalation differently without parsing prose.
        decision_reason_type: Option<String>,
        /// Set when a subagent made the call rather than the main thread.
        ///
        /// Not a correlation key — it is the harness's own handle and matches no
        /// other id — so it answers exactly one question: whether the call being
        /// consented to is visible to the reader. A main-thread request renders
        /// directly under its own `ToolCallStarted` row; a subagent's renders
        /// with that row filed away in a panel, so the card has to carry the
        /// arguments itself or it asks about something invisible.
        agent_id: Option<String>,
        options: Vec<PermissionOption>,
    },
    /// The agent asking the user something in its own words. Blocks the harness
    /// exactly like a [`PermissionRequested`](Self::PermissionRequested), shares
    /// its `request_id` space, and is retired by the same
    /// [`PermissionDecided`](Self::PermissionDecided) — it arrives on the same
    /// wire channel, and only what the user is shown differs.
    ///
    /// What differs is that there is no allow/deny in it. The call may always
    /// run; the answer *is* the reply. So this payload carries no `options`, and
    /// a consumer that renders it must offer a form rather than buttons —
    /// approving it with nothing filled in tells the agent it was ignored.
    QuestionsAsked {
        request_id: String,
        /// The `AskUserQuestion` call being held. Its own row is already in the
        /// transcript and will show the answers once it completes.
        tool_use_id: String,
        /// One to four, per the tool's own schema.
        questions: Vec<Question>,
    },
    /// How a [`PermissionRequested`](Self::PermissionRequested) was answered.
    /// Minted by the app when it replies, not by the harness — the CLI's own ack
    /// carries nothing worth keeping — so the transcript survives a reload with
    /// the outcome intact.
    PermissionDecided {
        request_id: String,
        tool_use_id: String,
        behavior: PermissionBehavior,
        /// The chosen option's label, so the transcript reads back as what the
        /// user actually picked rather than a bare allow/deny.
        label: String,
        /// True when the app answered on its own — an unsupported request
        /// subtype, or a shutdown clearing what it could not ask about.
        #[serde(default)]
        automatic: bool,
    },
    /// A call refused with no question asked, because none could be. The
    /// working-directory sandbox is the durable cause; a permission mode with no
    /// answer channel is the other, and that one disappears once the harness can
    /// ask.
    PermissionDenied {
        tool_name: String,
        tool_use_id: String,
        message: String,
    },

    Hook {
        name: String,
        event: String,
        phase: HookPhase,
        exit_code: Option<i32>,
        outcome: Option<String>,
    },
    /// The harness has sent a request to the model and is waiting on its first
    /// token. Drives the working indicator and nothing else.
    ///
    /// Fires at the top of a turn *and* after every tool result, which is what
    /// makes it worth carrying: the gap after a tool call is where the
    /// transcript otherwise sits blank, and this marks its start within 30ms.
    /// Measured from here to the first `content_block_start`: ~1s for a text
    /// block, a 3s median (1.7–7.5s) for a thinking one.
    ModelRequestStarted,
    /// A compaction is under way. Drives a live indicator and nothing else —
    /// the counts only exist once it finishes.
    ContextCompactionStarted,
    /// A model request failed and is being tried again. Drives a live
    /// indicator, in the same slot and for the same reason a compaction does:
    /// the turn is genuinely open and drawing nothing, and without this the
    /// wait is indistinguishable from a slow model.
    ///
    /// `attempt` of `max_retries` is the whole message. `status` and `reason`
    /// are carried but usually absent — the harness names a cause on well
    /// under half its retries — so a reader has to render without them.
    ApiRetry {
        attempt: u32,
        max_retries: u32,
        /// HTTP status, where the harness knew one. 529 (overloaded) and 500
        /// are the only two observed.
        status: Option<u32>,
        /// The harness's own word for the cause: `overloaded`, `server_error`,
        /// or `unknown`. The last is the majority case and says nothing, so it
        /// is dropped on the way in rather than shown.
        reason: Option<String>,
    },
    /// A compaction finished, and the transcript before it no longer reaches the
    /// model. Both counts are optional so an unfamiliar wire shape still closes
    /// the indicator; the UI drops the saving rather than reporting a wrong one.
    ContextCompacted {
        /// `manual` or `auto`.
        trigger: Option<String>,
        pre_tokens: Option<u64>,
        post_tokens: Option<u64>,
        duration_ms: Option<u64>,
    },
    Error {
        source: ErrorSource,
        message: String,
        #[serde(default)]
        fatal: bool,
    },
    /// A line we parsed but could not classify. Surfacing these beats silently
    /// dropping them.
    Unknown {
        harness_type: String,
    },

    /// A payload `kind` this build doesn't know — a log written by a newer
    /// version. Produced by the deserializer, never a mapper; the envelope
    /// survives so the event keeps its place. Distinct from
    /// [`Unknown`](Self::Unknown), a harness line the mapper couldn't classify.
    #[serde(other)]
    Unrecognized,
}

impl AgentEventPayload {
    /// Every archived picture this payload points at. Both arms hold paths under
    /// `~/.dray/attachments/<session-id>/`, so anything moving a log between
    /// sessions has to repoint them — see
    /// [`copy_session_log`](crate::store::copy_session_log).
    pub fn images_mut(&mut self) -> &mut [ImageRef] {
        match self {
            Self::UserMessage { images, .. } => images,
            Self::ToolCallCompleted { result, .. } => &mut result.images,
            _ => &mut [],
        }
    }
}

/// One answer the user can give to a [permission
/// request](AgentEventPayload::PermissionRequested).
///
/// Deliberately carries no wire payload. The standing rule an option would
/// apply is the harness's to compose and the harness's to send, so the app
/// replies with [`id`](Self::id) alone and the harness resolves it — which keeps
/// a rule that grants more than it appears to from ever being assembled on the
/// UI side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    /// Unique within its request, and the whole of what the app sends back.
    pub id: String,
    pub label: String,
    pub kind: PermissionOptionKind,
    /// Whether picking this lets the call run. Both `Deny` kinds carry
    /// [`Deny`](PermissionBehavior::Deny); everything else allows.
    pub behavior: PermissionBehavior,
}

/// What an option *does*, for a renderer that wants to group or order them.
/// The set is closed on purpose: an unmappable suggestion is dropped rather
/// than shown as a button whose effect can't be described.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    /// Allow this call and nothing else. Always offered, always first.
    Once,
    /// Allow this and everything matching a standing rule.
    AlwaysRule,
    /// Allow this and everything under a directory.
    AlwaysDirectory,
    /// Allow this and switch the session's stance so the next one doesn't ask.
    SwitchMode,
    /// Refuse. Always offered, always last.
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum PermissionBehavior {
    Allow,
    Deny,
}

/// One question from a [`QuestionsAsked`](AgentEventPayload::QuestionsAsked).
///
/// [`question`](Self::question) is both the prompt and the key its answer is
/// filed under, so the text has to survive the round trip unchanged — the
/// harness matches on it verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    /// A short chip label for the question — "Indentation", "Auth method".
    pub header: Option<String>,
    /// Whether several options may be picked, in which case the answer is one
    /// comma-separated string rather than a list.
    pub multi_select: bool,
    /// Two to four, per the tool's own schema. Never exhaustive: the harness
    /// promises the user a free-text box alongside them, and instructs the model
    /// not to offer an "Other" option because of it — so a renderer that shows
    /// only these takes an answer away.
    pub options: Vec<QuestionOption>,
    /// Whether an answer outside [`options`](Self::options) is one the asker can
    /// take.
    ///
    /// True for `AskUserQuestion`, where the CLI promises the user a box and
    /// tells the model not to offer an "Other" option because of it. False for
    /// pi's `select` and `confirm`, which are a closed list and a boolean: the
    /// extension that asked will be handed whatever comes back, and a typed
    /// sentence where it expected one of its own labels is an answer it cannot
    /// use.
    pub free_text: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    /// What the user picks, and what travels back as the answer — the harness
    /// has no option ids, so the label is the value.
    pub label: String,
    pub description: Option<String>,
    /// Markdown the harness expects shown in a monospace box. Single-select
    /// questions only.
    pub preview: Option<String>,
}

/// One outstanding background task. The harness's wire shape is snake_case, so
/// the parser keeps its own struct and the mapper converts — sharing this one
/// would break on `task_id` vs `taskId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    pub task_id: String,
    /// Free-form kind string — `local_agent` observed, set undocumented.
    pub task_type: String,
    pub description: String,
}

/// How a turn ended. Claude Code reports this as `is_error` on its result
/// event; Codex live emits `turn.completed` (a failed turn is uncaptured so
/// far). A user-abort outcome likely deserves its own variant once one has been
/// captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Success,
    Error,
}

/// Joins streamed content to its committed counterpart. A message is often
/// `[text, tool_use, …]` and each block arrives as its own event; Claude Code's
/// committed events carry no index, so the mapper derives one by counting blocks
/// per `message_id` in arrival order.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct BlockRef {
    pub message_id: String,
    pub index: u32,
}

/// Incremental content for a block.
///
/// **Deltas are a preview, never the source of truth**: the committed event for
/// the same [`BlockRef`] supersedes whatever they accumulated. Absent deltas are
/// the common case — Codex emits none, Claude Code none for subagent output — so
/// consumers must render correctly without them.
/// Tagged on `delta`, not `type`: [`AgentEventPayload::Delta`] is a newtype
/// variant, so these fields flatten into the payload object alongside its own
/// `type` tag. Two tags of the same name serialize but never deserialize.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(
    tag = "delta",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DeltaEvent {
    BlockStart {
        block: BlockRef,
        block_type: BlockType,
    },
    /// Carries *thinking* text too — the shapes are identical and the block's
    /// [`BlockStart`](Self::BlockStart) already said which kind it is, so a
    /// second variant would duplicate that fact.
    TextDelta {
        block: BlockRef,
        text: String,
    },
    /// A fragment of a tool call's JSON arguments, unparseable until every
    /// fragment for the block has been concatenated.
    InputDelta {
        block: BlockRef,
        partial_json: String,
    },
    BlockStop {
        block: BlockRef,
    },
}

/// A tool call's identity rides here rather than on [`BlockRef`], which stays a
/// cheap map key. It arrives before any arguments have streamed, so the UI can
/// label the call while [`DeltaEvent::InputDelta`] fragments are still landing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BlockType {
    Text,
    Thinking,
    ToolUse { id: String, name: String },
}

/// A rendering hint — which icon and component to use. Nothing depends on this
/// for correctness, and [`ToolType::Other`] must always render acceptably.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum ToolType {
    Shell,
    FileRead,
    FileEdit,
    Search,
    Web,
    Mcp,
    SubagentSpawn,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// Result content flattened to text; harnesses vary between a bare string
    /// and an array of blocks.
    pub text: String,
    /// Harnesses routinely omit the error flag on success, so this defaults to
    /// `false` rather than being treated as unknown.
    #[serde(default)]
    pub is_error: bool,
    /// The full result payload when the harness supplies a structured one.
    pub structured: Option<Value>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    /// Pictures the tool handed back — a `Read` of a screenshot, an MCP tool
    /// that answers in images. Archived under `~/.dray/attachments` before the
    /// event is written, so this carries a path and never the bytes: the CLI
    /// sends the same image twice on one line and a session of screenshots was
    /// 12MB of base64 in a 14MB log.
    #[serde(default)]
    pub images: Vec<ImageRef>,
}

/// Who relayed a prompt into this session, for a `user_message` the user did
/// not type.
///
/// Both fields are needed and neither substitutes for the other: the title is
/// what the reader recognizes — it is what the sidebar shows — and the id is
/// what the transcript navigates to when they click it.
///
/// Persisted, unlike most of what the app synthesizes: the transcript is
/// replayed from the log, so attribution that lived only in memory would be
/// gone on the next open.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct MessageSender {
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    pub path: String,
    pub change: FileChange,
    pub unified_diff: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum FileChange {
    Add,
    Update,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum HookPhase {
    Started,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum ErrorSource {
    /// The harness reported an error of its own.
    Harness,
    /// We failed to parse or map the line.
    Parser,
    /// The child process failed — spawn, stderr, unexpected exit.
    Process,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub path: Option<String>,
    pub url: Option<String>,
    pub mime_type: Option<String>,
}

/// Session-level facts, known at startup.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase", default)]
pub struct SessionInfo {
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub harness_version: Option<String>,
    pub tools: Vec<String>,
    pub mcp_servers: Vec<McpServer>,
    pub subagent_types: Vec<String>,
    pub settings: Option<Settings>,
}

/// Shared with the harness parsers rather than duplicated — the wire shape
/// matches, so they deserialize straight into this.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// Free-form: `connected`, `pending`, `needs-auth` observed, set undocumented.
    pub status: String,
}

/// Settings that can change mid-session, so they arrive as events rather than
/// living only on [`SessionInfo`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub model: Option<String>,
    /// How much the agent may do without asking. Modeled on Claude Code's
    /// `permissionMode`, which is a closed set; Codex's `approval_policy` maps
    /// onto these, gaining variants if it turns out to need them.
    pub approval_policy: Option<PermissionMode>,
    pub sandbox: Option<String>,
    pub writable_roots: Vec<String>,
    pub network_access: Option<bool>,
    pub fast_mode: Option<String>,
}

/// Permission stance a session *runs under*, in roughly increasing order of
/// autonomy. Every variant is settable, so this is what the app stores and
/// sends — see [`PermissionMode`] for the wider set the CLI reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub enum ApprovalPolicy {
    /// Read-only: research and propose, change nothing.
    Plan,
    /// Prompt per action.
    Manual,
    /// Prompt per action, but only where the sandbox cannot answer for itself.
    ///
    /// `acceptEdits` was a sixth variant and was removed: it auto-approved
    /// edits while still asking about commands, which is a narrower promise
    /// than this one and a hard difference to state on a button. The alias is
    /// how sessions started under it still read — as this, the nearest stance
    /// that exists — rather than failing the whole index entry.
    #[default]
    #[serde(alias = "acceptEdits")]
    Auto,
    DontAsk,
    /// Every permission check bypassed.
    BypassPermissions,
}

impl ApprovalPolicy {
    /// The `--permission-mode` flag value. Total, unlike the inbound direction:
    /// the frontend always sends a real mode, so there is nothing to omit.
    pub fn as_arg(self) -> &'static str {
        match self {
            ApprovalPolicy::Plan => "plan",
            ApprovalPolicy::Manual => "manual",
            ApprovalPolicy::Auto => "auto",
            ApprovalPolicy::DontAsk => "dontAsk",
            ApprovalPolicy::BypassPermissions => "bypassPermissions",
        }
    }
}

/// What the CLI *reports* in `system/init`, which is a wider set than it
/// accepts: `default` names the harness's own prompting stance, and
/// `--permission-mode` rejects that name while offering `manual` for the same
/// thing. Kept separate from [`ApprovalPolicy`] rather than remapped, so a
/// round trip can't quietly turn one into the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    #[default]
    Default,
    Plan,
    Manual,
    AcceptEdits,
    Auto,
    DontAsk,
    BypassPermissions,
}

/// Hand-rolled to avoid a date dependency for one display-only field; `seq`, not
/// `ts`, is the ordering key.
pub fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();

    rfc3339(now.as_secs() as i64, now.subsec_millis())
}

/// Unix seconds → RFC3339, for wire fields carrying an epoch timestamp where
/// this model uses strings — Claude Code's `resetsAt`, notably.
pub fn rfc3339_from_unix(secs: i64) -> String {
    rfc3339(secs, 0)
}

fn rfc3339(secs: i64, millis: u32) -> String {
    // Days since epoch → civil date, per Howard Hinnant's algorithm.
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60,
        millis
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rule 2: new code reads old lines. Flags and collections deserialize when
    /// absent instead of failing the line.
    #[test]
    fn old_lines_without_defaulted_fields_still_parse() {
        let v: AgentEventPayload =
            serde_json::from_str(r#"{"type":"user_message","text":"hi"}"#).unwrap();
        assert!(matches!(
            v,
            // `baseline`, `queued`, `from`, `issues` and `cwd` default too:
            // every prompt logged before each of those existed must not fail
            // the line.
            AgentEventPayload::UserMessage {
                ref text,
                ref images,
                ref baseline,
                queued,
                ref from,
                ref issues,
                ref cwd,
            } if text == "hi"
                && images.is_empty()
                && baseline.is_none()
                && cwd.is_none()
                && !queued
                && from.is_none()
                && issues.is_empty()
        ));

        let v: AgentEventPayload = serde_json::from_str(
            r#"{"type":"reasoning","block":{"messageId":"m","index":0},"text":"t"}"#,
        )
        .unwrap();
        assert!(matches!(
            v,
            AgentEventPayload::Reasoning {
                encrypted: false,
                ..
            }
        ));
    }

    /// Rule 1 corollary: old code reads new lines. Unknown fields are ignored,
    /// and an unknown payload kind degrades to `Unrecognized` instead of
    /// failing the whole line.
    #[test]
    fn new_lines_degrade_gracefully() {
        let v: AgentEventPayload = serde_json::from_str(
            r#"{"type":"turn_completed","status":"success","someFutureField":42}"#,
        )
        .unwrap();
        assert!(matches!(
            v,
            AgentEventPayload::TurnCompleted {
                status: TurnStatus::Success,
                ..
            }
        ));

        let v: AgentEventPayload =
            serde_json::from_str(r#"{"type":"from_the_future","payload":9001}"#).unwrap();
        assert!(matches!(v, AgentEventPayload::Unrecognized));
    }

    /// The nested tag-in-tag shape (`kind` outer, `type` inner) survives a
    /// round trip.
    #[test]
    fn delta_round_trips() {
        let d = AgentEventPayload::Delta(DeltaEvent::TextDelta {
            block: BlockRef {
                message_id: "m".into(),
                index: 0,
            },
            text: "he".into(),
        });
        let s = serde_json::to_string(&d).unwrap();
        assert!(s.contains(r#""type":"delta""#) && s.contains(r#""delta":"text_delta""#));
        let back: AgentEventPayload = serde_json::from_str(&s).unwrap();
        assert_eq!(s, serde_json::to_string(&back).unwrap());
    }

    /// Every settable mode's wire name is also its flag value, so persisting a
    /// mode and passing it to `--permission-mode` can't drift apart.
    #[test]
    fn every_settable_policy_matches_its_cli_arg() {
        for p in [
            ApprovalPolicy::Plan,
            ApprovalPolicy::Manual,
            ApprovalPolicy::Auto,
            ApprovalPolicy::DontAsk,
            ApprovalPolicy::BypassPermissions,
        ] {
            let json = serde_json::to_string(&p).unwrap();
            assert_eq!(json, format!("\"{}\"", p.as_arg()));
        }
    }

    /// `acceptEdits` was a settable stance and is not one any more. Sessions
    /// started under it are on disk, and one index entry that fails to
    /// deserialize takes the whole file with it — so the name has to keep
    /// reading, as the nearest stance that still exists.
    #[test]
    fn a_retired_stance_still_reads_back() {
        let read: ApprovalPolicy = serde_json::from_str("\"acceptEdits\"").unwrap();
        assert_eq!(read, ApprovalPolicy::Auto);
        // One direction only: nothing writes the old name again.
        assert_eq!(serde_json::to_string(&read).unwrap(), "\"auto\"");
    }

    /// The CLI reports `default` in `system/init` even though its flag won't
    /// take it. `PermissionMode` exists to hold that variant; `ApprovalPolicy`
    /// must not gain it back, or an unsettable mode reaches the flag.
    ///
    /// Verified against v2.1.224: `plan`, `acceptEdits`, `bypassPermissions`
    /// and `dontAsk` each report themselves, while both `auto` and `manual`
    /// report `default` — so it names a real stance rather than an omitted
    /// flag, and the init event can't say which of the two is in effect.
    #[test]
    fn reported_default_parses_as_permission_mode_only() {
        let m: PermissionMode = serde_json::from_str(r#""default""#).unwrap();
        assert_eq!(m, PermissionMode::Default);

        assert!(serde_json::from_str::<ApprovalPolicy>(r#""default""#).is_err());
    }

    /// An index entry written before `permissionMode` existed reads as `auto`,
    /// which is also the composer's default — so old sessions resume under the
    /// mode the picker would show for them.
    #[test]
    fn default_policy_is_auto() {
        assert_eq!(ApprovalPolicy::default(), ApprovalPolicy::Auto);
    }
}
