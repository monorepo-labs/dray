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

pub mod commands;
pub mod desk;
pub mod dialog;
pub mod mapper;
pub mod models;
pub mod parser;
pub mod rpc;

use crate::events::{AgentEvent, AgentEventPayload, ApprovalPolicy, TurnStatus};
use crate::harness::claude_code::permissions::PendingPermissions;
use crate::harness::Harness::Pi;
use crate::models::{Effort, Model};
use crate::session::{QueuedMessages, Session, StatusTracker, Transport};
use crate::store::{self, next_seq_by_session_id};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
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

/// pi's own read-only tools, and the whole of what `Plan` means here.
///
/// An allowlist rather than a list of tools to withhold, and that is the half
/// that matters: **pi extensions register their own tools**, under names this
/// build has never seen, and any of them can write files or run commands. A
/// blocklist would let every one of those through under the one stance a reader
/// picks precisely because it cannot write. An allowlist gets an unknown
/// read-only tool wrong in the safe direction — it is simply not there.
const PLAN_TOOLS: [&str; 4] = ["read", "grep", "find", "ls"];

/// The `--tools` allowlist a stance wants, or `None` for every tool pi has.
///
/// `Plan` is the one stance pi can enforce, and it enforces it properly:
/// `--tools` is fixed for the process and applies to extension tools too, so a
/// plan-mode pi is read-only by construction rather than by instruction. Every
/// other stance is ungated, which is pi's own default — it ships no permission
/// system, and the gate belongs to an extension the reader installs.
///
/// `stanceFor` in [permission.ts](../../../../src/lib/permission.ts) is the
/// other half of this and coerces anything else to `BypassPermissions` before
/// it is recorded, so a session's index entry says what actually happened.
///
/// **The composer no longer offers `Plan`, and this stays anyway.** pi honours
/// no stance now — its gate is an extension the reader installs and configures
/// on disk, which nothing passed at spawn can reach, so a picker there could
/// only have set something no extension reads. Two routes still reach `Plan`:
/// an index entry written before it was withdrawn, and a spawned session
/// inheriting a `plan` parent, which `orchestration` deliberately does not
/// clamp. Deleting this would run both of those ungated while their entry still
/// read `plan` — a restriction claimed and not carried, which is the alarming
/// direction. Enforcement kept, control withdrawn.
fn tools_for(mode: ApprovalPolicy) -> Option<Vec<&'static str>> {
    match mode {
        ApprovalPolicy::Plan => Some(PLAN_TOOLS.to_vec()),
        _ => None,
    }
}

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

    if let Some(tools) = tools_for(permission_mode) {
        args.push("--tools".into());
        args.push(tools.join(","));
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
    // Built here rather than at `Session` construction because the reader is
    // what registers entries and it starts first: an extension can ask before
    // the handshake even returns.
    let pending: PendingPermissions = Default::default();

    // Open before the reader, and before the handshake it starts for. pi can ask
    // a blocking question during startup — `resolveProjectTrusted` calls
    // `ctx.ui.select` for any directory holding `.pi` resources with no stored
    // decision — which is long before this session reaches `SessionManager`'s
    // map. See [`desk`] for the two windows and why the answer cannot go
    // through the session.
    let desk_token = desk::open(session_id, client.clone(), pending.clone(), seq.clone());

    // The ring's denominator, filled by the handshake below and read by the
    // mapper at every turn's end. Minted here because the reader has to start
    // *before* that handshake — nothing settles a request except a line off
    // stdout — so the mapper exists a moment before its window does. `0` until
    // then, which draws no ring rather than a wrong one.
    let context_window = Arc::new(AtomicU64::new(0));

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
        let pending = pending.clone();
        let context_window = context_window.clone();
        let desk_id = session_id.clone();
        let teardown_app = app.clone();
        async move {
            if let Err(error) = read_stdout(
                stdout,
                client,
                session_id,
                session_cwd,
                events,
                status,
                queued,
                pending,
                seq,
                context_window,
                app,
            )
            .await
            {
                eprintln!("Failed to read pi stdout: {error}");
            }

            // The reader ending is the one signal that covers every way a pi can
            // leave — asked to, killed, crashed, or never past the handshake —
            // so the desk ends here and nowhere else. A stale one answers: the
            // click takes the entry, the line joins a queue whose writer has
            // already broken, and the card retires saying "Answered" for a reply
            // that reached nothing.
            //
            // By token, because a respawn reuses the session id and nothing
            // joins this task: without it a slow teardown retires the *next*
            // pi's dialog and takes its desk with it.
            desk::end(&desk_id, desk_token, &teardown_app);
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
    let state = client
        .request_within("get_state", Value::Null, HANDSHAKE_TIMEOUT)
        .await;

    let state = match state {
        Ok(state) => state,
        Err(error) => {
            // Everything above is post-spawn, so the child is running with
            // nobody left to talk to it. Killed rather than dropped: a `Child`
            // is not reaped on drop, so every failed start would leave a pi
            // alive for the life of the app.
            //
            // Asked whether it is still there first, because the two failures
            // want different cures and read identically without this: a child
            // that *exited* took its reason with it to stderr, where one still
            // running and silent is pi not answering a command this build
            // sends.
            let died = child.try_wait().ok().flatten();
            shutdown(&mut child, &client).await;

            return Err(error).with_context(|| match died {
                Some(status) => format!("pi exited during the handshake ({status})"),
                None => "pi did not answer the handshake".to_string(),
            });
        }
    };

    // The one number the ring cannot derive. Read off the handshake rather than
    // asked for per turn, which the reader could not do anyway: a request is
    // settled by a line off stdout, so awaiting one inside the read loop waits
    // on itself. Sound for the child's life — pi respawns for a model change,
    // so nothing moves the window under a running session.
    if let Some(window) = state["model"]["contextWindow"].as_u64() {
        context_window.store(window, Relaxed);
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
        pending_permissions: pending,
        queued,
    })
}

