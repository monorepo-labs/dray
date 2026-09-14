//! Which models fx can run here, asked of fx.
//!
//! fx is multi-provider — Codex subscription, Vercel AI Gateway (247 models on
//! the probe box), Grok — and the list is *the active provider's*, chosen by
//! `fx provider` and held in `~/.fx/settings.json`. No table written here could
//! name it, so this asks `fx models --json`: one spawn, no model call, and
//! **no session**. The other route, `fx acp` + `session/new`, answers the
//! effort ladder too — and writes an empty session into `~/.fx/sessions` every
//! time, which `fx sessions` then lists. Nine of those from one afternoon of
//! probing settled it.
//!
//! The ladder is therefore a table by provider, read off `session/new`'s
//! `configOptions` on capture: codex offers `auto low medium high xhigh max
//! ultra`, gateway stops at `xhigh`. `auto` is fx's own default and is what an
//! unset effort leaves it on.

use crate::harness::ProbeCache;
use crate::models::{Effort, Model, ModelId};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::process::Command;

/// How long a cached answer stands. Expires, because `fx provider` and
/// `fx login` are things a reader does while Dray is open, and "restart the
/// app" is a poor answer to a list that is supposed to follow them.
const FRESH_FOR: Duration = Duration::from_secs(120);

static CACHE: LazyLock<ProbeCache<Vec<Model>>> = LazyLock::new(|| ProbeCache::new(FRESH_FOR));

/// Every model fx reports for its active provider, newest answer or cached.
///
/// Failure answers an empty list rather than an error: the picker draws its
/// own empty state, and a reader with no provider logged in is in an ordinary
/// state rather than a broken one.
pub async fn list() -> Vec<Model> {
    CACHE.get_or_probe("", probe).await.unwrap_or_else(|err| {
        eprintln!("[fx models] {err:#}");
        Vec::new()
    })
}

/// The model with this id, from whatever fx last reported. `None` for the
/// unset sentinel — fx picking for itself — and for an id the active provider
/// does not serve. The second is not refused here: fx's own sentence on the
/// first prompt names exactly what was wrong.
pub async fn find(id: &ModelId) -> Option<Model> {
    if id.is_unset() {
        return None;
    }
    list().await.into_iter().find(|m| &m.id == id)
}

/// Drops the cached answer, so the next read asks fx again.
pub fn forget() {
    CACHE.forget();
}

/// Moves fx onto another provider — `fx provider <name>`, which is fx's global
/// setting and writes `~/.fx/settings.json`. The composer says so out loud.
///
/// Refused where fx would refuse it, with fx's own sentence: a provider with no
/// login answers `Run fx login grok.`
pub async fn set_provider(provider: &str) -> Result<()> {
    if !["gateway", "codex", "grok"].contains(&provider) {
        anyhow::bail!("fx has no provider named {provider:?}");
    }

    let bin = crate::binpath::fx().await;
    let output = Command::new(&bin)
        .args(["provider", provider])
        .env("PATH", crate::harness::agent_path(&bin))
        .output()
        .await
        .context("couldn't run fx to switch its provider")?;

    if !output.status.success() {
        anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }

    forget();
    Ok(())
}

#[derive(Deserialize)]
struct Listing {
    #[serde(default)]
    models: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    id: String,
    /// Prose — "Codex subscription", "Vercel AI Gateway" — not the key
    /// `fx provider` takes. [`provider_key`] maps it.
    #[serde(default)]
    source: String,
}

async fn probe() -> Result<Vec<Model>> {
    let bin = crate::binpath::fx().await;
    let output = Command::new(&bin)
        .args(["models", "--json"])
        .env("PATH", crate::harness::agent_path(&bin))
        .output()
        .await
        .context("couldn't run fx to ask for its models")?;

    if !output.status.success() {
        anyhow::bail!(
            "fx models failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let listing: Listing =
        serde_json::from_slice(&output.stdout).context("fx models answered something else")?;

    Ok(listing.models.into_iter().map(row_to_model).collect())
}

fn row_to_model(row: Row) -> Model {
    let provider = provider_key(&row.source);
    Model {
        id: ModelId::new(&row.id),
        label: row.id.clone(),
        efforts: ladder_for(&provider),
        // fx has its own, in its settings. Naming one here would override a
        // choice this app never made.
        default_effort: None,
        arg: row.id,
        provider,
        // A gateway model may well take one; the Codex provider answered
        // `refused` to a 1×1 PNG on capture. Off until a model says otherwise.
        accepts_images: false,
        secondary: false,
    }
}

/// The key `fx provider` takes, off the prose `fx models` prints.
fn provider_key(source: &str) -> String {
    match source {
        "Codex subscription" => "codex".to_string(),
        "Vercel AI Gateway" => "gateway".to_string(),
        "Grok subscription" => "grok".to_string(),
        other => other.to_lowercase(),
    }
}

// ponytail: per-provider ladder, read off two captures. Per-model would need
// the ACP probe this module refuses to run; a level fx declines fails the
// first prompt with fx's own sentence.
fn ladder_for(provider: &str) -> Vec<Effort> {
    use Effort::*;
    match provider {
        "codex" => vec![Low, Medium, High, Xhigh, Max, Ultra],
        _ => vec![Low, Medium, High, Xhigh],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real `fx models --json` answer, verbatim.
    const LISTING: &str = r#"{"kind":"models","count":5,"shown_count":5,"more_count":0,"private_models_hidden":false,"ids":["gpt-6-astra","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5"],"models":[{"id":"gpt-6-astra","source":"Codex subscription"},{"id":"gpt-5.6-sol","source":"Codex subscription"},{"id":"gpt-5.6-terra","source":"Codex subscription"},{"id":"gpt-5.6-luna","source":"Codex subscription"},{"id":"gpt-5.5","source":"Codex subscription"}]}"#;

    #[test]
    fn the_listing_becomes_rows_under_their_provider() {
        let listing: Listing = serde_json::from_str(LISTING).unwrap();
        let models: Vec<Model> = listing.models.into_iter().map(row_to_model).collect();

        assert_eq!(models.len(), 5);
        assert!(models.iter().all(|m| m.provider == "codex"));
        assert_eq!(models[1].arg, "gpt-5.6-sol");
        assert!(models[1].efforts.contains(&Effort::Ultra));
        assert!(!ladder_for("gateway").contains(&Effort::Ultra));
    }

    #[test]
    fn provider_prose_maps_to_the_key_fx_provider_takes() {
        assert_eq!(provider_key("Vercel AI Gateway"), "gateway");
        assert_eq!(provider_key("Grok subscription"), "grok");
        assert_eq!(provider_key("Something New"), "something new");
    }
}
