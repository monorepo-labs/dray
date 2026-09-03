//! The slash commands Codex offers, which are its skills and nothing else.
//!
//! Codex's own `/` menu mixes two unlike things. Most rows — `/model`,
//! `/approvals`, `/new`, `/diff` — are TUI actions that never reach the server,
//! and Dray already owns every one of them in its own chrome, so listing them
//! would draw controls that do nothing. What is left is **skills**, and those
//! are real: `skills/list` answers them and `turn/start` takes one as an input
//! item of its own.
//!
//! That last part is why this file has a companion in [`super::turn_input`] —
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

    let skills = match probe(cwd).await {
        Ok(skills) => skills,
        Err(err) => {
            eprintln!("[codex commands] {err:#}");
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
/// `None` is an *answered* lookup that matched nothing, which is ordinary: prose
/// opening with a slash, or a skill that has since been removed. Both are right
/// to travel as text.
///
/// A lookup that could not be made is an error and not `None`, and the
/// difference is the whole bug this reintroduces if collapsed. A timed-out
/// `skills/list` would otherwise send a row the reader picked out of the picker
/// as four literal words — which is exactly the failure this file exists to fix,
/// and it reports as an ordinary turn.
///
/// The error is worth having because it is a **no-op**, not because it is
/// retryable: `deliver_prompt` calls this before it records anything, so a
/// failure here leaves no event, no log line and no turn. The composer does
/// clear the draft on send and does not put it back — true of every failed send,
/// not just this one — so the reader retypes. That is a worse cure than it
/// sounds and a better one than a session that answered the wrong prompt.
pub async fn skill_item(client: &RpcClient, text: &str) -> Result<Option<Value>> {
    let Some(name) = text.strip_prefix('/').and_then(|rest| rest.split_whitespace().next()) else {
        return Ok(None);
    };

    let answer = client
        .request("skills/list", json!({}))
        .await
        .context("couldn't ask codex which skills it has")?;

    Ok(read_rows(&answer)
        .into_iter()
        .find(|skill| skill.name == name)
        .map(|skill| json!({"type": "skill", "name": skill.name, "path": skill.path})))
}

/// What is left of `text` once its leading `/name` is taken off.
pub fn without_command(text: &str) -> &str {
    let rest = text.trim_start_matches('/');
    match rest.find(char::is_whitespace) {
        Some(at) => rest[at..].trim(),
        None => "",
    }
}

/// Spawns a throwaway app-server in `cwd` purely to ask it, then takes it down.
///
/// The directory is load-bearing: `skills/list` resolves project-scoped skills
/// against the process's own cwd, verified live — a probe spawned anywhere else
/// answers for the wrong project.
///
/// The timeout is *inside* here, and that is the difference between a kill and
/// a hope. Dropping a `Child` with `kill_on_drop` sends the signal but reaps on
/// the runtime's own schedule with no guarantee, and this child is not a lone
/// process: a codex app-server starts every MCP server the reader has
/// configured, so one left standing is a small tree of them. So every exit runs
/// through `child.kill().await`, which signals *and* waits.
async fn probe(cwd: &str) -> Result<Vec<Skill>> {
    let bin = crate::binpath::codex().await;
    let mut child = Command::new(&bin)
        .arg("app-server")
        .current_dir(cwd)
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Belt to the kill's braces: it covers this whole future being dropped,
        // which the explicit kill below cannot, since it never runs then.
        .kill_on_drop(true)
        .spawn()
        .context("couldn't start codex to ask for its skills")?;

    // Taken before the ask, so nothing it does borrows the child and the kill
    // below has one exit path to sit on.
    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;

    let answer = timeout(PROBE_TIMEOUT, ask(stdin, stdout)).await;

    // However the ask went. A probe that timed out is exactly the child least
    // likely to notice its stdin has gone, so it is the one that most needs it.
    let _ = child.kill().await;

    answer.context("timed out asking codex for its skills")?
}

/// The handshake and the one question, over a child's pipes.
async fn ask(stdin: tokio::process::ChildStdin, stdout: tokio::process::ChildStdout) -> Result<Vec<Skill>> {
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
