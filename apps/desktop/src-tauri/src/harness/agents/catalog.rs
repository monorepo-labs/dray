//! Which ACP agents Dray can run, which the reader switched on, and how to start
//! each.
//!
//! The list is the ACP registry's (`REGISTRY_URL`), read once a day and kept on
//! disk, with a snapshot compiled in for a first launch offline. Beside it are
//! the reader's own custom agents — any command that speaks ACP over stdio.
//!
//! **Dray installs nothing.** A registry entry names a binary inside an archive
//! (`./bin/devin` + `acp`) or an `npx`/`uvx` package. The binary's own name is
//! resolved the way every other agent CLI is, so an agent the reader installed
//! by its vendor's route is found; a package runs through `npx`/`uvx`, which
//! fetch it on first use. Neither downloads anything from here.

use crate::harness::{intern, Harness};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, SystemTime};
use ts_rs::TS;

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const SNAPSHOT: &str = include_str!("registry.json");
/// How old the cached registry may get before a read refreshes it.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Registry entries that are Dray's native harnesses through an adapter. The
/// native ones carry worktrees, fork and fast mode; two rows called Claude
/// would only say the same thing worse.
const HIDDEN: [&str; 4] = ["claude-acp", "codex-acp", "pi-acp", "grok-build"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryAgent {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    distribution: Distribution,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Distribution {
    /// By `<os>-<arch>`, `darwin-aarch64` and friends.
    #[serde(default)]
    binary: Option<HashMap<String, BinaryTarget>>,
    #[serde(default)]
    npx: Option<Package>,
    #[serde(default)]
    uvx: Option<Package>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BinaryTarget {
    /// A path inside the archive, `./bin/devin`. Its file name is what is
    /// looked up on this machine.
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Package {
    /// Pinned, `@google/gemini-cli@0.64.0`, so the agent `npx` runs is the one
    /// the registry vouched for.
    package: String,
    #[serde(default)]
    args: Vec<String>,
}

/// An agent the reader added by hand: any command speaking ACP over stdio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    /// Lowercase letters, digits and dashes. Also its harness name, `acp:<id>`.
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// `acp-agents.json`. Its own file rather than a field on `settings.json`,
/// which every build rewrites whole through its own struct — an older build
/// would drop this list on its next unrelated toggle.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    #[serde(default)]
    enabled: Vec<String>,
    #[serde(default)]
    custom: Vec<CustomAgent>,
}

/// One row of Settings → Agents.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AcpAgent {
    pub harness: Harness,
    pub id: String,
    pub name: String,
    pub description: String,
    pub website: Option<String>,
    pub icon: Option<String>,
    pub enabled: bool,
    pub custom: bool,
    /// Whether the command it starts with is on this machine. Always true for
    /// an `npx`/`uvx` package once those are, since they fetch on first run.
    pub installed: bool,
    /// The command as a reader would type it, for the row's own line.
    pub command: String,
}

/// How to start one agent.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

static REGISTRY: LazyLock<RwLock<Option<Arc<Registry>>>> = LazyLock::new(Default::default);
/// Display names by id, readable from sync code — [`Harness::label`] is.
static NAMES: LazyLock<RwLock<HashMap<String, &'static str>>> = LazyLock::new(Default::default);
static PREFS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The agent's display name, or its id where nothing has been read yet.
pub fn name_of(id: &str) -> &'static str {
    if let Some(name) = NAMES.read().unwrap().get(id) {
        return name;
    }
    intern(id)
}

fn remember_names<'a>(pairs: impl Iterator<Item = (&'a str, &'a str)>) {
    let mut names = NAMES.write().unwrap();
    for (id, name) in pairs {
        names.insert(id.to_string(), intern(name));
    }
}

/// The registry this process works from: the cached copy, else the snapshot.
/// A stale or absent cache starts a refresh behind the answer rather than in
/// front of it, so a launch offline never waits on the network.
async fn registry() -> Arc<Registry> {
    if let Some(hit) = REGISTRY.read().unwrap().clone() {
        return hit;
    }

    let path = cache_path().await.ok();
    let cached = match &path {
        Some(path) => crate::store::read_json::<Registry>(path).await.ok(),
        None => None,
    }
    .filter(|r| !r.agents.is_empty());
    let fresh = match &path {
        Some(path) => tokio::fs::metadata(path)
            .await
            .and_then(|m| m.modified())
            .ok()
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|age| age < STALE_AFTER),
        None => false,
    };

    let registry = Arc::new(cached.unwrap_or_else(|| {
        serde_json::from_str(SNAPSHOT).expect("the bundled registry snapshot parses")
    }));
    install(registry.clone());

    if !fresh {
        tokio::spawn(async {
            if let Err(err) = refresh().await {
                eprintln!("[acp registry refresh err] {err:#}");
            }
        });
    }
    registry
}

