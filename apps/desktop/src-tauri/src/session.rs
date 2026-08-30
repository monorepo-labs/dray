use crate::{
    attachments,
    events::{
        now_rfc3339, AgentEvent, AgentEventPayload, ApprovalPolicy, ErrorSource, ImageRef,
        MessageSender, PermissionBehavior,
    },
    git,
    harness::{
        claude_code::{
            self,
            control::{ControlLine, ControlRequest},
            permissions::{answer_response, decision_response, PendingPermissions},
        },
    },
    issues::{self, IssueRef},
    models::{find_model, resolve_effort, runs_on, Effort, Model, ModelId},
    store::{
        append_session_event, append_session_index_item, clear_fork_from, copy_session_log,
        delete_session, get_session_index_item, link_session_issue, list_session_events,
        relocate_session_to_project, resolve_unclaimed_worktree_name, set_session_status,
        touch_session_index_item, worktree_path, SessionIndexItem, SessionSnapshot, SessionStatus,
    },
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;
use uuid::Uuid;

// `Harness` is defined in `crate::harness`; re-exported so existing
// `crate::session::Harness` imports keep working.
pub use crate::harness::Harness;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        Arc,
    },
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin},
    sync::Mutex,
};

/// Emitted as `session_status` when a session's status changes, so the sidebar
/// and composer update without a refetch. Like `SessionTitleEvent`, this is not
/// an `AgentEvent`: it's derived state, and must never reach the `.jsonl` log.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusEvent {
    pub session_id: String,
    pub status: SessionStatus,
    /// The entry's `modified` as the status write left it — completion bumps it,
    /// and the sidebar orders by it, so a session finishing has to move to the
    /// top without a refetch. `None` only when the id is no longer indexed.
    pub modified: Option<String>,
}

/// A prompt typed while a turn was running, held here until the turn reaches a
/// point where handing it to the CLI costs nothing.
///
/// It is *not* persisted while it waits, and that is what makes cancelling it
/// clean: the log is append-only, so a queued message written on arrival could
/// only be retracted with a tombstone event. Held here instead, a cancel leaves
/// no trace at all. Nothing is lost by waiting — the flush persists it, and the
/// only window where it exists solely in memory is one the user is still
/// allowed to take it back from.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub session_id: String,
    /// The raw prompt. Attachments are resolved at flush rather than now, so
    /// what the composer gets back on a cancel is what the user typed.
    pub text: String,
    pub attachment_paths: Vec<String>,
    /// Held with the prompt rather than looked up at flush: a relayed message
    /// can wait out a long turn, and the sending session may be renamed or
    /// deleted before the boundary that delivers it.
    #[serde(default)]
    pub from: Option<MessageSender>,
    /// Resolved when the prompt was typed, not at flush, for `from`'s reason:
    /// a held prompt can wait out a long turn, and re-reading the tracker at
    /// the boundary would put a network call — and its failure — inside the
    /// flush.
    #[serde(default)]
    pub issues: Vec<IssueRef>,
}

/// Held prompts, oldest first. Shared with the stdout task, which is where the
/// boundary that flushes them is seen.
pub type QueuedMessages = Arc<Mutex<Vec<QueuedMessage>>>;

/// What a send did. The two fields are mutually exclusive in practice — a
/// session being created cannot already be running a turn — but they answer
/// different questions and the frontend acts on each separately.
#[derive(Debug, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    /// `Some` only when this send created the session.
    pub snapshot: Option<SessionSnapshot>,
    /// `Some` when a turn was already running, so the prompt is held rather
    /// than sent. The frontend draws it as pending and can still take it back.
    pub queued: Option<QueuedMessage>,
    /// Every issue the session is linked to now, as written.
    ///
    /// Answered on **every** path — created, live, queued and resumed — because
    /// a `#DRA-53` is expanded and recorded on every one of them, and the
    /// frontend has no other way to learn what a prompt just linked. Without it
    /// a tag typed into an existing session persisted in Rust and reached the
    /// panel only on a reselect or a restart: the Issue tab went on drawing the
    /// session's old links while the index on disk held the new ones.
    ///
    /// The whole list rather than what this send added, for [`store::
    /// link_session_issue`]'s reason — re-tagging *replaces* an entry, so what
    /// changed is not a set the caller can apply on its own.
    pub issues: Vec<IssueRef>,
}

/// Drives [`SessionStatus`] from the mapped event stream plus the user's own
/// sends.
///
/// Two axes, deliberately kept apart. The status follows the *turn*: a `result`
/// completes it, whatever background tasks are outstanding. The task set is
/// recorded beside it and answers one question only — whether the child can be
/// replaced — because a subagent that reports back later opens its own turn
/// (a promptless `init`) to do so, while a `local_bash` task may never end.
#[derive(Debug, Default)]
pub struct StatusTracker {
    status: SessionStatus,
    /// An `init` opened a model call that no `result` has closed yet.
    model_call_open: bool,
    /// Ids of the outstanding background tasks, not just how many. The count is
    /// all the status machine needs, but Stop has to name each one to the CLI —
    /// an interrupt does not touch them.
    background_tasks: Vec<String>,
    /// Main-thread tool calls started and not yet finished. Not a status input —
    /// it decides whether an arriving prompt is written now or held.
    open_tool_calls: usize,
}

impl StatusTracker {
    /// The user sent a prompt; work is starting regardless of what stdout says.
    pub fn on_send(&mut self) -> Option<SessionStatus> {
        self.model_call_open = true;
        self.set(SessionStatus::InProgress)
    }

    /// Advances on one mapped event. `Some` when the status changed — the
    /// caller persists and emits only then.
    pub fn on_event(&mut self, payload: &AgentEventPayload) -> Option<SessionStatus> {
        match payload {
            // Fires per model call, not per prompt — including the call the
            // agent opens for itself to report a finished background task. That
            // one arrives with no send in front of it, so a completed session
            // must be able to go straight back to in-progress here.
            AgentEventPayload::TurnStarted(_) => {
                self.model_call_open = true;
                self.set(SessionStatus::InProgress)
            }
            // A `result` ends the turn whatever tasks are outstanding. Holding
            // the session open on them was built for a subagent that reports
            // back later — but that report opens its own turn (`TurnStarted`
            // above), so the hold bought nothing there and cost everything for
            // a `local_bash` task that never ends: a dev server, a Monitor, a
            // poll loop kept the Stop button, the indicator and the completion
            // notice hanging until the reader clicked Stop.
            AgentEventPayload::TurnCompleted { .. } => {
                self.model_call_open = false;
                self.set(SessionStatus::Completed)
            }
            // Recorded, never a status input. The set has its own indicator
            // and its own per-task Stop.
            AgentEventPayload::BackgroundTasksChanged { tasks } => {
                self.background_tasks = tasks.iter().map(|t| t.task_id.clone()).collect();
                None
            }
            _ => None,
        }
    }

    /// Whether anything at all is still working, background tasks included.
    ///
    /// The safe-to-replace-the-child question, and nothing else. Wider than the
    /// status: a session whose turn ended reads `Completed` while a background
    /// task still runs, and killing that child would take the task with it.
    pub fn has_outstanding_work(&self) -> bool {
        self.model_call_open || !self.background_tasks.is_empty()
    }

    /// Whether a model call is open right now. Two readers: it decides that an
    /// arriving prompt is queued rather than sent — read *before* `on_send`,
    /// which opens one unconditionally and would answer for itself — and it is
    /// what [`SessionManager::fork`] refuses on.
    ///
    /// Also exactly what [`SessionStatus::InProgress`] reports, which is the
    /// reading the sidebar's own fork guard takes. Neither side can call the
    /// other, so that equivalence is pinned by test rather than assumed.
    ///
    /// Deliberately narrower than [`has_outstanding_work`](Self::has_outstanding_work). A background task
    /// keeps that one true long after its turn ended, but the CLI's main thread
    /// is idle and answers a prompt straight away — verified
    /// against v2.1.232, where a prompt written with a background `sleep 300`
    /// outstanding was answered in 1.8s. Queueing on status instead held that
    /// prompt until the task drained, and since a `local_bash` task emits none
    /// of the boundaries `read_stdout` flushes at, "until it drained" was the
    /// whole wait.
    pub fn turn_in_flight(&self) -> bool {
        self.model_call_open
    }

    /// The status the sidebar draws from, so a guard here can be checked
    /// against the word the frontend reads.
    pub fn status(&self) -> SessionStatus {
        self.status
    }

    /// The outstanding background tasks, for a Stop that has to name each one.
    ///
    /// The set is republished whole on every change, so this is simply the
    /// latest reading rather than anything accumulated.
    pub fn background_task_ids(&self) -> Vec<String> {
        self.background_tasks.clone()
    }

    /// Counts main-thread tool calls in and out. Fed separately from
    /// [`Self::on_event`] because only the caller holds the event envelope, and
    /// a *subagent's* tool call must not count: it runs on its own thread and
    /// its result is not a point where the CLI injects a queued prompt.
    pub fn note_tool_call(&mut self, payload: &AgentEventPayload) {
        match payload {
            AgentEventPayload::ToolCallStarted { .. } => self.open_tool_calls += 1,
            AgentEventPayload::ToolCallCompleted { .. } => {
                self.open_tool_calls = self.open_tool_calls.saturating_sub(1)
            }
            // A turn cannot end with a call still running, and an interrupt ends
            // one without completing its calls — so the count is reset here
            // rather than left to drift up over a session.
            AgentEventPayload::TurnCompleted { .. } => self.open_tool_calls = 0,
            _ => {}
        }
    }

    /// Whether a main-thread tool call is running right now.
    ///
    /// This is what decides that a prompt goes out immediately instead of being
    /// held: the CLI injects a buffered prompt at the next tool *result*, and
    /// while a tool runs that result is still ahead — so writing now catches it,
    /// where waiting for the boundary this app can see would miss it by the few
    /// milliseconds between the result line and the model call that follows it.
    pub fn tool_in_flight(&self) -> bool {
        self.open_tool_calls > 0
    }

    /// The user read the finished session. Only `Completed` clears — selecting
    /// a running session must not stop it reading as busy.
    pub fn mark_seen(&mut self) -> Option<SessionStatus> {
        (self.status == SessionStatus::Completed)
            .then(|| self.set(SessionStatus::Idle))
            .flatten()
    }

    fn set(&mut self, next: SessionStatus) -> Option<SessionStatus> {
        (self.status != next).then(|| {
            self.status = next;
            next
        })
    }
}

