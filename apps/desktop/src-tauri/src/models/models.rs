//! The model/effort menu the UI renders and the CLI accepts.
//!
//! Only aliases go on the wire — `claude --model opus` always resolves to the
//! latest Opus, so pinning a dated id here would silently freeze sessions to an
//! old model as new ones ship.

use crate::harness::Harness;
use serde::{Deserialize, Deserializer, Serialize};
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
    /// Above [`Effort::Max`], and a real rung rather than a synonym for it —
    /// Codex describes `max` as "maximum reasoning depth for the hardest
    /// problems" and `ultra` as "maximum reasoning **with automatic task
    /// delegation**", and offers both on the same model.
    ///
    /// Offered only where a model reports it: Sol and Terra do, Luna stops at
    /// `max`, and the older generations stop at `xhigh`. Claude Code's list
    /// stops at `max` too — its `ultracode` is a session boolean pairing xhigh
    /// with workflow orchestration, not a level, so it does not belong here
    /// (DRA-140).
    Ultra,
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
            Effort::Ultra => "ultra",
        }
    }

    /// The inverse, for a value arriving from outside the app — the `dray`
    /// CLI's `--effort`. Strict for [`id_for_arg`]'s reason: a typo is worth
    /// reporting, where silently running a different effort is not.
    pub fn from_arg(alias: &str) -> Option<Self> {
        match alias {
            "low" => Some(Effort::Low),
            "medium" => Some(Effort::Medium),
            "high" => Some(Effort::High),
            "xhigh" => Some(Effort::Xhigh),
            "max" => Some(Effort::Max),
            "ultra" => Some(Effort::Ultra),
            _ => None,
        }
    }
}

/// What an index entry records for a session's model.
///
/// A newtype over the string it has always serialized as. The closed enum this
/// replaces was a validation layer wearing a type's clothes: validity is
/// [`find_model`]'s question, since only the model table knows whether an id
/// names something this build can run — and a harness whose model list is
/// answered at runtime has ids no enum written here could hold.
///
/// An untagged `Known(..) | Named(String)` enum was the first proposal and has
/// a bug in it. Two spellings of one value would exist, identical on the wire
/// and unequal under a derived `PartialEq`, and that equality is what decides
/// whether [`crate::session`] replaces a live child or sends `set_model`. A
/// model reaching one side through the index and the other through the composer
/// would respawn a running session, silently and unreproducibly.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
pub struct ModelId(String);

/// The one spelling of "this build cannot name the model".
///
/// `unknown` is what the enum this replaces wrote for an id it did not list, so
/// entries on disk still carry it — and an older build reading a newer index
/// writes it back over every model id it does not know (PI-PLAN.md §4). Both
/// read as this one value, because two spellings of one state is how they drift
/// apart.
const UNSET: &str = "";

impl ModelId {
    pub fn new(id: impl Into<String>) -> Self {
        let id = id.into();
        if id == "unknown" {
            return Self(UNSET.to_string());
        }
        Self(id)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether this names no model. [`find_model`] rejects it, and a spawn omits
    /// `--model` — which for a harness that picks its own default is the honest
    /// answer rather than a failure.
    pub fn is_unset(&self) -> bool {
        self.0 == UNSET
    }
}

impl Default for ModelId {
    fn default() -> Self {
        Self(UNSET.to_string())
    }
}

impl std::fmt::Display for ModelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Normalizes on the way in, so the sentinel has one spelling everywhere above
/// this line.
impl<'de> Deserialize<'de> for ModelId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self::new(String::deserialize(d)?))
    }
}

