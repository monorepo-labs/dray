//! Grok Build's ACP wire format, typed.
//!
//! Newline JSON-RPC 2.0, the same envelope `fx acp` speaks, so
//! [`rpc`](crate::harness::rpc) splits a line into a method and a params object
//! and this only names what is inside. Same conventions as every parser here:
//! an enum that can grow carries `#[serde(other)]`, a field the agent may omit
//! carries `#[serde(default)]`, and a shape not modelled costs one field or one
//! line and never the connection.
//!
//! Every shape was read off a live `grok agent --no-leader stdio` (Grok Build
//! 1.0.40) — see `fixtures/README.md` and `apps/desktop/GROK-PLAN.md`.
//!
//! **Two notification streams carry one vocabulary.** ACP's own kinds arrive on
//! `session/update`; grok's extensions arrive on `_x.ai/session_notification`
//! inside the same `{sessionId, update: {sessionUpdate, …}}` envelope. A reader
//! listening to the first alone never sees `subagent_*`, `background_tasks`,
//! `turn_completed` or `auto_compact_completed` at all, so both methods are
//! parsed here into one [`GrokUpdate`].

use serde::Deserialize;
use serde_json::Value;

use crate::harness::null_as_default;
pub use crate::harness::acp::{ContentBlock, PermissionChoice, ToolContent, ToolKind, ToolStatus};

/// A line the mapper acts on, or a marker saying why it does not.
pub enum GrokEvent {
    /// An update belonging to **this** session. The read loop is what checks
    /// that — see [`UpdateNotification::session_id`].
    Update(GrokUpdate),
    /// The answer to `session/prompt`, which is how a turn ends: grok sends no
    /// turn-completed line the client can wait on, the request itself blocks
    /// for the whole turn.
    PromptDone(Box<PromptResponse>),
    /// `session/prompt` answered with a JSON-RPC error — no auth, a refused
    /// model. The turn never opened.
    PromptFailed { message: String },
    /// A method this build has never seen. Filed, and costs nothing else.
    Unknown,
}

/// The envelope both notification methods share.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotification {
    /// **Load-bearing, and the one field a reader must not ignore.** A
    /// `spawn_subagent` child streams its whole transcript — thoughts, tool
    /// calls, messages — down the *parent's* pipe under its own session id: 113
    /// updates against the parent's 154 in one capture. Unfiltered, the child's
    /// thinking is painted into the parent's chat.
    #[serde(default)]
    pub session_id: String,
    pub update: GrokUpdate,
}

/// One streamed update, tagged on `sessionUpdate`.
///
/// The unit variants are kinds seen and deliberately drawn as nothing:
/// `user_message_chunk` is `session/load`'s replay of a prompt Dray already
/// logged, the hook and delta-chunk kinds say nothing a row could show, and
/// `turn_completed` restates what the prompt response already carries. Naming
/// them keeps [`Self::Unknown`] — and so the failure log — a signal.
#[derive(Debug, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum GrokUpdate {
    AgentMessageChunk {
        content: ContentBlock,
    },
    AgentThoughtChunk {
        content: ContentBlock,
    },
    /// The opening line for a call. **Its `title` is the bare tool name** —
    /// `"write"` — where the first `tool_call_update` behind it carries the
    /// sentence (`"Write `/path`"`) *and* the ACP `kind`. So the tool is read
    /// off `_meta["x.ai/tool"].name` and never off `title`, which would draw
    /// the wrong thing for a frame.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: ToolKind,
        /// Present only on the `session/load` replay, which Dray never calls —
        /// live, a `tool_call` carries no status at all.
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(default)]
        raw_input: Option<Value>,
        #[serde(default, rename = "_meta")]
        meta: ToolMeta,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(default, deserialize_with = "null_as_default")]
        content: Vec<ToolContent>,
        #[serde(default)]
        raw_output: Option<RawOutput>,
    },
    /// grok's title, written by the model out of band and arriving mid-turn —
    /// nothing waits on it, which is the whole difference from fx.
    SessionInfoUpdate {
        #[serde(default)]
        title: Option<String>,
    },
    /// Every command behind a slash: grok's own built-ins plus every skill it
    /// discovered, including the reader's `~/.claude/skills`.
    #[serde(rename_all = "camelCase")]
    AvailableCommandsUpdate {
        #[serde(default, deserialize_with = "null_as_default")]
        available_commands: Vec<AvailableCommand>,
    },

    // `_x.ai/session_notification` kinds from here.
    /// The whole live task set, republished on every change.
    BackgroundTasks {
        #[serde(default, deserialize_with = "null_as_default")]
        tasks: Vec<GrokTask>,
    },
    SubagentSpawned(Box<SubagentSpawned>),
    SubagentProgress,
    SubagentFinished(Box<SubagentFinished>),
    /// The one compaction event there is — no start, no boundary. `0` for both
    /// token figures is ordinary: it fires even where nothing was dropped.
    AutoCompactCompleted {
        #[serde(default)]
        tokens_before: Option<u64>,
        #[serde(default)]
        tokens_after: Option<u64>,
    },

    // Seen, and drawn as nothing.
    UserMessageChunk,
    ToolCallDeltaChunk,
    ResponseCompleted,
    TurnCompleted,
    ModelChanged,
    SessionSummaryGenerated,
    HookRunStarted,
    HookExecution,
    PendingInteraction,
    InteractionResolved,
    TaskBackgrounded,
    ConfigOptionUpdate,
    Plan,
    #[serde(other)]
    Unknown,
}

