//! Grok Build, spoken over `grok agent --no-leader stdio`.
//!
//! ACP, the same shape [`fx`](crate::harness::fx) has and the same framing —
//! [`rpc`](crate::harness::rpc) verbatim — including the one structural fact
//! that drives both: **a prompt is a request that blocks for the whole turn.**
//! `session/prompt` answers with the stop reason once the model is done, so the
//! turn's end arrives as a *response* rather than a notification, and the read
//! loop watches for that id itself instead of registering a waiter (a waiter's
//! timeout is for acknowledgements, and a turn runs for minutes).
//!
//! Four things differ from fx and each is measured, not assumed:
//!
//! - **Dray picks the session id.** `_meta.sessionId` on `session/new` is
//!   honoured and `session/resume` in a fresh process finds it, so the index id
//!   *is* the resume handle and `thread_id` stays `None`.
//! - **Rules ride `session/new._meta.rules`** and persist onto grok's own
//!   session record — a resume in a fresh process sending no rules still obeyed
//!   them. So there is no prompt to append to and nothing to strip on the way
//!   out, which is fx's one exception to the transcript showing what the model
//!   was told.
//! - **Two notification streams**, ACP's `session/update` and grok's own
//!   `_x.ai/session_notification`, and every one of them has to be filtered on
//!   `params.sessionId`: a `spawn_subagent` child streams its whole transcript
//!   down the parent's pipe under its own id.
//! - **The stance cannot move in place.** `session/set_mode` is inert, so a
//!   change replaces the child — see [`Harness::caps`](crate::harness::Harness).
//!
//! Rejected: `grok -p --output-format streaming-messages-json` parses with
//! Dray's Claude Code parser almost unchanged and is read-only and single-turn
//! — no stdin input format, no permission channel. See
//! `apps/desktop/GROK-PLAN.md`.

pub mod commands;
pub mod mapper;
pub mod models;
pub mod parser;
pub mod permissions;
pub mod probe;

use crate::events::{AgentEvent, AgentEventPayload, ApprovalPolicy};
use crate::harness::claude_code::permissions::PendingPermissions;
use crate::harness::codex::rpc::{Incoming, RpcClient};
use crate::harness::{read_stderr, record_failure, Harness::Grok};
use crate::models::{Effort, Model};
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::store::next_seq_by_session_id;
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

/// Dray's rules, which grok takes as a real field rather than as prompt text.
///
/// `_meta.rules` on `session/new` is "appended to the system prompt", and it
/// **persists onto the session**: a codeword rule sent once was obeyed on the
/// first turn and again after `session/resume` in a fresh process with no rules
/// sent. So this rides creation alone.
///
/// Its own file rather than fx's or pi's, because each has to name the tools its
/// own agent actually has — grok's are `ask_user_question` and `spawn_subagent`.
const SYSTEM_PROMPT: &str = include_str!("system_prompt.md");

/// How long a child is given to leave after `session/close` and EOF before it
/// is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// The connection every write is addressed to.
///
/// Cloneable, and the read loop holds a clone: both halves have to agree about
/// which prompt is running, since the reader is what sees it answered.
#[derive(Clone, Debug)]
pub struct GrokSession {
    pub client: RpcClient,
    /// **Dray's own id**, which grok adopted — not one grok minted. So this is
    /// the index's `session_id` and the `--resume` handle both, and no
    /// `thread_id` slot is needed.
    pub id: String,
    /// The JSON-RPC id of the `session/prompt` now running, or `None` between
    /// turns. The read loop settles the turn on that id's response.
    prompt_id: Arc<std::sync::Mutex<Option<i64>>>,
}