/// Deletes the worktree an index entry names, if it names one.
///
/// A session that never had a worktree is a no-op rather than an error: this
/// sits on the delete path too, where most sessions have no tree to remove.
///
/// The path is rebuilt from `project_path` and the name rather than read off
/// `cwd`. The two agree today, but `cwd` is a field the agent can move —
/// `EnterWorktree` relocates a live session — and the one argument this must
/// never get wrong is which directory to delete.
async fn remove_session_worktree(item: &SessionIndexItem) -> Result<()> {
    let Some(name) = item.worktree_name.as_deref() else {
        return Ok(());
    };

    let path = worktree_path(&item.project_path, name);
    // Claude Code's own naming, minted at creation and never written to the
    // index — the same rebuild `sessionBranch` does on the frontend.
    let branch = format!("worktree-{name}");

    git::remove_worktree(&item.project_path, &path, Some(&branch)).await?;

    Ok(())
}

/// Persists a status change and tells the frontend. Failures are logged, not
/// propagated: status is derived state, and losing one update must not take
/// down the stdout loop that noticed it.
pub async fn publish_status(session_id: &str, status: SessionStatus, app: &AppHandle) {
    // Read back off the write rather than recomputed here: which statuses bump
    // `modified` is `set_session_status`'s rule, and stating it twice is how the
    // sidebar and the disk drift apart.
    let modified = match set_session_status(session_id, status).await {
        Ok(item) => item.map(|i| i.modified),
        Err(e) => {
            eprintln!("[status write err] {e}");
            None
        }
    };

    let event = SessionStatusEvent {
        session_id: session_id.to_string(),
        status,
        modified,
    };
    if let Err(e) = app.emit("session_status", &event) {
        eprintln!("[status emit err] {e}");
    }
}