/// The model a session starts on when nobody picked one.
///
/// Per-harness because a harness cannot run another's models at all — handing
/// Codex `opus` fails the spawn rather than falling back. Both named ones are
/// the strong model deliberately: this is the default for a session nobody is
/// sitting in front of, where a weak model costs work redone by hand.
///
/// `None` for pi, meaning pass no `--model` and let pi's own settings decide.
/// It is the only honest answer — pi is multi-provider, so any constant named
/// here might not exist on the machine, and a spawn failing with "model not
/// found" for a model the reader never picked is the worst possible first run.
/// It is also the right one: a pi user has already told pi which model they
/// want, and overriding that from a wrapper is presumptuous.
///
/// Stated on the frontend too, in `DEFAULT_MODEL_FOR` in `lib/model.ts`, since
/// neither side can call the other.
pub fn default_model_for(harness: Harness) -> Option<ModelId> {
    match harness {
        Harness::ClaudeCode => Some(ModelId::new("opus")),
        Harness::Codex => Some(ModelId::new("gpt56_sol")),
        Harness::Pi => None,
        // No list to default out of, and nothing will spawn for it anyway, so
        // there is no model to name — the same `None` pi takes, for a different
        // reason.
        Harness::Other(_) => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// What an index entry records.
    pub id: ModelId,
    pub label: String,
    /// Empty means the model has no effort levels. The CLI tolerates `--effort`
    /// on such a model and ignores it, so this drives the UI and keeps the
    /// persisted value honest rather than preventing a crash.
    pub efforts: Vec<Effort>,
    pub default_effort: Option<Effort>,
    /// What `--model` receives, where that differs from the persisted id.
    ///
    /// The two genuinely differ — `gpt56_sol` on disk, `gpt-5.6-sol` on the
    /// command line — which is why the enum this replaces needed an `as_arg`
    /// table at all. That table, moved onto the row it describes, so a
    /// discovered model carries its own alias instead of needing an arm here.
    pub arg: String,
    /// Who serves it, where the harness has more than one.
    ///
    /// Empty for the two single-vendor harnesses, which is what the picker
    /// reads as "do not group". pi's ids are `provider/model`, so the split is
    /// its own and made once, in `harness/pi/models.rs`.
    #[serde(default)]
    pub provider: String,
    /// Whether the composer's image tray can send to this model at all.
    ///
    /// A real one says no: `gpt-5.3-codex-spark` reports `input: ["text"]`, and
    /// a tray that offers to attach a screenshot to it fails at the send with a
    /// sentence the reader cannot act on.
    #[serde(default)]
    pub accepts_images: bool,
    /// Drawn under the picker's "More models" submenu rather than at the top
    /// level, and skipped by Shift+Tab.
    ///
    /// The chord cycles the list in order, which only works while the list is
    /// short — so this is what keeps it short as pinned and older models are
    /// added. A reader who picks one from the submenu keeps it: the flag
    /// decides where a row is *drawn*, never what may be run.
    #[serde(default)]
    pub secondary: bool,
}

impl Model {
    fn new(
        id: &str,
        arg: &str,
        label: &str,
        efforts: Vec<Effort>,
        default_effort: Option<Effort>,
    ) -> Self {
        Self {
            id: ModelId::new(id),
            label: label.into(),
            efforts,
            default_effort,
            arg: arg.into(),
            // One vendor each, so there is nothing for the picker to group by.
            provider: String::new(),
            accepts_images: true,
            secondary: false,
        }
    }

    /// Moves the row under the picker's "More models" submenu.
    fn under_more(self) -> Self {
        Self {
            secondary: true,
            ..self
        }
    }
}

/// The full model list the UI's picker is built from.
///
/// Two at the top level and the rest under "More models", which is what keeps
/// Shift+Tab worth a chord — it cycles the top level alone, and two presses
/// covers it. The split is by how often a row is reached for, not by how good
/// the model is: Sonnet and Haiku are picked deliberately when they are picked
/// at all, where the top two are what a session is flipped between mid-thought.
///
/// **`fable` and `claude-fable-5` are both here on purpose, and the pair is
/// the whole reason this list has a second tier.** An alias follows the latest
/// model — `fable` resolves to `claude-fable-5-1` today, and to whatever ships
/// next without anything here changing — which is what the top level wants and
/// what makes a dated id wrong there. But following the latest is exactly what
/// a reader pinning a previous generation is asking *not* to do, and the CLI's
/// own picker offers no such row: it says "for other/previous model names,
/// specify with `--model`". So a pinned id is a row here or it is nowhere.
pub fn claude_models() -> Vec<Model> {
    use Effort::*;

    let all = vec![Low, Medium, High, Xhigh, Max];

    vec![
        Model::new("fable", "fable", "Fable 5.1", all.clone(), Some(High)),
        Model::new("opus", "opus", "Opus 5", all.clone(), Some(High)),
        Model::new(
            "claude-fable-5",
            "claude-fable-5",
            "Fable 5",
            all.clone(),
            Some(High),
        )
        .under_more(),
        Model::new("sonnet", "sonnet", "Sonnet 5", all, Some(High)).under_more(),
        Model::new("haiku", "haiku", "Haiku 4.5", Vec::new(), None).under_more(),
    ]
}

/// The models a harness can actually run.
///
/// Static rather than read from `model/list`, which app-server does answer:
/// the picker has to be built before a session exists, and there is no child to
/// ask until one does. Worth revisiting once a spare connection is cheap.
///
/// `ultra` is offered per model rather than across the family, because Codex
/// answers it that way: Sol and Terra report it, Luna does not.
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
    let all = vec![Low, Medium, High, Xhigh, Max];
    let with_ultra = vec![Low, Medium, High, Xhigh, Max, Ultra];

    vec![
        Model::new(
            "gpt56_sol",
            "gpt-5.6-sol",
            "5.6 Sol",
            with_ultra.clone(),
            Some(Medium),
        ),
        Model::new(
            "gpt56_terra",
            "gpt-5.6-terra",
            "5.6 Terra",
            with_ultra,
            Some(Medium),
        ),
        Model::new("gpt56_luna", "gpt-5.6-luna", "5.6 Luna", all, Some(Medium)),
    ]
}

