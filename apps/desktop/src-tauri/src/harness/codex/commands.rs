//! The slash commands Codex offers, which are its skills and nothing else.
//!
//! Codex's own `/` menu mixes two unlike things. Most rows — `/model`,
//! `/approvals`, `/new`, `/diff` — are TUI actions that never reach the server,
//! and Dray already owns every one of them in its own chrome, so listing them
//! would draw controls that do nothing. What is left is **skills**, and those
//! are real: `skills/list` answers them and `turn/start` takes one as an input
//! item of its own.
//!
//! That last part is why this file has a companion in [`super::skill_input`] —
//! unlike Claude Code, where a slash command travels as ordinary prompt text and
//! the CLI expands it, Codex expands nothing. `/caveman` sent as text is the
//! literal four-slash-word to the model. The picker and the send path therefore
//! have to agree, and both read the same `skills/list`.

use super::rpc::RpcClient;
use crate::harness::claude_code::commands::SlashCommand;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
    time::timeout,
};

/// One row of `skills/list`, which answers far more per skill than this — a
/// scope, a plugin id, a display interface. Only what the picker draws and what
/// `turn/start` demands is read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The `SKILL.md` behind it. Load-bearing, not decoration: a `skill` input
    /// item carries `name` **and** `path`, and one without the path is refused
    /// outright with `missing field path`.
    pub path: String,
    /// A skill the reader has switched off. Absent means on — the field is
    /// theirs to set and most rows never carry it.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// `skills/list` answers per directory, since a project can carry its own.
#[derive(Debug, Deserialize)]
struct SkillsScope {
    #[serde(default)]
    skills: Vec<Skill>,
}

#[derive(Debug, Deserialize)]
struct SkillsList {
    #[serde(default)]
    data: Vec<SkillsScope>,
}

/// Kept for the life of the process, keyed by directory, exactly as Claude
/// Code's list is: a probe costs a child, and a skill installed while Dray is
/// open is a restart away rather than a keystroke away.
static CACHE: Mutex<Option<HashMap<String, Vec<Skill>>>> = Mutex::const_new(None);

/// A probe that hangs must not hold the picker open forever.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Every skill available in `cwd`, cached after the first read. Only the picker
/// reads this; the send path asks the session's own child instead.
///
/// Failure answers an empty list rather than an error, the call `pi`'s list
/// makes: the picker is an accelerator for text the reader can always type by
/// hand, so it staying shut is a smaller failure than an error over the
/// composer.
async fn list_skills(cwd: &str) -> Vec<Skill> {
    if let Some(hit) = CACHE.lock().await.as_ref().and_then(|map| map.get(cwd)) {
        return hit.clone();
    }

    let skills = match timeout(PROBE_TIMEOUT, probe(cwd)).await {
        Ok(Ok(skills)) => skills,
        Ok(Err(err)) => {
            eprintln!("[codex commands] {err:#}");
            return Vec::new();
        }
        Err(_) => {
            eprintln!("[codex commands] timed out asking codex for its skills");
            return Vec::new();
        }
    };

    CACHE
        .lock()
        .await
        .get_or_insert_with(HashMap::new)
        .insert(cwd.to_string(), skills.clone());

    skills
}

/// The picker's rows for `cwd`.
pub async fn list_commands(cwd: &str) -> Vec<SlashCommand> {
    list_skills(cwd)
        .await
        .into_iter()
        .map(|skill| SlashCommand {
            name: skill.name,
            description: first_sentence(&skill.description),
            // Codex publishes neither. A skill takes whatever follows it as
            // ordinary prose, so there is no hint to draw and no alias to offer.
            argument_hint: String::new(),
            aliases: Vec::new(),
        })
        .collect()
}

/// The `skill` input item a prompt opening with `/name` should travel as, or
/// `None` where it opens with no slash or names no skill this session has.
///
/// Asked of the **session's own** client rather than of [`list_skills`]: the
/// child is already running in the right directory, so this costs one roundtrip
/// where the cache costs a whole extra app-server — and it cannot answer for
/// the wrong project the way a stale cwd-keyed entry could.
///
/// `None` leaves the prompt as ordinary text, which is the right answer both
/// for prose that happens to start with a slash and for a skill that has since
/// been removed.
pub async fn skill_item(client: &RpcClient, text: &str) -> Option<Value> {
    let name = text.strip_prefix('/')?.split_whitespace().next()?;
    let answer = client.request("skills/list", json!({})).await.ok()?;
    let skill = read_rows(&answer)
        .into_iter()
        .find(|skill| skill.name == name)?;

    Some(json!({"type": "skill", "name": skill.name, "path": skill.path}))
}

/// What is left of `text` once its leading `/name` is taken off.
pub fn without_command(text: &str) -> &str {
    let rest = text.trim_start_matches('/');
    match rest.find(char::is_whitespace) {
        Some(at) => rest[at..].trim(),
        None => "",
    }
}

