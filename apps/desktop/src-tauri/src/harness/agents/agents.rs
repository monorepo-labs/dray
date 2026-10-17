//! Any ACP agent, run as data.
//!
//! fx and grok are hand-written because each has extensions worth driving. This
//! is the other road: an agent named by the ACP registry (or added by the
//! reader) is started from its catalog entry and spoken to in standard ACP
//! alone — `initialize`, `session/new`, `session/load`/`resume`,
//! `session/prompt`, `session/cancel`, `session/set_config_option` and
//! `session/request_permission`. What an agent can do is read off its own
//! `initialize` reply rather than a table.
//!
//! Measured against Devin 3000.11.92 (`devin acp`):
//! - **The agent mints the session id**, so it rides `thread_id` as fx's does.
//! - **`session/load` replays the whole conversation** as updates. They arrive
//!   before the load answers, and the read loop maps nothing until the session
//!   is open, so Dray's own log stays the only copy drawn.
//! - **Models and modes ride `session/new`'s `configOptions`**, never
//!   `initialize`, and Devin persists a session on `session/new` — so they are
//!   learned from the first live session rather than probed for.
//! - **Permission request ids are strings**, which [`RequestId`] carries.
//!
//! [`RequestId`]: crate::harness::codex::rpc::RequestId

pub mod catalog;
pub mod mapper;
pub mod parser;

use crate::events::{AgentEventPayload, ApprovalPolicy};
use crate::harness::claude_code::commands::SlashCommand;
use crate::harness::claude_code::permissions::{rpc_request_id, PendingPermissions};
use crate::harness::codex::rpc::{Incoming, RequestId, RpcClient};
use crate::harness::{mentions_any, read_stderr, record_failure, Harness};
use crate::models::{Effort, Model, ModelId};
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::sink::Sink;
use crate::store::next_seq_by_session_id;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStdout, Command},
    sync::Mutex,
};
use ts_rs::TS;

use parser::{AcpEvent, SessionOptions, SessionUpdate, Setting};

const PROTOCOL_VERSION: u64 = 1;
/// Opening a session can start the agent's MCP servers before it answers.
const OPEN_TIMEOUT: Duration = Duration::from_secs(120);
/// A browser sign-in waits on the reader.
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);

/// What an agent's sessions were last seen able to be set to, by agent id.
static LEARNED: LazyLock<std::sync::Mutex<HashMap<String, SessionOptions>>> =
    LazyLock::new(Default::default);
/// Slash commands by `<agent id>\0<cwd>`, published by live sessions.
static COMMANDS: LazyLock<std::sync::Mutex<HashMap<String, Vec<SlashCommand>>>> =
    LazyLock::new(Default::default);
/// Modes picked for a session before its child exists, by Dray session id.
static PENDING_MODES: LazyLock<std::sync::Mutex<HashMap<String, String>>> =
    LazyLock::new(Default::default);

/// The connection every write is addressed to.
#[derive(Clone, Debug)]
pub struct AcpSession {
    pub client: RpcClient,
    /// The agent's own session id.
    pub id: String,
    pub harness: Harness,
    prompt_id: Arc<std::sync::Mutex<Option<i64>>>,
    /// Where the session's settings stand and what they may be set to.
    options: Arc<std::sync::Mutex<SessionOptions>>,
}

fn agent_id(harness: Harness) -> Result<&'static str> {
    match harness {
        Harness::Acp(id) => Ok(id),
        other => bail!("{} is not an ACP agent", other.label()),
    }
}

