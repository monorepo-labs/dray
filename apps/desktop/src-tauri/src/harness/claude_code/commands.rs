//! The slash commands a directory has available, read out of the CLI itself.
//!
//! `system/init` carries a `slash_commands` list, but it only arrives once a
//! turn is underway — so it cannot answer "what may I type" for a composer with
//! no session behind it yet, which is the case the picker exists for. The
//! `initialize` control request answers the same question before any prompt and
//! without a model call, and carries a description and an argument hint per
//! command where `init` carries bare names.
//!
//! Reading `~/.claude/commands` and the plugin cache off disk would be the other
//! route and is deliberately not taken: the CLI merges user, project, plugin and
//! skill scopes and namespaces the results (`railway:deploy`), so a local walk
//! reproduces internals that are free to change and answers differently from the
//! CLI the moment they do.

use super::control::{ControlLine, ControlRequest};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
    time::timeout,
};
use ts_rs::TS;

/// One command the user may type. `name` carries no leading slash — the picker
/// adds it — and may be namespaced by its plugin (`railway:deploy`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// What the command does with the rest of the line — `<model>`, `[name]`.
    /// Empty for most; the CLI sends `""` rather than omitting it.
    #[serde(default)]
    pub argument_hint: String,
    /// Other names that reach the same command. Absent on most.
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// The `initialize` reply, which carries far more than this — agents, models,
/// output styles, the account. Only `commands` is read: everything else here is
/// already sourced from somewhere this app trusts more (`models` from
/// [`crate::models`], the permission mode from the user's own pick), and a field
/// modeled but unused is one more shape to keep in step with the CLI.
#[derive(Debug, Deserialize)]
struct InitializeResponse {
    #[serde(default)]
    commands: Vec<SlashCommand>,
}

/// Commands the picker doesn't offer, because this app already owns what they
/// do.
///
/// `model` and `fast` are the composer's own controls. The CLI's copies work,
/// but they change the running child without telling the app, so the picker and
/// the session's real state would drift apart with nothing to reconcile them.
///
/// `clear` and `rename` reach past the CLI into state this app keeps itself —
/// session identity and the title on the index — and neither change comes back
/// on the wire, so the app would carry on describing a session that no longer
/// matches the one running.
///
/// Matched on the exact name, so a plugin's own `foo:model` is untouched.
/// Hidden rather than refused: typing one by hand still reaches the CLI. This is
/// the picker declining to suggest a footgun, not a sandbox.
const HIDDEN: [&str; 4] = ["clear", "fast", "model", "rename"];

fn supported(commands: Vec<SlashCommand>) -> Vec<SlashCommand> {
    commands
        .into_iter()
        .filter(|command| !HIDDEN.contains(&command.name.as_str()))
        .collect()
}

/// Probes are ~1.5s each, so the answer is kept for the life of the process.
/// Keyed by directory because project and local scopes make the list per-repo.
///
/// Never invalidated: a plugin installed while the app is open needs a restart
/// to show up, which is the same bargain `binpath` makes and cheaper than
/// re-probing on every keystroke.
static CACHE: OnceLock<Mutex<HashMap<String, Vec<SlashCommand>>>> = OnceLock::new();

/// A probe that hangs must not hold the picker open forever. Generous against
/// the ~1.5s measured: a cold CLI on a large repo is slower, and the cost of
/// waiting too long is one late menu where the cost of giving up too early is a
/// permanently empty one.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// The slash commands available in `cwd`, cached after the first read.
pub async fn list_commands(cwd: &str) -> Result<Vec<SlashCommand>> {
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    if let Some(hit) = cache.lock().await.get(cwd) {
        return Ok(hit.clone());
    }

    let commands = timeout(PROBE_TIMEOUT, probe(cwd))
        .await
        .context("timed out asking the CLI for its slash commands")??;

    cache
        .lock()
        .await
        .insert(cwd.to_string(), commands.clone());

    Ok(commands)
}

/// Spawns a throwaway child purely to ask it what it can do, then kills it.
///
/// The child is spawned exactly like a session's minus everything that decides
/// how a turn runs — no model, no permission mode, no session id — because none
/// of it changes the answer and every flag is one more way the probe can fail
/// where a session would not.
async fn probe(cwd: &str) -> Result<Vec<SlashCommand>> {
    let mut child = Command::new(crate::binpath::claude().await)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
        ])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // The read below can end early — a timeout, an unreadable reply — and
        // the child waits on a stdin that never closes, so dropping it has to be
        // enough to reap it.
        .kill_on_drop(true)
        .spawn()
        .context("couldn't start claude to list its commands")?;

    let mut stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;

    let request = ControlLine::new(ControlRequest::Initialize);
    stdin
        .write_all(format!("{}\n", serde_json::to_string(&request)?).as_bytes())
        .await?;
    stdin.flush().await?;

    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        let Some(response) = matching_response(&line, &request.request_id) else {
            continue;
        };

        let response: InitializeResponse = serde_json::from_value(response)
            .context("the CLI's initialize reply had an unfamiliar shape")?;
        // Filtered before the cache, so the hidden set is applied once rather
        // than at every read.
        return Ok(supported(response.commands));
    }

    // Stdout closed with no reply. The child is holding a stdin we never
    // closed, so this is the CLI declining rather than finishing.
    bail!("the CLI closed without answering the initialize request")
}

