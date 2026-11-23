//! OpenCode, spoken over `opencode acp`.
//!
//! Plain ACP, the protocol fx and grok speak, and the framing is
//! [`rpc`](crate::harness::codex::rpc) as-is. A prompt is a request that blocks
//! for the turn, so the read loop settles the turn on that id's answer. What is
//! OpenCode's own, each measured against 1.19.5:
//!
//! - **OpenCode mints the session id** (`ses_…`), so it rides the index's
//!   `thread_id`, fx's slot, and `session/resume` in a fresh process finds it
//!   with no replay.
//! - **One prompt per turn.** A second `session/prompt` is refused and there is
//!   no interject, so a prompt typed mid-turn queues to the turn's end.
//! - **Settings move mid-turn.** `session/set_config_option` takes `model`,
//!   `effort` and `mode` while a prompt runs. The mode is not kept across a
//!   resume, so the stance's mode is set on every open.
//! - **Permission rules are config, fixed at spawn**, through
//!   `OPENCODE_PERMISSION` — so a stance change replaces the child.
//! - **Rules ride `OPENCODE_CONFIG_CONTENT`** as an `instructions` file, read
//!   on every spawn; there is no system-prompt field on the wire.

pub mod commands;
pub mod mapper;
pub mod models;
pub mod parser;

use crate::attachments::PreparedImage;
use crate::events::{AgentEventPayload, ApprovalPolicy};
use crate::harness::acp::{self, PermissionChoice};
use crate::harness::claude_code::permissions::{rpc_request_id, PendingPermissions};
use crate::harness::codex::rpc::{Incoming, RpcClient};
use crate::harness::{read_stderr, record_failure, Harness::OpenCode};
use crate::models::{Effort, Model};
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::sink::Sink;
use crate::store::{self, next_seq_by_session_id};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdout, Command},
    sync::Mutex,
};

/// Dray's rules. Each harness keeps its own copy, since each names the tools
/// its own agent has — OpenCode's are `skill` and `task`.
const SYSTEM_PROMPT: &str = include_str!("system_prompt.md");

/// The connection every write is addressed to. The read loop holds a clone,
/// since both halves have to agree which prompt is running.
#[derive(Clone, Debug)]
pub struct OpenCodeSession {
    pub client: RpcClient,
    /// OpenCode's own id, recorded on the index's `thread_id`.
    pub id: String,
    /// The JSON-RPC id of the `session/prompt` now running, or `None`.
    prompt_id: Arc<std::sync::Mutex<Option<i64>>>,
}

