//! pi, over `pi --mode rpc`.
//!
//! One child per session, speaking LF-delimited JSON in both directions. See
//! `apps/desktop/PI-PLAN.md` for the design, the rejected alternatives and the
//! captured protocol the parser was written against.
//!
//! **`DRAY_PI_TRACE=1` echoes every line read off pi**, tagged by session. A
//! line that reaches the mapper and draws nothing is otherwise invisible: it is
//! not a parse failure, so it is not in `parse_failures.jsonl`, and it is not a
//! mapped event, so it is not in the session log. That gap cost an afternoon
//! once already.
//!
//! **pi holds `~/.pi/agent/auth.json.lock` while it runs.** It is a mkdir lock;
//! a clean exit releases it and a `SIGKILL` leaves it, and the next pi to start
//! waits a stale one out for **~30s** before answering anything. So the cost of
//! killing a pi is paid by the *next* one, which is why nothing here kills one
//! it can ask to leave — see [`shutdown`] and [`PiClient::close`].

pub mod mapper;
pub mod models;
pub mod parser;
pub mod rpc;

use crate::events::{AgentEvent, AgentEventPayload, ApprovalPolicy, TurnStatus};
use crate::harness::Harness::Pi;
use crate::models::{Effort, Model};
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::store::{self, next_seq_by_session_id};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStderr, ChildStdout, Command},
    sync::Mutex,
};

use rpc::{Incoming, PiClient, HANDSHAKE_TIMEOUT};

/// Appended to pi's own system prompt, never replacing it.
///
/// pi's own file, not Claude's shared one: Claude's names `AskUserQuestion` and
/// the Agent tool and pi has neither, which is the same reason Codex needed one
/// of its own. Applied on every spawn, resume included, because a system prompt
/// is per-process and no CLI carries one across a resume.
const APPEND_SYSTEM_PROMPT: &str = include_str!("system_prompt.md");

/// Spawns a session's `pi --mode rpc` and handshakes it.
///
/// Takes a resolved [`Model`] like the other two, except that for pi it may be
/// absent: pi is multi-provider, so Dray names no default it could be wrong
/// about. With none the flag is omitted and pi's own settings decide, which is
/// both the honest answer and the one its user already configured.
pub async fn init(
    session_id: &str,
    model: Option<&Model>,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    cwd: &str,
    session_cwd: &str,
    is_new_session: bool,
    app: &AppHandle,
) -> Result<Session> {
    // The session *file*, not the session id, is pi's resume handle. pi mints
    // its own id and reports it back — `session_id_not_adopted.jsonl` pins that
    // it does not adopt one from the filename — so the path is the one thing
    // Dray gets to choose and the one thing a resume needs.
    let session_file = store::pi_session_file(session_id).await?;

    let mut args = vec![
        "--mode".to_string(),
        "rpc".to_string(),
        "--session".to_string(),
        session_file.to_string_lossy().into_owned(),
    ];

    // Two flags, because a pi model is named by two fields: `set_model` takes
    // `provider` and `modelId` separately, and two providers can serve the same
    // model name. `Model.id` joins them for the index; `arg` is the bare half
    // the flag wants.
    if let Some(model) = model {
        args.push("--provider".into());
        args.push(model.provider.clone());
        args.push("--model".into());
        args.push(model.arg.clone());
    }

    // A flag rather than the `set_thinking_level` command next door: both are
    // real, but the flag is applied before the first turn can start, where the
    // command is a round trip after the handshake with a window in between.
    if let Some(effort) = effort {
        args.push("--thinking".into());
        args.push(effort.as_arg().to_string());
    }

    args.push("--append-system-prompt".into());
    args.push(APPEND_SYSTEM_PROMPT.to_string());

    let mut command = Command::new(crate::binpath::pi().await);

    // Which app the agent's own `dray` calls reach. Dev and release builds
    // listen on different sockets and the CLI's default names the release one.
    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    let mut child = command
        .args(args)
        .current_dir(cwd)
        .env("DRAY_SESSION_ID", session_id)
        .env("PATH", crate::harness::agent_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("couldn't start pi")?;

    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let stderr = child.stderr.take().context("failed to take stderr")?;

    let client = PiClient::new(stdin);

    let seq_start: u64 = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };
    let seq = Arc::new(AtomicU64::new(seq_start));

    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let status: Arc<Mutex<StatusTracker>> = Arc::new(Mutex::new(StatusTracker::default()));
    let queued: QueuedMessages = Arc::new(Mutex::new(Vec::new()));

    // The reader has to be running before the handshake: `get_state` is a
    // request, and nothing settles a pending request except a line off stdout.
    tokio::spawn({
        let client = client.clone();
        let session_id = session_id.to_string();
        let session_cwd = session_cwd.to_string();
        let app = app.clone();
        let events = events.clone();
        let status = status.clone();
        let queued = queued.clone();
        let seq = seq.clone();
        async move {
            if let Err(error) = read_stdout(
                stdout, client, session_id, session_cwd, events, status, queued, seq, app,
            )
            .await
            {
                eprintln!("Failed to read pi stdout: {error}");
            }
        }
    });

    tokio::spawn(async move {
        if let Err(error) = read_stderr(stderr).await {
            eprintln!("Failed to read pi stderr: {error}");
        }
    });

    // pi says **nothing at all** on spawn — no banner, no ready line — so this
    // is the only thing that proves the child is alive and speaking. On its own
    // bound, tighter than an ordinary command's: silence here is
    // indistinguishable from a slow start, and thirty seconds of a blank
    // composer reads as broken.
    if let Err(error) = client
        .request_within("get_state", Value::Null, HANDSHAKE_TIMEOUT)
        .await
    {
        // Everything above is post-spawn, so the child is running with nobody
        // left to talk to it. Killed rather than dropped: a `Child` is not
        // reaped on drop, so every failed start would leave a pi alive for the
        // life of the app.
        //
        // Asked whether it is still there first, because the two failures want
        // different cures and read identically without this: a child that
        // *exited* took its reason with it to stderr, where one still running
        // and silent is pi not answering a command this build sends.
        let died = child.try_wait().ok().flatten();
        shutdown(&mut child, &client).await;

        return Err(error).with_context(|| match died {
            Some(status) => format!("pi exited during the handshake ({status})"),
            None => "pi did not answer the handshake".to_string(),
        });
    }

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: Transport::Pi(client),
        harness: Pi,
        // The unset sentinel where pi chose for itself, which is what
        // `models.rs` documents it for.
        model: model.map(|m| m.id.clone()).unwrap_or_default(),
        effort,
        permission_mode,
        events,
        seq,
        status,
        pending_permissions: Default::default(),
        queued,
    })
}

