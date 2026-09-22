//! Which models Grok Build can run here, asked of grok.
//!
//! Codex's shape one harness over, and for its reason: a model xAI ships would
//! otherwise be unpickable until Dray ships too. The difference is where the
//! answer lives — Codex has a `model/list` method and grok puts the whole thing
//! on the handshake, so the probe is an `initialize` that opens no session and
//! writes nothing to disk.
//!
//! The table below is therefore the **fallback**: what the picker draws on a
//! machine with no `grok` installed, or in the moment the CLI is mid-update.

use crate::harness::{Harness, ProbeCache};
use crate::models::{default_model_for, Effort, Model, ModelId};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;
use std::time::Duration;

/// Kept for the life of the process, as Codex's list is. grok's list changes
/// when xAI ships a model or the reader updates the CLI, neither of which
/// happens mid-session, and [`forget`] is the cure for the rare case.
static CACHE: LazyLock<ProbeCache<Vec<Model>>> = LazyLock::new(|| ProbeCache::new(Duration::MAX));

/// How many rows sit at the picker's top level, the rest folding into "More
/// models". Also exactly what Shift+Tab cycles, so it is a budget rather than a
/// taste — grok's two newest models, with the older generations below.
///
/// Counted over the rows the picker *draws*: a fast twin is hidden, so it takes
/// no slot here. Spending one on it made the cycle a flip between a model and
/// its own fast tier rather than between two models.
const TOP_LEVEL: usize = 2;

/// The window every current grok model reports, and the denominator the context
/// ring needs: `_meta.totalTokens` on a prompt reply is a count with nothing
/// beside it.
pub const DEFAULT_CONTEXT_WINDOW: u64 = 500_000;

/// Every model grok reports, or the table where the probe cannot run.
///
/// Keyed on the empty string: which models an account can run is not a property
/// of any directory, unlike the command list next door.
pub async fn list() -> Vec<Model> {
    all().await.into_iter().filter(in_picker).collect()
}

/// Every model including the fast twins the picker hides.
///
/// **Hidden is never unrunnable** — the gateway's own rule next door. A session
/// recorded on `grok-4.7-build-fast`, whether by `dray new --model` or by a
/// build that listed it, has to resolve to a real row: filtered here it would
/// answer `None`, spawn with no model at all and record its own model as unset,
/// which is silent on screen and in the log.
async fn all() -> Vec<Model> {
    CACHE
        .get_or_probe("", || probe())
        .await
        .unwrap_or_else(|err| {
            eprintln!("[grok models] {err:#}");
            fallback()
        })
}

/// The model with this id, from whatever grok last reported.
pub async fn find(id: &ModelId) -> Option<Model> {
    resolve(id, &all().await)
}

/// grok's own spelling of a fast tier. Not `-fast`: the id is
/// `grok-4.7-build-fast`, and matching the shorter suffix would be a rule that
/// happens to work rather than the one grok writes.
const FAST_SUFFIX: &str = "-build-fast";

/// Whether this id *is* a fast tier rather than a model with one.
pub fn is_fast_twin(id: &str) -> bool {
    id.ends_with(FAST_SUFFIX)
}

/// Every row but the fast twins, which are a **mode** rather than a model.
///
/// Listing both is the same model twice — once as a row and once as a switch —
/// and picking the twin directly gives fast speed with an inert toggle beside
/// it. It also spent one of Shift+Tab's two cycle slots on a duplicate of the
/// other.
fn in_picker(model: &Model) -> bool {
    !is_fast_twin(&model.arg)
}

/// The id to actually send, given the reader's pick and their fast-mode switch.
///
/// This is grok's whole fast-mode mechanism: there is no flag and no settings
/// key, so the twin id *is* the fast tier. The base id comes back wherever the
/// switch is off or the model has no twin, so a pick this list cannot pair is
/// sent exactly as the reader made it.
pub async fn fast_arg(arg: &str, fast: bool) -> String {
    if !fast || is_fast_twin(arg) {
        return arg.to_string();
    }

    let twin = format!("{arg}{FAST_SUFFIX}");
    all()
        .await
        .iter()
        .any(|m| m.arg == twin)
        .then_some(twin)
        .unwrap_or_else(|| arg.to_string())
}

