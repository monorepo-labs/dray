//! Codex, spoken over `codex app-server`.
//!
//! One child per session, same shape as [`claude_code`](crate::harness::claude_code),
//! but the child is a JSON-RPC peer rather than a pipe. So `init` does more than
//! spawn: it completes a handshake and opens a thread before there is a session
//! to hand back, and both of those have answers we keep.
//!
//! Rejected alternatives, because they look reasonable from the outside:
//! `codex exec --json` has no approval channel at all — safety is pre-decided by
//! a sandbox flag — so permission cards, questions and the "waiting on you" rail
//! would have nothing to fire on. `codex exec-server` is a subprocess and
//! filesystem backend, not an agent interface. The ACP adapter wraps this same
//! app-server behind a Node process.

use crate::events::{AgentEvent, ApprovalPolicy};
use crate::harness::Harness::Codex;
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

pub mod mapper;
pub mod parser;
pub mod rpc;

use rpc::{Incoming, RpcClient};

/// How long the opening handshake may take before we give up on the child.
///
/// Only the spawn-and-answer calls get one. A turn runs unbounded and its
/// `turn/start` response is not the turn — it lands in milliseconds and says
/// only that the turn opened.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// What Codex is told this client is.
///
/// Named rather than left blank because app-server records it for the
/// compliance log, and an unnamed client is an unattributable one.
const CLIENT_NAME: &str = "dray";

pub async fn init(
    session_id: &str,
    model: &Model,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    cwd: &str,
    session_cwd: &str,
    is_new_session: bool,
    app: &AppHandle,
) -> Result<Session> {
    let mut command = Command::new(crate::binpath::codex().await);

    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    let mut child = command
        .arg("app-server")
        .current_dir(cwd)
        .env("DRAY_SESSION_ID", session_id)
        .env("PATH", crate::harness::agent_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("couldn't start codex")?;

    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let stderr = child.stderr.take().context("failed to take stderr")?;

    let client = RpcClient::new(stdin);

    // The reader has to be running before the handshake: `initialize` is a
    // request, and nothing settles a pending request except a line off stdout.
    // Started with no ingest so the lines arriving during the handshake are
    // routed but drawn as nothing — there is no session to draw them into yet.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let reader = ReaderHandles {
        client: client.clone(),
        session_id: session_id.to_string(),
        session_cwd: session_cwd.to_string(),
        app: app.clone(),
    };

    let seq_start = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };
    let seq = Arc::new(AtomicU64::new(seq_start));

    let events: Arc<Mutex<Vec<AgentEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let status: Arc<Mutex<StatusTracker>> = Arc::new(Mutex::new(StatusTracker::default()));
    let queued: QueuedMessages = Arc::new(Mutex::new(Vec::new()));

    tokio::spawn({
        let events = events.clone();
        let status = status.clone();
        let queued = queued.clone();
        let seq = seq.clone();
        async move {
            if let Err(error) = read_stdout(stdout, reader, ready_rx, events, status, queued, seq).await
            {
                eprintln!("Failed to read Codex stdout: {error}");
            }
        }
    });

    tokio::spawn(async move {
        if let Err(error) = read_stderr(stderr).await {
            eprintln!("Failed to read Codex stderr: {error}");
        }
    });

    handshake(&client).await?;

    let thread_id = if is_new_session {
        let thread = start_thread(&client, model, effort, permission_mode, session_cwd).await?;
        // Recorded before the first prompt, so a session whose child dies mid
        // turn can still be resumed rather than silently starting over.
        store::set_session_thread_id(session_id, &thread).await?;
        thread
    } else {
        let recorded = store::get_session_index_item(session_id)
            .await?
            .and_then(|item| item.thread_id)
            // A session created before this harness existed, or one whose
            // `thread/start` never answered. Nothing to resume by.
            .context("this session has no Codex thread to resume")?;

        resume_thread(&client, &recorded).await?;
        recorded
    };

    // The reader can start ingesting now: the thread exists, so every event
    // from here belongs to a session the frontend can draw.
    let _ = ready_tx.send(thread_id.clone());

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: Transport::Rpc {
            client,
            thread_id,
        },
        harness: Codex,
        model: model.id,
        effort,
        permission_mode,
        events,
        seq,
        status,
        pending_permissions: Default::default(),
        queued,
    })
}

