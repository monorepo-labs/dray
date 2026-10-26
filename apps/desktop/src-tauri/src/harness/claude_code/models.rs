//! Which models Claude Code can run here, asked of Claude Code.
//!
//! The `initialize` reply carries `models` (v2.1.310): the bare aliases plus
//! every pinned generation the CLI still serves, each with its own effort
//! ladder and fast-mode flag. Read the way Codex's `model/list` is, with
//! [`claude_models`] as the fallback — what the picker draws until the probe
//! lands and wherever it cannot run.
//!
//! **The picker never waits on it.** Claude Code is the default harness, so
//! [`list`] answers the table at once and probes in the background, and
//! `models_changed` makes the picker read again once the CLI's answer is in —
//! fx's bargain for fx's reason.

use super::commands::initialize;
use crate::models::{claude_models, Effort, Model, ModelId};
use crate::sink::Sink;
use serde::Deserialize;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

/// What the CLI last listed. Kept across a [`forget`], so a refresh serves the
/// old answer while the new one is read rather than flashing the table.
static LISTED: Mutex<Option<Vec<Model>>> = Mutex::new(None);

/// Whether a probe has been started since the last [`forget`]. A failed one is
/// not retried until then: the CLI does not grow a model list by being asked
/// again, and a probe is a child.
static PROBED: AtomicBool = AtomicBool::new(false);

/// What the picker draws: the CLI's own list once read, the table until then.
pub fn list(sink: &Sink) -> Vec<Model> {
    if !PROBED.swap(true, Ordering::SeqCst) {
        let sink = sink.clone();
        tokio::spawn(async move {
            match probe().await {
                Ok(models) => {
                    *LISTED.lock().unwrap() = Some(models);
                    if let Err(err) = sink.emit("models_changed", ()) {
                        eprintln!("[claude models_changed emit err] {err}");
                    }
                }
                Err(err) => eprintln!("[claude models] {err:#}"),
            }
        });
    }

    LISTED.lock().unwrap().clone().unwrap_or_else(claude_models)
}

/// Every model this build can name for Claude Code: what the CLI listed, then
/// any table row it did not, so a session on a model the CLI has since dropped
/// still resumes and fails in the CLI's own words.
pub fn known() -> Vec<Model> {
    let mut models = LISTED.lock().unwrap().clone().unwrap_or_default();
    for row in claude_models() {
        if !models.iter().any(|m| m.id == row.id) {
            models.push(row);
        }
    }
    models
}

/// Makes the next [`list`] ask the CLI again.
pub fn forget() {
    PROBED.store(false, Ordering::SeqCst);
}

async fn probe() -> anyhow::Result<Vec<Model>> {
    // The list is the account's, not the project's, so any directory answers.
    let home = std::env::home_dir().unwrap_or_else(|| "/".into());
    let reply = initialize(&home.to_string_lossy()).await?;
    let models = read(&reply);
    anyhow::ensure!(!models.is_empty(), "the CLI listed no models this build could read");
    Ok(models)
}

/// One `models` row. Read row by row, so a shape the CLI changes costs that row
/// and not the list.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    value: String,
    display_name: String,
    #[serde(default)]
    supports_effort: bool,
    #[serde(default)]
    supported_effort_levels: Vec<String>,
    #[serde(default)]
    supports_fast_mode: bool,
    /// A model the CLI names but will not run here — "update Claude Code to use
    /// it". Untyped since none has been captured; anything but absent, null or
    /// `false` reads as disabled.
    #[serde(default)]
    disabled: Value,
}