/// Three answers, in order, and the last is why this is a function rather than
/// a `find`.
///
/// Past the live list and the table, an id is taken **as written** — Codex's
/// rule, for Codex's reason. A restart whose probe cannot complete would
/// otherwise leave a live session's own model unnameable, and refusing it there
/// reports "not a grok model" about a model this app itself offered.
///
/// What it must not do is make *everything* runnable: `send_msg` reads
/// `Some`/`None` here as "can grok run this", so a Claude alias has to come back
/// `None` or a session would spawn grok on `opus`. `find_model` is what asks
/// that, being the one table holding both static harnesses.
fn resolve(id: &ModelId, discovered: &[Model]) -> Option<Model> {
    if id.is_unset() {
        return None;
    }

    if let Some(model) = discovered
        .iter()
        .cloned()
        .find(|m| &m.id == id)
        .or_else(|| fallback().into_iter().find(|m| &m.id == id))
    {
        return Some(model);
    }

    crate::models::find_model(id).is_none().then(|| Model {
        id: id.clone(),
        label: id.to_string(),
        // No ladder, so the spawn omits `--reasoning-effort` and grok uses its
        // own default. The recorded level is untouched and the next answered
        // probe restores the real row.
        efforts: Vec::new(),
        default_effort: None,
        arg: id.to_string(),
        provider: String::new(),
        accepts_images: false,
        secondary: true,
        supports_fast: false,
    })
}

/// The model a grok session starts on when nobody picked one: the named default
/// where the installed grok lists it, its first row otherwise.
///
/// **Named, then checked** — Codex's rule. The constant is a model this build
/// knows and the *installed* grok may not, and one it does not list is a create
/// that fails at the spawn for a choice nobody made.
pub async fn default_model() -> ModelId {
    let models = list().await;

    default_model_for(Harness::Grok)
        .filter(|id| models.iter().any(|m| &m.id == id))
        .or_else(|| models.first().map(|m| m.id.clone()))
        .unwrap_or_default()
}

/// The id for a `--model` alias, from what grok reported *or* the table.
///
/// grok's ids are its own aliases — `grok-4.7` is what the index records and
/// what `--model` takes — so this is a membership test rather than a lookup.
pub async fn id_for_arg(alias: &str) -> Option<ModelId> {
    list()
        .await
        .into_iter()
        .chain(fallback())
        .find(|m| m.arg == alias)
        .map(|m| m.id)
}

/// Drops the cached answer, so the next read asks grok again.
pub fn forget() {
    CACHE.forget();
}

async fn probe() -> Result<Vec<Model>> {
    let answer = super::probe::initialize(None).await?;
    let models = read_models(&answer);

    // An answer this build cannot read is not an empty picker: the caller falls
    // back to the table, which is a stale list rather than no list.
    if models.is_empty() {
        bail!("grok's handshake listed no models this build could read");
    }

    Ok(models)
}

/// `_meta.modelState` off an `initialize` reply, or an empty list where this
/// build cannot read the shape.
///
/// Read leniently: a field xAI adds later must cost nothing, and a shape it
/// changes must cost the *list* rather than the app.
pub fn read_models(reply: &Value) -> Vec<Model> {
    let Some(state) = reply.pointer("/_meta/modelState") else {
        return Vec::new();
    };
    let Ok(state) = serde_json::from_value::<ModelState>(state.clone()) else {
        return Vec::new();
    };

    fold(state.available_models)
}

