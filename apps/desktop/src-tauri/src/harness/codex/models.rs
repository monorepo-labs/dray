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
use crate::harness::ProbeCache;
use crate::models::{codex_models, every_codex_model, Effort, Model, ModelId};
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
/// the chord is only worth pressing while the list it walks is short. Taken by
/// position because Codex lists its own newest first — so a new flagship lands
/// at the top of the cycle the day it ships, which is the whole point of asking.
const TOP_LEVEL: usize = 2;

/// Every model Codex reports, newest answer or a cached one.
pub async fn list() -> Vec<Model> {
    CACHE.get_or_probe("", probe).await.unwrap_or_else(|err| {
        eprintln!("[codex models] {err:#}");
        codex_models()
    })
}

/// The model with this id, from whatever Codex last reported.
///
/// Falls through to the static table, which holds the generations the picker
/// retired *and* everything Codex would have answered had the probe run — so a
/// session started on an older model still resumes, and a spawn still knows the
/// `--model` alias when the probe is down.
pub async fn find(id: &ModelId) -> Option<Model> {
    if id.is_unset() {
        return None;
    }

    list()
        .await
        .into_iter()
        .find(|m| &m.id == id)
        .or_else(|| every_codex_model().into_iter().find(|m| &m.id == id))
}

/// The model a Codex session starts on when nobody picked one: the list's own
/// first row, which is Codex's newest.
///
/// Asked rather than named, because the table's default is a model this build
/// knows and the *installed* Codex may not — `gpt6_astra` seeded onto a CLI
/// predating Astra is a create that fails at the spawn for a choice nobody
/// made. A probe that cannot run falls back to the table through [`list`], so
/// the old answer is still the answer where there is nothing better.
pub async fn default_model() -> ModelId {
    list()
        .await
        .first()
        .map(|m| m.id.clone())
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
/// notice, a first-run blurb, service tiers. Only what the picker draws and what
/// a spawn needs is read.
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
/// would start its own top level and put four rows in a two-row cycle.
fn fold(rows: Vec<Row>) -> Vec<Model> {
    rows.iter()
        .filter(|row| !row.hidden && !row.id.is_empty())
        .enumerate()
        .map(|(at, row)| row_to_model(row, at))
        .collect()
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
fn row_to_model(row: &Row, at: usize) -> Model {
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
        secondary: at >= TOP_LEVEL,
    }
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

    /// The whole argument for asking: GPT-6-Astra is in the capture, and no
    /// table in this repo could have named it before it shipped.
    #[test]
    fn the_captured_list_is_read_whole() {
        let models = read_rows(&captured());

        let labels: Vec<&str> = models.iter().map(|m| m.label.as_str()).collect();
        assert_eq!(labels, ["Astra", "Sol", "Terra", "Luna", "GPT-5.5"]);
        assert!(models.iter().all(|m| m.accepts_images));
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

    /// Shift+Tab cycles the top level, so two rows is the budget and everything
    /// else folds into "More models" — including a generation the hand-written
    /// list had retired outright.
    #[test]
    fn the_first_two_rows_are_the_cycle() {
        let models = read_rows(&captured());

        let cycled: Vec<&str> = models
            .iter()
            .filter(|m| !m.secondary)
            .map(|m| m.label.as_str())
            .collect();

        assert_eq!(cycled, ["Astra", "Sol"]);
        assert!(models.iter().filter(|m| m.secondary).count() >= 2);
    }

    /// `ultra` is per model and Codex says which: Sol reports it, Luna stops at
    /// `max`. Reading the family would put a level on the wire Luna refuses.
    #[test]
    fn the_ladder_is_the_rows_own() {
        let models = read_rows(&captured());
        let ladder = |arg: &str| {
            models
                .iter()
                .find(|m| m.arg == arg)
                .map(|m| m.efforts.clone())
                .unwrap()
        };

        assert_eq!(ladder("gpt-6-astra").last(), Some(&Effort::Ultra));
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

    /// A list longer than one page is paged, not halved — and the tier is
    /// counted across the whole thing, or page two starts its own top level.
    #[test]
    fn a_second_page_is_read_and_tiered_with_the_first() {
        let page_one = json!({"data": [{"id": "a"}, {"id": "b"}], "nextCursor": 2});
        let page_two = json!({"data": [{"id": "c"}], "nextCursor": null});

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
        assert_eq!(tiers, [("a", false), ("b", false), ("c", true)]);
    }

    /// The capture's own cursor is null, which is what one page looks like.
    #[test]
    fn a_single_page_answers_no_cursor() {
        assert_eq!(read_page(&captured()).unwrap().next, None);
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
