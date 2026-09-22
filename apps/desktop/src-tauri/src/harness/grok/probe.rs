//! A throwaway `grok agent stdio`, spawned to read one handshake.
//!
//! The model picker has to answer before a session exists, and grok puts
//! everything it needs on `initialize` — the whole `modelState`, ladders and
//! context windows per model, in **0.23s**. Measured, and the thing that makes
//! this cheap enough to be the ordinary path: session directories under
//! `~/.grok/sessions` were 54 before and 54 after, so an `initialize`-only spawn
//! persists **nothing**. (A `session/new` would, which is why no probe here
//! opens one.)

use crate::harness::rpc::{spawn_writer, Outbound};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::timeout,
};

/// A probe that hangs must not hold the picker open forever. Generous against
/// the 0.23s the handshake measures, because the *first* run after an install
/// pays for grok unpacking its bundled docs into `~/.grok`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// ACP protocol version grok speaks — `initialize` answers `1`.
pub const PROTOCOL_VERSION: u64 = 1;

/// The `initialize` params every grok spawn here sends, probe and session alike.
///
/// No `fs` and no `terminal`: grok reads and writes through its own tools, and
/// advertising either would invite requests this build cannot serve.
pub fn handshake_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientCapabilities": {},
        "clientInfo": {"name": "dray", "title": "Dray", "version": env!("CARGO_PKG_VERSION")},
    })
}

/// The environment every grok child takes, session and probe alike.
///
/// `GROK_DISABLE_AUTOUPDATER` is the one that has to be here rather than on the
/// session spawn alone: `--no-auto-update` is a TUI flag and `grok agent`
/// refuses it, so the variable is the only reach. A probe that stopped to
/// update itself would hold the picker for the length of a download.
pub fn child_env(command: &mut Command, bin: &std::path::Path) {
    command
        .env("GROK_DISABLE_AUTOUPDATER", "1")
        .env("PATH", crate::harness::agent_path(bin));
}

/// Spawns a throwaway agent, reads the `initialize` reply, then takes it down.
///
/// `cwd` is `Option` because the one answer read here is account-wide: the
/// model list rides the handshake and no directory moves it. Passing an empty
/// string instead is not the same thing and is why this took one — `chdir("")`
/// is `ENOENT`, so the spawn failed before grok started and `models::list` fell
/// back to the table *every* time, silently. Codex's probe already took the
/// `Option`; this one now matches it.
///
/// The timeout is *inside* here, which is the difference between a kill and a
/// hope: dropping a `Child` with `kill_on_drop` signals but reaps on the
/// runtime's own schedule, and this child is not a lone process — grok starts
/// every MCP server the reader has configured.
pub async fn initialize(cwd: Option<&str>) -> Result<Value> {
    let bin = crate::binpath::grok().await;
    let mut command = Command::new(&bin);
    child_env(&mut command, &bin);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let mut child = command
        .args(["agent", "--no-leader", "stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Belt to the kill's braces: it covers this whole future being dropped,
        // which the explicit kill below cannot, since it never runs then.
        .kill_on_drop(true)
        .spawn()
        .context("couldn't start grok to read its handshake")?;

    // Taken before the ask, so nothing it does borrows the child and the kill
    // below has one exit path to sit on.
    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;

    let answer = timeout(PROBE_TIMEOUT, one_handshake(stdin, stdout)).await;

    // However the ask went. A probe that timed out is exactly the child least
    // likely to notice its stdin has gone.
    let _ = child.kill().await;

    answer.context("timed out reading grok's handshake")?
}

/// `initialize`, and the first reply carrying its id.
///
/// Hand-rolled rather than through [`RpcClient`](crate::harness::rpc): one
/// request and one answer needs no pending map, and a probe that shares the
/// session client's correlation would have to spin a read loop to drain it.
async fn one_handshake(
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
) -> Result<Value> {
    let writer = spawn_writer(stdin);
    let line = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                      "params": handshake_params()})
    .to_string();
    writer
        .send(Outbound::Line(line))
        .map_err(|_| anyhow::anyhow!("grok's stdin closed before the handshake was written"))?;

    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // Notifications arrive before the reply on a machine with MCP servers
        // configured — grok publishes its setup phases as it goes.
        if value.get("id").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if let Some(error) = value.get("error") {
            bail!("grok refused the handshake: {error}");
        }
        return value
            .get("result")
            .cloned()
            .context("grok answered the handshake with no result");
    }

    bail!("grok exited before answering the handshake")
}
