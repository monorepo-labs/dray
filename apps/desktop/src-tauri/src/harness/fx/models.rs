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
//! The ladder is **per model**, and no list this module can ask for names it:
//! the gateway serves 247 models and `effort` is absent from the
//! `configOptions` of every one that does no reasoning, arbitrarily by model
//! rather than by vendor — `anthropic/claude-opus-5` takes one and
//! `anthropic/claude-sonnet-4` does not. So a session is the only thing that
//! can answer, and [`learn_ladder`] is where one hands its answer back — a
//! level at a time, since fx's list is the model's ladder unioned with the
//! level the session is on and only the subtraction of that level is sound
//! ([`crate::harness::fx::parser::ConfigOptions::model_effort_levels`]). A
//! model no session has reported on keeps [`ladder_for`]'s guess by provider,
//! which is why [`crate::harness::fx::set_effort`] asks the live session
//! rather than this list before sending a level. `auto` is fx's own default
//! and is what an unset effort leaves it on; it and `none` are levels Dray's
//! ladder cannot spell, so they are dropped rather than given a rung
//! (DRA-140's rule — a rung is a persisted enum).
//!
//! Fast mode, by contrast, **is** in this list: the gateway names a fast tier
//! as a model of its own with `-fast` on the end, so [`supports_fast`] is a
//! lookup in the ids already in hand and [`visible`] keeps the twins out of the
//! picker.

use crate::harness::ProbeCache;
use crate::models::{Effort, Model, ModelId};
use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::process::Command;

/// How long a cached answer stands. Expires, because `fx provider` and
/// `fx login` are things a reader does while Dray is open, and "restart the
/// app" is a poor answer to a list that is supposed to follow them.
const FRESH_FOR: Duration = Duration::from_secs(120);

static CACHE: LazyLock<ProbeCache<Vec<Model>>> = LazyLock::new(|| ProbeCache::new(FRESH_FOR));

/// Every model fx reports for its active provider that the picker should draw.
///
/// [`visible`] is the difference between this and [`all`], and the split is
/// load-bearing rather than tidy: a row kept out of the menu must still be
/// runnable, so [`find`] reads the unfiltered list.
pub async fn list() -> Vec<Model> {
    all().await.into_iter().filter(visible).collect()
}