#[derive(Debug)]
pub struct SessionManager {
    pub sessions: Mutex<HashMap<String, Session>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl SessionManager {
    /// Routes a prompt to a session: spawns a new child, reuses a live one, or
    /// respawns via `--resume` when the id is known but its process is gone.
    pub async fn send_msg(
        &self,
        session_id: &str,
        prompt: &str,
        // Absolute paths of what the composer had attached. Re-read here rather
        // than uploaded: the frontend holds a thumbnail, not bytes.
        attachment_paths: &[String],
        // Issues named outright rather than tagged in the text. `dray new
        // --issue` is the only caller: the app sends none, since nothing in it
        // starts a session against a row. Merged with the prompt's own `#` tags,
        // which is why one list arrives here and not two — and naming an issue
        // here is what *links* it, where a tag in the text only mentions.
        issue_ids: &[String],
        harness: Harness,
        model: ModelId,
        effort: Option<Effort>,
        permission_mode: ApprovalPolicy,
        cwd: &str,
        // Recorded, not acted on: the picker checks the branch out when the
        // user picks it, so by here the tree is already on it.
        branch: Option<&str>,
        use_worktree: bool,
        worktree_name: Option<&str>,
        // Where the worktree starts from, already resolved to a git ref by the
        // caller — the orchestration socket turns a session id into one, and
        // nothing below here knows sessions. `None` is the ordinary case and
        // hands the tree to `claude -w`, which forks it from `origin/<default>`.
        base_ref: Option<&str>,
        is_new_session: bool,
        // Set only for a session created over the orchestration socket. The
        // composer never has one, and it is recorded rather than acted on —
        // the depth cap reads it back off the index on the *next* create.
        parent_session_id: Option<&str>,
        // The session that relayed this prompt, for a message arriving over the
        // orchestration socket. `None` everywhere else: the composer's prompts
        // are the user's own, and a `user_message` with a sender is drawn
        // differently.
        from: Option<MessageSender>,
        app: &AppHandle,
    ) -> Result<SendOutcome> {
        // Resolved against whichever table can name it. The two single-vendor
        // harnesses have one written here; pi's list is answered by the machine,
        // so its models are looked up in what the probe last reported.
        //
        // `None` is legal for pi alone and means "let pi decide" — its own
        // settings already name a model, and Dray naming one it might have no
        // key for is the worst possible first run.
        let model_spec = match harness {
            Harness::Pi => crate::harness::pi::models::find(&model).await,
            _ => Some(find_model(&model).with_context(|| format!("unknown model {model}"))?),
        };

        // A model belongs to exactly one harness, and the pair reaches here from
        // two places that each know only half of it — the composer's stored
        // defaults and the `dray` CLI's own flags — so nothing upstream makes
        // them agree. Refused rather than quietly repaired: a session running on
        // a model nobody picked is the failure that looks like success.
        //
        // The unset sentinel is exempt: it names no model, so there is nothing
        // to be wrong about, and refusing it would refuse pi's own default.
        if !model.is_unset() && !runs_on(&model, harness) {
            let named = model_spec
                .as_ref()
                .map(|m| m.label.clone())
                .unwrap_or_else(|| model.to_string());
            bail!("{named} is not a {} model", harness.label());
        }

        let effort = model_spec
            .as_ref()
            .and_then(|spec| resolve_effort(spec, effort));

        // Resolved once for every path below — created, live, queued and
        // resumed alike — so a `#DRA-53` means the same thing whichever one the
        // prompt takes. The prompt comes back with any *named* issue appended as
        // a tag, so from here `prompt` is what the model will actually be given
        // and the transcript will actually draw. Best effort by design: an
        // unreachable tracker leaves the text as it was and costs nothing else.
        //
        // Two lists, and the split is the point: `mentioned` rides the prompt
        // event so the tag draws as a button, `linked` is written onto the
        // session and holds only what a caller named outright. See
        // [`issues::expand_tags`].
        let expanded = issues::expand_tags(prompt, issue_ids).await;
        let prompt = expanded.prompt.as_str();
        let issues = &expanded.mentioned;
        let linked_issues = &expanded.linked;

        if is_new_session {
            // Refused before anything is written, and that ordering is the
            // whole of it. The index entry lands before spawn on purpose, so a
            // session failing for a reason we could not predict is still
            // visible in the sidebar — but a missing CLI is predictable, and
            // taken through that path it leaves an empty row pointing at an
            // agent that can never start, which every retry fails against
            // identically.
            //
            // Refusing here instead means there is nothing to delete and
            // nothing to select: the composer never unmounts, `useDraft` still
            // holds the text under the new-task key, and retry is pressing send
            // again once the CLI is installed.
            if !crate::binpath::agent_available(harness).await {
                bail!(
                    "{} isn't installed. Install it with `{}`, then send again.",
                    harness.label(),
                    harness.install_command(),
                );
            }

            // Only Claude Code's `-w` makes its own tree. For everything else
            // the tree has to be one Dray makes — the same route `--from`
            // already takes, started where the CLI would have started it.
            // Without this the tree is never created, and the session bails
            // inside `Session::init` with its row already in the index: a
            // sidebar row pointing at a directory that never existed and can
            // never start. `HEAD` where there is no remote, matching what the
            // CLI itself falls back to when the fetch fails.
            let resolved_base = match (harness.caps().creates_own_worktree, use_worktree, base_ref) {
                (false, true, None) => {
                    Some(git::default_base(cwd).await.unwrap_or_else(|| "HEAD".into()))
                }
                _ => None,
            };
            let base_ref = base_ref.or(resolved_base.as_deref());

            let worktree_name = if use_worktree {
                Some(resolve_unclaimed_worktree_name(cwd, worktree_name).await?)
            } else {
                None
            };

            let session_cwd = match &worktree_name {
                Some(name) => worktree_path(cwd, name),
                None => cwd.to_string(),
            };

            // Read back rather than taken from the caller: the picker sends
            // `None` when the user didn't touch it, and the repo is still on
            // some branch worth recording. Non-repos report `None` and stay that
            // way.
            //
            // Ahead of the worktree below, though it reads the project root and
            // `worktree add` never moves that HEAD: it is one more fallible step
            // that would otherwise sit inside the window the rollback has to
            // cover, and the shortest window is the one least able to go wrong.
            let branch = match branch {
                Some(b) => Some(b.to_string()),
                None => git::list_branches(cwd).await?.current,
            };

            // A base ref is the one case Dray makes the tree itself. The harness
            // cannot be told where to fork from — `-w` resolves the default
            // branch and fetches `origin/<it>`, and its flag surface exposes no
            // base at all — so the tree is created here and the child is spawned
            // *into* it with no `-w`. Refused for a session with no worktree,
            // which would mean checking a ref out over whatever the reader has
            // in the project root.
            //
            // Ahead of the index write, unlike the spawn below: a base git
            // cannot resolve has left nothing behind at all and the caller is
            // getting the error.
            let owned_worktree = match (base_ref, &worktree_name) {
                (Some(base), Some(name)) => {
                    git::create_worktree(cwd, name, base).await?;
                    true
                }
                (Some(_), None) => bail!("a base ref needs a worktree to check it out into"),
                (None, _) => false,
            };

            // Indexed before the process spawns, so a session that fails to
            // start is still visible rather than vanishing without a trace.
            let mut item = SessionIndexItem::new(
                session_id,
                harness,
                &session_cwd,
                cwd,
                worktree_name.as_deref(),
                branch.as_deref(),
                prompt,
                model,
                effort,
                permission_mode,
                parent_session_id,
            );
            // Written with the entry rather than linked after it: the row
            // appears before the child spawns, and a tab that arrived a beat
            // later would be one more thing moving while the first turn starts.
            item.issues = linked_issues.clone();

            // The one failure that has to undo the tree, and the row that just
            // failed to be written is exactly why: removal is offered from a
            // session's own row, so an orphan here is one nothing in the app can
            // ever reach and `git worktree remove` by hand is the only recovery.
            // The spawn below is deliberately *not* covered — by then the row
            // exists, and deleting the session already takes the tree with it.
            //
            // Only a tree Dray made. A `-w` one does not exist yet, and the
            // failed create above left nothing to undo.
            if let Err(e) = append_session_index_item(item.clone()).await {
                if owned_worktree {
                    // Logged, not propagated: the caller has to see what
                    // actually failed, not how the tidy-up went.
                    if let Err(undo) =
                        git::remove_worktree(cwd, &session_cwd, item.branch.as_deref()).await
                    {
                        eprintln!("could not roll back {session_cwd}: {undo}");
                    }
                }
                return Err(e);
            }

            // Detached: generation takes ~16s and the snapshot below is what the
            // composer waits on. The title written above stands until this lands.
            //
            // Spawned at the project root, not `session_cwd`, for the same
            // reason the harness child is: a worktree's directory does not exist
            // until the CLI creates it, and `current_dir` on a missing path
            // fails the spawn outright. Nothing waits on this, so that took
            // every worktree session's title with it in silence.
            crate::title::spawn_title_generation(session_id, harness, prompt, cwd, app);

            // Taken before the child exists, so nothing it does can end up
            // inside its own baseline. A worktree the CLI has yet to create has
            // no directory to snapshot, so that case resolves the fork point the
            // tree will start from instead — slightly approximate, since the CLI
            // fetches `origin/<default>` first and an upstream commit landing in
            // between would read as this turn's work. A tree created above has
            // none of that: it is on disk and clean, so its snapshot is exact.
            let baseline = match (owned_worktree, worktree_name.is_some()) {
                (false, true) => git::base_ref_tree(cwd).await,
                _ => git::snapshot_tree(&session_cwd).await,
            };

            // A tree we made is a directory that already exists and a checkout
            // already on the right commit, so the child starts in it and is told
            // nothing about worktrees at all. Every other creation spawns at the
            // project root, because the directory `-w` is about to make cannot
            // be `chdir`ed into before it exists.
            let (spawn_cwd, spawn_worktree) = if owned_worktree {
                (session_cwd.as_str(), None)
            } else {
                (cwd, worktree_name.as_deref())
            };

            let mut session = Session::init(
                session_id,
                harness,
                model_spec.as_ref(),
                effort,
                permission_mode,
                spawn_cwd,
                &session_cwd,
                spawn_worktree,
                is_new_session,
                None,
                app,
            )
            .await?;
            if let Err(error) = session
                .send_msg(prompt, attachment_paths, issues, baseline, from, app)
                .await
            {
                // Nothing has this session yet — it is inserted below — so
                // returning here is the last anything can reach that child, and
                // a `Child` is not reaped on drop. Reachable with the child
                // alive and well on Codex, where the send is a request the
                // server can refuse or leave unanswered.
                let _ = session.kill().await;
                return Err(error);
            }
            // The prompt event is synthesized by `send_msg`, so read the log
            // back rather than returning empty — otherwise the frontend's first
            // render drops the user's own message.
            let events = list_session_events(session_id).await?;
            self.sessions
                .lock()
                .await
                .insert(session_id.to_string(), session);

            // Returned so the frontend learns the resolved worktree name and
            // the backend-truncated title rather than guessing either.
            return Ok(SendOutcome {
                issues: item.issues.clone(),
                snapshot: Some(SessionSnapshot {
                    index_item: item,
                    events,
                }),
                queued: None,
            });
        }

        let mut sessions_guard = self.sessions.lock().await;

        // Decided here rather than by the caller: the frontend's own `busy` is
        // optimistic, and this is the only reading taken on the same lock the
        // write goes out under.
        // Three readings, not one, because the questions below differ: whether
        // anything is working at all decides that the child must not be
        // replaced, while only an open model call means this prompt has a turn
        // to be folded into.
        let (busy, turn_in_flight, tool_in_flight) = match sessions_guard.get(session_id) {
            Some(s) => {
                let tracker = s.status.lock().await;
                (
                    tracker.has_outstanding_work(),
                    tracker.turn_in_flight(),
                    tracker.tool_in_flight(),
                )
            }
            None => (false, false, false),
        };

        // Effort is fixed at spawn — the CLI has no `set_effort` control request
        // — so changing it means replacing the child. Resuming by id keeps the
        // conversation, and the log continues from the persisted seq.
        //
        // Never while anything runs, which is the *wider* reading on purpose:
        // the kill would destroy not just a turn in flight but every background
        // task the child is still carrying. The index still records the pick
        // below, so the next idle send is what respawns.
        // Codex respawns for its model and its stance as well. Not for want of
        // a per-turn override — `turn/start` carries model, effort and approval
        // policy, and this restates all three on every turn — but because a
        // stance is *two* settings and only one of them has a turn-level form.
        // `sandbox` is thread-level only, so applying a stance change in place
        // would move the approval policy and leave the sandbox where it was:
        // exactly the half-applied setting that makes a session more or less
        // free than the reader asked for. Respawning settles both at once, and
        // `thread/resume` carries the conversation across it.
        let respawn_needed = !busy
            && sessions_guard.get(session_id).is_some_and(|s| {
                let caps = s.harness.caps();

                (s.effort != effort && !caps.applies_effort_in_place)
                    || (s.model != model && !caps.applies_model_in_place)
                    || (s.permission_mode != permission_mode && !caps.applies_permission_in_place)
            });

        if respawn_needed {
            if let Some(s) = sessions_guard.remove(session_id) {
                s.kill().await?;
            }
        }

        // The caller's `cwd` is a hint for a new session only. From here on the
        // recorded one wins: with a project picker the two can disagree, and
        // resuming in the wrong directory is both silent and destructive. It is
        // also where the baseline gets snapshotted, so a stale value would
        // diff the wrong tree.
        let indexed = get_session_index_item(session_id).await?;
        let session_cwd = match &indexed {
            Some(item) => item.cwd.clone(),
            None => cwd.to_string(),
        };

        // Recorded before the prompt goes out, and before the queue branch
        // below returns: a tag on a prompt held behind a running turn still
        // says what the session is about, and the panel's tab should not wait
        // on a boundary to appear. Failures are logged and dropped — the link
        // is a record, and losing one must not cost the send.
        //
        // What each write answered with is kept, because that is what goes back
        // to the frontend: re-tagging *replaces* an entry rather than appending
        // one, so the list as written is not something the caller could work out
        // from `issues` alone. A session nothing was tagged on answers with the
        // links it already had, so every path can report the same fact.
        let mut linked = indexed
            .as_ref()
            .map(|item| item.issues.clone())
            .unwrap_or_default();
        for issue in linked_issues {
            match link_session_issue(session_id, issue.clone()).await {
                Ok(next) => linked = next,
                Err(e) => eprintln!("[issue link err] {e:#}"),
            }
        }

        if let Some(s) = sessions_guard.get_mut(session_id) {
            // Before the send, so the index reflects intent even if writing to
            // the child fails — the prompt event is persisted ahead of stdin too.
            touch_session_index_item(session_id, model.clone(), effort, permission_mode).await?;

            // A model call is open, so this prompt is held rather than sent, and
            // none of the live controls below fire with it. `set_model` and
            // `set_permission_mode` were verified switching an *idle* child;
            // what they do to a turn mid-flight is unknown, and a queued prompt
            // is not worth finding out on. The index above has the user's pick
            // either way, so the next idle send applies it.
            //
            // Gated on the turn, not on `busy`: a session holding a background
            // task reads busy with its main thread idle, and queueing there left
            // the prompt waiting on a boundary that task would never produce.
            if turn_in_flight {
                // A tool is running, so the CLI's next injection point — that
                // tool's result — is still ahead, and writing now is what lands
                // the prompt on it. Holding for the `tool_call_completed` this
                // app can see would miss it: the CLI dispatches the next model
                // call within a few milliseconds of emitting the result line, so
                // the prompt would sit in its buffer through another whole tool
                // call before being read. Measured, and the reason this branch
                // exists rather than one uniform hold.
                //
                // The cost is that there is no window to cancel in — which the
                // UI states by itself, since a prompt written straight through
                // draws no pending row and so offers no Esc.
                if tool_in_flight {
                    s.queue_and_flush(prompt, attachment_paths, issues, from, app)
                        .await;
                    return Ok(SendOutcome {
                        issues: linked,
                        ..Default::default()
                    });
                }

                let queued = s.queue_msg(prompt, attachment_paths, issues, from).await;
                return Ok(SendOutcome {
                    snapshot: None,
                    queued: Some(queued),
                    issues: linked,
                });
            }

            // The other side of the respawn rule above, and read off the same
            // table so the two cannot disagree. They were two equality tests
            // against two different harnesses, which is one edit away from a
            // pick that neither respawns for nor applies — recorded in the
            // index and never reaching the child.
            //
            // Reaching here with a changed pick at all means the respawn was
            // skipped because work was outstanding. The index still records it,
            // so the next idle send applies it.
            let caps = s.harness.caps();

            if caps.applies_model_in_place && s.model != model {
                // A harness that applies a model in place is one Dray names a
                // default for, so the spec is there by construction — the table
                // and `default_model_for` agree on which harnesses those are.
                let spec = model_spec
                    .as_ref()
                    .context("no model to switch the session to")?;
                s.set_model(spec).await?;
            }
            if caps.applies_permission_in_place && s.permission_mode != permission_mode {
                s.set_permission_mode(permission_mode).await?;
            }

            // Last thing before the prompt goes down the pipe: the child is idle
            // but alive, so the narrower the gap the less of the user's own
            // editing lands on the turn's side of the diff.
            let baseline = git::snapshot_tree(&session_cwd).await;
            s.send_msg(prompt, attachment_paths, issues, baseline, from, app)
                .await?;
            return Ok(SendOutcome {
                issues: linked,
                ..Default::default()
            });
        }

        touch_session_index_item(session_id, model, effort, permission_mode).await?;

        // A fork that hasn't spawned yet. The app's half happened when the user
        // asked for it — log copied, entry written — and this is the spawn that
        // carries out the CLI's, after which the session resumes like any other.
        let fork_from = indexed.as_ref().and_then(|i| i.fork_from.clone());

        // A fork into a *new* worktree is the one resume whose tree does not
        // exist yet, so it needs the creation treatment: `-w` to make the tree,
        // the project root to spawn in because a missing directory cannot be
        // `chdir`ed into, and the fork point as a baseline because there is no
        // tree to snapshot. Every other resume runs in a directory already there.
        let pending_worktree = fork_from
            .as_ref()
            .and(indexed.as_ref())
            .and_then(|i| i.worktree_name.clone());

        let (spawn_cwd, baseline) = match (&pending_worktree, &indexed) {
            (Some(_), Some(item)) => (
                item.project_path.clone(),
                git::base_ref_tree(&item.project_path).await,
            ),
            _ => (session_cwd.clone(), git::snapshot_tree(&session_cwd).await),
        };

        let mut session = Session::init(
            session_id,
            harness,
            model_spec.as_ref(),
            effort,
            permission_mode,
            &spawn_cwd,
            &session_cwd,
            pending_worktree.as_deref(),
            is_new_session,
            fork_from.as_deref(),
            app,
        )
        .await?;

        // After the spawn, so a child that fails to start leaves the instruction
        // standing and the next send forks again. Cleared before the prompt goes
        // out for the opposite reason: from here the CLI owns a session under
        // this id, and forking the parent a second time would abandon it.
        if fork_from.is_some() {
            clear_fork_from(session_id).await?;
        }

        if let Err(error) = session
            .send_msg(prompt, attachment_paths, issues, baseline, from, app)
            .await
        {
            // Same reason as the creation path above: the insert is below, so
            // this is the last reference to a child that is still running.
            let _ = session.kill().await;
            return Err(error);
        }
        sessions_guard.insert(session_id.to_string(), session);
        Ok(SendOutcome {
            issues: linked,
            ..Default::default()
        })
    }

    /// Copies a session onto a new id, to be continued separately from the one
    /// it came from. `worktree` puts the fork in a tree of its own rather than
    /// leaving it in the parent's directory.
    ///
    /// Nothing spawns here. The CLI's fork only happens on a spawn, and spawning
    /// one to sit idle would cost a child process per fork and a turn's wait
    /// before the row appeared — so this writes the app's half now and leaves
    /// [`fork_from`](crate::store::SessionIndexItem::fork_from) as the
    /// instruction for the first send. The copied log is what the fork replays
    /// meanwhile, so it opens reading exactly like its parent.
    ///
    /// Refused while the parent's turn is in flight, and on nothing wider. The
    /// CLI forks by reading the parent's transcript, which a live child is
    /// appending to mid-turn, so a fork taken there inherits half of one. A
    /// background task outstanding is not that case: it appends *after* the
    /// turn ended — that is how a subagent reports back — and what this takes
    /// is a copy at a point in time, which is what a fork is.
    ///
    /// Reading [`has_outstanding_work`](StatusTracker::has_outstanding_work)
    /// here was the bug. That is the safe-to-replace-the-child question, and
    /// this replaces no child — it borrowed a guard written for the paths that
    /// kill one. A `local_bash` task never ends on its own, so a session
    /// running a dev server could not be forked again for the rest of its life,
    /// while the menu item stayed enabled: the sidebar guards on
    /// `status === "in_progress"`, which the same `result` had already moved to
    /// `completed`. The two must answer one question, which they now do —
    /// `InProgress` *is* `turn_in_flight`, pinned by test. An item offering
    /// what this refuses reads as Fork being broken rather than busy.
    pub async fn fork(
        &self,
        session_id: &str,
        fork_id: &str,
        worktree: bool,
    ) -> Result<SessionSnapshot> {
        let parent = get_session_index_item(session_id)
            .await?
            .with_context(|| format!("unknown session {session_id}"))?;

        // Ahead of every write below, not left to the first send. A fork copies
        // the log and appends an index entry before any child exists, so a
        // refusal that late leaves a row in the sidebar holding a whole
        // conversation it can never carry on.
        if !parent.harness.caps().forkable {
            bail!("{} sessions cannot be forked yet", parent.harness.label());
        }
        if !parent.harness.names_a_cli() {
            bail!(
                "this session runs on {}, which this version of Dray can't drive — update Dray",
                parent.harness.label()
            );
        }

        if let Some(s) = self.sessions.lock().await.get(session_id) {
            if s.status.lock().await.turn_in_flight() {
                bail!("wait for the turn to finish before forking it");
            }
        }

        // Resolved against the project rather than the parent's own name, so a
        // fork of a fork can't collide with the tree it came from — and against
        // the index as well as disk, since a fork's tree does not exist until
        // its first send.
        let worktree_name = if worktree {
            Some(resolve_unclaimed_worktree_name(&parent.project_path, None).await?)
        } else {
            None
        };

        let events = copy_session_log(session_id, fork_id, &parent.cwd).await?;

        // The parent never got a conversation off the ground — indexed, then its
        // spawn failed — so the CLI has no transcript under that id to fork
        // from. Refused here, where it can be said plainly; left to the first
        // send it would come back as the CLI's own "no conversation found".
        // Checked after the copy because that read is what answers it, and it
        // writes nothing when there is nothing to write.
        if events.is_empty() {
            bail!("this session has no conversation to fork yet");
        }

        let item = parent.fork(fork_id, worktree_name.as_deref());
        append_session_index_item(item.clone()).await?;

        Ok(SessionSnapshot {
            index_item: item,
            events,
        })
    }

    /// Stops everything the session is doing: the turn in flight, and every
    /// background task still outstanding. Errors when no live child holds the
    /// id — nothing is running, so there is nothing to stop.
    ///
    /// The second half is not something the CLI's own interrupt does. Verified
    /// against v2.1.232: an interrupt aborts the turn's tools and streaming and
    /// leaves backgrounded tasks running, which is what backgrounding one means
    /// — so a session held open by a task alone had a Stop button that acked and
    /// changed nothing. Naming the tasks here is what makes one Stop mean stop.
    /// Per-task stops stay available in the subagent panel for the narrower ask.
    pub async fn interrupt(&self, session_id: &str) -> Result<()> {
        let mut sessions_guard = self.sessions.lock().await;
        let Some(session) = sessions_guard.get_mut(session_id) else {
            bail!("no running session {session_id}");
        };

        session.interrupt().await?;

        // Read after the interrupt, so a task the CLI did stop on its own is
        // already gone from the set rather than stopped twice. Harmless either
        // way — the CLI answers success for a task it no longer holds.
        let task_ids = session.status.lock().await.background_task_ids();
        for task_id in task_ids {
            // Logged, not propagated: the interrupt above already went out, and
            // one task refusing to stop must not hide that from the caller or
            // stop the tasks behind it in the list from being asked.
            if let Err(err) = session.stop_task(&task_id).await {
                eprintln!("[stop task err] {task_id}: {err}");
            }
        }

        Ok(())
    }

    /// Stops one of a session's background tasks. Errors for a dead child like
    /// the rest of these: the task ran inside that process and died with it.
    pub async fn stop_task(&self, session_id: &str, task_id: &str) -> Result<()> {
        let mut sessions_guard = self.sessions.lock().await;
        let Some(session) = sessions_guard.get_mut(session_id) else {
            bail!("no running session {session_id}");
        };
        session.stop_task(task_id).await
    }

    /// Takes back the newest prompt still waiting on a boundary, returning it
    /// so the composer can put the text back where the user left it.
    ///
    /// A session with no live child answers `None` rather than erroring: the
    /// queue died with the process, which is the same "nothing to take back"
    /// the frontend already handles.
    pub async fn cancel_queued(&self, session_id: &str) -> Option<QueuedMessage> {
        let sessions_guard = self.sessions.lock().await;
        let session = sessions_guard.get(session_id)?;
        session.cancel_queued().await
    }

    /// Answers a permission request. Errors when the session has no live child:
    /// the request died with the process, and the CLI will re-ask on resume.
    pub async fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        option_id: &str,
        app: &AppHandle,
    ) -> Result<()> {
        let mut sessions_guard = self.sessions.lock().await;
        let Some(session) = sessions_guard.get_mut(session_id) else {
            bail!("no running session {session_id}");
        };
        session.respond_permission(request_id, option_id, app).await
    }

