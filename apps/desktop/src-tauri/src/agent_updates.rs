//! Whether an agent CLI has a newer version out, and running its own updater.
//!
//! **"Latest" is asked of each vendor's own source, never inferred.** Only grok
//! can answer from its CLI (`grok update --check --json`); the other four are
//! the URLs their own updaters read, measured against each installed CLI:
//! Claude Code's release channel file, pi's `latest-version` endpoint, fx's
//! `latest.txt` from its `setup.sh`, and npm for Codex, whose standalone
//! installer publishes the same version numbers.
//!
//! **The update is the CLI's own command, run with stdin closed.** All five
//! finish without a prompt (measured), and each knows how it was installed —
//! pi picks npm, pnpm or bun itself — which no table here could.

use crate::binpath;
use crate::harness::{agent_path, Harness};
use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use ts_rs::TS;

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
/// An updater downloads a whole binary or package, so it gets far longer than a
/// probe — but still a bound, or a CLI that decided to prompt would hold the
/// button spinning until the app restarted.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, TS, Clone)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    harness: Harness,
    label: String,
    current: String,
    latest: String,
}

/// One agent's answer. `update` is `None` where it is current or not installed.
#[derive(Serialize, TS)]
#[ts(export, export_to = "events.ts")]
pub struct AgentCheck {
    harness: Harness,
    update: Option<AgentUpdate>,
}

/// Every agent that could be asked. One that could not is **absent**, never
/// "current": the caller keeps its last answer for it, so a flaky endpoint
/// neither hides a known update nor invents one.
#[tauri::command]
pub async fn check_agent_updates() -> Vec<AgentCheck> {
    let checks = Harness::ALL.map(|harness| (harness, tokio::spawn(check(harness))));
    let mut out = Vec::new();
    for (harness, check) in checks {
        if let Ok(Ok(update)) = check.await {
            out.push(AgentCheck { harness, update });
        }
    }
    out
}

/// Runs the agent's own updater, then asks again.
///
/// `Ok(None)` is the ordinary success: the recheck finds nothing behind. An
/// `Ok(Some)` means the updater exited cleanly and the version did not move —
/// an install it declines to manage, say — which the caller draws as still
/// behind rather than as a success. `Err` carries the CLI's own last
/// line, the only thing that names which step failed.
#[tauri::command]
pub async fn update_agent(harness: Harness) -> Result<Option<AgentUpdate>, String> {
    let bin = binpath::agent_binary(harness).await;
    if !bin.is_absolute() {
        return Err(format!("{} is not installed", harness.label()));
    }
    let output = tokio::time::timeout(
        UPDATE_TIMEOUT,
        command(&bin).args(update_args(harness)).output(),
    )
    .await
    .map_err(|_| format!("{} update took too long", harness.label()))?
    .map_err(|err| format!("could not run {}: {err}", harness.label()))?;

    if !output.status.success() {
        // stderr last, since that is where the reason usually is.
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let said = text.lines().map(str::trim).filter(|line| !line.is_empty()).last();
        return Err(said.map_or_else(|| format!("{} update failed", harness.label()), String::from));
    }
    // "Updated" is read back, never assumed, so a recheck that cannot answer
    // is a failure rather than the success its silence would look like.
    check(harness)
        .await
        .map_err(|()| format!("{} updated, but its new version could not be read", harness.label()))
}

/// The same updater, in Terminal, for when the in-app run failed and the reader
/// wants to watch it or answer something it asked.
#[tauri::command]
pub async fn update_agent_in_terminal(harness: Harness) -> Result<(), String> {
    let bin = binpath::agent_binary(harness).await;
    // The enriched `PATH` rides the line: Terminal inherits launchd's when Dray
    // was opened from the Dock, where pi's `env node` and npm are not found.
    let mut line = format!(
        "PATH={} {}",
        crate::apps::sh_quote(&agent_path(&bin)),
        crate::apps::sh_quote(&bin.to_string_lossy())
    );
    for arg in update_args(harness) {
        line.push(' ');
        line.push_str(arg);
    }
    crate::apps::run_in_terminal(&line, "").await
}

fn update_args(harness: Harness) -> &'static [&'static str] {
    match harness {
        Harness::ClaudeCode => &["update"],
        Harness::Codex => &["update"],
        Harness::Pi => &["update", "--self"],
        Harness::Fx => &["upgrade"],
        Harness::Grok => &["update"],
        Harness::Other(_) => &[],
    }
}

