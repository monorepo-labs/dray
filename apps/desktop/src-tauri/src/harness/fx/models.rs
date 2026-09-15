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
    let key = active_provider().await.unwrap_or_default();

    // A real probe already cached for this provider wins over the static table
    // below — that is how [`refresh`] lets a changed subscription catalog reach
    // the picker despite the tables. Fresh only; a stale entry falls through.
    if let Some(fresh) = CACHE.peek(&key) {
        return fresh;
    }

    // The subscription providers serve a handful of models each, fixed and
    // known, so the first read answers from a table with no probe — `fx models`
    // costs ~2s of fx startup whatever it returns. gateway's list is discovered
    // (247 and unbounded), so it alone is probed. The manual Refresh calls
    // [`refresh`], which probes fx even for a table-backed provider and caches
    // the answer above.
    if let Some(models) = known_models(&key) {
        return models;
    }

    match probe_stable().await {
        Some((provider, models)) => {
            CACHE.insert(&provider, models.clone());
            models
        }
        None => Vec::new(),
    }
}

/// Re-queries fx for the active provider and replaces its cached list, so the
/// next [`list`] returns fx's own answer rather than a static table. For the
/// reader's manual Refresh: they want fx asked again, worth its ~2s startup,
/// even for codex or grok.
pub async fn refresh() {
    forget();
    if let Some((provider, models)) = probe_stable().await {
        CACHE.insert(&provider, models);
    }
}

/// Probes fx and pairs the models with the provider they belong to, or `None`
/// if the active provider changed across the probe.
///
/// `fx models` reports only whichever provider is active when it runs, so a
/// switch mid-probe makes the result ambiguous — provider B's models read under
/// a key of A. Reading the provider on both sides of the probe and caching only
/// when it held steady is what keeps a concurrent switch or Refresh from
/// poisoning the cache; an ambiguous result is dropped, and the next read (the
/// switch reloads one) probes again.
async fn probe_stable() -> Option<(String, Vec<Model>)> {
    let before = active_provider().await;
    let models = probe()
        .await
        .map_err(|err| eprintln!("[fx models] {err:#}"))
        .ok()?;
    let after = active_provider().await;
    (before == after).then(|| (after.unwrap_or_default(), models))
}

