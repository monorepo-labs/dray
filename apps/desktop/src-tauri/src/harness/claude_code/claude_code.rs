use crate::events::{AgentEvent, AgentEventPayload, ApprovalPolicy};
use crate::harness::{claude_code, Harness::ClaudeCode};
use crate::models::{Effort, Model};
use crate::session::{flush_queued, publish_status, QueuedMessages, Session, StatusTracker};
use crate::store::{self, append_session_event, next_seq_by_session_id};
use anyhow::{Context, Result};
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStderr, ChildStdin, ChildStdout, Command},
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

/// The child's `PATH`: the inherited one with the user-bin directories put
/// back.
///
/// Load-bearing rather than defensive. A bundled `.app` launched from Finder
/// inherits launchd's `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` — so a `dray`
/// installed to `~/.local/bin` is simply not there for the agent, and the
/// failure reads as "the CLI is broken" rather than "the CLI is unreachable".
/// Appended, not prepended: the user's own `PATH` should still win where the
/// two name the same binary.
fn agent_path() -> String {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<_> = std::env::split_paths(&inherited).collect();

    for dir in crate::binpath::known_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }

    std::env::join_paths(dirs)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| inherited.to_string_lossy().into_owned())
}

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
        // Infallible for a `Model`: only `claude_models()` builds one, and none
        // of those carry `Unknown`.
        model.id.as_arg().context("model has no CLI alias")?,
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
    let mut command = Command::new(crate::binpath::claude().await);

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
        .env("PATH", agent_path())
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
        if let Err(error) = read_stderr(stderr).await {
            eprintln!("Failed to read Claude stderr: {error}");
        }
    });

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin,
        harness: ClaudeCode,
        model: model.id,
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

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        let claude_event = match parser::parse_line(&line) {
            Ok(ev) => ev,
            Err(err) => {
                record_failure(session_id, "parse", &err.to_string(), &line).await;
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
            record_failure(session_id, "unsupported_request", "unanswerable", &line).await;

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
            record_failure(session_id, "unknown_subtype", "unmodeled system subtype", &line).await;
        }

        let mut agent_event = match mapper.map(claude_event) {
            Ok(Some(ev)) => ev,
            Ok(None) => continue,
            Err(err) => {
                record_failure(session_id, "map", &err.to_string(), &line).await;
                continue;
            }
        };

        // Filled here rather than in the mapper because only the session layer
        // knows the cwd. Freezing the tree id onto the closing event is what
        // stops an idle session's diff from absorbing everything that later
        // touches the same checkout. ~20ms once per turn; a background
        // subagent's writes land after this, but its report-back turn closes
        // with its own, fresher snapshot.
        if let AgentEventPayload::TurnCompleted { ref mut head, .. } = agent_event.payload {
            *head = crate::git::snapshot_tree(session_cwd).await;
        }

        // Here for the same reason: only the session layer knows which session's
        // directory the bytes belong in. Before the emit below, so the live
        // transcript and the replayed one load the same file.
        if let AgentEventPayload::ToolCallCompleted { ref mut result, .. } = agent_event.payload {
            crate::attachments::archive_result_images(session_id, &mut result.images).await;
        }

        // Read before the event is moved into the log below. These three are
        // the turn's boundaries in the sense that matters here: each is a point
        // where handing the CLI a held prompt costs nothing. A tool starting or
        // finishing means the next tool result — where the CLI injects a
        // buffered prompt — is still ahead, and a turn ending means there is no
        // result left to absorb one, so the prompt opens the next turn instead.
        //
        // A subagent's call counts here and deliberately does not in
        // `note_tool_call` below, because the two ask different questions.
        // That one asks whether a main-thread result is close enough ahead to
        // write straight through; this asks only whether handing over now is
        // safe, and it is at any point inside a turn — a prompt written early
        // waits in the CLI's own buffer for the same main-thread result it
        // would have waited here for.
        let at_boundary = matches!(
            agent_event.payload,
            AgentEventPayload::ToolCallStarted { .. }
                | AgentEventPayload::ToolCallCompleted { .. }
                | AgentEventPayload::TurnCompleted { .. }
        );

        if let Err(err) = app.emit("agent_event", &agent_event) {
            eprintln!("[claude emit err] {err}");
        }

        // One lock for both. The tool count is fed here rather than from inside
        // `on_event` because the subagent test needs the envelope: a subagent's
        // tool call runs on its own thread, and its result is not a point where
        // the CLI injects a queued prompt.
        let next_status = {
            let mut tracker = status.lock().await;
            if agent_event.subagent.is_none() {
                tracker.note_tool_call(&agent_event.payload);
            }
            tracker.on_event(&agent_event.payload)
        };
        if let Some(next) = next_status {
            publish_status(session_id, next, app).await;
        }

        // Live-view only, never retained. Deltas are superseded by the
        // committed event; a usage update is a running counter whose final
        // value lands on `turn_completed` — and `thinking_tokens` alone fires
        // dozens of times per turn, which would be most of a session's log.
        //
        // A permission request is here for a different reason: it is a question,
        // and it can only be answered by the child that asked. That child does
        // not survive a restart, so a persisted request would come back as a
        // card whose buttons cannot work. Dropping it is what makes the stale
        // card impossible rather than merely unlikely. Nothing is lost — the
        // tool call it belongs to is persisted and shows the outcome either way,
        // and a live card survives re-selection because the frontend keeps a
        // loaded session in memory rather than re-reading it.
        //
        // Questions are dropped on the same reasoning, and the "nothing is lost"
        // half holds harder there: the `AskUserQuestion` result the harness
        // writes carries both the questions and the answers, so the transcript
        // keeps the whole exchange without this line.
        if matches!(
            agent_event.payload,
            AgentEventPayload::Delta(_)
                | AgentEventPayload::UsageUpdate(_)
                // Transient by the same rule: it says a request is in flight,
                // and no request survives the process that made it. Persisting
                // it would also be most of a busy session's log — it fires once
                // per turn *and* once per tool result, 89 times in one capture.
                | AgentEventPayload::ModelRequestStarted
                | AgentEventPayload::PermissionRequested { .. }
                | AgentEventPayload::QuestionsAsked { .. }
        ) {
            continue;
        }

        // The data: URL a failed archive leaves behind must not reach the
        // retained copies: it is the whole image as base64, in a log read whole
        // on every open — the exact cost archiving exists to avoid. Stripped
        // here rather than in the archiver because the emit above must keep it:
        // the live transcript draws the picture either way, and only a reload
        // pays for the failure by showing the row without it.
        if let AgentEventPayload::ToolCallCompleted { ref mut result, .. } = agent_event.payload {
            for image in &mut result.images {
                image.url = None;
            }
        }

        events.lock().await.push(agent_event.clone());

        if let Err(err) = append_session_event(session_id, agent_event).await {
            eprintln!("[claude write err] {err}");
        }

        // After the boundary event is logged, so the prompt that follows it
        // lands behind it in the file as well as by `seq`. Cheap when the queue
        // is empty, which is nearly always.
        if at_boundary {
            flush_queued(
                session_id,
                &queued,
                &flush_seq,
                &flush_events,
                &flush_stdin,
                &status,
                app,
            )
            .await;
        }
    }

    // The child is gone and its tasks went with it. The CLI republishes the set
    // on every change but cannot announce its own death, so the last set it
    // published would stand — in the log and on screen — as work still
    // running, with a Stop that answers success and does nothing.
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
        events.lock().await.push(drained.clone());
        if let Err(err) = append_session_event(session_id, drained).await {
            eprintln!("[claude write err] {err}");
        }
    }

    Ok(())
}

/// Logs an unreadable line and files it for investigation. Failing to *record*
/// a failure is itself only logged: the read loop must survive anything.
async fn record_failure(session_id: &str, stage: &str, detail: &str, raw: &str) {
    eprintln!("[claude {stage} err] {detail}\n[{stage} err] raw line: {raw}");

    if let Err(err) = store::record_parse_failure(session_id, stage, detail, raw).await {
        eprintln!("[claude failure log err] {err}");
    }
}

/// Copies the child's stderr to this process's, for logging only.
async fn read_stderr(stderr: ChildStderr) -> Result<()> {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await? {
        eprintln!("Claude stderr: {line}");
    }

    Ok(())
}
