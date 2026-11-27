//! OpenCode's ACP wire format, typed.
//!
//! Newline JSON-RPC 2.0, the envelope fx and grok speak, so
//! [`rpc`](crate::harness::rpc) splits a line and this only names what is
//! inside. Every shape was read off a live `opencode acp` (OpenCode 1.19.5) —
//! see `fixtures/README.md`.
//!
//! **Standard ACP and nothing else.** One notification method, `session/update`,
//! and no vendor channel beside it — so the whole vocabulary is the spec's.

use serde::Deserialize;
use serde_json::Value;

use crate::harness::null_as_default;
pub use crate::harness::acp::{ContentBlock, PermissionChoice, ToolContent, ToolKind, ToolStatus};

/// A line the mapper acts on.
pub enum OpenCodeEvent {
    /// An update belonging to **this** session — the read loop checks that.
    Update(OpenCodeUpdate),
    /// The answer to `session/prompt`, which is how a turn ends.
    PromptDone(Box<PromptResponse>),
    /// `session/prompt` answered with a JSON-RPC error — a provider key that
    /// stopped working, a model that is gone. The turn never ran.
    PromptFailed { message: String },
}

/// `session/update`'s envelope.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotification {
    /// Filtered on, because OpenCode's subagents run as child sessions and
    /// their updates are tagged with the child's own id.
    #[serde(default)]
    pub session_id: String,
    pub update: OpenCodeUpdate,
}

/// One streamed update, tagged on `sessionUpdate`. The unit variants are kinds
/// seen and drawn as nothing; naming them keeps [`Self::Unknown`] a signal.
#[derive(Debug, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum OpenCodeUpdate {
    AgentMessageChunk {
        content: ContentBlock,
    },
    AgentThoughtChunk {
        content: ContentBlock,
    },
    /// A call opening while the model still streams its arguments: `title` is
    /// the bare tool name (`bash`, `edit`) and `rawInput` is `{}` or `{cwd}`.
    /// The arguments land on the first `in_progress` update behind it.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: ToolKind,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(default)]
        kind: Option<ToolKind>,
        #[serde(default)]
        raw_input: Option<Value>,
        /// The files the call touches. OpenCode 2's `patch` names its file
        /// here alone, its input being the patch text.
        #[serde(default, deserialize_with = "null_as_default")]
        locations: Vec<Location>,
        #[serde(default, deserialize_with = "null_as_default")]
        content: Vec<ToolContent>,
        #[serde(default)]
        raw_output: Option<RawOutput>,
    },
    /// The context ring's reading: `used` tokens of a `size` window. A `0` is
    /// what a cancelled turn reports, not an empty context.
    UsageUpdate {
        #[serde(default)]
        used: u64,
        #[serde(default)]
        size: u64,
    },
    /// Every command behind a slash: OpenCode's `init` and `review` plus each
    /// skill and command it found, including the reader's `~/.claude/skills`.
    #[serde(rename_all = "camelCase")]
    AvailableCommandsUpdate {
        #[serde(default, deserialize_with = "null_as_default")]
        available_commands: Vec<AvailableCommand>,
    },
    // Seen, and drawn as nothing. `config_option_update` echoes a setting Dray
    // just set; `user_message_chunk` is `session/load`'s replay, never called.
    ConfigOptionUpdate,
    CurrentModeUpdate,
    UserMessageChunk,
    SessionInfoUpdate,
    Plan,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct Location {
    #[serde(default)]
    pub path: String,
}

/// A finished call's result. `output` is the text the model was handed;
/// `metadata.exit` is the shell's exit code.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct RawOutput {
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

impl RawOutput {
    pub fn exit_code(&self) -> Option<i64> {
        self.metadata.as_ref()?.get("exit")?.as_i64()
    }
}

/// One row of `available_commands_update`.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct AvailableCommand {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// The `session/prompt` response.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    /// `end_turn` or `cancelled` on capture; the spec also lists `max_tokens`,
    /// `max_turn_requests` and `refusal`.
    #[serde(default)]
    pub stop_reason: String,
    /// This turn's own token figures, all zero on a cancelled one.
    #[serde(default)]
    pub usage: PromptUsage,
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptUsage {
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cached_read_tokens: Option<u64>,
    #[serde(default)]
    pub thought_tokens: Option<u64>,
}

/// `session/request_permission`'s params. The options are OpenCode's own
/// (`once`, `always`, `reject`) and go back as they came.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    #[serde(default)]
    pub tool_call: ToolCallRef,
    #[serde(default)]
    pub options: Vec<PermissionChoice>,
}

/// The call a permission request names. Its `title` is the command or the
/// path, which is what the card draws.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRef {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub kind: ToolKind,
    #[serde(default)]
    pub raw_input: Option<Value>,
}

/// Why a notification produced no update.
pub enum ParseOutcome {
    /// A method this build has never seen — worth filing.
    Unknown,
    Malformed(serde_json::Error),
}

/// Types one notification off the connection.
pub fn parse_notification(method: &str, params: Value) -> Result<UpdateNotification, ParseOutcome> {
    match method {
        "session/update" => serde_json::from_value(params).map_err(ParseOutcome::Malformed),
        _ => Err(ParseOutcome::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exit code rides `metadata`, not the top level, and a read or an edit
    /// has none.
    #[test]
    fn the_exit_code_is_read_off_the_metadata() {
        let shell: RawOutput = serde_json::from_value(json!({
            "output": "notes.txt\n",
            "metadata": {"output": "notes.txt\n", "exit": 0, "truncated": false},
        }))
        .unwrap();
        assert_eq!(shell.exit_code(), Some(0));

        let edit: RawOutput =
            serde_json::from_value(json!({"output": "Edit applied successfully.", "metadata": {"diagnostics": {}}}))
                .unwrap();
        assert_eq!(edit.exit_code(), None);
    }

    /// A kind nobody has modelled costs the update and never the line.
    #[test]
    fn an_unmodelled_kind_is_unknown() {
        let note = parse_notification(
            "session/update",
            json!({"sessionId": "s", "update": {"sessionUpdate": "something_new", "x": 1}}),
        )
        .unwrap_or_else(|_| panic!("the envelope parses"));
        assert!(matches!(note.update, OpenCodeUpdate::Unknown));
    }
}
