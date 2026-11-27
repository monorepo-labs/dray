//! Which models OpenCode can run here, asked of OpenCode.
//!
//! Multi-provider, like pi: the list is whatever the reader's providers serve,
//! so it is asked rather than tabled. OpenCode 1 answers `opencode models
//! --verbose`: each model as its `provider/model` id on a line of its own
//! followed by a pretty-printed JSON object, which carries the name, the
//! context limit, whether it takes images, and its `variants` — OpenCode's
//! effort ladder. OpenCode 2 refuses `--verbose` (#1617) and answers the same
//! facts as JSON from its background server, `opencode api GET /api/model`.

use crate::harness::ProbeCache;
use crate::models::{Effort, Model, ModelId};
use anyhow::{Context, Result};
use serde_json::Value;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

/// Expiring for pi's reason: a provider connected while Dray is open is the
/// one the reader will try next.
const FRESH_FOR: Duration = Duration::from_secs(120);

/// The CLI reads a local cache and answers in under a second; this bounds a
/// hung one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

static CACHE: LazyLock<ProbeCache<Vec<Model>>> = LazyLock::new(|| ProbeCache::new(FRESH_FOR));

/// Every model OpenCode reports, or an empty list where it could not say —
/// the picker draws its own empty state.
pub async fn list() -> Vec<Model> {
    CACHE.get_or_probe("", probe).await.unwrap_or_else(|err| {
        eprintln!("[opencode models] {err:#}");
        Vec::new()
    })
}

/// The model with this id. An id the list does not hold is still handed to
/// OpenCode as written — the id *is* the argument — so its own "model not
/// found" names what was wrong rather than the session silently running its
/// default.
pub async fn find(id: &ModelId) -> Option<Model> {
    if id.is_unset() {
        return None;
    }
    let listed = list().await.into_iter().find(|m| &m.id == id);
    Some(listed.unwrap_or_else(|| unlisted(id)))
}

/// Drops the cached answer, so the next read asks again.
pub fn forget() {
    CACHE.forget();
}

async fn probe() -> Result<Vec<Model>> {
    if crate::binpath::opencode_v2().await {
        return probe_v2().await;
    }
    Ok(parse_verbose(&opencode(&["models", "--verbose"]).await?))
}