/// Every Codex model this build can still *run*, listed or not.
///
/// [`codex_models`] is the picker's list and stops at the current family; this
/// is what [`find_model`] searches, so a session started on an older one
/// resumes instead of failing at the spawn with "unknown model".
fn every_codex_model() -> Vec<Model> {
    use Effort::*;

    let older = vec![Low, Medium, High, Xhigh];

    let mut all = codex_models();
    all.extend([
        Model::new("gpt55", "gpt-5.5", "GPT-5.5", older.clone(), Some(Medium)),
        Model::new("gpt54", "gpt-5.4", "GPT-5.4", older.clone(), Some(Medium)),
        Model::new(
            "gpt54_mini",
            "gpt-5.4-mini",
            "GPT-5.4-Mini",
            older,
            Some(Medium),
        ),
    ]);
    all
}

/// What the picker offers for a harness.
///
/// Empty for pi, and that is this slice's shape rather than pi's: its list is
/// answered by the machine, so it arrives from a probe rather than from here.
/// `agent_availability` reports pi unavailable until that probe exists, so an
/// empty list cannot reach a picker.
pub fn models_for(harness: Harness) -> Vec<Model> {
    match harness {
        Harness::ClaudeCode => claude_models(),
        Harness::Codex => codex_models(),
        Harness::Pi => Vec::new(),
        // Empty rather than a guess: this build cannot say what that harness
        // runs, and offering Claude's list would let a picker set a model the
        // session's own agent has never heard of.
        Harness::Other(_) => Vec::new(),
    }
}

/// Whether a harness can *run* a model, which is a wider question than whether
/// it offers one.
///
/// The two differ by exactly the models retired from a picker, and reading the
/// offered list for this is the bug it exists to prevent: a session started on
/// an older model would stop resuming the day its successor shipped, refused
/// for a stance nobody changed.
///
/// pi answers by elimination — anything that is not another harness's alias —
/// because only pi knows its own list and it changes with the reader's logins.
/// That is enough for the job: this exists to stop a Claude alias reaching a pi
/// spawn, and pi's own `Model not found` names anything narrower.
pub fn runs_on(id: &ModelId, harness: Harness) -> bool {
    if id.is_unset() {
        return false;
    }

    match harness {
        Harness::ClaudeCode => claude_models().iter().any(|m| &m.id == id),
        Harness::Codex => every_codex_model().iter().any(|m| &m.id == id),
        Harness::Pi => find_model(id).is_none(),
        // Nothing runs on a harness this build cannot spawn, and `false` is
        // the safe direction: it refuses a model rather than recording one
        // against a session that could never use it.
        Harness::Other(_) => false,
    }
}