/// Where a prompt sent into a running turn lands.
///
/// pi keeps two queues and `streamingBehavior` picks which one, verified live:
/// a steered prompt was read at the **next tool-call boundary inside the run**,
/// before the model call after it, and the answer came back mid-turn. The
/// default waits for the whole run to end.
///
/// Both are pi's, not Dray's, which is why steering needs no queue on this side
/// at all — see [`Session::steer`](crate::session::Session::steer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// pi's own default: this prompt starts a run, or waits for the one running
    /// to finish. What `dray send` and an idle composer both want.
    WhenIdle,
    /// Into the turn already running, at its next tool-call boundary.
    Steer,
}

/// Registers one dialog, unless the reader has stopped the run that raised it.
/// Answers whether it was taken.
///
/// Refused after a Stop because the drain Stop performs is a snapshot and pi is
/// lines ahead of it — a dialog raised as the abort goes out would otherwise
/// survive it.
///
/// **The check sits under the pending lock, with the registration, and that is
/// the whole of what makes it sound.** `begin_stop` stores the flag before Stop
/// takes this lock to drain, so both orders end correctly: register first and
/// the drain that follows finds this entry and cancels it; drain first and the
/// flag is visible here — the mutex is what publishes a `Relaxed` store — so
/// this refuses. Checked *before* taking the lock, the two become separate
/// steps on two threads and a dialog landing between them survives a Stop that
/// has already reported itself done.
///
/// Split out to be called rather than inlined, so the test can exercise the
/// same code the read loop runs instead of a second copy of its ordering.
fn register_dialog(
    client: &PiClient,
    pending: &PendingPermissions,
    request_id: &str,
    request: crate::harness::claude_code::permissions::PendingRequest,
) -> bool {
    let mut guard = pending.lock().expect("pending permissions mutex poisoned");

    if client.stopping() {
        return false;
    }

    guard.insert(request_id.to_string(), request);
    true
}

/// Writes one prompt.
///
/// pi answers `success: true` the moment it *accepts* one, and its docs say
/// failures after acceptance arrive through the event stream rather than as a
/// second response. So awaiting this proves the prompt was taken and nothing
/// else — still worth awaiting, because a refusal then reaches the caller as an
/// error instead of as a prompt that vanished.
pub async fn send_prompt(
    client: &PiClient,
    text: &str,
    delivery: Delivery,
    images: &[crate::attachments::PreparedImage],
) -> Result<()> {
    // The refusal window closes here, on the way out, and not on the inbound
    // `agent_start` it used to. Two reasons, and the first is the damaging one:
    // a new run's own preflight can ask before `agent_start` is ever published —
    // an extension command, an `input` handler, `before_agent_start` — so a
    // window keyed on that line was still open for a question the reader very
    // much wanted, and Dray refused it. And pi awaits its `agent_start` handlers
    // before publishing the line at all, so it was never proof the stopped run
    // had finished asking either.
    //
    // Only a prompt that starts a run. A steer joins the run that is already
    // going, which is the one the reader stopped.
    if matches!(delivery, Delivery::WhenIdle) {
        client.end_stop();
    }

    client
        .request("prompt", prompt_request(text, delivery, images))
        .await?;
    Ok(())
}

