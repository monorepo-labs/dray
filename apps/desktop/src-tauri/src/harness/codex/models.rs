//! Which models Codex can run here, asked of Codex.
//!
//! `models::codex_models` named them by hand, which meant a model OpenAI shipped
//! was unpickable until Dray shipped too — and the app-server has answered
//! `model/list` the whole time. So the table stops being the list and becomes
//! the **fallback**: what the picker draws when the probe cannot run, which is
//! every reader with no `codex` installed and every moment the CLI is mid-update
//! (DRA-137).
//!
//! Same shape as [`pi::models`](crate::harness::pi::models), one harness over.
//! The difference is what failure answers: pi answers an empty list, since only
//! pi knows pi's models, where Dray does know Codex's and a picker with no rows
//! in it would be a worse answer than a slightly old one.

use super::probe;
use crate::harness::{Harness, ProbeCache};
use crate::models::{codex_models, default_model_for, every_codex_model, Effort, Model, ModelId};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::LazyLock;
use std::time::Duration;

/// Kept for the life of the process, as the skill list next door is. Codex's
/// list changes when OpenAI ships a model or the reader updates the CLI —
/// neither happens mid-session, and a probe costs a child that starts every MCP
/// server the reader has configured. `forget` is the cure for the rare case.
static CACHE: LazyLock<ProbeCache<Vec<Model>>> = LazyLock::new(|| ProbeCache::new(Duration::MAX));

/// How many rows sit at the picker's top level, the rest folding into "More
/// models".
///
/// Also exactly what Shift+Tab cycles, so it is a budget rather than a taste:
/// the chord is only worth pressing while the list it walks is short. A cap, not
/// a quota: [`fold`] fills it only with rows the table puts at the top level or
/// has never heard of, so a Codex missing one of the table's two draws one.
const TOP_LEVEL: usize = 3;

/// Every model Codex reports, newest answer or a cached one.
pub async fn list() -> Vec<Model> {
    CACHE.get_or_probe("", probe).await.unwrap_or_else(|err| {
        eprintln!("[codex models] {err:#}");
        codex_models()
    })
}

/// The model with this id, from whatever Codex last reported.
pub async fn find(id: &ModelId) -> Option<Model> {
    resolve(id, &list().await)
}

/// Three answers, in order, and the last one is the whole reason this is a
/// function rather than a `find`.
///
/// The table is asked after the list because it holds the generations the
/// picker retired, so a session started on one still resumes.
///
/// Past both, an id is taken **as written** — pi's rule, for pi's reason. A
/// *discovered* model is one no table here names, so a restart whose probe
/// cannot complete can leave a live session's own model unnameable; refusing it
/// there reports "not a Codex model" about a model this app itself offered, and
/// the session cannot be resumed by any retry that does not also fix Codex. As
/// written, the id **is** the alias, and a Codex that genuinely cannot run it
/// says so in its own words — which names the real fault where a guess here
/// could not. The stand-in carries no ladder, so that one spawn omits
/// `--effort` and Codex uses its own; the recorded level is untouched and the
/// next answered probe restores the real row.
///
/// What it must not do is make *everything* runnable: `send_msg` reads
/// `Some`/`None` here as "can Codex run this", so a Claude alias has to come
/// back `None` or a session would spawn Codex on `opus`. `find_model` is what
/// asks that, being the one table that holds both harnesses.
fn resolve(id: &ModelId, discovered: &[Model]) -> Option<Model> {
    if id.is_unset() {
        return None;
    }

    if let Some(model) = discovered
        .iter()
        .cloned()
        .find(|m| &m.id == id)
        .or_else(|| every_codex_model().into_iter().find(|m| &m.id == id))
    {
        return Some(model);
    }

    crate::models::find_model(id).is_none().then(|| Model {
        id: id.clone(),
        label: id.to_string(),
        efforts: Vec::new(),
        default_effort: None,
        arg: id.to_string(),
        provider: String::new(),
        accepts_images: true,
        secondary: true,
        // Nothing here names the model, so nothing here knows whether it has a
        // faster tier. Off: a switch drawn over a guess is accepted silently by
        // `turn/start`, where an absent one only costs a model nobody has
        // heard of its speed.
        supports_fast: false,
    })
}