    /// Answers an `AskUserQuestion`. Fails for a dead child like
    /// [`respond_permission`](Self::respond_permission) does, and for the same
    /// reason: only the process that asked can be told.
    pub async fn answer_questions(
        &self,
        session_id: &str,
        request_id: &str,
        answers: HashMap<String, String>,
        app: &AppHandle,
    ) -> Result<()> {
        let mut sessions_guard = self.sessions.lock().await;
        let Some(session) = sessions_guard.get_mut(session_id) else {
            bail!("no running session {session_id}");
        };
        session.answer_questions(request_id, answers, app).await
    }

    /// Deletes the worktree a session was running in and moves the session to
    /// its project root, keeping the transcript and everything in it.
    ///
    /// The child is killed first and unconditionally, even when it is idle:
    /// its working directory is about to stop existing, and the lock git
    /// refuses the removal over names that process. A session with no live
    /// child is the ordinary case here — this is offered on settle, which is
    /// something a reader does to finished work.
    ///
    /// Ordering is the whole of the method. Disk first, index second: an entry
    /// relocated before a removal that then failed would describe a session as
    /// living at the project root while its files sat in a directory nothing
    /// pointed at any more.
    pub async fn remove_worktree(&self, session_id: &str) -> Result<SessionIndexItem> {
        let item = get_session_index_item(session_id)
            .await?
            .with_context(|| format!("no session {session_id}"))?;

        if item.worktree_name.is_none() {
            bail!("that session is not running in a worktree");
        }

        if let Some(session) = self.sessions.lock().await.remove(session_id) {
            session.kill().await?;
        }

        remove_session_worktree(&item).await?;

        relocate_session_to_project(session_id)
            .await?
            .with_context(|| format!("no session {session_id}"))
    }

    /// Deletes a session: kills its child if one is running, then drops the
    /// index entry and the log. Returns whether the index held it.
    ///
    /// The child goes first and its lock is released before the disk work, so a
    /// dying process can't append one last event to a file we just removed.
    pub async fn delete(&self, session_id: &str) -> Result<bool> {
        let running = self.sessions.lock().await.remove(session_id);
        if let Some(session) = running {
            session.kill().await?;
        }

        // Best-effort for the same reason the attachments below are, and with
        // one cost worth naming: a removal that fails here orphans the tree
        // with no UI left to retry from, since the row it hung off is about to
        // go. `git worktree remove` by hand is the recovery. Failing the
        // delete instead would be worse — the session the user asked to be rid
        // of would still be there.
        //
        // Deliberately *not* covered by the card the frontend raises when
        // [`remove_worktree`] above is refused. That card corrects a "Deleted"
        // the reader was shown and sends them back to the session to try again;
        // here they were shown nothing to correct, and the session it would be
        // keyed to is the one being deleted — so it would be a card about a row
        // that is gone, whose button leads nowhere. Saying this properly means
        // naming the orphaned path with no session behind it, which is a
        // channel of its own and not this one.
        if let Some(item) = get_session_index_item(session_id).await? {
            if let Err(e) = remove_session_worktree(&item).await {
                eprintln!("could not remove worktree for {session_id}: {e}");
            }
        }

        // Best-effort: the images are a convenience for the transcript that is
        // about to stop existing, so failing to remove them must not fail the
        // delete the user asked for.
        if let Err(e) = attachments::delete_session_attachments(session_id).await {
            eprintln!("could not delete attachments for {session_id}: {e}");
        }

        // pi keeps its own transcript beside Dray's, because the *file* is its
        // resume handle. Left behind it is a whole conversation on disk that
        // nothing can ever reach again, the index entry naming it having just
        // gone. Best-effort and unconditional: a non-pi session has no such
        // file, and a missing one reads as done.
        if let Err(e) = crate::store::delete_pi_session_file(session_id).await {
            eprintln!("could not delete pi's session file for {session_id}: {e}");
        }

        delete_session(session_id).await
    }

    /// Clears a finished session's unread mark: `Completed` → `Idle`, anything
    /// else untouched. Returns the status as written, `None` for no change.
    ///
    /// The live tracker is updated first so the in-memory machine agrees with
    /// the index; a session with no live process falls back to the index alone.
    pub async fn mark_idle(&self, session_id: &str) -> Result<Option<SessionStatus>> {
        let sessions_guard = self.sessions.lock().await;

        if let Some(session) = sessions_guard.get(session_id) {
            let Some(next) = session.status.lock().await.mark_seen() else {
                return Ok(None);
            };
            set_session_status(session_id, next).await?;
            return Ok(Some(next));
        }
        drop(sessions_guard);

        match get_session_index_item(session_id).await? {
            Some(item) if item.status == SessionStatus::Completed => {
                set_session_status(session_id, SessionStatus::Idle).await?;
                Ok(Some(SessionStatus::Idle))
            }
            _ => Ok(None),
        }
    }
}