/// Spawns an ACP agent and opens or reloads its session.
#[allow(clippy::too_many_arguments)]
pub async fn init(
    session_id: &str,
    harness: Harness,
    model: Option<&Model>,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    cwd: &str,
    session_cwd: &str,
    is_new_session: bool,
    app: &Sink,
) -> Result<Session> {
    let id = agent_id(harness)?;
    let seq_start = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };

    let launch = catalog::launch(id).await?;
    // A custom agent's own PATH leads, so tool dirs its owner named still win.
    let path = match launch.env.get("PATH").filter(|p| !p.is_empty()) {
        Some(own) => format!("{own}:{}", crate::harness::agent_path(&launch.program)),
        None => crate::harness::agent_path(&launch.program),
    };
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.args)
        .envs(&launch.env)
        .env("PATH", path)
        .env("DRAY_SESSION_ID", session_id);
    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    let mut child = command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("couldn't start {}", harness.label()))?;

    let stdin = child.stdin.take().context("failed to take stdin")?;
    let stdout = child.stdout.take().context("failed to take stdout")?;
    let stderr = child.stderr.take().context("failed to take stderr")?;

    let client = RpcClient::new(stdin);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let pending: PendingPermissions = Default::default();
    let seq = Arc::new(AtomicU64::new(seq_start));
    let status: Arc<Mutex<StatusTracker>> = Arc::new(Mutex::new(StatusTracker::default()));
    let queued: QueuedMessages = Arc::new(Mutex::new(Vec::new()));

    let handles = ReaderHandles {
        client: client.clone(),
        session_id: session_id.to_string(),
        session_cwd: session_cwd.to_string(),
        harness,
        pending: pending.clone(),
        app: app.clone(),
    };
    tokio::spawn({
        let (status, queued, seq) = (status.clone(), queued.clone(), seq.clone());
        async move {
            if let Err(error) = read_stdout(stdout, handles, ready_rx, status, queued, seq).await {
                eprintln!("Failed to read ACP agent stdout: {error}");
            }
        }
    });
    tokio::spawn(async move {
        if let Err(error) = read_stderr(harness, stderr).await {
            eprintln!("Failed to read ACP agent stderr: {error}");
        }
    });

    let opened = match open_session(&client, session_id, session_cwd, is_new_session).await {
        Ok(opened) => opened,
        Err(error) => {
            // The agent may have started MCP servers of its own by now.
            if let Some(root) = child.id() {
                crate::local_servers::kill_descendants(root).await;
            }
            let _ = child.kill().await;
            return Err(error.context(format!("{} could not open the session", harness.label())));
        }
    };

    let session = AcpSession {
        client,
        id: opened.0,
        harness,
        prompt_id: Arc::new(std::sync::Mutex::new(None)),
        options: Arc::new(std::sync::Mutex::new(opened.1)),
    };
    learn(&session, app);

    // The reader's picks, applied once the session says what it takes. A
    // refusal leaves the agent on its own setting rather than failing the send.
    if let Some(model) = model.filter(|m| !m.arg.is_empty()) {
        if let Err(err) = set_model(&session, model, app).await {
            eprintln!("[acp model err] {err:#}");
        }
    }
    if let Some(effort) = effort {
        if let Err(err) = set_effort(&session, effort, app).await {
            eprintln!("[acp effort err] {err:#}");
        }
    }
    let held = PENDING_MODES.lock().unwrap().remove(session_id);
    let mode = match held.clone() {
        Some(mode) => Some(mode),
        None => crate::store::get_session_index_item(session_id)
            .await
            .ok()
            .flatten()
            .and_then(|item| item.agent_mode),
    };
    if let Some(mode) = mode {
        match set_mode(&session, &mode, app).await {
            // A pick made before the session existed is recorded only once the
            // agent took it, or a reopen could not restore it.
            Ok(()) if held.is_some() => {
                if let Err(err) = crate::store::set_session_agent_mode(session_id, &mode).await {
                    eprintln!("[acp mode save err] {err:#}");
                }
            }
            Ok(()) => {}
            Err(err) => eprintln!("[acp mode err] {err:#}"),
        }
    }

    let _ = ready_tx.send(session.clone());

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: Transport::Acp(session),
        harness,
        model: model.map(|m| m.id.clone()).unwrap_or_default(),
        effort,
        // Recorded but never sent: the agent's own modes are its stance, set
        // through `set_agent_mode`.
        permission_mode,
        fast: false,
        seq,
        status,
        pending_permissions: pending,
        queued,
    })
}