/// `initialize`, then the `initialized` notification. Every other method on the
/// connection is rejected with "Not initialized" until both have been sent.
async fn handshake(client: &RpcClient) -> Result<()> {
    let params = json!({
        "clientInfo": {
            "name": CLIENT_NAME,
            "title": "Dray",
            "version": env!("CARGO_PKG_VERSION"),
        }
    });

    tokio::time::timeout(HANDSHAKE_TIMEOUT, client.request("initialize", params))
        .await
        .context("codex did not answer the handshake")??;

    client.notify("initialized", json!({}))
}

async fn start_thread(
    client: &RpcClient,
    model: &Model,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    cwd: &str,
) -> Result<String> {
    let (approval_policy, sandbox) = approval_for(permission_mode);

    let mut params = json!({
        "cwd": cwd,
        "model": model.id.as_arg().context("model has no CLI alias")?,
        "approvalPolicy": approval_policy,
        "sandbox": sandbox,
    });

    if let Some(effort) = effort {
        params["effort"] = json!(effort.as_arg());
    }

    let answer = tokio::time::timeout(HANDSHAKE_TIMEOUT, client.request("thread/start", params))
        .await
        .context("codex did not answer thread/start")??;

    thread_id_from(&answer).context("thread/start answered with no thread id")
}

async fn resume_thread(client: &RpcClient, thread_id: &str) -> Result<()> {
    tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        client.request("thread/resume", json!({"threadId": thread_id})),
    )
    .await
    .context("codex did not answer thread/resume")??;

    Ok(())
}

fn thread_id_from(answer: &Value) -> Option<String> {
    answer
        .get("thread")?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

/// Dray's stance onto Codex's two settings.
///
/// **Both values are kebab-case on the wire**, which the README gets wrong: it
/// shows `workspaceWrite`, and passing that is refused outright with `unknown
/// variant`. Verified against 0.148.0-alpha.21.
///
/// Codex splits into "when do I ask" and "what may I touch" where Claude has one
/// mode, so this is a widening rather than a rename. `Plan` is the loose fit —
/// Codex has no plan mode, so it becomes read-only-and-ask, which is what plan
/// mode is for.
fn approval_for(mode: ApprovalPolicy) -> (&'static str, &'static str) {
    match mode {
        ApprovalPolicy::Plan => ("on-request", "read-only"),
        ApprovalPolicy::Manual => ("untrusted", "workspace-write"),
        ApprovalPolicy::AcceptEdits | ApprovalPolicy::Auto => ("on-request", "workspace-write"),
        ApprovalPolicy::DontAsk => ("never", "workspace-write"),
        ApprovalPolicy::BypassPermissions => ("never", "danger-full-access"),
    }
}

/// The handles the read loop needs that are not per-event state.
struct ReaderHandles {
    client: RpcClient,
    session_id: String,
    session_cwd: String,
    app: AppHandle,
}

#[allow(clippy::too_many_arguments)]
async fn read_stdout(
    stdout: ChildStdout,
    handles: ReaderHandles,
    ready: tokio::sync::oneshot::Receiver<String>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    status: Arc<Mutex<StatusTracker>>,
    queued: QueuedMessages,
    seq: Arc<AtomicU64>,
) -> Result<()> {
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut mapper = mapper::Mapper::new(handles.session_id.clone(), seq.clone());

    // Held until the thread exists. Lines that arrive before it are routed —
    // a response still has to reach the handshake waiting on it — but mapped to
    // nothing, since there is no session for the frontend to draw them into.
    let mut ready = Some(ready);
    let mut thread_id: Option<String> = None;

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        if thread_id.is_none() {
            if let Some(rx) = &mut ready {
                if let Ok(id) = rx.try_recv() {
                    thread_id = Some(id);
                    ready = None;
                }
            }
        }

        let incoming = handles.client.accept(&line).await;

        let (method, params) = match incoming {
            Incoming::Notification { method, params } => (method, params),

            // Every server request blocks the turn until it is answered, so
            // silence is not neutral. Slice 1 runs with `approvalPolicy: never`
            // so none should arrive; one that does is refused rather than
            // ignored, which keeps the turn moving and files the gap.
            Incoming::Request { id, method, .. } => {
                record_failure(&handles.session_id, "unsupported_request", &method, &line).await;
                let _ = handles.client.respond_err(
                    id,
                    -32601,
                    "This client cannot answer that request yet.",
                );
                continue;
            }

            Incoming::Response { id, matched: false } => {
                let detail = format!("no caller waiting on id {id}");
                record_failure(&handles.session_id, "stray_response", &detail, &line).await;
                continue;
            }
            Incoming::Response { .. } => continue,

            Incoming::Malformed => {
                record_failure(&handles.session_id, "parse", "not a JSON-RPC message", &line).await;
                continue;
            }
        };

        let event = match parser::parse_notification(&method, params) {
            Ok(event) => event,
            Err(err) => {
                record_failure(&handles.session_id, "map", &err.to_string(), &line).await;
                continue;
            }
        };

        // Parsed only by the catch-all: the method exists and this build has
        // never seen it. Recorded for the same reason Claude's unknown subtypes
        // are — it is a coverage gap, and the catch-all only stops it costing
        // the line.
        if matches!(event, parser::CodexEvent::Unknown) {
            record_failure(&handles.session_id, "unknown_method", &method, &line).await;
            continue;
        }

        let Some(thread) = thread_id.as_deref() else {
            continue;
        };

        let ingest = crate::session::Ingest {
            session_id: &handles.session_id,
            harness: Codex,
            session_cwd: &handles.session_cwd,
            events: &events,
            status: &status,
            queued: &queued,
            flush_seq: &seq,
            flush_events: &events,
            flush_transport: &Transport::Rpc {
                client: handles.client.clone(),
                thread_id: thread.to_string(),
            },
        };

        for agent_event in mapper.map(event) {
            crate::session::ingest(&ingest, agent_event, &handles.app).await;
        }
    }

    Ok(())
}