fn install(registry: Arc<Registry>) {
    remember_names(registry.agents.iter().map(|a| (a.id.as_str(), a.name.as_str())));
    *REGISTRY.write().unwrap() = Some(registry);
}

/// Fetches the registry and keeps it. A failed fetch leaves what was there.
async fn refresh() -> Result<()> {
    let body = reqwest::Client::new()
        .get(REGISTRY_URL)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .context("asking the ACP registry for its agents")?
        .error_for_status()
        .context("the ACP registry refused the request")?
        .text()
        .await?;
    let registry: Registry = serde_json::from_str(&body).context("reading the ACP registry")?;
    if registry.agents.is_empty() {
        bail!("the ACP registry listed no agents");
    }
    crate::store::write_atomic(&cache_path().await?, serde_json::to_vec(&registry)?).await?;
    install(Arc::new(registry));
    Ok(())
}

async fn cache_path() -> Result<PathBuf> {
    Ok(crate::store::config_dir().await?.join("acp-registry.json"))
}

async fn prefs_path() -> Result<PathBuf> {
    Ok(crate::store::config_dir().await?.join("acp-agents.json"))
}

async fn read_prefs() -> Prefs {
    let prefs = match prefs_path().await {
        Ok(path) => crate::store::read_json::<Prefs>(&path).await.unwrap_or_else(|err| {
            eprintln!("[acp agents read err] {err:#}");
            Prefs::default()
        }),
        Err(_) => Prefs::default(),
    };
    remember_names(prefs.custom.iter().map(|c| (c.id.as_str(), c.name.as_str())));
    prefs
}

/// Read, edit, write under both locks — the app and its background server both
/// write this file.
async fn update_prefs(edit: impl FnOnce(&mut Prefs) -> Result<()>) -> Result<()> {
    let _held = PREFS_LOCK.lock().await;
    let _across = crate::store::lock_across_processes("acp-agents").await;
    let mut prefs = read_prefs().await;
    edit(&mut prefs)?;
    crate::store::write_atomic(&prefs_path().await?, serde_json::to_vec_pretty(&prefs)?).await
}

/// This machine's key into a registry entry's `binary` map.
fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("linux", "aarch64") => Some("linux-aarch64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        _ => None,
    }
}

/// The program and args an entry starts with, before resolving the program.
/// A binary is preferred where it ships for this platform: it is what the
/// vendor's own installer puts on `PATH`, where `npx` would fetch a second copy.
fn recipe(agent: &RegistryAgent) -> Option<(String, Vec<String>)> {
    if let Some(target) = platform().and_then(|p| agent.distribution.binary.as_ref()?.get(p)) {
        let name = std::path::Path::new(&target.cmd).file_name()?.to_str()?.to_string();
        return Some((name, target.args.clone()));
    }
    for (runner, package) in [("npx", &agent.distribution.npx), ("uvx", &agent.distribution.uvx)] {
        if let Some(package) = package {
            // `-y` so `npx` never stops to ask whether it may install — there is
            // no terminal behind this pipe to answer it.
            let mut args = match runner {
                "npx" => vec!["-y".to_string(), package.package.clone()],
                _ => vec![package.package.clone()],
            };
            args.extend(package.args.iter().cloned());
            return Some((runner.to_string(), args));
        }
    }
    None
}

fn command_line(program: &str, args: &[String]) -> String {
    std::iter::once(program).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
}

/// Every agent Settings can list: custom ones first, then the registry's.
pub async fn list() -> Vec<AcpAgent> {
    let registry = registry().await;
    let prefs = read_prefs().await;
    let enabled = |id: &str| prefs.enabled.iter().any(|e| e == id);

    let custom = prefs.custom.iter().map(|c| AcpAgent {
        harness: Harness::Acp(intern(&c.id)),
        id: c.id.clone(),
        name: c.name.clone(),
        description: String::new(),
        website: None,
        icon: None,
        enabled: enabled(&c.id),
        custom: true,
        installed: std::path::Path::new(&c.command).is_absolute()
            && std::path::Path::new(&c.command).exists()
            || crate::binpath::acp_agent_found(&c.command),
        command: command_line(&c.command, &c.args),
    });

    let listed = registry
        .agents
        .iter()
        .filter(|a| !HIDDEN.contains(&a.id.as_str()))
        .filter(|a| !prefs.custom.iter().any(|c| c.id == a.id))
        .filter_map(|a| {
            let (program, args) = recipe(a)?;
            Some(AcpAgent {
                harness: Harness::Acp(intern(&a.id)),
                id: a.id.clone(),
                name: a.name.clone(),
                description: a.description.clone(),
                website: a.website.clone(),
                icon: a.icon.clone(),
                enabled: enabled(&a.id),
                custom: false,
                installed: crate::binpath::acp_agent_found(&program),
                command: command_line(&program, &args),
            })
        });

    custom.chain(listed).collect()
}

