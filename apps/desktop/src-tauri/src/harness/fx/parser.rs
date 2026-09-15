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

/// The settings a session carries, answered by `session/new`,
/// `session/resume` and every `session/set_config_option` alike.
///
/// The one place fx states what the **active model** actually takes. `effort`
/// is absent entirely from a model that does no reasoning — grok-4.6 and
/// claude-sonnet-4 on the Vercel gateway both answer `provider model mode` and
/// nothing else — and where it is present its `options` are that model's own:
/// claude-opus-5 stops at `max`, gpt-5.4-nano at `xhigh`, gpt-5.6-sol offers
/// `none` beside them. So the ladder is per **model**, and no per-provider
/// table can name it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOptions {
    #[serde(default)]
    pub config_options: Vec<ConfigOption>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub current_value: Option<String>,
    #[serde(default)]
    pub options: Vec<ConfigChoice>,
}

#[derive(Debug, Deserialize)]
pub struct ConfigChoice {
    #[serde(default)]
    pub value: String,
}

impl ConfigOptions {
    /// Reads the list off a JSON-RPC `result`. Absent or misshapen answers an
    /// empty list, which [`effort_levels`](Self::effort_levels) then reads as
    /// "fx said nothing about effort" rather than as "this model takes none" —
    /// the safe direction, since the second refuses a level fx might accept.
    pub fn of(result: &Value) -> Self {
        serde_json::from_value(result.clone()).unwrap_or_default()
    }

    /// The `effort` option's values, or `None` where the reply carries no
    /// `effort` option — the active model does no reasoning and
    /// `set_config_option effort` on it answers `-32602`.
    ///
    /// **Not always the model's own list.** See
    /// [`model_effort_levels`](Self::model_effort_levels): fx unions the
    /// session's current level into it, so this can name a rung the model
    /// refuses. Safe for "may this session try that level" — fx is still the
    /// judge — and not safe for anything that outlives the session.
    pub fn effort_levels(&self) -> Option<Vec<&str>> {
        let option = self.effort()?;
        Some(option.options.iter().map(|c| c.value.as_str()).collect())
    }

    /// The level the session is sitting on, which is the one entry of
    /// [`effort_levels`](Self::effort_levels) that may not be the model's.
    ///
    /// fx's option list is the model's ladder **unioned with the session's
    /// current level**, and switching model does not clamp that level.
    /// Captured on the codex provider: a session moved from `gpt-5.6-sol` at
    /// `ultra` onto `gpt-5.6-luna` reports luna's options as `… max, ultra` —
    /// and `ultra` set there is still refused `-32602`, so the list is simply
    /// wrong. `session/resume` restates the same wrong list.
    ///
    /// So `options` minus this is sound whatever the current level is: every
    /// level left is one the model takes. It can drop a level the model *does*
    /// support — the one in use — which is the safe direction, a rung missing
    /// from a menu against a refusal the reader cannot see coming, and the
    /// union in `models::learn_ladder` puts it back the moment a reading is
    /// taken from another level. Checked against every reply in every fixture
    /// here: 13 readings, no case where a level survived the subtraction that
    /// the model then refused.
    pub fn current_effort(&self) -> Option<&str> {
        self.effort()?.current_value.as_deref()
    }

    /// The levels that can only be the model's own — [`effort_levels`] minus
    /// [`current_effort`](Self::current_effort). `None` where fx carries no
    /// `effort` option at all, which is it saying outright that the model has
    /// none, and is the one reading that needs no subtracting: the grok row of
    /// `effort_ladder.jsonl` reports it while the session stands at `max`.
    ///
    /// [`effort_levels`]: Self::effort_levels
    pub fn model_effort_levels(&self) -> Option<Vec<&str>> {
        let current = self.current_effort();
        Some(
            self.effort_levels()?
                .into_iter()
                .filter(|level| Some(*level) != current)
                .collect(),
        )
    }

    /// The model those levels belong to, as fx spells it.
    pub fn model(&self) -> Option<&str> {
        self.config_options
            .iter()
            .find(|o| o.id == "model")?
            .current_value
            .as_deref()
    }

    fn effort(&self) -> Option<&ConfigOption> {
        self.config_options.iter().find(|o| o.id == "effort")
    }
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
    const LADDER: &str = include_str!("fixtures/effort_ladder.jsonl");
    const CARRYOVER: &str = include_str!("fixtures/effort_carryover.jsonl");

    /// Every reply in a capture that states the session's settings, in order —
    /// `session/new`, `session/resume` and `session/set_config_option` alike,
    /// which is what lets one reader serve all three.
    fn configs(fixture: &str) -> Vec<ConfigOptions> {
        inbound(fixture)
            .into_iter()
            .filter(|v| v.pointer("/result/configOptions").is_some())
            .map(|v| ConfigOptions::of(&v["result"]))
            .collect()
    }

