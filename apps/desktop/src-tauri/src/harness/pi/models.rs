//! Which models pi can actually run here, asked of pi.
//!
//! The other two harnesses list their models in `models.rs` because each has
//! one vendor and a handful of names. pi is multi-provider: the list depends on
//! which providers the reader has logged into, and it changed the moment a
//! second one was added on the probe machine. No table written here could name
//! them.
//!
//! So this spawns a throwaway `pi --mode rpc`, asks, and kills it. There is
//! precedent: `claude_code::commands` does exactly this for the slash-command
//! picker, and for the same reason — the picker has to exist before a session
//! does, so there is no child to ask until one is made.

use crate::models::{Effort, Model, ModelId};
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::rpc::{Incoming, PiClient, HANDSHAKE_TIMEOUT};

/// How long a cached answer stands.
///
/// Unlike the slash-command cache next door, this one expires. A provider
/// logged into while Dray is open is exactly the case a reader would then try
/// to use, and "restart the app" is a poor answer to a list that is *supposed*
/// to follow their logins.
const FRESH_FOR: Duration = Duration::from_secs(120);

static CACHE: Mutex<Option<(Instant, Arc<Vec<Model>>)>> = Mutex::const_new(None);

/// Every model pi reports, newest answer or a cached one.
///
/// Failure answers an empty list rather than an error: the picker draws its own
/// empty state, and a reader with no provider configured is in an ordinary
/// state rather than a broken one.
pub async fn list() -> Vec<Model> {
    if let Some((at, cached)) = CACHE.lock().await.as_ref() {
        if at.elapsed() < FRESH_FOR {
            return cached.as_ref().clone();
        }
    }

    let models = match probe().await {
        Ok(models) => models,
        Err(err) => {
            eprintln!("[pi models] {err:#}");
            return Vec::new();
        }
    };

    *CACHE.lock().await = Some((Instant::now(), Arc::new(models.clone())));
    models
}

/// The model with this id, from whatever pi last reported.
///
/// `None` for the unset sentinel — pi picking for itself — and for an id no
/// provider on this machine serves. The second is not refused here: pi's own
/// `Model not found: nope/nope` names exactly what was wrong on the spawn, and
/// a guess made here could not.
pub async fn find(id: &ModelId) -> Option<Model> {
    if id.is_unset() {
        return None;
    }

    list().await.into_iter().find(|m| &m.id == id)
}

/// Drops the cached answer, so the next read asks pi again.
///
/// For the refresh a reader asks for by hand — they have just logged a provider
/// in, and waiting out the window would read as the list being wrong.
pub async fn forget() {
    *CACHE.lock().await = None;
}

/// Spawns a throwaway pi, asks it, kills it.
async fn probe() -> Result<Vec<Model>> {
    let mut child = Command::new(crate::binpath::pi().await)
        .args([
            "--mode",
            "rpc",
            // Mandatory, not tidiness: without it every probe writes a session
            // file into the reader's own `~/.pi/agent/sessions/`, and their
            // session list fills with empty runs Dray started.
            "--no-session",
        ])
        .env("PATH", crate::harness::agent_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("couldn't start pi to ask for its models")?;

    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let client = PiClient::new(stdin);

    tokio::spawn({
        let client = client.clone();
        async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // Only answers matter here. The probe sends no prompt, so
                // anything else pi says is not about us.
                if let Incoming::Malformed = client.accept(&line).await {
                    continue;
                }
            }
        }
    });

    let listed = client
        .request_within("get_available_models", Value::Null, HANDSHAKE_TIMEOUT)
        .await;

    let models = match listed {
        Ok(data) => read_rows(&client, &data).await,
        Err(err) => {
            super::shutdown(&mut child, &client).await;
            return Err(err);
        }
    };

    // Ended by EOF rather than killed, and that is the difference between a
    // working picker and a broken one. A killed pi leaves its auth lock behind
    // and the *next* pi waits ~30s on it — so a probe that killed its child
    // made the session spawned right after it look hung. See
    // [`PiClient::close`]. Dropped is not an option either: a `Child` is not
    // reaped on drop, so a probe per picker-open would leak one pi each time.
    super::shutdown(&mut child, &client).await;

    Ok(models)
}

/// Reads the `get_available_models` payload, asking each row for its own ladder.
///
/// The second half is two round trips per model on the child already running,
/// with no model call in either — `get_available_thinking_levels` answers for
/// the **current** model, so one reading applied to every row would give them
/// all the *default* model's ladder, and be wrong precisely for the model a
/// reader switched to because it was different. Pinned by
/// `models_and_steering.jsonl`, where the same connection answered five levels
/// and then `["off"]` after one `set_model`.
///
/// A model whose query fails keeps its row with no levels rather than being
/// dropped: it can still be run, and an effort picker is not what a reader
/// opened the list for.
async fn read_rows(client: &PiClient, data: &Value) -> Vec<Model> {
    let rows = data
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut models = Vec::with_capacity(rows.len());

    for row in &rows {
        let efforts = match ask_levels(client, row).await {
            Ok(efforts) => efforts,
            Err(err) => {
                eprintln!("[pi models] no thinking levels for a row: {err:#}");
                Vec::new()
            }
        };

        if let Some(model) = row_to_model(row, efforts) {
            models.push(model);
        }
    }

    models
}

