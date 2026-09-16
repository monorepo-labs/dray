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

pub mod commands;
pub mod mapper;
pub mod mcp;
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
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdout, Command},
    sync::Mutex,
    time::Duration,
};

/// ACP protocol version fx speaks (`agentCapabilities` answered `1`).
const PROTOCOL_VERSION: u64 = 1;

/// Dray's rules, which fx has nowhere to put but a prompt.
///
/// Every other harness has a surface for this — Claude Code and pi take
/// `--append-system-prompt`, Codex takes `developerInstructions` — and fx has
/// none: `fx acp` takes `--model` and `--log-file` and nothing else (0.0.10),
/// `session/new` has no field for it, and `~/.fx/settings.json` holds no key.
/// So the text rides the first prompt of a new session and nothing else, since
/// `session/resume` restores the thread and the rules are in its history.
///
/// Its own file rather than pi's: pi's names `~/.agents/skills`, and fx reads
/// `~/.claude/skills` among its global roots, so each has to name the path its
/// own agent will actually find the skill at.
const SYSTEM_PROMPT: &str = include_str!("system_prompt.md");

/// The tag the rules are wrapped in, so anything reading the prompt back can
/// find where they stop.
const PREAMBLE_TAG: &str = "dray_system_prompt";

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
    /// What the **active model** takes, as the session's own `configOptions`
    /// state it. Three answers, and they are not two: `Some(levels)` for a
    /// model that reasons, `Some(vec![])` for one fx says has no `effort`
    /// option at all, and `None` for a reply this build could not read — which
    /// means "unknown, send it and let fx judge" and must never collapse into
    /// the empty list, or an unfamiliar shape silently turns effort off.
    ///
    /// Moves with the model: `session/set_config_option model` answers the new
    /// model's whole list back, so an in-place switch re-reads it for free.
    /// Taken whole, carried-over level included — see
    /// [`parser::ConfigOptions::model_effort_levels`] for why this is the
    /// place that may, and the model list is not.
    efforts: Arc<std::sync::Mutex<Option<Vec<Effort>>>>,
    /// Which provider the session is on, off the same `configOptions` the
    /// efforts come from. `None` for a reply this build could not read, which
    /// [`set_model`] takes as "leave it alone" rather than as a mismatch.
    provider: Arc<std::sync::Mutex<Option<String>>>,
    /// The model fx says it is running, off those same replies.
    ///
    /// Not the model that was *asked* for — [`landed_model`] hands this back so
    /// a caller whose request was refused can record what the child is really
    /// on. A cross-provider [`set_model`] moves the provider first, and fx
    /// answers that with the new provider's own remembered model, so a refusal
    /// on the model call after it leaves the session somewhere neither side
    /// picked.
    model: Arc<std::sync::Mutex<Option<String>>>,
    /// Whether [`SYSTEM_PROMPT`] still has to ride a prompt.
    ///
    /// **Not `is_new_session`, and the gap is a real one.** `open_session`
    /// records fx's thread id *before* the first prompt, so an `init` failing
    /// after it — a refused stance, a child dying — leaves a session that
    /// resumes onto a thread no prompt ever reached. Read off
    /// `is_new_session` alone, that retry resumes with the flag already false
    /// and the rules are lost for the life of the conversation.
    ///
    /// So a resume that has logged nothing counts as owing them too. The
    /// signal is already on disk: [`crate::session`] writes `user_message`
    /// before the send, so `seq` still at 0 means no prompt was ever
    /// delivered and the rules cannot have gone with one.
    preamble: Arc<AtomicBool>,
}

impl FxSession {
    /// The active model's ladder, or `None` where fx has not said.
    fn efforts(&self) -> Option<Vec<Effort>> {
        self.efforts.lock().expect("fx efforts poisoned").clone()
    }

    /// The provider fx last reported for this session.
    fn provider(&self) -> Option<String> {
        self.provider.lock().expect("fx provider poisoned").clone()
    }
}

/// The model fx last reported for a session, as an id — which for fx is the
/// same string as the argument, every row being minted from the one fx names.
///
/// For a caller reconciling after a refusal. `None` before any reply this build
/// could read, which is "nothing better than what you already have".
pub fn landed_model(session: &FxSession) -> Option<crate::models::ModelId> {
    let model = session.model.lock().expect("fx model poisoned").clone();
    model.map(crate::models::ModelId::new)
}

