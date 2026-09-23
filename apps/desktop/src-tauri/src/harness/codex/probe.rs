//! A throwaway `codex app-server`, spawned to ask one question.
//!
//! Both lists that have to exist *before* a session does — the skill picker and
//! the model picker — have no child to ask, so each spawns its own and takes it
//! down. The two disagree about nothing but the method name, so the spawn, the
//! handshake, the timeout and the kill live here once.

use super::rpc::RpcClient;
use anyhow::{Context, Result};
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::timeout,
};

/// A probe that hangs must not hold the picker open forever.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Spawns a throwaway app-server, asks it one thing, then takes it down.
///
/// `cwd` is load-bearing wherever the answer is project-scoped: `skills/list`
/// resolves a project's own skills against the process's cwd, verified live, so
/// a probe spawned anywhere else answers for the wrong project. `None` inherits
/// this app's own directory, which is right for a question no project can
/// change.
///
/// The timeout is *inside* here, and that is the difference between a kill and
/// a hope. Dropping a `Child` with `kill_on_drop` sends the signal but reaps on
/// the runtime's own schedule with no guarantee, and this child is not a lone
/// process: a codex app-server starts every MCP server the reader has
/// configured, so one left standing is a small tree of them. So every exit runs
/// through `child.kill().await`, which signals *and* waits.
pub async fn ask(cwd: Option<&str>, method: &str, params: Value) -> Result<Value> {
    let bin = crate::binpath::codex().await;
    let mut command = Command::new(&bin);
    command.arg("app-server");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let mut child = command
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Belt to the kill's braces: it covers this whole future being dropped,
        // which the explicit kill below cannot, since it never runs then.
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("couldn't start codex to ask it {method}"))?;

    // Taken before the ask, so nothing it does borrows the child and the kill
    // below has one exit path to sit on.
    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;

    let answer = timeout(PROBE_TIMEOUT, one_request(stdin, stdout, method, params)).await;

    // However the ask went. A probe that timed out is exactly the child least
    // likely to notice its stdin has gone, so it is the one that most needs it.
    let _ = child.kill().await;

    answer.with_context(|| format!("timed out asking codex {method}"))?
}

/// The handshake and the one question, over a child's pipes.
async fn one_request(
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    method: &str,
    params: Value,
) -> Result<Value> {
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

    super::handshake(&client).await?;

    client.request(method, params).await
}