/// Every model fx reports for its active provider, hidden rows included,
/// newest answer or cached.
///
/// **For resolving an id that already exists, never for offering a choice.**
/// [`list`] is the one to reach for anywhere a reader is being shown models;
/// this one is for [`find`] alone, whose job is to answer for a model some
/// session is *already recorded on* — including a gateway `-fast` id the
/// picker deliberately does not draw. Offering from here would put the twins
/// back in the menu, which is the whole thing [`visible`] exists to stop.
///
/// Failure answers an empty list rather than an error: the picker draws its
/// own empty state, and a reader with no provider logged in is in an ordinary
/// state rather than a broken one.
async fn all() -> Vec<Model> {
    let key = active_provider().await.unwrap_or_default();

    // A real probe already cached for this provider wins over the static table
    // below — that is how [`refresh`] lets a changed subscription catalog reach
    // the picker despite the tables. Fresh only; a stale entry falls through.
    if let Some(fresh) = CACHE.peek(&key) {
        return with_learned_ladders(fresh);
    }

    // The subscription providers serve a handful of models each, fixed and
    // known, so the first read answers from a table with no probe — `fx models`
    // costs ~2s of fx startup whatever it returns. gateway's list is discovered
    // (247 and unbounded), so it alone is probed. The manual Refresh calls
    // [`refresh`], which probes fx even for a table-backed provider and caches
    // the answer above.
    if let Some(models) = known_models(&key) {
        return with_learned_ladders(models);
    }

    match probe_stable().await {
        Some((provider, models)) => {
            CACHE.insert(&provider, models.clone());
            with_learned_ladders(models)
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
    Some(ids_to_models(
        ids.iter().map(|id| id.to_string()).collect(),
        provider,
    ))
}

/// The model with this id, from whatever fx last reported. `None` for the
/// unset sentinel — fx picking for itself — and for an id the active provider
/// does not serve. The second is not refused here: fx's own sentence on the
/// first prompt names exactly what was wrong.
///
/// Reads [`all`] and not [`list`], and that is the whole reason the two exist.
/// **Hiding a row from the picker must not make it unspawnable.** A session
/// already recorded on a gateway `-fast` id has to keep running and keep naming
/// its own model, and `None` here is not a refusal that says so: it is what
/// makes [`super::init`] omit `--model` altogether and record the session's
/// model as *unset*. So the session would quietly move onto fx's own default
/// and forget which model it had been having its conversation with — invisible
/// on screen, silent in the log. Codex's hidden rows make the same bargain.
pub async fn find(id: &ModelId) -> Option<Model> {
    if id.is_unset() {
        return None;
    }
    all().await.into_iter().find(|m| &m.id == id)
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
    write_setting_at(&path, key, value).await
}

/// Takes the path so a test can round-trip against a tempdir and read the mode
/// back, rather than writing into the reader's real `~/.fx`.
async fn write_setting_at(
    path: &std::path::Path,
    key: &str,
    value: serde_json::Value,
) -> Result<()> {
    let bytes = tokio::fs::read(path).await.context("reading fx settings")?;
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

    // **The file's own mode, carried onto the temp before the rename.** This is
    // somebody else's config, so the rule is preserve what was found rather than
    // mint a mode of our own — and fx keeps it at `0600`, as it does every file
    // beside it. `fs::write` creates at the process umask, so the rename was
    // handing the reader back a `0644` copy of their own config on every write
    // through here — a provider switch, and every session creation that moves
    // fast mode — readable by any other account on the machine. Measured, not
    // feared: fx rewrites the mode to `0600` on each of its own writes, so the
    // widening was Dray's alone and came back every time.
    //
    // On the temp at **create**, never on the final file after the rename: the
    // same ordering [`crate::issues`]'s credential write documents, and for the
    // same reason — every other order leaves a window where the file exists at
    // the wider mode.
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::metadata(path)
            .await
            .map(|m| m.permissions().mode() & 0o777)
            // Unreadable metadata on a file we just read whole is not a case
            // worth a failed switch, and `0600` is the narrow direction.
            .unwrap_or(0o600)
    };

    let dir = path.parent().context("fx settings has no parent dir")?;
    let tmp = dir.join(format!(".settings.json.dray.{}", std::process::id()));
    // Cleared first, so the `create_new` below is answering "did this call make
    // the file" rather than failing over one a crashed write left behind.
    let _ = tokio::fs::remove_file(&tmp).await;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // A ceiling, not the answer: `open` applies `mode & !umask`, so this can only
    // land at or below what was found. That is the half that matters for safety —
    // the temp never exists wider than the target is going to be — and the
    // `set_permissions` below is what makes it *exact*.
    #[cfg(unix)]
    options.mode(mode);

    let written = async {
        use tokio::io::AsyncWriteExt;
        let mut file = options.open(&tmp).await?;
        file.write_all(&serde_json::to_vec(&settings)?).await?;
        file.sync_all().await?;
        // Restored exactly, because the create above was filtered by the umask:
        // under `0077` a file found at `0644` would otherwise be renamed into
        // place at `0600`, silently *narrowing* the reader's own config instead
        // of preserving it. Still before the rename, so the window the ordering
        // exists to close stays closed.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(mode))
                .await?;
        }
        anyhow::Ok(())
    }
    .await;

    if let Err(error) = written {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(error.context("writing fx settings"));
    }

    if let Err(error) = tokio::fs::rename(&tmp, path).await {
        // Or the next switch inherits a stale temp file `create_new` would trip on.
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(anyhow::Error::new(error).context("replacing fx settings"));
    }
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

    Ok(ids_to_models(listing.ids, &provider))
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

/// A provider's whole id list as models.
///
/// Mapped over the set rather than one id at a time because [`supports_fast`]
/// is a lookup *in* that set — a model's fast tier is another row in the same
/// list, so nothing can answer for one id alone.
fn ids_to_models(ids: Vec<String>, provider: &str) -> Vec<Model> {
    let siblings: HashSet<&str> = ids.iter().map(String::as_str).collect();
    ids.iter()
        .map(|id| id_to_model(id.clone(), provider, &siblings))
        .collect()
}

/// The gateway's own spelling of a fast tier.
const FAST_SUFFIX: &str = "-fast";

fn is_fast_tier(id: &str) -> bool {
    id.ends_with(FAST_SUFFIX)
}

/// Whether a row is drawn in the picker at all.
///
/// The gateway's `-fast` twins are not. They are the same models in another
/// gear, so listing them puts 25 models in twice — once as a model and once as
/// a mode — and picking one directly gives fast speed with an inert fast-mode
/// toggle beside it, which reads as broken. The toggle on the base model is the
/// way to reach them, and whatever fx does behind the scenes to serve one is
/// fx's business.
///
/// **Scoped to gateway, not to the suffix.** codex and grok list no `-fast` id
/// today, so a filter on the suffix alone would be a no-op — which is exactly
/// what makes it the wrong code to leave behind. The day a provider ships a
/// model legitimately named something-fast it would vanish from the picker with
/// nobody able to say why.
///
/// **Hidden is not unrunnable** — see [`find`], which reads the unfiltered list.
fn visible(model: &Model) -> bool {
    !(model.provider == "gateway" && is_fast_tier(&model.arg))
}

/// Whether this model has a faster tier to ask for — per provider, because only
/// one of them publishes the answer.
///
/// **gateway names its fast tiers as models**, a separate id with `-fast` on
/// the end, 25 of the 247 on the probe box. So a model has fast mode exactly
/// where its twin is in the list: `anthropic/claude-opus-5` has one and fx's
/// TUI offers the toggle, `anthropic/claude-fable-5.1` has none and the TUI
/// says *"This model does not come with a fast mode"* and turns fast mode off.
/// Unlike the effort ladder next door, no session is needed to learn this and
/// there is nothing to announce — the list Dray already fetches *is* the answer.
///
/// **A `-fast` id itself takes no toggle, because it *is* the fast tier** — not
/// because it lacks one. The twin lookup would answer `false` for it anyway,
/// since no `…-fast-fast` exists, but only by accident: that is the list
/// happening not to hold a row where the real reason is what the id means. Its
/// own arm, so a tidy-up deleting it as redundant fails a test.
///
/// **The rule stops at the gateway boundary, measured.** codex lists no `-fast`
/// id and `gpt-5.6-sol` on that subscription *does* offer the toggle in the
/// TUI, so the twin rule applied there would mark every model as having no fast
/// mode. grok is **untested** — nobody has checked either half — and keeps
/// `true` for codex's reason rather than on a measurement of its own.
fn supports_fast(id: &str, provider: &str, siblings: &HashSet<&str>) -> bool {
    if provider != "gateway" {
        return true;
    }
    if is_fast_tier(id) {
        return false;
    }
    siblings.contains(format!("{id}{FAST_SUFFIX}").as_str())
}

fn id_to_model(id: String, provider: &str, siblings: &HashSet<&str>) -> Model {
    Model {
        supports_fast: supports_fast(&id, provider, siblings),
        // The guess. [`with_learned_ladders`] replaces it on the way out with
        // what a session running this model actually reported.
        efforts: ladder_for(provider),
        id: ModelId::new(&id),
        label: id.clone(),
        // fx has its own, in its settings. Naming one here would override a
        // choice this app never made.
        default_effort: None,
        arg: id,
        provider: provider.to_string(),
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

/// What a live session said its model takes, keyed by the id fx spells.
///
/// Not persisted, and deliberately: an entry is re-learned by the very next
/// `session/new` or `session/resume` on that model, so a file would buy one
/// cold picker draw at the price of a schema to migrate. A model never run
/// under this process keeps [`ladder_for`]'s guess.
static LADDERS: LazyLock<Mutex<HashMap<String, Vec<Effort>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Rung order, low to high. The union below is rebuilt in it, since the picker
/// draws the list as handed and two readings merged by set would arrive in
/// whatever order the merge pleased.
const RUNGS: [Effort; 6] = [
    Effort::Low,
    Effort::Medium,
    Effort::High,
    Effort::Xhigh,
    Effort::Max,
    Effort::Ultra,
];

/// Records what a live session answered for its active model, and says whether
/// that changed anything — which is what decides if the composer is told to
/// re-read, since an unchanged ladder is every send after the first.
///
/// The two arms are two kinds of statement, and conflating them is a bug
/// either way round:
///
/// - **`None` is definitive** — fx carried no `effort` option at all, which is
///   it saying the model has no reasoning effort. It *replaces* whatever was
///   known, and an empty list is a real answer: it is what makes the picker
///   stop drawing an effort submenu.
/// - **`Some(levels)` is partial** — `configOptions` minus the level the
///   session sits on (see `ConfigOptions::model_effort_levels`). Every level
///   in it is one the model takes, but the subtraction may have dropped one
///   the model *also* takes, so it is **unioned** rather than assigned.
///   Without the union the learned ladder would lose whichever rung was in use
///   and regain it on the next change, so the menu would shuffle a level in
///   and out as the reader worked.
pub fn learn_ladder(model_arg: &str, levels: Option<Vec<Effort>>) -> bool {
    let mut ladders = LADDERS.lock().expect("fx ladders poisoned");

    let next = match levels {
        None => Vec::new(),
        Some(partial) => {
            let known = ladders.get(model_arg);
            RUNGS
                .into_iter()
                .filter(|rung| {
                    partial.contains(rung) || known.is_some_and(|k| k.contains(rung))
                })
                .collect()
        }
    };

    if ladders.get(model_arg) == Some(&next) {
        return false;
    }
    ladders.insert(model_arg.to_string(), next);
    true
}

/// Puts what has been learned over what was guessed, applied **at read rather
/// than at build** — the gateway's list is cached as whole [`Model`]s, so a
/// ladder learned after that read would never reach the picker if it were
/// stamped on in [`id_to_model`]. One place, and every route into [`list`]
/// passes through it.
fn with_learned_ladders(models: Vec<Model>) -> Vec<Model> {
    let ladders = LADDERS.lock().expect("fx ladders poisoned");
    if ladders.is_empty() {
        return models;
    }
    models
        .into_iter()
        .map(|mut model| {
            if let Some(learned) = ladders.get(&model.arg) {
                model.efforts = learned.clone();
            }
            model
        })
        .collect()
}

// ponytail: per-provider guess, read off two captures, for a model no session
// has reported on yet. It is wrong in both directions on the gateway — it
// offers effort where a model has none and stops at `xhigh` where
// claude-opus-5 goes to `max` — which is why it is only ever a first draw:
// [`learn_ladder`] replaces it with the model's own the moment one runs.
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
        let models = ids_to_models(listing.ids, "codex");

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

        let models = ids_to_models(listing.ids, "gateway");

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

    /// The real gateway shape for fast tiers: a twin is a row of its own,
    /// beside the model it makes fast. Opus has one, Fable does not.
    const GATEWAY_FAST_LISTING: &str = r#"{"kind":"models","ids":["anthropic/claude-opus-5","anthropic/claude-opus-5-fast","anthropic/claude-fable-5.1","openai/gpt-5.6-sol","openai/gpt-5.6-sol-fast"]}"#;

    fn gateway_models() -> Vec<Model> {
        let listing: Listing = serde_json::from_str(GATEWAY_FAST_LISTING).unwrap();
        ids_to_models(listing.ids, "gateway")
    }

    fn model<'a>(models: &'a [Model], arg: &str) -> &'a Model {
        models.iter().find(|m| m.arg == arg).expect("model is listed")
    }

    /// A gateway model has fast mode exactly where the list carries its twin.
    /// fx's TUI offers the toggle on `claude-opus-5` and refuses it on
    /// `claude-fable-5.1`, which is the pair this reproduces.
    #[test]
    fn a_gateway_model_has_fast_mode_where_its_twin_is_listed() {
        let models = gateway_models();

        assert!(model(&models, "anthropic/claude-opus-5").supports_fast);
        assert!(model(&models, "openai/gpt-5.6-sol").supports_fast);
        assert!(
            !model(&models, "anthropic/claude-fable-5.1").supports_fast,
            "no twin in the list, so fx turns fast mode off for it",
        );
    }

    /// A `-fast` id takes no toggle **because it is the fast tier**, not
    /// because the list happens to hold no `…-fast-fast` beside it.
    ///
    /// The twin lookup alone answers `false` here by accident, so this feeds it
    /// a list where the accident does not hold: with `…-fast-fast` present, a
    /// rule that were only a twin lookup would light the toggle on a row that
    /// already *is* the fast tier.
    #[test]
    fn a_fast_tier_is_refused_for_being_one_not_for_want_of_a_twin() {
        assert!(!gateway_models()[1].supports_fast, "claude-opus-5-fast");

        let contrived = ids_to_models(
            vec!["x/m-fast".to_string(), "x/m-fast-fast".to_string()],
            "gateway",
        );
        assert!(
            !contrived[0].supports_fast,
            "a fast tier takes no toggle even where a twin of it is listed",
        );
    }

    /// The rule stops at the gateway. codex offers fast mode and lists no
    /// `-fast` id, so a twin lookup applied there would mark every model as
    /// having none — the whole reason this is per provider.
    #[test]
    fn the_twin_rule_does_not_reach_the_subscription_providers() {
        assert!(known_models("codex").unwrap().iter().all(|m| m.supports_fast));
        assert!(known_models("grok").unwrap().iter().all(|m| m.supports_fast));

        // And the suffix means nothing off the gateway: a codex model named
        // this way keeps its toggle rather than being read as a tier.
        let codexish = ids_to_models(vec!["gpt-fast".to_string()], "codex");
        assert!(codexish[0].supports_fast);
    }

    /// Hidden from the picker, still runnable — the silent failure the
    /// [`list`]/[`all`] split exists for.
    ///
    /// A session already recorded on a `-fast` id resolves through [`find`].
    /// Were that reading the *filtered* list it would answer `None`, and `None`
    /// is not a refusal that reports itself here: [`super::init`] omits
    /// `--model` entirely and the session's own model is recorded as unset, so
    /// the conversation moves to fx's default and forgets which model it had
    /// been held with, with nothing on screen or in the log saying so.
    ///
    /// **Goes through the real [`list`] and [`find`]**, because which of the
    /// two `find` reads is the entire thing being guarded: a test asserting
    /// over a `Vec` built here still passes with `find` reverted to `list`,
    /// which would leave every recorded `-fast` session unresolvable and
    /// nothing failing.
    ///
    /// Seeded through [`CACHE`] under whatever key [`all`] computes on this
    /// machine, since the peek is the first thing it does — ahead of
    /// [`known_models`] and of any probe, so no `fx` is spawned and the answer
    /// does not depend on which provider the reader happens to be on.
    #[tokio::test]
    async fn a_hidden_fast_tier_is_dropped_from_the_picker_but_still_resolves() {
        let key = active_provider().await.unwrap_or_default();
        CACHE.insert(&key, gateway_models());

        let drawn = list().await;
        assert_eq!(drawn.len(), 3, "both -fast twins are kept out of the picker");
        assert!(!drawn.iter().any(|m| is_fast_tier(&m.arg)));

        let recorded = ModelId::new("openai/gpt-5.6-sol-fast");
        assert!(
            !drawn.iter().any(|m| m.id == recorded),
            "the picker does not draw the row this session is recorded on",
        );

        let found = find(&recorded)
            .await
            .expect("a session recorded on a fast tier still resolves");
        assert_eq!(found.arg, "openai/gpt-5.6-sol-fast", "and names its own model");
        assert!(!found.supports_fast, "it is the fast tier, so there is no toggle on it");

        CACHE.forget();

        // A row off the gateway is never filtered, whatever it is called.
        assert!(visible(&ids_to_models(vec!["gpt-fast".to_string()], "codex")[0]));
    }

    /// A model a session has actually run reports its own ladder, and that
    /// beats the provider guess in both directions — the guess offers effort
    /// where the gateway's grok has none, and stops at `xhigh` where its
    /// claude-opus-5 goes to `max`.
    ///
    /// The ids are this test's own, since [`LADDERS`] is process-wide and a
    /// name a sibling test also used would make the two order-dependent.
    #[test]
    fn a_learned_ladder_beats_the_provider_guess() {
        let built = |id: &str| ids_to_models(vec![id.to_string()], "gateway").remove(0);

        // The list as built, before anything has run: the provider's guess.
        let guessed = with_learned_ladders(vec![built("test/never-run")]);
        assert_eq!(guessed[0].efforts, ladder_for("gateway"));

        assert!(learn_ladder("test/no-reasoning", None));
        assert!(learn_ladder(
            "test/reasons",
            Some(vec![Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max]),
        ));

        // Applied to a list built *earlier*, which is the gateway's cached one:
        // stamping the ladder on at build time would leave that list stale for
        // as long as it stays fresh.
        let stale = vec![built("test/no-reasoning"), built("test/reasons"), built("test/never-run")];
        let read = with_learned_ladders(stale);
        assert!(
            read[0].efforts.is_empty(),
            "an empty ladder is an answer — it is what stops the picker drawing the submenu"
        );
        assert!(
            read[1].efforts.contains(&Effort::Max),
            "the guess stops at xhigh; the model's own list is what carries max"
        );
        assert_eq!(read[2].efforts, ladder_for("gateway"), "unlearned, so untouched");

        // Only news is news: the composer is told to re-read off this bool, and
        // every send after the first would otherwise bump it.
        assert!(!learn_ladder("test/no-reasoning", None));
    }

    /// A partial reading is unioned, never assigned. Each one is missing
    /// whichever level its session happened to be on, so assigning would drop
    /// that rung from the picker and hand it back on the next change — a menu
    /// shuffling a level in and out as the reader works.
    ///
    /// `None` is the other kind of statement and still replaces: fx carrying
    /// no `effort` option at all is it saying the model has none.
    #[test]
    fn partial_readings_are_unioned_and_a_definitive_one_replaces() {
        let ladder = |id: &str| {
            with_learned_ladders(ids_to_models(vec![id.to_string()], "gateway"))[0]
                .efforts
                .clone()
        };

        // Sitting on `max`, so the reply's list came back without it.
        assert!(learn_ladder(
            "test/union",
            Some(vec![Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh]),
        ));
        assert!(!ladder("test/union").contains(&Effort::Max));

        // Moved to `low`, so this reading carries `max` and misses `low`.
        assert!(learn_ladder(
            "test/union",
            Some(vec![Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max]),
        ));
        assert_eq!(
            ladder("test/union"),
            vec![Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max],
            "both readings together are the model's whole ladder, in rung order",
        );

        // Converged, so nothing to tell the composer about.
        assert!(!learn_ladder("test/union", Some(vec![Effort::Low, Effort::Medium])));

        // fx saying the model has no effort at all overrides everything learned.
        assert!(learn_ladder("test/union", None));
        assert!(ladder("test/union").is_empty());
    }

    #[test]
    fn provider_prose_maps_to_the_key_fx_provider_takes() {
        assert_eq!(provider_key("Vercel AI Gateway"), "gateway");
        assert_eq!(provider_key("Grok subscription"), "grok");
        assert_eq!(provider_key("Something New"), "something new");
    }

    /// The file is fx's, kept at `0600` like everything beside it, and **every**
    /// write through here must hand it back at the mode it was found at — the
    /// provider switch and the fast-mode write each session creation makes.
    /// `fs::write` creates at the process umask, so without this the reader's own
    /// config came back `0644` — and fx rewrites `0600` on its next write, so the
    /// widening returned each time rather than settling.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_settings_write_hands_the_file_back_at_the_mode_it_found() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "dray-fx-settings-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        // `0o777` is what pins the umask half, and it pins it **without setting
        // a umask here** — which must not happen, since a umask is process-wide
        // and these tests run in parallel.
        //
        // It works because `0o777 & umask != 0` for every umask except `0000`:
        // a build that only passes `OpenOptions::mode` and never restores the
        // permissions creates the temp at `0o777 & !umask` and renames that into
        // place, so this row fails under any umask that filters anything. And
        // under `0000` nothing is filtered, so that build is *correct* and there
        // is no regression to catch. The row's coverage is therefore exactly as
        // wide as the defect's reach, rather than depending on the ambient value.
        for found in [0o600, 0o644, 0o777] {
            std::fs::write(
                &path,
                br#"{"provider":"codex","models":{"grok":"grok-4.6"},"yolo_acknowledged":true}"#,
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(found)).unwrap();

            write_setting_at(&path, "provider", "grok".into()).await.unwrap();

            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, found, "a switch must not move the file's mode");

            // Every other field handed back untouched — the whole reason this
            // edits a `Value` rather than writing an object built here.
            let after: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(after["provider"], "grok");
            assert_eq!(after["models"]["grok"], "grok-4.6");
            assert_eq!(after["yolo_acknowledged"], true);

            // And no temp left beside it holding the same config at the umask's mode.
            assert!(
                !dir.join(format!(".settings.json.dray.{}", std::process::id()))
                    .exists()
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