/// grok's own account of a tool, hung off `_meta` under a namespaced key.
///
/// The clean discriminator for everything the mapper branches on: `name` is the
/// tool grok ran and `kind` its class, where ACP's own `kind` arrives a line
/// late and calls `ask_user_question` `other`.
#[derive(Debug, Default, Deserialize)]
pub struct ToolMeta {
    #[serde(default, rename = "x.ai/tool")]
    pub tool: Option<XaiTool>,
}

impl ToolMeta {
    pub fn name(&self) -> Option<&str> {
        self.tool.as_ref().map(|t| t.name.as_str())
    }

    pub fn kind(&self) -> Option<&str> {
        self.tool.as_ref().map(|t| t.kind.as_str())
    }
}

#[derive(Debug, Deserialize)]
pub struct XaiTool {
    #[serde(default)]
    pub name: String,
    /// grok's own class — `write`, `execute`, `ask_user`, `task`, `read`.
    #[serde(default)]
    pub kind: String,
}

/// A finished call's structured result, tagged on `type`.
///
/// Only the shell arm carries anything the row needs. The `output` field beside
/// `output_for_prompt` is a **byte array**, not a string, and is deliberately
/// unread — `output_for_prompt` is the decoded text.
///
/// **Snake case, with no `rename_all`, and that is grok's wire rather than an
/// oversight.** The ACP envelope around this is camelCase (`toolCallId`,
/// `rawOutput`, `sessionUpdate`) and everything grok puts *inside* its own
/// payloads is snake. Renaming here costs no error and no failed line: every
/// field simply reads `None` for ever, so a shell row loses its exit code and
/// its stdout falls back to whatever the model wrote about the call. Pinned by
/// [`tests::the_payload_inside_the_envelope_is_snake_case`].
#[derive(Debug, Default, Clone, Deserialize)]
pub struct RawOutput {
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub output_for_prompt: Option<String>,
}

/// One outstanding background task, as `background_tasks` republishes it.
///
/// `task_id` is **not** the `tool_call_id` that started it: the spawning call
/// closes `completed` the moment the task detaches.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct GrokTask {
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SubagentSpawned {
    #[serde(default)]
    pub subagent_id: String,
    #[serde(default)]
    pub subagent_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SubagentFinished {
    #[serde(default)]
    pub subagent_id: String,
    #[serde(default)]
    pub status: Option<String>,
    /// The child's whole report. It is why the panel needs nothing from the
    /// child's own stream, which is dropped on its session id.
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub tokens_used: Option<u64>,
}

/// One row of `available_commands_update`.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct AvailableCommand {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input: Option<CommandInput>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct CommandInput {
    #[serde(default)]
    pub hint: Option<String>,
}

/// The `session/prompt` response.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    /// `end_turn`, `cancelled`; the docs also list `max_tokens`,
    /// `max_turn_requests` and `refusal`.
    #[serde(default)]
    pub stop_reason: String,
    #[serde(default, rename = "_meta")]
    pub meta: PromptMeta,
}

/// The accounting the reply carries, and **the two token figures are different
/// questions**.
///
/// `total_tokens` at this level is the session's *occupancy* — 21598 then 22429
/// across two turns of one session. The `input_tokens`/`output_tokens` beside it
/// are this **turn's** figures, where the nested `usage` object is cumulative
/// over the session (`numTurns: 2`, both turns summed), the trap Claude Code's
/// `result.usage` sets one harness over. So the nested object is deliberately
/// unread.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMeta {
    #[serde(default)]
    pub model_id: Option<String>,
    /// Occupancy. **A `0` here means "keep the last reading", not "empty"**:
    /// the turn that runs `/compact` answers `totalTokens: 0` while
    /// `inputTokens` beside it still reads the real figure, so a ring believing
    /// it snaps to nothing.
    #[serde(default)]
    pub total_tokens: Option<u64>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cached_read_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning_tokens: Option<u64>,
}