    /// The whole of DRA-221's first half, read off one capture: the ladder is a
    /// fact about the **model**, and `effort` is simply absent from a model
    /// that does no reasoning. A per-provider table cannot say either — every
    /// row here is the same provider.
    #[test]
    fn the_effort_ladder_is_per_model_and_absent_where_a_model_has_none() {
        let configs = configs(LADDER);

        // `session/new` on claude-opus-5.
        let opened = &configs[0];
        assert_eq!(opened.model(), Some("anthropic/claude-opus-5"));
        assert_eq!(
            opened.effort_levels(),
            Some(vec!["auto", "low", "medium", "high", "xhigh", "max"]),
        );

        // Switched onto grok-4.6, which carries no `effort` option at all —
        // and that is `None`, not an empty list, so a caller can tell "fx says
        // this model has none" from "fx said nothing".
        let grok = configs
            .iter()
            .find(|c| c.model() == Some("spacexai/grok-4.6"))
            .expect("the capture switches onto grok-4.6");
        assert_eq!(grok.effort_levels(), None);

        // And onto gpt-5.4-nano, which offers a level Dray cannot spell. Its
        // list also carries the `max` this session was left on — the carryover
        // `effort_carryover.jsonl` pins — so only the first reply above is
        // trusted past the session.
        let nano = configs
            .iter()
            .find(|c| c.model() == Some("openai/gpt-5.4-nano"))
            .expect("the capture switches onto gpt-5.4-nano");
        assert!(nano
            .effort_levels()
            .expect("nano reasons")
            .contains(&"none"));
        assert_eq!(nano.current_effort(), Some("max"), "carried in from opus-5");
        assert!(
            !nano
                .model_effort_levels()
                .expect("nano reasons")
                .contains(&"max"),
            "the carried level is what the subtraction is for",
        );
    }

    /// fx's option list is the model's ladder **unioned with whatever level the
    /// session is on**, and switching model does not clamp that level — so the
    /// list can name a rung the model refuses, and `session/resume` restates
    /// it. Remembering one of these against the *model* is what would put a
    /// dead rung in the picker for the rest of the run.
    #[test]
    fn a_carried_level_leaks_into_the_list_and_is_still_refused() {
        let configs = configs(CARRYOVER);

        // luna's own ladder, read before anything was set on the session.
        let fresh = &configs[0];
        assert_eq!(fresh.model(), Some("gpt-5.6-luna"));
        assert_eq!(
            fresh.effort_levels(),
            Some(vec!["auto", "low", "medium", "high", "xhigh", "max"]),
        );

        // The same model after a session carrying `ultra` switched onto it:
        // `ultra` is in the list, and the capture's next line is fx refusing
        // it. Both readings of luna are in one file, which is the point.
        let carried = configs
            .iter()
            .filter(|c| c.model() == Some("gpt-5.6-luna"))
            .find(|c| c.current_effort() == Some("ultra"))
            .expect("the capture switches onto luna carrying ultra");
        assert!(carried.effort_levels().expect("luna reasons").contains(&"ultra"));

        // Subtracting the carried level reads luna's own ladder back off the
        // polluted reply, exactly — which is what makes the rule worth having
        // rather than merely safe.
        assert_eq!(
            carried.model_effort_levels(),
            Some(vec!["auto", "low", "medium", "high", "xhigh", "max"]),
        );

        // Refused twice: once on the fresh session, once after the switch that
        // put `ultra` in luna's own list.
        let refusals = inbound(CARRYOVER).into_iter().filter(|v| v.get("error").is_some()).count();
        assert_eq!(refusals, 2);
    }

    /// The rule the learned ladder rests on, checked against every reply in
    /// every capture rather than argued: `options` is the model's ladder
    /// unioned with the session's current level, so `options` minus that level
    /// holds nothing the model refuses.
    ///
    /// Truth here is a reading taken on a fresh `session/new` sitting on
    /// `auto`, which has nothing carried in. A future fx that widened the
    /// list some other way should fail here first.
    #[test]
    fn subtracting_the_current_level_never_keeps_one_the_model_refuses() {
        let mut truth: Vec<(String, Vec<String>)> = Vec::new();
        let mut checked = 0;

        for fixture in [LIVE_TURN, PERMISSION, CANCEL, EDIT, LADDER, CARRYOVER] {
            for config in configs(fixture) {
                let (Some(model), Some(levels)) = (config.model(), config.effort_levels()) else {
                    continue;
                };
                if config.current_effort() == Some("auto") {
                    let owned = levels.iter().map(|l| l.to_string()).collect();
                    truth.push((model.to_string(), owned));
                }
            }
        }

        for fixture in [LIVE_TURN, PERMISSION, CANCEL, EDIT, LADDER, CARRYOVER] {
            for config in configs(fixture) {
                let Some(model) = config.model() else { continue };
                let Some(known) = truth.iter().find(|(m, _)| m == model).map(|(_, l)| l) else {
                    continue;
                };
                for level in config.model_effort_levels().unwrap_or_default() {
                    assert!(
                        known.iter().any(|k| k == level),
                        "{model}: {level} survived the subtraction but is not in its own ladder",
                    );
                    checked += 1;
                }
            }
        }

        assert!(checked > 40, "the captures stopped covering this: {checked}");
    }

    /// Both refusals are `-32602` and their sentences differ by one word, so
    /// neither the code nor the text can be matched on to tell "this model has
    /// no effort" from "not that rung". Dray writes its own sentence off the
    /// ladder instead, and this is what says why.
    #[test]
    fn fx_refuses_two_different_things_with_one_code() {
        let errors: Vec<String> = inbound(LADDER)
            .into_iter()
            .filter_map(|v| v.get("error").cloned())
            .map(|e| {
                assert_eq!(e["code"], -32602);
                e["message"].as_str().unwrap_or_default().to_string()
            })
            .collect();

        assert_eq!(
            errors,
            vec![
                "Reasoning effort is unavailable for the active model",
                "Reasoning effort is not available for the active model",
            ],
        );
    }

    /// `session/new`, `session/resume` and `set_config_option` all answer the
    /// same shape, so one reader serves every place a ladder can be learned.
    /// A reply with no `configOptions` reads as an empty list, never an error.
    #[test]
    fn a_reply_without_config_options_is_empty_not_a_failure() {
        assert!(ConfigOptions::of(&serde_json::json!({})).config_options.is_empty());
        assert_eq!(ConfigOptions::of(&Value::Null).effort_levels(), None);
        assert_eq!(ConfigOptions::of(&Value::Null).model(), None);
    }

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