/// The `prompt` command's body.
///
/// Split out to be tested. A misspelled or misplaced `streamingBehavior` is not
/// refused by pi — an unknown field is dropped in silence — so the failure is a
/// steered prompt quietly waiting for the whole run instead, which reads as
/// steering not being wired at all.
fn prompt_request(
    text: &str,
    delivery: Delivery,
    images: &[crate::attachments::PreparedImage],
) -> Value {
    let mut request = json!({"message": text});

    // Omitted when there are none, because `prompt`'s own `images` is optional
    // and an empty array is this build stating something pi already assumes.
    //
    // Not gated on the model taking images: pi resolves the model itself when
    // Dray names none, so the app's copy of that answer can be absent or wrong,
    // and a provider refusing an image is a sentence the reader can act on
    // where silently dropping one is not. Before this the images were dropped —
    // the transcript drew the screenshot the reader attached and the model was
    // never given it.
    if !images.is_empty() {
        request["images"] = Value::Array(
            images
                .iter()
                .map(|image| {
                    json!({
                        "type": "image",
                        "data": image.data,
                        "mimeType": image.mime_type,
                    })
                })
                .collect(),
        );
    }

    // Omitted rather than sent as a default value: `models_and_steering.jsonl`
    // captures a prompt with no `streamingBehavior` at all landing in the
    // follow-up queue, so absent *is* the default and naming one would be this
    // build restating a decision pi already makes.
    if delivery == Delivery::Steer {
        request["streamingBehavior"] = json!("steer");
    }

    request
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
    pending: PendingPermissions,
    seq: Arc<AtomicU64>,
    context_window: Arc<AtomicU64>,
    app: AppHandle,
) -> Result<()> {
    let reader = BufReader::new(stdout);
    // Splits on `\n` alone, which is what pi's framing requires: `U+2028` and
    // `U+2029` are legal inside JSON strings, so a reader treating them as line
    // breaks would corrupt any record containing one.
    let mut lines = reader.lines();
    let mut mapper = mapper::Mapper::new(session_id.clone(), seq.clone(), context_window);
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
            record_failure(&session_id, "unknown_line", &parser::describe_line(&line), &line).await;
            continue;
        }

        // The model moved under a running child, which Dray itself never does
        // — it respawns — but a pi extension calling `setModel` does, and pi
        // reports it here whoever asked. The ring's denominator belongs to the
        // model, so it is re-read rather than left describing the old one.
        //
        // Spawned, never awaited: a request is settled by a line off stdout and
        // this loop is what reads them, so awaiting one here waits on itself.
        //
        // So the old window is dropped *here*, synchronously, rather than left
        // standing until the answer lands. That is about the *mixed* pair: a
        // fresh occupancy measured against the window of the model that left
        // reads as room where there is none, once the switch is onto a smaller
        // one.
        //
        // It does not make the gauge wait. A turn carrying no window falls
        // through to the previous turn's pair, which is a reading one turn old
        // with both halves from one model. Going dark instead would need the
        // fold to know that readings before this point are void — see
        // PI-PLAN.md.
        if matches!(event, parser::PiEvent::ModelChanged { .. }) {
            let client = client.clone();
            let context_window = mapper.context_window();
            context_window.store(0, Relaxed);
            tokio::spawn(async move {
                match client.request("get_state", Value::Null).await {
                    Ok(state) => {
                        if let Some(window) = state["model"]["contextWindow"].as_u64() {
                            context_window.store(window, Relaxed);
                        }
                    }
                    Err(error) => eprintln!("[pi] could not re-read the context window: {error:#}"),
                }
            });
        }

        // An extension asking the reader something. Answered from here and
        // never merely ignored: pi blocks the tool call until an
        // `extension_ui_response` carrying this id comes back, and
        // `ctx.ui.confirm` has no timeout, so silence stalls the session with a
        // complete transcript on screen and nothing saying why.
        if let parser::PiEvent::ExtensionUiRequest { id, method, title, .. } = &event {
            // Four of the nine block. The five in `ANNOUNCEMENTS` are output:
            // pi mints an id for them and registers no waiter, so a reply is
            // dropped. Drawing them is wanted and not built, and dropping them
            // quietly is the honest interim. Anything else is a method this
            // build has never seen, which is worth filing.
            let Some((request_id, request, questions)) = dialog::for_request(&event) else {
                if !dialog::ANNOUNCEMENTS.contains(&method.as_str()) {
                    let asked = title.clone().unwrap_or_else(|| method.clone());
                    record_failure(&session_id, "unsupported_request", &asked, &line).await;

                    // `cancelled` is the one answer every dialog understands,
                    // resolving each to the default it was built with. A refusal
                    // reaches the extension as its own dialog being dismissed,
                    // which is a state its author already had to handle.
                    let _ = client.send(&json!({
                        "type": "extension_ui_response",
                        "id": id,
                        "cancelled": true,
                    }));
                }
                continue;
            };

            let tool_use_id = request.tool_use_id.clone();
            if !register_dialog(&client, &pending, &request_id, request) {
                // `cancelled` is what every dialog understands, resolving each
                // to the default it was built with.
                let _ = client.send(&json!({
                    "type": "extension_ui_response",
                    "id": id,
                    "cancelled": true,
                }));
                continue;
            }

            // Registered before it is emitted, so a reader answering the frame
            // it appears cannot beat the entry that resolves the answer.
            let asked = mapper.synthesize(AgentEventPayload::QuestionsAsked {
                request_id,
                tool_use_id,
                questions,
            });

            if let Err(error) = app.emit("agent_event", &asked) {
                eprintln!("[pi emit err] {error}");
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `Plan` is the one stance pi can enforce, and it enforces it with a flag.
    #[test]
    fn plan_spawns_a_read_only_pi_and_nothing_else_gates() {
        assert_eq!(
            tools_for(ApprovalPolicy::Plan),
            Some(vec!["read", "grep", "find", "ls"])
        );

        for ungated in [
            ApprovalPolicy::BypassPermissions,
            ApprovalPolicy::Manual,
            ApprovalPolicy::Auto,
            ApprovalPolicy::DontAsk,
        ] {
            assert_eq!(
                tools_for(ungated),
                None,
                "{ungated:?} has nothing behind it on pi, so it must not \
                 half-apply a restriction"
            );
        }
    }

    /// The allowlist holds no tool that writes.
    ///
    /// Read as a list it is obvious; the failure it guards is a later edit
    /// widening it to "the tools people usually want in plan mode", which is
    /// how `bash` gets in. `--tools` is what makes plan mode true rather than
    /// instructed, so every name here has to be one that cannot change the
    /// tree.
    #[test]
    fn the_plan_allowlist_admits_nothing_that_writes() {
        for mutating in ["bash", "powershell", "write", "edit"] {
            assert!(
                !PLAN_TOOLS.contains(&mutating),
                "{mutating} can change the tree, so plan mode cannot offer it"
            );
        }
    }

    /// Steering is one field, and pi drops an unknown one in silence.
    ///
    /// So a misspelling here does not fail — the prompt lands on the follow-up
    /// queue and waits out the whole run, which is exactly what steering not
    /// being wired at all looks like. Both spellings come from
    /// `models_and_steering.jsonl`, which captured a prompt of each kind.
    #[test]
    fn only_a_steered_prompt_names_a_streaming_behavior() {
        assert_eq!(
            prompt_request("go", Delivery::WhenIdle, &[]),
            json!({"message": "go"}),
            "absent is pi's own default, so naming one restates its decision"
        );

        assert_eq!(
            prompt_request("go", Delivery::Steer, &[]),
            json!({"message": "go", "streamingBehavior": "steer"})
        );
    }

    /// An attached screenshot reaches the model.
    ///
    /// It did not before: `prompt`'s `images` was never sent, so the transcript
    /// drew the picture the reader attached and pi was handed the text alone.
    /// Silent in both directions, which is what makes it worth a test rather
    /// than a glance — the field is optional, so its absence is not an error at
    /// either end.
    #[test]
    fn an_attached_image_rides_the_prompt() {
        let image = crate::attachments::PreparedImage {
            stored_path: "/tmp/shot.png".to_string(),
            mime_type: "image/png".to_string(),
            data: "aGk=".to_string(),
        };

        assert_eq!(
            prompt_request("look", Delivery::WhenIdle, std::slice::from_ref(&image)),
            json!({
                "message": "look",
                "images": [{"type": "image", "data": "aGk=", "mimeType": "image/png"}],
            })
        );

        assert_eq!(
            prompt_request("go", Delivery::WhenIdle, &[]),
            json!({"message": "go"}),
            "an empty array states what pi already assumes"
        );
    }

    /// The read loop names no dialog method of its own.
    ///
    /// Which methods block and which are announcements is stated once, in
    /// [`dialog`], and this is the half that drifted: the loop carried its own
    /// `"notify" | "setStatus"` while the list beside it grew, so `setTitle` and
    /// `setWidget` were filed as coverage gaps and answered with a refusal
    /// nobody was waiting for. Neither direction of that mistake produces an
    /// error — pi drops an unwanted reply in silence — so the guard has to be
    /// that the loop holds no opinion at all.
    #[test]
    fn the_read_loop_classifies_dialogs_only_through_the_lists() {
        let source = include_str!("pi.rs");
        let code = source
            .split("\n#[cfg(test)]")
            .next()
            .expect("there is always a first half");

        for method in dialog::BLOCKING.into_iter().chain(dialog::ANNOUNCEMENTS) {
            assert!(
                !code.contains(&format!("\"{method}\"")),
                "the read loop names {method} itself instead of asking `dialog`"
            );
        }
    }

    /// A Stop cannot leave a dialog registered behind it, however the two
    /// threads interleave.
    ///
    /// The reader registers dialogs and `Session::interrupt` drains them, on
    /// different threads and with no await between the check and the insert —
    /// so there is no scheduling point to reason from, only real parallelism.
    /// Checking the flag before taking the lock made those two separate steps,
    /// and a dialog landing between them outlived the Stop that had already
    /// reported itself done: a card raised by a run the reader had just ended,
    /// holding its extension open.
    ///
    /// Run rather than reasoned about, and against `register_dialog` itself
    /// rather than a copy of its ordering. The invariant is one sentence: once
    /// both halves have finished, nothing is left registered — either the insert
    /// landed before the drain and was drained, or the flag was visible and the
    /// insert was refused.
    #[test]
    fn a_stop_never_leaves_a_dialog_registered() {
        use crate::harness::claude_code::permissions::{PendingPermissions, PendingRequest};

        for round in 0..2_000 {
            let client = PiClient::detached();
            let pending: PendingPermissions = Default::default();

            let reader = {
                let client = client.clone();
                let pending = pending.clone();
                std::thread::spawn(move || {
                    register_dialog(
                        &client,
                        &pending,
                        "d-1",
                        PendingRequest {
                            tool_use_id: "d-1".to_string(),
                            tool_name: "confirm".to_string(),
                            input: serde_json::Value::Null,
                            options: Default::default(),
                            rpc_id: None,
                            pi_dialog_method: Some("confirm".to_string()),
                        },
                    )
                })
            };

            let stopper = {
                let client = client.clone();
                let pending = pending.clone();
                std::thread::spawn(move || {
                    // The order `Session::cancel_pending_dialogs` uses, and the
                    // order the argument rests on: the flag is stored before the
                    // lock is taken.
                    client.begin_stop();
                    let drained: Vec<_> = pending
                        .lock()
                        .expect("pending permissions mutex poisoned")
                        .drain()
                        .collect();
                    drained.len()
                })
            };

            let registered = reader.join().expect("reader thread");
            let drained = stopper.join().expect("stopper thread");

            assert!(
                pending.lock().unwrap().is_empty(),
                "round {round}: a dialog survived the Stop (registered {registered}, drained {drained})"
            );
            assert_eq!(
                registered, drained == 1,
                "round {round}: a registered dialog has to be the one drained"
            );
        }
    }

    /// Nothing here kills a pi except the one function allowed to.
    ///
    /// pi holds `~/.pi/agent/auth.json.lock` while it runs and a `SIGKILL`
    /// leaves it, so the cost of killing one is paid by the *next* pi, which
    /// waits the stale lock out for ~30s before answering anything. That is a
    /// rule with nothing enforcing it — a fourth teardown path reaching for
    /// `child.kill()` regresses in silence, and the symptom lands in a
    /// different session from the cause.
    ///
    /// So the rule is read off the source. The one permitted call is
    /// [`shutdown`]'s, after it has asked pi to leave and waited.
    #[test]
    fn only_shutdown_may_kill_a_pi() {
        let source = include_str!("pi.rs");
        // This module's own prose names the call it is banning, so read only
        // the half above it.
        let code = source
            .split_once("\n#[cfg(test)]")
            .map(|(code, _)| code)
            .expect("this file carries a test module");

        let kills = code.matches("child.kill()").count();

        assert_eq!(
            kills, 1,
            "every teardown goes through `shutdown`, which asks pi to exit \
             first — a kill anywhere else leaks the auth lock onto the next \
             spawn. Found {kills} `child.kill()` calls in this file."
        );
    }
}
