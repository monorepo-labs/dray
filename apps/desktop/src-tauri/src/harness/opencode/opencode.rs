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
//!   `OPENCODE_PERMISSION` — so a stance change replaces the child. A subagent
//!   cannot ask, so its rules refuse instead; see [`stance_config`].
//! - **A fork is `session/fork` on the fork's first send**, Codex's lazy route.
//!   OpenCode files the copy under the parent's folder whatever `cwd` says, so
//!   only a fork in place is offered.
//! - **Rules ride `OPENCODE_CONFIG_CONTENT`** as an `instructions` file, read
//!   on every spawn; there is no system-prompt field on the wire.
//! - **OpenCode titles its own sessions and never says so on the wire.** The
//!   title is ready by the first turn's answer and `session/list` returns it,
//!   so it is read back from there — see [`note_title`].

pub mod commands;
pub mod mapper;
pub mod models;
pub mod parser;
pub mod questions;

use crate::attachments::PreparedImage;
use crate::events::{AgentEventPayload, ApprovalPolicy};
use crate::harness::acp::{self, PermissionChoice};
use crate::harness::claude_code::permissions::{rpc_request_id, PendingPermissions, PendingRequest, Reply};
use crate::harness::codex::rpc::{Incoming, RpcClient};
use crate::harness::{read_stderr, record_failure, Harness::OpenCode};
use crate::models::{Effort, Model};
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::sink::Sink;
use crate::store::{self, next_seq_by_session_id};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// Whether a prompt sent mid-turn joins the running turn through
    /// `_session/steering`, which OpenCode 2 advertises on `initialize`. 1
    /// does not, and queues to the turn's end.
    pub steers: bool,
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
    // The session this one is a fork of, on a fork's first send and never
    // again. Its index entry already holds the parent's OpenCode id.
    fork_from: Option<&str>,
    app: &Sink,
) -> Result<Session> {
    // Everything fallible goes ahead of the spawn, so no `?` can leave a child
    // nothing reaches.
    let seq_start = if is_new_session {
        0
    } else {
        next_seq_by_session_id(session_id).await?
    };
    let open = if is_new_session {
        Open::New
    } else {
        let recorded = store::get_session_index_item(session_id)
            .await?
            .and_then(|item| item.thread_id)
            .context("this session has no OpenCode session to resume")?;
        match fork_from {
            Some(_) => Open::Fork(recorded),
            None => Open::Resume(recorded),
        }
    };
    let rules = write_rules(session_id, session_cwd).await?;

    let bin = crate::binpath::opencode().await;
    let v2 = crate::binpath::opencode_v2().await;
    let agents = agents_refusing_edits(&bin, v2, permission_mode, cwd, session_cwd).await;
    let global = global_rules(permission_mode, agents.as_deref());
    let mut config = stance_config(&rules, permission_mode, agents.as_deref());
    // OpenCode 2 no longer reads `OPENCODE_PERMISSION`; the config's own
    // `permission` is the global list, appended after each agent's.
    if v2 {
        config["permission"] = children_ask(permission_mode, agents.as_deref(), &mut config);
        // 2 ships `todowrite` off; it is what fills Dray's task list, as 1's
        // did by default.
        config["experimental"] = json!({"todo": true});
    }
    let mut command = Command::new(&bin);
    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    let mut child = command
        .arg("acp")
        .current_dir(cwd)
        .env("DRAY_SESSION_ID", session_id)
        .env("PATH", crate::harness::agent_path(&bin))
        .env("OPENCODE_PERMISSION", global.to_string())
        .env("OPENCODE_CONFIG_CONTENT", config.to_string())
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

    let opened = open_session(&client, session_id, session_cwd, open, model, effort, permission_mode).await;
    let (id, effort, steers) = match opened {
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
        steers,
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

/// Dray's stance as OpenCode permission rules, for the agent Dray runs.
///
/// Set whole rather than left to the reader's config, because OpenCode's own
/// default allows everything and a stance that said otherwise would be a lie.
/// Plan is the `plan` agent, which refuses edits itself; its shell still asks.
/// Every rule OpenCode asks under by default is stated too — outside folders,
/// `.env` reads and `doom_loop` (a third identical call in a row) — so
/// [`refusing`] can turn it for subagents and Bypass can answer it. `dontAsk`
/// is never offered and runs as Auto.
fn permission_rules(mode: ApprovalPolicy) -> Value {
    let (edit, rest) = match mode {
        ApprovalPolicy::Plan | ApprovalPolicy::Manual => ("ask", "ask"),
        // Edits inside the project go through.
        ApprovalPolicy::Auto | ApprovalPolicy::DontAsk => ("allow", "ask"),
        ApprovalPolicy::BypassPermissions => ("allow", "allow"),
    };
    json!({
        "edit": edit,
        "bash": rest,
        "webfetch": rest,
        "external_directory": rest,
        "doom_loop": rest,
        // OpenCode's own patterns, in its order: the last match wins, so the
        // example file comes after the `*.env.*` it also matches.
        "read": {"*.env": rest, "*.env.*": rest, "*.env.example": "allow"},
    })
}

/// The rules with every `ask` turned into `deny`, patterns included.
///
/// **A subagent cannot ask.** Measured on 1.19.6: a `task` child's permission
/// ask is logged and never forwarded over ACP, so its turn waits for good.
/// Refused instead, the tool leaves the child's list and it works without it —
/// a child told to run `ls` listed the folder with `glob`.
fn refusing(rules: &Value) -> Value {
    match rules {
        Value::String(rule) if rule == "ask" => json!("deny"),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), refusing(v))).collect()),
        other => other.clone(),
    }
}

