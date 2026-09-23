//! The ACP wire types and helpers fx and grok share. Framing is Codex's
//! [`rpc`](super::codex::rpc); what each agent adds on top stays in its own
//! directory.

use crate::events::{
    AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent, PermissionBehavior,
    PermissionOption, PermissionOptionKind, ToolType,
};
use crate::harness::claude_code::permissions::{PendingRequest, Reply, ResolvedOption};
use serde::Deserialize;
use serde_json::{json, Value};

/// An ACP content block. Only text is drawn; anything else is kept from failing
/// the line and drawn as nothing.
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
/// grok sends `diff` on both `write` and `search_replace`; fx never does, its
/// editor naming the sides in `rawInput` instead. Only its presence is read.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContent {
    Content {
        content: ContentBlock,
    },
    Diff,
    #[serde(other)]
    Other,
}

/// ACP's closed set of tool kinds, which is what makes classifying a call
/// possible without knowing the agent's tool names.
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

impl ToolKind {
    /// Dray's row type, the fallback once each agent's own name checks miss.
    pub fn tool_type(self) -> ToolType {
        match self {
            ToolKind::Read => ToolType::FileRead,
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move => ToolType::FileEdit,
            ToolKind::Search => ToolType::Search,
            ToolKind::Execute => ToolType::Shell,
            ToolKind::Fetch => ToolType::Web,
            ToolKind::Think | ToolKind::SwitchMode | ToolKind::Other => ToolType::Other,
        }
    }

    /// A name for a call that arrived without one — both agents name every
    /// call on every capture, so this is the line-survives-anything fallback.
    pub fn name(self) -> &'static str {
        match self {
            ToolKind::Read => "read",
            ToolKind::Edit => "edit",
            ToolKind::Delete => "delete",
            ToolKind::Move => "move",
            ToolKind::Search => "search",
            ToolKind::Execute => "shell",
            ToolKind::Fetch => "fetch",
            ToolKind::Think => "think",
            ToolKind::SwitchMode => "switch_mode",
            ToolKind::Other => "tool",
        }
    }
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

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionChoice {
    pub option_id: String,
    #[serde(default)]
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always`. A string
    /// rather than an enum so a kind added later reaches [`build_options`]'s
    /// own fallback instead of failing the request — and an unanswered request
    /// stalls the turn.
    #[serde(default)]
    pub kind: String,
}

/// A streamed block still open, and the text it has accumulated — the
/// committed event supersedes the deltas, so the whole text is kept.
pub struct OpenBlock {
    pub id: String,
    pub kind: BlockType,
    pub text: String,
}

/// Neither agent has a message/block split — one run of chunks is one block —
/// so the index is always zero.
pub fn block_ref(id: &str) -> BlockRef {
    BlockRef {
        message_id: id.to_string(),
        index: 0,
    }
}

/// Closes a streaming block, committing its whole text: the deltas were a
/// preview and this is what the transcript keeps.
pub fn commit(block: OpenBlock, mut event: impl FnMut(AgentEventPayload) -> AgentEvent) -> Vec<AgentEvent> {
    let stop = event(AgentEventPayload::Delta(DeltaEvent::BlockStop {
        block: block_ref(&block.id),
    }));
    let committed = match block.kind {
        BlockType::Thinking => event(AgentEventPayload::Reasoning {
            block: Some(block_ref(&block.id)),
            encrypted: block.text.is_empty(),
            text: block.text,
        }),
        _ => event(AgentEventPayload::AssistantText {
            block: Some(block_ref(&block.id)),
            text: block.text,
        }),
    };
    vec![stop, committed]
}

/// Builds a held `session/request_permission` and its buttons in one pass.
///
/// **The options are the agent's own**: ACP names each with an `optionId` and
/// a `kind`, and the button carries the id back untouched inside the outcome
/// envelope, so a decision Dray never composes is one it can never compose
/// wrongly. `prefix` keeps one agent's button ids apart from another's.
pub fn pending_for(
    prefix: &str,
    tool_use_id: &str,
    tool_name: &str,
    choices: &[PermissionChoice],
    rpc_id: i64,
) -> (PendingRequest, Vec<PermissionOption>) {
    let resolved = build_options(prefix, choices);
    let offered = resolved.iter().map(|r| r.option.clone()).collect();

    let pending = PendingRequest {
        tool_use_id: tool_use_id.to_string(),
        tool_name: tool_name.to_string(),
        // The agent rebuilds nothing from the answer — it is the option alone.
        input: Value::Null,
        options: resolved
            .into_iter()
            .map(|r| (r.option.id.clone(), r))
            .collect(),
        reply: Reply::Rpc(rpc_id),
    };

    (pending, offered)
}

/// The reply `session/request_permission` wants for a picked option.
fn selected(option_id: &str) -> Value {
    json!({"outcome": {"outcome": "selected", "optionId": option_id}})
}

/// One button per option offered, in the order the card reads: allow first,
/// standing grants in the middle, refusal last. A kind this build cannot spell
/// is dropped rather than drawn generically. Labels are the agent's own words.
fn build_options(prefix: &str, choices: &[PermissionChoice]) -> Vec<ResolvedOption> {
    use PermissionBehavior::{Allow, Deny};
    use PermissionOptionKind as Kind;

    let mut options: Vec<ResolvedOption> = choices
        .iter()
        .filter_map(|choice| {
            let (kind, behavior) = match choice.kind.as_str() {
                "allow_once" => (Kind::Once, Allow),
                "allow_always" => (Kind::AlwaysRule, Allow),
                "reject_once" | "reject_always" => (Kind::Deny, Deny),
                _ => return None,
            };
            Some(ResolvedOption {
                option: PermissionOption {
                    id: format!("{prefix}-{}", choice.option_id),
                    label: choice.name.clone(),
                    kind,
                    behavior,
                },
                updates: Vec::new(),
                decision: Some(selected(&choice.option_id)),
            })
        })
        .collect();

    options.sort_by_key(|o| match o.option.kind {
        Kind::Once => 0,
        Kind::AlwaysRule | Kind::AlwaysDirectory | Kind::SwitchMode => 1,
        Kind::Deny => 2,
    });

    // A card with no way to say no cannot be answered honestly. ACP's
    // `cancelled` outcome is always a legal answer, whatever was offered.
    if !options.iter().any(|o| o.option.behavior == Deny) {
        options.push(ResolvedOption {
            option: PermissionOption {
                id: format!("{prefix}-cancelled"),
                label: "Deny".to_string(),
                kind: Kind::Deny,
                behavior: Deny,
            },
            updates: Vec::new(),
            decision: Some(json!({"outcome": {"outcome": "cancelled"}})),
        });
    }

    options
}