/// The rows the picker draws, in the order it draws them.
///
/// grok lists newest first, so position is the ranking and the top two are its
/// flagship and that flagship's fast twin — the pair a session is flipped
/// between. Everything below folds into "More models" and out of Shift+Tab's
/// cycle, which is what keeps the chord worth pressing.
fn fold(rows: Vec<Row>) -> Vec<Model> {
    // Mapped over the whole set rather than one row at a time, because
    // `supports_fast` is a lookup *in* that set: a model's fast tier is another
    // row beside it.
    let ids: Vec<String> = rows.iter().map(|row| row.model_id.clone()).collect();
    // Counted over the rows the picker will actually draw, or hiding a twin
    // leaves a hole in the top level and the cycle is one row long.
    let mut visible = 0usize;

    rows.into_iter()
        .map(|row| {
            let twin = is_fast_twin(&row.model_id);
            let position = visible;
            if !twin {
                visible += 1;
            }
            let efforts: Vec<Effort> = row
                .meta
                .reasoning_efforts
                .iter()
                .filter_map(|rung| Effort::from_arg(&rung.value))
                // grok lists its ladder loudest-first; every picker here reads
                // it the other way.
                .rev()
                .collect();
            let default_effort = row
                .meta
                .reasoning_efforts
                .iter()
                .find(|rung| rung.default)
                .and_then(|rung| Effort::from_arg(&rung.value));

            Model {
                id: ModelId::new(&row.model_id),
                label: if row.name.is_empty() {
                    row.model_id.clone()
                } else {
                    row.name.clone()
                },
                // Absent where grok says the model does no reasoning, which
                // keeps the effort control off a row that would refuse it.
                efforts: if row.meta.supports_reasoning_effort {
                    efforts
                } else {
                    Vec::new()
                },
                default_effort,
                arg: row.model_id.clone(),
                // One vendor, so there is nothing for the picker to group by.
                provider: String::new(),
                // `promptCapabilities.image` is `false` on every grok
                // handshake, so the tray must not offer to attach a screenshot
                // to any of these.
                accepts_images: false,
                // A twin is never top level because it is never drawn at
                // all — `list` filters it out. Said here too so the flag can
                // never contradict that from the unfiltered list.
                secondary: twin || position >= TOP_LEVEL,
                // A twin exists beside this row, so the switch has something to
                // ask for. **A twin itself takes none** — it *is* the fast
                // tier, which is its own answer rather than the lookup happening
                // to miss for want of a `…-build-fast-build-fast`.
                supports_fast: !twin && ids.iter().any(|id| id == &format!("{}{FAST_SUFFIX}", row.model_id)),
            }
        })
        .collect()
}