/// The model a Codex session starts on when nobody picked one: the table's
/// default where the installed Codex lists it, the table's other top-level row
/// next, the list's first row last.
///
/// **Named, then checked — never the list's first row alone.** It was that row,
/// and reading it survived only while the list arrived in the wire's order:
/// [`fold`] now ranks the picker itself, so the same read moved the *creation*
/// default onto whichever model this build would draw first, and onto any model
/// it has never heard of. A `dray new` naming no model would have changed
/// generation under the reader with nothing on screen saying so.
///
/// The check is what the old reading was really buying, and it is kept: the
/// table's default is a model this build knows and the *installed* Codex may
/// not, and one it does not list is a create that fails at the spawn for a
/// choice nobody made. So it is taken only where Codex answers for it, and the
/// table's own top level stands in otherwise — GPT-6 Sol is the default, and a
/// Codex not yet updated to list it lands on 6 Astra rather than on whatever
/// [`fold`] draws first, which may be a model this build has never heard of. A probe that cannot run falls back to the table
/// through [`list`], so the old answer is still the answer where there is
/// nothing better.
pub async fn default_model() -> ModelId {
    pick_default(&list().await)
}

fn pick_default(models: &[Model]) -> ModelId {
    let listed = |id: &ModelId| models.iter().any(|m| &m.id == id);

    default_model_for(Harness::Codex)
        .into_iter()
        .chain(codex_models().into_iter().filter(|m| !m.secondary).map(|m| m.id))
        .find(|id| listed(id))
        .or_else(|| models.first().map(|m| m.id.clone()))
        .unwrap_or_default()
}

/// The id for a `--model` alias, from what Codex reported *or* the table.
///
/// The table alone would refuse an alias for a model newer than this build —
/// which is the one thing `dray new --model` most wants to name, since the
/// picker is already offering it.
pub async fn id_for_arg(alias: &str) -> Option<ModelId> {
    list()
        .await
        .into_iter()
        .chain(every_codex_model())
        .find(|m| m.arg == alias)
        .map(|m| m.id)
}

/// Drops the cached answer, so the next read asks Codex again.
pub fn forget() {
    CACHE.forget();
}

/// A page of rows, so a list longer than one page is not silently halved.
///
/// `limit` is the server's own knob and its `nextCursor` is what pages the rest
/// — verified live, where a bogus cursor is refused outright (`invalid cursor`)
/// rather than ignored. The cap is there so a server answering its own cursor
/// forever cannot spin: ten pages is far past any model list, and stopping
/// short costs the rows the table would have named anyway.
const MAX_PAGES: usize = 10;