/// Spawns a session's `grok agent stdio`, handshakes it and opens or resumes its
/// session.
#[allow(clippy::too_many_arguments)]
pub async fn init(
    session_id: &str,
    model: Option<&Model>,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    fast: bool,
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

    let bin = crate::binpath::grok().await;
    let mut command = Command::new(&bin);
    probe::child_env(&mut command, &bin);

    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    // **Agent-level flags go between `agent` and `stdio`.** `--allow`,
    // `--permission-mode` and `--rules` are TUI and headless flags and are
    // refused outright here (`error: unexpected argument`), which is why the
    // stance rides `_meta` and the rules ride `session/new`.
    //
    // `--no-leader` regardless of the reader's `[cli] use_leader`, which
    // defaults off: turned on, every Dray session would be multiplexed through
    // one shared grok process.
    command.args(["agent", "--no-leader"]);
    // The fast tier is a model id rather than a flag, so the switch is resolved
    // here and `--model` carries whichever of the pair was asked for. It has to
    // ride the resume too: dropped on a respawn the session would come back at
    // standard speed with the composer's switch still on.
    let model_arg = match model.filter(|m| !m.arg.is_empty()) {
        Some(model) => Some(models::fast_arg(&model.arg, fast).await),
        None => None,
    };
    if let Some(arg) = &model_arg {
        command.args(["--model", arg]);
    }
    // Withheld for a model with no ladder, so grok uses its own default rather
    // than being handed a level it would refuse. The ladder is closed at four
    // (`low medium high xhigh`, case-sensitive) and 4.5 stops at `high`.
    if let Some(effort) = effort.filter(|_| takes_effort(model, effort)) {
        command.args(["--reasoning-effort", effort.as_arg()]);
    }
    command.arg("stdio");

    let mut child = command
        .current_dir(cwd)
        .env("DRAY_SESSION_ID", session_id)
        // **Trust is a per-child decision and this is it.** grok gates the
        // repo's own `CLAUDE.md`/`AGENTS.md`, its project hooks, project skills
        // and project MCP servers behind `~/.grok/trusted_folders.toml` — and
        // over stdio it **never asks**: no `folder_trust` request reaches the
        // client on any capture, the folder is simply untrusted and every one of
        // those surfaces silently missing. A Dray worktree under
        // `<project>/.claude/worktrees/<name>` is its own workspace to grok
        // ("a nested git checkout is a separate workspace"), so even a trusted
        // project would not cover it. Claude Code under Dray runs the repo's
        // hooks and MCP with no prompt either, so this is parity rather than an
        // escalation — but it *is* Dray deciding, and grok's own note is that
        // the grant "is process-local only and will not survive restart", which
        // is exactly the scope of this variable.
        .env("GROK_FOLDER_TRUST", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("couldn't start grok")?;

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
    // The ring's denominator, learned from the session's own reply below and
    // read by the mapper for every occupancy it publishes. Shared rather than
    // passed, because an in-place model switch moves it.
    let window = Arc::new(std::sync::atomic::AtomicU64::new(
        models::DEFAULT_CONTEXT_WINDOW,
    ));

    tokio::spawn({
        let events = events.clone();
        let status = status.clone();
        let queued = queued.clone();
        let seq = seq.clone();
        let window = window.clone();
        async move {
            if let Err(error) =
                read_stdout(stdout, reader, ready_rx, events, status, queued, seq, window).await
            {
                eprintln!("Failed to read grok stdout: {error}");
            }
        }
    });

    tokio::spawn(async move {
        if let Err(error) = read_stderr(Grok, stderr).await {
            eprintln!("Failed to read grok stderr: {error}");
        }
    });

    let answer = match open_session(&client, session_id, session_cwd, permission_mode, is_new_session)
        .await
    {
        Ok(answer) => answer,
        Err(error) => {
            // Post-spawn, so the child is running with nobody left to talk to
            // it. A `Child` is not reaped on drop.
            let _ = child.kill().await;
            return Err(error);
        }
    };
    window.store(models::window_of(&answer), std::sync::atomic::Ordering::Relaxed);

    let session = GrokSession {
        client,
        id: session_id.to_string(),
        prompt_id: Arc::new(std::sync::Mutex::new(None)),
    };
    let _ = ready_tx.send(session.clone());

    Ok(Session {
        id: session_id.to_string(),
        child,
        stdin: Transport::Grok(session),
        harness: Grok,
        model: model.map(|m| m.id.clone()).unwrap_or_default(),
        effort,
        permission_mode,
        // grok's faster tier is a model of its own, so nothing here is a speed
        // the child was told about.
        fast: false,
        events,
        seq,
        status,
        pending_permissions: pending,
        queued,
    })
}

/// Whether this model has the level being asked for, so the flag can be
/// withheld rather than refused.
///
/// `None` for the model means grok picks, and a level sent alongside no model is
/// still legal — every model grok currently ships reasons. An unknown model
/// resolves with an empty ladder (see [`models::resolve`]), which reads here as
/// "say nothing and let grok's default stand".
fn takes_effort(model: Option<&Model>, effort: Option<Effort>) -> bool {
    let Some(effort) = effort else {
        return false;
    };
    match model {
        Some(model) => model.efforts.contains(&effort),
        None => true,
    }
}

/// `initialize`, then `session/new` or `session/resume`.
///
/// The stance rides `_meta` and the rules ride creation alone. **MCP is grok's
/// own and Dray hands over nothing**: `mcpServers: []` and grok merges
/// `~/.grok/config.toml`, the project's, *and* Claude's and Cursor's through its
/// compat scanners — six of the reader's servers came up on every capture with
/// no Dray involvement, and grok runs its own OAuth flow for the ones that need
/// it. The opposite of fx, where the empty list means "this session has none".
async fn open_session(
    client: &RpcClient,
    session_id: &str,
    session_cwd: &str,
    mode: ApprovalPolicy,
    is_new_session: bool,
) -> Result<Value> {
    client
        .request("initialize", probe::handshake_params())
        .await?;

    if !is_new_session {
        return client
            .request(
                "session/resume",
                json!({"sessionId": session_id, "cwd": session_cwd, "mcpServers": []}),
            )
            .await;
    }

    let mut meta = json!({"sessionId": session_id, "rules": SYSTEM_PROMPT});
    if let Some((key, value)) = stance_meta(mode) {
        meta[key] = json!(value);
    }

    let answer = client
        .request(
            "session/new",
            json!({"cwd": session_cwd, "mcpServers": [], "_meta": meta}),
        )
        .await?;

    // grok honouring the id is what makes the index entry the resume handle, so
    // a grok that stopped honouring it has to fail here rather than leave a
    // session nothing can reopen.
    let minted = answer
        .get("sessionId")
        .and_then(Value::as_str)
        .context("session/new answered with no session id")?;
    anyhow::ensure!(
        minted == session_id,
        "grok opened session {minted} rather than the id Dray chose — this build cannot resume it"
    );

    Ok(answer)
}

/// Dray's stance as the `_meta` key grok reads it from, or `None` for the
/// narrowest, which is grok's own default and needs nothing said.
///
/// **Three of Dray's five reach grok and the mapping is measured.** grok's TUI
/// has four modes and only three have a `session/new` surface: normal (ask),
/// `autoMode`, `yoloMode`. Plan is entered by prompt text and has no toggle at
/// all, so it lands on ask — a session recorded `plan` must never come out
/// freer than the reader asked.
///
/// **`autoMode` is a classifier, not a bypass, and Dray never sees it work.** A
/// blocked call fails the *tool* with a sentence to the model — "Auto mode
/// blocked this action (…)" — and raises no `session/request_permission` at all,
/// so no card is ever drawn under it and the refusal shows only where the model
/// repeats it. Measured holes in the same run, all executed silently: `rm -rf`
/// of a directory *outside* the cwd, `git push origin main`, and a `curl` POST
/// to the internet. The stance row says so.
///
/// `_meta.permissionMode` carrying Claude's own enum is **swallowed** — `plan`,
/// `acceptEdits` and `bypassPermissions` all raised cards — so it is not sent.
fn stance_meta(mode: ApprovalPolicy) -> Option<(&'static str, bool)> {
    match mode {
        ApprovalPolicy::Plan | ApprovalPolicy::Manual => None,
        ApprovalPolicy::Auto => Some(("autoMode", true)),
        ApprovalPolicy::DontAsk | ApprovalPolicy::BypassPermissions => Some(("yoloMode", true)),
    }
}

/// Moves a live session onto another model.
///
/// `session/set_config_option` answers the whole updated option list and
/// mirrors it as a `config_option_update`, verified live. The value is a **bare
/// string**: the `{value: …}` wrapper the docs print is refused (`did not match
/// any variant of untagged enum SessionConfigOptionValue`).
/// Moves a live session onto another model — **and onto its fast tier or off
/// it**, which here is the same request.
///
/// grok publishes no fast-mode flag and no settings key: `grok-4.7-build-fast`
/// is a row in the model list, so asking for fast speed *is* asking for another
/// model. That is why this takes the switch rather than leaving it to a second
/// setter, and why `Session::set_fast` comes back through here.
pub async fn set_model(session: &GrokSession, model: &Model, fast: bool) -> Result<()> {
    set_config(
        session,
        "model",
        &models::fast_arg(&model.arg, fast).await,
    )
    .await?;
    Ok(())
}

/// Moves a live session onto another effort.
///
/// The ladder is closed at four and **case-sensitive** — `HIGH`, `minimal`,
/// `ultra`, `none` and `""` are each refused `-32602 unknown reasoning_effort
/// value`, and the error never names the legal set. So a level outside the
/// model's own list is refused here rather than sent, which turns grok's
/// unhelpful sentence into one naming the model's real rungs.
pub async fn set_effort(session: &GrokSession, model: Option<&Model>, effort: Effort) -> Result<()> {
    if let Some(model) = model.filter(|m| !m.efforts.is_empty()) {
        if !model.efforts.contains(&effort) {
            let levels: Vec<&str> = model.efforts.iter().map(|e| e.as_arg()).collect();
            anyhow::bail!(
                "{} does not take {} — it offers {}. The effort is unchanged.",
                model.label,
                effort.as_arg(),
                levels.join(", ")
            );
        }
    }
    set_config(session, "reasoning_effort", effort.as_arg()).await?;
    Ok(())
}

async fn set_config(session: &GrokSession, config_id: &str, value: &str) -> Result<Value> {
    session
        .client
        .request(
            "session/set_config_option",
            json!({"sessionId": session.id, "configId": config_id, "value": value}),
        )
        .await
}

/// Writes one prompt as a turn.
///
/// Sent with an id and **no waiter**: the response is the turn's end, minutes
/// away, and the read loop settles it on the id kept here. A prompt refused
/// outright still answers on that id, as an error, which the reader draws as a
/// failed turn.
///
/// Nothing is appended to the text — grok's rules went in at `session/new` and
/// persist on the session — so the transcript shows exactly what the model was
/// told, which fx alone cannot promise.
pub async fn start_turn(session: &GrokSession, text: &str) -> Result<()> {
    // Held across the send, which only hands the line to the writer task: an
    // outright refusal can answer before this returns, and `prompt_answer`
    // takes this same lock, so it cannot read the id before it is written.
    let mut running = session.prompt_id.lock().expect("grok prompt id poisoned");
    let id = session.client.request_detached(
        "session/prompt",
        json!({
            "sessionId": session.id,
            "prompt": [{"type": "text", "text": text}],
        }),
    )?;
    *running = Some(id);
    Ok(())
}

/// Stops the running turn. A notification: grok acknowledges nothing, kills the
/// running *foreground* tool and answers the prompt with `cancelled`.
///
/// A **backgrounded** task is untouched by this — measured, a `sleep 300`
/// outlived both the cancel and the agent process — which is why settle reaps
/// the tree rather than trusting the child's own exit.
pub fn cancel(session: &GrokSession) -> Result<()> {
    session
        .client
        .notify("session/cancel", json!({"sessionId": session.id}))
}

/// Ends the child cleanly: `session/close`, EOF, then a kill if it lingers.
pub async fn shutdown(child: &mut Child, session: &GrokSession) {
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
    ready: tokio::sync::oneshot::Receiver<GrokSession>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
    status: Arc<Mutex<StatusTracker>>,
    queued: QueuedMessages,
    seq: Arc<AtomicU64>,
    window: Arc<std::sync::atomic::AtomicU64>,
) -> Result<()> {
    let mut lines = BufReader::new(stdout).lines();
    let mut mapper = mapper::Mapper::new(
        handles.session_id.clone(),
        seq.clone(),
        window.load(std::sync::atomic::Ordering::Relaxed),
    );

    // Held until the session exists. Lines before it are routed — the
    // handshake's answers have to reach their waiters — but mapped to nothing.
    let mut ready = Some(ready);
    let mut transport: Option<Transport> = None;

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            // stdout closed (the child exited) or a read error — either way no
            // more of this turn is coming. Break to the cleanup below.
            Ok(None) => break,
            Err(err) => {
                eprintln!("[grok stdout err] {err}");
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
                        transport = Some(Transport::Grok(session));
                        ready = None;
                        mapper.set_window(window.load(std::sync::atomic::Ordering::Relaxed));
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => ready = None,
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                }
            }
        }

        // The prompt's own answer, read ahead of the demux: nothing waits on
        // it, so `accept` would file it as stray.
        let mut event: Option<parser::GrokEvent> = None;
        if let Some(Transport::Grok(session)) = transport.as_ref() {
            if let Some(done) = prompt_answer(session, &line) {
                event = Some(done);
            }
        }

        let event = match event {
            Some(event) => event,
            None => match handles.client.accept(&line).await {
                Incoming::Notification { method, params } => {
                    match parser::parse_notification(&method, params) {
                        Ok(note) => {
                            // **The rule the whole harness rests on.** A
                            // `spawn_subagent` child streams its own transcript
                            // down this pipe under its own session id — 113
                            // updates against the parent's 154 in one capture —
                            // and it is announced nowhere but `subagent_spawned`.
                            // Unfiltered, the child's thinking and tool calls are
                            // painted into the parent's chat.
                            if note.session_id != handles.session_id {
                                continue;
                            }
                            // Two facts about the session rather than events in
                            // it, so they are read here and mapped to nothing.
                            match &note.update {
                                parser::GrokUpdate::SessionInfoUpdate { title } => {
                                    if let Some(title) = title.clone() {
                                        note_title(&handles, title).await;
                                    }
                                    continue;
                                }
                                parser::GrokUpdate::AvailableCommandsUpdate {
                                    available_commands,
                                } => {
                                    commands::remember(
                                        &handles.session_cwd,
                                        available_commands.clone(),
                                    );
                                    continue;
                                }
                                _ => {}
                            }
                            parser::GrokEvent::Update(note.update)
                        }
                        Err(parser::ParseOutcome::Ignored) => continue,
                        Err(parser::ParseOutcome::Unknown) => {
                            record_failure(Grok, &handles.session_id, "unknown_method", &method, &line)
                                .await;
                            continue;
                        }
                        Err(parser::ParseOutcome::Malformed(err)) => {
                            record_failure(Grok, &handles.session_id, "map", &err.to_string(), &line)
                                .await;
                            continue;
                        }
                    }
                }

                // Every server request blocks the turn until it is answered, so
                // silence stalls the session exactly as an unanswered
                // `can_use_tool` does.
                Incoming::Request { id, method, params } => {
                    if let Err(err) = raise_request(&handles, &mut mapper, id, &method, params).await
                    {
                        record_failure(
                            Grok,
                            &handles.session_id,
                            "unsupported_request",
                            &err.to_string(),
                            &line,
                        )
                        .await;
                        // Refused rather than left hanging, and the shape is
                        // per method: a permission wants ACP's own outcome
                        // envelope, where a question and a plan approval both
                        // survive a JSON-RPC error — measured, the tool fails
                        // and the turn carries on.
                        let _ = match method.as_str() {
                            "session/request_permission" => handles
                                .client
                                .respond(id, json!({"outcome": {"outcome": "cancelled"}})),
                            _ => handles.client.respond_err(
                                id,
                                -32601,
                                "This client cannot answer that request yet.",
                            ),
                        };
                    }
                    continue;
                }

                Incoming::Response { id, matched: false } => {
                    let detail = format!("no caller waiting on id {id}");
                    record_failure(Grok, &handles.session_id, "stray_response", &detail, &line).await;
                    continue;
                }
                Incoming::Response { .. } => continue,

                Incoming::Malformed => {
                    record_failure(Grok, &handles.session_id, "parse", "not a JSON-RPC message", &line)
                        .await;
                    continue;
                }
            },
        };

        let Some(transport) = transport.as_ref() else {
            continue;
        };

        let ingest = crate::session::Ingest {
            session_id: &handles.session_id,
            harness: Grok,
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

    // The child's stdout has ended. If a prompt was still in flight its answer
    // will never arrive, so close the turn as a failure — without which the
    // session hangs `in_progress` forever, its queue with no boundary to drain
    // at. The queue is stranded *first*, so the closing turn's boundary flush
    // finds nothing to hand the dead child.
    if let Some(transport @ Transport::Grok(session)) = transport.as_ref() {
        let outstanding = session
            .prompt_id
            .lock()
            .expect("grok prompt id poisoned")
            .take()
            .is_some();

        crate::session::strand_queue_on_exit(
            &handles.session_id,
            Grok,
            &queued,
            &seq,
            &events,
            &handles.app,
        )
        .await;

        if outstanding {
            let ingest = crate::session::Ingest {
                session_id: &handles.session_id,
                harness: Grok,
                session_cwd: &handles.session_cwd,
                events: &events,
                status: &status,
                queued: &queued,
                flush_seq: &seq,
                flush_events: &events,
                flush_transport: transport,
            };
            for agent_event in mapper.map(parser::GrokEvent::PromptFailed {
                message: "Grok exited before finishing this turn.".to_string(),
            }) {
                crate::session::ingest(&ingest, agent_event, &handles.app).await;
            }
        }
    }

    Ok(())
}

