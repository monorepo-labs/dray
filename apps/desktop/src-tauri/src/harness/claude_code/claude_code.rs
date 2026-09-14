use crate::events::{AgentEvent, AgentEventPayload, ApprovalPolicy};
use crate::harness::{claude_code, read_stderr, record_failure, Harness::ClaudeCode};
use crate::models::{Effort, Model};
use crate::session::{QueuedMessages, Session, StatusTracker};
use crate::store::next_seq_by_session_id;
use anyhow::{Context, Result};
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
pub mod parser;
pub use parser::ClaudeCodeEvent;
pub mod commands;
pub mod control;
pub mod mapper;
pub mod permissions;
use permissions::PendingPermissions;

/// Appended to the CLI's own system prompt, never replacing it — `--system-prompt`
/// would drop the tool docs and environment preamble the harness depends on.
/// Applied on every spawn, resume included: a system prompt is per-process and
/// the CLI does not carry one across `--resume`.
const APPEND_SYSTEM_PROMPT: &str = include_str!("system_prompt.md");

/// Tools the agent may use without being asked. Only `dray`, and only because
/// orchestration is meant to run unattended — the user approved the fan-out
/// when they asked for it, and a card per session would make three issues three
/// interruptions.
///
/// Verified against v2.1.241 rather than assumed, because a pattern that fails
/// to match fails *silently* — as an unexpected consent card, not an error.
/// Measured with `mkdir` under `--permission-mode manual`: `Bash(mkdir:*)` and
/// `Bash(mkdir *)` both ran it, `Bash(git *)` reported
/// `system`/`permission_denied`. Test it with a command that *mutates* — a
/// read-only one like `echo` is auto-allowed whatever the rule says, so it
/// reports success for a pattern that matches nothing.
const ALLOWED_TOOLS: &str = "Bash(dray:*)";