/// The context window the *session's own* model reports, off the `models` block
/// `session/new` and `session/resume` both answer with.
///
/// Read from the session's own reply rather than from [`list`], because that is
/// the one statement of which model this session is actually on — and because
/// the ring needs a denominator at all: `_meta.totalTokens` on a prompt reply is
/// a count with nothing beside it. [`DEFAULT_CONTEXT_WINDOW`] stands in where
/// the shape cannot be read, since a ring divided by nothing draws nothing.
pub fn window_of(reply: &Value) -> u64 {
    let Some(state) = reply.get("models") else {
        return DEFAULT_CONTEXT_WINDOW;
    };
    let Ok(state) = serde_json::from_value::<ModelState>(state.clone()) else {
        return DEFAULT_CONTEXT_WINDOW;
    };

    state
        .available_models
        .iter()
        .find(|row| Some(&row.model_id) == state.current_model_id.as_ref())
        .or_else(|| state.available_models.first())
        .map(|row| row.meta.total_context_tokens)
        .filter(|window| *window > 0)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

/// The four models grok shipped when this was written, for a picker on a
/// machine where the probe cannot run.
///
/// Stale by construction, which is the point: it is a worse answer than the
/// wire's and a far better one than an empty menu. Ladders are the wire's own —
/// 4.5 stops at `high` where the other three reach `xhigh`.
pub fn fallback() -> Vec<Model> {
    use Effort::{High, Low, Medium, Xhigh};

    let row = |id: &str,
               label: &str,
               efforts: Vec<Effort>,
               secondary: bool,
               supports_fast: bool| Model {
        id: ModelId::new(id),
        label: label.to_string(),
        efforts,
        default_effort: Some(High),
        arg: id.to_string(),
        provider: String::new(),
        accepts_images: false,
        secondary,
        supports_fast,
    };

    vec![
        row(
            "grok-4.7",
            "Grok 4.7",
            vec![Low, Medium, High, Xhigh],
            false,
            true,
        ),
        // Kept in the table and out of the picker, the same bargain the live
        // list makes: a session already recorded on it still has to resolve.
        row(
            "grok-4.7-build-fast",
            "Grok 4.7 Fast",
            vec![Low, Medium, High, Xhigh],
            true,
            false,
        ),
        // Top level beside 4.7, because the twin above takes no slot: the
        // live fold counts position over the rows the picker *draws*, and a
        // table that folded 4.6 away would put the two lists in different
        // shapes depending only on whether the probe answered.
        row(
            "grok-4.6",
            "Grok 4.6",
            vec![Low, Medium, High, Xhigh],
            false,
            false,
        ),
        row("grok-4.5", "Grok 4.5", vec![Low, Medium, High], true, false),
    ]
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelState {
    #[serde(default)]
    current_model_id: Option<String>,
    #[serde(default)]
    available_models: Vec<Row>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    model_id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "_meta")]
    meta: RowMeta,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowMeta {
    #[serde(default)]
    total_context_tokens: u64,
    #[serde(default)]
    supports_reasoning_effort: bool,
    #[serde(default)]
    reasoning_efforts: Vec<Rung>,
}

#[derive(Debug, Deserialize)]
struct Rung {
    /// grok sends `id` and `value` carrying the same string. `value` is what
    /// `session/set_config_option` takes, so it is the one read.
    #[serde(default)]
    value: String,
    #[serde(default)]
    default: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HANDSHAKE: &str = include_str!("fixtures/handshake.json");

    /// The real handshake, read the way the picker reads it: four rows, newest
    /// first, with the ladder the wire gave each one.
    #[test]
    fn the_handshake_answers_the_whole_picker() {
        let reply: Value = serde_json::from_str(HANDSHAKE).unwrap();
        let models = read_models(&reply);

        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]
        );

        // Position is the ranking and it is counted over the rows the picker
        // *draws*: the fast twin is hidden, so the top level is the two newest
        // real models rather than one model and its own fast tier.
        let top: Vec<&str> = models
            .iter()
            .filter(|m| !m.secondary)
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(top, ["grok-4.7", "grok-4.6"]);

        // The twin is what gives 4.7 its switch, and the twin itself takes none
        // — it *is* the fast tier. 4.6 and 4.5 have no twin on this wire, so
        // they draw no switch at all rather than one that would do nothing.
        let fast: Vec<(&str, bool)> = models
            .iter()
            .map(|m| (m.id.as_str(), m.supports_fast))
            .collect();
        assert_eq!(
            fast,
            [
                ("grok-4.7", true),
                ("grok-4.7-build-fast", false),
                ("grok-4.6", false),
                ("grok-4.5", false),
            ]
        );

        // Quietest rung first, which is every other picker's order and the
        // reverse of grok's own.
        assert_eq!(
            models[0].efforts,
            [Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh]
        );
        assert_eq!(models[0].default_effort, Some(Effort::High));

        // 4.5 is the one that stops short, which is the whole reason the ladder
        // is read per model rather than written once per harness.
        let older = models.last().unwrap();
        assert_eq!(older.id.as_str(), "grok-4.5");
        assert_eq!(older.efforts, [Effort::Low, Effort::Medium, Effort::High]);

        // No image prompts on any grok model — `promptCapabilities.image` is
        // false on every handshake, so the tray must never offer one.
        assert!(models.iter().all(|m| !m.accepts_images));
    }

    /// The table stands in for the wire, so it has to *look* like the wire: a
    /// reader whose probe could not run should get the same menu, stale rather
    /// than differently shaped. The twin taking no top-level slot is the half
    /// that is easy to miss, since it is invisible in both.
    #[test]
    fn the_table_and_the_wire_agree_about_the_top_level() {
        let reply: Value = serde_json::from_str(HANDSHAKE).unwrap();

        let top = |models: &[Model]| -> Vec<String> {
            models
                .iter()
                .filter(|m| !m.secondary)
                .map(|m| m.id.to_string())
                .collect()
        };

        assert_eq!(top(&read_models(&reply)), top(&fallback()));
        assert_eq!(top(&fallback()), ["grok-4.7", "grok-4.6"]);
    }

    /// The twin is a **mode**, so it is hidden from the picker — and hiding is
    /// never unrunnable: `find` reads the unfiltered list, or a session already
    /// recorded on it would resolve to nothing, spawn with no `--model` at all
    /// and record its own model as unset.
    #[tokio::test]
    async fn the_fast_twin_is_hidden_and_still_runnable() {
        let table = fallback();
        let drawn: Vec<&str> = table
            .iter()
            .filter(|m| in_picker(m))
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(drawn, ["grok-4.7", "grok-4.6", "grok-4.5"]);

        assert!(find(&ModelId::new("grok-4.7-build-fast")).await.is_some());
    }

    /// The switch *is* the model id here, so this is grok's whole fast-mode
    /// mechanism — and the pairing has to hold in both directions, or the
    /// composer's switch would send a model nobody picked.
    #[tokio::test]
    async fn the_switch_resolves_to_the_twin_and_back() {
        assert_eq!(fast_arg("grok-4.7", true).await, "grok-4.7-build-fast");
        assert_eq!(fast_arg("grok-4.7", false).await, "grok-4.7");

        // Already the fast tier: asking again must not reach for a
        // `…-build-fast-build-fast` that does not exist.
        assert_eq!(
            fast_arg("grok-4.7-build-fast", true).await,
            "grok-4.7-build-fast"
        );

        // No twin on this wire, so the pick is sent exactly as it was made
        // rather than mangled into an id grok would refuse.
        assert_eq!(fast_arg("grok-4.6", true).await, "grok-4.6");
        assert_eq!(fast_arg("grok-9.9", true).await, "grok-9.9");
    }

    /// A shape this build cannot read costs the list, never the app — the
    /// caller falls back to the table, which is stale rather than empty.
    #[test]
    fn an_unreadable_handshake_answers_no_rows_rather_than_failing() {
        assert!(read_models(&json!({})).is_empty());
        assert!(read_models(&json!({"_meta": {"modelState": "surprise"}})).is_empty());
        assert!(read_models(&json!({"_meta": {"modelState": {"availableModels": []}}})).is_empty());
    }

    /// The fallback has to be runnable, not merely present: the picker draws it
    /// on a machine where the probe failed, and a row whose id grok refuses is
    /// a spawn that fails for a choice the reader could not have made
    /// differently.
    #[test]
    fn the_fallback_names_the_default_and_matches_the_wire() {
        let table = fallback();
        let wire = read_models(&serde_json::from_str(HANDSHAKE).unwrap());

        let table_ids: Vec<&str> = table.iter().map(|m| m.id.as_str()).collect();
        let wire_ids: Vec<&str> = wire.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(table_ids, wire_ids, "the table is the captured list");

        let default = default_model_for(Harness::Grok).unwrap();
        assert!(
            table.iter().any(|m| m.id == default),
            "the picker's fallback must hold the model a create defaults to"
        );
    }

    /// A model newer than this build is taken as written so a live session can
    /// still name what it is running — but another harness's alias must still
    /// come back `None`, or a session would spawn grok on `opus`.
    #[test]
    fn an_unknown_id_resolves_and_another_harness_s_does_not() {
        let known = fallback();

        let newer = resolve(&ModelId::new("grok-5"), &known).expect("taken as written");
        assert_eq!(newer.arg, "grok-5");
        assert!(newer.efforts.is_empty(), "no ladder guessed for it");

        assert!(resolve(&ModelId::new("opus"), &known).is_none());
        assert!(resolve(&ModelId::default(), &known).is_none());
    }
}