/// The `--model` argument a spawn carries, or `None` where the flag must be
/// withheld — which is **every resume**, and that is the whole of DRA-223's
/// resume failure.
///
/// fx persists a session's provider *and* its model and restores both on
/// `session/resume`. `--model` on a **resuming** spawn overrides that and drags
/// the session onto whatever `settings.json` names *now* — so a session created
/// on codex, resumed after the reader started a grok chat, came back on grok
/// while still holding a codex model. The model call then answered `-32602
/// "Model is not available for the active provider"` and the turn came back
/// `refused`, with nothing on screen saying why. Measured both ways on one
/// session: without the flag it resumes on codex, the model call succeeds and
/// the turn runs. The model half was pinned separately, against a settings file
/// pointed at a *different* model of the same provider — resume still answered
/// with the session's own.
///
/// A creation still needs it, since nothing else names the model there, and fx
/// saves it nowhere: a spawn with `--model` leaves `settings.json` byte-identical
/// and a later `set_config_option model` still moves the session.
fn model_arg(model: Option<&Model>, is_new_session: bool) -> Option<&str> {
    model.filter(|_| is_new_session).map(|m| m.arg.as_str())
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

    // Before the spawn, and only on one: fx reads `fast_mode` out of its
    // settings file at `session/new` and stamps it onto the session record it
    // keeps, where a `session/resume` then honours the stamp whatever the file
    // says since. So this is the only moment it can be set, and a resume asking
    // again would be a write that changes nothing.
    //
    // **The guard has to outlive the write, and that is the whole of it.** What
    // reads the file is `session/new`, seconds later and a process away — so a
    // lock around the rewrite alone leaves two creations free to interleave
    // write, write, read, read, and one session is permanently stamped with the
    // other's speed while Dray's index records the value that was asked for. A
    // fan-out of `dray new` is exactly where two land at once.
    //
    // Named, not `_`: a plain underscore drops the guard on the spot and puts
    // the race straight back. It falls at the end of `init`, which is wider than
    // `open_session` by one handshake and costs nothing worth a narrower scope.
    let _creating = if is_new_session {
        let guard = FX_CREATING.lock().await;
        set_fast_mode(fast).await;
        disable_fx_titles().await;
        Some(guard)
    } else {
        None
    };

    let bin = crate::binpath::fx().await;
    let mut command = Command::new(&bin);

    if let Some(endpoint) = crate::orchestration::child_endpoint() {
        command.env("DRAY_ENDPOINT", endpoint);
    }

    command.arg("acp");
    if let Some(arg) = model_arg(model, is_new_session) {
        command.args(["--model", arg]);
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

    let (fx_id, config) = match open_session(&client, session_id, session_cwd, is_new_session).await
    {
        Ok(opened) => opened,
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
        efforts: Arc::new(std::sync::Mutex::new(None)),
        provider: Arc::new(std::sync::Mutex::new(None)),
        model: Arc::new(std::sync::Mutex::new(None)),
        preamble: Arc::new(AtomicBool::new(owes_preamble(is_new_session, seq_start))),
    };
    note_config(&session, &config, None, app);

    // Session settings, applied in place on a session that now exists. The model
    // is among them on a **resume**, where it did not ride the spawn — see
    // [`model_arg`] — and on a creation it did, so it is left alone there.
    //
    // **Before the effort, and that ordering is load-bearing rather than
    // incidental**: a ladder is per model, so a level sent first is asked of the
    // model fx restored rather than the one the reader picked, and a rung the
    // new model does not have is refused for the old one's sake. Re-sending the
    // model fx already restored is a no-op that answers ok, so this needs no
    // comparison — and the reply is what teaches the session the new model's
    // ladder, which is what the effort below is judged against.
    if !is_new_session {
        if let Some(model) = model {
            if let Err(error) = set_model(&session, model, app).await {
                let _ = child.kill().await;
                return Err(error);
            }
        }
    }

    // A refused effort is **not** fatal, where a refused stance is. fx declines
    // one on a model that does no reasoning, and killing the child over that
    // means a session whose recorded level its model has since stopped taking
    // cannot be resumed at all. So the level is dropped, the session runs on
    // fx's own default, and the transcript says so — the same answer the
    // in-place path in [`crate::session`] gives, by design, since the reader
    // cannot tell the two moments apart.
    let (applied, refusal, accepted) = open_effort(&session, effort).await;
    // fx taking the level is proof this model has it, which no reply can say
    // on its own — every reading has the level in use subtracted out of it.
    if let (Some(level), Some(config)) = (applied, accepted) {
        note_effort(&session, &config, level, app);
    }
    if let Some(refusal) = refusal {
        crate::session::report_session_error(session_id, Fx, &refusal, &seq, &events, app).await;
    }

    // A stance that will not apply is the fatal one: the session would run
    // freer or narrower than the reader asked, which is not something to
    // report and carry on from.
    if let Err(error) = set_mode(&session, permission_mode).await {
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
        // What the session is running on, not what was asked for — the index
        // is written from this, and a level recorded that fx declined is the
        // whole of DRA-221's second half.
        effort: applied,
        permission_mode,
        fast,
        events,
        seq,
        status,
        pending_permissions: pending,
        queued,
    })
}

/// Serializes fx session *creation*, so a global setting written for one cannot
/// be read by another.
///
/// Only creation: a resume reads nothing out of the settings file, since fx
/// honours the stamp on its own session record instead. Two resumes, or a resume
/// beside a creation, still run side by side.
static FX_CREATING: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Puts fx's fast mode where the next `session/new` will read it.
///
/// **fx's own global setting, and there is no narrower place to put it.** ACP's
/// `configOptions` are provider, model, mode and effort and nothing else (fx
/// 0.0.10), `fx acp` takes `--model` and `--log-file` and nothing else, and no
/// `FX_*` variable names it — so the settings file is the only surface, exactly
/// as it is for the provider switch next door. The composer's row says so.
///
/// Best effort, deliberately. A session must not fail to start because another
/// tool's config file could not be edited, and the cost of a failed write is a
/// session running at ordinary speed — which is the safe direction, since the
/// faster tier is the one that spends more.
async fn set_fast_mode(fast: bool) {
    if let Err(error) = models::write_setting("fast_mode", fast.into()).await {
        eprintln!("[fx] couldn't set fast mode: {error:#}");
    }
}

