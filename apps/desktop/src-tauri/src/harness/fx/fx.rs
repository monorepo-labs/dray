//! fx, spoken over `fx acp`.
//!
//! One child per session, a JSON-RPC peer like Codex's — the framing is
//! [`codex::rpc`](crate::harness::codex::rpc) as-is. What differs is the
//! vocabulary (ACP's) and one structural fact: **a prompt is a request that
//! blocks for the whole turn.** `session/prompt` answers with the stop reason
//! once the model is done, so the turn's end arrives as a *response* rather
//! than a notification. The read loop watches for that id itself instead of
//! registering a waiter, since a waiter's timeout is for acknowledgements and
//! a turn runs for minutes.
//!
//! Rejected: `fx ask --json` is one JSON object after the turn — no stream, no
//! permission channel, no cancel. See `apps/desktop/FX-PLAN.md`.

pub mod mapper;
pub mod models;
pub mod parser;
pub mod permissions;

use crate::events::{AgentEvent, AgentEventPayload, ApprovalPolicy};
use crate::harness::claude_code::permissions::PendingPermissions;
use crate::harness::codex::rpc::{Incoming, RpcClient};
use crate::harness::{read_stderr, record_failure, Harness::Fx};
use crate::models::{Effort, Model};
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
    process::{Child, ChildStdout, Command},
    sync::Mutex,
    time::Duration,
};

/// ACP protocol version fx speaks (`agentCapabilities` answered `1`).
const PROTOCOL_VERSION: u64 = 1;

/// How long a child is given to leave after `session/close` and EOF before it
/// is killed. fx holds a `session.lock` per session under `~/.fx/sessions`,
/// and a clean exit is what releases it.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// The connection every write is addressed to.
///
/// Cloneable, and the read loop holds a clone: both halves have to agree about
/// which prompt is running, since the reader is what sees it answered.
#[derive(Clone, Debug)]
pub struct FxSession {
    pub client: RpcClient,
    /// Minted by fx, not chosen by us. Recorded on the index entry's
    /// `thread_id`, the slot Codex's minted id already lives in.
    pub id: String,
    /// The JSON-RPC id of the `session/prompt` now running, or `None` between
    /// turns. The read loop settles the turn on that id's response.
    prompt_id: Arc<std::sync::Mutex<Option<i64>>>,
}

/// Spawns a session's `fx acp`, handshakes it and opens or resumes its session.
///
/// Takes an optional [`Model`] like pi: fx is multi-provider and its own
/// settings already name one, so with none the spawn says nothing and fx's
/// pick stands.
#[allow(clippy::too_many_arguments)]
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
    // Ahead of the spawn: everything between the spawn and the kill-wrapped
    // `open_session` below has to be infallible, or a `?` returns leaving a
    // child nothing can reach.
    let seq_start = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };

    let bin = crate::binpath::fx().await;
    let mut command = Command::new(&bin);

    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    command.arg("acp");
    // A process-level override, which fx saves nowhere — verified: a spawn
    // with `--model` left `~/.fx/settings.json` byte-identical, and a later
    // `set_config_option model` on the same session still moved it.
    if let Some(model) = model {
        command.args(["--model", &model.arg]);
    }

    let mut child = command
        .current_dir(cwd)
        .env("DRAY_SESSION_ID", session_id)
        .env("PATH", crate::harness::agent_path(&bin))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("couldn't start fx")?;

    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let stderr = child.stderr.take().context("failed to take stderr")?;

    let client = RpcClient::new(stdin);
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
                eprintln!("Failed to read fx stdout: {error}");
            }
        }
    });

    tokio::spawn(async move {
        if let Err(error) = read_stderr(Fx, stderr).await {
            eprintln!("Failed to read fx stderr: {error}");
        }
    });

    let fx_id = match open_session(&client, session_id, session_cwd, is_new_session).await {
        Ok(id) => id,
        Err(error) => {
            // Post-spawn, so the child is running with nobody left to talk to
            // it. A `Child` is not reaped on drop.
            let _ = child.kill().await;
            return Err(error);
        }
    };

    let session = FxSession {
        client,
        id: fx_id,
        prompt_id: Arc::new(std::sync::Mutex::new(None)),
    };

    // Effort and stance are session settings, applied in place on a session
    // that now exists. The model rode the spawn above.
    if let Err(error) = apply_settings(&session, effort, permission_mode).await {
        let _ = child.kill().await;
        return Err(error);
    }

    let _ = ready_tx.send(session.clone());

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: Transport::Fx(session),
        harness: Fx,
        model: model.map(|m| m.id.clone()).unwrap_or_default(),
        effort,
        permission_mode,
        events,
        seq,
        status,
        pending_permissions: pending,
        queued,
    })
}

