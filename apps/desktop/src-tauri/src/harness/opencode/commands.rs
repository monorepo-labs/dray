//! What the `/` picker offers for an OpenCode session.
//!
//! The list comes off the wire as `available_commands_update`, which OpenCode
//! sends once a session opens: its own `init` and `review` plus every command and skill
//! it found for that directory. A picked command travels as prompt text, which
//! OpenCode expands itself.
//!
//! A live session's publish is cached per directory by the read loop. A
//! directory no session has opened in yet is probed: a throwaway child opens a
//! session there, reads the list and deletes the session again, since
//! OpenCode keeps even a session that was never prompted.

use crate::harness::claude_code::commands::{first_sentence, SlashCommand};
use crate::harness::rpc::{spawn_writer, Outbound};
use crate::harness::ProbeCache;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::parser::AvailableCommand;

static CACHE: LazyLock<ProbeCache<Vec<SlashCommand>>> = LazyLock::new(|| ProbeCache::new(Duration::MAX));

/// Measured at ~4s to the list on a machine with MCP servers configured.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// What the picker draws for `cwd`, from a live session's publish or a probe.
pub async fn list_commands(cwd: &str) -> Result<Vec<SlashCommand>> {
    if let Some(hit) = CACHE.peek(cwd) {
        return Ok(hit);
    }
    remember(cwd, probe(cwd).await?);
    CACHE
        .peek(cwd)
        .context("OpenCode published no commands for this directory")
}

/// Records what a session published. An empty publish is ignored, so it never
/// replaces a good answer.
pub fn remember(cwd: &str, published: Vec<AvailableCommand>) {
    let rows: Vec<SlashCommand> = published
        .into_iter()
        .map(|command| SlashCommand {
            // A skill's description is written for the model; the picker
            // draws one line.
            description: first_sentence(&command.description),
            argument_hint: String::new(),
            aliases: Vec::new(),
            name: command.name,
        })
        .collect();
    if !rows.is_empty() {
        CACHE.insert(cwd, rows);
    }
}

/// Opens a throwaway session in `cwd`, reads its command list, and deletes it.
async fn probe(cwd: &str) -> Result<Vec<AvailableCommand>> {
    let bin = crate::binpath::opencode().await;
    let mut child = Command::new(&bin)
        .arg("acp")
        .current_dir(cwd)
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("couldn't start opencode to read its commands")?;
    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;

    let read = tokio::time::timeout(PROBE_TIMEOUT, read_commands(stdin, stdout, cwd)).await;
    super::kill_tree(&mut child).await;

    let (session, commands) = read.context("timed out reading OpenCode's commands")??;
    // Best effort: a session left behind costs one empty row in OpenCode's
    // own list, never the picker.
    let deleted = Command::new(&bin)
        .args(["session", "delete", &session])
        .current_dir(cwd)
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    if !matches!(tokio::time::timeout(PROBE_TIMEOUT, deleted).await, Ok(Ok(status)) if status.success()) {
        eprintln!("[opencode commands] couldn't delete probe session {session}");
    }
    Ok(commands)
}

/// `initialize`, then `session/new`, then the session's own command publish,
/// which lands just after the reply.
async fn read_commands(
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    cwd: &str,
) -> Result<(String, Vec<AvailableCommand>)> {
    let writer = spawn_writer(stdin);
    let send = |id: i64, method: &str, params: Value| {
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
        writer
            .send(Outbound::Line(line))
            .map_err(|_| anyhow::anyhow!("opencode's stdin closed"))
    };
    send(
        1,
        "initialize",
        json!({"protocolVersion": 1, "clientCapabilities": {},
               "clientInfo": {"name": "dray", "title": "Dray", "version": env!("CARGO_PKG_VERSION")}}),
    )?;

    let mut session: Option<String> = None;
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(error) = value.get("error") {
            bail!("opencode refused the probe: {error}");
        }
        match value.get("id").and_then(Value::as_i64) {
            Some(1) if value.get("method").is_none() => {
                send(2, "session/new", json!({"cwd": cwd, "mcpServers": []}))?;
            }
            Some(2) if value.get("method").is_none() => {
                session = value.pointer("/result/sessionId").and_then(Value::as_str).map(str::to_string);
            }
            _ => {}
        }
        let update = value.pointer("/params/update");
        if update.and_then(|u| u.get("sessionUpdate")).and_then(Value::as_str) == Some("available_commands_update") {
            let commands = update
                .and_then(|u| u.get("availableCommands"))
                .cloned()
                .and_then(|c| serde_json::from_value(c).ok())
                .unwrap_or_default();
            let session = match session {
                Some(id) => id,
                // The publish can overtake the reply; its own envelope names
                // the session too.
                None => value
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .context("a command list with no session")?
                    .to_string(),
            };
            return Ok((session, commands));
        }
    }
    bail!("opencode exited before publishing its commands")
}

// Unix alone: the stand-in agent is an `sh` script, which Windows has no `sh` for.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// The publish can land ahead of `session/new`'s reply, and then names the
    /// session in its own envelope. Fed through a real pipe, as the probe reads.
    #[tokio::test]
    async fn the_probe_reads_a_publish_that_overtakes_the_reply() {
        let script = r#"read a; printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'; read b; printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_x","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"compact","description":"Compact the session. Frees context."},{"name":"review","description":"Review changes"}]}}}' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ses_x"}}'; cat >/dev/null"#;
        let mut child = Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (stdin, stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());

        let (session, commands) = read_commands(stdin, stdout, "/tmp").await.unwrap();
        assert_eq!(session, "ses_x");
        assert_eq!(commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["compact", "review"]);
    }

    /// Against the real CLI: a list comes back and the probe session is gone
    /// from OpenCode's own list afterwards. Needs `opencode` installed.
    #[tokio::test]
    #[ignore]
    async fn the_probe_lists_commands_and_leaves_no_session() {
        let dir = std::env::temp_dir().join(format!("dray-oc-probe-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();

        let commands = list_commands(cwd).await.expect("a list");
        // OpenCode's own two, which every directory has.
        assert!(commands.iter().any(|c| c.name == "init"), "{commands:?}");

        let listed = Command::new(crate::binpath::opencode().await)
            .args(["session", "list", "--format", "json"])
            .current_dir(cwd)
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&listed.stdout);
        assert!(!text.contains(cwd), "the probe session was left behind: {text}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
