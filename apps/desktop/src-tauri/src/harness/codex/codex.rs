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

use crate::events::{AgentEvent, AgentEventPayload, ApprovalPolicy};
use crate::harness::Harness::Codex;
use crate::models::{Effort, Model};
use crate::harness::claude_code::permissions::PendingPermissions;
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::store::{self, next_seq_by_session_id};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStderr, ChildStdout, Command},
    sync::Mutex,
};

pub mod mapper;
pub mod parser;
pub mod permissions;
pub mod rpc;

use permissions::ApprovalKind;
use rpc::{Incoming, RpcClient};

/// What Codex is told this client is.
///
/// Named rather than left blank because app-server records it for the
/// compliance log, and an unnamed client is an unattributable one.
const CLIENT_NAME: &str = "dray";

/// Dray's own rules, appended to Codex's prompt the way `--append-system-prompt`
/// appends them to Claude's. `developerInstructions`, not `baseInstructions`:
/// the second *replaces* the built-in prompt, tool docs and all. Sent on
/// resume as well as start — the rollout does not carry it. Verified live:
/// a codeword placed here comes back when asked for.
const DEVELOPER_INSTRUCTIONS: &str = include_str!("developer_instructions.md");

/// The conversation every write is addressed to, and what each write restates.
///
/// Cloneable, and the read loop holds a clone: both halves have to agree about
/// which turn is running, and the reader is what sees a turn the server opened
/// for itself.
#[derive(Clone, Debug)]
pub struct Thread {
    pub client: RpcClient,
    /// Minted by the server, not chosen by us — the one id in this app that
    /// arrives rather than being handed out.
    pub id: String,
    /// Restated on every `turn/start` rather than settled once at
    /// `thread/start`, because neither of the two thread-level calls can carry
    /// all of it. `ThreadStartParams` has no `effort` field at all — it is
    /// accepted and silently dropped, verified against 0.148.0-alpha.21 — and a
    /// resumed thread otherwise runs on whatever its rollout recorded, so a
    /// session whose model or stance changed would go on running the old one
    /// while the index reported the new. `turn/start` overrides "this turn and
    /// subsequent turns", which is the one place that covers both.
    ///
    /// Fixed for the life of the child: every one of these respawns it.
    pub settings: TurnSettings,
    /// The turn now running, or `None` between turns.
    ///
    /// `turn/interrupt` takes a turn id *as well as* a thread id — a request
    /// carrying only the thread is refused outright with `missing field
    /// turnId`, verified live — so without this Stop reaches the server as an
    /// error and the turn keeps going.
    pub turn_id: Arc<Mutex<Option<String>>>,
}

/// What a turn is started with. Every field is an override that also applies to
/// the turns after it, which is why a resume needs no separate copy of them.
#[derive(Clone, Debug)]
pub struct TurnSettings {
    pub model: String,
    pub effort: Option<&'static str>,
    pub approval_policy: &'static str,
    pub sandbox: &'static str,
}

impl TurnSettings {
    fn new(model: &Model, effort: Option<Effort>, permission_mode: ApprovalPolicy) -> Result<Self> {
        let (approval_policy, sandbox) = approval_for(permission_mode);

        Ok(Self {
            model: model
                .id
                .as_arg()
                .context("model has no CLI alias")?
                .to_string(),
            effort: effort.map(Effort::as_arg),
            approval_policy,
            sandbox,
        })
    }
}

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
    // Both ahead of the spawn, and for one reason: everything between the spawn
    // and the kill-wrapped `open_thread` below has to be infallible, or a `?`
    // returns leaving a child nothing can reach. A model with no alias and an
    // unreadable log are both refusals that owe the caller no process.
    let settings = TurnSettings::new(model, effort, permission_mode)?;
    let seq_start = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };

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
    let pending: PendingPermissions = Default::default();

    let reader = ReaderHandles {
        client: client.clone(),
        session_id: session_id.to_string(),
        session_cwd: session_cwd.to_string(),
        pending: pending.clone(),
        app: app.clone(),
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

    let thread_id = match open_thread(
        &client,
        session_id,
        &settings,
        session_cwd,
        is_new_session,
    )
    .await
    {
        Ok(thread_id) => thread_id,
        Err(error) => {
            // Everything above is post-spawn, so the child is running and about
            // to be dropped with nobody left to talk to it. Killed rather than
            // dropped: a `Child` is not reaped on drop, so every failed start
            // would leave an app-server alive for the life of the app — and a
            // handshake that timed out is exactly the child least likely to
            // notice its stdin has gone.
            let _ = child.kill().await;
            return Err(error);
        }
    };

    let thread = Thread {
        client,
        id: thread_id,
        settings,
        turn_id: Arc::new(Mutex::new(None)),
    };

    // The reader can start ingesting now: the thread exists, so every event
    // from here belongs to a session the frontend can draw. It gets a clone
    // rather than a copy of the id, so the turn it sees open is the turn Stop
    // interrupts.
    let _ = ready_tx.send(thread.clone());

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: Transport::Rpc(thread),
        harness: Codex,
        model: model.id,
        effort,
        permission_mode,
        events,
        seq,
        status,
        pending_permissions: pending,
        queued,
    })
}