/// Spawns a session's `opencode acp`, handshakes it, opens or resumes its
/// session and puts it on the reader's pick.
#[allow(clippy::too_many_arguments)]
pub async fn init(
    session_id: &str,
    model: Option<&Model>,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    cwd: &str,
    session_cwd: &str,
    is_new_session: bool,
    app: &Sink,
) -> Result<Session> {
    // Everything fallible goes ahead of the spawn, so no `?` can leave a child
    // nothing reaches.
    let seq_start = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };
    let resume = if is_new_session {
        None
    } else {
        Some(
            store::get_session_index_item(session_id)
                .await?
                .and_then(|item| item.thread_id)
                .context("this session has no OpenCode session to resume")?,
        )
    };
    let rules = write_rules(session_id, session_cwd).await?;

    let bin = crate::binpath::opencode().await;
    let mut command = Command::new(&bin);
    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    let mut child = command
        .arg("acp")
        .current_dir(cwd)
        .env("DRAY_SESSION_ID", session_id)
        .env("PATH", crate::harness::agent_path(&bin))
        .env("OPENCODE_PERMISSION", permission_rules(permission_mode).to_string())
        // Merged over the reader's own config, and `instructions` is a list
        // OpenCode concatenates, so the reader's own instruction files stay.
        .env("OPENCODE_CONFIG_CONTENT", json!({"instructions": [rules]}).to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("couldn't start opencode")?;

    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let stderr = child.stderr.take().context("failed to take stderr")?;

    let client = RpcClient::new(stdin);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let pending: PendingPermissions = Default::default();
    let seq = Arc::new(AtomicU64::new(seq_start));
    let status: Arc<Mutex<StatusTracker>> = Arc::new(Mutex::new(StatusTracker::default()));
    let queued: QueuedMessages = Arc::new(Mutex::new(Vec::new()));

    let reader = ReaderHandles {
        client: client.clone(),
        session_id: session_id.to_string(),
        session_cwd: session_cwd.to_string(),
        pending: pending.clone(),
        app: app.clone(),
    };
    tokio::spawn({
        let (status, queued, seq) = (status.clone(), queued.clone(), seq.clone());
        async move {
            if let Err(error) = read_stdout(stdout, reader, ready_rx, status, queued, seq).await {
                eprintln!("Failed to read opencode stdout: {error}");
            }
        }
    });
    tokio::spawn(async move {
        if let Err(error) = read_stderr(OpenCode, stderr).await {
            eprintln!("Failed to read opencode stderr: {error}");
        }
    });

    let opened = open_session(&client, session_id, session_cwd, resume, model, effort, permission_mode).await;
    let (id, effort) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            // OpenCode starts the reader's MCP servers and language servers
            // once a session opens, so the whole tree goes, not the child.
            kill_tree(&mut child).await;
            return Err(error);
        }
    };

    let session = OpenCodeSession {
        client,
        id,
        prompt_id: Arc::new(std::sync::Mutex::new(None)),
    };
    let _ = ready_tx.send(session.clone());

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: Transport::OpenCode(session),
        harness: OpenCode,
        model: model.map(|m| m.id.clone()).unwrap_or_default(),
        // What the session runs on: a level the model has no variant for is
        // left with OpenCode and recorded as none.
        effort,
        permission_mode,
        fast: false,
        seq,
        status,
        pending_permissions: pending,
        queued,
    })
}

/// Writes this session's rules where `OPENCODE_CONFIG_CONTENT` points, fresh on
/// every spawn so a bot's edit lands at its next start.
async fn write_rules(session_id: &str, session_cwd: &str) -> Result<String> {
    let text = crate::bots::system_prompt(SYSTEM_PROMPT, session_id, session_cwd, OpenCode).await;
    let path = store::app_subdir("opencode-rules").await?.join(format!("{session_id}.md"));
    store::write_atomic(&path, text).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Dray's stance as OpenCode permission rules.
///
/// Set whole rather than left to the reader's config, because OpenCode's own
/// default allows everything and a stance that said otherwise would be a lie.
/// Plan is the `plan` agent, which refuses edits itself; its shell still asks.
/// `dontAsk` is never offered and runs as Auto.
fn permission_rules(mode: ApprovalPolicy) -> Value {
    match mode {
        ApprovalPolicy::Plan | ApprovalPolicy::Manual => {
            json!({"edit": "ask", "bash": "ask", "webfetch": "ask"})
        }
        // Edits inside the project go through; OpenCode's own
        // `external_directory` check still asks about paths outside it.
        ApprovalPolicy::Auto | ApprovalPolicy::DontAsk => {
            json!({"edit": "allow", "bash": "ask", "webfetch": "ask"})
        }
        ApprovalPolicy::BypassPermissions => json!({
            "edit": "allow", "bash": "allow", "webfetch": "allow", "external_directory": "allow",
        }),
    }
}

/// The agent a stance runs as. `None` leaves the reader's default agent, which
/// may be one of their own.
fn stance_agent(mode: ApprovalPolicy, current: Option<&str>) -> Option<&'static str> {
    match (mode, current) {
        (ApprovalPolicy::Plan, Some("plan")) => None,
        (ApprovalPolicy::Plan, _) => Some("plan"),
        (_, Some("plan")) => Some("build"),
        _ => None,
    }
}