/// Spawns a throwaway app-server in `cwd` purely to ask it, then drops it.
///
/// The directory is load-bearing: `skills/list` resolves project-scoped skills
/// against the process's own cwd, verified live — a probe spawned anywhere else
/// answers for the wrong project.
async fn probe(cwd: &str) -> Result<Vec<Skill>> {
    let bin = crate::binpath::codex().await;
    let mut child = Command::new(&bin)
        .arg("app-server")
        .current_dir(cwd)
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // The read can end early — a timeout, an unreadable reply — and the
        // child waits on a stdin that never closes, so dropping it has to reap.
        .kill_on_drop(true)
        .spawn()
        .context("couldn't start codex to ask for its skills")?;

    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let client = RpcClient::new(stdin);

    tokio::spawn({
        let client = client.clone();
        async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                client.accept(&line).await;
            }
        }
    });

    // Every other method is refused with "Not initialized" until both halves of
    // the handshake have gone out.
    client
        .request(
            "initialize",
            json!({"clientInfo": {"name": "dray", "title": "Dray",
                                  "version": env!("CARGO_PKG_VERSION")}}),
        )
        .await?;
    client.notify("initialized", json!({}))?;

    let answer = client.request("skills/list", json!({})).await?;

    Ok(read_rows(&answer))
}

/// Folds `skills/list` onto the picker's vocabulary.
///
/// Read leniently for `map_model_usage`'s reason: a shape Codex extends later
/// must cost one field, never the whole list — and an empty picker looks exactly
/// like a reader having no skills at all.
fn read_rows(answer: &Value) -> Vec<Skill> {
    let Ok(list) = serde_json::from_value::<SkillsList>(answer.clone()) else {
        return Vec::new();
    };

    list.data
        .into_iter()
        .flat_map(|scope| scope.skills)
        .filter(|skill| skill.enabled)
        .collect()
}

/// The first sentence of a skill's description.
///
/// Skill descriptions are written for the *model* — several hundred words of
/// trigger phrases — where the picker draws one line. Cut at the first full stop
/// rather than at a character count, so the row ends on a sentence.
fn first_sentence(description: &str) -> String {
    match description.find(". ") {
        Some(at) => description[..=at].to_string(),
        None => description.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The captured shape of a real `skills/list`, folded onto rows.
    #[test]
    fn skills_become_rows_and_keep_the_path_the_send_path_needs() {
        let rows = read_rows(&json!({"data": [{"cwd": "/x", "skills": [
            {"name": "caveman", "description": "Ultra-compressed mode. Cuts tokens.",
             "path": "/Users/x/.codex/skills/caveman/SKILL.md", "scope": "user",
             "enabled": true, "pluginId": null},
            {"name": "off", "description": "", "path": "/y/SKILL.md", "enabled": false},
        ]}]}));

        assert_eq!(rows.len(), 1, "a disabled skill is not offered");
        assert_eq!(rows[0].name, "caveman");
        assert_eq!(rows[0].path, "/Users/x/.codex/skills/caveman/SKILL.md");
    }

    /// A skill carrying no `enabled` is on, since the field is the reader's to
    /// set and most rows never carry it.
    #[test]
    fn a_skill_with_no_enabled_field_is_offered() {
        let rows = read_rows(&json!({"data": [{"skills": [
            {"name": "kept", "path": "/p/SKILL.md"}
        ]}]}));

        assert_eq!(rows.len(), 1);
    }

    /// A shape this build cannot read costs the list, never the connection.
    #[test]
    fn an_unreadable_answer_is_an_empty_picker_and_not_a_failure() {
        assert!(read_rows(&json!({"data": "not a list"})).is_empty());
        assert!(read_rows(&json!(null)).is_empty());
        assert!(read_rows(&json!({})).is_empty());
    }

    /// A skill takes the rest of the line as prose, and a bare invocation takes
    /// none — Codex accepts a `skill` item with no text beside it, verified
    /// live, so an empty remainder must come back empty rather than as a blank
    /// text item.
    #[test]
    fn the_rest_of_the_line_survives_the_command() {
        assert_eq!(without_command("/caveman make it terse"), "make it terse");
        assert_eq!(without_command("/caveman"), "");
        assert_eq!(without_command("/caveman   "), "");
        assert_eq!(
            without_command("/browser:control-in-app-browser open x"),
            "open x"
        );
    }

    /// The picker draws one line, so a description written for the model is cut
    /// at its first sentence — and one that is already a single sentence is left
    /// whole rather than losing its full stop.
    #[test]
    fn a_description_is_cut_at_its_first_sentence() {
        assert_eq!(
            first_sentence("Does a thing. Use when the user says foo. Or bar."),
            "Does a thing."
        );
        assert_eq!(first_sentence("Does a thing."), "Does a thing.");
        assert_eq!(first_sentence(""), "");
    }
}