/// The harnesses the composer offers beside the native five.
pub async fn enabled() -> Vec<Harness> {
    list()
        .await
        .into_iter()
        .filter(|a| a.enabled)
        .map(|a| a.harness)
        .collect()
}

/// How to start `id`, resolved. Custom agents shadow a registry entry of the
/// same id.
pub async fn launch(id: &str) -> Result<Launch> {
    let prefs = read_prefs().await;
    if let Some(custom) = prefs.custom.iter().find(|c| c.id == id) {
        let program = match std::path::Path::new(&custom.command) {
            path if path.is_absolute() => path.to_path_buf(),
            _ => crate::binpath::acp_agent(&custom.command).await,
        };
        return Ok(Launch {
            program,
            args: custom.args.clone(),
            env: custom.env.clone(),
        });
    }

    let registry = registry().await;
    let agent = registry
        .agents
        .iter()
        .find(|a| a.id == id)
        .with_context(|| format!("no ACP agent named {id}"))?;
    let (program, args) = recipe(agent)
        .with_context(|| format!("{} ships nothing that runs on this machine", agent.name))?;
    Ok(Launch {
        program: crate::binpath::acp_agent(&program).await,
        args,
        env: BTreeMap::new(),
    })
}

/// Where to send a reader whose agent is missing.
pub async fn website(id: &str) -> Option<String> {
    registry().await.agents.iter().find(|a| a.id == id)?.website.clone()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_acp_agents(recheck: Option<bool>) -> Vec<AcpAgent> {
    if recheck.unwrap_or(false) {
        crate::binpath::forget_acp_agents();
    }
    list().await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_acp_agent_enabled(id: String, enabled: bool) -> Result<(), String> {
    update_prefs(|prefs| {
        prefs.enabled.retain(|e| *e != id);
        if enabled {
            prefs.enabled.push(id.clone());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("{e:#}"))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_custom_acp_agent(agent: CustomAgent) -> Result<(), String> {
    if !valid_id(&agent.id) {
        return Err("An agent's id is lowercase letters, digits and dashes.".into());
    }
    if agent.name.trim().is_empty() || agent.command.trim().is_empty() {
        return Err("A custom agent needs a name and a command.".into());
    }
    update_prefs(|prefs| {
        prefs.custom.retain(|c| c.id != agent.id);
        prefs.enabled.retain(|e| *e != agent.id);
        prefs.enabled.push(agent.id.clone());
        prefs.custom.push(agent);
        Ok(())
    })
    .await
    .map_err(|e| format!("{e:#}"))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn remove_custom_acp_agent(id: String) -> Result<(), String> {
    update_prefs(|prefs| {
        prefs.custom.retain(|c| c.id != id);
        prefs.enabled.retain(|e| *e != id);
        Ok(())
    })
    .await
    .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Registry {
        serde_json::from_str(SNAPSHOT).expect("snapshot parses")
    }

    /// Devin is the agent this was built against, and its entry is a binary
    /// whose name is what gets looked up — never the archive path.
    #[test]
    fn devin_starts_as_its_own_binary_with_acp() {
        let registry = snapshot();
        let devin = registry.agents.iter().find(|a| a.id == "devin").expect("devin is listed");
        if platform().is_some() {
            assert_eq!(recipe(devin), Some(("devin".to_string(), vec!["acp".to_string()])));
        }
    }

    /// A package entry runs through `npx -y`, or `npx` stops to ask whether it
    /// may install into a pipe nobody reads.
    #[test]
    fn a_package_runs_through_npx_without_asking() {
        let registry = snapshot();
        let gemini = registry.agents.iter().find(|a| a.id == "gemini").expect("gemini is listed");
        let (program, args) = recipe(gemini).expect("gemini has a recipe");
        assert_eq!(program, "npx");
        assert_eq!(args[0], "-y");
        assert!(args[1].starts_with("@google/gemini-cli@"));
        assert_eq!(args.last().map(String::as_str), Some("--acp"));
    }

    /// The native harnesses' adapters stay out of the list.
    #[test]
    fn native_harnesses_are_not_listed_twice() {
        let registry = snapshot();
        for id in HIDDEN {
            assert!(registry.agents.iter().any(|a| a.id == id), "{id} moved out of the registry");
        }
    }

    #[test]
    fn a_custom_id_is_a_safe_harness_name() {
        assert!(valid_id("my-agent2"));
        for bad in ["", "-x", "My", "a b", "a:b", "../x"] {
            assert!(!valid_id(bad), "{bad:?} accepted");
        }
    }
}
