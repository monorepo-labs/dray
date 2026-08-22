//! The model/effort menu the UI renders and the CLI accepts.
//!
//! Only aliases go on the wire — `claude --model opus` always resolves to the
//! latest Opus, so pinning a dated id here would silently freeze sessions to an
//! old model as new ones ship.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    /// The `--effort` flag value.
    pub fn as_arg(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
        }
    }
}

/// The `--model` alias, typed. `Unknown` exists so an index entry naming a
/// model this build no longer lists still deserializes — losing one session's
/// model beats failing the whole index read and emptying the sidebar. It maps
/// to no alias, so [`find_model`] rejects it and it can't reach a spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum ModelId {
    Opus,
    Sonnet,
    Fable,
    Haiku,
    #[serde(other)]
    Unknown,
}

impl Default for ModelId {
    fn default() -> Self {
        Self::Unknown
    }
}

impl ModelId {
    /// `None` for [`ModelId::Unknown`] — there is no alias to pass the CLI.
    /// Callers hold a [`Model`] by then, so this is unreachable in practice.
    pub fn as_arg(self) -> Option<&'static str> {
        match self {
            ModelId::Opus => Some("opus"),
            ModelId::Sonnet => Some("sonnet"),
            ModelId::Fable => Some("fable"),
            ModelId::Haiku => Some("haiku"),
            ModelId::Unknown => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// What `--model` receives.
    pub id: ModelId,
    pub label: String,
    /// Empty means the model has no effort levels. The CLI tolerates `--effort`
    /// on such a model and ignores it, so this drives the UI and keeps the
    /// persisted value honest rather than preventing a crash.
    pub efforts: Vec<Effort>,
    pub default_effort: Option<Effort>,
}

/// The full model list the UI's picker is built from.
pub fn claude_models() -> Vec<Model> {
    use Effort::*;

    vec![
        Model {
            id: ModelId::Fable,
            label: "Fable 5".into(),
            efforts: vec![Low, Medium, High, Xhigh, Max],
            default_effort: Some(High),
        },
        Model {
            id: ModelId::Opus,
            label: "Opus 5".into(),
            efforts: vec![Low, Medium, High, Xhigh, Max],
            default_effort: Some(High),
        },
        Model {
            id: ModelId::Sonnet,
            label: "Sonnet 5".into(),
            efforts: vec![Low, Medium, High, Xhigh, Max],
            default_effort: Some(High),
        },
        Model {
            id: ModelId::Haiku,
            label: "Haiku 4.5".into(),
            efforts: Vec::new(),
            default_effort: None,
        },
    ]
}

/// `None` for anything this build doesn't list, including `Unknown` read back
/// from an older index entry — so it fails loudly at the spawn rather than
/// silently running a different model.
pub fn find_model(id: ModelId) -> Option<Model> {
    claude_models().into_iter().find(|m| m.id == id)
}

/// The effort actually sent for `(model, requested)`. `None` means omit the
/// flag — either the model takes none, or the request isn't one it supports.
pub fn resolve_effort(model: &Model, requested: Option<Effort>) -> Option<Effort> {
    if model.efforts.is_empty() {
        return None;
    }

    match requested {
        Some(e) if model.efforts.contains(&e) => Some(e),
        _ => model.default_effort,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verified against the CLI: `--effort` on Haiku is accepted and ignored,
    /// so this pins a UI/persistence rule, not a spawn failure.
    #[test]
    fn haiku_never_takes_an_effort() {
        let haiku = find_model(ModelId::Haiku).unwrap();

        assert_eq!(resolve_effort(&haiku, Some(Effort::Max)), None);
        assert_eq!(resolve_effort(&haiku, None), None);
    }

    #[test]
    fn unsupported_effort_falls_back_to_the_model_default() {
        let opus = find_model(ModelId::Opus).unwrap();

        assert_eq!(resolve_effort(&opus, Some(Effort::Low)), Some(Effort::Low));
        assert_eq!(resolve_effort(&opus, None), Some(Effort::High));
    }

    /// The serialized id is what `--model` receives, so it must stay a bare
    /// alias — a dated name would freeze sessions to a model that stops
    /// receiving updates.
    #[test]
    fn model_ids_serialize_as_bare_aliases() {
        for model in claude_models() {
            let wire = serde_json::to_string(&model.id).unwrap();
            assert!(
                !wire.contains('-'),
                "{wire} looks like a dated id; the CLI wants an alias"
            );
        }
    }

    /// An index entry naming a model this build dropped must not fail the whole
    /// index read, and must not reach a spawn either.
    #[test]
    fn a_retired_model_reads_back_as_unknown_and_is_rejected() {
        let id: ModelId = serde_json::from_str("\"opus-4-1-20250805\"").unwrap();

        assert_eq!(id, ModelId::Unknown);
        assert!(find_model(id).is_none());
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    /// The frontend sends `effort: null` for a model with no levels; Tauri
    /// deserializes command args from JSON, so this is the real shape.
    #[test]
    fn effort_round_trips_through_null() {
        let none: Option<Effort> = serde_json::from_str("null").unwrap();
        assert_eq!(none, None);

        let some: Option<Effort> = serde_json::from_str("\"xhigh\"").unwrap();
        assert_eq!(some, Some(Effort::Xhigh));

        assert_eq!(
            serde_json::to_string(&Some(Effort::Max)).unwrap(),
            "\"max\""
        );
    }

    /// Every level the CLI documents must survive the round trip, or a session
    /// persisted with it fails to load.
    #[test]
    fn every_effort_matches_its_cli_arg() {
        for e in [
            Effort::Low,
            Effort::Medium,
            Effort::High,
            Effort::Xhigh,
            Effort::Max,
        ] {
            let json = serde_json::to_string(&e).unwrap();
            assert_eq!(json, format!("\"{}\"", e.as_arg()));
        }
    }
}
