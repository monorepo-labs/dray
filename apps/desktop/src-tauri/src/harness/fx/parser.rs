//! fx's ACP wire format, typed.
//!
//! ACP (Agent Client Protocol) is newline JSON-RPC 2.0 over stdio, the shape
//! `codex app-server` already has, so the envelope arrives split into a method
//! and a params object by [`codex::rpc`](crate::harness::codex::rpc) and this
//! only names what is inside. Same conventions as the other parsers: every enum
//! that can grow carries `#[serde(other)]`, fields the server may omit carry
//! `#[serde(default)]`, and a shape not modelled costs one field or one line,
//! never the connection.
//!
//! Every shape here was read off a live `fx acp` (fx 0.0.9) — see
//! `fixtures/README.md` — not off the ACP schema. Two places the two differ
//! and the capture wins: `edit_file` carries `old_string`/`new_string` in
//! `rawInput` and never a `diff` block, and a shell call's `completed` update
//! carries fx's own replay blob as text with the real stdout having streamed
//! through the `in_progress` updates before it.

use serde::Deserialize;
use serde_json::Value;

/// Reads `null` as the type's default, which `#[serde(default)]` alone will not.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// A line the mapper acts on, or a marker saying why it does not.
pub enum FxEvent {
    Update(SessionUpdate),
    /// The answer to `session/prompt`, which is how a turn ends: fx sends no
    /// turn-completed notification, the request itself blocks for the turn.
    PromptDone(PromptResponse),
    /// `session/prompt` answered with a JSON-RPC error — a provider refusing
    /// the login, a model the provider does not serve. The turn never opened.
    PromptFailed { message: String },
    /// A method this build has never seen. Filed, and costs nothing else.
    Unknown,
}

/// `session/update`'s params.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotification {
    #[serde(default)]
    pub session_id: String,
    pub update: SessionUpdate,
}

/// One streamed update, tagged on `sessionUpdate`.
///
/// The unit variants are updates seen and drawn as nothing: `user_message_chunk`
/// is the `session/load` replay of a prompt Dray already logged,
/// `available_commands_update` arrived empty on every capture. The distinction
/// from [`Self::Unknown`] is what keeps the failure log a signal.
#[derive(Debug, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum SessionUpdate {
    #[serde(rename_all = "camelCase")]
    AgentMessageChunk {
        #[serde(default)]
        message_id: Option<String>,
        content: ContentBlock,
    },
    AgentThoughtChunk {
        content: ContentBlock,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: ToolKind,
        #[serde(default)]
        status: ToolStatus,
        #[serde(default)]
        raw_input: Option<Value>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(default, deserialize_with = "null_as_default")]
        content: Vec<ToolContent>,
        /// fx's own addition beside the ACP fields, on a shell call's closing
        /// update. Snake case on the wire where everything around it is camel,
        /// hence the explicit rename under the variant's `camelCase`.
        #[serde(default, rename = "command_result")]
        command_result: Option<CommandResult>,
    },
    SessionInfoUpdate {
        #[serde(default)]
        title: Option<String>,
    },
    /// An occupancy reading — `used` of `size` — not a cumulative. The trap
    /// Codex's `total` and Claude's `result.usage` both set is absent here.
    UsageUpdate {
        #[serde(default)]
        used: Option<u64>,
        #[serde(default)]
        size: Option<u64>,
    },
    AvailableCommandsUpdate,
    UserMessageChunk,
    CurrentModeUpdate,
    Plan,
    #[serde(other)]
    Unknown,
}

/// An ACP content block. Only text is drawn; an image or resource block is
/// kept from failing the line and drawn as nothing.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        #[serde(default)]
        text: String,
    },
    #[serde(other)]
    Other,
}

impl ContentBlock {
    pub fn text(&self) -> Option<&str> {
        match self {
            ContentBlock::Text { text } => Some(text),
            ContentBlock::Other => None,
        }
    }
}

/// What a tool call reports back, tagged on `type`.
///
/// `diff` is in the ACP schema and no capture carried one — fx's editor names
/// its sides in `rawInput` instead — so it is modelled to keep the line and
/// read by nothing yet.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContent {
    Content {
        content: ContentBlock,
    },
    #[serde(rename_all = "camelCase")]
    Diff {
        #[serde(default)]
        path: String,
        #[serde(default)]
        old_text: Option<String>,
        #[serde(default)]
        new_text: String,
    },
    #[serde(other)]
    Other,
}

/// ACP's closed set of tool kinds, which is what makes classifying a call
/// possible without knowing fx's tool names.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    #[default]
    #[serde(other)]
    Other,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
    Failed,
    #[serde(other)]
    Unknown,
}

impl ToolStatus {
    /// Whether this update closes the call.
    pub fn is_final(self) -> bool {
        matches!(self, ToolStatus::Completed | ToolStatus::Failed)
    }
}

/// fx's own account of a finished shell command. Snake case, since it is fx's
/// field and not ACP's.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct CommandResult {
    #[serde(default)]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub signal: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// `session/request_permission`'s params. The options are the server's and go
/// back as they came — see [`permissions`](super::permissions).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub tool_call: ToolCallRef,
    #[serde(default)]
    pub options: Vec<PermissionChoice>,
}