/// How a session writes to its child.
///
/// The two harnesses do not merely encode differently — they have different
/// shapes. Claude Code takes newline-delimited JSON and its reader shares the
/// pipe, because an unanswerable `control_request` has to be refused from where
/// it is read. `codex app-server` is a JSON-RPC peer, so every write goes
/// through one queue and a send has an answer worth waiting for.
///
/// An enum rather than two fields with one always `None`: a session has exactly
/// one way to write, and the compiler should say so.
#[derive(Clone, Debug)]
pub enum Transport {
    Lines(Arc<Mutex<ChildStdin>>),
    /// The conversation every Codex write is addressed to, and the settings
    /// each one restates. See [`Thread`](crate::harness::codex::Thread).
    Rpc(crate::harness::codex::Thread),
    /// pi's connection. A peer like Codex's, but not JSON-RPC and with nothing
    /// to address a write to: pi has one conversation per process, so the
    /// client is the whole of it.
    Pi(crate::harness::pi::rpc::PiClient),
}

impl Transport {
    /// The line-writing pipe, for the paths that only Claude Code has.
    ///
    /// An error rather than a silent no-op: reaching one of those with a
    /// session that writes some other way is a wiring mistake, and a control
    /// that quietly does nothing is the failure mode `control.rs` exists to
    /// warn about.
    pub fn lines(&self) -> Result<&Arc<Mutex<ChildStdin>>> {
        match self {
            Transport::Lines(stdin) => Ok(stdin),
            Transport::Rpc(_) | Transport::Pi(_) => {
                bail!("this control is not wired for this harness")
            }
        }
    }
}

#[derive(Debug)]
pub struct Session {
    pub id: String,
    pub child: Child,
    /// Shared with the stdout task, which has to write back on its own: an
    /// unanswerable `control_request` must be refused from where it is read,
    /// since the CLI blocks its turn until something replies.
    pub stdin: Transport,
    pub harness: Harness,
    pub model: ModelId,
    pub effort: Option<Effort>,
    pub permission_mode: ApprovalPolicy,
    pub events: Arc<Mutex<Vec<AgentEvent>>>,
    pub seq: Arc<AtomicU64>,
    /// Shared with the stdout task: sends flip it here, `result` and
    /// `background_tasks_changed` flip it there.
    pub status: Arc<Mutex<StatusTracker>>,
    /// Permission requests the mapper has registered and nobody has answered.
    pub pending_permissions: PendingPermissions,
    /// Prompts typed during a running turn, waiting for the next boundary.
    /// Shared with the stdout task, which is what flushes them.
    pub queued: QueuedMessages,
}

impl Session {
    /// Spawns the child process for the given harness.
    ///
    /// `model` is optional because pi's is: it is multi-provider, so Dray names
    /// no default it could be wrong about and lets pi's own settings decide.
    /// The other two name one in `default_model_for`, so `None` reaching them
    /// is a caller that skipped resolution rather than a state to spawn in.
    pub async fn init(
        session_id: &str,
        harness: Harness,
        model: Option<&Model>,
        effort: Option<Effort>,
        permission_mode: ApprovalPolicy,
        cwd: &str,
        // The session's own tree, for the turn-end snapshot. Differs from `cwd`
        // on a worktree creation, where the child spawns at the project root.
        session_cwd: &str,
        worktree_name: Option<&str>,
        is_new_session: bool,
        fork_from: Option<&str>,
        app: &AppHandle,
    ) -> Result<Session> {
        match harness {
            Harness::ClaudeCode => {
                claude_code::init(
                    session_id,
                    model.context("a Claude Code session needs a model")?,
                    effort,
                    permission_mode,
                    cwd,
                    session_cwd,
                    worktree_name,
                    is_new_session,
                    fork_from,
                    app,
                )
                .await
            }
            Harness::Codex => {
                // A worktree reaches Codex as a directory that already exists,
                // never as a name to create: `send_msg` resolves a base and
                // makes the tree itself, because Codex has no `-w`. A name
                // arriving here is a caller that skipped that, and a session
                // that silently ran in the wrong tree is the failure worth
                // refusing outright. A fork needs `thread/fork`, and forking
                // into the parent's own conversation is the same kind of wrong.
                if worktree_name.is_some() {
                    bail!("Codex cannot create a worktree — it has to be made first");
                }
                if fork_from.is_some() {
                    bail!("Codex sessions cannot be forked yet");
                }

                crate::harness::codex::init(
                    session_id,
                    model.context("a Codex session needs a model")?,
                    effort,
                    permission_mode,
                    cwd,
                    session_cwd,
                    is_new_session,
                    app,
                )
                .await
            }
            Harness::Pi => {
                // A worktree reaches pi as a directory that already exists,
                // never as a name to create — pi has no `-w`, so `send_msg`
                // resolves a base and makes the tree itself. A name arriving
                // here is a caller that skipped that, and a session that
                // silently ran in the wrong tree is worth refusing outright.
                if worktree_name.is_some() {
                    bail!("pi cannot create a worktree — it has to be made first");
                }
                if fork_from.is_some() {
                    bail!("pi sessions cannot be forked yet");
                }

                // `None` where pi picked for itself. The spawn omits `--model`
                // there, which is the honest answer for a multi-provider CLI
                // whose user has already configured one.
                crate::harness::pi::init(
                    session_id,
                    model,
                    effort,
                    permission_mode,
                    cwd,
                    session_cwd,
                    is_new_session,
                    app,
                )
                .await
            }
            // A session some newer build wrote into the shared index. Its
            // transcript still reads and its row still draws — that is what the
            // tolerant read bought — but there is no CLI here to carry it on,
            // and picking one would run a different agent inside somebody
            // else's conversation.
            Harness::Other(name) => {
                bail!("this session runs on {name}, which this version of Dray can't drive — update Dray")
            }
        }
    }

    /// Builds and saves the user's own prompt event, then writes it to the
    /// child's stdin — the CLI never echoes it back.
    ///
    /// `baseline` is the caller's working-tree snapshot, taken before this
    /// prompt reaches the child. It is passed in rather than taken here because
    /// only the manager knows which directory to snapshot: a worktree session's
    /// tree does not exist until the CLI creates it.
    pub async fn send_msg(
        &mut self,
        prompt: &str,
        attachment_paths: &[String],
        issues: &[IssueRef],
        baseline: Option<String>,
        from: Option<MessageSender>,
        app: &AppHandle,
    ) -> Result<()> {
        deliver_prompt(
            &self.id,
            self.harness,
            prompt,
            attachment_paths,
            issues,
            baseline,
            false,
            from,
            &self.seq,
            &self.events,
            &self.stdin,
            app,
        )
        .await?;

        // After the write: a prompt that never reached the child starts
        // nothing, and the command's error is what the frontend acts on.
        if let Some(next) = self.status.lock().await.on_send() {
            publish_status(&self.id, next, app).await;
        }

        Ok(())
    }

    /// Holds a prompt typed during a running turn. Nothing is written or
    /// persisted here — [`flush_queued`] does both once the turn reaches a
    /// boundary, which is what leaves a cancel possible until then.
    pub async fn queue_msg(
        &self,
        prompt: &str,
        attachment_paths: &[String],
        issues: &[IssueRef],
        from: Option<MessageSender>,
    ) -> QueuedMessage {
        let message = QueuedMessage {
            id: Uuid::now_v7().to_string(),
            session_id: self.id.clone(),
            text: prompt.to_string(),
            attachment_paths: attachment_paths.to_vec(),
            from,
            issues: issues.to_vec(),
        };
        self.queued.lock().await.push(message.clone());
        message
    }

    /// Takes back the newest held prompt, newest-first because that is the one
    /// the user just typed and the only one the composer is offering to undo.
    ///
    /// `None` means the flush won the race, which needs no handling beyond
    /// leaving the composer alone: the prompt is on its way and the frontend
    /// learns so from the `user_message` that follows.
    pub async fn cancel_queued(&self) -> Option<QueuedMessage> {
        self.queued.lock().await.pop()
    }

    /// Holds a prompt and immediately hands it over, for the case where a tool
    /// call is already running.
    ///
    /// Through the queue rather than written directly, so a prompt already
    /// waiting goes out ahead of this one instead of being overtaken.
    pub async fn queue_and_flush(
        &self,
        prompt: &str,
        attachment_paths: &[String],
        issues: &[IssueRef],
        from: Option<MessageSender>,
        app: &AppHandle,
    ) {
        self.queue_msg(prompt, attachment_paths, issues, from).await;
        flush_queued(
            &self.id,
            self.harness,
            &self.queued,
            &self.seq,
            &self.events,
            &self.stdin,
            &self.status,
            app,
        )
        .await;
    }

    /// Switches the model of a running child. Verified against the CLI: the
    /// reply after this arrives from the new model, so no respawn is needed.
    /// There is no `set_effort` counterpart — the CLI rejects that subtype, and
    /// an `effort` field on this request is accepted but ignored.
    pub async fn set_model(&mut self, model: &Model) -> Result<()> {
        write_line(
            self.stdin.lines()?,
            &ControlLine::new(ControlRequest::SetModel { model: &model.arg }),
        )
        .await?;
        self.model = model.id.clone();

        Ok(())
    }

    /// Interrupts the in-flight turn without killing the child. Verified
    /// against the CLI: it acks with a `control_response`, aborts running tools
    /// (`terminal_reason: "aborted_tools"`) or streaming
    /// (`"aborted_streaming"`), ends the turn as `error_during_execution`, and
    /// usually opens a follow-up turn to narrate the abort — so the status
    /// machine needs nothing special here, the resulting events drive it.
    pub async fn interrupt(&mut self) -> Result<()> {
        // Codex answers the ack immediately and ends the turn with its own
        // `turn/completed` carrying `interrupted`, so the reader is what
        // reports the stop — nothing waits here for the turn to actually end.
        if let Transport::Rpc(thread) = &self.stdin {
            return crate::harness::codex::interrupt_turn(thread).await;
        }

        // Two commands, in this order. `clear_queue` first because `abort`
        // ends the *running* agent and leaves anything steered or queued
        // behind it to start the moment it does — so aborting alone reads as
        // Stop having done nothing. It answers with what it dropped, which is
        // discarded here: the composer takes prompts back through
        // `cancel_queued`, and these are pi's own copies of ones the reader
        // has already seen sent.
        if let Transport::Pi(client) = &self.stdin {
            return crate::harness::pi::interrupt(client).await;
        }

        write_line(self.stdin.lines()?, &ControlLine::new(ControlRequest::Interrupt)).await?;

        Ok(())
    }