/// `session/request_permission`'s params. The options are grok's own and go back
/// as they came — see [`permissions`](super::permissions).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    #[serde(default)]
    pub tool_call: ToolCallRef,
    #[serde(default)]
    pub options: Vec<PermissionChoice>,
}

/// The call a permission request names.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRef {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub raw_input: Option<Value>,
    #[serde(default, rename = "_meta")]
    pub meta: ToolMeta,
}

/// `_x.ai/ask_user_question`'s params — its own client request, not a
/// permission, and answered inside the result rather than by a button.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestion {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub questions: Vec<AskedQuestion>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskedQuestion {
    #[serde(default)]
    pub question: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub options: Vec<AskedOption>,
    /// Sent as `null` rather than omitted for a single-select question.
    #[serde(default, deserialize_with = "null_as_default")]
    pub multi_select: bool,
}

#[derive(Debug, Default, Deserialize)]
pub struct AskedOption {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// `_x.ai/exit_plan_mode`'s params. A client request bracketed by
/// `pending_interaction {kind: plan_approval}`, so it blocks the turn exactly as
/// a permission does and must be answered.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPlanMode {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub plan_content: String,
}

/// Types one notification off the connection, whichever of grok's two channels
/// carried it.
pub fn parse_notification(method: &str, params: Value) -> Result<UpdateNotification, ParseOutcome> {
    match method {
        "session/update" | "_x.ai/session_notification" => {
            serde_json::from_value(params).map_err(ParseOutcome::Malformed)
        }
        // Standalone methods with no `update` envelope. Each is real traffic
        // grok sends on every session and none of it draws a row, so they are
        // named rather than left to fill the failure log: session setup phases,
        // the sidebar-ish session list, MCP progress, the settings and model
        // caches, the prompt's own completion notice (the JSON-RPC reply is
        // what Dray settles a turn on), and the `session/load` replay channel.
        _ if is_quiet(method) => Err(ParseOutcome::Ignored),
        _ => Err(ParseOutcome::Unknown),
    }
}

/// Why a notification produced no update.
pub enum ParseOutcome {
    /// Modelled and deliberately drawn as nothing.
    Ignored,
    /// A method this build has never seen — worth filing.
    Unknown,
    Malformed(serde_json::Error),
}