/// `initialize`, `session/new` or `session/resume`, then the reader's model,
/// effort and stance. Answers OpenCode's id and the effort that landed.
async fn open_session(
    client: &RpcClient,
    session_id: &str,
    session_cwd: &str,
    resume: Option<String>,
    model: Option<&Model>,
    effort: Option<Effort>,
    mode: ApprovalPolicy,
) -> Result<(String, Option<Effort>)> {
    client
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                // No `fs` and no `terminal`: OpenCode reads and writes through
                // its own tools.
                "clientCapabilities": {},
                "clientInfo": {"name": "dray", "title": "Dray", "version": env!("CARGO_PKG_VERSION")},
            }),
        )
        .await?;

    // MCP is OpenCode's own: it reads the reader's config, so Dray hands over
    // nothing.
    let (id, mut config) = match resume {
        Some(id) => {
            let answer = client
                .request("session/resume", json!({"sessionId": id, "cwd": session_cwd, "mcpServers": []}))
                .await
                .with_context(|| format!("couldn't resume OpenCode session {id}"))?;
            (id, answer)
        }
        None => {
            let answer = client
                .request("session/new", json!({"cwd": session_cwd, "mcpServers": []}))
                .await?;
            let id = answer
                .get("sessionId")
                .and_then(Value::as_str)
                .context("session/new answered with no session id")?
                .to_string();
            // Before the first prompt, so a child dying mid-turn still leaves
            // a session to resume.
            store::set_session_thread_id(session_id, &id).await?;
            (id, answer)
        }
    };

    if let Some(model) = model {
        config = set_config(client, &id, "model", &model.arg).await?;
    }
    // After the model, since a ladder is per model.
    let effort = effort.filter(|level| offers(&config, "effort", level.as_arg()));
    if let Some(level) = effort {
        set_config(client, &id, "effort", level.as_arg()).await?;
    }
    if let Some(agent) = stance_agent(mode, current(&config, "mode")) {
        set_config(client, &id, "mode", agent).await?;
    }
    Ok((id, effort))
}

/// The `currentValue` of one config option in a reply that lists them.
fn current<'a>(reply: &'a Value, option: &str) -> Option<&'a str> {
    options(reply)?
        .iter()
        .find(|o| o["id"] == option)?
        .get("currentValue")?
        .as_str()
}

/// Whether one config option offers `value` — the effort option exists only
/// for a model with variants, and lists only that model's levels.
fn offers(reply: &Value, option: &str, value: &str) -> bool {
    options(reply)
        .and_then(|opts| opts.iter().find(|o| o["id"] == option))
        .and_then(|o| o.get("options")?.as_array())
        .is_some_and(|values| values.iter().any(|v| v["value"] == value))
}

fn options(reply: &Value) -> Option<&Vec<Value>> {
    reply.get("configOptions")?.as_array()
}

/// `session/set_config_option`, which answers the session's whole option list.
async fn set_config(client: &RpcClient, id: &str, option: &str, value: &str) -> Result<Value> {
    client
        .request(
            "session/set_config_option",
            json!({"sessionId": id, "configId": option, "value": value}),
        )
        .await
}

/// Moves a live session onto another model, mid-turn included.
pub async fn set_model(session: &OpenCodeSession, model: &Model) -> Result<()> {
    set_config(&session.client, &session.id, "model", &model.arg).await?;
    Ok(())
}

/// Moves a live session onto another effort. OpenCode refuses a level the
/// model has no variant for, and that refusal is what the reader sees.
pub async fn set_effort(session: &OpenCodeSession, effort: Effort) -> Result<()> {
    set_config(&session.client, &session.id, "effort", effort.as_arg()).await?;
    Ok(())
}

/// Opens a turn with one prompt. Sent with no waiter: the answer is the turn's
/// end, and the read loop settles it on the id kept here.
pub async fn start_turn(session: &OpenCodeSession, text: &str, images: &[PreparedImage]) -> Result<()> {
    let mut prompt = vec![json!({"type": "text", "text": text})];
    prompt.extend(
        images
            .iter()
            .map(|image| json!({"type": "image", "mimeType": image.mime_type, "data": image.data})),
    );

    // Held across the send: a refusal can answer before this returns, and the
    // reader takes this same lock.
    let mut running = session.prompt_id.lock().expect("opencode prompt id poisoned");
    let id = session
        .client
        .request_detached("session/prompt", json!({"sessionId": session.id, "prompt": prompt}))?;
    *running = Some(id);
    Ok(())
}

