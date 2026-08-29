//! The model/effort menu the UI renders and the CLI accepts.
//!
//! Only aliases go on the wire — `claude --model opus` always resolves to the
//! latest Opus, so pinning a dated id here would silently freeze sessions to an
//! old model as new ones ship.

use crate::harness::Harness;
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

    /// The inverse, for a value arriving from outside the app — the `dray`
    /// CLI's `--effort`. Strict for [`ModelId::from_arg`]'s reason: a typo is
    /// worth reporting, where silently running a different effort is not.
    pub fn from_arg(alias: &str) -> Option<Self> {
        match alias {
            "low" => Some(Effort::Low),
            "medium" => Some(Effort::Medium),
            "high" => Some(Effort::High),
            "xhigh" => Some(Effort::Xhigh),
            "max" => Some(Effort::Max),
            _ => None,
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
    // Codex's. Read from a live `model/list` rather than the docs, and named
    // in full because Codex has no moving aliases the way `opus` is one —
    // pinning a session to `gpt-5.6-sol` is what its author meant.
    Gpt56Sol,
    Gpt56Terra,
    Gpt56Luna,
    Gpt55,
    Gpt54,
    Gpt54Mini,
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
            ModelId::Gpt56Sol => Some("gpt-5.6-sol"),
            ModelId::Gpt56Terra => Some("gpt-5.6-terra"),
            ModelId::Gpt56Luna => Some("gpt-5.6-luna"),
            ModelId::Gpt55 => Some("gpt-5.5"),
            ModelId::Gpt54 => Some("gpt-5.4"),
            ModelId::Gpt54Mini => Some("gpt-5.4-mini"),
            ModelId::Unknown => None,
        }
    }

    /// The inverse of [`as_arg`](Self::as_arg), for an alias arriving from
    /// outside the app — the `dray` CLI's `--model`. Deliberately not
    /// `#[serde(other)]`-style forgiving: an unrecognized alias is a typo worth
    /// reporting, where silently running a different model is not.
    pub fn from_arg(alias: &str) -> Option<Self> {
        match alias {
            "opus" => Some(ModelId::Opus),
            "sonnet" => Some(ModelId::Sonnet),
            "fable" => Some(ModelId::Fable),
            "haiku" => Some(ModelId::Haiku),
            "gpt-5.6-sol" => Some(ModelId::Gpt56Sol),
            "gpt-5.6-terra" => Some(ModelId::Gpt56Terra),
            "gpt-5.6-luna" => Some(ModelId::Gpt56Luna),
            "gpt-5.5" => Some(ModelId::Gpt55),
            "gpt-5.4" => Some(ModelId::Gpt54),
            "gpt-5.4-mini" => Some(ModelId::Gpt54Mini),
            _ => None,
        }
    }
}

/// What an orchestrated session runs when nobody said. [`ModelId::default`]
/// cannot serve here — it is `Unknown`, which exists so an old index entry
/// still deserializes and which has no CLI alias at all.
///
/// Deliberately *not* the composer's seed. That one opens a picker the user is
/// about to touch, so it starts cheap; this one is a session nobody is sitting
/// in front of, doing a whole task unattended, and the cost of it being weak is
/// work that has to be redone by hand. Effort follows from the model's own
/// default, which is `High` for every model that has levels.
pub fn default_model() -> ModelId {
    ModelId::Opus
}