/// OpenCode 2's global rules: the stance itself, not [`refusing`] it.
///
/// 2 forwards a subagent's ask over ACP (measured on 2.4.2: a `general`
/// child's `ls -1` arrived as `session/request_permission` on the parent's id,
/// tagged `_meta["opencode/child-session"]`), so a child asks where 1's could
/// only be refused. Edits stay off the global list for [`global_rules`]'
/// reason, and the per-agent refusals [`stance_config`] wrote become asks under
/// Manual; under Plan nothing edits, children included.
fn children_ask(mode: ApprovalPolicy, agents: Option<&[String]>, config: &mut Value) -> Value {
    let plan = matches!(mode, ApprovalPolicy::Plan);
    let mut rules = permission_rules(mode);
    if let Some(map) = rules.as_object_mut() {
        if agents.is_some() || !asks_for_edits(mode) {
            map.remove("edit");
        } else if plan {
            map.insert("edit".into(), json!("deny"));
        }
    }
    if !plan {
        if let Some(listed) = config["agent"].as_object_mut() {
            for (name, agent) in listed.iter_mut() {
                if !matches!(name.as_str(), "build" | "plan") && agent["permission"]["edit"] == "deny" {
                    agent["permission"]["edit"] = json!("ask");
                }
            }
        }
    }
    rules
}

/// Whether this stance asks before an edit, which no subagent can do.
fn asks_for_edits(mode: ApprovalPolicy) -> bool {
    permission_rules(mode)["edit"] == "ask"
}

/// `OPENCODE_PERMISSION`, which every agent gets: the stance refused, minus
/// `edit`.
///
/// OpenCode appends these after each agent's own rules and the last match
/// wins, so an `edit` here overrode them: `explore` refuses edits itself and
/// gained them under Auto, and `plan` allows its own plan files and lost them
/// under Plan. Edits are refused per agent in [`stance_config`] instead.
/// `agents` is `None` where OpenCode could not name its agents; edits are then
/// refused here, for every agent, at the cost of `plan`'s plan files.
fn global_rules(mode: ApprovalPolicy, agents: Option<&[String]>) -> Value {
    let mut rules = refusing(&permission_rules(mode));
    if let Some(map) = rules.as_object_mut() {
        if agents.is_some() || !asks_for_edits(mode) {
            map.remove("edit");
        }
    }
    rules
}