/// OpenCode 2's list. Its server loads a folder's models after answering that
/// folder's first ask, so an empty list is asked again for a few seconds
/// before plain `opencode models`, which waits for the load but carries ids
/// alone, stands in for it.
async fn probe_v2() -> Result<Vec<Model>> {
    for _ in 0..10 {
        let models = parse_api(&opencode(&["api", "GET", "/api/model"]).await?);
        if !models.is_empty() {
            return Ok(models);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let ids = opencode(&["models"]).await?;
    Ok(ids
        .lines()
        .map(str::trim)
        .filter(|line| line.contains('/'))
        .map(|id| unlisted(&ModelId::new(id)))
        .collect())
}

/// One `opencode` run's stdout, or why it failed.
async fn opencode(args: &[&str]) -> Result<String> {
    let bin = crate::binpath::opencode().await;
    let output = tokio::time::timeout(
        PROBE_TIMEOUT,
        crate::binpath::command(&bin)
            .args(args)
            .env("PATH", crate::harness::agent_path(&bin))
            // Null, never a pipe: an OpenCode command with an open stdin and
            // no TTY can wait on it for good.
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("opencode models timed out")?
    .context("couldn't run opencode models")?;

    anyhow::ensure!(
        output.status.success(),
        "opencode {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Reads `opencode api GET /api/model`: `{"data": [row, …]}`, each row naming
/// its `providerID` and `id`, `capabilities.input` as a list of kinds and
/// `variants` as a list of `{id}`.
fn parse_api(out: &str) -> Vec<Model> {
    let Ok(body) = serde_json::from_str::<Value>(out) else {
        return Vec::new();
    };
    let Some(rows) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter(|row| row.get("enabled").and_then(Value::as_bool) != Some(false))
        .filter_map(|row| {
            let provider = row.get("providerID").and_then(Value::as_str)?;
            let model = row.get("id").and_then(Value::as_str)?;
            let id = format!("{provider}/{model}");
            let variants: Vec<&str> = row
                .get("variants")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("id").and_then(Value::as_str))
                .collect();
            Some(Model {
                id: ModelId::new(id.clone()),
                label: row.get("name").and_then(Value::as_str).unwrap_or(model).to_string(),
                efforts: ladder(|level| variants.contains(&level)),
                default_effort: None,
                arg: id,
                provider: provider.to_string(),
                accepts_images: row
                    .pointer("/capabilities/input")
                    .and_then(Value::as_array)
                    .is_none_or(|kinds| kinds.iter().any(|k| k == "image")),
                secondary: false,
                supports_fast: false,
            })
        })
        .collect()
}

/// Reads `opencode models --verbose`: an id line, then one JSON object, over
/// and over. Read with a streaming deserializer rather than by line, so the
/// object's own layout is OpenCode's business.
fn parse_verbose(out: &str) -> Vec<Model> {
    let mut models = Vec::new();
    let mut rest = out;

    while let Some(brace) = rest.find('{') {
        let header = rest[..brace].trim().lines().last().unwrap_or_default().trim().to_string();
        let mut stream = serde_json::Deserializer::from_str(&rest[brace..]).into_iter::<Value>();
        let Some(Ok(row)) = stream.next() else {
            break;
        };
        rest = &rest[brace + stream.byte_offset()..];
        if let Some(model) = row_to_model(&header, &row) {
            models.push(model);
        }
    }
    models
}

/// One row. The id is `provider/model`, which is also what
/// `session/set_config_option` takes, so `arg` is the same string.
fn row_to_model(header: &str, row: &Value) -> Option<Model> {
    let provider = row.get("providerID").and_then(Value::as_str)?;
    let model = row.get("id").and_then(Value::as_str)?;
    let id = if header.contains('/') {
        header.to_string()
    } else {
        format!("{provider}/{model}")
    };

    Some(Model {
        id: ModelId::new(id.clone()),
        label: row.get("name").and_then(Value::as_str).unwrap_or(model).to_string(),
        efforts: efforts(row.get("variants")),
        // OpenCode's own, set by whoever configured the provider.
        default_effort: None,
        arg: id,
        provider: provider.to_string(),
        accepts_images: row
            .pointer("/capabilities/input/image")
            .and_then(Value::as_bool)
            // Absent means OpenCode did not say; pi's reading of the same gap.
            .unwrap_or(true),
        // The reader stars their own shortlist, as on pi.
        secondary: false,
        supports_fast: false,
    })
}

/// The ladder out of `variants`, in Dray's order. OpenCode names levels it
/// alone has (`none`, `minimal`); those are dropped rather than added to
/// [`Effort`], which an older build must still be able to read.
fn efforts(variants: Option<&Value>) -> Vec<Effort> {
    let Some(variants) = variants.and_then(Value::as_object) else {
        return Vec::new();
    };
    ladder(|level| variants.contains_key(level))
}

/// Dray's levels that `has` names, in Dray's order.
fn ladder(has: impl Fn(&str) -> bool) -> Vec<Effort> {
    const LADDER: [Effort; 6] = [Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max, Effort::Ultra];
    LADDER.into_iter().filter(|level| has(level.as_arg())).collect()
}

/// A model nothing listed, carried as its own argument.
fn unlisted(id: &ModelId) -> Model {
    let (provider, label) = id.as_str().split_once('/').unwrap_or(("", id.as_str()));
    Model {
        id: id.clone(),
        label: label.to_string(),
        efforts: Vec::new(),
        default_effort: None,
        arg: id.as_str().to_string(),
        provider: provider.to_string(),
        accepts_images: true,
        secondary: false,
        supports_fast: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERBOSE: &str = include_str!("fixtures/models_verbose.txt");

    #[test]
    fn the_verbose_listing_reads_into_rows() {
        let models = parse_verbose(VERBOSE);
        assert_eq!(models.len(), 3);

        let beam = &models[0];
        assert_eq!(beam.id.as_str(), "opencode-go/beam-free");
        assert_eq!(beam.arg, "opencode-go/beam-free");
        assert_eq!(beam.label, "Beam Free");
        assert_eq!(beam.provider, "opencode-go");
        assert!(!beam.accepts_images);
        assert_eq!(
            beam.efforts,
            [Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max]
        );

        // `none` is OpenCode's alone and is dropped, never added to the ladder.
        let luna = &models[1];
        assert!(luna.accepts_images);
        assert_eq!(luna.efforts.first(), Some(&Effort::Low));

        // A model id may hold a slash of its own; the header line is kept whole.
        assert_eq!(models[2].id.as_str(), "orcarouter/obsidian/Qwen3.8-27B");
        assert_eq!(models[2].provider, "orcarouter");
        assert!(models[2].efforts.is_empty());
    }

    #[test]
    fn opencode_2s_listing_reads_into_rows() {
        let models = parse_api(include_str!("fixtures/models_api.json"));
        assert_eq!(models.len(), 3);

        let sonnet = &models[0];
        assert_eq!(sonnet.id.as_str(), "anthropic/claude-sonnet-5-5");
        assert_eq!(sonnet.arg, "anthropic/claude-sonnet-5-5");
        assert_eq!(sonnet.label, "Claude Sonnet 5.5");
        assert_eq!(sonnet.provider, "anthropic");
        assert!(sonnet.accepts_images);
        assert_eq!(
            sonnet.efforts,
            [Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max]
        );

        // `minimal` and `none` are OpenCode's alone.
        assert!(!models[1].accepts_images);
        assert_eq!(models[1].efforts.first(), Some(&Effort::Low));

        // A model id holding a slash of its own stays whole after the provider.
        assert_eq!(models[2].id.as_str(), "openrouter/upstage/solar-mini-4-5");
        assert_eq!(models[2].provider, "openrouter");
    }

    #[test]
    fn a_server_still_loading_answers_no_rows() {
        assert!(parse_api(r#"{"location":{"directory":"/tmp"},"data":[]}"#).is_empty());
        assert!(parse_api("HTTP 503").is_empty());
    }

    #[test]
    fn an_unlisted_id_is_carried_as_written() {
        let model = unlisted(&ModelId::new("acme/new-model"));
        assert_eq!(model.arg, "acme/new-model");
        assert_eq!(model.provider, "acme");
    }
}