/// Stops the running turn. OpenCode aborts the running tool and answers the
/// prompt `cancelled`.
pub fn cancel(session: &OpenCodeSession) -> Result<()> {
    session.client.notify("session/cancel", json!({"sessionId": session.id}))
}

/// Kills the child and everything under it — the reader's MCP servers and the
/// language servers OpenCode starts per project.
pub async fn kill_tree(child: &mut Child) {
    if let Some(root) = child.id() {
        crate::local_servers::kill_descendants(root).await;
    }
    let _ = child.kill().await;
}

struct ReaderHandles {
    client: RpcClient,
    session_id: String,
    session_cwd: String,
    pending: PendingPermissions,
    app: Sink,
}

async fn read_stdout(
    stdout: ChildStdout,
    handles: ReaderHandles,
    ready: tokio::sync::oneshot::Receiver<OpenCodeSession>,
    status: Arc<Mutex<StatusTracker>>,
    queued: QueuedMessages,
    seq: Arc<AtomicU64>,
) -> Result<()> {
    let mut lines = BufReader::new(stdout).lines();
    let mut mapper = mapper::Mapper::new(handles.session_id.clone(), seq.clone());
    let mut ready = Some(ready);
    let mut transport: Option<Transport> = None;

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                eprintln!("[opencode stdout err] {err}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        if transport.is_none() {
            if let Some(rx) = &mut ready {
                match rx.try_recv() {
                    Ok(session) => {
                        transport = Some(Transport::OpenCode(session));
                        ready = None;
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => ready = None,
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                }
            }
        }
        let session = match &transport {
            Some(Transport::OpenCode(session)) => Some(session),
            _ => None,
        };

        // The prompt's own answer, read ahead of the demux: nothing waits on
        // it, so `accept` would file it as stray.
        let event = match session.and_then(|s| prompt_answer(s, &line)) {
            Some(done) => done,
            None => match handles.client.accept(&line).await {
                Incoming::Notification { method, params } => match parser::parse_notification(&method, params) {
                    Ok(note) => {
                        // A subagent's child session is dropped on its own id.
                        // Before the session is handed over nothing is drawn —
                        // but the command list lands then, right after
                        // `session/new` answers and while the pick is still
                        // being applied, and it is per directory, so it is kept.
                        let ours = session.is_some_and(|s| note.session_id == s.id);
                        match note.update {
                            parser::OpenCodeUpdate::AvailableCommandsUpdate { available_commands }
                                if ours || session.is_none() =>
                            {
                                commands::remember(&handles.session_cwd, available_commands);
                                continue;
                            }
                            _ if !ours => continue,
                            parser::OpenCodeUpdate::Unknown => {
                                let kind = serde_json::from_str::<Value>(&line)
                                    .ok()
                                    .and_then(|v| v.pointer("/params/update/sessionUpdate")?.as_str().map(str::to_string))
                                    .unwrap_or_default();
                                record_failure(OpenCode, &handles.session_id, "unknown_subtype", &kind, &line).await;
                                continue;
                            }
                            update => parser::OpenCodeEvent::Update(update),
                        }
                    }
                    Err(parser::ParseOutcome::Unknown) => {
                        record_failure(OpenCode, &handles.session_id, "unknown_method", &method, &line).await;
                        continue;
                    }
                    Err(parser::ParseOutcome::Malformed(err)) => {
                        record_failure(OpenCode, &handles.session_id, "map", &err.to_string(), &line).await;
                        continue;
                    }
                },

                // Every request blocks the turn until it is answered.
                Incoming::Request { id, method, params } => {
                    answer_request(&handles, &mapper, id, &method, params, &line).await;
                    continue;
                }

                Incoming::Response { id, matched: false } => {
                    let detail = format!("no caller waiting on id {id}");
                    record_failure(OpenCode, &handles.session_id, "stray_response", &detail, &line).await;
                    continue;
                }
                Incoming::Response { .. } | Incoming::Foreign => continue,
                Incoming::Malformed => {
                    record_failure(OpenCode, &handles.session_id, "parse", "not a JSON-RPC message", &line).await;
                    continue;
                }
            },
        };

        let Some(transport) = transport.as_ref() else {
            continue;
        };
        let ingest = crate::session::Ingest {
            session_id: &handles.session_id,
            harness: OpenCode,
            session_cwd: &handles.session_cwd,
            status: &status,
            queued: &queued,
            flush_seq: &seq,
            flush_transport: transport,
        };
        for agent_event in mapper.map(event) {
            crate::session::ingest(&ingest, agent_event, &handles.app).await;
        }
    }

    handles.client.fail_pending();

    // A prompt still in flight will never be answered, so its turn is closed
    // as a failure — after the queue is stranded, so the closing turn's flush
    // hands the dead child nothing.
    if let Some(transport @ Transport::OpenCode(session)) = transport.as_ref() {
        let outstanding = session.prompt_id.lock().expect("opencode prompt id poisoned").take().is_some();
        crate::session::strand_queue_on_exit(&handles.session_id, OpenCode, &queued, &seq, &handles.app).await;
        if outstanding {
            let ingest = crate::session::Ingest {
                session_id: &handles.session_id,
                harness: OpenCode,
                session_cwd: &handles.session_cwd,
                status: &status,
                queued: &queued,
                flush_seq: &seq,
                flush_transport: transport,
            };
            let failed = parser::OpenCodeEvent::PromptFailed {
                message: "OpenCode exited before finishing this turn.".to_string(),
            };
            for agent_event in mapper.map(failed) {
                crate::session::ingest(&ingest, agent_event, &handles.app).await;
            }
        }
    }

    crate::session::settle_dead_child(
        &handles.session_id,
        OpenCode,
        &seq,
        &status,
        &queued,
        "OpenCode stopped before the turn finished",
        &handles.app,
    )
    .await;
    Ok(())
}