/// The fixed model lists for the subscription providers, or `None` for one
/// whose list must be discovered (gateway).
///
// ponytail: hardcoded from fx's own output — a subscription tier changes its
// models rarely, and the cost of a stale row here is one line to edit against
// two seconds off every switch. gateway is left to the probe precisely because
// its list is the one that moves.
fn known_models(provider: &str) -> Option<Vec<Model>> {
    let ids: &[&str] = match provider {
        "codex" => &[
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
        ],
        "grok" => &["grok-4.6", "grok-4.5"],
        _ => return None,
    };
    Some(
        ids.iter()
            .map(|id| id_to_model(id.to_string(), provider))
            .collect(),
    )
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

/// Moves fx onto another provider — fx's global setting, held in the `provider`
/// field of `~/.fx/settings.json`. The composer says so out loud.
///
/// Written directly rather than through `fx provider <name>`, which costs 2-3s
/// of fx startup to set one JSON field — the whole reason a switch felt broken.
/// `fx provider` does no more than write that field (it prints "Provider set"
/// even for a provider with no login), and [`active_provider`] already reads
/// the same file, so this is symmetric. On any read/parse trouble it falls back
/// to the CLI, which keeps correctness where the file shape is not what we
/// expect.
pub async fn set_provider(provider: &str) -> Result<()> {
    if !["gateway", "codex", "grok"].contains(&provider) {
        anyhow::bail!("fx has no provider named {provider:?}");
    }

    if write_setting("provider", provider.into()).await.is_err() {
        set_provider_via_cli(provider).await?;
    }

    // No `forget()`: the cache is keyed by provider, so the list this switch
    // moves *to* is read under its own key — cached from a previous visit or
    // probed once — and the list it moves *from* stays warm for the trip back.
    Ok(())
}

/// Serializes Dray's own writers of `~/.fx/settings.json`, so two provider
/// switches can't interleave their read-modify-write and lose one's change.
static SETTINGS_WRITE: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Sets one field in `~/.fx/settings.json`, preserving every other. Errors —
/// no home dir, missing or unparseable file — are the caller's to answer for:
/// the provider switch falls back to the CLI, the fast-mode write carries on
/// without it.
///
/// **Read, modify, write — never write a whole object built here.** The file is
/// fx's, holding its provider, its per-provider model picks, its effort and its
/// onboarding flags, and a field this build has never heard of is one it must
/// hand back untouched. Same bargain `SessionIndexItem.unknown` makes with
/// Dray's own index, kept for free by editing a `Value`.
///
/// The replace is atomic: the new bytes go to a temp file beside the target and
/// then `rename` over it, so fx (or any reader) sees the old file or the whole
/// new one, never a half-written truncation. The lock serializes Dray's writers
/// against each other; it cannot order fx's own writes, so a rewrite fx makes
/// between this read and rename is still lost — a temp+rename shrinks that
/// window to a single syscall.
pub(super) async fn write_setting(key: &str, value: serde_json::Value) -> Result<()> {
    let _guard = SETTINGS_WRITE.lock().await;

    let path = std::env::home_dir()
        .context("no home dir")?
        .join(".fx/settings.json");
    let bytes = tokio::fs::read(&path).await.context("reading fx settings")?;
    let mut settings: serde_json::Value =
        serde_json::from_slice(&bytes).context("parsing fx settings")?;
    let fields = settings
        .as_object_mut()
        .context("fx settings is not an object")?;

    // Nothing to do, and that is worth checking rather than writing anyway:
    // every fx session creation asks for the fast-mode field, and a rename over
    // somebody else's config file is not a thing to do for no change. It also
    // keeps the one window this cannot close — an fx write landing between the
    // read and the rename — shut for the overwhelmingly common case.
    if fields.get(key) == Some(&value) {
        return Ok(());
    }
    fields.insert(key.to_string(), value);

    let dir = path.parent().context("fx settings has no parent dir")?;
    let tmp = dir.join(format!(".settings.json.dray.{}", std::process::id()));
    tokio::fs::write(&tmp, serde_json::to_vec(&settings)?)
        .await
        .context("writing fx settings")?;
    tokio::fs::rename(&tmp, &path)
        .await
        .context("replacing fx settings")?;
    Ok(())
}

/// The slow, robust switch: `fx provider <name>`, kept as the fallback for when
/// the settings file cannot be edited by hand.
async fn set_provider_via_cli(provider: &str) -> Result<()> {
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
    Ok(())
}

#[derive(Deserialize)]
struct Listing {
    /// Every model of the active provider, always present. The richer `models`
    /// array below is dropped above a few dozen rows — gateway's 247 come back
    /// as `ids` only — so this is the list, and the provider comes from fx's
    /// settings rather than a per-row `source`.
    #[serde(default)]
    ids: Vec<String>,
    /// Present only for short lists, and carries a per-row `source`. Kept as a
    /// fallback for reading the provider when fx's settings can't be.
    #[serde(default)]
    models: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    /// Prose — "Codex subscription", "Vercel AI Gateway" — not the key
    /// `fx provider` takes. [`provider_key`] maps it.
    #[serde(default)]
    source: String,
}

/// Bounds the probe. `fx models` hangs indefinitely on a provider that is
/// selected but not signed in — grok, when its login is missing — reaching for
/// an API that never answers. Without this the composer's model refresh hangs
/// with it. Timing out degrades to the empty list, which reads as "No models
/// available", the same as any other failed read.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

async fn probe() -> Result<Vec<Model>> {
    let bin = crate::binpath::fx().await;
    let output = tokio::time::timeout(
        PROBE_TIMEOUT,
        Command::new(&bin)
            .args(["models", "--json"])
            .env("PATH", crate::harness::agent_path(&bin))
            // Killed if the timeout drops the future, or the hung `fx models`
            // outlives the probe as a zombie reaching for an API forever.
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("fx models timed out — a provider may be selected but not signed in")?
    .context("couldn't run fx to ask for its models")?;

    if !output.status.success() {
        anyhow::bail!(
            "fx models failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let listing: Listing =
        serde_json::from_slice(&output.stdout).context("fx models answered something else")?;

    // `fx models` lists the *active* provider alone, so every id belongs to it.
    // The provider is read from fx's settings — the one place it is recorded
    // for every list size — falling back to the `source` on a short list's rows
    // when the settings can't be read.
    let provider = active_provider()
        .await
        .or_else(|| listing.models.first().map(|r| provider_key(&r.source)))
        .unwrap_or_default();

    Ok(listing
        .ids
        .into_iter()
        .map(|id| id_to_model(id, &provider))
        .collect())
}

/// The provider `fx provider` last wrote, read from `~/.fx/settings.json`.
/// `None` if the file is missing or unreadable, which the caller answers with
/// the row `source` or an empty key.
async fn active_provider() -> Option<String> {
    let path = std::env::home_dir()?.join(".fx/settings.json");
    let bytes = tokio::fs::read(path).await.ok()?;
    let settings: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    settings.get("provider")?.as_str().map(str::to_string)
}

fn id_to_model(id: String, provider: &str) -> Model {
    Model {
        id: ModelId::new(&id),
        label: id.clone(),
        efforts: ladder_for(provider),
        // fx has its own, in its settings. Naming one here would override a
        // choice this app never made.
        default_effort: None,
        arg: id,
        provider: provider.to_string(),
        // A gateway model may well take one; the Codex provider answered
        // `refused` to a 1×1 PNG on capture. Off until a model says otherwise.
        accepts_images: false,
        secondary: false,
        // fx's own answer is "when the model supports it" and it publishes no
        // list of which — `fx models --json` carries an id and a provider and
        // nothing else. So the row is offered everywhere and fx decides: an
        // unsupported model simply runs at its ordinary speed, which is what it
        // does in fx's own TUI too.
        supports_fast: true,
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

    /// The real `fx models --json` for the codex provider — few enough rows to
    /// carry the rich `models` array beside `ids`.
    const CODEX_LISTING: &str = r#"{"kind":"models","count":5,"shown_count":5,"more_count":0,"private_models_hidden":false,"ids":["gpt-6-astra","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5"],"models":[{"id":"gpt-6-astra","source":"Codex subscription"},{"id":"gpt-5.6-sol","source":"Codex subscription"},{"id":"gpt-5.6-terra","source":"Codex subscription"},{"id":"gpt-5.6-luna","source":"Codex subscription"},{"id":"gpt-5.5","source":"Codex subscription"}]}"#;

    /// The real gateway shape: 247 models come back as `ids` alone, with no
    /// `models` array and so no per-row `source`. What the id-driven path fixes.
    const GATEWAY_LISTING: &str = r#"{"kind":"models","count":3,"shown_count":3,"more_count":0,"private_models_hidden":false,"ids":["anthropic/claude-fable-5.1","openai/gpt-5.6","xai/grok-5"]}"#;

    #[test]
    fn ids_become_models_under_the_active_provider() {
        let listing: Listing = serde_json::from_str(CODEX_LISTING).unwrap();
        let models: Vec<Model> = listing
            .ids
            .into_iter()
            .map(|id| id_to_model(id, "codex"))
            .collect();

        assert_eq!(models.len(), 5);
        assert!(models.iter().all(|m| m.provider == "codex"));
        assert_eq!(models[1].arg, "gpt-5.6-sol");
        assert!(models[1].efforts.contains(&Effort::Ultra));
        assert!(!ladder_for("gateway").contains(&Effort::Ultra));
    }

    #[test]
    fn a_models_less_listing_still_yields_every_id() {
        let listing: Listing = serde_json::from_str(GATEWAY_LISTING).unwrap();
        assert!(listing.models.is_empty(), "gateway sends no models array");

        let models: Vec<Model> = listing
            .ids
            .into_iter()
            .map(|id| id_to_model(id, "gateway"))
            .collect();

        assert_eq!(models.len(), 3);
        assert!(models.iter().all(|m| m.provider == "gateway"));
        assert_eq!(models[0].arg, "anthropic/claude-fable-5.1");
    }

    #[test]
    fn subscription_providers_answer_from_a_table_gateway_does_not() {
        let codex = known_models("codex").expect("codex is known");
        assert_eq!(codex.len(), 5);
        assert_eq!(codex[1].arg, "gpt-5.6-sol");
        assert!(codex[0].efforts.contains(&Effort::Ultra));

        let grok = known_models("grok").expect("grok is known");
        assert_eq!(grok.len(), 2);
        assert!(!grok[0].efforts.contains(&Effort::Ultra));

        // gateway's list is discovered, so it falls through to the probe.
        assert!(known_models("gateway").is_none());
    }

    #[test]
    fn provider_prose_maps_to_the_key_fx_provider_takes() {
        assert_eq!(provider_key("Vercel AI Gateway"), "gateway");
        assert_eq!(provider_key("Grok subscription"), "grok");
        assert_eq!(provider_key("Something New"), "something new");
    }
}