/// Takes a resolved [`Model`] rather than an id: there's no way to build one
/// outside `models`, so an unknown model can't reach the spawn and this doesn't
/// re-validate what the caller already checked.
pub async fn init(
    session_id: &str,
    model: &Model,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    cwd: &str,
    // Where the session's tree lives — differs from `cwd` on a worktree
    // creation, where the child spawns at the project root but the turn's
    // closing snapshot must describe the worktree the CLI moves into.
    session_cwd: &str,
    worktree_name: Option<&str>,
    is_new_session: bool,
    // The session to fork from, on the one spawn that carries out a fork. See
    // [`SessionIndexItem::fork_from`](crate::store::SessionIndexItem::fork_from).
    fork_from: Option<&str>,
    app: &AppHandle,
) -> Result<Session> {
    let mut args = vec![
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        &model.arg,
    ];

    // Omitted for models with no effort levels. The CLI accepts and ignores the
    // flag there, so this is about not recording an effort the session never had.
    if let Some(effort) = effort {
        args.extend(["--effort", effort.as_arg()]);
    }

    args.extend(["--permission-mode", permission_mode.as_arg()]);

    args.extend(["--append-system-prompt", APPEND_SYSTEM_PROMPT]);

    // The literal `stdio` is a special case, not a tool name: the flag otherwise
    // takes an MCP tool, and it is undocumented in `--help`. Without it the CLI
    // never asks — it auto-denies every call needing approval and reports
    // `system`/`permission_denied` — which is what made `manual` and `plan` look
    // broken rather than unasked.
    args.extend(["--permission-prompt-tool", "stdio"]);

    // Orchestration calls raise no consent card. An additive allow rule, not a
    // whitelist — everything else still routes through `can_use_tool` exactly
    // as before.
    args.extend(["--allowedTools", ALLOWED_TOOLS]);

    // Three ways in, and the fork is the only one naming two ids: it resumes the
    // parent's conversation but records it under this session's own id. Verified
    // against v2.1.246 — `--fork-session` honours `--session-id` rather than
    // minting one of its own, which is what lets the app choose the id here the
    // same way it does for a new session, and the CLI writes the fork a complete
    // standalone transcript holding the parent's history.
    if let Some(parent) = fork_from {
        args.extend([
            "--resume",
            parent,
            "--fork-session",
            "--session-id",
            session_id,
        ]);
    } else if is_new_session {
        args.extend(["--session-id", session_id]);
    } else {
        args.extend(["--resume", session_id]);
    };

    // Only on creation: the CLI resolves the tree relative to its own cwd, so
    // the child must start at the project root even though the session's
    // recorded `cwd` is the worktree it ends up in.
    if let Some(name) = worktree_name {
        args.extend(["-w", name]);
    }

    // Resolved rather than spawned by bare name: a bundled `.app` launched from
    // Finder inherits launchd's `PATH`, which holds no `claude`.
    let bin = crate::binpath::claude().await;
    let mut command = Command::new(&bin);

    // Which app the agent's own `dray` calls reach. Set because dev and release
    // builds listen on different sockets and the CLI's default names the
    // release one — without this a dev session's agent would file its work into
    // the release app's sidebar.
    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    let mut child = command
        .args(args)
        .current_dir(cwd)
        // How the CLI knows which session is calling it, which is what links a
        // spawned session to its parent and what the depth cap reads.
        .env("DRAY_SESSION_ID", session_id)
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("couldn't start claude")?;

    let stdin = Arc::new(Mutex::new(child.stdin.take().context("failed to take stdin")?));
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let stderr = child.stderr.take().context("failed to take stderr")?;

    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let stdout_events = events.clone();

    let status: Arc<Mutex<StatusTracker>> = Arc::new(Mutex::new(StatusTracker::default()));
    let stdout_status = status.clone();

    let pending_permissions = PendingPermissions::default();
    let stdout_pending = pending_permissions.clone();
    let stdout_stdin = stdin.clone();

    let seq_start: u64 = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };

    let seq = Arc::new(AtomicU64::new(seq_start));
    // Two handles on purpose: the mapper takes ownership of one to number the
    // events it builds, and the flush needs its own to number the prompts it
    // delivers through the same counter — `seq` is the ordering key, so a
    // second counter would put gaps in it.
    let stdout_seq = seq.clone();
    let flush_seq = seq.clone();

    let queued: QueuedMessages = Arc::new(Mutex::new(Vec::new()));
    let stdout_queued = queued.clone();
    let flush_events = events.clone();
    let flush_stdin = stdin.clone();

    let stdout_session_id = session_id.to_string();
    let stdout_cwd = session_cwd.to_string();

    let app = app.clone();
    tokio::spawn(async move {
        let session_id = stdout_session_id;
        if let Err(error) = read_stdout(
            stdout,
            &session_id,
            &stdout_cwd,
            stdout_events,
            stdout_seq,
            stdout_status,
            stdout_pending,
            stdout_stdin,
            stdout_queued,
            flush_seq,
            flush_events,
            flush_stdin,
            &app,
        )
        .await
        {
            eprintln!("Failed to read Claude stdout: {error}");
        }
    });

    tokio::spawn(async move {
        if let Err(error) = read_stderr(ClaudeCode, stderr).await {
            eprintln!("Failed to read Claude stderr: {error}");
        }
    });

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: crate::session::Transport::Lines(stdin),
        harness: ClaudeCode,
        model: model.id.clone(),
        effort,
        permission_mode,
        events,
        seq,
        status,
        pending_permissions,
        queued,
    })
}