/// Turns fx's own session titling off, so the first turn ends when the answer
/// does.
///
/// **fx's ACP server holds the `session/prompt` reply until it has written a
/// title, and that is a second model call.** Measured against 0.0.10 through
/// `fx acp --log-file`: `prompt_finish` for the turn, then 5.9s of
/// `title_generation`, and only then the reply — so the working indicator sat
/// there for six seconds over a finished answer. Nothing on the wire says the
/// answer is done; `prompt_finish` is log-only. Nor can the wait be worked
/// around from this side: a prompt sent into that window is refused outright
/// with `-32600 Prompt already in progress`, so fx holds the whole session and
/// not merely the reply. Off, the same gap measures 0.16s.
///
/// Only the first turn pays it — fx restates the stored title afterwards rather
/// than deriving it again — which is why the stall looks like the first message
/// being special.
///
/// [`crate::title`] writes the title instead, detached, the way every other
/// harness here is titled.
///
/// Best effort and for fast mode's reason, and it sits beside it for another:
/// this is fx's **global** setting, so it moves the reader's own TUI default
/// too, and the two writers can undo each other. A lost write costs the stall
/// back, never the session.
async fn disable_fx_titles() {
    if let Err(error) = models::write_setting("session_titles", false.into()).await {
        eprintln!("[fx] couldn't turn fx's own session titling off: {error:#}");
    }
}

/// The effort a session opening should record: the level asked for where fx
/// took it, `None` where fx would not, with the sentence to report beside it.
///
/// The refusal is **handed back rather than raised**, and that is the half of
/// DRA-221 with teeth. `init` used to `?` on it and kill the child, so a
/// session resumed onto a model that no longer takes its recorded level could
/// not be opened *at all* — a conversation the reader cannot get back into,
/// not a menu that offers the wrong thing. Nothing about an effort is worth a
/// session for.
/// The accepted reply rides back with them rather than being recorded here, so
/// this answers with no `AppHandle` and can be tested without one.
async fn open_effort(
    session: &FxSession,
    asked: Option<Effort>,
) -> (Option<Effort>, Option<String>, Option<parser::ConfigOptions>) {
    // Absent means fx's `auto`, which is its own default and not a level
    // Dray's ladder spells — so it is left alone rather than sent.
    let Some(level) = asked else {
        return (None, None, None);
    };
    match set_effort(session, level).await {
        Ok(config) => (Some(level), None, Some(config)),
        Err(err) => (None, Some(format!("{err:#}")), None),
    }
}

/// The sentence a refused effort draws, written here rather than passed
/// through from fx.
///
/// fx has two refusals one word apart — "Reasoning effort is unavailable for
/// the active model" for a model with none, "is not available" for a rung
/// above one that has some — and neither says which level was refused, what
/// the model does take, or what the session ended up on. All three are what
/// the reader needs, and the ladder is right here.
fn effort_refusal(session: &FxSession, asked: Effort) -> String {
    let levels: Vec<&str> = session
        .efforts()
        .unwrap_or_default()
        .iter()
        .map(|e| e.as_arg())
        .collect();

    if levels.is_empty() {
        return format!(
            "This model takes no reasoning effort, so {} was not applied and the effort is unchanged.",
            asked.as_arg()
        );
    }
    format!(
        "This model does not take {} — it offers {}. The effort is unchanged.",
        asked.as_arg(),
        levels.join(", ")
    )
}

/// Records what a reply said the active model takes, on the session and in the
/// model list both, and nudges the composer when that is news.
///
/// The picker builds its effort submenu from [`models::list`], which for a
/// model nobody has run can only guess by provider — so without the nudge it
/// keeps offering a control fx has just refused for the rest of the run.
fn note_config(
    session: &FxSession,
    config: &parser::ConfigOptions,
    accepted: Option<Effort>,
    app: &AppHandle,
) {
    // A reply carrying no `configOptions` at all is fx saying nothing, not fx
    // saying "no effort" — a shape this build cannot read must leave the
    // judgement with fx rather than silently disable the control.
    if config.config_options.is_empty() {
        return;
    }

    // The session takes the list as fx gave it, carried level and all: fx is
    // the judge of its own session, and over-offering here costs one refusal
    // that is now reported, where withholding a level costs one fx would have
    // taken.
    *session.efforts.lock().expect("fx efforts poisoned") = Some(rungs(config.effort_levels()));

    // Every reply that states a session's settings states its provider, so the
    // one reader serves `session/new`, `session/resume` and every
    // `set_config_option` alike — which is what keeps [`set_model`]'s
    // comparison current without a read of its own.
    if let Some(provider) = config.provider() {
        *session.provider.lock().expect("fx provider poisoned") = Some(provider.to_string());
    }
    if let Some(model) = config.model() {
        *session.model.lock().expect("fx model poisoned") = Some(model.to_string());
    }

    // The model list outlives this session, so it only takes the part of that
    // list which cannot be this session's own level leaking in — with the whole
    // list beside it as the upper bound, or a rung fx has stopped offering
    // would be cached for the life of the process.
    let Some(model) = config.model() else {
        return;
    };
    let reading = match config.model_effort_levels() {
        None => None,
        Some(levels) => {
            let mut takes = rungs(Some(levels));
            // fx *taking* a level is the one proof this model has it, and the
            // reply cannot say so on its own: the level in use is subtracted
            // out of every reading, since a carried-over one is refused just
            // the same. Without it, opening a session on a valid level teaches
            // the picker that level is unsupported — and `usableEffort` then
            // moves the reader off it silently.
            if let Some(effort) = accepted.filter(|e| !takes.contains(e)) {
                takes.push(effort);
            }
            Some(models::LadderReading { takes, may_take: rungs(config.effort_levels()) })
        }
    };
    announce_ladder(model, reading, app);
}