async fn ask_levels(client: &PiClient, row: &Value) -> Result<Vec<Effort>> {
    let id = row.get("id").and_then(Value::as_str).context("row has no id")?;
    let provider = row
        .get("provider")
        .and_then(Value::as_str)
        .context("row has no provider")?;

    // The ordinary bound, not the handshake's: the first command absorbed
    // whatever the startup cost, and everything after it is a live child
    // answering from memory.
    client
        .request(
            "set_model",
            serde_json::json!({"provider": provider, "modelId": id}),
        )
        .await?;

    let levels = client
        .request("get_available_thinking_levels", Value::Null)
        .await?;

    Ok(efforts_from_levels(&levels))
}

/// Reads one row, with the effort ladder that row's own query answered.
///
/// A pi model is named by **two** fields, not one: `set_model` takes `provider`
/// and `modelId` separately, and so does the spawn. So the persisted id joins
/// them and `arg` keeps the bare half, which is what the flag receives. Joining
/// is not cosmetic — two providers can serve the same model name, and an id
/// that dropped the provider would record a pick that resolves to whichever row
/// came back first.
fn row_to_model(row: &Value, efforts: Vec<Effort>) -> Option<Model> {
    let id = row.get("id").and_then(Value::as_str)?;
    let provider = row.get("provider").and_then(Value::as_str)?;

    Some(Model {
        id: ModelId::new(format!("{provider}/{id}")),
        // pi's own display name, and the row is already under its provider's
        // heading, so the provider is not repeated in it.
        label: row
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string(),
        efforts,
        // pi has its own, configured by whoever set the provider up. Naming one
        // here would override a choice this app never made.
        default_effort: None,
        arg: id.to_string(),
        provider: provider.to_string(),
        // A real model that takes no images: `gpt-5.3-codex-spark` reports
        // `input: ["text"]`, and the composer's tray has to know before it
        // offers to send one.
        accepts_images: accepts_images(row),
        // pi's picker draws the reader's shortlist rather than the whole list,
        // so it already has its own answer to "which few of these do I want in
        // front of me" and a second tier here would be a second one.
        secondary: false,
    })
}

/// Dray's own ladder, out of the levels pi answered for one model.
///
/// `off` and `minimal` are dropped rather than added to [`Effort`]: `off` is
/// what an empty list already means here, and pi folds `minimal` onto `low`
/// through `thinkingLevelMap` on the models that carry it. So `["off"]` alone —
/// what a non-reasoning model answers — reaches the picker as no levels at all,
/// which is the existing convention for a model with none.
fn efforts_from_levels(levels: &Value) -> Vec<Effort> {
    let names = match levels.get("levels").and_then(Value::as_array) {
        Some(names) => names,
        None => return Vec::new(),
    };

    names
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|name| match name {
            "low" => Some(Effort::Low),
            "medium" => Some(Effort::Medium),
            "high" => Some(Effort::High),
            "xhigh" => Some(Effort::Xhigh),
            "max" => Some(Effort::Max),
            "ultra" => Some(Effort::Ultra),
            _ => None,
        })
        .collect()
}

fn accepts_images(row: &Value) -> bool {
    match row.get("input").and_then(Value::as_array) {
        Some(kinds) => kinds.iter().any(|k| k.as_str() == Some("image")),
        // Absent means pi did not say. Assumed yes, because the cost of being
        // wrong is one refused attachment with pi's own sentence on it, where
        // the other way round silently hides a working feature.
        None => true,
    }
}