/// The reply's `models` folded into the picker's list.
///
/// `default` is left out: it is the CLI's name for its own pick, which Dray
/// makes itself. A row the table names keeps the table's place and shortlist
/// tier, so a fresh install still seeds Fable and Opus. One it has never heard
/// of leads if it is a bare alias — a new family — and sits under "Shortlist
/// models" if it is a pinned id, the shape every previous generation takes.
fn read(reply: &Value) -> Vec<Model> {
    let table = claude_models();
    let rows = reply.get("models").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut models: Vec<Model> = rows
        .into_iter()
        .filter_map(|row| serde_json::from_value::<Row>(row).ok())
        .filter(|row| row.value != "default" && matches!(row.disabled, Value::Null | Value::Bool(false)))
        .map(|row| {
            let known = table.iter().find(|m| m.id.as_str() == row.value);
            let efforts: Vec<Effort> = if row.supports_effort {
                row.supported_effort_levels.iter().filter_map(|e| Effort::from_arg(e)).collect()
            } else {
                Vec::new()
            };
            Model {
                id: ModelId::new(&row.value),
                label: row.display_name,
                default_effort: efforts
                    .contains(&Effort::High)
                    .then_some(Effort::High)
                    .or(efforts.last().copied()),
                efforts,
                arg: row.value.clone(),
                provider: String::new(),
                accepts_images: true,
                secondary: known.map_or(row.value.contains('-'), |m| m.secondary),
                supports_fast: row.supports_fast_mode,
            }
        })
        .collect();

    models.sort_by_key(|model| match table.iter().position(|m| m.id == model.id) {
        Some(at) => at as i64,
        None if model.secondary => i64::MAX,
        None => -1,
    });
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Vec<Model> {
        let reply: Value =
            serde_json::from_str(include_str!("fixtures/initialize_models.json")).unwrap();
        read(&reply)
    }

    /// v2.1.310 lists 13 rows; `default` is the CLI's own pick and dropped.
    /// The table's rows keep its order and tier, so the shortlist a fresh
    /// install seeds is still Fable and Opus.
    #[test]
    fn reads_the_captured_list_in_the_tables_order() {
        let models = captured();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();

        assert_eq!(models.len(), 12);
        assert!(!ids.contains(&"default"));
        assert_eq!(&ids[..2], ["fable", "opus"]);
        let top: Vec<&str> = models.iter().filter(|m| !m.secondary).map(|m| m.id.as_str()).collect();
        assert_eq!(top, ["fable", "opus"]);
        assert!(models.iter().all(|m| m.arg == m.id.as_str()));
    }

    /// The ladders and fast mode are per model, which is what the table could
    /// not say: Opus 4.6 has no xhigh, Haiku 4.5 has no ladder at all, and
    /// fast mode is Opus 5.5, Opus 5 and Opus 4.8 alone.
    #[test]
    fn ladders_and_fast_mode_follow_each_row() {
        let models = captured();
        let row = |id: &str| models.iter().find(|m| m.id.as_str() == id).unwrap();

        assert_eq!(row("claude-opus-4-6").efforts, vec![Effort::Low, Effort::Medium, Effort::High, Effort::Max]);
        assert!(row("claude-haiku-4-5-20251001").efforts.is_empty());
        assert_eq!(row("claude-haiku-4-5-20251001").default_effort, None);
        assert_eq!(row("opus").default_effort, Some(Effort::High));

        let fast: Vec<&str> = models.iter().filter(|m| m.supports_fast).map(|m| m.id.as_str()).collect();
        assert_eq!(fast, ["opus", "claude-opus-5", "claude-opus-4-8"]);
        assert_eq!(row("opus").label, "Opus 5.5");
    }

    /// A new bare alias is a new family and leads; a disabled row is dropped;
    /// a row whose shape moved costs that row alone.
    #[test]
    fn unknown_rows_lead_or_sink_and_bad_rows_cost_themselves() {
        let reply = serde_json::json!({"models": [
            {"value": "opus", "displayName": "Opus 5.5", "supportsEffort": true, "supportedEffortLevels": ["high"]},
            {"value": "claude-opus-4-1", "displayName": "Opus 4.1"},
            {"value": "mythos", "displayName": "Mythos 1"},
            {"value": "claude-next", "displayName": "Next", "disabled": true},
            {"value": 7},
        ]});
        let ids: Vec<String> = read(&reply).into_iter().map(|m| m.id.to_string()).collect();

        assert_eq!(ids, ["mythos", "opus", "claude-opus-4-1"]);
    }

    /// Hits the real CLI: `cargo test -- --ignored asks_the_real_cli_for_its_models`.
    #[tokio::test]
    #[ignore]
    async fn asks_the_real_cli_for_its_models() {
        let models = probe().await.unwrap();

        assert!(models.iter().any(|m| m.id.as_str() == "opus" && !m.secondary));
        assert!(models.iter().any(|m| m.id.as_str().starts_with("claude-") && m.secondary));
    }
}