/// fx's level names as rungs Dray can spell.
///
/// `auto` and `none` are fx's own and are dropped — the ladder must not grow a
/// variant for them, since an older build reading a level it cannot spell
/// fails the whole index (DRA-140). Dropping leaves an effort-capable model
/// whose every level is unspellable reading as one with no effort, and fx's
/// `auto` is where both land, so the two agree where it matters.
fn rungs(levels: Option<Vec<&str>>) -> Vec<Effort> {
    levels
        .unwrap_or_default()
        .iter()
        .filter_map(|level| Effort::from_arg(level))
        .collect()
}

fn announce_ladder(model_arg: &str, reading: Option<models::LadderReading>, app: &AppHandle) {
    if models::learn_ladder(model_arg, reading) {
        if let Err(err) = app.emit("models_changed", ()) {
            eprintln!("[fx models_changed emit err] {err}");
        }
    }
}

/// `initialize`, then `session/new` or `session/resume`. Answers fx's own id
/// and the settings it opened with — both replies carry `configOptions`,
/// captured, which is the only statement of what the active model takes.
async fn open_session(
    client: &RpcClient,
    session_id: &str,
    session_cwd: &str,
    is_new_session: bool,
) -> Result<(String, parser::ConfigOptions)> {
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

    // Read once and sent on both paths. `fx acp` reads no MCP config of its
    // own, so this list is the only thing standing between a session and the
    // servers the reader's `fx` shell already has — and a resumed session is
    // handed them again, since fx keeps none of it across the connection.
    let mcp_servers = mcp::configured_servers().await;

    if is_new_session {
        let answer =
            open_with_servers(client, "session/new", json!({"cwd": session_cwd}), mcp_servers)
                .await?;
        let id = answer
            .get("sessionId")
            .and_then(Value::as_str)
            .context("session/new answered with no session id")?
            .to_string();
        // Before the first prompt, so a child dying mid-turn still leaves a
        // session to resume rather than one that silently starts over.
        store::set_session_thread_id(session_id, &id).await?;
        return Ok((id, parser::ConfigOptions::of(&answer)));
    }

    let recorded = store::get_session_index_item(session_id)
        .await?
        .and_then(|item| item.thread_id)
        .context("this session has no fx session to resume")?;

    let answer = open_with_servers(
        client,
        "session/resume",
        json!({"sessionId": recorded, "cwd": session_cwd}),
        mcp_servers,
    )
    .await?;
    Ok((recorded, parser::ConfigOptions::of(&answer)))
}

