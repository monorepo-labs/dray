//! pi, over `pi --mode rpc`.
//!
//! One child per session, speaking LF-delimited JSON in both directions. See
//! `apps/desktop/PI-PLAN.md` for the design, the rejected alternatives and the
//! captured protocol the parser was written against.

pub mod mapper;
pub mod models;
pub mod parser;
pub mod rpc;

use crate::events::{AgentEvent, ApprovalPolicy};
use crate::harness::Harness::Pi;
use crate::models::{Effort, Model};
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::store::{self, next_seq_by_session_id};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStderr, ChildStdout, Command},
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
        let _ = child.kill().await;
        return Err(error).context("pi did not answer the handshake");
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