async fn probe() -> Result<Vec<Model>> {
    let mut rows = Vec::new();
    let mut cursor: Option<Value> = None;

    for _ in 0..MAX_PAGES {
        // No cwd: `model/list` is an account-wide answer, where the skill list
        // next door is per project. `includeHidden` stays off — it adds
        // internal rows (`gpt-reserve`, `codex-auto-review`) nobody picked.
        let mut params = json!({"includeHidden": false});
        if let Some(cursor) = cursor.take() {
            params["cursor"] = cursor;
        }

        let answer = probe::ask(None, "model/list", params).await?;
        let Some(page) = read_page(&answer) else { break };

        rows.extend(page.rows);
        match page.next {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    let models = fold(rows);

    // An answer this build cannot read is not an empty picker: the caller falls
    // back to the table, which is a stale list rather than no list.
    if models.is_empty() {
        bail!("codex listed no models this build could read");
    }

    Ok(models)
}

/// One row of `model/list`, which answers far more than this — an upgrade
/// notice, a first-run blurb, a personality flag. Only what the picker draws and
/// what a spawn needs is read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    #[serde(default)]
    display_name: String,
    /// An internal model. Absent means visible, which is the ordinary row.
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    supported_reasoning_efforts: Vec<Rung>,
    #[serde(default)]
    input_modalities: Vec<String>,
    /// The speeds this model can be run at above its ordinary one — `["fast"]`
    /// on every row captured so far, and the two spellings are one thing: the
    /// name here is `fast` while the tier it selects is `priority`, which is
    /// what `serviceTier` takes. Both are read because either alone would be a
    /// guess about which one a later Codex drops.
    #[serde(default)]
    additional_speed_tiers: Vec<String>,
    /// Left untyped because only its *length* is read. Codex's own `id`, `name`
    /// and `description` are drawn nowhere — the switch says one thing and the
    /// wording beside it is Dray's — and a shape typed for a field nobody reads
    /// is one more way for a changed row to cost the whole picker.
    #[serde(default)]
    service_tiers: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rung {
    reasoning_effort: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelList {
    #[serde(default)]
    data: Vec<Row>,
    /// Whatever the server wants handed back to reach the next page — a number
    /// today, kept whole rather than typed, since only the server reads it.
    #[serde(default)]
    next_cursor: Option<Value>,
}

struct Page {
    rows: Vec<Row>,
    next: Option<Value>,
}

/// One page of `model/list`, or `None` where this build cannot read the shape.
///
/// Read leniently for `map_model_usage`'s reason: a field Codex adds later must
/// cost nothing, and a shape it changes must cost the *list* rather than the
/// app — the caller reads no rows as "use the table".
fn read_page(answer: &Value) -> Option<Page> {
    let list = serde_json::from_value::<ModelList>(answer.clone()).ok()?;

    Some(Page {
        rows: list.data,
        next: list.next_cursor.filter(|next| !next.is_null()),
    })
}

/// Every page's rows folded into the picker's list.
///
/// Tier is counted across the whole list rather than per page, or a second page
/// would start its own top level and put six rows in a three-row cycle.
///
/// **The wire's order is not the tier, measured.** Codex answers `gpt-5.6-sol`
/// ahead of `gpt-6-astra` — its own recommendation first, not its newest — so
/// reading position as rank put last generation's flagship at the top of the
/// picker and of ⇧⇥'s cycle. A model this build *names* therefore takes
/// [`codex_models`]'s order, which is Dray's own answer to which it would put
/// first, and one it has never heard of **leads**: a model no table here holds
/// is the new one, and having it top the picker the day it ships is what
/// reading the list was for. Stable, so several unknowns keep the wire's
/// order among themselves.
fn fold(rows: Vec<Row>) -> Vec<Model> {
    let table = codex_models();
    let mut models: Vec<Model> = rows
        .iter()
        .filter(|row| !row.hidden && !row.id.is_empty())
        .map(row_to_model)
        .collect();

    models.sort_by_key(|model| {
        match table.iter().position(|known| known.id == model.id) {
            Some(at) => at as i64,
            // Named by `every_codex_model` alone is a generation the picker
            // retired, still runnable and still answerable by Codex: it sinks
            // rather than leads, or "unknown here" would promote last year's.
            None if every_codex_model().iter().any(|m| m.id == model.id) => i64::MAX,
            None => -1,
        }
    });

    // A row the table names takes the table's tier, so an older Codex that
    // lists no GPT-6 Sol does not promote 6 Luna into its slot. One it has
    // never heard of is the new flagship and competes for the top level.
    let mut top = 0;
    for model in &mut models {
        let wants_top = match table.iter().find(|known| known.id == model.id) {
            Some(known) => !known.secondary,
            None => !every_codex_model().iter().any(|m| m.id == model.id),
        };
        model.secondary = !wants_top || top >= TOP_LEVEL;
        if !model.secondary {
            top += 1;
        }
    }

    models
}

/// One page, for a caller that has the whole answer in hand — the tests.
#[cfg(test)]
fn read_rows(answer: &Value) -> Vec<Model> {
    read_page(answer).map(|page| fold(page.rows)).unwrap_or_default()
}

/// Reads one row, keeping the id this app has always persisted for it.
///
/// **The id is the whole care here.** An index entry records `gpt56_sol` where
/// the wire says `gpt-5.6-sol`, and minting the wire spelling would leave every
/// running Codex session naming a model the picker no longer lists — its row
/// would read as unknown and the composer would move it to the default. So a
/// row Dray already knows keeps the table's id and label, and only a model this
/// build has never heard of is minted from the wire.
/// Tier is left to [`fold`], which is the only place that knows a row's final
/// position — the wire's own is not it.
fn row_to_model(row: &Row) -> Model {
    let known = every_codex_model().into_iter().find(|m| m.arg == row.id);
    let efforts = ladder(row);

    Model {
        id: known
            .as_ref()
            .map(|m| m.id.clone())
            .unwrap_or_else(|| ModelId::new(&row.id)),
        label: known
            .map(|m| m.label)
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| display_name(row)),
        default_effort: default_effort(&efforts),
        efforts,
        arg: row.id.clone(),
        // One vendor, so there is nothing for the picker to group by.
        provider: String::new(),
        accepts_images: accepts_images(row),
        secondary: false,
        supports_fast: supports_fast(row),
    }
}

/// Whether this row has a faster tier to ask for.
///
/// **Absent means no, the opposite reading to `accepts_images` next door, and
/// the asymmetry is the point.** A wrongly offered attachment is refused with
/// Codex's own sentence; a wrongly offered speed switch is *accepted silently*
/// — `turn/start` takes an unknown `serviceTier` with no error, records it on
/// the thread and runs the turn at ordinary speed — so a fast mode that does
/// nothing looks exactly like one that works.
///
/// Which is why the question is **"does it offer the tier the spawn sends"**
/// and not "does it offer any tier". The spawn sends the literal
/// [`FAST_TIER`](super::FAST_TIER) whatever this answers, so a model serving
/// some other tier and nothing else would draw a switch that changes nothing at
/// all. Both spellings are checked because Codex publishes both and either
/// alone would be a guess about which one it keeps.
fn supports_fast(row: &Row) -> bool {
    row.additional_speed_tiers
        .iter()
        .any(|speed| speed == super::FAST_SPEED)
        || row
            .service_tiers
            .iter()
            .any(|tier| tier.get("id").and_then(Value::as_str) == Some(super::FAST_TIER))
}

fn display_name(row: &Row) -> String {
    if row.display_name.is_empty() {
        row.id.clone()
    } else {
        row.display_name.clone()
    }
}

/// Dray's own ladder, out of the rungs this row reports. A level Dray cannot
/// spell is dropped rather than guessed at — it could not be persisted anyway.
fn ladder(row: &Row) -> Vec<Effort> {
    row.supported_reasoning_efforts
        .iter()
        .filter_map(|rung| Effort::from_arg(&rung.reasoning_effort))
        .collect()
}

/// Medium, and **deliberately not the row's own `defaultReasoningEffort`.**
///
/// Which model a reader can run is Codex's answer; how hard Dray sets it
/// working is Dray's, and the CLI's settings have no business arriving through
/// the back door of a list read for something else — Codex answers `low` on its
/// top two models today, so taking it would have quietly moved everybody down a
/// rung. The reader's own pick is what overrides this, and it persists, exactly
/// as it did while the table named the level.
///
/// The fallback only matters for a model whose ladder skips Medium, which no
/// Codex model has ever done.
fn default_effort(efforts: &[Effort]) -> Option<Effort> {
    efforts
        .contains(&Effort::Medium)
        .then_some(Effort::Medium)
        .or_else(|| efforts.first().copied())
}

fn accepts_images(row: &Row) -> bool {
    // Absent means Codex did not say. Assumed yes, because the cost of being
    // wrong is one refused attachment carrying Codex's own sentence, where the
    // other way round silently hides a working feature.
    row.input_modalities.is_empty() || row.input_modalities.iter().any(|kind| kind == "image")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `model/list`, `includeHidden: true` so the filter has something to
    /// drop. Captured off `codex-cli 0.154.0`.
    fn captured() -> Value {
        serde_json::from_str(include_str!("fixtures/model_list.json")).expect("fixture json")
    }

    /// The same answer off `codex-cli 0.156.1`, the first to list GPT-6 Sol.
    /// `captured` is now what a reader who has not updated Codex sees.
    fn captured_gpt6() -> Value {
        serde_json::from_str(include_str!("fixtures/model_list_gpt6.json")).expect("fixture json")
    }

    fn cycled(models: &[Model]) -> Vec<&str> {
        models
            .iter()
            .filter(|m| !m.secondary)
            .map(|m| m.label.as_str())
            .collect()
    }

    #[test]
    fn the_captured_list_is_read_whole() {
        let models = read_rows(&captured_gpt6());

        let labels: Vec<&str> = models.iter().map(|m| m.label.as_str()).collect();
        assert_eq!(
            labels,
            ["6 Astra", "6 Sol", "5.6 Sol", "6 Luna", "5.6 Terra", "5.6 Luna", "GPT-5.5"]
        );
        assert!(models.iter().all(|m| m.accepts_images));
    }

    /// A Codex not yet updated lists no GPT-6 Sol, so the picker draws no row
    /// for it and does not promote 6 Luna into its slot.
    #[test]
    fn an_older_codex_draws_no_6_sol() {
        let models = read_rows(&captured());

        assert!(!models.iter().any(|m| m.arg == "gpt-6-sol"));
        assert_eq!(cycled(&models), ["6 Astra", "5.6 Sol"]);
    }

    /// The default is GPT-6 Sol only where Codex lists it; an older one lands
    /// on the table's next top-level row, never on a model it cannot run.
    #[test]
    fn the_default_is_a_model_the_installed_codex_lists() {
        assert_eq!(pick_default(&read_rows(&captured_gpt6())).as_str(), "gpt-6-sol");
        assert_eq!(pick_default(&read_rows(&captured())).as_str(), "gpt6_astra");
    }

    /// Internal rows are not models anybody picked, and the capture carries two.
    #[test]
    fn a_hidden_model_is_not_offered() {
        let models = read_rows(&captured());

        assert!(!models.iter().any(|m| m.arg == "gpt-reserve"));
        assert!(!models.iter().any(|m| m.arg == "codex-auto-review"));
    }

    /// The id an index entry already holds, not the wire's spelling. Minting
    /// `gpt-5.6-sol` here would leave every running Codex session naming a model
    /// the picker no longer lists.
    #[test]
    fn a_model_dray_already_knows_keeps_its_persisted_id() {
        let models = read_rows(&captured());

        let sol = models.iter().find(|m| m.arg == "gpt-5.6-sol").unwrap();
        assert_eq!(sol.id.as_str(), "gpt56_sol");

        let astra = models.iter().find(|m| m.arg == "gpt-6-astra").unwrap();
        assert_eq!(astra.id.as_str(), "gpt6_astra");
    }

    /// A model this build has never heard of is still offered, and its id is the
    /// wire's — which is the entire point of asking rather than listing.
    #[test]
    fn an_unknown_model_is_offered_under_its_own_id() {
        let rows = json!({"data": [{
            "id": "gpt-7-nova",
            "displayName": "GPT-7-Nova",
            "supportedReasoningEfforts": [{"reasoningEffort": "high"}],
            "defaultReasoningEffort": "high",
            "inputModalities": ["text", "image"],
        }]});

        let models = read_rows(&rows);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id.as_str(), "gpt-7-nova");
        assert_eq!(models[0].arg, "gpt-7-nova");
        assert_eq!(models[0].label, "GPT-7-Nova");
        assert_eq!(models[0].efforts, vec![Effort::High]);
    }

    /// Shift+Tab cycles the top level, so three rows is the budget and everything
    /// else folds into "More models" — including a generation the hand-written
    /// list had retired outright.
    #[test]
    fn astra_and_the_two_sols_are_the_cycle() {
        let models = read_rows(&captured_gpt6());

        assert_eq!(cycled(&models), ["6 Astra", "6 Sol", "5.6 Sol"]);
        assert!(models.iter().filter(|m| m.secondary).count() >= 2);
    }

    /// The wire's order is Codex's own recommendation, not the tier, so the
    /// order is this build's — except for a model it has never heard of, which
    /// is the new one and leads, and a generation the picker retired, which
    /// sinks.
    #[test]
    fn the_order_is_drays_own_and_a_new_model_still_leads() {
        let wire = json!({"data": [
            {"id": "gpt-5.6-sol"},
            {"id": "gpt-5.5"},
            {"id": "gpt-6-astra"},
            {"id": "gpt-6-sol"},
            {"id": "gpt-7-nova"},
        ]});

        let models = read_rows(&wire);
        let labels: Vec<&str> = models.iter().map(|m| m.label.as_str()).collect();

        assert_eq!(labels, ["gpt-7-nova", "6 Astra", "6 Sol", "5.6 Sol", "GPT-5.5"]);
        assert_eq!(cycled(&models), ["gpt-7-nova", "6 Astra", "6 Sol"]);
    }

    /// `ultra` is per model and Codex says which: Sol reports it, Luna stops at
    /// `max`. Reading the family would put a level on the wire Luna refuses.
    #[test]
    fn the_ladder_is_the_rows_own() {
        let models = read_rows(&captured_gpt6());
        let ladder = |arg: &str| {
            models
                .iter()
                .find(|m| m.arg == arg)
                .map(|m| m.efforts.clone())
                .unwrap()
        };

        assert_eq!(ladder("gpt-6-astra").last(), Some(&Effort::Ultra));
        assert_eq!(ladder("gpt-6-sol").last(), Some(&Effort::Ultra));
        assert_eq!(ladder("gpt-6-luna").last(), Some(&Effort::Max));
        assert_eq!(ladder("gpt-5.6-luna").last(), Some(&Effort::Max));
        assert_eq!(
            ladder("gpt-5.5"),
            vec![Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh]
        );
    }

    /// Medium, whatever the CLI says its own default is — the capture has
    /// `low` on Astra and Sol. Which models exist is Codex's answer; how hard
    /// Dray sets one working is Dray's, and the reader's own pick overrides it.
    #[test]
    fn the_default_effort_is_drays_own_and_not_the_clis() {
        let models = read_rows(&captured());

        assert!(models
            .iter()
            .all(|m| m.default_effort == Some(Effort::Medium)));
    }

    /// A ladder with no Medium in it still has to answer something.
    #[test]
    fn a_ladder_without_medium_falls_back_to_its_first_rung() {
        let rows = json!({"data": [{"id": "a",
            "supportedReasoningEfforts": [{"reasoningEffort": "high"}],
            "defaultReasoningEffort": "low"}]});

        assert_eq!(read_rows(&rows)[0].default_effort, Some(Effort::High));
    }

    /// A level this build cannot spell costs that rung and nothing else — it
    /// could not be persisted anyway.
    #[test]
    fn an_unknown_rung_is_dropped_and_the_row_survives() {
        let rows = json!({"data": [{
            "id": "a",
            "supportedReasoningEfforts": [{"reasoningEffort": "hyper"},
                                          {"reasoningEffort": "high"}],
        }]});

        let models = read_rows(&rows);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].efforts, vec![Effort::High]);
    }

    /// Every row of the real capture offers the `priority` tier, so the whole
    /// picker draws the switch.
    #[test]
    fn the_capture_says_every_model_has_a_faster_tier() {
        let models = read_rows(&captured());

        assert!(!models.is_empty());
        assert!(models.iter().all(|m| m.supports_fast), "{models:#?}");
    }

    /// Absent means no, the opposite reading to `acceptsImages` beside it: a
    /// `serviceTier` Codex does not recognise is accepted with no error and the
    /// turn runs at ordinary speed, so a wrongly offered switch is
    /// indistinguishable from a working one.
    #[test]
    fn a_row_naming_no_tier_offers_no_fast_mode() {
        let rows = json!({"data": [
            {"id": "plain"},
            {"id": "speed-only", "additionalSpeedTiers": ["fast"]},
            {"id": "tier-only", "serviceTiers": [{"id": "priority"}]},
            // A tier that is not the one the spawn sends. The switch would run
            // every turn at ordinary speed and say nothing about it.
            {"id": "some-other-tier", "additionalSpeedTiers": ["turbo"],
             "serviceTiers": [{"id": "flex"}]},
        ]});

        let models = read_rows(&rows);
        let offered: Vec<(&str, bool)> = models
            .iter()
            .map(|m| (m.arg.as_str(), m.supports_fast))
            .collect();

        assert_eq!(
            offered,
            [
                ("plain", false),
                ("speed-only", true),
                ("tier-only", true),
                ("some-other-tier", false),
            ]
        );
    }

    /// A list longer than one page is paged, not halved — and the tier is
    /// counted across the whole thing, or page two starts its own top level.
    #[test]
    fn a_second_page_is_read_and_tiered_with_the_first() {
        let page_one = json!({"data": [{"id": "a"}, {"id": "b"}], "nextCursor": 2});
        let page_two = json!({"data": [{"id": "c"}, {"id": "d"}], "nextCursor": null});

        let first = read_page(&page_one).unwrap();
        let second = read_page(&page_two).unwrap();

        assert_eq!(first.next, Some(json!(2)));
        assert_eq!(second.next, None);

        let mut rows = first.rows;
        rows.extend(second.rows);
        let models = fold(rows);

        let tiers: Vec<(&str, bool)> = models
            .iter()
            .map(|m| (m.arg.as_str(), m.secondary))
            .collect();
        assert_eq!(tiers, [("a", false), ("b", false), ("c", false), ("d", true)]);
    }

    /// The capture's own cursor is null, which is what one page looks like.
    #[test]
    fn a_single_page_answers_no_cursor() {
        assert_eq!(read_page(&captured()).unwrap().next, None);
    }

    /// Discovered first, then the table for a generation the picker retired.
    #[test]
    fn a_model_resolves_from_the_list_then_from_the_table() {
        let discovered = read_rows(&captured());

        let astra = resolve(&ModelId::new("gpt6_astra"), &discovered).unwrap();
        assert_eq!(astra.arg, "gpt-6-astra");

        // Retired from the picker, still runnable, and not in the capture.
        let old = resolve(&ModelId::new("gpt54"), &discovered).unwrap();
        assert_eq!(old.arg, "gpt-5.4");

        assert!(resolve(&ModelId::default(), &discovered).is_none());
    }

    /// A session started on a model only Codex named must still resume when the
    /// probe cannot answer — the restart case, where neither list holds it. The
    /// id is the alias, so Codex is the one that reports a model it cannot run.
    #[test]
    fn a_model_no_list_names_is_taken_as_written() {
        let stood_in = resolve(&ModelId::new("gpt-7-nova"), &[]).unwrap();

        assert_eq!(stood_in.arg, "gpt-7-nova");
        assert_eq!(stood_in.id.as_str(), "gpt-7-nova");
        // No ladder, so the spawn omits `--effort` rather than sending a rung
        // nothing has said this model takes.
        assert!(stood_in.efforts.is_empty());
        assert_eq!(stood_in.default_effort, None);
    }

    /// And it must not make everything runnable: `send_msg` reads this as "can
    /// Codex run it", so another harness's model has to come back `None` or a
    /// Codex session would spawn on `opus`.
    #[test]
    fn another_harnesss_model_is_still_refused() {
        for alias in ["opus", "sonnet", "haiku", "fable"] {
            assert!(resolve(&ModelId::new(alias), &[]).is_none(), "{alias} resolved");
        }
    }

    /// A shape this build cannot read is an empty answer, which the caller turns
    /// into the static table rather than into an empty picker.
    #[test]
    fn an_unreadable_answer_reads_as_no_rows() {
        assert!(read_rows(&json!({"data": "not a list"})).is_empty());
        assert!(read_rows(&json!(null)).is_empty());
        assert!(read_rows(&json!({})).is_empty());
    }

    /// A model that takes no images, which the composer's tray has to know
    /// before it offers to send one.
    #[test]
    fn a_text_only_model_says_so() {
        let rows = json!({"data": [{"id": "a", "inputModalities": ["text"]}]});

        assert!(!read_rows(&rows)[0].accepts_images);
    }

    /// The probe against the codex on this machine, printed rather than
    /// asserted. Everything above reads a capture, so it proves the parse and
    /// nothing about whether `model/list` still answers — which is the half a
    /// new CLI can break. Ignored by default: it spawns a child.
    #[tokio::test]
    #[ignore]
    async fn what_the_installed_codex_answers() {
        let models = probe().await.expect("codex answered the probe");

        for model in &models {
            let efforts: Vec<_> = model.efforts.iter().map(|e| e.as_arg()).collect();
            println!(
                "  {:<20} {:<16} {}{}",
                model.arg,
                model.label,
                efforts.join(" "),
                if model.secondary { "  (more)" } else { "" }
            );
        }

        assert!(!models.is_empty(), "codex reported no models at all");
    }
}