/// `None` for anything this build doesn't list, including the unset sentinel
/// read back from an older index entry — so a spawn omits `--model` or fails
/// loudly rather than silently running a different model.
///
/// Searches both static harnesses because a model id names exactly one of them:
/// their aliases do not overlap, so there is nothing for a harness argument to
/// disambiguate and asking for one would only let a caller pass the wrong one.
/// pi's models are not here at all, which is what [`runs_on`] reads.
pub fn find_model(id: &ModelId) -> Option<Model> {
    if id.is_unset() {
        return None;
    }

    claude_models()
        .into_iter()
        .chain(every_codex_model())
        .find(|m| &m.id == id)
}

/// The id for a `--model` alias arriving from outside the app — the `dray`
/// CLI's own flag — or `None` where this harness cannot run it.
///
/// Deliberately strict for the two harnesses with a table: an unrecognized
/// alias is a typo worth reporting, where silently running a different model is
/// not. pi has no table to be strict against, so any alias is taken as written
/// and pi's own `Model not found: nope/nope` is the sentence that reports it —
/// which names exactly what was wrong, where a guess here could not.
pub fn id_for_arg(alias: &str, harness: Harness) -> Option<ModelId> {
    if alias.is_empty() {
        return None;
    }

    let id = match harness {
        Harness::Pi => ModelId::new(alias),
        _ => claude_models()
            .into_iter()
            .chain(every_codex_model())
            .find(|m| m.arg == alias)
            .map(|m| m.id)?,
    };

    // One gate for all three, so an alias can never resolve to a model its own
    // harness cannot run. It is the pi arm this catches: taking any alias as
    // written also takes `opus`, and a session recorded on it would fail at the
    // spawn for a model nobody typed — an inherited one, from a parent on
    // another harness.
    runs_on(&id, harness).then_some(id)
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

    fn id(s: &str) -> ModelId {
        ModelId::new(s)
    }

    /// A model dropped from the picker must still resume. The two lists differ
    /// by exactly the retired models, and reading the offered one for "may this
    /// run" is what would strand every session on an older generation.
    #[test]
    fn a_retired_model_still_runs_but_is_not_offered() {
        assert!(runs_on(&id("gpt55"), Harness::Codex));
        assert!(find_model(&id("gpt55")).is_some());
        assert!(!models_for(Harness::Codex)
            .iter()
            .any(|m| m.id == id("gpt55")));
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

    /// `ultra` is per model, not per family — Codex reports it on Sol and Terra
    /// and stops Luna at `max`. Offering it across the three would put a level
    /// on the wire that the model refuses.
    ///
    /// It is also **not** a synonym for `max`: Codex describes `max` as maximum
    /// reasoning depth and `ultra` as maximum reasoning *with automatic task
    /// delegation*, and lists both on the same model.
    #[test]
    fn only_the_codex_models_that_report_ultra_offer_it() {
        let tops: Vec<(String, Option<Effort>)> = codex_models()
            .into_iter()
            .map(|m| (m.label, m.efforts.last().copied()))
            .collect();

        assert_eq!(
            tops,
            [
                ("5.6 Sol".to_string(), Some(Effort::Ultra)),
                ("5.6 Terra".to_string(), Some(Effort::Ultra)),
                ("5.6 Luna".to_string(), Some(Effort::Max)),
            ]
        );

        // Claude's list stops at max: its `ultracode` is a session boolean
        // pairing xhigh with workflow orchestration, not a rung (DRA-140).
        assert!(claude_models()
            .iter()
            .all(|m| !m.efforts.contains(&Effort::Ultra)));
    }

    /// Verified against the CLI: `--effort` on Haiku is accepted and ignored,
    /// so this pins a UI/persistence rule, not a spawn failure.
    #[test]
    fn haiku_never_takes_an_effort() {
        let haiku = find_model(&id("haiku")).unwrap();

        assert_eq!(resolve_effort(&haiku, Some(Effort::Max)), None);
        assert_eq!(resolve_effort(&haiku, None), None);
    }

    #[test]
    fn unsupported_effort_falls_back_to_the_model_default() {
        let opus = find_model(&id("opus")).unwrap();

        assert_eq!(resolve_effort(&opus, Some(Effort::Low)), Some(Effort::Low));
        assert_eq!(resolve_effort(&opus, None), Some(Effort::High));
    }

    /// The `arg` is what `--model` receives, and a **top-level** one must stay
    /// a bare alias — a dated name there would freeze the picker's everyday
    /// models to a generation that stops receiving updates.
    ///
    /// The rule binds one direction only: "More models" holds both shapes, an
    /// alias for a model that is merely reached for less often (`haiku`) and a
    /// pinned id for a generation the reader is asking not to be moved off
    /// (`claude-fable-5`). Only the top level is alias-or-nothing.
    #[test]
    fn only_the_top_level_claude_models_are_bare_aliases() {
        for model in claude_models().iter().filter(|m| !m.secondary) {
            assert!(
                !model.arg.contains('-'),
                "{} is a dated id at the top level; that tier wants an alias",
                model.arg
            );
        }

        assert!(
            claude_models()
                .iter()
                .any(|m| m.secondary && m.arg.contains('-')),
            "nothing is pinned, so this test is asserting against an empty tier"
        );
    }

    /// Shift+Tab cycles the top level in order, so its length is what decides
    /// whether the chord beats opening the menu at all. Two is the budget.
    #[test]
    fn the_claude_shortcut_cycles_two_models() {
        let cycled: Vec<String> = claude_models()
            .into_iter()
            .filter(|m| !m.secondary)
            .map(|m| m.label)
            .collect();

        assert_eq!(cycled, ["Fable 5.1", "Opus 5"]);
    }

    /// The submenu is drawn in list order, so the order is the list's.
    #[test]
    fn more_models_runs_newest_family_first() {
        let more: Vec<String> = claude_models()
            .into_iter()
            .filter(|m| m.secondary)
            .map(|m| m.label)
            .collect();

        assert_eq!(more, ["Fable 5", "Sonnet 5", "Haiku 4.5"]);
    }

    /// The flag decides where a row is drawn and nothing else. A model reached
    /// through the submenu has to spawn exactly like one reached at the top
    /// level, or "More models" is a menu of models that cannot be run.
    #[test]
    fn a_model_under_more_still_runs() {
        let more: Vec<Model> = claude_models().into_iter().filter(|m| m.secondary).collect();
        assert!(!more.is_empty());

        for model in more {
            assert!(runs_on(&model.id, Harness::ClaudeCode));
            assert!(find_model(&model.id).is_some());
            assert_eq!(
                id_for_arg(&model.arg, Harness::ClaudeCode),
                Some(model.id.clone())
            );
        }
    }

    /// The persisted id and the CLI alias genuinely differ, and this is the
    /// pair that proves the split earns its place. Reading one for the other
    /// spawns with `gpt56_sol`, which Codex does not know.
    #[test]
    fn the_persisted_id_is_not_the_cli_alias() {
        let sol = find_model(&id("gpt56_sol")).unwrap();

        assert_eq!(sol.id.as_str(), "gpt56_sol");
        assert_eq!(sol.arg, "gpt-5.6-sol");
    }

    /// Every id the old enum could write must still name its model, or a real
    /// index entry loses the model it was started on.
    ///
    /// The spellings are `serde(rename_all = "snake_case")` applied to the
    /// variants this replaced, which is what 240 entries on disk carry.
    #[test]
    fn every_shipped_id_still_resolves() {
        for spelling in [
            "opus",
            "sonnet",
            "fable",
            "haiku",
            "gpt56_sol",
            "gpt56_terra",
            "gpt56_luna",
            "gpt55",
            "gpt54",
            "gpt54_mini",
        ] {
            let parsed: ModelId = serde_json::from_str(&format!("\"{spelling}\"")).unwrap();

            assert_eq!(parsed.as_str(), spelling);
            assert!(
                find_model(&parsed).is_some(),
                "{spelling} no longer names a model"
            );
            assert_eq!(
                serde_json::to_string(&parsed).unwrap(),
                format!("\"{spelling}\""),
                "{spelling} does not round-trip byte-identically"
            );
        }
    }

    /// Both spellings of "this build cannot name the model" have to read as one
    /// value, or the sentinel drifts into two states that compare unequal —
    /// and that comparison is what decides whether a live child is replaced.
    #[test]
    fn unknown_and_empty_are_one_sentinel() {
        let from_old_enum: ModelId = serde_json::from_str("\"unknown\"").unwrap();
        let from_a_fresh_entry: ModelId = serde_json::from_str("\"\"").unwrap();

        assert_eq!(from_old_enum, from_a_fresh_entry);
        assert_eq!(from_old_enum, ModelId::default());
        assert!(from_old_enum.is_unset());
        assert!(find_model(&from_old_enum).is_none());
        assert!(!runs_on(&from_old_enum, Harness::Pi));
    }

    /// An index entry naming a model this build dropped must not fail the whole
    /// index read, and must not reach a spawn either. It keeps its own spelling
    /// rather than being folded into the sentinel — the id is what the session
    /// was started on, and a later build that lists it again should find it.
    #[test]
    fn a_retired_model_reads_back_and_is_rejected() {
        let dated: ModelId = serde_json::from_str("\"opus-4-1-20250805\"").unwrap();

        assert_eq!(dated.as_str(), "opus-4-1-20250805");
        assert!(find_model(&dated).is_none());
    }

    /// A typo is worth reporting for the two harnesses that have a table, and
    /// cannot be reported for the one that does not.
    #[test]
    fn an_alias_resolves_only_where_its_harness_can_run_it() {
        assert_eq!(
            id_for_arg("opus", Harness::ClaudeCode),
            Some(id("opus")),
            "an alias must resolve to its persisted id, not to itself"
        );
        assert_eq!(id_for_arg("gpt-5.6-sol", Harness::Codex), Some(id("gpt56_sol")));

        assert_eq!(id_for_arg("opus", Harness::Codex), None);
        assert_eq!(id_for_arg("gpt-5.6-sol", Harness::ClaudeCode), None);
        assert_eq!(id_for_arg("nope", Harness::ClaudeCode), None);

        // pi takes any alias it is given, since only pi knows its own list.
        assert_eq!(
            id_for_arg("anthropic/claude-sonnet-4-5", Harness::Pi),
            Some(id("anthropic/claude-sonnet-4-5"))
        );
        // Except another harness's, which is the one thing it can rule out.
        assert_eq!(id_for_arg("opus", Harness::Pi), None);
        assert_eq!(id_for_arg("", Harness::Pi), None);
    }

    /// pi names no default, and the other two must not lose theirs to the
    /// `Option` that makes room for it.
    #[test]
    fn only_pi_has_no_default_model() {
        assert_eq!(default_model_for(Harness::ClaudeCode), Some(id("opus")));
        assert_eq!(default_model_for(Harness::Codex), Some(id("gpt56_sol")));
        assert_eq!(default_model_for(Harness::Pi), None);

        for harness in [Harness::ClaudeCode, Harness::Codex] {
            let default = default_model_for(harness).unwrap();
            assert!(
                runs_on(&default, harness),
                "{harness:?} defaults to a model it cannot run"
            );
            assert!(find_model(&default).is_some());
        }
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

        assert_eq!(serde_json::to_string(&Some(Effort::Max)).unwrap(), "\"max\"");
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
            Effort::Ultra,
        ] {
            let json = serde_json::to_string(&e).unwrap();
            assert_eq!(json, format!("\"{}\"", e.as_arg()));
            assert_eq!(Effort::from_arg(e.as_arg()), Some(e), "{} lost its inverse", e.as_arg());
        }
    }

    /// The id is a bare string on the wire, not a wrapper object — which is
    /// what every entry on disk already holds, and what makes this change a
    /// rename rather than a migration.
    #[test]
    fn a_model_id_is_a_bare_string() {
        assert_eq!(
            serde_json::to_string(&ModelId::new("opus")).unwrap(),
            "\"opus\""
        );
    }
}