/// Reads the child's stdout line by line: parses, maps, emits, and saves each
/// one. Logs and skips a bad line instead of stopping the loop.
async fn read_stdout(
    stdout: ChildStdout,
    session_id: &str,
    session_cwd: &str,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    stdout_seq: Arc<AtomicU64>,
    status: Arc<Mutex<StatusTracker>>,
    pending_permissions: PendingPermissions,
    stdin: Arc<Mutex<ChildStdin>>,
    queued: QueuedMessages,
    flush_seq: Arc<AtomicU64>,
    flush_events: Arc<Mutex<Vec<AgentEvent>>>,
    flush_stdin: Arc<Mutex<ChildStdin>>,
    app: &AppHandle,
) -> Result<()> {
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    // One mapper per session: it carries state across lines (the open message
    // id, the seq counter), so it must outlive the loop body.
    let mut mapper = claude_code::mapper::Mapper::new(stdout_seq, pending_permissions);

    // Everything past the mapper is Dray's, not Claude's, and lives in
    // `session` so a second harness cannot grow its own persistence rules.
    let ingest = crate::session::Ingest {
        session_id,
        harness: ClaudeCode,
        session_cwd,
        events: &events,
        status: &status,
        queued: &queued,
        flush_seq: &flush_seq,
        flush_events: &flush_events,
        flush_transport: &crate::session::Transport::Lines(flush_stdin.clone()),
    };

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        let claude_event = match parser::parse_line(&line) {
            Ok(ev) => ev,
            Err(err) => {
                record_failure(ClaudeCode, session_id, "parse", &err.to_string(), &line).await;
                continue;
            }
        };

        // A control request the CLI is blocked on, of a subtype this build
        // can't put to the user. Refused from here rather than left alone:
        // silence hangs the turn until the CLI's own deadline, and the read
        // loop is the only place holding both the request and the pipe back.
        if let ClaudeCodeEvent::ControlRequest {
            request_id,
            request: parser::ControlRequest::Unsupported,
        } = &claude_event
        {
            record_failure(ClaudeCode, session_id, "unsupported_request", "unanswerable", &line).await;

            let denial = permissions::auto_deny_response(
                request_id,
                "This client cannot answer that request.",
            );
            if let Err(err) = crate::session::write_line(&stdin, &denial).await {
                eprintln!("[claude auto-deny err] {err}");
            }
            continue;
        }

        // Parsed, but only by a catch-all — the line is a subtype this build
        // has never seen. Recorded alongside outright failures because it is
        // the same coverage gap; the catch-all only stops it costing the line.
        if let ClaudeCodeEvent::System(parser::SystemEvent::Unrecognized) = &claude_event {
            record_failure(ClaudeCode, session_id, "unknown_subtype", "unmodeled system subtype", &line).await;
        }

        let agent_event = match mapper.map(claude_event) {
            Ok(Some(ev)) => ev,
            Ok(None) => continue,
            Err(err) => {
                record_failure(ClaudeCode, session_id, "map", &err.to_string(), &line).await;
                continue;
            }
        };

        crate::session::ingest(&ingest, agent_event, app).await;
    }

    // The child is gone and its tasks went with it. The CLI republishes the set
    // on every change but cannot announce its own death, so the last set it
    // published would stand on screen as work still running, with a Stop that
    // answers success and does nothing.
    //
    // Emitted, never logged. The frontend reads the set off live events alone,
    // so the log needs no closing entry — and this runs after a delete has
    // removed the file, where an append would quietly recreate it.
    let stranded = !status.lock().await.background_task_ids().is_empty();
    if stranded {
        let drained = mapper.synthesize(
            session_id,
            AgentEventPayload::BackgroundTasksChanged { tasks: vec![] },
        );
        if let Err(err) = app.emit("agent_event", &drained) {
            eprintln!("[claude emit err] {err}");
        }
        status.lock().await.on_event(&drained.payload);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::APPEND_SYSTEM_PROMPT;

    /// Same undefined word Codex read as a git parent. Claude has not been seen
    /// to get it wrong, which is not the same as the prompt saying what it means.
    #[test]
    fn the_prompt_defines_a_parent_session() {
        // Prose, so match on the words rather than on where a line wraps.
        let prose = APPEND_SYSTEM_PROMPT
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(prose.contains("parent session is the Dray session that spawned this one"));
        assert!(prose.contains("never a git parent"));
        assert!(prose.contains("`parentSessionId`"));
    }

    /// "Review this with codex" names a harness, and an agent reading it as the
    /// vendor's CLI shells out to a second agent nothing in the app can see.
    #[test]
    fn the_prompt_reads_an_agent_name_as_a_harness() {
        let prose = APPEND_SYSTEM_PROMPT
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(prose.contains("`dray new --harness <name>`"));
        assert!(prose.contains("never the vendor's own CLI or app"));
    }
}