    /// Stops one background task by id.
    ///
    /// Separate from [`interrupt`](Self::interrupt) because the CLI keeps them
    /// separate: an interrupt with no turn in flight acks and leaves every
    /// running task alone, so it is no answer at all to the one state where the
    /// user is stuck — main thread idle, a task still holding the session open.
    ///
    /// Nothing is emitted here. The CLI republishes the task set and files a
    /// `task_notification` with `status: "stopped"` on its own, which is what
    /// settles the panel row and drives the status machine to completion — so
    /// minting anything would be a second source for what already arrives.
    ///
    /// The model is not told, and that is Claude Code's own behaviour rather
    /// than a gap left here. It notifies on a task *completing* — a
    /// `<task-notification>` user line naming the task and its exit — and says
    /// of stops in its own orphan-scan text that those made "via the UI, Monitor
    /// timeout, or agent teardown … leave no transcript marker". Synthesizing
    /// one would mean waking the model for a turn to announce something the
    /// harness deliberately keeps quiet.
    pub async fn stop_task(&mut self, task_id: &str) -> Result<()> {
        write_line(
            self.stdin.lines()?,
            &ControlLine::new(ControlRequest::StopTask { task_id }),
        )
        .await?;

        Ok(())
    }

    /// Switches the permission stance of a running child. Unlike effort, the CLI
    /// does have a `set_permission_mode` subtype, so this needs no respawn.
    pub async fn set_permission_mode(&mut self, mode: ApprovalPolicy) -> Result<()> {
        write_line(
            self.stdin.lines()?,
            &ControlLine::new(ControlRequest::SetPermissionMode {
                mode: mode.as_arg(),
            }),
        )
        .await?;
        self.permission_mode = mode;

        Ok(())
    }

    /// Answers a pending permission request and records the decision.
    ///
    /// The reply goes out before the event is minted: the CLI's turn is blocked
    /// on it, and a failure to persist the transcript row is not worth holding
    /// an agent still for. Taking the entry out of the map is what makes this
    /// single-shot — a second click on a card the frontend hasn't repainted yet
    /// finds nothing and errors rather than double-answering.
    pub async fn respond_permission(
        &mut self,
        request_id: &str,
        option_id: &str,
        app: &AppHandle,
    ) -> Result<()> {
        let (pending, chosen) = {
            let mut guard = self
                .pending_permissions
                .lock()
                .expect("pending permissions mutex poisoned");

            let pending = guard
                .get(request_id)
                .with_context(|| format!("no pending permission request {request_id}"))?;

            let chosen = pending
                .options
                .get(option_id)
                .with_context(|| format!("unknown permission option {option_id}"))?
                .clone();

            // Only removed once the option resolved: an unknown id leaves the
            // request answerable rather than stranding the turn.
            let pending = guard.remove(request_id).expect("just read under this lock");
            (pending, chosen)
        };

        // Answered on the channel that asked. Codex was handed its decision by
        // the server and sends it back whole; Claude's verdict is composed here
        // out of the rule the button carried.
        match (&self.stdin, pending.rpc_id) {
            (Transport::Rpc(thread), Some(rpc_id)) => {
                let decision = chosen
                    .decision
                    .clone()
                    .context("this option carries no decision to send")?;
                thread.client.respond(rpc_id, json!({"decision": decision}))?;
            }
            _ => {
                write_line(
                    self.stdin.lines()?,
                    &decision_response(request_id, &pending, &chosen),
                )
                .await?;
            }
        }

        let payload = AgentEventPayload::PermissionDecided {
            request_id: request_id.to_string(),
            tool_use_id: pending.tool_use_id,
            behavior: chosen.option.behavior,
            label: chosen.option.label,
            automatic: false,
        };

        // Emitted, never persisted — it exists to retire the request's card, and
        // the request itself is not persisted either. Still numbered through the
        // shared counter so the live transcript orders it correctly.
        let decision = AgentEvent {
            id: Uuid::now_v7().to_string(),
            session_id: self.id.clone(),
            harness: self.harness,
            seq: self.seq.fetch_add(1, Relaxed),
            ts: now_rfc3339(),
            turn_id: None,
            subagent: None,
            payload,
            raw: None,
        };

        app.emit("agent_event", &decision)?;

        Ok(())
    }

    /// Sends the user's answers back and retires the card.
    ///
    /// Single-shot and reply-first for the same reasons as
    /// [`respond_permission`](Self::respond_permission), and it mints the same
    /// `PermissionDecided` — the frontend has one way to clear a pending card,
    /// and giving questions a second one would mean two things to keep in step.
    /// The verdict is always an allow; the label is what actually happened,
    /// since no option was picked.
    ///
    /// An empty map is a skip, not an error: the harness turns it into "the user
    /// did not answer", which is the truthful thing to tell the agent.
    pub async fn answer_questions(
        &mut self,
        request_id: &str,
        answers: HashMap<String, String>,
        app: &AppHandle,
    ) -> Result<()> {
        let pending = {
            let mut guard = self
                .pending_permissions
                .lock()
                .expect("pending permissions mutex poisoned");

            guard
                .remove(request_id)
                .with_context(|| format!("no pending permission request {request_id}"))?
        };

        // Answered on the channel that asked, and in the shape that channel
        // reads. pi's extension dialogs are not a permission verdict at all —
        // each resolves the promise its own `ctx.ui` call returned — so they
        // carry their method here rather than share one envelope.
        match (&self.stdin, &pending.pi_dialog_method) {
            (Transport::Pi(client), Some(method)) => {
                client.send(&crate::harness::pi::dialog::response(method, request_id, &answers))?;
            }
            _ => {
                write_line(
                    self.stdin.lines()?,
                    &answer_response(request_id, &pending, &answers),
                )
                .await?;
            }
        }

        let payload = AgentEventPayload::PermissionDecided {
            request_id: request_id.to_string(),
            tool_use_id: pending.tool_use_id,
            behavior: PermissionBehavior::Allow,
            label: if answers.is_empty() {
                "Skipped".to_string()
            } else {
                "Answered".to_string()
            },
            automatic: false,
        };

        let decision = AgentEvent {
            id: Uuid::now_v7().to_string(),
            session_id: self.id.clone(),
            harness: self.harness,
            seq: self.seq.fetch_add(1, Relaxed),
            ts: now_rfc3339(),
            turn_id: None,
            subagent: None,
            payload,
            raw: None,
        };

        app.emit("agent_event", &decision)?;

        Ok(())
    }

    /// Ends the child process. Takes `self` by value — a stopped session can't
    /// be reused.
    ///
    /// pi is asked to exit rather than killed, and that is not politeness: it
    /// holds `~/.pi/agent/auth.json.lock` while it runs and a `SIGKILL`ed one
    /// leaves it behind, so the cost of killing lands on the **next** pi, which
    /// waits that stale lock out for ~30s before answering anything. Every
    /// caller here is one where another pi follows — a respawn for an effort
    /// change, an update install, a delete and retry.
    pub async fn kill(mut self) -> Result<()> {
        if let Transport::Pi(client) = &self.stdin {
            crate::harness::pi::shutdown(&mut self.child, client).await;
            return Ok(());
        }

        let _ = self.child.kill().await?;
        Ok(())
    }
}

/// Writes one JSON line to a child's stdin. The CLI's input format is
/// line-delimited, so the newline and the flush are part of the message rather
/// than tidiness.
///
/// Takes anything serializable rather than a built [`Value`](serde_json::Value),
/// so a typed line goes out without being rendered into one first.
pub async fn write_line(stdin: &Arc<Mutex<ChildStdin>>, value: &impl Serialize) -> Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');

    let mut guard = stdin.lock().await;
    guard.write_all(line.as_bytes()).await?;
    guard.flush().await?;
    Ok(())
}

/// Persists the user's own prompt event, emits it, then writes it to the
/// child's stdin — the CLI never echoes a prompt back, so this is the only
/// place it enters the transcript.
///
/// Free rather than a method because a queued prompt is delivered from the
/// stdout task, which holds the same handles but no `Session`.
#[allow(clippy::too_many_arguments)]
async fn deliver_prompt(
    session_id: &str,
    // Whose conversation this prompt joins. Recorded on the event rather than
    // assumed, since this is the one event Dray mints itself for every harness.
    harness: Harness,
    prompt: &str,
    attachment_paths: &[String],
    // Already resolved against the tracker by the caller. Appended to the text
    // the child is given, so the transcript keeps showing exactly what the
    // model was told — the same rule a non-image attachment's `@path` follows.
    issues: &[IssueRef],
    baseline: Option<String>,
    queued: bool,
    from: Option<MessageSender>,
    seq: &Arc<AtomicU64>,
    events: &Arc<Mutex<Vec<AgentEvent>>>,
    transport: &Transport,
    app: &AppHandle,
) -> Result<()> {
    let seq = seq.fetch_add(1, Relaxed);

    // Ahead of the event, because it is what decides the event's own text:
    // a non-image attachment becomes an `@path` mention on the prompt, and
    // the transcript has to show what the model was actually given.
    let prepared = attachments::prepare(session_id, prompt, attachment_paths).await?;
    let text = prepared.text;

    let payload = AgentEventPayload::UserMessage {
        text: text.clone(),
        issues: issues.to_vec(),
        images: prepared
            .images
            .iter()
            .map(|i| ImageRef {
                path: Some(i.stored_path.clone()),
                url: None,
                mime_type: Some(i.mime_type.clone()),
            })
            .collect(),
        baseline,
        queued,
        from,
        // Absent means "this session's own cwd", which is the truth for every
        // message a session logs itself. Only a fork records one.
        cwd: None,
    };
    let agent_event = AgentEvent {
        id: Uuid::now_v7().to_string(),
        session_id: session_id.to_string(),
        harness,
        seq,
        ts: now_rfc3339(),
        // Nothing tracks turns yet; Claude Code opens one per `init`.
        turn_id: None,
        subagent: None,
        payload,
        raw: None,
    };

    app.emit("agent_event", &agent_event)?;

    let mut events_guard = events.lock().await;
    events_guard.push(agent_event.clone());
    drop(events_guard);

    append_session_event(session_id, agent_event).await?;

    // Codex takes a prompt as a request that opens a turn, so the write is the
    // send rather than a line the child picks up on its own schedule. Images
    // ride a different shape there and are not wired yet; the text still goes.
    if let Transport::Rpc(thread) = transport {
        return crate::harness::codex::start_turn(thread, &text).await;
    }
    // pi takes a prompt as a command whose answer says it was accepted, so the
    // write is the send rather than a line the child picks up on its own
    // schedule. Images ride a different shape there and are not wired yet; the
    // text still goes.
    if let Transport::Pi(client) = transport {
        return crate::harness::pi::send_prompt(client, &text).await;
    }
    let stdin = transport.lines()?;

    // A bare string is the whole content when nothing is attached — the
    // shape every fixture captures, kept rather than always sending the
    // one-element block array it is sugar for.
    let content = if prepared.images.is_empty() {
        json!(text)
    } else {
        let mut blocks = Vec::new();
        if !text.is_empty() {
            blocks.push(json!({"type": "text", "text": text}));
        }
        for image in &prepared.images {
            blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.mime_type,
                    "data": image.data,
                },
            }));
        }
        json!(blocks)
    };

    let line = json!({"type":"user","message":{"role":"user","content": content}});
    write_line(stdin, &line).await
}