/// `session/new` or `session/resume` with the MCP list, shedding servers fx
/// refuses until it opens.
///
/// Every server on the ACP surface is *required* — fx's shell tolerates a
/// dead one under `policy=optional`, but over ACP the same entry fails the
/// whole request with `-32602 Required MCP server '<name>' failed to start`.
/// Left alone, one stale command or unreachable URL in `~/.fx/mcp.json` would
/// make fx sessions uncreatable in Dray while working fine in a terminal. So
/// the named culprit is dropped and the request repeated; a refusal naming no
/// server sheds them all. The child stays usable across a refused open —
/// measured, for both methods. Each drop is logged, since the reader's only
/// other signal is a tool the agent cannot find.
///
/// **Only an MCP refusal is retried.** A timeout or a closed pipe is not one:
/// a `session/new` that timed out may have opened a session fx persisted,
/// and repeating it would mint a second one nothing tracks, with the first
/// failure hidden behind it. Those propagate untouched.
async fn open_with_servers(
    client: &RpcClient,
    method: &str,
    base: Value,
    mut servers: Vec<Value>,
) -> Result<Value> {
    loop {
        let mut params = base.clone();
        params["mcpServers"] = Value::Array(servers.clone());
        match client.request(method, params).await {
            Ok(answer) => return Ok(answer),
            Err(error) if !servers.is_empty() && is_mcp_refusal(&error.to_string()) => {
                let message = error.to_string();
                match refused_server(&servers, &message) {
                    Some(index) => {
                        let dropped = servers.remove(index);
                        eprintln!(
                            "[fx mcp] dropping server {}: {message}",
                            dropped["name"].as_str().unwrap_or("?")
                        );
                    }
                    None => {
                        eprintln!("[fx mcp] dropping every server: {message}");
                        servers.clear();
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
}

/// Whether a failed open is fx refusing the MCP list, as against the request
/// never being answered at all.
///
/// The RPC layer flattens a JSON-RPC error to text, so the answer is read off
/// the two things that text carries and no other failure does: `RpcError`'s
/// own `(code -32602)` suffix — invalid params, the code every MCP refusal
/// came back under — and fx's "MCP server" wording. A timeout says "never
/// answered", a dead child says "pipe is closed"; neither carries a code.
fn is_mcp_refusal(message: &str) -> bool {
    message.contains("(code -32602)") && message.contains("MCP server")
}

/// Which of `servers` a refusal names, matched on the quoted name fx puts in
/// its message. `None` where it names none of them — a message that changed
/// shape, or a refusal about something other than a server.
fn refused_server(servers: &[Value], message: &str) -> Option<usize> {
    servers.iter().position(|server| {
        server["name"]
            .as_str()
            .is_some_and(|name| message.contains(&format!("'{name}'")))
    })
}

/// The provider a session has to be moved to before [`set_model`] may send
/// this model, or `None` where it is already there and nothing need go out.
///
/// Two states answer `None` besides agreement, and both are silence rather than
/// evidence: a session whose `configOptions` this build could not read, and a
/// model listed with no provider on it — `fx models` falls back to an empty one
/// where `~/.fx/settings.json` cannot be read, which says nothing about where
/// the model lives.
fn provider_move<'a>(current: Option<&str>, model: &'a Model) -> Option<&'a str> {
    if model.provider.is_empty() || current? == model.provider {
        return None;
    }
    Some(&model.provider)
}

/// Moves a live session onto another model, taking its provider with it.
///
/// The reply restates the whole `configOptions` list for the model just
/// switched to, so this is also where the new model's effort ladder is read —
/// captured, and the reason an in-place switch costs no extra round trip.
///
/// **The provider moves first, and that is what makes a cross-provider pick
/// land at all.** fx refuses a model belonging to another provider outright
/// (`-32602 "Model is not available for the active provider"`), and this `?`
/// used to take the whole send with it — on a resume, [`init`] kills the child
/// over it, so a session whose provider had moved underneath it could not be
/// opened. A model names its provider, so there is nothing to ask the reader:
/// switching the session across is what picking that model *meant*.
/// `set_config_option provider` is a real in-place switch — it persists onto
/// fx's own session record and a later `session/resume` comes back on it,
/// captured in `provider_switch.jsonl` — and it moves the session onto that
/// provider's own remembered model, which the call below then overrides.
pub async fn set_model(session: &FxSession, model: &Model, app: &AppHandle) -> Result<()> {
    if let Some(provider) = provider_move(session.provider().as_deref(), model) {
        let answer = set_config(session, "provider", provider).await?;
        note_config(session, &parser::ConfigOptions::of(&answer), None, app);
    }

    let answer = set_config(session, "model", &model.arg).await?;
    // No accepted level to record: the reply's current effort is the one
    // carried over from the model just left, which the new one may refuse.
    note_config(session, &parser::ConfigOptions::of(&answer), None, app);
    Ok(())
}

/// Moves a live session onto another effort — the one in-place effort switch
/// any harness here has.
///
/// A level outside what the session said it takes is **refused here rather
/// than sent**. fx answers `-32602` to both an effort set on a model that does
/// no reasoning and a rung above one that does, and the caller has to tell the
/// reader either way — so asking the session's own list first turns the common
/// case into a sentence naming the model's real levels instead of fx's
/// "Reasoning effort is unavailable for the active model".
/// The reply is handed back rather than dropped: it restates the whole list
/// for the level fx has just taken, and that acceptance is the only proof this
/// model has that level. [`note_effort`] is what records it, and both callers
/// do — this one cannot, having no `AppHandle` to nudge the composer with.
pub async fn set_effort(session: &FxSession, effort: Effort) -> Result<parser::ConfigOptions> {
    if let Some(levels) = session.efforts() {
        if !levels.contains(&effort) {
            anyhow::bail!("{}", effort_refusal(session, effort));
        }
    }
    let answer = set_config(session, "effort", effort.as_arg()).await?;
    Ok(parser::ConfigOptions::of(&answer))
}

/// Records a [`set_effort`] reply against the level it accepted.
pub fn note_effort(
    session: &FxSession,
    config: &parser::ConfigOptions,
    accepted: Effort,
    app: &AppHandle,
) {
    note_config(session, config, Some(accepted), app);
}

async fn set_config(session: &FxSession, config_id: &str, value: &str) -> Result<Value> {
    session
        .client
        .request(
            "session/set_config_option",
            json!({"sessionId": session.id, "configId": config_id, "value": value}),
        )
        .await
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

/// Whether this spawn still owes [`SYSTEM_PROMPT`] — see [`FxSession::preamble`].
///
/// A creation always does. A resume does only where nothing has ever been
/// logged for the session, which is the shape an `init` that failed after
/// `session/new` leaves: a thread id on the index, an empty conversation, and
/// a retry that would otherwise resume with the rules already written off.
fn owes_preamble(is_new_session: bool, seq_start: u64) -> bool {
    is_new_session || seq_start == 0
}

/// The reader's text with [`SYSTEM_PROMPT`] behind it, wrapped in
/// [`PREAMBLE_TAG`] so where the rules start and stop is mechanical.
///
/// **The rules go after the request, and that ordering is measured rather than
/// stylistic.** fx titles the session off its first turn, so a prompt opening
/// with 4KB of Dray rules is titled about Dray: the same request came back
/// "Dray Agent Workflow Instructions" with the block first and "Add Verbose
/// Flag to CLI Parser" with it last, and fx restates that title on later turns
/// rather than re-deriving it, so a first turn titled wrong stays wrong. Two
/// content blocks in the `prompt` array read as the block-first order and title
/// the same way. The rules are still honoured from down there — pinned live
/// with a codeword rule the model obeyed on the turn it arrived.
fn with_preamble(text: &str) -> String {
    format!("{text}{}", preamble_block())
}

/// Exactly what [`with_preamble`] appends, as one string.
///
/// **Split out so [`crate::title`] can cut back off what this puts on, by
/// equality rather than by pattern.** A search for the tag alone is a search
/// through the reader's own words — and in this repo, of all places, a prompt
/// may well quote the markup — where the whole block is 4KB nobody writes by
/// accident. Two spellings of it would leave that cut silently matching
/// nothing, which is why this is one function and not a rule stated twice.
pub(crate) fn preamble_block() -> String {
    format!("\n\n<{PREAMBLE_TAG}>\n{SYSTEM_PROMPT}\n</{PREAMBLE_TAG}>")
}

/// Writes one prompt as a turn.
///
/// Sent with an id and **no waiter**: the response is the turn's end, minutes
/// away, and the read loop settles it on the id kept here. A prompt refused
/// outright still answers on that id, as an error, which the reader draws as
/// a failed turn.
///
/// **Dray's rules ride the first prompt of a new session**, since fx has no
/// system-prompt surface at all — see [`SYSTEM_PROMPT`]. Only the *transport*
/// text carries them: [`crate::session`] logs `user_message` from the reader's
/// own string, so the transcript never sees the block and there is nothing to
/// strip on the way out.
pub async fn start_turn(session: &FxSession, text: &str) -> Result<()> {
    // Read, not taken: a send that fails hands the line to nobody, and the
    // reader's retry is then a turn that never learns the rules.
    let owed = session.preamble.load(std::sync::atomic::Ordering::Relaxed);
    let sent = if owed {
        with_preamble(text)
    } else {
        text.to_string()
    };

    // Held across the send, which only hands the line to the writer task:
    // an outright refusal can answer before this returns, and `prompt_answer`
    // takes this same lock, so it cannot read the id before it is written.
    let mut running = session.prompt_id.lock().expect("fx prompt id poisoned");
    let id = session.client.request_detached(
        "session/prompt",
        json!({
            "sessionId": session.id,
            "prompt": [{"type": "text", "text": sent}],
        }),
    )?;
    *running = Some(id);
    session
        .preamble
        .store(false, std::sync::atomic::Ordering::Relaxed);
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

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            // stdout closed (the child exited) or a read error — either way no
            // more of this turn is coming. Break to the cleanup below.
            Ok(None) => break,
            Err(err) => {
                eprintln!("[fx stdout err] {err}");
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

        // fx's own title is deliberately dropped — see [`disable_fx_titles`].
        // With its generation off, what `session_info_update` carries is the
        // raw first prompt, which is already what Dray's index holds; and fx
        // **restates** that on every later turn, so honouring it would write the
        // prompt back over the title [`crate::title`] generated, mid-session.

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

    // The child's stdout has ended. If a prompt was still in flight its answer
    // will never arrive, so close the turn as a failure — without which the
    // session hangs `in_progress` forever, its queue with no boundary to drain
    // at. The queue is stranded *first* (reported and cleared), so the closing
    // turn's boundary flush finds nothing to hand the dead child.
    if let Some(transport @ Transport::Fx(session)) = transport.as_ref() {
        // Clear it either way — the child is gone, so a Stop pressed now names
        // nothing — and remember whether a turn was open to close it below.
        let outstanding = session
            .prompt_id
            .lock()
            .expect("fx prompt id poisoned")
            .take()
            .is_some();

        crate::session::strand_queue_on_exit(
            &handles.session_id,
            Fx,
            &queued,
            &seq,
            &events,
            &handles.app,
        )
        .await;

        if outstanding {
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
            for agent_event in mapper.map(parser::FxEvent::PromptFailed {
                message: "fx exited before finishing this turn.".to_string(),
            }) {
                crate::session::ingest(&ingest, agent_event, &handles.app).await;
            }
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
    use crate::harness::rpc::Outbound;

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

    /// The rules go **after** the reader's text, which is what keeps fx's own
    /// title on the work — measured, see [`with_preamble`]. A refactor that
    /// tidies them to the front reads fine and costs every fx session its
    /// title, so the order is pinned rather than left to the comment.
    #[test]
    fn the_rules_ride_behind_the_prompt_in_a_tag_that_closes() {
        let sent = with_preamble("add a --verbose flag");

        assert!(sent.starts_with("add a --verbose flag\n\n"));
        let opens = sent.find("<dray_system_prompt>").expect("no opening tag");
        let closes = sent.find("</dray_system_prompt>").expect("no closing tag");
        assert!(opens < closes);
        assert!(sent.trim_end().ends_with("</dray_system_prompt>"));
        // The rules themselves, not just an empty envelope.
        assert!(sent.contains("You run inside Dray"));
    }

    /// A resume that has logged nothing never delivered a prompt, so it still
    /// owes the rules — the state an `init` failing after `session/new`
    /// leaves, where reading `is_new_session` alone lost them for good.
    #[test]
    fn a_resume_onto_a_thread_no_prompt_reached_still_owes_the_rules() {
        assert!(owes_preamble(true, 0));
        // The failed-creation retry: thread id recorded, nothing logged.
        assert!(owes_preamble(false, 0));
        // An ordinary resume — `user_message` is logged before the send, so a
        // conversation that ran has moved the counter and took the rules with
        // its first turn.
        assert!(!owes_preamble(false, 1));
        assert!(!owes_preamble(false, 420));
    }

    /// fx's refusal names the server in quotes, and that is the whole match:
    /// a server whose name is a prefix of another's must not be blamed for
    /// it, and a message naming none answers `None` so the caller sheds all
    /// rather than guessing.
    #[test]
    fn a_refusal_names_the_server_it_is_about() {
        let servers = vec![json!({"name": "files"}), json!({"name": "files-remote"})];
        let refusal = |name: &str| {
            format!("Required MCP server '{name}' failed to start: FileNotFound (code -32602)")
        };

        assert_eq!(refused_server(&servers, &refusal("files-remote")), Some(1));
        assert_eq!(refused_server(&servers, &refusal("files")), Some(0));
        assert_eq!(refused_server(&servers, &refusal("other")), None);
        assert_eq!(refused_server(&servers, "Each HTTP MCP server requires headers"), None);
    }

    /// Only fx refusing the list is retried. The three captured refusals all
    /// qualify; the RPC layer's own failures — a request that timed out or a
    /// child that left — carry no code and must propagate, since repeating a
    /// `session/new` that may already have landed mints a session nothing
    /// tracks.
    #[test]
    fn only_an_mcp_refusal_is_retried() {
        let refused = [
            "session/new failed: Required MCP server 'dead' failed to start: FileNotFound (code -32602)",
            "session/new failed: Each HTTP MCP server requires headers (code -32602)",
            "session/resume failed: Required MCP server 'x' failed to start: ConnectionRefused (code -32602)",
        ];
        for message in refused {
            assert!(is_mcp_refusal(message), "{message}");
        }

        let propagated = [
            "session/new was never answered — the agent exited",
            "session/new timed out after 30s",
            "the agent's input pipe is closed",
            "session/new failed: Run fx login grok. (code -32600)",
        ];
        for message in propagated {
            assert!(!is_mcp_refusal(message), "{message}");
        }
    }

    /// Only `arg` is read by what is under test; the rest is what fx's own
    /// `id_to_model` builds for a codex row.
    fn model(arg: &str) -> Model {
        Model {
            id: crate::models::ModelId::new(arg),
            label: arg.into(),
            efforts: Vec::new(),
            default_effort: None,
            arg: arg.into(),
            provider: "codex".into(),
            accepts_images: false,
            secondary: false,
            supports_fast: true,
        }
    }

    /// A creation carries `--model`, because nothing else names the model there.
    #[test]
    fn a_new_session_spawns_with_the_model_named() {
        let m = model("gpt-5.6-sol");
        assert_eq!(model_arg(Some(&m), true), Some("gpt-5.6-sol"));
        // No pick is fx's own settings deciding, which is an ordinary state here.
        assert_eq!(model_arg(None, true), None);
    }

    /// A resume carries it **never**, whatever the pick — fx restores the
    /// session's own provider and model, and the flag overrides both onto
    /// whatever `settings.json` names now. That is what left a resumed codex
    /// session on grok, its model refused `-32602` and its next turn `refused`.
    #[test]
    fn a_resume_spawns_without_it_so_the_session_keeps_its_own_provider() {
        let m = model("gpt-5.6-sol");
        assert_eq!(model_arg(Some(&m), false), None);
        assert_eq!(model_arg(None, false), None);
    }

    fn session_on(
        efforts: Option<Vec<Effort>>,
    ) -> (FxSession, tokio::sync::mpsc::UnboundedReceiver<Outbound>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            FxSession {
                client: RpcClient::over(tx),
                id: "s".into(),
                prompt_id: Arc::new(std::sync::Mutex::new(None)),
                efforts: Arc::new(std::sync::Mutex::new(efforts)),
                provider: Arc::new(std::sync::Mutex::new(None)),
                model: Arc::new(std::sync::Mutex::new(None)),
                preamble: Arc::new(AtomicBool::new(false)),
            },
            rx,
        )
    }

    /// A level the session said it cannot take never reaches the wire — which
    /// is DRA-221's cure rather than its report: fx answers `-32602` to it, and
    /// an unsent request is one that cannot fail a send.
    #[tokio::test]
    async fn an_effort_outside_the_ladder_is_never_sent() {
        let (session, mut rx) = session_on(Some(vec![Effort::Low, Effort::Medium]));

        let refused = set_effort(&session, Effort::Max).await.unwrap_err();
        let sentence = format!("{refused:#}");
        assert!(sentence.contains("max"), "names the level asked for: {sentence}");
        assert!(sentence.contains("low, medium"), "names what it does take: {sentence}");
        assert!(rx.try_recv().is_err(), "nothing was written");

        // A model with no `effort` option at all gets its own sentence, since
        // "it offers nothing" and "not that rung" are different news.
        let (none, mut rx) = session_on(Some(Vec::new()));
        let sentence = format!("{:#}", set_effort(&none, Effort::High).await.unwrap_err());
        assert!(sentence.contains("takes no reasoning effort"), "{sentence}");
        assert!(rx.try_recv().is_err(), "nothing was written");
    }

    /// Unknown is not the same as none. A reply that carried no
    /// `configOptions` must leave the judgement to fx rather than refuse
    /// locally, or a shape this build has not seen silently disables effort.
    #[tokio::test]
    async fn an_unread_ladder_sends_and_lets_fx_judge() {
        let (session, mut rx) = session_on(None);
        // The request blocks on fx's answer, which never comes here — what is
        // under test is that the line goes out at all.
        let sent = tokio::time::timeout(Duration::from_millis(50), set_effort(&session, Effort::Max)).await;
        assert!(sent.is_err(), "still waiting on fx, so it was sent");

        let Outbound::Line(line) = rx.try_recv().expect("a line was written") else {
            panic!("a close, not a line");
        };
        assert!(line.contains("set_config_option"), "{line}");
        assert!(line.contains("\"max\""), "{line}");
    }

    /// A level a model has stopped taking must not make its session
    /// unopenable. This is the resume path: `init` used to `?` on the refusal
    /// and kill the child, so the conversation could not be reached at all.
    /// The level is dropped, the refusal is handed back to be drawn, and the
    /// session opens recording what it is actually on.
    #[tokio::test]
    async fn a_refused_effort_does_not_stop_a_session_opening() {
        let (session, mut rx) = session_on(Some(Vec::new()));

        let (applied, refusal, accepted) = open_effort(&session, Some(Effort::High)).await;
        assert_eq!(applied, None, "records what is running, not what was asked");
        assert!(accepted.is_none(), "nothing fx took, so nothing to learn from");
        assert!(
            refusal.expect("says so").contains("takes no reasoning effort"),
            "the reader is told why the level on their row is not the one in force",
        );
        assert!(rx.try_recv().is_err(), "nothing was written");

        // No effort asked for is no refusal and nothing sent — fx's own `auto`.
        let (applied, refusal, accepted) = open_effort(&session, None).await;
        assert_eq!((applied, refusal), (None, None));
        assert!(accepted.is_none());
        assert!(rx.try_recv().is_err());
    }

    /// A model belonging to another provider takes the session across first,
    /// since fx refuses it outright otherwise — and that refusal is not a
    /// sentence the reader ever sees: it fails the send, and on a resume kills
    /// the child, so the conversation cannot be opened at all.
    ///
    /// Nothing goes out where the two already agree, or every ordinary model
    /// switch would cost a round trip. And nothing goes out on either kind of
    /// silence: sending a provider nobody established would be a switch made
    /// out of a failure to read one.
    #[test]
    fn a_model_from_another_provider_moves_the_provider_first() {
        let sol = model("gpt-5.6-sol");
        assert_eq!(provider_move(Some("grok"), &sol), Some("codex"));
        assert_eq!(provider_move(Some("codex"), &sol), None, "already there");
        assert_eq!(provider_move(None, &sol), None, "fx has not said where it is");

        let nowhere = Model { provider: String::new(), ..model("gpt-5.6-sol") };
        assert_eq!(provider_move(Some("grok"), &nowhere), None, "a list read with no provider");
    }

    /// The ladder rides `configOptions`, and `auto`/`none` are fx's own levels
    /// rather than rungs Dray may spell — a new `Effort` variant is an index
    /// an older build cannot parse (DRA-140), so they are dropped here.
    ///
    /// What the *session* may try is the list whole; what is remembered
    /// against the *model* is that list minus the level in use, since fx
    /// unions the two.
    #[test]
    fn a_config_reply_teaches_the_session_its_models_levels() {
        let reply = json!({"configOptions": [
            {"id": "model", "currentValue": "openai/gpt-5.4-nano", "options": []},
            {"id": "effort", "currentValue": "max", "options": [
                {"value": "auto"}, {"value": "none"}, {"value": "low"},
                {"value": "medium"}, {"value": "high"}, {"value": "xhigh"},
                {"value": "max"},
            ]},
        ]});
        let config = parser::ConfigOptions::of(&reply);

        assert_eq!(
            rungs(config.effort_levels()),
            vec![Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max],
            "the session may try any of them — fx judges its own session",
        );
        assert_eq!(
            rungs(config.model_effort_levels()),
            vec![Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh],
            "`max` is the carried level, so it is not remembered against the model",
        );
        assert_eq!(config.model(), Some("openai/gpt-5.4-nano"));
    }

    /// The prompt's answer is read off its id and nothing else — a response
    /// to some other request, or one arriving after the turn was cleared,
    /// must not close a turn.
    #[test]
    fn only_the_running_prompts_answer_closes_the_turn() {
        let (session, _rx) = session_on(None);
        *session.prompt_id.lock().unwrap() = Some(7);

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
