//! The slash commands pi offers, asked of pi.
//!
//! Same shape and same reason as [`models`](super::models): the composer's `/`
//! picker has to exist before a session does, so there is no child to ask and a
//! throwaway one is spawned instead. `claude_code::commands` set the precedent.
//!
//! What pi answers is not what Claude Code answers, and that is the point of
//! this file existing at all. Before it, every harness's picker was filled from
//! Claude Code's `initialize` — so a pi session offered `/compact`, `/dataviz`
//! and 145 others, none of which pi has ever heard of, and typing one sent it
//! as a prompt.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::rpc::{Incoming, PiClient, HANDSHAKE_TIMEOUT};
use crate::harness::claude_code::commands::SlashCommand;

/// How long a cached answer stands.
///
/// Expiring, like the model list beside it and unlike Claude Code's — pi
/// discovers commands from extensions and skills the reader can install while
/// Dray is open, and "restart the app" is a poor answer to a picker that is
/// meant to follow what they have set up.
const FRESH_FOR: Duration = Duration::from_secs(120);

/// Keyed by directory: pi's commands include project-scoped ones, so a list
/// read in one checkout says nothing about another.
static CACHE: Mutex<Option<HashMap<String, (Instant, Arc<Vec<SlashCommand>>)>>> =
    Mutex::const_new(None);

/// One entry of `get_commands`.
///
/// `sourceInfo` is on the wire and deliberately unread: it names the extension
/// or file a command came from, which the picker has nowhere to put — and a
/// field modelled but unused is one more shape to keep in step with pi.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiCommand {
    name: String,
    #[serde(default)]
    description: Option<String>,
    /// `extension`, `prompt` or `skill`. Read only to keep a command whose kind
    /// pi adds later from being dropped — every value is offered.
    #[serde(default)]
    #[allow(dead_code)]
    source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CommandsData {
    #[serde(default)]
    commands: Vec<PiCommand>,
}

/// Every command pi reports for this directory, newest answer or a cached one.
///
/// Failure answers an empty list rather than an error, the same call the model
/// list makes: the picker is an accelerator for text the reader can always type
/// by hand, so it staying shut is a smaller failure than an error over the
/// composer.
pub async fn list_commands(cwd: &str) -> Vec<SlashCommand> {
    if let Some(map) = CACHE.lock().await.as_ref() {
        if let Some((at, cached)) = map.get(cwd) {
            if at.elapsed() < FRESH_FOR {
                return cached.as_ref().clone();
            }
        }
    }

    let commands = match probe(cwd).await {
        Ok(commands) => commands,
        Err(err) => {
            eprintln!("[pi commands] {err:#}");
            return Vec::new();
        }
    };

    CACHE
        .lock()
        .await
        .get_or_insert_with(HashMap::new)
        .insert(cwd.to_string(), (Instant::now(), Arc::new(commands.clone())));

    commands
}

/// Drops every cached answer, so the next read asks pi again.
pub async fn forget() {
    *CACHE.lock().await = None;
}

/// Spawns a throwaway pi in `cwd`, asks it, and asks it to leave.
///
/// The directory is load-bearing: pi discovers project-scoped commands relative
/// to where it runs, so a probe spawned anywhere else answers for the wrong
/// project.
async fn probe(cwd: &str) -> Result<Vec<SlashCommand>> {
    let mut child = Command::new(crate::binpath::pi().await)
        .args([
            "--mode",
            "rpc",
            // Mandatory, not tidiness: without it every probe writes a session
            // file into the reader's own `~/.pi/agent/sessions/`, and their
            // session list fills with empty runs Dray started.
            "--no-session",
        ])
        .current_dir(cwd)
        .env("PATH", crate::harness::agent_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("couldn't start pi to ask for its commands")?;

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
        .request_within("get_commands", Value::Null, HANDSHAKE_TIMEOUT)
        .await;

    // Asked to leave rather than killed, whichever way the read went: pi holds
    // `~/.pi/agent/auth.json.lock` while it runs and a kill leaves it, so the
    // cost lands on the next pi to start — which here is very likely the
    // session the reader is about to open.
    let answer = listed.map(|data| read_rows(&data));
    super::shutdown(&mut child, &client).await;

    answer
}

/// Folds pi's answer onto the picker's own vocabulary.
///
/// Read field-by-field out of `Value` for `map_model_usage`'s reason: a shape pi
/// extends later must cost one field, never the whole list — and an empty
/// picker looks exactly like a reader having no commands at all.
fn read_rows(data: &Value) -> Vec<SlashCommand> {
    let Ok(answer) = serde_json::from_value::<CommandsData>(data.clone()) else {
        return Vec::new();
    };

    answer
        .commands
        .into_iter()
        .map(|command| SlashCommand {
            name: command.name,
            description: command.description.unwrap_or_default(),
            // pi publishes neither. An argument hint is Claude Code's own field,
            // and pi lists no aliases — absent rather than invented, since the
            // picker draws a hint it was given and nothing where it was not.
            argument_hint: String::new(),
            aliases: Vec::new(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// pi's answer becomes the picker's rows, and a description it omits is an
    /// empty string rather than a missing command.
    #[test]
    fn commands_carry_their_names_and_whatever_description_they_have() {
        let rows = read_rows(&json!({
            "commands": [
                {"name": "compact", "description": "Compact the conversation",
                 "source": "prompt", "sourceInfo": {"path": "/x"}},
                {"name": "deploy", "source": "extension", "sourceInfo": {"path": "/y"}},
            ]
        }));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "compact");
        assert_eq!(rows[0].description, "Compact the conversation");
        assert_eq!(rows[1].name, "deploy");
        assert_eq!(rows[1].description, "");
        assert!(
            rows[0].argument_hint.is_empty(),
            "pi publishes no hint, and the picker draws nothing where it was given none"
        );
    }

    /// A shape this build cannot read costs the list, never the connection.
    ///
    /// The picker is an accelerator, so an empty one is a smaller failure than
    /// a probe that errors — but it looks exactly like a reader having no
    /// commands, which is why every field is optional rather than this being
    /// the ordinary path.
    #[test]
    fn an_unreadable_answer_is_an_empty_picker_and_not_a_failure() {
        assert!(read_rows(&json!({"commands": "not a list"})).is_empty());
        assert!(read_rows(&json!(null)).is_empty());
        assert!(
            read_rows(&json!({})).is_empty(),
            "an answer with no commands key is a pi with no commands"
        );
    }

    /// A command pi adds a new `source` kind for is still offered.
    ///
    /// The field is read to keep the row rather than to filter on it: pi's own
    /// three are `extension`, `prompt` and `skill`, and a fourth would otherwise
    /// have to be added here before a reader could see commands they installed.
    #[test]
    fn a_command_of_an_unfamiliar_kind_is_still_offered() {
        let rows = read_rows(&json!({
            "commands": [{"name": "novel", "source": "something_new"}]
        }));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "novel");
    }
}