/// Handshakes and opens the thread this session will run on.
///
/// Split out from `init` for one reason: everything in it happens after the
/// spawn, so its caller has a child to kill on the way out.
async fn open_thread(
    client: &RpcClient,
    session_id: &str,
    settings: &TurnSettings,
    session_cwd: &str,
    is_new_session: bool,
) -> Result<String> {
    handshake(client).await?;

    if is_new_session {
        let thread = start_thread(client, settings, session_cwd).await?;
        // Recorded before the first prompt, so a session whose child dies mid
        // turn can still be resumed rather than silently starting over.
        store::set_session_thread_id(session_id, &thread).await?;
        return Ok(thread);
    }

    let recorded = store::get_session_index_item(session_id)
        .await?
        .and_then(|item| item.thread_id)
        // A session created before this harness existed, or one whose
        // `thread/start` never answered. Nothing to resume by.
        .context("this session has no Codex thread to resume")?;

    resume_thread(client, &recorded, settings).await?;
    Ok(recorded)
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

    client.request("initialize", params).await?;

    client.notify("initialized", json!({}))
}

/// Opens a fresh thread. No `effort` here — `ThreadStartParams` has no such
/// field, and one sent anyway is accepted and dropped, so it rides every
/// `turn/start` instead.
async fn start_thread(client: &RpcClient, settings: &TurnSettings, cwd: &str) -> Result<String> {
    let params = json!({
        "cwd": cwd,
        "model": settings.model,
        "approvalPolicy": settings.approval_policy,
        "sandbox": settings.sandbox,
        "developerInstructions": DEVELOPER_INSTRUCTIONS,
    });

    let answer = client.request("thread/start", params).await?;

    thread_id_from(&answer).context("thread/start answered with no thread id")
}

/// Picks a thread back up, restating what it should run as.
///
/// The overrides are not decoration: a resume with the thread id alone runs on
/// whatever the rollout recorded, so a session whose model or stance changed
/// between runs — which is every effort or model change, since those respawn
/// the child — would go on running the old one while the index reported the
/// new. Silent, because nothing on the wire disagrees.
async fn resume_thread(
    client: &RpcClient,
    thread_id: &str,
    settings: &TurnSettings,
) -> Result<()> {
    client
        .request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "model": settings.model,
                "approvalPolicy": settings.approval_policy,
                "sandbox": settings.sandbox,
                "developerInstructions": DEVELOPER_INSTRUCTIONS,
            }),
        )
        .await?;

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
/// mode, so this is a widening rather than a rename. Codex's own UI presents
/// three combinations, and Dray's stances land on them:
///
/// - **Ask for approval** — `Manual`. Every command asks.
/// - **Approve for me** — `Auto`. Runs inside the sandbox, asks to leave it.
/// - **Full access** — `BypassPermissions`. No sandbox, no asking.
///
/// `DontAsk` has no Codex label of its own: it is "approve for me" with the
/// asking turned off, still bounded by the same sandbox. `Plan` is the loose
/// fit — Codex has no plan mode, so it becomes read-only-and-ask, which is what
/// plan mode is for — and the composer hides it for Codex rather than offering
/// a stance Codex does not name. It is kept here because a spawned session
/// inherits its parent's stance, so one can still arrive.
fn approval_for(mode: ApprovalPolicy) -> (&'static str, &'static str) {
    match mode {
        ApprovalPolicy::Plan => ("on-request", "read-only"),
        ApprovalPolicy::Manual => ("untrusted", "workspace-write"),
        ApprovalPolicy::Auto => ("on-request", "workspace-write"),
        ApprovalPolicy::DontAsk => ("never", "workspace-write"),
        ApprovalPolicy::BypassPermissions => ("never", "danger-full-access"),
    }
}