/// Writes one prompt.
///
/// pi answers `success: true` the moment it *accepts* one, and its docs say
/// failures after acceptance arrive through the event stream rather than as a
/// second response. So awaiting this proves the prompt was taken and nothing
/// else — still worth awaiting, because a refusal then reaches the caller as an
/// error instead of as a prompt that vanished.
pub async fn send_prompt(client: &PiClient, text: &str) -> Result<()> {
    client.request("prompt", json!({"message": text})).await?;
    Ok(())
}

/// How long a pi asked to exit is given before it is killed.
///
/// Generous, because the point of asking is to let pi release
/// `~/.pi/agent/auth.json.lock` — see [`PiClient::close`] — and a kill that
/// beats the release costs the *next* spawn 30 seconds. pi exits on EOF within
/// a few hundred milliseconds, so reaching this bound means it was already
/// wedged, and a wedged pi is holding the lock either way.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Ends a pi, by EOF where it will take one and by force where it will not.
///
/// Every path that stops a pi goes through this. A `Child` is not reaped on
/// drop, so dropping one leaks the process; killing one outright leaks the
/// auth lock onto the next spawn. This is the only shape that leaks neither.
pub async fn shutdown(child: &mut Child, client: &PiClient) {
    client.close();

    if tokio::time::timeout(SHUTDOWN_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

/// Stops the running agent and drops whatever was queued behind it.
///
/// Order is load-bearing: `abort` ends the agent that is running and leaves
/// anything steered or followed up behind it to start the moment it does, so
/// aborting alone reads as Stop having changed nothing. `clear_queue` answers
/// with what it dropped and that is discarded — the composer takes prompts back
/// through its own queue, and these are pi's copies of ones already sent.
///
/// Neither is fatal on its own. A clear that fails still leaves the abort worth
/// sending, and an abort that fails is what the caller is told about.
pub async fn interrupt(client: &PiClient) -> Result<()> {
    if let Err(error) = client.request("clear_queue", Value::Null).await {
        eprintln!("[pi] could not clear the queue: {error:#}");
    }

    client.request("abort", Value::Null).await?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn read_stdout(
    stdout: ChildStdout,
    client: PiClient,
    session_id: String,
    session_cwd: String,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    status: Arc<Mutex<StatusTracker>>,
    queued: QueuedMessages,
    seq: Arc<AtomicU64>,
    app: AppHandle,
) -> Result<()> {
    let reader = BufReader::new(stdout);
    // Splits on `\n` alone, which is what pi's framing requires: `U+2028` and
    // `U+2029` are legal inside JSON strings, so a reader treating them as line
    // breaks would corrupt any record containing one.
    let mut lines = reader.lines();
    let mut mapper = mapper::Mapper::new(session_id.clone(), seq.clone());
    let transport = Transport::Pi(client.clone());

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        if std::env::var_os("DRAY_PI_TRACE").is_some() {
            // By chars, not bytes: slicing a `String` at a byte offset that
            // lands inside a multi-byte character panics, and this reads lines
            // an agent wrote.
            let head: String = line.chars().take(400).collect();
            eprintln!("[pi {session_id} <<] {head}");
        }

        let raw = match client.accept(&line).await {
            Incoming::Event(raw) => raw,
            Incoming::Response { matched: true } => continue,
            Incoming::Response { matched: false } => {
                record_failure(&session_id, "stray_response", "no caller waiting", &line).await;
                continue;
            }
            Incoming::Malformed => {
                record_failure(&session_id, "parse", "not JSON", &line).await;
                continue;
            }
        };

        let event = match parser::parse_line(&raw) {
            Ok(event) => event,
            Err(err) => {
                record_failure(&session_id, "parse", &err.to_string(), &line).await;
                continue;
            }
        };

        // Reached only through the catch-all: the line exists and this build
        // has never seen it. Filed for the reason Claude's unknown subtypes
        // are — it is a coverage gap, and the catch-all only stops it costing
        // the line.
        if matches!(event, parser::PiEvent::Unknown) {
            record_failure(&session_id, "unknown_line", "unmodelled type", &line).await;
            continue;
        }

        // Refused from here rather than ignored, exactly as Claude Code's
        // unmodelled control requests are and for the same reason: pi blocks
        // the tool call until an `extension_ui_response` carrying this id comes
        // back, and `ctx.ui.confirm` has no timeout. Silence is not neutral —
        // it stalls the session with a complete transcript on screen and
        // nothing saying why, which reads as Dray having hung.
        //
        // The answer is **no**, because there is no card to ask on yet: saying
        // yes would grant on the reader's behalf something they were never
        // shown. A refusal reaches the model as the tool's own error, which is
        // a sentence the reader can act on.
        if let parser::PiEvent::ExtensionUiRequest { id, method, title, .. } = &event {
            let asked = title.clone().unwrap_or_else(|| method.clone());
            record_failure(&session_id, "unsupported_request", &asked, &line).await;

            let _ = client.send(&json!({
                "type": "extension_ui_response",
                "id": id,
                "confirmed": false,
            }));
            continue;
        }

        let ingest = crate::session::Ingest {
            session_id: &session_id,
            harness: Pi,
            session_cwd: &session_cwd,
            events: &events,
            status: &status,
            queued: &queued,
            flush_seq: &seq,
            flush_events: &events,
            flush_transport: &transport,
        };

        for agent_event in mapper.map(event) {
            crate::session::ingest(&ingest, agent_event, &app).await;
        }
    }

    // The child is gone. `agent_settled` is the only line that closes a turn,
    // and a pi that dies mid-turn cannot send one — so without this the session
    // sits `in_progress` forever with a complete-looking transcript, every tool
    // row shimmering, and a Stop that answers success and does nothing.
    //
    // Emitted, never logged, for the reason Claude Code's drained task set is:
    // this describes a child that no longer exists, a persisted copy would be
    // replayed against a session that has already been reset to `idle` at
    // startup, and this runs after a delete may have removed the file, where an
    // append would quietly recreate it.
    if status.lock().await.turn_in_flight() {
        let closed = mapper.synthesize(AgentEventPayload::TurnCompleted {
            status: TurnStatus::Error,
            stop_reason: None,
            // The one sentence that names what happened. `Turn failed` alone is
            // the fallback for an errored turn carrying no text, and this turn
            // has a reason worth reading.
            final_text: Some("pi stopped before the turn finished".to_string()),
            // A child that went away, which no login fixes.
            auth_failed: false,
            usage: None,
            duration_ms: None,
            head: None,
        });

        if let Err(err) = app.emit("agent_event", &closed) {
            eprintln!("[pi emit err] {err}");
        }
        status.lock().await.on_event(&closed.payload);
    }

    Ok(())
}

async fn read_stderr(stderr: ChildStderr) -> Result<()> {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await? {
        if !line.trim().is_empty() {
            eprintln!("[pi stderr] {line}");
        }
    }

    Ok(())
}

/// Files a line this build could not use, with the raw line beside it.
///
/// Same file and same stages as the other two harnesses', because the question
/// it answers is the same: how well does *this build* cover the wire format.
async fn record_failure(session_id: &str, stage: &str, detail: &str, line: &str) {
    eprintln!("[pi {stage} err] {detail}\n[{stage} err] raw line: {line}");

    if let Err(err) = store::record_parse_failure(session_id, stage, detail, line).await {
        eprintln!("[pi parse-failure write err] {err}");
    }
}