/// Records the title grok wrote for this session and tells the sidebar.
///
/// **grok's title is free, which is the whole reason `title.rs` has no grok
/// arm.** It is written by the model out of band and lands mid-turn, 0.22–0.24s
/// from the last token to the prompt's reply — fx's six-second stall has no
/// counterpart here, because nothing waits on it. grok regenerates it at a
/// couple of early turns and then freezes it, so a later one is ordinary and
/// overwrites the last.
async fn note_title(handles: &ReaderHandles, title: String) {
    match crate::store::set_session_title(&handles.session_id, &title).await {
        // A session deleted mid-turn reads back as `None`; nothing to emit,
        // since the row it would update is gone.
        Ok(None) => {}
        Ok(Some(_)) => {
            let payload = json!({"sessionId": handles.session_id, "title": title});
            if let Err(err) = handles.app.emit("session_title", payload) {
                eprintln!("[grok title emit err] {err}");
            }
        }
        Err(err) => eprintln!("[grok title write err] {err}"),
    }
}

/// The running prompt's response, where `line` is it.
///
/// A response with no method and the prompt's id. Both a result and an error
/// close the turn, and the id is cleared here so a Stop pressed after the
/// answer names nothing.
fn prompt_answer(session: &GrokSession, line: &str) -> Option<parser::GrokEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("method").is_some() {
        return None;
    }
    let id = value.get("id").and_then(Value::as_i64)?;

    let mut running = session.prompt_id.lock().expect("grok prompt id poisoned");
    if *running != Some(id) {
        return None;
    }
    *running = None;

    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Grok could not run this prompt")
            .to_string();
        // `-32000 Authentication required` carries its cure in `data` ("no auth
        // method id provided") and writes nothing at all to stderr, so the
        // JSON-RPC error is the only place the reason exists.
        let detail = error.get("data").and_then(Value::as_str).unwrap_or_default();
        let message = if detail.is_empty() {
            message
        } else {
            format!("{message}: {detail}")
        };
        return Some(parser::GrokEvent::PromptFailed { message });
    }

    let response: parser::PromptResponse = value
        .get("result")
        .cloned()
        .and_then(|r| serde_json::from_value(r).ok())
        .unwrap_or_default();
    Some(parser::GrokEvent::PromptDone(Box::new(response)))
}