/// The handles a read loop needs once its harness has stopped being relevant.
///
/// Bundled rather than passed loose because [`ingest`] takes eight of them and
/// every harness's reader holds the same set.
pub struct Ingest<'a> {
    pub session_id: &'a str,
    /// Stamped on prompts flushed from the queue, which this mints itself.
    pub harness: Harness,
    /// The session's own tree, for the turn-end snapshot. Differs from the
    /// spawn directory on a worktree creation.
    pub session_cwd: &'a str,
    pub events: &'a Arc<Mutex<Vec<AgentEvent>>>,
    pub status: &'a Arc<Mutex<StatusTracker>>,
    pub queued: &'a QueuedMessages,
    pub flush_seq: &'a Arc<AtomicU64>,
    pub flush_events: &'a Arc<Mutex<Vec<AgentEvent>>>,
    pub flush_transport: &'a Transport,
}

/// Everything that happens to a mapped event, from the snapshot on a closing
/// turn to the queued flush at a boundary.
///
/// Lives here rather than in a harness because none of it is one harness's
/// business: which payloads are persisted, when the tree is snapshotted, where
/// a tool result's images are archived, and what counts as a boundary are all
/// properties of Dray's own event model. With a copy per harness they would
/// drift, and the drift would be silent — a second harness whose deltas were
/// persisted looks exactly like one whose logs are simply larger.
pub async fn ingest(ctx: &Ingest<'_>, mut agent_event: AgentEvent, app: &AppHandle) {
    // Filled here rather than in the mapper because only the session layer
    // knows the cwd. Freezing the tree id onto the closing event is what
    // stops an idle session's diff from absorbing everything that later
    // touches the same checkout. ~20ms once per turn; a background
    // subagent's writes land after this, but its report-back turn closes
    // with its own, fresher snapshot.
    if let AgentEventPayload::TurnCompleted { ref mut head, .. } = agent_event.payload {
        *head = crate::git::snapshot_tree(ctx.session_cwd).await;
    }

    // Here for the same reason: only the session layer knows which session's
    // directory the bytes belong in. Before the emit below, so the live
    // transcript and the replayed one load the same file.
    if let AgentEventPayload::ToolCallCompleted { ref mut result, .. } = agent_event.payload {
        crate::attachments::archive_result_images(ctx.session_id, &mut result.images).await;
    }

    // Read before the event is moved into the log below. These three are
    // the turn's boundaries in the sense that matters here: each is a point
    // where handing the CLI a held prompt costs nothing. A tool starting or
    // finishing means the next tool result — where the CLI injects a
    // buffered prompt — is still ahead, and a turn ending means there is no
    // result left to absorb one, so the prompt opens the next turn instead.
    //
    // A subagent's call counts here and deliberately does not in
    // `note_tool_call` below, because the two ask different questions.
    // That one asks whether a main-thread result is close enough ahead to
    // write straight through; this asks only whether handing over now is
    // safe, and it is at any point inside a turn — a prompt written early
    // waits in the CLI's own buffer for the same main-thread result it
    // would have waited here for.
    let at_boundary = matches!(
        agent_event.payload,
        AgentEventPayload::ToolCallStarted { .. }
            | AgentEventPayload::ToolCallCompleted { .. }
            | AgentEventPayload::TurnCompleted { .. }
    );

    if let Err(err) = app.emit("agent_event", &agent_event) {
        eprintln!("[emit err] {err}");
    }

    // One lock for both. The tool count is fed here rather than from inside
    // `on_event` because the subagent test needs the envelope: a subagent's
    // tool call runs on its own thread, and its result is not a point where
    // the CLI injects a queued prompt.
    let next_status = {
        let mut tracker = ctx.status.lock().await;
        if agent_event.subagent.is_none() {
            tracker.note_tool_call(&agent_event.payload);
        }
        tracker.on_event(&agent_event.payload)
    };
    if let Some(next) = next_status {
        publish_status(ctx.session_id, next, app).await;
    }

    // Live-view only, never retained. Deltas are superseded by the
    // committed event; a usage update is a running counter whose final
    // value lands on `turn_completed` — and `thinking_tokens` alone fires
    // dozens of times per turn, which would be most of a session's log.
    //
    // A permission request is here for a different reason: it is a question,
    // and it can only be answered by the child that asked. That child does
    // not survive a restart, so a persisted request would come back as a
    // card whose buttons cannot work. Dropping it is what makes the stale
    // card impossible rather than merely unlikely. Nothing is lost — the
    // tool call it belongs to is persisted and shows the outcome either way,
    // and a live card survives re-selection because the frontend keeps a
    // loaded session in memory rather than re-reading it.
    //
    // Questions are dropped on the same reasoning, and the "nothing is lost"
    // half holds harder there: the `AskUserQuestion` result the harness
    // writes carries both the questions and the answers, so the transcript
    // keeps the whole exchange without this line.
    if matches!(
        agent_event.payload,
        AgentEventPayload::Delta(_)
            | AgentEventPayload::UsageUpdate(_)
            // Transient by the same rule: it says a request is in flight,
            // and no request survives the process that made it. Persisting
            // it would also be most of a busy session's log — it fires once
            // per turn *and* once per tool result, 89 times in one capture.
            | AgentEventPayload::ModelRequestStarted
            | AgentEventPayload::PermissionRequested { .. }
            | AgentEventPayload::QuestionsAsked { .. }
            // The decision retiring a withdrawn card. Dropped for the same
            // reason as the request it retires, and to keep one rule: the
            // decision `Session::respond_permission` mints is emitted and
            // never written, so persisting this one would make "was it
            // answered" true of cancels and false of real answers.
            | AgentEventPayload::PermissionDecided { .. }
    ) {
        return;
    }

    // The data: URL a failed archive leaves behind must not reach the
    // retained copies: it is the whole image as base64, in a log read whole
    // on every open — the exact cost archiving exists to avoid. Stripped
    // here rather than in the archiver because the emit above must keep it:
    // the live transcript draws the picture either way, and only a reload
    // pays for the failure by showing the row without it.
    if let AgentEventPayload::ToolCallCompleted { ref mut result, .. } = agent_event.payload {
        for image in &mut result.images {
            image.url = None;
        }
    }

    ctx.events.lock().await.push(agent_event.clone());

    if let Err(err) = append_session_event(ctx.session_id, agent_event).await {
        eprintln!("[write err] {err}");
    }

    // After the boundary event is logged, so the prompt that follows it
    // lands behind it in the file as well as by `seq`. Cheap when the queue
    // is empty, which is nearly always.
    if !at_boundary {
        return;
    }

    // On a request/response transport the flush must not run on the read loop.
    //
    // Delivering a prompt there means `turn/start`, which waits for a response
    // that only the read loop can deliver — so awaiting it here is the reader
    // waiting on itself, and the session stops dead. Reachable, not theoretical:
    // type while Codex is working and the next tool boundary hangs the session.
    //
    // Spawned rather than made fire-and-forget so the send still reports its own
    // failure. Ordering is unaffected — the queue was drained under one lock, and
    // `flush_queued` already logs rather than propagates.
    if matches!(ctx.flush_transport, Transport::Rpc(_)) {
        let session_id = ctx.session_id.to_string();
        let harness = ctx.harness;
        let queued = ctx.queued.clone();
        let seq = ctx.flush_seq.clone();
        let events = ctx.flush_events.clone();
        let transport = ctx.flush_transport.clone();
        let status = ctx.status.clone();
        let app = app.clone();

        tokio::spawn(async move {
            flush_queued(
                &session_id, harness, &queued, &seq, &events, &transport, &status, &app,
            )
            .await;
        });
        return;
    }

    flush_queued(
        ctx.session_id,
        ctx.harness,
        ctx.queued,
        ctx.flush_seq,
        ctx.flush_events,
        ctx.flush_transport,
        ctx.status,
        app,
    )
    .await;
}

/// Hands every held prompt to the child, oldest first.
///
/// Called from the stdout loop on a tool call starting or finishing, or on the
/// turn ending. Those are the points where writing costs nothing: the CLI
/// buffers a mid-turn prompt and injects it at its *next* tool result, so a
/// prompt written while a tool runs lands on that tool's result rather than
/// waiting for the one after — and a turn that never calls a tool would not
/// have absorbed it at all, so flushing at the end just starts the new turn the
/// CLI would have started anyway.
///
/// Verified against the CLI: nothing is written back to say a prompt was
/// absorbed, so the boundary is the app's only handle on when to let go of one.
///
/// Failures are logged, not propagated — the stdout loop must survive anything,
/// and a prompt that cannot be written is one the user can retype.
pub async fn flush_queued(
    session_id: &str,
    harness: Harness,
    queued: &QueuedMessages,
    seq: &Arc<AtomicU64>,
    events: &Arc<Mutex<Vec<AgentEvent>>>,
    transport: &Transport,
    status: &Arc<Mutex<StatusTracker>>,
    app: &AppHandle,
) {
    // Drained under one lock so a cancel arriving mid-flush either takes a
    // message back before any of this or finds nothing — never races a
    // half-written batch.
    let batch: Vec<QueuedMessage> = std::mem::take(&mut *queued.lock().await);

    if batch.is_empty() {
        return;
    }

    let mut delivered = 0;

    for message in batch {
        // No baseline, and this is the load-bearing half of the queued case:
        // the changes panel pairs the newest baseline with the newest head
        // after it, so a snapshot taken here would cut the running turn's
        // range in two and credit it with only the work that came after this
        // prompt. `None` makes `changeRange` walk past it to the real prompt.
        match deliver_prompt(
            session_id,
            harness,
            &message.text,
            &message.attachment_paths,
            &message.issues,
            None,
            true,
            message.from,
            seq,
            events,
            transport,
            app,
        )
        .await
        {
            Ok(()) => delivered += 1,
            Err(err) => {
                eprintln!("[queued flush err] {err}");
                // Drawn, not only logged. The prompt is already on screen and in
                // the log — `deliver_prompt` writes the user's own event before
                // the send — so silence here leaves a message sitting above a
                // session that will never answer it, with nothing saying why.
                // It is out of the queue for good: retrying would mean a second
                // copy of an event already persisted.
                report_send_failure(session_id, harness, &err.to_string(), seq, events, app).await;
            }
        }
    }

    // A flush at `turn_completed` lands just after the tracker marked the
    // session finished, and the prompt it just wrote opens a new turn the CLI
    // has not announced yet. Without this the composer reads idle for the
    // second or so until `init` arrives — offering to send into a session that
    // is already working. Redundant at a tool boundary, where the session is
    // in-progress and `on_send` reports no change.
    //
    // Only where something actually reached the child. A batch that all failed
    // starts no turn, and reporting one would leave the session running forever
    // on a prompt the agent never received.
    if delivered == 0 {
        return;
    }
    if let Some(next) = status.lock().await.on_send() {
        publish_status(session_id, next, app).await;
    }
}