/// Whether this method is one of grok's side channels that says nothing a
/// transcript could show.
///
/// A prefix list rather than an exact one because two of these are families:
/// `_x.ai/mcp/*` is six methods on a machine with servers configured, and
/// `_x.ai/session/*` is three. Written to under-match — a method missed is one
/// line in the failure log, where a prefix too wide silently swallows the next
/// thing grok adds that Dray ought to draw.
fn is_quiet(method: &str) -> bool {
    const QUIET: &[&str] = &[
        "_x.ai/session/setup",
        "_x.ai/session/prompt_complete",
        "_x.ai/session/update",
        "_x.ai/sessions/changed",
        "_x.ai/queue/changed",
        "_x.ai/models/update",
        "_x.ai/settings/update",
        "_x.ai/announcements/update",
        "_x.ai/task_backgrounded",
        // Both spellings: grok punctuates its MCP methods two ways, and
        // `_x.ai/mcp_initialized` — a tool count and an elapsed time, once per
        // session — landed in the failure log for want of the underscore.
        "_x.ai/mcp/",
        "_x.ai/mcp_",
    ];

    QUIET.iter().any(|quiet| method.starts_with(quiet))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// grok's extensions ride a second method with the same envelope, and a
    /// reader on `session/update` alone sees none of them — no subagent, no
    /// background task, no compaction.
    #[test]
    fn both_notification_methods_carry_the_same_envelope() {
        let params = json!({
            "sessionId": "s1",
            "update": {"sessionUpdate": "auto_compact_completed",
                       "tokens_before": 100, "tokens_after": 40},
        });

        let note = parse_notification("_x.ai/session_notification", params)
            .unwrap_or_else(|_| panic!("grok's own channel is parsed"));
        assert_eq!(note.session_id, "s1");
        assert!(matches!(
            note.update,
            GrokUpdate::AutoCompactCompleted {
                tokens_after: Some(40),
                ..
            }
        ));
    }

    /// grok's wire mixes cases and `rawOutput` is where it bites: the envelope
    /// around it is camelCase and its own fields are snake, so a `rename_all`
    /// there reads every one as `None` — no error, no failed line, just a shell
    /// row with no exit code whose text falls back to the model's description of
    /// the call. Read straight off the captured shell result, which is the only
    /// thing that can keep this honest.
    #[test]
    fn the_payload_inside_the_envelope_is_snake_case() {
        let update = include_str!("fixtures/live_turn.jsonl")
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line.get(3..)?).ok())
            .filter_map(|line| {
                let update = line.pointer("/params/update")?.clone();
                serde_json::from_value::<GrokUpdate>(update).ok()
            })
            .find_map(|update| match update {
                GrokUpdate::ToolCallUpdate { status, raw_output, .. }
                    if status.is_some_and(|s| s.is_final()) =>
                {
                    raw_output.filter(|r| r.kind.as_deref() == Some("Bash"))
                }
                _ => None,
            })
            .expect("the capture holds one finished shell call");

        assert_eq!(update.exit_code, Some(0));
        assert!(update.output_for_prompt.is_some_and(|out| out.starts_with("exit: 0")));
    }

    /// The tool is read off grok's own `_meta` and never off `title`, which is
    /// the bare tool name on the opening line and a sentence on the next.
    #[test]
    fn a_tool_call_names_its_tool_in_meta_and_its_title_changes_under_it() {
        let open: GrokUpdate = serde_json::from_value(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "write",
            "rawInput": {"file_path": "/tmp/x", "content": "hi\n"},
            "_meta": {"x.ai/tool": {"name": "write", "kind": "write",
                                    "namespace": "opencode", "label": "Write"}},
        }))
        .unwrap();

        let GrokUpdate::ToolCall { meta, title, status, .. } = open else {
            panic!("a tool call");
        };
        assert_eq!(meta.name(), Some("write"));
        assert_eq!(meta.kind(), Some("write"));
        // The display title is the tool's own name here — the sentence lands on
        // the update behind it.
        assert_eq!(title.as_deref(), Some("write"));
        // Live, a `tool_call` carries no status; only `session/load`'s replay
        // does, and Dray never calls it.
        assert!(status.is_none());
    }

    /// `multiSelect` arrives as an explicit `null` for a single-select
    /// question, which `#[serde(default)]` alone does not survive — it answers
    /// for an absent key and fails on a present null.
    #[test]
    fn a_single_select_question_sends_multi_select_as_null() {
        let asked: AskUserQuestion = serde_json::from_value(json!({
            "sessionId": "s",
            "toolCallId": "call-1",
            "questions": [{"question": "tea or coffee?",
                           "options": [{"label": "tea", "description": "tea"}],
                           "multiSelect": null}],
            "mode": "default",
        }))
        .unwrap();

        assert_eq!(asked.questions.len(), 1);
        assert!(!asked.questions[0].multi_select);
        assert_eq!(asked.questions[0].options[0].label, "tea");
    }

    /// The reply's own `_meta` is the occupancy and the nested `usage` is the
    /// session's running total — reading the second as the first reports the
    /// context multiplied by the turn count.
    #[test]
    fn the_reply_reads_occupancy_from_meta_not_from_the_cumulative_usage() {
        let response: PromptResponse = serde_json::from_value(json!({
            "stopReason": "end_turn",
            "_meta": {"sessionId": "s", "totalTokens": 22429, "modelId": "grok-4.7",
                      "inputTokens": 22370, "outputTokens": 52,
                      "cachedReadTokens": 21632, "reasoningTokens": 32,
                      "usage": {"inputTokens": 44014, "outputTokens": 304,
                                "totalTokens": 44318, "numTurns": 2}},
        }))
        .unwrap();

        assert_eq!(response.meta.total_tokens, Some(22429));
        assert_eq!(response.meta.input_tokens, Some(22370));
        assert_eq!(response.meta.model_id.as_deref(), Some("grok-4.7"));
    }

    /// grok's side channels are named rather than left to the failure log, and
    /// a method nobody has modelled still has to be told apart from them.
    #[test]
    fn the_side_channels_are_quiet_and_an_unheard_method_is_not() {
        for method in [
            "_x.ai/session/setup",
            "_x.ai/mcp/server_status",
            "_x.ai/sessions/changed",
            "_x.ai/session/prompt_complete",
        ] {
            assert!(
                matches!(
                    parse_notification(method, json!({})),
                    Err(ParseOutcome::Ignored)
                ),
                "{method} should be quiet"
            );
        }

        assert!(matches!(
            parse_notification("_x.ai/something_new", json!({})),
            Err(ParseOutcome::Unknown)
        ));
    }
}