/// Picks our own reply out of the stream, returning its inner payload.
///
/// Parsed loosely rather than through [`parser::ClaudeCodeEvent`]: the probe
/// reads one reply and everything else on this stream is noise it must skip, so
/// a line it cannot classify is not a failure the way it would be in a session's
/// read loop.
///
/// [`parser::ClaudeCodeEvent`]: super::parser::ClaudeCodeEvent
fn matching_response(line: &str, request_id: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line).ok()?;

    if value.get("type")? != "control_response" {
        return None;
    }

    let response = value.get("response")?;
    if response.get("request_id")? != request_id {
        return None;
    }

    // An error subtype carries no `response` object, so this returns `None` and
    // the loop reads on until the stream ends — which reports the failure as the
    // timeout or the closed-stream bail rather than as a wrong answer.
    if response.get("subtype")? != "success" {
        return None;
    }

    response.get("response").cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reply double-wraps, like a permission decision does in the other
    /// direction: the outer `response` is the control-protocol envelope, the
    /// inner one the payload. Reading the wrong level yields no commands.
    #[test]
    fn reads_commands_out_of_the_doubly_wrapped_reply() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"req_1","response":{"commands":[{"name":"compact","description":"Free up context","argumentHint":"<instructions>"},{"name":"clear","description":"Start over","argumentHint":"[name]","aliases":["reset","new"]}],"agents":[]}}}"#;

        let payload = matching_response(line, "req_1").expect("our own reply");
        let response: InitializeResponse = serde_json::from_value(payload).unwrap();

        assert_eq!(response.commands.len(), 2);
        assert_eq!(response.commands[0].name, "compact");
        assert_eq!(response.commands[0].argument_hint, "<instructions>");
        assert!(response.commands[0].aliases.is_empty());
        assert_eq!(response.commands[1].aliases, vec!["reset", "new"]);
    }

    /// Every other line on the stream has to be skipped rather than failing the
    /// read — a hook event or a stray init would otherwise end the probe.
    #[test]
    fn skips_everything_that_is_not_our_reply() {
        for line in [
            r#"{"type":"system","subtype":"init","session_id":"s"}"#,
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"someone_else","response":{"commands":[]}}}"#,
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"req_1","error":"nope"}}"#,
            "not json at all",
            "",
        ] {
            assert!(matching_response(line, "req_1").is_none(), "{line}");
        }
    }

    /// The hidden set is exact-match, so a plugin that happens to name a
    /// command `model` keeps it — the conflict is with the CLI's own, not with
    /// the word.
    #[test]
    fn hides_only_the_commands_the_app_supersedes() {
        let commands = supported(vec![
            SlashCommand {
                name: "model".into(),
                description: "Set the AI model".into(),
                argument_hint: String::new(),
                aliases: vec![],
            },
            SlashCommand {
                name: "vendor:model".into(),
                description: "A plugin's own".into(),
                argument_hint: String::new(),
                aliases: vec![],
            },
            SlashCommand {
                name: "compact".into(),
                description: "Free up context".into(),
                argument_hint: String::new(),
                aliases: vec![],
            },
        ]);

        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["vendor:model", "compact"]);
    }

    /// `clear` is reachable as `/reset` and `/new`. Dropping the command takes
    /// its aliases with it, since the picker only ever sees this list.
    #[test]
    fn a_hidden_command_takes_its_aliases_with_it() {
        let commands = supported(vec![SlashCommand {
            name: "clear".into(),
            description: "Start a new session".into(),
            argument_hint: String::new(),
            aliases: vec!["reset".into(), "new".into()],
        }]);

        assert!(commands.is_empty());
    }

    /// A command with no arguments and no aliases is the common case, and the
    /// CLI omits `aliases` entirely for it.
    #[test]
    fn defaults_cover_the_fields_the_cli_omits() {
        let command: SlashCommand =
            serde_json::from_str(r#"{"name":"usage","description":"Show usage"}"#).unwrap();

        assert_eq!(command.argument_hint, "");
        assert!(command.aliases.is_empty());
    }
}

/// Hits the real CLI, so it's `#[ignore]`d: `cargo test -- --ignored
/// asks_the_real_cli` when changing the spawn or the reply shape above.
#[cfg(test)]
mod cli_tests {
    use super::*;

    /// The whole point of the probe is that it answers *before* a prompt, so
    /// this asserts a populated list without ever running a turn. `compact` is
    /// the check that built-ins are in there alongside the user's own skills —
    /// it is also the one command this app already knows the CLI honours over
    /// stdin.
    #[tokio::test]
    #[ignore]
    async fn asks_the_real_cli_for_its_commands() {
        let commands = list_commands(env!("CARGO_MANIFEST_DIR")).await.unwrap();

        assert!(commands.len() > 10, "got {} commands", commands.len());
        assert!(commands.iter().any(|c| c.name == "compact"));
        assert!(
            commands.iter().all(|c| !c.name.starts_with('/')),
            "names carry no leading slash; the picker adds it"
        );
    }
}