/// Turns one of grok's three client-bound requests into the card that answers
/// it.
///
/// Each is registered before it is emitted, so a button pressed the instant the
/// card draws finds the entry waiting. The reply goes out from
/// [`Session::respond_permission`](crate::session::Session::respond_permission)
/// or its question counterpart when the user picks; until then grok is blocked.
async fn raise_request(
    handles: &ReaderHandles,
    mapper: &mut mapper::Mapper,
    rpc_id: i64,
    method: &str,
    params: Value,
) -> Result<()> {
    let request_id = rpc_id.to_string();

    let event = match method {
        "session/request_permission" => {
            let request: parser::PermissionRequest = serde_json::from_value(params)?;
            let (pending, options) = permissions::pending_for(&request, rpc_id);
            let input = request.tool_call.raw_input.clone().unwrap_or(json!({}));
            let command = input.get("command").and_then(Value::as_str).map(str::to_string);
            let path = input
                .get("file_path")
                .or_else(|| input.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let tool_name = pending.tool_name.clone();
            hold(handles, &request_id, pending);

            mapper.synthesize(AgentEventPayload::PermissionRequested {
                request_id,
                tool_use_id: request.tool_call.tool_call_id.clone(),
                tool_name,
                display_name: None,
                // The command or the path, which is what the card draws as the
                // subject. grok's own `title` is a sentence naming the same
                // thing the row above already says.
                title: command.or(path.clone()),
                description: None,
                input,
                blocked_path: path,
                decision_reason: None,
                decision_reason_type: None,
                agent_id: None,
                options,
            })
        }

        "_x.ai/ask_user_question" => {
            let request: parser::AskUserQuestion = serde_json::from_value(params)?;
            let (pending, questions) = permissions::question_pending(&request, rpc_id);
            hold(handles, &request_id, pending);

            mapper.synthesize(AgentEventPayload::QuestionsAsked {
                request_id,
                tool_use_id: request.tool_call_id.clone(),
                questions,
            })
        }

        // A plan approval. Drawn as a card rather than left to the composer's
        // Plan control, which grok has no toggle for: `/plan` sent as prompt
        // text is the only way in, and a reader who types it must not be left
        // with a turn hung on a request nothing answers.
        "_x.ai/exit_plan_mode" => {
            let request: parser::ExitPlanMode = serde_json::from_value(params)?;
            let (pending, options) = permissions::plan_pending(&request, rpc_id);
            let tool_use_id = request.tool_call_id.clone();
            hold(handles, &request_id, pending);

            mapper.synthesize(AgentEventPayload::PermissionRequested {
                request_id,
                tool_use_id,
                tool_name: "exit_plan_mode".to_string(),
                display_name: Some("Plan".to_string()),
                title: Some("Ready to start coding?".to_string()),
                // The plan itself, which is the whole of what is being approved
                // — the tool row beside it carries no arguments worth reading.
                description: Some(request.plan_content.clone()),
                input: json!({}),
                blocked_path: None,
                decision_reason: None,
                decision_reason_type: None,
                agent_id: None,
                options,
            })
        }

        // `fs/*` and `terminal/*` were not advertised, so one arriving is grok
        // asking past the capabilities it was given.
        _ => anyhow::bail!("{method}"),
    };

    // Emitted, never logged — only the child that asked can answer, and no
    // child survives a restart.
    handles.app.emit("agent_event", &event)?;
    Ok(())
}

fn hold(
    handles: &ReaderHandles,
    request_id: &str,
    pending: crate::harness::claude_code::permissions::PendingRequest,
) {
    handles
        .pending
        .lock()
        .expect("pending permissions mutex poisoned")
        .insert(request_id.to_string(), pending);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ModelId;

    fn model(id: &str, efforts: Vec<Effort>) -> Model {
        Model {
            id: ModelId::new(id),
            label: id.to_string(),
            efforts,
            default_effort: None,
            arg: id.to_string(),
            provider: String::new(),
            accepts_images: false,
            secondary: false,
            supports_fast: false,
        }
    }

    /// Three of Dray's five stances reach grok, and the two that do not fall
    /// the *narrow* way — a session recorded `plan` must never come out freer
    /// than the reader asked, and grok has no plan mode to put it in.
    #[test]
    fn every_stance_lands_on_a_mode_grok_has() {
        assert_eq!(stance_meta(ApprovalPolicy::Manual), None);
        assert_eq!(stance_meta(ApprovalPolicy::Plan), None);
        assert_eq!(stance_meta(ApprovalPolicy::Auto), Some(("autoMode", true)));
        assert_eq!(
            stance_meta(ApprovalPolicy::DontAsk),
            Some(("yoloMode", true))
        );
        assert_eq!(
            stance_meta(ApprovalPolicy::BypassPermissions),
            Some(("yoloMode", true))
        );
    }

    /// The two keys are grok's own and are never both set: `autoMode` is a
    /// classifier that raises no card and `yoloMode` asks nothing at all, so a
    /// session carrying both would be describing two different stances.
    #[test]
    fn the_two_stance_keys_are_never_sent_together() {
        for mode in [
            ApprovalPolicy::Manual,
            ApprovalPolicy::Plan,
            ApprovalPolicy::Auto,
            ApprovalPolicy::DontAsk,
            ApprovalPolicy::BypassPermissions,
        ] {
            let mut meta = json!({"sessionId": "s", "rules": "…"});
            if let Some((key, value)) = stance_meta(mode) {
                meta[key] = json!(value);
            }
            let keys = meta.as_object().unwrap();
            assert!(
                !(keys.contains_key("autoMode") && keys.contains_key("yoloMode")),
                "{mode:?} set both stance keys"
            );
        }
    }

    /// The ladder is per model — 4.5 stops at `high` where the others reach
    /// `xhigh` — so a level the model does not have is **withheld** from the
    /// spawn rather than sent and refused. grok's own refusal never names the
    /// legal set, so a spawn that carried one would fail with nothing useful in
    /// it.
    #[test]
    fn a_level_the_model_lacks_is_withheld_from_the_spawn() {
        let four_seven = model("grok-4.7", vec![Effort::High, Effort::Xhigh]);
        let four_five = model("grok-4.5", vec![Effort::Low, Effort::High]);

        assert!(takes_effort(Some(&four_seven), Some(Effort::Xhigh)));
        assert!(!takes_effort(Some(&four_five), Some(Effort::Xhigh)));
        assert!(!takes_effort(Some(&four_seven), None));
        // A model nobody could name resolves with an empty ladder, and grok's
        // own default is the honest answer there.
        assert!(!takes_effort(Some(&model("grok-5", vec![])), Some(Effort::High)));
        // No model at all means grok picks, and a level is still legal.
        assert!(takes_effort(None, Some(Effort::High)));
    }

    /// The rules are a real field on the session rather than text on a prompt,
    /// which is what lets grok's transcript show exactly what the model was
    /// told — the one promise fx cannot make.
    #[test]
    fn the_rules_ride_the_session_and_never_a_prompt() {
        assert!(SYSTEM_PROMPT.contains("You run inside Dray"));
        // Named here because each harness's copy has to name the tools its own
        // agent actually has.
        assert!(SYSTEM_PROMPT.contains("spawn_subagent"));
        assert!(SYSTEM_PROMPT.contains("ask_user_question"));
    }
}