/// The running prompt's answer, where `line` is it. Clears the id, so a Stop
/// pressed after the answer names nothing.
fn prompt_answer(session: &OpenCodeSession, line: &str) -> Option<parser::OpenCodeEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("method").is_some() {
        return None;
    }
    let id = value.get("id").and_then(Value::as_i64)?;

    let mut running = session.prompt_id.lock().expect("opencode prompt id poisoned");
    if *running != Some(id) {
        return None;
    }
    *running = None;

    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("OpenCode could not run this prompt")
            .to_string();
        return Some(parser::OpenCodeEvent::PromptFailed { message });
    }
    let response = value
        .get("result")
        .cloned()
        .and_then(|r| serde_json::from_value(r).ok())
        .unwrap_or_default();
    Some(parser::OpenCodeEvent::PromptDone(Box::new(response)))
}

/// Answers one client-bound request: a permission becomes a card, and anything
/// else is refused so the turn moves on.
async fn answer_request(
    handles: &ReaderHandles,
    mapper: &mapper::Mapper,
    rpc_id: i64,
    method: &str,
    params: Value,
    line: &str,
) {
    match method {
        "session/request_permission" => {
            if let Err(err) = raise_permission(handles, mapper, rpc_id, params) {
                record_failure(OpenCode, &handles.session_id, "unsupported_request", &err.to_string(), line).await;
                // ACP's `cancelled` is always a legal answer, and one that
                // stalls nothing.
                let _ = handles.client.respond(rpc_id, json!({"outcome": {"outcome": "cancelled"}}));
            }
        }
        // OpenCode writes the file itself, then asks the client to write it
        // too — unadvertised, so an editor client can refresh its buffer.
        // Refused quietly: measured, the edit has already landed.
        "fs/write_text_file" => {
            let _ = handles.client.respond_err(rpc_id, -32601, "Dray does not write files for the agent.");
        }
        _ => {
            record_failure(OpenCode, &handles.session_id, "unsupported_request", method, line).await;
            let _ = handles
                .client
                .respond_err(rpc_id, -32601, "This client cannot answer that request yet.");
        }
    }
}