/// The call a permission request names. A subset of `tool_call`'s fields, and
/// `rawInput` is what the card draws the command or path from.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRef {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub kind: ToolKind,
    #[serde(default)]
    pub raw_input: Option<Value>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionChoice {
    pub option_id: String,
    #[serde(default)]
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always`. A string
    /// rather than an enum so a kind added later reaches [`permissions`]'s
    /// own fallback instead of failing the request.
    #[serde(default)]
    pub kind: String,
}

/// The `session/prompt` response.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    /// `end_turn`, `cancelled`, `refused`, `max_tokens`, `max_turn_requests`.
    #[serde(default)]
    pub stop_reason: String,
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
    pub cache_read_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning_tokens: Option<u64>,
}

/// Types one notification off the connection.
pub fn parse_notification(method: &str, params: Value) -> Result<FxEvent, serde_json::Error> {
    Ok(match method {
        "session/update" => {
            let update: UpdateNotification = serde_json::from_value(params)?;
            FxEvent::Update(update.update)
        }
        _ => FxEvent::Unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every inbound line of a capture, `<< ` prefix stripped.
    pub fn inbound(fixture: &str) -> Vec<Value> {
        fixture
            .lines()
            .filter_map(|line| line.strip_prefix("<< "))
            .map(|line| serde_json::from_str(line).expect("fixture line is JSON"))
            .collect()
    }

    /// Every `session/update` in a capture, typed.
    pub fn updates(fixture: &str) -> Vec<SessionUpdate> {
        inbound(fixture)
            .into_iter()
            .filter(|v| v.get("method").and_then(Value::as_str) == Some("session/update"))
            .map(|v| {
                let n: UpdateNotification =
                    serde_json::from_value(v["params"].clone()).expect("update parses");
                n.update
            })
            .collect()
    }

    const LIVE_TURN: &str = include_str!("fixtures/live_turn.jsonl");
    const PERMISSION: &str = include_str!("fixtures/permission_request.jsonl");
    const CANCEL: &str = include_str!("fixtures/cancel.jsonl");
    const EDIT: &str = include_str!("fixtures/edit_file.jsonl");

    /// Every update in every capture parses, and none lands on the catch-all.
    /// A new `sessionUpdate` kind should fail here before it is filed as
    /// unknown on a live session.
    #[test]
    fn every_captured_update_is_modelled() {
        for fixture in [LIVE_TURN, PERMISSION, CANCEL, EDIT] {
            for update in updates(fixture) {
                assert!(!matches!(update, SessionUpdate::Unknown), "{update:?}");
            }
        }
    }

    /// The capture's shell call: three kinds of update on one id, and the
    /// closing one carries fx's `command_result` beside the content.
    #[test]
    fn a_shell_call_closes_with_a_command_result() {
        let closing = updates(LIVE_TURN)
            .into_iter()
            .filter_map(|u| match u {
                SessionUpdate::ToolCallUpdate {
                    status: Some(ToolStatus::Completed),
                    command_result: Some(result),
                    ..
                } => Some(result),
                _ => None,
            })
            .next()
            .expect("the shell call closes with a command_result");

        assert_eq!(closing.exit_code, Some(0));
        assert!(closing.duration_ms.is_some());
    }

    /// The editor's sides ride `rawInput`, not a `diff` block. Pinned because
    /// the ACP schema says otherwise and the row reads `old_string`.
    #[test]
    fn edit_file_names_its_sides_in_raw_input() {
        let edit = updates(EDIT)
            .into_iter()
            .find_map(|u| match u {
                SessionUpdate::ToolCall {
                    name, raw_input, kind, ..
                } if name.as_deref() == Some("edit_file") => Some((kind, raw_input)),
                _ => None,
            })
            .expect("an edit_file call");

        assert_eq!(edit.0, ToolKind::Edit);
        let input = edit.1.expect("rawInput present");
        assert!(input.get("old_string").is_some());
        assert!(input.get("new_string").is_some());
    }

    /// A permission request names three options and every one is a string
    /// kind this build spells.
    #[test]
    fn the_captured_permission_request_parses() {
        let request = inbound(PERMISSION)
            .into_iter()
            .find(|v| v.get("method").and_then(Value::as_str) == Some("session/request_permission"))
            .expect("a permission request");
        let request: PermissionRequest =
            serde_json::from_value(request["params"].clone()).expect("parses");

        let kinds: Vec<&str> = request.options.iter().map(|o| o.kind.as_str()).collect();
        assert_eq!(kinds, ["allow_once", "allow_always", "reject_once"]);
        assert_eq!(request.tool_call.kind, ToolKind::Execute);
        assert!(request.tool_call.raw_input.is_some());
    }

    /// A cancelled prompt still answers, and with its own word.
    #[test]
    fn a_cancelled_prompt_answers_cancelled() {
        let response = inbound(CANCEL)
            .into_iter()
            .filter(|v| v.get("id").is_some() && v.get("method").is_none())
            .filter_map(|v| serde_json::from_value::<PromptResponse>(v["result"].clone()).ok())
            .find(|r| !r.stop_reason.is_empty())
            .expect("a prompt response");

        assert_eq!(response.stop_reason, "cancelled");
    }
}