/// `initialize`, then `session/new`, `session/resume` or `session/load`.
/// Answers the agent's session id and what the session can be set to.
async fn open_session(
    client: &RpcClient,
    session_id: &str,
    session_cwd: &str,
    is_new_session: bool,
) -> Result<(String, SessionOptions)> {
    let init = client
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                // No `fs`, no `terminal`: the agent reads, writes and runs
                // through its own tools, and advertising either invites
                // requests this build cannot serve.
                "clientCapabilities": {},
                "clientInfo": {"name": "dray", "title": "Dray", "version": env!("CARGO_PKG_VERSION")},
            }),
        )
        .await?;
    let caps = &init["agentCapabilities"];
    let auth_methods = init.get("authMethods").cloned().unwrap_or(json!([]));

    if is_new_session {
        let params = json!({"cwd": session_cwd, "mcpServers": []});
        let answer = with_auth(client, &auth_methods, "session/new", params).await?;
        let id = answer
            .get("sessionId")
            .and_then(Value::as_str)
            .context("session/new answered with no session id")?
            .to_string();
        // Before the first prompt, so a child dying mid-turn leaves a session
        // to reopen rather than one that silently starts over.
        crate::store::set_session_thread_id(session_id, &id).await?;
        return Ok((id, SessionOptions::of(&answer)));
    }

    let recorded = crate::store::get_session_index_item(session_id)
        .await?
        .and_then(|item| item.thread_id)
        .context("this session has no agent session to reopen")?;
    // `resume` where the agent offers it: it restores without replaying.
    let method = if caps.pointer("/sessionCapabilities/resume").is_some() {
        "session/resume"
    } else if caps.get("loadSession").and_then(Value::as_bool) == Some(true) {
        "session/load"
    } else {
        bail!("this agent cannot reopen a session it ran before");
    };
    let params = json!({"sessionId": recorded, "cwd": session_cwd, "mcpServers": []});
    let answer = with_auth(client, &auth_methods, method, params).await?;
    Ok((recorded, SessionOptions::of(&answer)))
}

/// Sends `method`, signing in through ACP's `authenticate` once where the agent
/// refuses for want of it.
///
/// Only a method the agent runs itself (no `type`, or `"agent"`) is tried — a
/// browser login like Devin's. A terminal method wants a terminal this pipe has
/// not got, so the agent's own refusal stands and says what to do.
async fn with_auth(client: &RpcClient, methods: &Value, method: &str, params: Value) -> Result<Value> {
    let first = client.request_within(method, params.clone(), OPEN_TIMEOUT).await;
    let Err(err) = first else {
        return first;
    };
    let message = format!("{err:#}");
    if !(message.contains("code -32000") || mentions_any(&message, &["authenticat", "log in", "sign in"])) {
        return Err(err);
    }
    let Some(auth) = methods.as_array().into_iter().flatten().find(|m| {
        matches!(m.get("type").and_then(Value::as_str), None | Some("agent"))
    }) else {
        return Err(err);
    };
    let method_id = auth.get("id").and_then(Value::as_str).context("an auth method with no id")?;
    client
        .request_within("authenticate", json!({"methodId": method_id}), AUTH_TIMEOUT)
        .await
        .context("signing in to the agent")?;
    client.request_within(method, params, OPEN_TIMEOUT).await
}

/// Records what this session can be set to, telling the composer where the
/// answer changed what it draws.
fn learn(session: &AcpSession, app: &Sink) {
    let Ok(id) = agent_id(session.harness) else {
        return;
    };
    let options = session.options.lock().unwrap().clone();
    if options.is_empty() {
        return;
    }
    let changed = {
        let mut learned = LEARNED.lock().unwrap();
        let before = learned.get(id).map(choice_values);
        let after = choice_values(&options);
        learned.insert(id.to_string(), options);
        before.as_ref() != Some(&after)
    };
    if changed {
        if let Err(err) = app.emit("models_changed", json!({"harness": session.harness})) {
            eprintln!("[acp models_changed emit err] {err}");
        }
    }
}

/// What changing would move the picker: the choices, not where they stand.
fn choice_values(options: &SessionOptions) -> Vec<Vec<String>> {
    [&options.model, &options.mode, &options.effort]
        .iter()
        .map(|s| s.as_ref().map(|s| s.choices.iter().map(|c| c.value.clone()).collect()).unwrap_or_default())
        .collect()
}

#[derive(Clone, Copy)]
enum Which {
    Model,
    Mode,
    Effort,
}

fn setting(options: &SessionOptions, which: Which) -> Option<&Setting> {
    match which {
        Which::Model => options.model.as_ref(),
        Which::Mode => options.mode.as_ref(),
        Which::Effort => options.effort.as_ref(),
    }
}