fn command(bin: &std::path::Path) -> Command {
    let mut command = Command::new(bin);
    // `agent_path` because pi is a `node` script and its updater runs npm, and
    // a Dock-launched bundle has neither on launchd's `PATH`.
    command
        .env("PATH", agent_path(bin))
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

/// `Err` where the answer could not be read; `Ok(None)` where the agent is
/// current, not installed, or not Dray's to update.
async fn check(harness: Harness) -> Result<Option<AgentUpdate>, ()> {
    if !binpath::agent_installed(harness).await {
        return Ok(None);
    }
    let bin = binpath::agent_binary(harness).await;
    // The copy inside ChatGPT.app is updated by that app, and `codex update`
    // would install a second one beside it rather than touch it.
    if bin == std::path::Path::new(binpath::CHATGPT_APP_CODEX) {
        return Ok(None);
    }
    let (current, latest) = tokio::time::timeout(CHECK_TIMEOUT, versions(harness, &bin))
        .await
        .ok()
        .flatten()
        .ok_or(())?;
    Ok(newer(&latest, &current).then(|| AgentUpdate {
        harness,
        label: harness.label().to_string(),
        current,
        latest,
    }))
}

/// Installed and latest, or `None` where either could not be read.
async fn versions(harness: Harness, bin: &std::path::Path) -> Option<(String, String)> {
    if harness == Harness::Grok {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Check {
            current_version: String,
            latest_version: String,
        }
        let out = command(bin).args(["update", "--check", "--json"]).output().await.ok()?;
        let check: Check = serde_json::from_slice(&out.stdout).ok()?;
        return Some((check.current_version, check.latest_version));
    }

    let out = command(bin).arg("--version").output().await.ok()?;
    let current = version_in(&String::from_utf8_lossy(&out.stdout))?;
    let latest = match harness {
        Harness::ClaudeCode => {
            get(&format!(
                "https://downloads.claude.ai/claude-code-releases/{}",
                claude_channel()
            ))
            .await?
        }
        Harness::Codex => json_version("https://registry.npmjs.org/@openai/codex/latest").await?,
        Harness::Pi => json_version("https://pi.dev/api/latest-version").await?,
        // `latest.txt` is the stable channel's; a reader on fx's dev channel is
        // ahead of it by design, and telling them to "update" would be wrong.
        Harness::Fx if fx_channel().as_deref() == Some("dev") => return None,
        Harness::Fx => get("https://releases.fx.sh/latest.txt").await?,
        _ => return None,
    };
    Some((current, version_in(&latest)?))
}

/// Claude Code's own `autoUpdatesChannel`, so a reader on `stable` is not told
/// to update toward a `latest` that `claude update` will never install.
fn claude_channel() -> String {
    std::env::home_dir()
        .and_then(|home| std::fs::read_to_string(home.join(".claude/settings.json")).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("autoUpdatesChannel")?.as_str().map(String::from))
        .filter(|c| c == "stable" || c == "latest")
        .unwrap_or_else(|| "latest".to_string())
}

fn fx_channel() -> Option<String> {
    let raw = std::fs::read_to_string(std::env::home_dir()?.join(".fx/settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("update_channel")?.as_str().map(String::from)
}

async fn get(url: &str) -> Option<String> {
    let response = reqwest::Client::new()
        .get(url)
        .timeout(CHECK_TIMEOUT)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    response.text().await.ok()
}

async fn json_version(url: &str) -> Option<String> {
    let body: serde_json::Value = serde_json::from_str(&get(url).await?).ok()?;
    body.get("version")?.as_str().map(String::from)
}

/// The first `x.y.z` in a line, which is how all five spell it — `2.1.280 (Claude
/// Code)`, `codex-cli 0.156.1`, `v0.0.10`.
fn version_in(text: &str) -> Option<String> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|word| parse(word).is_some())
        .map(|word| word.trim_matches('.').to_string())
}

fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim_matches('.').split('.').map(|p| p.parse::<u64>().ok());
    let triple = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(triple)
}

// ponytail: numeric x.y.z only, prerelease suffixes ignored — none of the five
// publish one on the channels read here; reach for the `semver` crate if one does.
fn newer(latest: &str, current: &str) -> bool {
    matches!((parse(latest), parse(current)), (Some(l), Some(c)) if l > c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_clis_version_line() {
        assert_eq!(version_in("2.1.280 (Claude Code)").as_deref(), Some("2.1.280"));
        assert_eq!(version_in("codex-cli 0.156.1").as_deref(), Some("0.156.1"));
        assert_eq!(version_in("v0.0.10\n").as_deref(), Some("0.0.10"));
        assert_eq!(version_in("0.85.1").as_deref(), Some("0.85.1"));
        assert_eq!(version_in("no version here 1.2"), None);
    }

    #[test]
    fn compares_numerically_not_as_text() {
        assert!(newer("0.87.1", "0.85.1"));
        assert!(newer("2.1.280", "2.1.99"));
        assert!(!newer("0.0.10", "0.0.10"));
        assert!(!newer("2.1.267", "2.1.280"));
        assert!(!newer("garbage", "1.0.0"));
    }

    /// Asks the installed CLIs and the network. Run by hand when a vendor moves
    /// its version endpoint: `cargo test agent_updates -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn what_the_installed_agents_answer() {
        for check in check_agent_updates().await {
            match check.update {
                Some(u) => println!("{}: {} -> {}", u.label, u.current, u.latest),
                None => println!("{}: current", check.harness.label()),
            }
        }
    }
}