/// The models grouped by provider, in the order pi listed them.
///
/// Grouping is the frontend's job for the other two harnesses' pickers, but the
/// *split* is pi's own id format, so it is stated once here.
pub fn by_provider(models: &[Model]) -> Vec<(String, Vec<Model>)> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, Vec<Model>> = HashMap::new();

    for model in models {
        let key = model.provider.clone();
        if !grouped.contains_key(&key) {
            order.push(key.clone());
        }
        grouped.entry(key).or_default().push(model.clone());
    }

    order
        .into_iter()
        .filter_map(|k| grouped.remove(&k).map(|v| (k, v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Record {
        dir: String,
        line: String,
    }

    /// The real `get_available_models` answer from a machine with two providers
    /// logged in.
    fn captured() -> Value {
        let fixture = include_str!("fixtures/live_models.jsonl");

        for line in fixture.lines().filter(|l| !l.trim().is_empty()) {
            let record: Record = serde_json::from_str(line).expect("fixture record");
            if record.dir != "out" {
                continue;
            }
            let value: Value = serde_json::from_str(&record.line).expect("json");
            if value.get("command").and_then(Value::as_str) == Some("get_available_models") {
                return value.get("data").cloned().unwrap_or(Value::Null);
            }
        }

        panic!("the capture has no get_available_models answer in it");
    }

    /// The rows as the picker would build them, with the per-model query left
    /// out — that half needs a live child, and the two are independent.
    fn rows() -> Vec<Model> {
        captured()
            .get("models")
            .and_then(Value::as_array)
            .expect("the capture has rows")
            .iter()
            .filter_map(|row| row_to_model(row, Vec::new()))
            .collect()
    }

    /// The whole argument for discovering the list: eleven models across two
    /// providers, on an ordinary machine, and none of them nameable by a table
    /// written in this repo.
    #[test]
    fn the_captured_list_is_read_whole() {
        let models = rows();

        assert_eq!(models.len(), 11);
        assert!(models.iter().all(|m| !m.id.as_str().is_empty()));
        assert!(models.iter().all(|m| !m.arg.is_empty()));
    }

    /// `set_model` names a model with two fields, so the persisted id joins
    /// them and the flag keeps the bare half. An id that dropped the provider
    /// would record a pick that resolves to whichever row came back first.
    #[test]
    fn the_id_carries_the_provider_and_the_arg_does_not() {
        for model in rows() {
            assert_eq!(model.id.as_str(), format!("{}/{}", model.provider, model.arg));
            assert!(!model.arg.contains('/'), "{} is not bare", model.arg);
        }
    }

    /// Two providers on one machine, and every id distinct across them — which
    /// is the property the joined id exists to keep.
    #[test]
    fn a_row_names_its_model_and_its_group_names_the_provider() {
        let models = rows();
        let groups = by_provider(&models);

        assert!(groups.len() >= 2, "the capture has two providers logged in");

        let ids: std::collections::HashSet<_> = models.iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids.len(), models.len(), "two rows share one id");

        for (provider, rows) in &groups {
            assert!(!provider.is_empty());
            for row in rows {
                assert_eq!(row.provider, *provider);
            }
        }
    }

    /// A real model that takes no images. The composer's tray has to know
    /// before it offers to send one.
    #[test]
    fn a_text_only_model_says_so() {
        let models = rows();

        let spark = models
            .iter()
            .find(|m| m.arg == "gpt-5.3-codex-spark")
            .expect("the capture has the text-only model in it");

        assert!(!spark.accepts_images);
        assert!(
            models.iter().any(|m| m.accepts_images),
            "every model read as text-only, so the flag says nothing"
        );
    }

    /// A row missing either half of its name is dropped, and the rest of the
    /// list survives — an empty picker names no reason.
    #[test]
    fn a_row_missing_half_its_name_costs_one_row() {
        let rows = serde_json::json!([
            {"id": "grok-4.6", "provider": "xai"},
            {"id": "no-provider"},
            {"provider": "xai"},
        ]);

        let models: Vec<_> = rows
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row_to_model(row, Vec::new()))
            .collect();

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id.as_str(), "xai/grok-4.6");
    }

    /// `["off"]` is what a non-reasoning model answers, and it reaches the
    /// picker as no levels — which is already what an empty list means here.
    /// `minimal` folds onto `low` inside pi, so carrying it would be a rung
    /// Dray cannot send.
    #[test]
    fn the_ladder_keeps_drays_own_and_nothing_else() {
        let none = serde_json::json!({"levels": ["off"]});
        assert!(efforts_from_levels(&none).is_empty());

        let full = serde_json::json!({
            "levels": ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        });
        assert_eq!(
            efforts_from_levels(&full),
            vec![
                Effort::Low,
                Effort::Medium,
                Effort::High,
                Effort::Xhigh,
                Effort::Max,
                Effort::Ultra
            ]
        );

        // The shape `models_and_steering.jsonl` captured, which stops short of
        // Dray's top two.
        let captured = serde_json::json!({
            "levels": ["off", "minimal", "low", "medium", "high"]
        });
        assert_eq!(
            efforts_from_levels(&captured),
            vec![Effort::Low, Effort::Medium, Effort::High]
        );
    }

    /// An answer shaped differently reads as no levels rather than failing the
    /// row: the model can still be run.
    #[test]
    fn an_unreadable_ladder_reads_as_none() {
        assert!(efforts_from_levels(&Value::Null).is_empty());
        assert!(efforts_from_levels(&serde_json::json!({})).is_empty());
    }

    /// The probe against the pi on this machine, printed rather than asserted.
    ///
    /// Everything above reads a capture, so it proves the parse and nothing
    /// about whether the *commands* still answer — which is the half a new pi
    /// release can break, and the half `binpath` deliberately does not guard
    /// with a version number. Ignored by default: the answer is a property of
    /// whoever is running it, and it spawns a child.
    #[tokio::test]
    #[ignore]
    async fn what_the_installed_pi_answers() {
        let models = probe().await.expect("pi answered the probe");

        for (provider, rows) in by_provider(&models) {
            println!("{provider}");
            for row in rows {
                let efforts: Vec<_> = row.efforts.iter().map(|e| e.as_arg()).collect();
                println!("  {:<28} {}", row.arg, efforts.join(" "));
            }
        }

        assert!(!models.is_empty(), "pi reported no models at all");
    }
}
