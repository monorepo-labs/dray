//! Standard ACP, typed — and nothing any one agent adds.
//!
//! The generic harness runs agents nobody here has read the source of, so this
//! models the protocol's own shapes (agentclientprotocol.com) and lets anything
//! else cost one field or one line. Vendor notifications (`_cognition.ai/*`,
//! `_x.ai/*`) are ignored by prefix: an agent's extensions are its own, and
//! Devin's echo the reader's whole MCP config, secrets included.

use serde::Deserialize;
use serde_json::Value;

use crate::harness::null_as_default;
pub use crate::harness::acp::{ContentBlock, PermissionChoice, ToolKind, ToolStatus};

/// A line the mapper acts on.
pub enum AcpEvent {
    Update(SessionUpdate),
    /// `session/prompt`'s answer, which is the turn's end.
    PromptDone(PromptResponse),
    /// `session/prompt` refused with a JSON-RPC error.
    PromptFailed { message: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotification {
    #[serde(default)]
    pub session_id: String,
    pub update: SessionUpdate,
}

/// One `session/update`, tagged on `sessionUpdate`.
#[derive(Debug, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum SessionUpdate {
    AgentMessageChunk {
        content: ContentBlock,
    },
    AgentThoughtChunk {
        content: ContentBlock,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        kind: ToolKind,
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(default, deserialize_with = "null_as_default")]
        content: Vec<ToolContent>,
        #[serde(default)]
        raw_input: Option<Value>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        status: Option<ToolStatus>,
        #[serde(default, deserialize_with = "null_as_default")]
        content: Vec<ToolContent>,
        #[serde(default)]
        raw_input: Option<Value>,
        #[serde(default, rename = "_meta")]
        meta: Option<Value>,
    },
    SessionInfoUpdate {
        #[serde(default)]
        title: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AvailableCommandsUpdate {
        #[serde(default, deserialize_with = "null_as_default")]
        available_commands: Vec<AvailableCommand>,
    },
    #[serde(rename_all = "camelCase")]
    CurrentModeUpdate {
        #[serde(default)]
        current_mode_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ConfigOptionUpdate {
        #[serde(default, deserialize_with = "null_as_default")]
        config_options: Vec<ConfigOption>,
    },
    /// An occupancy, `used` of `size`.
    UsageUpdate {
        #[serde(default)]
        used: Option<u64>,
        #[serde(default)]
        size: Option<u64>,
    },
    /// `session/load`'s replay of a prompt Dray already logged.
    UserMessageChunk,
    Plan,
    #[serde(other)]
    Unknown,
}

/// ACP's tool content, with the diff's fields kept — an edit's sides are
/// only here on agents that leave `rawInput` without them.
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    #[serde(default)]
    pub stop_reason: String,
    #[serde(default)]
    pub usage: Option<PromptUsage>,
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    #[serde(default)]
    pub tool_call: ToolCallRef,
    #[serde(default)]
    pub options: Vec<PermissionChoice>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRef {
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub raw_input: Option<Value>,
}

/// One session setting. ACP's `configOptions`, read by `category` — `model`,
/// `mode`, `thought_level` — since the `id` is the agent's to choose.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub current_value: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub options: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigChoice {
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// What a session can be set to: its models, modes and effort levels, from
/// `configOptions` or the older `modes`/`models` objects beside them.
#[derive(Debug, Clone, Default)]
pub struct SessionOptions {
    pub model: Option<Setting>,
    pub mode: Option<Setting>,
    pub effort: Option<Setting>,
}

/// One setting: the config id to write it through, where it stands, and what
/// it may be set to. `config_id` is `None` for the legacy `modes` object,
/// which moves through `session/set_mode` instead.
#[derive(Debug, Clone, Default)]
pub struct Setting {
    pub config_id: Option<String>,
    pub current: Option<String>,
    pub choices: Vec<ConfigChoice>,
}

impl SessionOptions {
    /// Reads a `session/new`, `session/load` or `set_config_option` result.
    pub fn of(result: &Value) -> Self {
        let configs: Vec<ConfigOption> = result
            .get("configOptions")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let mut options = Self::from_configs(&configs);

        if options.mode.is_none() {
            options.mode = legacy_modes(result);
        }
        if options.model.is_none() {
            options.model = legacy_models(result);
        }
        options
    }

    pub fn from_configs(configs: &[ConfigOption]) -> Self {
        let by = |category: &str| {
            configs
                .iter()
                .find(|c| c.category.as_deref() == Some(category))
                .map(|c| Setting {
                    config_id: Some(c.id.clone()),
                    current: c.current_value.clone(),
                    choices: c.options.clone(),
                })
        };
        Self {
            model: by("model"),
            mode: by("mode"),
            effort: by("thought_level"),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.mode.is_none() && self.effort.is_none()
    }
}

/// `{"modes": {"currentModeId", "availableModes": [{id, name, description}]}}`.
fn legacy_modes(result: &Value) -> Option<Setting> {
    let modes = result.get("modes")?;
    let choices = modes
        .get("availableModes")?
        .as_array()?
        .iter()
        .filter_map(|m| {
            Some(ConfigChoice {
                value: m.get("id")?.as_str()?.to_string(),
                name: m.get("name").and_then(Value::as_str).map(str::to_string),
                description: m.get("description").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect();
    Some(Setting {
        config_id: None,
        current: modes.get("currentModeId").and_then(Value::as_str).map(str::to_string),
        choices,
    })
}

/// `{"models": {"currentModelId", "availableModels": [{modelId, name}]}}`,
/// ACP's unstable form — some agents still send only this.
fn legacy_models(result: &Value) -> Option<Setting> {
    let models = result.get("models")?;
    let choices = models
        .get("availableModels")?
        .as_array()?
        .iter()
        .filter_map(|m| {
            Some(ConfigChoice {
                value: m.get("modelId")?.as_str()?.to_string(),
                name: m.get("name").and_then(Value::as_str).map(str::to_string),
                description: m.get("description").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect();
    Some(Setting {
        config_id: None,
        current: models.get("currentModelId").and_then(Value::as_str).map(str::to_string),
        choices,
    })
}

/// Why a notification produced no update.
pub enum ParseOutcome {
    Ignored,
    Unknown,
    Malformed(serde_json::Error),
}

pub fn parse_notification(method: &str, params: Value) -> Result<UpdateNotification, ParseOutcome> {
    match method {
        "session/update" => serde_json::from_value(params).map_err(ParseOutcome::Malformed),
        // An extension, by ACP's own rule that they start with `_`.
        _ if method.starts_with('_') => Err(ParseOutcome::Ignored),
        _ => Err(ParseOutcome::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TURN: &str = include_str!("fixtures/devin_turn.jsonl");

    /// Every inbound line of a capture, `<< ` stripped.
    pub fn inbound(fixture: &str) -> Vec<Value> {
        fixture
            .lines()
            .filter_map(|line| line.strip_prefix("<< "))
            .map(|line| serde_json::from_str(line).expect("fixture line is JSON"))
            .collect()
    }

    /// Every update in a real Devin turn parses, and none of it lands in
    /// `Unknown` — that arm is the failure log's signal.
    #[test]
    fn every_update_in_a_devin_turn_is_modelled() {
        let mut seen = 0;
        for line in inbound(TURN) {
            if line.get("method").and_then(Value::as_str) != Some("session/update") {
                continue;
            }
            let note = parse_notification("session/update", line["params"].clone())
                .unwrap_or_else(|_| panic!("parses: {line}"));
            assert!(!matches!(note.update, SessionUpdate::Unknown), "unmodelled: {line}");
            seen += 1;
        }
        assert!(seen > 10);
    }

    /// Devin answers both `configOptions` and the older `modes`; the config
    /// list wins and names the id to write through.
    #[test]
    fn session_options_read_by_category() {
        let new = inbound(TURN)
            .into_iter()
            .find_map(|l| l.pointer("/result/sessionId").is_some().then(|| l["result"].clone()))
            .expect("the capture opens a session");
        let options = SessionOptions::of(&new);

        let mode = options.mode.expect("devin has modes");
        assert_eq!(mode.config_id.as_deref(), Some("mode"));
        assert_eq!(mode.current.as_deref(), Some("accept-edits"));
        assert!(mode.choices.iter().any(|c| c.value == "bypass"));
        assert_eq!(options.model.expect("devin has a model").config_id.as_deref(), Some("model"));
        assert!(options.effort.is_none());
    }

    #[test]
    fn legacy_modes_move_through_set_mode() {
        let options = SessionOptions::of(&json!({
            "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code"}]}
        }));
        let mode = options.mode.expect("modes");
        assert_eq!(mode.config_id, None);
        assert_eq!(mode.current.as_deref(), Some("ask"));
        assert_eq!(mode.choices.len(), 2);
    }

    #[test]
    fn vendor_extensions_are_quiet_and_unknown_methods_are_not() {
        assert!(matches!(parse_notification("_cognition.ai/output", json!({})), Err(ParseOutcome::Ignored)));
        assert!(matches!(parse_notification("session/new_thing", json!({})), Err(ParseOutcome::Unknown)));
    }
}