/// Moves one setting on a live session, and keeps the answer it gives back.
async fn set(session: &AcpSession, which: Which, value: &str, app: &Sink) -> Result<()> {
    let (config_id, current) = {
        let options = session.options.lock().unwrap();
        let setting = setting(&options, which);
        (
            setting.and_then(|s| s.config_id.clone()),
            setting.and_then(|s| s.current.clone()),
        )
    };
    if current.as_deref() == Some(value) {
        return Ok(());
    }

    match (config_id, which) {
        (Some(config_id), _) => {
            let answer = session
                .client
                .request(
                    "session/set_config_option",
                    json!({"sessionId": session.id, "configId": config_id, "value": value}),
                )
                .await?;
            let next = SessionOptions::of(&answer);
            if !next.is_empty() {
                *session.options.lock().unwrap() = next;
            }
        }
        // The older forms, for agents that publish `modes`/`models` alone.
        (None, Which::Mode) => {
            session
                .client
                .request("session/set_mode", json!({"sessionId": session.id, "modeId": value}))
                .await?;
            note_current(session, which, value);
        }
        (None, Which::Model) => {
            session
                .client
                .request("session/set_model", json!({"sessionId": session.id, "modelId": value}))
                .await?;
            note_current(session, which, value);
        }
        (None, Which::Effort) => bail!("{} takes no effort setting", session.harness.label()),
    }
    learn(session, app);
    Ok(())
}

fn note_current(session: &AcpSession, which: Which, value: &str) {
    let mut options = session.options.lock().unwrap();
    let slot = match which {
        Which::Model => &mut options.model,
        Which::Mode => &mut options.mode,
        Which::Effort => &mut options.effort,
    };
    if let Some(setting) = slot {
        setting.current = Some(value.to_string());
    }
}

pub async fn set_model(session: &AcpSession, model: &Model, app: &Sink) -> Result<()> {
    set(session, Which::Model, &model.arg, app).await
}

pub async fn set_effort(session: &AcpSession, effort: Effort, app: &Sink) -> Result<()> {
    set(session, Which::Effort, effort.as_arg(), app).await
}

pub async fn set_mode(session: &AcpSession, mode: &str, app: &Sink) -> Result<()> {
    set(session, Which::Mode, mode, app).await
}

/// Writes one prompt as a turn. The answer is the turn's end, read by the loop.
pub async fn start_turn(session: &AcpSession, text: &str) -> Result<()> {
    let mut running = session.prompt_id.lock().expect("acp prompt id poisoned");
    let id = session.client.request_detached(
        "session/prompt",
        json!({"sessionId": session.id, "prompt": [{"type": "text", "text": text}]}),
    )?;
    *running = Some(id);
    Ok(())
}

/// Stops the running turn. The agent answers the prompt `cancelled`.
pub fn cancel(session: &AcpSession) -> Result<()> {
    session.client.notify("session/cancel", json!({"sessionId": session.id}))
}

/// The models an agent was last seen offering, or none before its first
/// session — the picker then draws the agent's own default.
pub fn list_models(harness: Harness) -> Vec<Model> {
    let Ok(id) = agent_id(harness) else {
        return Vec::new();
    };
    let learned = LEARNED.lock().unwrap();
    let Some(options) = learned.get(id) else {
        return Vec::new();
    };
    let efforts: Vec<Effort> = options
        .effort
        .iter()
        .flat_map(|s| s.choices.iter())
        .filter_map(|c| Effort::from_arg(&c.value))
        .collect();
    options
        .model
        .iter()
        .flat_map(|s| s.choices.iter())
        .map(|choice| Model {
            id: ModelId::new(choice.value.clone()),
            label: choice.name.clone().unwrap_or_else(|| choice.value.clone()),
            efforts: efforts.clone(),
            default_effort: None,
            arg: choice.value.clone(),
            provider: String::new(),
            accepts_images: false,
            secondary: false,
            supports_fast: false,
        })
        .collect()
}

/// A model by id, taken as written where nothing has been learned — the agent
/// is the judge of its own models, and refusing one this build has not seen
/// would make a restart forget every session's pick.
pub fn find_model(harness: Harness, id: &ModelId) -> Option<Model> {
    if id.is_unset() {
        return None;
    }
    list_models(harness).into_iter().find(|m| &m.id == id).or_else(|| {
        Some(Model {
            id: id.clone(),
            label: id.to_string(),
            efforts: Vec::new(),
            default_effort: None,
            arg: id.to_string(),
            provider: String::new(),
            accepts_images: false,
            secondary: false,
            supports_fast: false,
        })
    })
}