/// `initialize`, then `session/new` or `session/resume`. Answers fx's own id.
async fn open_session(
    client: &RpcClient,
    session_id: &str,
    session_cwd: &str,
    is_new_session: bool,
) -> Result<String> {
    client
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                // No `fs` and no `terminal`: fx reads and writes through its
                // own tools, and advertising either would invite requests
                // this build cannot serve.
                "clientCapabilities": {},
                "clientInfo": {"name": "dray", "title": "Dray", "version": env!("CARGO_PKG_VERSION")},
            }),
        )
        .await?;

    if is_new_session {
        let answer = client
            .request("session/new", json!({"cwd": session_cwd, "mcpServers": []}))
            .await?;
        let id = answer
            .get("sessionId")
            .and_then(Value::as_str)
            .context("session/new answered with no session id")?
            .to_string();
        // Before the first prompt, so a child dying mid-turn still leaves a
        // session to resume rather than one that silently starts over.
        store::set_session_thread_id(session_id, &id).await?;
        return Ok(id);
    }

    let recorded = store::get_session_index_item(session_id)
        .await?
        .and_then(|item| item.thread_id)
        .context("this session has no fx session to resume")?;

    client
        .request(
            "session/resume",
            json!({"sessionId": recorded, "cwd": session_cwd, "mcpServers": []}),
        )
        .await?;
    Ok(recorded)
}

async fn apply_settings(
    session: &FxSession,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
) -> Result<()> {
    // Absent means fx's `auto`, which is its own default and not a level
    // Dray's ladder spells — so it is left alone rather than sent.
    if let Some(effort) = effort {
        set_effort(session, effort).await?;
    }
    set_mode(session, permission_mode).await
}

/// Moves a live session onto another model.
pub async fn set_model(session: &FxSession, model: &Model) -> Result<()> {
    set_config(session, "model", &model.arg).await
}

/// Moves a live session onto another effort — the one in-place effort switch
/// any harness here has.
pub async fn set_effort(session: &FxSession, effort: Effort) -> Result<()> {
    set_config(session, "effort", effort.as_arg()).await
}

async fn set_config(session: &FxSession, config_id: &str, value: &str) -> Result<()> {
    session
        .client
        .request(
            "session/set_config_option",
            json!({"sessionId": session.id, "configId": config_id, "value": value}),
        )
        .await?;
    Ok(())
}

/// Dray's stance onto ACP's two modes.
///
/// fx exposes `ask` (its `ask`) and `code` (its `auto`) over ACP and nothing
/// wider: `full-access` is neither a mode here nor reachable by env or flag on
/// `fx acp`, verified against 0.0.9. So `bypassPermissions` and `dontAsk` land
/// on `code`, the widest fx has, and the frontend's `stanceFor` records that
/// rather than the stance that was asked for. `plan` lands on `ask`, the
/// narrowest.
pub fn mode_for(mode: ApprovalPolicy) -> &'static str {
    match mode {
        ApprovalPolicy::Plan | ApprovalPolicy::Manual => "ask",
        ApprovalPolicy::Auto | ApprovalPolicy::DontAsk | ApprovalPolicy::BypassPermissions => "code",
    }
}

/// Moves a live session onto another stance.
pub async fn set_mode(session: &FxSession, mode: ApprovalPolicy) -> Result<()> {
    session
        .client
        .request(
            "session/set_mode",
            json!({"sessionId": session.id, "modeId": mode_for(mode)}),
        )
        .await?;
    Ok(())
}

/// Writes one prompt as a turn.
///
/// Sent with an id and **no waiter**: the response is the turn's end, minutes
/// away, and the read loop settles it on the id kept here. A prompt refused
/// outright still answers on that id, as an error, which the reader draws as
/// a failed turn.
pub async fn start_turn(session: &FxSession, text: &str) -> Result<()> {
    let id = session.client.request_detached(
        "session/prompt",
        json!({
            "sessionId": session.id,
            "prompt": [{"type": "text", "text": text}],
        }),
    )?;
    *session.prompt_id.lock().expect("fx prompt id poisoned") = Some(id);
    Ok(())
}

/// Stops the running turn. A notification: fx acknowledges nothing, kills the
/// running tool and answers the prompt with `cancelled`, which is what the
/// reader reports the stop through.
pub fn cancel(session: &FxSession) -> Result<()> {
    session
        .client
        .notify("session/cancel", json!({"sessionId": session.id}))
}