async fn read_stderr(stderr: ChildStderr) -> Result<()> {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await? {
        if !line.trim().is_empty() {
            eprintln!("[codex stderr] {line}");
        }
    }

    Ok(())
}

/// Writes one prompt as a turn.
///
/// Where Claude's send is a line written and forgotten, this is a request whose
/// answer names the turn. The answer is awaited so a refusal — an unsteerable
/// turn, a thread that has gone — reaches the caller as an error instead of a
/// prompt that vanished.
pub async fn start_turn(client: &RpcClient, thread_id: &str, text: &str) -> Result<()> {
    let params = json!({
        "threadId": thread_id,
        "input": [{"type": "text", "text": text}],
    });

    client.request("turn/start", params).await?;
    Ok(())
}

/// Stops the running turn.
///
/// The server acknowledges immediately and the turn ends with its own
/// `turn/completed` carrying `interrupted`, so the reader is what reports it —
/// nothing here waits for the turn to actually stop.
pub async fn interrupt_turn(client: &RpcClient, thread_id: &str) -> Result<()> {
    client
        .request("turn/interrupt", json!({"threadId": thread_id}))
        .await?;
    Ok(())
}

/// Files a line this build could not use, with the raw line beside it.
///
/// Same file and same stages as Claude Code's, because the question it answers
/// is the same: how well does *this build* cover the wire format.
async fn record_failure(session_id: &str, stage: &str, detail: &str, line: &str) {
    eprintln!("[codex {stage} err] {detail}\n[{stage} err] raw line: {line}");

    if let Err(err) = store::record_parse_failure(session_id, stage, detail, line).await {
        eprintln!("[codex parse-failure write err] {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both values are kebab-case, and a camelCase one is refused outright —
    /// verified live, against a README that documents the opposite. Getting
    /// this wrong fails the spawn with `unknown variant`, so it is loud, but it
    /// is loud in a place nobody looks until a session will not start.
    #[test]
    fn approval_values_are_kebab_case() {
        for mode in [
            ApprovalPolicy::Plan,
            ApprovalPolicy::Manual,
            ApprovalPolicy::AcceptEdits,
            ApprovalPolicy::Auto,
            ApprovalPolicy::DontAsk,
            ApprovalPolicy::BypassPermissions,
        ] {
            let (policy, sandbox) = approval_for(mode);
            assert!(
                !policy.chars().any(char::is_uppercase),
                "{policy} must be kebab-case"
            );
            assert!(
                !sandbox.chars().any(char::is_uppercase),
                "{sandbox} must be kebab-case"
            );
        }
    }

    /// The stance the reader picked has to reach the child. `bypassPermissions`
    /// reaching the wire as anything narrower would make a session that was
    /// asked not to stop, stop.
    #[test]
    fn stance_widens_into_both_settings() {
        assert_eq!(approval_for(ApprovalPolicy::Plan), ("on-request", "read-only"));
        assert_eq!(
            approval_for(ApprovalPolicy::BypassPermissions),
            ("never", "danger-full-access")
        );
        assert_eq!(approval_for(ApprovalPolicy::DontAsk).0, "never");
    }

    /// The one field of `thread/start`'s answer everything after is keyed on.
    #[test]
    fn reads_the_thread_id() {
        let answer = json!({"thread": {"id": "01a0497b-87e6-78a3-99a2-15b783b3db75",
                                       "cwd": "/tmp", "turns": []}});
        assert_eq!(
            thread_id_from(&answer).as_deref(),
            Some("01a0497b-87e6-78a3-99a2-15b783b3db75")
        );
        assert_eq!(thread_id_from(&json!({"thread": {}})), None);
    }

    /// Replays a real capture through the parser and the mapper.
    ///
    /// The point is not the assertions below so much as the parse itself: these
    /// types are hand-written against a wire format nobody publishes a schema
    /// for, so a field that is `String` where the server sends `null` shows up
    /// here and nowhere else until a session breaks.
    fn replay(capture: &str) -> (Vec<crate::events::AgentEvent>, Vec<String>) {
        let mut mapper =
            mapper::Mapper::new("fixture-session".to_string(), Arc::new(AtomicU64::new(0)));
        let mut events = Vec::new();
        let mut unknown = Vec::new();

        for line in capture.lines().filter(|l| !l.trim().is_empty()) {
            let record: Value = serde_json::from_str(line).expect("fixture line is JSON");
            if record["dir"] != "in" {
                continue;
            }

            let message: Value = serde_json::from_str(record["line"].as_str().unwrap())
                .expect("captured line is JSON");
            // Notifications only: a request or a response carries an id, and
            // neither reaches the parser.
            let (Some(method), None) = (
                message.get("method").and_then(Value::as_str),
                message.get("id"),
            ) else {
                continue;
            };

            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let parsed = parser::parse_notification(method, params)
                .unwrap_or_else(|e| panic!("{method} failed to parse: {e}"));

            if matches!(parsed, parser::CodexEvent::Unknown) {
                unknown.push(method.to_string());
            }
            events.extend(mapper.map(parsed));
        }

        (events, unknown)
    }

    /// Every line in every capture is either acted on or deliberately ignored.
    ///
    /// A method landing in `Unknown` is a gap in this build, and the failure log
    /// only stays a signal while it holds real ones. Add the method to the
    /// ignore list in `parser` with a reason, or map it.
    #[test]
    fn every_captured_method_is_accounted_for() {
        for (name, capture) in FIXTURES {
            let (_, unknown) = replay(capture);
            assert!(
                unknown.is_empty(),
                "{name} carries unhandled methods: {unknown:?}"
            );
        }
    }

    /// The smallest complete turn has to produce a turn that opens, text that
    /// commits, and a turn that closes. If the shapes drifted, this is where a
    /// transcript that draws nothing shows up as a test failure.
    #[test]
    fn simple_turn_draws_a_whole_exchange() {
        let (events, _) = replay(SIMPLE_TURN);
        let payloads: Vec<_> = events.iter().map(|e| &e.payload).collect();

        assert!(
            payloads
                .iter()
                .any(|p| matches!(p, crate::events::AgentEventPayload::TurnStarted(_))),
            "no turn opened"
        );
        assert!(
            payloads.iter().any(|p| matches!(
                p,
                crate::events::AgentEventPayload::AssistantText { text, .. } if text == "ok"
            )),
            "the reply never committed"
        );
        assert!(
            payloads
                .iter()
                .any(|p| matches!(p, crate::events::AgentEventPayload::TurnCompleted { .. })),
            "no turn closed"
        );
    }

    /// The capture that settles which token figure is the occupancy. A
    /// three-call turn is the only place `last` and `total` disagree, and
    /// reading `total` would report 47083 of a 258400 window against a real
    /// 15785.
    #[test]
    fn multi_call_turn_reports_the_last_reading() {
        let (events, _) = replay(MULTI_CALL_TURN);

        let closing = events
            .iter()
            .rev()
            .find_map(|e| match &e.payload {
                crate::events::AgentEventPayload::TurnCompleted { usage, .. } => usage.as_ref(),
                _ => None,
            })
            .expect("the turn closed with usage");

        let window = closing
            .context_window
            .as_ref()
            .expect("an occupancy reading");
        assert_eq!(window.used_tokens, 15785);
        assert_eq!(window.max_tokens, 258400);
    }

    /// Codex echoes our prompt back as an item. Drawing it as well as Dray's
    /// own would show every prompt twice, and the echo only exists in a real
    /// capture — no hand-written test would have caught it.
    #[test]
    fn no_capture_mints_a_user_message() {
        for (name, capture) in FIXTURES {
            let (events, _) = replay(capture);
            assert!(
                !events.iter().any(|e| matches!(
                    e.payload,
                    crate::events::AgentEventPayload::UserMessage { .. }
                )),
                "{name} echoed a prompt back into the transcript"
            );
        }
    }

    const SIMPLE_TURN: &str = include_str!("fixtures/simple_turn.jsonl");
    const MULTI_CALL_TURN: &str = include_str!("fixtures/multi_call_turn.jsonl");
    const COMMAND_APPROVAL: &str = include_str!("fixtures/command_approval.jsonl");

    const FIXTURES: &[(&str, &str)] = &[
        ("simple_turn", SIMPLE_TURN),
        ("multi_call_turn", MULTI_CALL_TURN),
        ("command_approval", COMMAND_APPROVAL),
    ];

    /// Drives a real `codex app-server` through this module's own client.
    ///
    /// Ignored because it needs Codex installed and logged in, and it is the
    /// only test here that talks to anything. It costs no model call — the
    /// handshake and `thread/start` are both local — so run it after touching
    /// `rpc` or the handshake, with `--ignored`.
    ///
    /// The fixtures cover the shapes; this covers the conversation, which a
    /// recording cannot: whether our request ids come back, whether the
    /// `initialized` notification is accepted, and whether the values we send
    /// for `sandbox` and `approvalPolicy` are ones this build of Codex takes.
    /// That last one is why this exists — a rejected value fails the spawn and
    /// nothing else, so the first sign of it is a session that will not start.
    #[tokio::test]
    #[ignore = "needs codex installed and logged in"]
    async fn handshake_against_a_live_server() {
        let mut child = Command::new(crate::binpath::codex().await)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("codex should start");

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
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

        handshake(&client).await.expect("handshake should succeed");

        let model = crate::models::find_model(crate::models::default_model_for(Codex))
            .expect("the default Codex model should be listed");

        let thread = start_thread(
            &client,
            &model,
            None,
            ApprovalPolicy::Auto,
            std::env::temp_dir().to_str().unwrap(),
        )
        .await
        .expect("thread/start should succeed");

        assert!(!thread.is_empty(), "a thread id came back");
        println!("live thread: {thread}");

        let _ = child.kill().await;
    }
}