/// One of an agent's own permission modes.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AgentMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// What the stance picker draws for an ACP agent.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AgentModes {
    pub modes: Vec<AgentMode>,
    /// Where the agent's last session started, which is its default.
    pub current: Option<String>,
}

/// The mode this live session is on, as the agent last said.
pub fn current_mode(session: &AcpSession) -> Option<String> {
    session.options.lock().unwrap().mode.as_ref()?.current.clone()
}

pub fn modes(harness: Harness) -> AgentModes {
    let Ok(id) = agent_id(harness) else {
        return AgentModes::default();
    };
    let learned = LEARNED.lock().unwrap();
    let Some(mode) = learned.get(id).and_then(|o| o.mode.as_ref()) else {
        return AgentModes::default();
    };
    AgentModes {
        modes: mode
            .choices
            .iter()
            .map(|c| AgentMode {
                id: c.value.clone(),
                name: c.name.clone().unwrap_or_else(|| c.value.clone()),
                description: c.description.clone(),
            })
            .collect(),
        current: mode.current.clone(),
    }
}

/// Holds a mode for a session whose child does not exist yet.
pub fn hold_mode(session_id: &str, mode: &str) {
    PENDING_MODES.lock().unwrap().insert(session_id.to_string(), mode.to_string());
}

/// The slash commands a session of this agent last published in `cwd`, or an
/// error where none has — read by the picker as "not answered yet".
pub fn list_commands(harness: Harness, cwd: &str) -> Result<Vec<SlashCommand>> {
    let id = agent_id(harness)?;
    COMMANDS
        .lock()
        .unwrap()
        .get(&format!("{id}\0{cwd}"))
        .cloned()
        .context("this agent has not published its commands here yet")
}

/// The commands Dray already draws in its own chrome, or whose effect never
/// comes back on the wire. Devin advertises each of these over ACP.
const WITHHELD: &[&str] = &["login", "logout", "status", "model", "mode", "compact", "context", "help", "bug"];

fn remember_commands(harness: Harness, cwd: &str, published: Vec<parser::AvailableCommand>) {
    let Ok(id) = agent_id(harness) else {
        return;
    };
    let rows: Vec<SlashCommand> = published
        .into_iter()
        .filter(|c| !c.name.is_empty() && !WITHHELD.contains(&c.name.as_str()))
        .map(|c| SlashCommand {
            description: crate::harness::claude_code::commands::first_sentence(&c.description),
            argument_hint: c.input.and_then(|i| i.hint).unwrap_or_default(),
            aliases: Vec::new(),
            name: c.name,
        })
        .collect();
    if !rows.is_empty() {
        COMMANDS.lock().unwrap().insert(format!("{id}\0{cwd}"), rows);
    }
}

struct ReaderHandles {
    client: RpcClient,
    session_id: String,
    session_cwd: String,
    harness: Harness,
    pending: PendingPermissions,
    app: Sink,
}