/// Files a prompt that could not be handed to the child as an error in the
/// transcript, beside the message it belongs to.
///
/// Persisted like the prompt above it, so reopening the session still explains
/// why that message was never answered. Not fatal: the session is intact and
/// the next prompt may well go through — the write is what failed, not the
/// conversation.
async fn report_send_failure(
    session_id: &str,
    harness: Harness,
    message: &str,
    seq: &Arc<AtomicU64>,
    events: &Arc<Mutex<Vec<AgentEvent>>>,
    app: &AppHandle,
) {
    let agent_event = AgentEvent {
        id: Uuid::now_v7().to_string(),
        session_id: session_id.to_string(),
        harness,
        seq: seq.fetch_add(1, Relaxed),
        ts: now_rfc3339(),
        turn_id: None,
        subagent: None,
        payload: AgentEventPayload::Error {
            source: ErrorSource::Process,
            message: format!("This message could not be sent: {message}"),
            fatal: false,
        },
        raw: None,
    };

    if let Err(err) = app.emit("agent_event", &agent_event) {
        eprintln!("[queued flush emit err] {err}");
    }
    events.lock().await.push(agent_event.clone());
    if let Err(err) = append_session_event(session_id, agent_event).await {
        eprintln!("[queued flush log err] {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::claude_code::{mapper::Mapper, parser};

    /// Drives the real capture through the counter that decides whether a
    /// prompt is written now or held. Two things have to hold across it: a call
    /// in flight is visible while it runs, and nothing is left in flight once
    /// the turns are over — a counter that drifted up would make every later
    /// prompt skip the queue and lose its cancel window for the rest of the
    /// session.
    #[test]
    fn tool_flight_tracks_calls_and_settles_at_zero() {
        let mut mapper = Mapper::default();
        let mut tracker = StatusTracker::default();
        let mut ever_in_flight = false;

        for line in include_str!("harness/claude_code/fixtures/complex.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };
            // Mirrors `read_stdout`: a subagent's call is not a boundary the CLI
            // injects a queued prompt at, so it must not count.
            if event.subagent.is_none() {
                tracker.note_tool_call(&event.payload);
            }
            ever_in_flight |= tracker.tool_in_flight();
        }

        assert!(ever_in_flight, "the fixture runs main-thread tool calls");
        assert!(
            !tracker.tool_in_flight(),
            "every call is closed by the end of the capture"
        );
    }

    /// An interrupt ends a turn with its calls still open, so `turn_completed`
    /// is what clears them. Without it the count only ever climbs.
    #[test]
    fn an_interrupted_turn_clears_its_open_calls() {
        let mut mapper = Mapper::default();
        let mut tracker = StatusTracker::default();

        for line in include_str!("harness/claude_code/fixtures/interrupted_tools.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };
            if event.subagent.is_none() {
                tracker.note_tool_call(&event.payload);
            }
        }

        assert!(!tracker.tool_in_flight());
    }

    /// The fixture's second turn spawns a background agent: its `result`
    /// arrives while a task is outstanding, the set drains later, and the CLI
    /// opens a promptless turn to report. The trajectory pins all of it — most
    /// importantly that the mid-flight `result` completes the turn, and that
    /// the set draining moves nothing.
    #[test]
    fn a_result_completes_the_turn_whatever_tasks_are_outstanding() {
        let mut mapper = Mapper::default();
        let mut tracker = StatusTracker::default();

        let mut transitions = vec![tracker.on_send().expect("a send starts work")];

        for line in include_str!("harness/claude_code/fixtures/multi_turn.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };
            if let Some(next) = tracker.on_event(&event.payload) {
                transitions.push(next);
            }
        }

        use SessionStatus::*;
        assert_eq!(
            transitions,
            vec![
                InProgress, // the send
                Completed,  // turn 1: result with nothing outstanding
                InProgress, // turn 2 opens
                Completed,  // turn 2's result, with a background task still open
                // the task set draining is *absent*: it is not a status input
                InProgress, // the promptless report-back turn
                Completed,  // its result
            ]
        );
    }

    /// The capture that settled the rule. Background Bash and Monitor both
    /// register as `local_bash`, and a `result` lands with both still open —
    /// so the turn completes with two tasks outstanding, and the reader is not
    /// left clicking Stop to end a turn that already ended.
    #[test]
    fn a_monitor_is_a_local_bash_task_and_holds_nothing() {
        let mut mapper = Mapper::default();
        let mut tracker = StatusTracker::default();
        tracker.on_send();

        let mut kinds = Vec::new();
        let mut outstanding_at_result = None;

        for line in include_str!("harness/claude_code/fixtures/background_bash_monitor.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };
            if let AgentEventPayload::BackgroundTasksChanged { tasks } = &event.payload {
                kinds.extend(tasks.iter().map(|t| t.task_type.clone()));
            }
            let next = tracker.on_event(&event.payload);
            if matches!(event.payload, AgentEventPayload::TurnCompleted { .. }) {
                outstanding_at_result = Some((next, tracker.background_task_ids().len()));
            }
        }

        assert!(!kinds.is_empty() && kinds.iter().all(|k| k == "local_bash"));
        assert_eq!(
            outstanding_at_result,
            Some((Some(SessionStatus::Completed), 2)),
            "the result completes the turn with both tasks still running"
        );
    }

    fn turn_completed() -> AgentEventPayload {
        AgentEventPayload::TurnCompleted {
            status: crate::events::TurnStatus::Success,
            stop_reason: None,
            auth_failed: false,
            final_text: None,
            usage: None,
            duration_ms: None,
            head: None,
        }
    }

    /// The reason the two readings exist separately. A background task keeps
    /// the child from being replaced after its turn ended, but must not hold
    /// the turn: a `local_bash` task — dev server, Monitor, poll loop — may
    /// never end, and the CLI's main thread is idle meanwhile (verified against
    /// v2.1.232, a prompt written in this state is answered in under two
    /// seconds).
    #[test]
    fn a_background_task_holds_the_child_but_not_the_turn() {
        let mut tracker = StatusTracker::default();
        tracker.on_send();

        tracker.on_event(&AgentEventPayload::BackgroundTasksChanged {
            tasks: vec![crate::events::BackgroundTask {
                task_id: "b0n57ez9b".to_string(),
                task_type: "local_bash".to_string(),
                description: "sleep 300".to_string(),
            }],
        });
        assert!(tracker.turn_in_flight(), "the turn that spawned it is open");
        assert_eq!(
            tracker.background_task_ids(),
            vec!["b0n57ez9b".to_string()],
            "Stop has to name it — the CLI's interrupt leaves it running"
        );

        assert_eq!(
            tracker.on_event(&turn_completed()),
            Some(SessionStatus::Completed),
            "the turn is over whatever the task is doing"
        );
        assert!(
            tracker.has_outstanding_work(),
            "but the child must not be replaced while it carries the task"
        );
        assert!(
            !tracker.turn_in_flight(),
            "and the main thread is idle, so a prompt goes straight out"
        );

        // Stopping it drains the set, which is what the CLI republishes. Not a
        // status change: the turn already ended.
        assert_eq!(
            tracker.on_event(&AgentEventPayload::BackgroundTasksChanged { tasks: vec![] }),
            None
        );
        assert!(!tracker.has_outstanding_work());
    }

    /// What [`SessionManager::fork`] reads. A dev server, a Monitor, a poll
    /// loop — a `local_bash` task never ends, so guarding fork on the wide
    /// reading took Fork away from that session for the rest of its life. The
    /// transcript it copies is not being appended to mid-turn here; the turn
    /// ended, and a task reporting back later opens a turn of its own.
    #[test]
    fn a_session_carrying_a_background_task_can_still_be_forked() {
        let mut tracker = StatusTracker::default();
        tracker.on_send();

        tracker.on_event(&AgentEventPayload::BackgroundTasksChanged {
            tasks: vec![crate::events::BackgroundTask {
                task_id: "b0n57ez9b".to_string(),
                task_type: "local_bash".to_string(),
                description: "pnpm dev".to_string(),
            }],
        });
        assert!(tracker.turn_in_flight(), "mid-turn, fork is refused");

        tracker.on_event(&turn_completed());
        assert!(
            tracker.has_outstanding_work(),
            "the child still carries the task, so it must not be replaced"
        );
        assert!(
            !tracker.turn_in_flight(),
            "but no model call is open, so there is no half a turn to inherit"
        );
    }

    /// The two guards on Fork are one question, and this is what keeps them so.
    /// The backend refuses on `turn_in_flight`; the sidebar disables the menu
    /// item on `status === "in_progress"`. Neither side can call the other, so
    /// the rule is stated twice — and a disabled item disagreeing with a
    /// refusal is exactly what made Fork read as broken rather than busy.
    #[test]
    fn the_fork_guard_is_the_status_the_sidebar_reads() {
        let mut mapper = Mapper::default();
        let mut tracker = StatusTracker::default();

        let check = |tracker: &StatusTracker| {
            assert_eq!(
                tracker.turn_in_flight(),
                tracker.status() == SessionStatus::InProgress,
                "the backend's fork guard and the word the sidebar reads have drifted"
            );
        };

        check(&tracker);
        tracker.on_send();
        check(&tracker);

        // The state this is all about: the turn over, tasks still running.
        let mut forkable_with_a_task_running = false;

        for line in include_str!("harness/claude_code/fixtures/background_bash_monitor.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };
            tracker.on_event(&event.payload);
            check(&tracker);
            forkable_with_a_task_running |=
                !tracker.turn_in_flight() && tracker.has_outstanding_work();
        }

        // Reading the finished session moves it off `Completed`, the one
        // transition that touches the status without touching the turn.
        tracker.mark_seen();
        check(&tracker);
        assert!(
            forkable_with_a_task_running,
            "the fixture runs its turn out with both tasks outstanding, which is the case that was refused"
        );
    }

    /// Only a finished-and-unread session clears on read; selecting a running
    /// one must not stop it reading as busy.
    #[test]
    fn mark_seen_clears_only_completed() {
        let mut tracker = StatusTracker::default();
        assert_eq!(tracker.mark_seen(), None, "idle has nothing to clear");

        tracker.on_send();
        assert_eq!(tracker.mark_seen(), None, "a running session stays busy");

        tracker.on_event(&turn_completed());
        assert_eq!(tracker.mark_seen(), Some(SessionStatus::Idle));
        assert_eq!(tracker.mark_seen(), None, "already read");
    }
}