/// Ends the child cleanly: `session/close`, EOF, then a kill if it lingers.
pub async fn shutdown(child: &mut Child, session: &FxSession) {
    let _ = session
        .client
        .request_within(
            "session/close",
            json!({"sessionId": session.id}),
            SHUTDOWN_GRACE,
        )
        .await;
    session.client.close();

    if tokio::time::timeout(SHUTDOWN_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

/// The handles the read loop needs that are not per-event state.
struct ReaderHandles {
    client: RpcClient,
    session_id: String,
    session_cwd: String,
    pending: PendingPermissions,
    app: AppHandle,
}

#[allow(clippy::too_many_arguments)]
async fn read_stdout(
    stdout: ChildStdout,
    handles: ReaderHandles,
    ready: tokio::sync::oneshot::Receiver<FxSession>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    status: Arc<Mutex<StatusTracker>>,
    queued: QueuedMessages,
    seq: Arc<AtomicU64>,
) -> Result<()> {
    let mut lines = BufReader::new(stdout).lines();
    let mut mapper = mapper::Mapper::new(handles.session_id.clone(), seq.clone());

    // Held until the session exists. Lines before it are routed — the
    // handshake's answers have to reach their waiters — but mapped to nothing.
    let mut ready = Some(ready);
    let mut transport: Option<Transport> = None;

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        if transport.is_none() {
            if let Some(rx) = &mut ready {
                match rx.try_recv() {
                    Ok(session) => {
                        transport = Some(Transport::Fx(session));
                        ready = None;
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => ready = None,
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                }
            }
        }

        // The prompt's own answer, read ahead of the demux: nothing waits on
        // it, so `accept` would file it as stray.
        let mut event: Option<parser::FxEvent> = None;
        if let Some(Transport::Fx(session)) = transport.as_ref() {
            if let Some(done) = prompt_answer(session, &line) {
                event = Some(done);
            }
        }

        let event = match event {
            Some(event) => event,
            None => match handles.client.accept(&line).await {
                Incoming::Notification { method, params } => {
                    match parser::parse_notification(&method, params) {
                        Ok(parser::FxEvent::Unknown) => {
                            record_failure(Fx, &handles.session_id, "unknown_method", &method, &line)
                                .await;
                            continue;
                        }
                        Ok(event) => event,
                        Err(err) => {
                            record_failure(Fx, &handles.session_id, "map", &err.to_string(), &line)
                                .await;
                            continue;
                        }
                    }
                }

                // Every server request blocks the turn until it is answered, so
                // silence stalls the session exactly as an unanswered
                // `can_use_tool` does.
                Incoming::Request { id, method, params } => {
                    if method == "session/request_permission" {
                        if let Err(err) = raise_permission(&handles, &mut mapper, id, params).await {
                            record_failure(Fx, &handles.session_id, "unsupported_request", &err.to_string(), &line)
                                .await;
                            let _ = handles
                                .client
                                .respond(id, json!({"outcome": {"outcome": "cancelled"}}));
                        }
                    } else {
                        // `fs/*` and `terminal/*` were not advertised, so one
                        // arriving is fx asking past the capabilities it was
                        // given. A protocol error leaves it to decide.
                        record_failure(Fx, &handles.session_id, "unsupported_request", &method, &line)
                            .await;
                        let _ = handles.client.respond_err(
                            id,
                            -32601,
                            "This client cannot answer that request yet.",
                        );
                    }
                    continue;
                }

                Incoming::Response { id, matched: false } => {
                    let detail = format!("no caller waiting on id {id}");
                    record_failure(Fx, &handles.session_id, "stray_response", &detail, &line).await;
                    continue;
                }
                Incoming::Response { .. } => continue,

                Incoming::Malformed => {
                    record_failure(Fx, &handles.session_id, "parse", "not a JSON-RPC message", &line)
                        .await;
                    continue;
                }
            },
        };

        let Some(transport) = transport.as_ref() else {
            continue;
        };

        // A title is a fact about the index row, not a transcript event, so it
        // takes the side channel `title.rs` emits on. Only inside a turn:
        // `session/resume` restates the last title before any prompt — and for
        // a session never titled, restates "Untitled session" — where Dray
        // already holds one written from the prompt.
        if let parser::FxEvent::Update(parser::SessionUpdate::SessionInfoUpdate {
            title: Some(title),
        }) = &event
        {
            if mapper.turn_open() && !title.trim().is_empty() {
                set_title(&handles, title).await;
            }
        }

        let ingest = crate::session::Ingest {
            session_id: &handles.session_id,
            harness: Fx,
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

/// The running prompt's response, where `line` is it.
///
/// A response with no method and the prompt's id. Both a result and an error
/// close the turn, and the id is cleared here so a Stop pressed after the
/// answer names nothing.
fn prompt_answer(session: &FxSession, line: &str) -> Option<parser::FxEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("method").is_some() {
        return None;
    }
    let id = value.get("id").and_then(Value::as_i64)?;

    let mut running = session.prompt_id.lock().expect("fx prompt id poisoned");
    if *running != Some(id) {
        return None;
    }
    *running = None;

    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("fx could not run this prompt")
            .to_string();
        return Some(parser::FxEvent::PromptFailed { message });
    }

    let response: parser::PromptResponse = value
        .get("result")
        .cloned()
        .and_then(|r| serde_json::from_value(r).ok())
        .unwrap_or_default();
    Some(parser::FxEvent::PromptDone(response))
}

/// fx's own title for the session, written over the prompt-derived one.
async fn set_title(handles: &ReaderHandles, title: &str) {
    match store::set_session_title(&handles.session_id, title).await {
        Ok(Some(_)) => {
            let event = crate::title::SessionTitleEvent {
                session_id: handles.session_id.clone(),
                title: title.to_string(),
            };
            if let Err(e) = handles.app.emit("session_title", &event) {
                eprintln!("[fx title emit err] {e}");
            }
        }
        Ok(None) => {}
        Err(e) => eprintln!("[fx title write err] {e}"),
    }
}

/// Turns one permission request into the card that answers it.
///
/// Registered before it is emitted, so a button pressed the instant the card
/// draws finds the entry waiting. The reply goes out from
/// [`Session::respond_permission`](crate::session::Session::respond_permission)
/// when the user picks; until then fx is blocked.
async fn raise_permission(
    handles: &ReaderHandles,
    mapper: &mut mapper::Mapper,
    rpc_id: i64,
    params: Value,
) -> Result<()> {
    let request: parser::PermissionRequest = serde_json::from_value(params)?;
    let (pending, options) = permissions::pending_for(&request, rpc_id);

    let request_id = rpc_id.to_string();
    handles
        .pending
        .lock()
        .expect("pending permissions mutex poisoned")
        .insert(request_id.clone(), pending);

    let input = request.tool_call.raw_input.clone().unwrap_or(json!({}));
    let command = input.get("command").and_then(Value::as_str).map(str::to_string);
    let path = input.get("path").and_then(Value::as_str).map(str::to_string);

    let event = mapper.synthesize(AgentEventPayload::PermissionRequested {
        request_id,
        tool_use_id: request.tool_call.tool_call_id.clone(),
        tool_name: request
            .tool_call
            .name
            .clone()
            .unwrap_or_else(|| "tool".to_string()),
        display_name: None,
        // The command or the path, which is what the card draws as the
        // subject. fx's own `title` is the tool name with the command after
        // it, which the row above already says.
        title: command.clone().or_else(|| path.clone()),
        description: None,
        input,
        blocked_path: path,
        decision_reason: None,
        decision_reason_type: None,
        agent_id: None,
        options,
    });

    // Emitted, never logged — only the child that asked can answer.
    handles.app.emit("agent_event", &event)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every stance lands on one of fx's two modes, and the wide ones land on
    /// the wider — recording `ask` for a `bypassPermissions` session would
    /// stop a session that was asked not to.
    #[test]
    fn every_stance_lands_on_a_mode_fx_has() {
        assert_eq!(mode_for(ApprovalPolicy::Manual), "ask");
        assert_eq!(mode_for(ApprovalPolicy::Plan), "ask");
        assert_eq!(mode_for(ApprovalPolicy::Auto), "code");
        assert_eq!(mode_for(ApprovalPolicy::DontAsk), "code");
        assert_eq!(mode_for(ApprovalPolicy::BypassPermissions), "code");
    }

    /// The prompt's answer is read off its id and nothing else — a response
    /// to some other request, or one arriving after the turn was cleared,
    /// must not close a turn.
    #[test]
    fn only_the_running_prompts_answer_closes_the_turn() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let session = FxSession {
            client: RpcClient::over(tx),
            id: "s".into(),
            prompt_id: Arc::new(std::sync::Mutex::new(Some(7))),
        };

        assert!(prompt_answer(&session, r#"{"jsonrpc":"2.0","id":6,"result":{}}"#).is_none());
        assert!(prompt_answer(&session, r#"{"jsonrpc":"2.0","id":7,"method":"x","params":{}}"#).is_none());

        let done = prompt_answer(
            &session,
            r#"{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn","usage":{}}}"#,
        );
        assert!(matches!(done, Some(parser::FxEvent::PromptDone(r)) if r.stop_reason == "end_turn"));
        // Cleared, so the same id answering twice closes nothing twice.
        assert!(prompt_answer(&session, r#"{"jsonrpc":"2.0","id":7,"result":{}}"#).is_none());

        *session.prompt_id.lock().unwrap() = Some(8);
        let failed = prompt_answer(
            &session,
            r#"{"jsonrpc":"2.0","id":8,"error":{"code":-32600,"message":"Run fx login grok."}}"#,
        );
        assert!(matches!(failed, Some(parser::FxEvent::PromptFailed { message }) if message.contains("grok")));
    }
}