/// The model a session starts on when nobody picked one.
///
/// Per-harness because a harness cannot run the other's models at all — handing
/// Codex `opus` fails the spawn rather than falling back. Both are the strong
/// one deliberately: this is the default for a session nobody is sitting in
/// front of, where a weak model costs work redone by hand.
pub fn default_model_for(harness: Harness) -> ModelId {
    match harness {
        Harness::ClaudeCode => ModelId::Opus,
        Harness::Codex => ModelId::Gpt56Sol,
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

/// The models a harness can actually run.
///
/// Static rather than read from `model/list`, which app-server does answer:
/// the picker has to be built before a session exists, and there is no child to
/// ask until one does. Worth revisiting once a spare connection is cheap.
///
/// `ultra` is deliberately absent from every effort list — Codex offers it on
/// the 5.6 models and Dray's [`Effort`] has no such level. Adding one is a
/// change to a persisted enum, so it waits for a reason beyond completeness.
pub fn codex_models() -> Vec<Model> {
    use Effort::*;

    // The current family only. Older generations keep their ids, aliases and
    // context windows — a session started on one resumes and reads back — they
    // are simply not offered, since a picker is a recommendation and nothing
    // here recommends last year's model.
    //
    // **Medium by default, where Claude's models default to High.** Codex
    // reasons at every level and starts here itself; `resolve_effort` reads
    // this, so the flag follows without a second constant.
    vec![
        Model {
            id: ModelId::Gpt56Sol,
            label: "5.6 Sol".into(),
            efforts: vec![Low, Medium, High, Xhigh, Max],
            default_effort: Some(Medium),
        },
        Model {
            id: ModelId::Gpt56Terra,
            label: "5.6 Terra".into(),
            efforts: vec![Low, Medium, High, Xhigh, Max],
            default_effort: Some(Medium),
        },
        Model {
            id: ModelId::Gpt56Luna,
            label: "5.6 Luna".into(),
            efforts: vec![Low, Medium, High, Xhigh, Max],
            default_effort: Some(Medium),
        },
    ]
}

/// Every Codex model this build can still *run*, listed or not.
///
/// [`codex_models`] is the picker's list and stops at the current family; this
/// is what [`find_model`] searches, so a session started on an older one
/// resumes instead of failing at the spawn with "unknown model".
fn every_codex_model() -> Vec<Model> {
    use Effort::*;

    let mut all = codex_models();
    all.extend([
        Model {
            id: ModelId::Gpt55,
            label: "GPT-5.5".into(),
            efforts: vec![Low, Medium, High, Xhigh],
            default_effort: Some(Medium),
        },
        Model {
            id: ModelId::Gpt54,
            label: "GPT-5.4".into(),
            efforts: vec![Low, Medium, High, Xhigh],
            default_effort: Some(Medium),
        },
        Model {
            id: ModelId::Gpt54Mini,
            label: "GPT-5.4-Mini".into(),
            efforts: vec![Low, Medium, High, Xhigh],
            default_effort: Some(Medium),
        },
    ]);
    all
}

/// What the picker offers for a harness.
pub fn models_for(harness: Harness) -> Vec<Model> {
    match harness {
        Harness::ClaudeCode => claude_models(),
        Harness::Codex => codex_models(),
    }
}

/// Whether a harness can *run* a model, which is a wider question than whether
/// it offers one.
///
/// The two differ by exactly the models retired from a picker, and reading the
/// offered list for this is the bug it exists to prevent: a session started on
/// an older model would stop resuming the day its successor shipped, refused
/// for a stance nobody changed.
pub fn runs_on(id: ModelId, harness: Harness) -> bool {
    match harness {
        Harness::ClaudeCode => claude_models(),
        Harness::Codex => every_codex_model(),
    }
    .into_iter()
    .any(|m| m.id == id)
}

/// `None` for anything this build doesn't list, including `Unknown` read back
/// from an older index entry — so it fails loudly at the spawn rather than
/// silently running a different model.
///
/// Searches both harnesses because a model id names exactly one of them: the
/// aliases do not overlap, so there is nothing for a harness argument to
/// disambiguate and asking for one would only let a caller pass the wrong one.
pub fn find_model(id: ModelId) -> Option<Model> {
    claude_models()
        .into_iter()
        .chain(every_codex_model())
        .find(|m| m.id == id)
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

    /// A model dropped from the picker must still resume. The two lists differ
    /// by exactly the retired models, and reading the offered one for "may this
    /// run" is what would strand every session on an older generation.
    #[test]
    fn a_retired_model_still_runs_but_is_not_offered() {
        assert!(runs_on(ModelId::Gpt55, Harness::Codex));
        assert!(find_model(ModelId::Gpt55).is_some());
        assert!(!models_for(Harness::Codex).iter().any(|m| m.id == ModelId::Gpt55));
    }

    /// The picker offers one family, and every model in it reasons — so a
    /// harness switch can never land the composer on a model with no effort.
    #[test]
    fn the_offered_codex_models_are_the_current_family() {
        let offered = models_for(Harness::Codex);

        assert_eq!(
            offered.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(),
            ["5.6 Sol", "5.6 Terra", "5.6 Luna"]
        );
        // Medium, where Claude's default is High. Cheap to state, and the one
        // number a reader would otherwise have to open the picker to learn.
        assert!(offered
            .iter()
            .all(|m| m.default_effort == Some(Effort::Medium)));
    }

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