/// Holds a permission request and draws its card. Registered before it is
/// emitted, so a button pressed the instant the card draws finds it waiting.
fn raise_permission(handles: &ReaderHandles, mapper: &mapper::Mapper, rpc_id: i64, params: Value) -> Result<()> {
    let request: parser::PermissionRequest = serde_json::from_value(params)?;
    let call = &request.tool_call;
    let choices: Vec<PermissionChoice> = request.options.clone();
    let (pending, options) = acp::pending_for("opencode", &call.tool_call_id, call.kind.name(), &choices, rpc_id);

    let input = call.raw_input.clone().unwrap_or(json!({}));
    let path = input
        .get("filepath")
        .or_else(|| input.get("filePath"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let request_id = rpc_request_id();
    handles
        .pending
        .lock()
        .expect("pending permissions mutex poisoned")
        .insert(request_id.clone(), pending);

    let event = mapper.synthesize(AgentEventPayload::PermissionRequested {
        request_id,
        tool_use_id: call.tool_call_id.clone(),
        tool_name: call.kind.name().to_string(),
        display_name: None,
        // OpenCode's title is the command or the path, the card's subject.
        title: call.title.clone(),
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

    /// A session recorded `plan` must never come out freer than asked, and the
    /// plan agent is what refuses its edits.
    #[test]
    fn every_stance_lands_on_rules_and_an_agent() {
        assert_eq!(stance_agent(ApprovalPolicy::Plan, Some("build")), Some("plan"));
        assert_eq!(stance_agent(ApprovalPolicy::Plan, Some("plan")), None);
        assert_eq!(stance_agent(ApprovalPolicy::Manual, Some("plan")), Some("build"));
        // The reader's own default agent is left alone.
        assert_eq!(stance_agent(ApprovalPolicy::Auto, Some("my-agent")), None);

        assert_eq!(permission_rules(ApprovalPolicy::Plan)["bash"], "ask");
        assert_eq!(permission_rules(ApprovalPolicy::Manual)["edit"], "ask");
        assert_eq!(permission_rules(ApprovalPolicy::Auto)["edit"], "allow");
        assert_eq!(permission_rules(ApprovalPolicy::Auto)["bash"], "ask");
        assert_eq!(permission_rules(ApprovalPolicy::BypassPermissions)["bash"], "allow");
    }

    /// The effort option exists only for a model with variants, so a level is
    /// sent only where the reply lists it.
    #[test]
    fn effort_is_sent_only_where_the_model_offers_it() {
        let reply = json!({"configOptions": [
            {"id": "model", "currentValue": "opencode-go/gpt-6-luna", "options": []},
            {"id": "effort", "currentValue": "none",
             "options": [{"value": "none"}, {"value": "low"}, {"value": "high"}]},
            {"id": "mode", "currentValue": "build", "options": [{"value": "build"}, {"value": "plan"}]},
        ]});
        assert!(offers(&reply, "effort", "high"));
        assert!(!offers(&reply, "effort", "xhigh"));
        assert_eq!(current(&reply, "mode"), Some("build"));

        let flat = json!({"configOptions": [{"id": "model", "currentValue": "x", "options": []}]});
        assert!(!offers(&flat, "effort", "low"));
    }

    /// A resume in a fresh process brings the model back and **not** the mode
    /// — the capture set `plan` mid-turn and resumed on `build` — which is why
    /// the stance's agent is set on every open, never on creation alone.
    #[test]
    fn a_resume_keeps_the_model_and_drops_the_mode() {
        let reply: Value = include_str!("fixtures/resume.jsonl")
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line.strip_prefix("<< ")?).ok())
            .find(|line| line["id"] == 2)
            .and_then(|line| line.get("result").cloned())
            .expect("the resume answered");

        assert_eq!(current(&reply, "model"), Some("opencode-go/qwen3.8-flash"));
        assert_eq!(current(&reply, "mode"), Some("build"));
        assert_eq!(stance_agent(ApprovalPolicy::Plan, current(&reply, "mode")), Some("plan"));
    }

    #[test]
    fn the_rules_name_opencodes_own_tools() {
        assert!(SYSTEM_PROMPT.contains("You run inside Dray"));
        assert!(SYSTEM_PROMPT.contains("`skill` tool"));
        assert!(SYSTEM_PROMPT.contains("`task` tool"));
    }
}