async fn read_stdout(
    stdout: ChildStdout,
    handles: ReaderHandles,
    ready: tokio::sync::oneshot::Receiver<AcpSession>,
    status: Arc<Mutex<StatusTracker>>,
    queued: QueuedMessages,
    seq: Arc<AtomicU64>,
) -> Result<()> {
    let harness = handles.harness;
    let mut lines = BufReader::new(stdout).lines();
    let mut mapper = mapper::Mapper::new(handles.session_id.clone(), harness, seq.clone());
    let mut ready = Some(ready);
    let mut transport: Option<Transport> = None;

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(err) => {
                eprintln!("[acp stdout err] {err}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        // Nothing is mapped until the session is open, which is what drops
        // `session/load`'s replay: it arrives before the load answers.
        if transport.is_none() {
            if let Some(rx) = &mut ready {
                match rx.try_recv() {
                    Ok(session) => {
                        transport = Some(Transport::Acp(session));
                        ready = None;
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => ready = None,
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                }
            }
        }

        let session = match transport.as_ref() {
            Some(Transport::Acp(session)) => Some(session),
            _ => None,
        };
        let event = match session.and_then(|s| prompt_answer(s, &line)) {
            Some(done) => done,
            None => match handles.client.accept(&line).await {
                Incoming::Notification { method, params } => match parser::parse_notification(&method, params) {
                    Ok(note) => {
                        if session.is_some_and(|s| !note.session_id.is_empty() && note.session_id != s.id) {
                            continue;
                        }
                        // Facts about the session rather than events in it, read
                        // even while a load replays.
                        match note.update {
                            SessionUpdate::SessionInfoUpdate { title } => {
                                if let (Some(title), Some(_)) = (title, session) {
                                    note_title(&handles, title).await;
                                }
                                continue;
                            }
                            SessionUpdate::AvailableCommandsUpdate { available_commands } => {
                                remember_commands(harness, &handles.session_cwd, available_commands);
                                continue;
                            }
                            SessionUpdate::ConfigOptionUpdate { config_options } => {
                                if let Some(session) = session {
                                    let next = SessionOptions::from_configs(&config_options);
                                    if !next.is_empty() {
                                        *session.options.lock().unwrap() = next;
                                        learn(session, &handles.app);
                                    }
                                }
                                continue;
                            }
                            // The agent moved itself, so the record follows and the
                            // picker is told to read it again.
                            SessionUpdate::CurrentModeUpdate { current_mode_id: Some(mode) } => {
                                if let Some(session) = session {
                                    note_current(session, Which::Mode, &mode);
                                    let _ = crate::store::set_session_agent_mode(&handles.session_id, &mode).await;
                                    let _ = handles.app.emit("models_changed", json!({"harness": harness}));
                                }
                                continue;
                            }
                            update => AcpEvent::Update(update),
                        }
                    }
                    Err(parser::ParseOutcome::Ignored) => continue,
                    Err(parser::ParseOutcome::Unknown) => {
                        record_failure(harness, &handles.session_id, "unknown_method", &method, &line).await;
                        continue;
                    }
                    Err(parser::ParseOutcome::Malformed(err)) => {
                        record_failure(harness, &handles.session_id, "map", &err.to_string(), &line).await;
                        continue;
                    }
                },

                // Every request blocks the agent until it is answered.
                Incoming::Request { id, method, params } => {
                    if let Err(err) = raise_request(&handles, &mapper, id.clone(), &method, params).await {
                        record_failure(harness, &handles.session_id, "unsupported_request", &err.to_string(), &line)
                            .await;
                        let _ = match method.as_str() {
                            "session/request_permission" => handles
                                .client
                                .respond(id, json!({"outcome": {"outcome": "cancelled"}})),
                            _ => handles.client.respond_err(id, -32601, "This client cannot answer that request."),
                        };
                    }
                    continue;
                }

                Incoming::Response { id, matched: false } => {
                    let detail = format!("no caller waiting on id {id}");
                    record_failure(harness, &handles.session_id, "stray_response", &detail, &line).await;
                    continue;
                }
                Incoming::Response { .. } => continue,
                Incoming::Malformed => {
                    record_failure(harness, &handles.session_id, "parse", "not a JSON-RPC message", &line).await;
                    continue;
                }
            },
        };

        let Some(transport) = transport.as_ref() else {
            continue;
        };
        let ingest = crate::session::Ingest {
            session_id: &handles.session_id,
            harness,
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

    // The child is gone. A prompt in flight will never answer, so the turn is
    // closed as failed — after the queue is stranded, so its flush finds
    // nothing to hand a dead child.
    if let Some(transport @ Transport::Acp(session)) = transport.as_ref() {
        let outstanding = session.prompt_id.lock().expect("acp prompt id poisoned").take().is_some();
        crate::session::strand_queue_on_exit(&handles.session_id, harness, &queued, &seq, &handles.app).await;
        if outstanding {
            let ingest = crate::session::Ingest {
                session_id: &handles.session_id,
                harness,
                session_cwd: &handles.session_cwd,
                status: &status,
                queued: &queued,
                flush_seq: &seq,
                flush_transport: transport,
            };
            let message = format!("{} exited before finishing this turn.", harness.label());
            for agent_event in mapper.map(AcpEvent::PromptFailed { message }) {
                crate::session::ingest(&ingest, agent_event, &handles.app).await;
            }
        }
    }
    Ok(())
}

/// The agent's title for the session, which it writes itself.
async fn note_title(handles: &ReaderHandles, title: String) {
    match crate::store::set_session_title(&handles.session_id, &title).await {
        Ok(None) => {}
        Ok(Some(_)) => {
            let payload = json!({"sessionId": handles.session_id, "title": title, "titleLocked": false});
            if let Err(err) = handles.app.emit("session_title", payload) {
                eprintln!("[acp title emit err] {err}");
            }
        }
        Err(err) => eprintln!("[acp title write err] {err}"),
    }
}

fn prompt_answer(session: &AcpSession, line: &str) -> Option<AcpEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("method").is_some() {
        return None;
    }
    let id = value.get("id").and_then(Value::as_i64)?;
    let mut running = session.prompt_id.lock().expect("acp prompt id poisoned");
    if *running != Some(id) {
        return None;
    }
    *running = None;

    if let Some(error) = value.get("error") {
        let message = error.get("message").and_then(Value::as_str).unwrap_or("The agent could not run this prompt");
        let message = match error.get("data").and_then(Value::as_str).filter(|d| !d.is_empty()) {
            Some(detail) => format!("{message}: {detail}"),
            None => message.to_string(),
        };
        return Some(AcpEvent::PromptFailed { message });
    }
    let response = value
        .get("result")
        .cloned()
        .and_then(|r| serde_json::from_value(r).ok())
        .unwrap_or_default();
    Some(AcpEvent::PromptDone(response))
}

/// Turns a permission request into the card that answers it.
async fn raise_request(
    handles: &ReaderHandles,
    mapper: &mapper::Mapper,
    rpc_id: RequestId,
    method: &str,
    params: Value,
) -> Result<()> {
    if method != "session/request_permission" {
        bail!("{method}");
    }
    let request: parser::PermissionRequest = serde_json::from_value(params)?;
    let call_id = request.tool_call.tool_call_id.clone();
    let known = mapper.call(&call_id);
    let input = request
        .tool_call
        .raw_input
        .clone()
        .or_else(|| known.map(|k| k.input.clone()))
        .unwrap_or(json!({}));
    let command = input.get("command").and_then(Value::as_str).map(str::to_string);
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let title = command
        .or(path.clone())
        .or(request.tool_call.title.clone())
        .or_else(|| known.and_then(|k| k.title.clone()));

    let tool_name = handles.harness.label();
    let (pending, options) =
        crate::harness::acp::pending_for("acp", &call_id, tool_name, &request.options, rpc_id);
    let request_id = rpc_request_id();
    handles
        .pending
        .lock()
        .expect("pending permissions mutex poisoned")
        .insert(request_id.clone(), pending);

    let event = mapper.synthesize(AgentEventPayload::PermissionRequested {
        request_id,
        tool_use_id: call_id,
        tool_name: tool_name.to_string(),
        display_name: None,
        title,
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

    /// What a Devin session teaches the picker: its model and its five modes,
    /// under Devin's own names.
    #[test]
    fn a_session_teaches_its_models_and_modes() {
        let new = include_str!("fixtures/devin_turn.jsonl")
            .lines()
            .filter_map(|l| l.strip_prefix("<< "))
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .find_map(|l| l.pointer("/result/sessionId").is_some().then(|| l["result"].clone()))
            .unwrap();
        let harness = Harness::Acp("devin-test");
        LEARNED.lock().unwrap().insert("devin-test".into(), SessionOptions::of(&new));

        let models = list_models(harness);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].arg, "swe-1-6-slow");

        let modes = modes(harness);
        assert_eq!(modes.current.as_deref(), Some("accept-edits"));
        assert_eq!(modes.modes.iter().find(|m| m.id == "accept-edits").unwrap().name, "Code");
        assert_eq!(modes.modes.len(), 5);
    }

    /// A model nothing has taught yet is still run as written.
    #[test]
    fn an_unlearned_model_is_taken_as_written() {
        let model = find_model(Harness::Acp("never-seen"), &ModelId::new("opus")).unwrap();
        assert_eq!(model.arg, "opus");
        assert!(find_model(Harness::Acp("never-seen"), &ModelId::default()).is_none());
    }
}