/// `OPENCODE_CONFIG_CONTENT`: Dray's rules file, the stance whole for `build`
/// and `plan` over [`global_rules`], and edits refused for every other agent
/// in `agents`.
///
/// `plan` takes no `edit` key, so its own refusal of edits, and its plan
/// files, stand. Merged deep over the reader's config — an agent of theirs
/// keeps its prompt and mode and loses only `edit` — and `instructions` is a
/// list OpenCode concatenates, so their own instruction files stay.
fn stance_config(rules_path: &str, mode: ApprovalPolicy, agents: Option<&[String]>) -> Value {
    let build = permission_rules(mode);
    let mut plan = build.clone();
    if let Some(map) = plan.as_object_mut() {
        map.remove("edit");
    }
    let mut config = json!({
        "instructions": [rules_path],
        "agent": {"build": {"permission": build}, "plan": {"permission": plan}},
    });
    let listed = if asks_for_edits(mode) { agents.unwrap_or_default() } else { &[] };
    for name in listed.iter().filter(|name| !matches!(name.as_str(), "build" | "plan")) {
        config["agent"][name] = json!({"permission": {"edit": "deny"}});
    }
    config
}

/// Every agent OpenCode will run here, when the stance asks before edits:
/// those are the agents whose edits must be refused by name.
///
/// Read from `opencode agent list`, or 2's `opencode debug agents`, which name
/// the built-ins, the reader's own from `opencode.json` and `.opencode/agent/`,
/// and any a plugin adds. 2 answers `agent list` with its help and a clean
/// exit, so the two are never tried in turn. Empty where nothing needs
/// refusing, so Auto and Bypass skip the call, about a second; `None` where
/// OpenCode could not answer, which [`global_rules`] covers.
async fn agents_refusing_edits(
    bin: &std::path::Path,
    v2: bool,
    mode: ApprovalPolicy,
    cwd: &str,
    session_cwd: &str,
) -> Option<Vec<String>> {
    if !asks_for_edits(mode) {
        return Some(Vec::new());
    }
    // The folder OpenCode opens the session in decides which project config
    // it reads; a worktree not made yet falls back to where the child starts.
    let dir = if std::path::Path::new(session_cwd).is_dir() { session_cwd } else { cwd };
    let (args, parse): (&[&str], fn(&str) -> Option<Vec<String>>) = if v2 {
        (&["debug", "agents"], parse_agents_json)
    } else {
        (&["agent", "list"], |out| Some(parse_agent_list(out)))
    };
    let listed = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        Command::new(bin)
            .args(args)
            .current_dir(dir)
            .env("PATH", crate::harness::agent_path(bin))
            // Null, never a pipe: an OpenCode command with an open stdin and
            // no TTY can wait on it for good.
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let reason = match listed {
        Ok(Ok(out)) if out.status.success() => match parse(&String::from_utf8_lossy(&out.stdout)) {
            Some(agents) => return Some(agents),
            None => "the agent list did not parse".to_string(),
        },
        Ok(Ok(out)) => format!("{}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim()),
        Ok(Err(err)) => err.to_string(),
        Err(_) => "timed out".to_string(),
    };
    eprintln!("[opencode] couldn't list agents, so edits are refused to every agent: {reason}");
    None
}

/// Reads `opencode agent list`: a `name (mode)` line per agent, each followed
/// by its rules indented beneath it.
fn parse_agent_list(out: &str) -> Vec<String> {
    out.lines()
        .filter(|line| !line.starts_with(char::is_whitespace))
        .filter_map(|line| line.trim_end().strip_suffix(')')?.rsplit_once(" (").map(|(name, _)| name))
        .filter(|name| !name.is_empty() && !name.contains(char::is_whitespace))
        .map(str::to_string)
        .collect()
}

/// Reads `opencode debug agents`: a JSON array of agents, each with its `id`.
/// `None` for anything else, so a changed answer refuses edits globally rather
/// than naming no agent at all.
fn parse_agents_json(out: &str) -> Option<Vec<String>> {
    let agents: Vec<Value> = serde_json::from_str(out).ok()?;
    Some(
        agents
            .iter()
            .filter_map(|agent| agent.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect(),
    )
}

/// The agent a stance runs as: `plan` for Plan, `build` for the rest. Always
/// one of the two, since they are the agents holding the asking rules.
fn stance_agent(mode: ApprovalPolicy, current: Option<&str>) -> Option<&'static str> {
    let wanted = match mode {
        ApprovalPolicy::Plan => "plan",
        _ => "build",
    };
    (current != Some(wanted)).then_some(wanted)
}

/// How a spawn reaches its OpenCode session.
enum Open {
    New,
    Resume(String),
    /// A fork's first send: the parent's OpenCode id, copied onto the fork's
    /// index entry when it was forked.
    Fork(String),
}

/// `initialize`, `session/new` or `session/resume`, then the reader's model,
/// effort and stance. Answers OpenCode's id and the effort that landed.
async fn open_session(
    client: &RpcClient,
    session_id: &str,
    session_cwd: &str,
    open: Open,
    model: Option<&Model>,
    effort: Option<Effort>,
    mode: ApprovalPolicy,
) -> Result<(String, Option<Effort>, bool)> {
    let hello = client
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                // No `fs` and no `terminal`: OpenCode reads and writes through
                // its own tools. `elicitation.form` is what lets OpenCode 2's
                // `question` tool reach the reader; 1 ignores it.
                "clientCapabilities": {"elicitation": {"form": {}}},
                "clientInfo": {"name": "dray", "title": "Dray", "version": env!("CARGO_PKG_VERSION")},
            }),
        )
        .await?;

    // MCP is OpenCode's own: it reads the reader's config, so Dray hands over
    // nothing.
    let (id, mut config) = match open {
        Open::Resume(id) => {
            let answer = client
                .request("session/resume", json!({"sessionId": id, "cwd": session_cwd, "mcpServers": []}))
                .await
                .with_context(|| format!("couldn't resume OpenCode session {id}"))?;
            (id, answer)
        }
        // The answer is the copy, opened. OpenCode replays the parent's history
        // ahead of it, which the read loop drops: nothing is drawn until the
        // session is handed over, and Dray's own copied log is the transcript.
        Open::Fork(parent) => {
            let answer = client
                .request("session/fork", json!({"sessionId": parent, "cwd": session_cwd, "mcpServers": []}))
                .await
                .with_context(|| format!("couldn't fork OpenCode session {parent}"))?;
            let id = answer
                .get("sessionId")
                .and_then(Value::as_str)
                .context("session/fork answered with no session id")?
                .to_string();
            store::set_session_thread_id(session_id, &id).await?;
            (id, answer)
        }
        Open::New => {
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
    let steers = hello.pointer("/_meta/steering/supported").and_then(Value::as_bool) == Some(true);
    Ok((id, effort, steers))
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

/// Moves a live session onto another model, mid-turn included, and answers
/// the effort it runs at after.
///
/// OpenCode resets effort to the new model's default (`none`) on every model
/// change, so the reader's level is sent again where the new model offers it —
/// [`open_session`]'s order, model then effort.
pub async fn set_model(session: &OpenCodeSession, model: &Model, effort: Option<Effort>) -> Result<Option<Effort>> {
    let config = set_config(&session.client, &session.id, "model", &model.arg).await?;
    let effort = effort.filter(|level| offers(&config, "effort", level.as_arg()));
    if let Some(level) = effort {
        set_config(&session.client, &session.id, "effort", level.as_arg()).await?;
    }
    Ok(effort)
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
    let prompt = prompt_blocks(text, images);

    // Held across the send: a refusal can answer before this returns, and the
    // reader takes this same lock.
    let mut running = session.prompt_id.lock().expect("opencode prompt id poisoned");
    let id = session
        .client
        .request_detached("session/prompt", json!({"sessionId": session.id, "prompt": prompt}))?;
    *running = Some(id);
    Ok(())
}

fn prompt_blocks(text: &str, images: &[PreparedImage]) -> Vec<Value> {
    let mut prompt = vec![json!({"type": "text", "text": text})];
    prompt.extend(
        images
            .iter()
            .map(|image| json!({"type": "image", "mimeType": image.mime_type, "data": image.data})),
    );
    prompt
}

/// Hands a prompt to the running turn through OpenCode 2's `_session/steering`,
/// which it reads at the turn's next step. `false` where the turn had already
/// ended — "promptRequired" — which leaves the prompt for the caller to open a
/// turn with.
pub async fn steer(session: &OpenCodeSession, text: &str, images: &[PreparedImage]) -> Result<bool> {
    let answer = session
        .client
        .request("_session/steering", json!({"sessionId": session.id, "prompt": prompt_blocks(text, images)}))
        .await?;
    Ok(answer.get("outcome").and_then(Value::as_str) == Some("injected"))
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

/// How long a turn OpenCode woke on its own may go quiet before it is closed.
const WAKE_QUIET: std::time::Duration = std::time::Duration::from_secs(10);

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
    // Set once OpenCode's own title has been read back, so later turns ask
    // nothing.
    let titled = Arc::new(AtomicBool::new(false));

    loop {
        // OpenCode 2 wakes the parent on its own when a background subagent
        // reports after the turn, and that turn has no `session/prompt` whose
        // answer would close it. Nothing on the wire ends it, so it is closed
        // once it goes quiet between steps with no card waiting.
        // ponytail: a quiet timer; a slow first token past it splits the
        // wake-up into two turns. An end marker from OpenCode would replace it.
        let promptless = match &transport {
            Some(Transport::OpenCode(session)) => {
                mapper.between_steps()
                    && session.prompt_id.lock().expect("opencode prompt id poisoned").is_none()
                    && handles.pending.lock().expect("pending permissions mutex poisoned").is_empty()
            }
            _ => false,
        };
        let next = if promptless {
            match tokio::time::timeout(WAKE_QUIET, lines.next_line()).await {
                Ok(next) => next,
                Err(_) => {
                    let done = parser::OpenCodeEvent::PromptDone(Box::new(parser::PromptResponse {
                        stop_reason: "end_turn".into(),
                        ..Default::default()
                    }));
                    if let Some(transport) = transport.as_ref() {
                        let ingest = crate::session::Ingest {
                            session_id: &handles.session_id,
                            harness: OpenCode,
                            session_cwd: &handles.session_cwd,
                            status: &status,
                            queued: &queued,
                            flush_seq: &seq,
                            flush_transport: transport,
                        };
                        for agent_event in mapper.map(done) {
                            crate::session::ingest(&ingest, agent_event, &handles.app).await;
                        }
                    }
                    continue;
                }
            }
        } else {
            lines.next_line().await
        };
        let line = match next {
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
                            update => match note.child {
                                Some(child) => parser::OpenCodeEvent::ChildUpdate { child, update },
                                None => parser::OpenCodeEvent::Update(update),
                            },
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
        if let (parser::OpenCodeEvent::PromptDone(_), Some(session)) = (&event, session) {
            if !titled.load(Ordering::Relaxed) {
                tokio::spawn(note_title(session.clone(), handles.session_cwd.clone(), handles.session_id.clone(), handles.app.clone(), titled.clone()));
            }
        }
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

/// Records OpenCode's own title for this session and tells the sidebar.
///
/// Spawned off the read loop, which is what routes the answer. A title not
/// written yet ("New session - <time>") leaves `titled` unset, so the next
/// turn asks again. A name the reader typed wins over it in the store.
async fn note_title(session: OpenCodeSession, cwd: String, session_id: String, app: Sink, titled: Arc<AtomicBool>) {
    let Ok(list) = session.client.request("session/list", json!({"cwd": cwd})).await else {
        return;
    };
    let Some(title) = own_title(&list, &session.id) else {
        return;
    };
    titled.store(true, Ordering::Relaxed);
    match store::set_session_title(&session_id, &title).await {
        Ok(Some(_)) => {
            let payload = json!({"sessionId": session_id, "title": title, "titleLocked": false});
            if let Err(err) = app.emit("session_title", payload) {
                eprintln!("[opencode title emit err] {err}");
            }
        }
        Ok(None) => {}
        Err(err) => eprintln!("[opencode title write err] {err}"),
    }
}

/// OpenCode's title for `id` in a `session/list` answer, or `None` while it is
/// still the placeholder OpenCode opens every session with.
///
/// shortcut: reads the first page alone (100 sessions, newest first), where a
/// session that has just answered always sits; page on `nextCursor` if not.
fn own_title(list: &Value, id: &str) -> Option<String> {
    list.get("sessions")?
        .as_array()?
        .iter()
        .find(|s| s["sessionId"] == id)?
        .get("title")?
        .as_str()
        .filter(|t| !t.is_empty() && !t.starts_with("New session - "))
        .map(str::to_string)
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
        "elicitation/create" => {
            if let Err(err) = raise_question(handles, mapper, rpc_id, &params) {
                record_failure(OpenCode, &handles.session_id, "unsupported_request", &err.to_string(), line).await;
                // `cancel` ends the form and the turn moves on.
                let _ = handles.client.respond(rpc_id, json!({"action": "cancel"}));
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
    // OpenCode 2 tags a subagent's ask with the child it came from; the card
    // names it, since the call it asks about is drawn nowhere else.
    let child = params
        .pointer("/toolCall/_meta/opencode~1child-session/title")
        .and_then(Value::as_str)
        .map(|title| format!("Subagent · {title}"));
    let request: parser::PermissionRequest = serde_json::from_value(params)?;
    let call = &request.tool_call;
    let choices: Vec<PermissionChoice> = request.options.clone();
    let (pending, options) = acp::pending_for("opencode", &call.tool_call_id, call.kind.name(), &choices, rpc_id);

    let input = ask_input(call.raw_input.as_ref(), mapper.running_input(&call.tool_call_id));
    let path = ["filepath", "filePath", "file_path"]
        .iter()
        .find_map(|key| input.get(key)?.as_str())
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
        description: child,
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

/// Holds an OpenCode 2 question form and draws the question card. The pending
/// entry's `input` is what [`questions::answer`] maps the answers back with.
fn raise_question(handles: &ReaderHandles, mapper: &mapper::Mapper, rpc_id: i64, params: &Value) -> Result<()> {
    let (questions, lookup) = questions::read(params).context("a form the question card cannot draw")?;
    let tool_use_id = params.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_string();
    let request_id = rpc_request_id();
    handles.pending.lock().expect("pending permissions mutex poisoned").insert(
        request_id.clone(),
        PendingRequest {
            tool_use_id: tool_use_id.clone(),
            tool_name: "question".to_string(),
            input: lookup,
            options: HashMap::new(),
            reply: Reply::Rpc(rpc_id),
        },
    );
    let event = mapper.synthesize(AgentEventPayload::QuestionsAsked {
        request_id,
        tool_use_id,
        questions,
    });
    handles.app.emit("agent_event", &event)?;
    Ok(())
}

/// What a card shows as the call's subject: the ask's own input, or, where it
/// carries none, the input the running call was drawn with.
fn ask_input(raw: Option<&Value>, running: Option<&Value>) -> Value {
    let own = raw.filter(|input| match input {
        Value::Object(map) => !map.is_empty(),
        other => !other.is_null(),
    });
    own.or(running).cloned().unwrap_or(json!({}))
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
        assert_eq!(stance_agent(ApprovalPolicy::Auto, Some("build")), None);
        // A default agent of the reader's own holds no asking rules.
        assert_eq!(stance_agent(ApprovalPolicy::Auto, Some("my-agent")), Some("build"));

        assert_eq!(permission_rules(ApprovalPolicy::Plan)["bash"], "ask");
        assert_eq!(permission_rules(ApprovalPolicy::Manual)["edit"], "ask");
        assert_eq!(permission_rules(ApprovalPolicy::Auto)["edit"], "allow");
        assert_eq!(permission_rules(ApprovalPolicy::Auto)["bash"], "ask");
        assert_eq!(permission_rules(ApprovalPolicy::BypassPermissions)["bash"], "allow");
    }

    /// On OpenCode 2 a child's ask reaches Dray, so children ask under the
    /// stance: Manual's per-agent edit refusals become asks, Plan keeps them.
    /// The capture is a live 2.4.2 child asking for `ls -1`.
    #[test]
    fn opencode_2_children_ask_instead_of_being_refused() {
        let agents = vec!["build".to_string(), "plan".to_string(), "general".to_string()];
        let mut manual = stance_config("/r.md", ApprovalPolicy::Manual, Some(&agents));
        let global = children_ask(ApprovalPolicy::Manual, Some(&agents), &mut manual);
        assert_eq!(global["bash"], "ask");
        assert!(global.get("edit").is_none());
        assert_eq!(manual["agent"]["general"]["permission"]["edit"], "ask");

        let mut plan = stance_config("/r.md", ApprovalPolicy::Plan, Some(&agents));
        children_ask(ApprovalPolicy::Plan, Some(&agents), &mut plan);
        assert_eq!(plan["agent"]["general"]["permission"]["edit"], "deny");
        assert_eq!(children_ask(ApprovalPolicy::Plan, None, &mut json!({}))["edit"], "deny");

        let line = include_str!("fixtures/child_permission_v2.jsonl")
            .lines()
            .find(|l| l.contains("session/request_permission"))
            .unwrap();
        let ask: Value = serde_json::from_str(&line[3..]).unwrap();
        let title = ask.pointer("/params/toolCall/_meta/opencode~1child-session/title").and_then(Value::as_str);
        assert_eq!(title, Some("List directory contents"));
    }

    /// What would ask is refused for every agent but the two Dray runs, which
    /// get the asking rules back — a subagent's ask never reaches Dray, and a
    /// refused tool leaves its list rather than hanging the turn.
    #[test]
    fn subagents_are_refused_what_they_cannot_ask_for() {
        // OpenCode's own default asks are refused too: a child reading `.env`
        // or tripping `doom_loop` hung the turn with no card.
        let global = global_rules(ApprovalPolicy::Auto, Some(&[]));
        assert_eq!(
            global,
            json!({
                "bash": "deny", "webfetch": "deny", "external_directory": "deny", "doom_loop": "deny",
                "read": {"*.env": "deny", "*.env.*": "deny", "*.env.example": "allow"},
            })
        );
        // Last match wins inside a pattern map too, so the order is OpenCode's.
        let patterns: Vec<&String> = global["read"].as_object().unwrap().keys().collect();
        assert_eq!(patterns, ["*.env", "*.env.*", "*.env.example"]);

        let config = stance_config("/r.md", ApprovalPolicy::Auto, Some(&[]));
        assert_eq!(config["instructions"], json!(["/r.md"]));
        assert_eq!(config["agent"]["build"]["permission"], permission_rules(ApprovalPolicy::Auto));
        assert_eq!(config["agent"]["build"]["permission"]["read"]["*.env"], "ask");

        // Bypass asks nothing, `.env` and loops included.
        let bypass = global_rules(ApprovalPolicy::BypassPermissions, Some(&[]));
        assert_eq!(bypass["doom_loop"], "allow");
        assert_eq!(bypass["read"]["*.env"], "allow");
    }

    /// `edit` is never global while OpenCode can name its agents: it puts the
    /// global rules after each agent's own, so one there overrode `explore`'s
    /// refusal under Auto and `plan`'s own plan files under Plan.
    #[test]
    fn edits_are_refused_per_agent() {
        let agents: Vec<String> = ["build", "plan", "general", "explore", "scribe"].map(String::from).into();
        for mode in [
            ApprovalPolicy::Plan,
            ApprovalPolicy::Manual,
            ApprovalPolicy::Auto,
            ApprovalPolicy::BypassPermissions,
        ] {
            assert!(global_rules(mode, Some(&agents)).get("edit").is_none(), "{mode:?}");
            let config = stance_config("/r.md", mode, Some(&agents));
            assert!(config["agent"]["plan"]["permission"].get("edit").is_none(), "{mode:?}");
        }

        // Where the stance asks before an edit, every agent but the two Dray
        // runs is refused, the reader's own included: none of them can ask.
        let manual = stance_config("/r.md", ApprovalPolicy::Manual, Some(&agents));
        assert_eq!(manual["agent"]["build"]["permission"]["edit"], "ask");
        for name in ["general", "explore", "scribe"] {
            assert_eq!(manual["agent"][name], json!({"permission": {"edit": "deny"}}), "{name}");
        }

        // Where edits go through, an agent keeps its own rule — `explore`'s
        // refusal above all.
        let auto = stance_config("/r.md", ApprovalPolicy::Auto, Some(&agents));
        assert_eq!(auto["agent"]["build"]["permission"]["edit"], "allow");
        assert!(auto["agent"].get("explore").is_none());
        assert!(auto["agent"].get("scribe").is_none());
    }

    /// No list, no names: edits are then refused for every agent at once,
    /// which costs `plan` its plan files but lets nothing edit unasked.
    #[test]
    fn an_unknown_agent_list_refuses_edits_globally() {
        assert_eq!(global_rules(ApprovalPolicy::Plan, None)["edit"], "deny");
        assert_eq!(global_rules(ApprovalPolicy::Manual, None)["edit"], "deny");
        assert!(global_rules(ApprovalPolicy::Auto, None).get("edit").is_none());
        let manual = stance_config("/r.md", ApprovalPolicy::Manual, None);
        assert_eq!(manual["agent"]["build"]["permission"]["edit"], "ask");
    }

    /// `opencode agent list` as 1.19.5 prints it: a `name (mode)` line, then
    /// the agent's rules indented beneath.
    #[test]
    fn the_agent_list_names_every_agent() {
        let out = "build (primary)\n  [\n  {\n    \"permission\": \"*\",\n    \"action\": \"allow\"\n  }\n]\n\
                   explore (subagent)\n  [\n]\nmdhelper (subagent)\n  [\n]\nscribe (all)\n  [\n]\n";
        assert_eq!(parse_agent_list(out), ["build", "explore", "mdhelper", "scribe"]);
        assert!(parse_agent_list("").is_empty());
    }

    /// `opencode debug agents` as 2.4.1 prints it, trimmed to the fields read.
    /// Its help text, which 2 prints for `agent list`, is no list at all.
    #[test]
    fn opencode_2s_agent_list_names_every_agent() {
        let out = r#"[{"id":"build","name":"build","mode":"primary","permissions":[]},
                      {"id":"explore","name":"explore","mode":"subagent"},
                      {"id":"reviewer","name":"reviewer","mode":"subagent"}]"#;
        assert_eq!(parse_agents_json(out).unwrap(), ["build", "explore", "reviewer"]);
        assert_eq!(parse_agents_json("DESCRIPTION\n  OpenCode command line interface\n"), None);
    }

    /// OpenCode's ask for a `.env` read carries `rawInput: {}`, so the card
    /// takes the running call's input, which names the file.
    #[test]
    fn an_ask_with_no_input_takes_the_running_calls() {
        let running = json!({"file_path": "/p/.env"});
        assert_eq!(ask_input(Some(&json!({})), Some(&running)), running);
        assert_eq!(ask_input(None, Some(&running)), running);
        assert_eq!(ask_input(Some(&Value::Null), None), json!({}));
        let own = json!({"command": "ls"});
        assert_eq!(ask_input(Some(&own), Some(&running)), own);
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

    /// Shapes as `session/list` answered on 1.19.5, before and after the
    /// first turn.
    #[test]
    fn the_title_is_read_back_once_opencode_has_written_one() {
        let before = json!({"sessions": [
            {"sessionId": "ses_a", "cwd": "/p", "title": "New session - 2026-11-23T10:16:53.976Z", "updatedAt": "x"},
        ]});
        assert_eq!(own_title(&before, "ses_a"), None);

        let after = json!({"sessions": [
            {"sessionId": "ses_b", "cwd": "/p", "title": "Something else", "updatedAt": "x"},
            {"sessionId": "ses_a", "cwd": "/p", "title": "Binary search tree explanation", "updatedAt": "x"},
        ]});
        assert_eq!(own_title(&after, "ses_a").as_deref(), Some("Binary search tree explanation"));
        assert_eq!(own_title(&after, "ses_c"), None);
    }

    /// `session/fork` replays the parent's history as updates **ahead of** its
    /// answer, under the copy's id. Nothing is drawn before the session is
    /// handed over, which happens after that answer, so the replay never
    /// reaches the transcript — this pins the ordering that rests on.
    #[test]
    fn a_fork_replays_the_parent_before_it_answers() {
        let lines: Vec<Value> = include_str!("fixtures/fork.jsonl")
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line.strip_prefix("<< ")?).ok())
            .collect();
        let answered = lines.iter().position(|l| l["id"] == 2).expect("the fork answered");
        let fork = lines[answered]["result"]["sessionId"].as_str().expect("the copy's id");

        let replayed: Vec<&Value> = lines[..answered].iter().filter(|l| l["method"] == "session/update").collect();
        assert!(!replayed.is_empty(), "1.19 replays the parent");
        assert!(replayed.iter().all(|l| l["params"]["sessionId"] == fork));
        assert!(replayed.iter().any(|l| l["params"]["update"]["sessionUpdate"] == "user_message_chunk"));
    }

    #[test]
    fn the_rules_name_opencodes_own_tools() {
        assert!(SYSTEM_PROMPT.contains("You run inside Dray"));
        assert!(SYSTEM_PROMPT.contains("`skill` tool"));
        assert!(SYSTEM_PROMPT.contains("`task` tool"));
    }
}