/// The handles the read loop needs that are not per-event state.
struct ReaderHandles {
    client: RpcClient,
    session_id: String,
    session_cwd: String,
    /// Shared with the session, which is what answers the cards this raises.
    pending: PendingPermissions,
    app: AppHandle,
}

#[allow(clippy::too_many_arguments)]
async fn read_stdout(
    stdout: ChildStdout,
    handles: ReaderHandles,
    ready: tokio::sync::oneshot::Receiver<Thread>,
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
    let mut transport: Option<Transport> = None;

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        if transport.is_none() {
            if let Some(rx) = &mut ready {
                match rx.try_recv() {
                    Ok(thread) => {
                        transport = Some(Transport::Rpc(thread));
                        ready = None;
                    }
                    // The sender was dropped, so the thread never opened. Stop
                    // checking rather than polling a dead channel every line.
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => ready = None,
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                }
            }
        }

        let incoming = handles.client.accept(&line).await;

        let (method, params) = match incoming {
            Incoming::Notification { method, params } => (method, params),

            // Every server request blocks the turn until it is answered, so
            // silence is not neutral: it stalls the session until Codex's own
            // deadline, exactly as an unanswered `can_use_tool` does.
            Incoming::Request { id, method, params } => {
                let kind = match method.as_str() {
                    "item/commandExecution/requestApproval" => Some(ApprovalKind::Command),
                    "item/fileChange/requestApproval" => Some(ApprovalKind::FileChange),
                    _ => None,
                };

                match kind {
                    Some(kind) => {
                        // The card is the answer, and the reply goes out when
                        // the user presses a button — so nothing is written
                        // here. An entry left in the map with no card raised is
                        // the one way this hangs, which is why a request that
                        // cannot be read is declined below rather than dropped.
                        if let Err(err) =
                            raise_permission(&handles, &mut mapper, id, kind, params).await
                        {
                            record_failure(
                                &handles.session_id,
                                "unsupported_request",
                                &err.to_string(),
                                &line,
                            )
                            .await;
                            let _ = handles.client.respond(id, json!({"decision": "decline"}));
                        }
                    }
                    None => {
                        record_failure(&handles.session_id, "unsupported_request", &method, &line)
                            .await;

                        // Not an approval, so there is nothing to put to the
                        // user and nothing honest to answer. A protocol error
                        // leaves the server to decide what to do about a
                        // request this build cannot serve, which is better than
                        // a made-up success.
                        let _ = handles.client.respond_err(
                            id,
                            -32601,
                            "This client cannot answer that request yet.",
                        );
                    }
                }
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

        // Built once the thread exists, then reused: it holds a clone of the
        // client and the thread id, and rebuilding it per line would clone both
        // for every delta.
        let Some(transport) = transport.as_ref() else {
            continue;
        };

        // Whatever the turn is, Stop has to be able to name it. The server
        // opens turns of its own — a review it starts, a compaction — so the
        // send path cannot be the only thing that records one, and a turn id
        // left standing after its turn ended would have Stop interrupting
        // something already over.
        if let Transport::Rpc(thread) = transport {
            match &event {
                parser::CodexEvent::TurnStarted(turn) => {
                    *thread.turn_id.lock().await = Some(turn.turn.id.clone());
                }
                parser::CodexEvent::TurnCompleted(_) => {
                    *thread.turn_id.lock().await = None;
                }
                _ => {}
            }
        }

        let ingest = crate::session::Ingest {
            session_id: &handles.session_id,
            harness: Codex,
            session_cwd: &handles.session_cwd,
            events: &events,
            status: &status,
            queued: &queued,
            flush_seq: &seq,
            flush_events: &events,
            flush_transport: transport,
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
pub async fn start_turn(thread: &Thread, text: &str) -> Result<()> {
    let mut params = json!({
        "threadId": thread.id,
        "input": [{"type": "text", "text": text}],
        "model": thread.settings.model,
        "approvalPolicy": thread.settings.approval_policy,
    });

    // Absent means "whatever the model defaults to", which is not the same as
    // any level, so it is left out rather than sent as null.
    if let Some(effort) = thread.settings.effort {
        params["effort"] = json!(effort);
    }

    let answer = thread.client.request("turn/start", params).await?;

    // Recorded here rather than left to `turn/started`: the notification lands
    // a beat later, and a Stop pressed inside that window would find no turn to
    // name. The reader writes the same id over it moments later.
    if let Some(id) = answer
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
    {
        *thread.turn_id.lock().await = Some(id.to_string());
    }

    Ok(())
}

/// Stops the running turn.
///
/// The server acknowledges immediately and the turn ends with its own
/// `turn/completed` carrying `interrupted`, so the reader is what reports it —
/// nothing here waits for the turn to actually stop.
///
/// Names the turn, not just the thread: a request carrying the thread alone is
/// refused outright with `missing field turnId`, so Stop reached the server as
/// an error and the turn ran on. With nothing running there is nothing to name,
/// and that answers success — Stop is pressed on a row whose turn may have just
/// ended, and an error there would report a failure that isn't one.
pub async fn interrupt_turn(thread: &Thread) -> Result<()> {
    let Some(turn_id) = thread.turn_id.lock().await.clone() else {
        return Ok(());
    };

    thread
        .client
        .request(
            "turn/interrupt",
            json!({"threadId": thread.id, "turnId": turn_id}),
        )
        .await?;
    Ok(())
}

/// Turns one approval request into the card that answers it.
///
/// Registered before it is emitted, so a button pressed the instant the card
/// draws finds the entry waiting. The reply is not written here: it goes out
/// from [`Session::respond_permission`](crate::session::Session::respond_permission)
/// when the user picks, and until then Codex is blocked — the same bargain
/// `can_use_tool` makes.
async fn raise_permission(
    handles: &ReaderHandles,
    mapper: &mut mapper::Mapper,
    rpc_id: i64,
    kind: ApprovalKind,
    params: Value,
) -> Result<()> {
    let request: parser::ApprovalRequest = serde_json::from_value(params)?;
    let (pending, options) = permissions::pending_for(&request, kind, rpc_id);

    // The id the frontend answers with. Codex's is a number and Dray's whole
    // permission vocabulary is keyed by string, so it is spelled once here.
    let request_id = rpc_id.to_string();

    handles
        .pending
        .lock()
        .expect("pending permissions mutex poisoned")
        .insert(request_id.clone(), pending);

    let event = mapper.synthesize(AgentEventPayload::PermissionRequested {
        request_id,
        tool_use_id: request.item_id.clone(),
        tool_name: kind.tool_name().to_string(),
        display_name: Some(kind.display_name().to_string()),
        title: request.command.clone(),
        description: request.reason.clone(),
        // Carried on the card itself rather than left to the tool row: the row
        // may be collapsed inside a finished group, and a card asking about
        // something invisible is a card nobody can answer.
        //
        // Field names are the card's, not Codex's: it reads `command` and
        // `path` off raw input whatever tool carried them. A file-change
        // request names no file — only the root it wants — and that root is the
        // subject of the question, so it goes in the slot the card will draw.
        input: json!({
            "command": request.command,
            "cwd": request.cwd,
            "path": request.grant_root,
        }),
        blocked_path: request.grant_root.clone(),
        decision_reason: request.reason.clone(),
        decision_reason_type: None,
        // Codex names no subagent on an approval, and it has none to name yet.
        agent_id: None,
        options,
    });

    // Emitted, never logged — the request can only be answered by the child
    // that asked, and no child survives a restart, so a persisted card would
    // come back with buttons that cannot work.
    handles.app.emit("agent_event", &event)?;

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
            ApprovalPolicy::Auto,
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

    /// The Claude prompt names tools Codex does not have. A copy that still
    /// names them tells the model to reach for something that is not there,
    /// and the skill path it names is Codex's own.
    #[test]
    fn the_developer_instructions_name_nothing_codex_lacks() {
        assert!(!DEVELOPER_INSTRUCTIONS.contains("AskUserQuestion"));
        assert!(!DEVELOPER_INSTRUCTIONS.contains("Agent tool"));
        assert!(DEVELOPER_INSTRUCTIONS.contains("~/.codex/skills/dray"));
        assert!(DEVELOPER_INSTRUCTIONS.contains("dray issue link"));
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

    /// The captured approval, built into a card and answered, end to end.
    ///
    /// The capture is the point: this request offered `accept`, an execpolicy
    /// amendment and `cancel` — and no `decline` — so a card built only from
    /// what the server named would have had nothing to refuse with. The reply
    /// shape is pinned here too, since a wrongly shaped one is ignored in
    /// silence and shows up as a turn that never resumes.
    #[test]
    fn the_captured_approval_becomes_a_card_and_an_answer() {
        let request = captured_approval();
        let (pending, options) = permissions::pending_for(&request, ApprovalKind::Command, 0);

        assert!(
            options
                .iter()
                .any(|o| o.behavior == crate::events::PermissionBehavior::Allow),
            "nothing on the card would let the command run"
        );
        let deny = options
            .iter()
            .find(|o| o.behavior == crate::events::PermissionBehavior::Deny)
            .expect("a card with no refusal cannot be answered honestly");

        // What the button sends, in the envelope `respond` puts around it.
        let decision = pending.options[&deny.id].decision.clone().unwrap();
        assert_eq!(json!({"decision": decision}), json!({"decision": "cancel"}));

        // And the allow carries the server's own word back, not ours.
        let allow = options
            .iter()
            .find(|o| o.kind == crate::events::PermissionOptionKind::Once)
            .unwrap();
        assert_eq!(
            pending.options[&allow.id].decision.as_ref().unwrap(),
            &json!("accept")
        );
    }

    /// Pulls the one real `requestApproval` out of the capture. A request is not
    /// a notification, so `replay` skips it and this reads it directly.
    fn captured_approval() -> parser::ApprovalRequest {
        for line in COMMAND_APPROVAL.lines().filter(|l| !l.trim().is_empty()) {
            let record: Value = serde_json::from_str(line).unwrap();
            if record["dir"] != "in" {
                continue;
            }
            let message: Value = serde_json::from_str(record["line"].as_str().unwrap()).unwrap();
            if message.get("method").and_then(Value::as_str)
                == Some("item/commandExecution/requestApproval")
            {
                return serde_json::from_value(message["params"].clone())
                    .expect("the captured approval parses");
            }
        }
        panic!("the capture holds no approval request");
    }

    /// The smallest complete turn has to produce a turn that opens, text that
    /// commits, and a turn that closes. If the shapes drifted, this is where a
    /// transcript that draws nothing shows up as a test failure.
    /// Every tool Codex ran in the capture reaches the transcript as a row.
    ///
    /// The regression this pins is a silent one. An item kind we have not typed
    /// lands in `ThreadItem::Other` and maps to nothing — no parse failure, no
    /// row, nothing to notice it by. A real session made 62 tool calls and Dray
    /// drew 34, and the only way that surfaced was reading Codex's own rollout
    /// beside our log. So the assert is on the *set* of tools drawn, and a kind
    /// dropping out of it fails here rather than going quiet in a transcript.
    #[test]
    fn every_captured_tool_kind_draws_a_row() {
        let (events, _) = replay(TOOL_KINDS);

        let drawn: std::collections::HashSet<&str> = events
            .iter()
            .filter_map(|e| match &e.payload {
                crate::events::AgentEventPayload::ToolCallStarted { name, .. } => {
                    Some(name.as_str())
                }
                _ => None,
            })
            .collect();

        for want in ["shell", "web_search", "view_image", "spawn_agent"] {
            assert!(drawn.contains(want), "{want} drew no row; drew {drawn:?}");
        }

        // `wait` is the exception, and it is *deliberately* nothing: the model
        // blocking on a run whose row and panel entry are already on screen.
        // It carries no prompt and names no receiver, so the row read `wait
        // wait` — the same word twice, about work drawn directly above it.
        assert!(
            !drawn.contains("wait"),
            "the wait call drew a row of its own"
        );
        // The MCP row is named for the tool the server offered, not for a
        // fixed string, so it is checked by its type rather than its name.
        assert!(
            events.iter().any(|e| matches!(
                &e.payload,
                crate::events::AgentEventPayload::ToolCallStarted { tool_type, .. }
                    if *tool_type == crate::events::ToolType::Mcp
            )),
            "the MCP call drew no row"
        );

        // An image the model looked at is the whole answer, so the completed
        // row has to carry it — a "read a file" row with nothing in it is what
        // this looked like before.
        assert!(
            events.iter().any(|e| matches!(
                &e.payload,
                crate::events::AgentEventPayload::ToolCallCompleted { result, .. }
                    if !result.images.is_empty()
            )),
            "the viewed image never reached a row"
        );
    }

    /// A call that drew no row must not be answered either. The result is
    /// keyed by call id, so a stray one closes a row that was never opened —
    /// which in a group header counts as a tool call that is not there.
    #[test]
    fn a_silent_call_is_not_answered() {
        let (events, _) = replay(TOOL_KINDS);

        let opened: std::collections::HashSet<&str> = events
            .iter()
            .filter_map(|e| match &e.payload {
                crate::events::AgentEventPayload::ToolCallStarted { call_id, .. } => {
                    Some(call_id.as_str())
                }
                _ => None,
            })
            .collect();

        for e in &events {
            if let crate::events::AgentEventPayload::ToolCallCompleted { call_id, .. } = &e.payload
            {
                assert!(
                    opened.contains(call_id.as_str()),
                    "{call_id} was answered without ever being asked"
                );
            }
        }
    }

    /// `cwd` rides every `commandExecution` on the wire and is the session's own
    /// directory on nearly all of them, so carrying it gave the most common row
    /// in the transcript an expanded body holding one obvious line of JSON.
    #[test]
    fn a_shell_row_carries_only_its_command() {
        let (events, _) = replay(TOOL_KINDS);

        let inputs: Vec<_> = events
            .iter()
            .filter_map(|e| match &e.payload {
                crate::events::AgentEventPayload::ToolCallStarted { name, input, .. }
                    if name == "shell" =>
                {
                    Some(input)
                }
                _ => None,
            })
            .collect();

        assert!(!inputs.is_empty(), "the capture drew no shell row");
        for input in inputs {
            assert!(input.get("cwd").is_none(), "cwd leaked into a shell row");
            assert!(input.get("command").is_some(), "a shell row lost its command");
        }
    }

    /// `update_plan` is the one tool with no item of its own — the plan
    /// reaches us only as `turn/plan/updated`, so before this the agent went
    /// quiet and then acted on a plan the reader was never shown.
    ///
    /// Each rewrite is its own row. A plan is redrawn several times a turn, and
    /// one row changing underneath a reader scrolling back through it would
    /// describe a decision they never saw taken.
    #[test]
    fn a_rewritten_plan_draws_a_row_each_time() {
        let (events, _) = replay(PLAN_UPDATED);

        let plans: Vec<_> = events
            .iter()
            .filter_map(|e| match &e.payload {
                crate::events::AgentEventPayload::ToolCallStarted { name, input, .. }
                    if name == "update_plan" =>
                {
                    Some(input)
                }
                _ => None,
            })
            .collect();

        assert!(plans.len() >= 2, "the capture rewrote the plan; drew {}", plans.len());
        let steps = plans[0].get("plan").and_then(|p| p.as_array());
        assert!(
            steps.is_some_and(|s| !s.is_empty()),
            "a plan row carried no steps"
        );

        // Every row is answered, or each one shimmers forever waiting on a
        // result that has no line coming to deliver it.
        let done = events
            .iter()
            .filter(|e| {
                matches!(
                    &e.payload,
                    crate::events::AgentEventPayload::ToolCallCompleted { call_id, .. }
                        if call_id.starts_with("plan:")
                )
            })
            .count();
        assert_eq!(done, plans.len(), "a plan row was left open");
    }

    /// The verb has to follow what happened to the file: a patch that creates
    /// one has no previous version to have edited. The path is the row's
    /// tooltip and the diff's key, so the label itself is the filename alone.
    #[test]
    fn an_edit_is_named_for_the_file_and_the_change() {
        use parser::FileChangeEntry;

        let add = vec![FileChangeEntry {
            path: "/a/b/notes.md".to_string(),
            kind: Some(serde_json::json!("add")),
            diff: None,
        }];
        assert_eq!(mapper::edit_tool_name(&add), "create_file");
        assert_eq!(mapper::edit_title(&add), "notes.md");

        let update = vec![FileChangeEntry {
            path: "/a/b/notes.md".to_string(),
            kind: Some(serde_json::json!("update")),
            diff: None,
        }];
        assert_eq!(mapper::edit_tool_name(&update), "apply_patch");

        // No one name describes a multi-file patch, so it counts instead.
        let many = vec![
            FileChangeEntry {
                path: "/a/one.rs".to_string(),
                kind: Some(serde_json::json!("add")),
                diff: None,
            },
            FileChangeEntry {
                path: "/a/two.rs".to_string(),
                kind: Some(serde_json::json!("add")),
                diff: None,
            },
        ];
        assert_eq!(mapper::edit_tool_name(&many), "apply_patch");
        assert_eq!(mapper::edit_title(&many), "2 files");
    }

    /// Codex has no skill item — a skill is an `exec` of the skill's own file —
    /// so the name has to come off the command, and the row must not be titled
    /// with the invocation. Before this it read `Read Skill /bin/zsh -lc "sed
    /// -n '1,240p' /Users/…`, which is the machinery rather than the thing.
    ///
    /// The `.system` case is the one that made it wrong rather than ugly:
    /// Codex's own skills sit a directory deeper than the path suggests, so
    /// taking the first segment named the whole set on every one of them.
    #[test]
    fn a_skill_is_named_for_itself_not_its_invocation() {
        assert_eq!(
            mapper::skill_name(
                "/bin/zsh -lc \"sed -n '1,240p' /Users/dev/.codex/skills/.system/imagegen/SKILL.md\""
            )
            .as_deref(),
            Some("imagegen")
        );
        assert_eq!(
            mapper::skill_name("cat /Users/dev/.claude/skills/caveman-commit/SKILL.md").as_deref(),
            Some("caveman-commit")
        );

        // Fails towards an ordinary shell row: a command that is not a skill
        // must not be relabelled as one.
        assert_eq!(mapper::skill_name("git status").as_deref(), None);
        assert_eq!(mapper::skill_name("ls /tmp/skills/").as_deref(), None);
    }

    /// A Codex subagent is a whole second thread on the same connection, and
    /// telling it from the main conversation is the only thing standing between
    /// its work and the reader's transcript.
    ///
    /// Three separate failures live here, all silent:
    ///
    /// - its `agentMessage` drawn as though the primary agent said it;
    /// - its `turn/completed` marking the **session** finished while the main
    ///   turn is still running;
    /// - its `thread/tokenUsage/updated` reported as the main context ring.
    #[test]
    fn a_subagents_thread_is_filed_under_its_spawn() {
        let (events, _) = replay(TOOL_KINDS);

        // The card sits beside a title and a running orb, so the agent's own
        // identifier is written as prose rather than pasted in.
        assert_eq!(mapper::agent_name(Some("/root/count_to_three")), "Count to three");
        assert_eq!(mapper::agent_name(None), "Agent");

        let spawn = events
            .iter()
            .find_map(|e| match &e.payload {
                crate::events::AgentEventPayload::ToolCallStarted { call_id, name, .. }
                    if name == "spawn_agent" =>
                {
                    Some(call_id.clone())
                }
                _ => None,
            })
            .expect("the spawn drew no row");

        // The subagent's own answer, filed under that call rather than sitting
        // in the transcript.
        let filed: Vec<_> = events
            .iter()
            .filter(|e| e.subagent.as_ref().is_some_and(|s| s.id == spawn))
            .collect();
        assert!(!filed.is_empty(), "nothing was filed under the run");
        assert!(
            filed.iter().any(|e| matches!(
                &e.payload,
                crate::events::AgentEventPayload::AssistantText { text, .. }
                    if text.contains("One, two, three")
            )),
            "the subagent's answer never reached its run"
        );

        // And it is *not* in the main conversation.
        assert!(
            !events.iter().any(|e| e.subagent.is_none()
                && matches!(
                    &e.payload,
                    crate::events::AgentEventPayload::AssistantText { text, .. }
                        if text.contains("One, two, three")
                )),
            "the subagent's answer was drawn as the main agent's"
        );

        // The capture stops while the main turn is still running, so the one
        // `turn/completed` in it belongs to the **subagent** — which is what
        // makes this the sharp version of the test rather than the weak one.
        // Attributed to the main conversation it closes a turn that never
        // ended, settling the session while the agent is still working.
        let closes = events
            .iter()
            .filter(|e| {
                e.subagent.is_none()
                    && matches!(
                        &e.payload,
                        crate::events::AgentEventPayload::TurnCompleted { .. }
                    )
            })
            .count();
        assert_eq!(closes, 0, "a subagent's turn ended the session");

        // Same for its occupancy. The count is exact on purpose: the capture
        // carries six `thread/tokenUsage/updated` on the main thread and one on
        // the subagent's, so a seventh here is the subagent's reading folded
        // into the ring, describing a conversation the reader is not having.
        let usage = events
            .iter()
            .filter(|e| {
                matches!(&e.payload, crate::events::AgentEventPayload::UsageUpdate(_))
            })
            .count();
        assert_eq!(usage, 6, "a subagent's usage reached the main context ring");

        // The run closes, and on the thread rather than on the activity's own
        // id — `completed` carries a synthetic one that never matches.
        assert!(
            events.iter().any(|e| matches!(
                &e.payload,
                crate::events::AgentEventPayload::ToolCallCompleted { call_id, .. }
                    if *call_id == spawn
            )),
            "the run never closed"
        );

        // And the panel is told, under the run's own envelope. The transcript
        // row and the panel entry both read `done` off this one event, and it
        // rides the *main* thread — so an unstamped one matches no run and
        // leaves a finished subagent shimmering for the rest of the session.
        assert!(
            events.iter().any(|e| e.subagent.as_ref().is_some_and(|r| r.id == spawn)
                && matches!(
                    &e.payload,
                    crate::events::AgentEventPayload::SubagentCompleted { status, .. }
                        if status == "completed"
                )),
            "the run never settled"
        );
    }

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
    const TOOL_KINDS: &str = include_str!("fixtures/tool_kinds.jsonl");
    const PLAN_UPDATED: &str = include_str!("fixtures/plan_updated.jsonl");

    const FIXTURES: &[(&str, &str)] = &[
        ("simple_turn", SIMPLE_TURN),
        ("multi_call_turn", MULTI_CALL_TURN),
        ("command_approval", COMMAND_APPROVAL),
        ("tool_kinds", TOOL_KINDS),
        ("plan_updated", PLAN_UPDATED),
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
        let settings = TurnSettings::new(&model, None, ApprovalPolicy::Auto)
            .expect("the default Codex model has an alias");

        let thread_id = start_thread(
            &client,
            &settings,
            std::env::temp_dir().to_str().unwrap(),
        )
        .await
        .expect("thread/start should succeed");

        assert!(!thread_id.is_empty(), "a thread id came back");
        println!("live thread: {thread_id}");

        // The shape of Stop, checked without paying for a turn. A request
        // carrying the thread alone is refused with `missing field turnId`, so
        // the interrupt that mattered never reached the server at all; naming a
        // turn that does not exist has to fail for *that* reason instead.
        let thread = Thread {
            client: client.clone(),
            id: thread_id,
            settings,
            turn_id: Arc::new(Mutex::new(Some(
                "00000000-0000-0000-0000-000000000000".to_string(),
            ))),
        };
        let refusal = interrupt_turn(&thread)
            .await
            .expect_err("no such turn exists")
            .to_string();
        assert!(
            !refusal.contains("missing field"),
            "turn/interrupt rejected our params: {refusal}"
        );

        // And with nothing running there is nothing to name, which is not a
        // failure — Stop is pressed on turns that have just ended.
        *thread.turn_id.lock().await = None;
        interrupt_turn(&thread)
            .await
            .expect("an idle thread has nothing to interrupt");

        let _ = child.kill().await;
    }
}
