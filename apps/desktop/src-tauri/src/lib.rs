use crate::{
    attachments::Attachment,
    events::ApprovalPolicy,
    harness::claude_code::commands::SlashCommand,
    models::{Effort, Model, ModelId},
    session::{Harness, QueuedMessage, SendOutcome, SessionManager},
    store::{SessionIndexItem, SessionSnapshot, SessionStatus},
};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

/// `anyhow::bail!` for a function returning [`Fail`]: `bail!` returns the bare
/// `anyhow::Error`, which does not coerce, where `?` would have converted it.
macro_rules! fail {
    ($($t:tt)*) => {
        return Err(anyhow::anyhow!($($t)*).into())
    };
}

pub mod analytics;
pub mod apps;
pub mod attachments;
pub mod binpath;
#[cfg(all(feature = "cef", target_os = "macos"))]
#[path = "cef/cef.rs"]
pub mod cef;
// Compiled without the feature too: it needs nothing of CEF's, and that is
// what keeps its types in `events.ts` and its tests in a bare `cargo test`.
#[cfg(target_os = "macos")]
pub mod chromium;
mod local_servers;
pub mod docs;
pub mod download;
#[path = "events/events.rs"]
pub mod events;
pub mod files;
pub mod git;
pub mod github;
#[path = "harness/harness.rs"]
pub mod harness;
#[path = "issues/issues.rs"]
pub mod issues;
#[path = "models/models.rs"]
pub mod models;
pub mod notifications;
pub mod orchestration;
pub mod projects;
pub mod quit;
pub mod session;
pub mod settings;
pub mod store;
pub mod title;
#[path = "transcription/transcription.rs"]
pub mod transcription;
pub mod updater;

/// A command's failure as the frontend sees it: the outermost message, as a
/// string. `anyhow::Error` cannot cross the bridge itself, and the alternative
/// was a wrapper per command mapping it to `String`. Converts both ways, so a
/// function returning this still reads as `anyhow` to every caller in the crate.
pub struct Fail(anyhow::Error);

impl From<anyhow::Error> for Fail {
    fn from(e: anyhow::Error) -> Self {
        Self(e)
    }
}

impl From<Fail> for anyhow::Error {
    fn from(f: Fail) -> Self {
        f.0
    }
}

impl std::fmt::Debug for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl serde::Serialize for Fail {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

#[tauri::command]
async fn send_msg(
    session_id: &str,
    prompt: &str,
    attachment_paths: Vec<String>,
    // Deserialized straight into the enum rather than matched off a string: the
    // wire spelling is `Harness`'s own `snake_case`, so a third arm here was a
    // third list to keep in step and its failure was one word — "invalid
    // harness" — for a name the enum could have named.
    harness: Harness,
    model: ModelId,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
    cwd: &str,
    branch: Option<&str>,
    use_worktree: bool,
    worktree_name: Option<&str>,
    is_new_session: bool,
    app: AppHandle,
    manager: State<'_, SessionManager>,
) -> Result<SendOutcome, String> {
    // The tolerant `Deserialize` reads a name this build doesn't know as
    // `Other`, which is right off the index and wrong here: this is the
    // composer naming a harness to *start*, so an unknown one is a caller
    // error rather than a session some other build wrote.
    if !harness.names_a_cli() {
        return Err("invalid harness".to_string());
    }

    manager
        .send_msg(
            session_id,
            prompt,
            &attachment_paths,
            // Nothing named, ever: the app tags its issues in the prompt
            // text, the composer's `#` picker being the only route, so there is
            // one rule on this side of the bridge. `--issue` on the CLI is the
            // other caller, and it names them because a flag is not prose.
            &[],
            harness,
            model,
            effort,
            permission_mode,
            cwd,
            branch,
            use_worktree,
            worktree_name,
            // The composer offers no base ref: a worktree session created there
            // is one the reader is starting fresh, and the picker already hides
            // the branch list in worktree mode because `-w` would not honour it.
            None,
            is_new_session,
            // The composer never has a parent, and its prompts are the user's
            // own; only the orchestration socket sets either.
            None,
            None,
            &app,
        )
        .await
        .map_err(|e| e.to_string())
}

/// Describes dropped or picked paths for the composer's tray. Returns only the
/// ones that can be attached — a folder dragged in alongside two files leaves
/// the two files.
#[tauri::command]
async fn read_attachments(paths: Vec<String>) -> Vec<Attachment> {
    attachments::read_attachments(paths).await
}

/// Which agents can actually be run on this machine, and what to say about
/// one that can't.
///
/// Read when the composer mounts, so an agent with no CLI behind it is marked
/// before anybody writes a prompt for it. The resolution is cached in
/// `binpath`, so this is a filesystem check on the first call and free after —
/// but the first call can spawn a login shell, hence `async` and hence a
/// command rather than something the picker computes per render.
///
/// The cure travels with the answer. A row saying "not installed" and nothing
/// else is the errno reworded; naming the command and the page is the whole
/// point of asking.
#[tauri::command]
async fn agent_availability() -> Vec<AgentAvailability> {
    let mut out = Vec::new();
    for harness in harness::Harness::ALL {
        let (reason, curable) = unavailable_reason(harness).await;

        out.push(AgentAvailability {
            harness,
            available: binpath::agent_available(harness).await,
            label: harness.label().to_string(),
            reason,
            install_command: curable.then(|| harness.install_command().to_string()),
            docs_url: curable.then(|| harness.docs_url().to_string()),
            login_command: harness.login_command().to_string(),
            login_hint: harness.login_hint().map(str::to_string),
        });
    }
    out
}

/// What to say about an agent that cannot run, and whether the install command
/// is what fixes it.
///
/// Three answers wearing one word before this, and each wants a different cure.
/// A CLI that is not on the machine is fixed by installing it. One that is
/// present and too old is fixed by *re-running* the same installer, so the
/// buttons still help — but a sentence saying "not installed" tells the reader
/// to fix something they already have. And a harness this build cannot drive
/// yet is fixed by neither, so it draws the sentence alone: sending someone to
/// an installer for a CLI that is sitting right there is the worst of the
/// three.
async fn unavailable_reason(harness: harness::Harness) -> (String, bool) {
    let label = harness.label();

    // Asked before drivability, and the order is the whole of it. A CLI that is
    // not on the machine is missing whatever this build could do with it, and
    // the install command is the answer — the same one Claude and Codex give.
    // Checking drivability first told a reader with no pi at all that Dray
    // cannot run pi, which is true, useless, and hides the one thing they could
    // have done about it.
    if !binpath::agent_installed(harness).await {
        return (
            format!("{label} isn't installed, so this session can't start."),
            true,
        );
    }

    (format!("Dray can't run {label} sessions yet."), false)
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
struct AgentAvailability {
    harness: harness::Harness,
    available: bool,
    label: String,
    /// The sentence the composer's notice draws. Built here for the reason the
    /// cure travels with the answer: a row saying "unavailable" and nothing
    /// else is the errno reworded.
    reason: String,
    /// What fixes it, where installing is what fixes it. `None` where the CLI
    /// is not the problem, so the notice draws no buttons rather than buttons
    /// that change nothing.
    install_command: Option<String>,
    docs_url: Option<String>,
    /// Read by a different notice from the two fields above it: those cure a
    /// CLI that is missing, this cures one that is logged out. Both are facts
    /// about the harness rather than about the machine, so they ride one read.
    login_command: String,
    /// What is left to do once `login_command` has run, for a harness whose
    /// command is not the whole cure. `None` for the two whose command is.
    login_hint: Option<String>,
}

/// The models a harness can run here.
///
/// Async because one harness's answer is not a table: pi is multi-provider, so
/// its list depends on which providers the reader has logged into and only pi
/// can say. That read is cached and cheap after the first, and it answers empty
/// rather than erroring — a reader with no provider configured is in an
/// ordinary state, and the picker draws its own empty row for it.
#[tauri::command]
async fn list_models(harness: Option<harness::Harness>) -> Vec<Model> {
    // Defaulted rather than required so a caller that predates the second
    // harness still gets the list it always got.
    match harness.unwrap_or(harness::Harness::ClaudeCode) {
        harness::Harness::Pi => harness::pi::models::list().await,
        other => models::models_for(other),
    }
}

/// Drops pi's cached model list, so the next read asks pi again.
///
/// For the refresh a reader asks for by hand: they have just logged a provider
/// in, and waiting out the freshness window would read as the list being wrong.
#[tauri::command]
async fn refresh_models() {
    harness::pi::models::forget();
}

/// The preferences Rust owns. Everything else the settings dialog draws is the
/// frontend's own local storage — see [`settings`].
///
/// Answers with the **effective** state, off `analytics::enabled`, not with
/// what is on disk. The two differ whenever `DRAY_NO_ANALYTICS` is set, and a
/// switch drawn from the file there would sit at `on` while nothing was being
/// sent.
#[tauri::command]
async fn get_settings() -> settings::SettingsView {
    settings_view().await
}

/// Persists the analytics opt-out. Every send reads the file, so the switch
/// needs no restart to mean anything.
///
/// Read-modify-write rather than a fresh struct: with a second field here one
/// day, building this from `enabled` alone would reset whatever the caller did
/// not name.
#[tauri::command]
async fn set_analytics_enabled(enabled: bool) -> Result<settings::SettingsView, Fail> {
    let mut next = settings::read().await;
    next.analytics_enabled = enabled;
    settings::write(&next).await?;

    Ok(settings_view().await)
}

async fn settings_view() -> settings::SettingsView {
    settings::SettingsView {
        analytics_enabled: analytics::enabled().await,
        analytics_locked: analytics::env_opt_out(),
    }
}

/// The slash commands available in a directory, for the harness that will run
/// there. Cached per directory in the backend, so the composer may call this
/// whenever the project or the harness changes.
///
/// The harness is what makes this answer anything true. Every picker used to be
/// filled from Claude Code's `initialize` whatever the session ran on, so a pi
/// session offered `/compact`, `/dataviz` and 145 others pi has never heard of
/// — and typing one sent it as a prompt, because pi expands no command it does
/// not know.
///
/// Codex answers none, and that is its own fact rather than a gap here: nothing
/// in `codex app-server` publishes a command list, so an empty picker is the
/// honest one.
#[tauri::command]
async fn list_slash_commands(cwd: &str, harness: Harness) -> Result<Vec<SlashCommand>, String> {
    Ok(match harness {
        Harness::ClaudeCode => harness::claude_code::commands::list_commands(cwd)
            .await
            .map_err(|e| e.to_string())?,
        Harness::Pi => harness::pi::commands::list_commands(cwd).await,
        Harness::Codex => harness::codex::commands::list_commands(cwd).await,
        Harness::Other(_) => Vec::new(),
    })
}

/// The committed side of the repo view's uncommitted list. Paired with a `None`
/// head on [`changes_since`], which snapshots the working tree to answer — so
/// the two together are "what have I changed but not committed".
///
/// Takes an owned `cwd` where every command around it borrows: an async command
/// with a borrowed argument has to return `Result`, and neither this nor
/// [`sync_status`] can fail — a `Result` here would be a lie the caller then has
/// to handle.
#[tauri::command]
async fn head_tree(cwd: String) -> Option<String> {
    git::head_tree(&cwd).await
}

#[tauri::command]
async fn sync_status(cwd: String) -> git::SyncStatus {
    git::sync_status(&cwd).await
}

#[tauri::command]
async fn work_status(cwd: String) -> git::WorkStatus {
    git::work_status(&cwd).await
}

/// What removing this session's worktree would cost, for the dialog that asks.
///
/// Answers for a session with no worktree too — an all-zero, `exists: false`
/// reading — so the caller has one shape to render rather than a null to
/// branch on.
#[tauri::command]
async fn worktree_disposition(session_id: &str) -> Result<git::WorktreeDisposition, String> {
    let item = store::get_session_index_item(session_id)
        .await
        .map_err(|e| e.to_string())?;

    let Some(item) = item.filter(|i| i.worktree_name.is_some()) else {
        return Ok(git::WorktreeDisposition::default());
    };

    let path = store::worktree_path(&item.project_path, item.worktree_name.as_deref().unwrap());

    Ok(git::worktree_disposition(&path, &item.project_path).await)
}

/// Deletes the session's worktree and its branch, and moves the session to its
/// project root. The session, its transcript and its log all survive.
///
/// Returns the relocated index entry so the frontend replaces its row from
/// what the disk holds rather than from what it hoped the write would do —
/// `set_session_flags` makes the same bargain.
#[tauri::command]
async fn remove_session_worktree(
    session_id: &str,
    manager: State<'_, SessionManager>,
) -> Result<SessionIndexItem, String> {
    manager
        .remove_worktree(session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Removes a session for good: its child, its index entry, and its log. `false`
/// means the index never held the id, which the sidebar treats the same as a
/// success — either way the row it was asked to remove is gone.
#[tauri::command]
async fn delete_session(
    session_id: &str,
    manager: State<'_, SessionManager>,
) -> Result<bool, String> {
    manager.delete(session_id).await.map_err(|e| e.to_string())
}

/// Copies a session onto `fork_id`, to be carried on separately from the one it
/// came from. `worktree` gives the fork a tree of its own rather than leaving it
/// in the parent's directory.
///
/// The id comes from the caller for the same reason a new session's does: this
/// app chooses session ids and the CLI adopts them, and `--fork-session` honours
/// `--session-id` like any other spawn.
///
/// Returns what the fork replays — the parent's log, already copied — so the
/// frontend can open it without a second read.
#[tauri::command]
async fn fork_session(
    session_id: &str,
    fork_id: &str,
    worktree: bool,
    manager: State<'_, SessionManager>,
) -> Result<SessionSnapshot, String> {
    manager
        .fork(session_id, fork_id, worktree)
        .await
        .map_err(|e| e.to_string())
}

/// Stops the in-flight turn without killing the session — the CLI aborts its
/// tools and streaming, ends the turn, and stays alive for the next prompt.
#[tauri::command]
async fn interrupt_session(
    session_id: &str,
    manager: State<'_, SessionManager>,
    app: AppHandle,
) -> Result<(), String> {
    manager
        .interrupt(session_id, &app)
        .await
        .map_err(|e| e.to_string())
}

/// Stops one background task without touching the rest of the session.
///
/// Not reachable through `interrupt_session`: an interrupt with no turn in
/// flight acks and leaves running tasks alone, which is exactly the state a
/// background task holds a session in. Idempotent — the CLI answers success for
/// a task it no longer holds.
#[tauri::command]
async fn stop_task(
    session_id: &str,
    task_id: &str,
    manager: State<'_, SessionManager>,
) -> Result<(), String> {
    manager
        .stop_task(session_id, task_id)
        .await
        .map_err(|e| e.to_string())
}

/// Takes back the newest prompt still held for a running turn, returning its
/// text so the composer can restore it. `None` once the flush has written it —
/// past that point the CLI owns the prompt and there is no way to retract it.
#[tauri::command]
async fn cancel_queued(
    session_id: &str,
    manager: State<'_, SessionManager>,
) -> Result<Option<QueuedMessage>, String> {
    Ok(manager.cancel_queued(session_id).await)
}

/// Answers a permission request the agent is blocked on. `option_id` names one
/// of the options carried on the `permission_requested` event — the standing
/// rule it may apply never leaves the backend, so the frontend cannot widen a
/// grant beyond what the CLI proposed.
#[tauri::command]
async fn respond_permission(
    session_id: &str,
    request_id: &str,
    option_id: &str,
    manager: State<'_, SessionManager>,
    app: AppHandle,
) -> Result<(), String> {
    manager
        .respond_permission(session_id, request_id, option_id, &app)
        .await
        .map_err(|e| e.to_string())
}

/// Answers the questions on a `questions_asked` event. `answers` is keyed by
/// each question's verbatim text — the CLI matches on the string — and a
/// question left out of it is one the user skipped, which is a real answer
/// rather than a refusal.
#[tauri::command]
async fn answer_questions(
    session_id: &str,
    request_id: &str,
    answers: HashMap<String, String>,
    manager: State<'_, SessionManager>,
    app: AppHandle,
) -> Result<(), String> {
    manager
        .answer_questions(session_id, request_id, answers, &app)
        .await
        .map_err(|e| e.to_string())
}

/// Clears a finished session's unread mark. The frontend calls this when the
/// user views the session; a `completed` badge is "finished and unread", so
/// reading is what retires it. Returns the status as written, `None` when
/// nothing changed — the session wasn't `completed`, or the id is unknown.
#[tauri::command]
async fn mark_session_idle(
    session_id: &str,
    manager: State<'_, SessionManager>,
) -> Result<Option<SessionStatus>, String> {
    manager
        .mark_idle(session_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(analytics::plugin())
        .manage(SessionManager::default())
        .manage(updater::PendingUpdate::default())
        .manage(quit::PendingQuit::default())
        .manage(transcription::TranscriptionState::default())
        .menu(quit::menu)
        .on_menu_event(|app, event| {
            if event.id() == quit::QUIT_ID {
                quit::request(app);
            } else if event.id() == updater::CHECK_UPDATE_ID {
                if let Err(e) = app.emit(updater::CHECK_UPDATE_REQUESTED, ()) {
                    eprintln!("[check update emit err] {e}");
                }
            }
        })
        .on_window_event(|window, event| {
            // The dialog answers with `confirm_quit`, which exits outright — so
            // this arm never has to let a close through.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                quit::request(window.app_handle());
            }
        })
        .setup(|app| {
            // Chromium first: it patches NSApp and starts its pump, and every
            // window already exists here for it to parent a view into.
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::init(app.handle());
            // A persisted `in_progress` can't be true anymore — no child
            // survived the restart. Spawned, not awaited: the reset needs no
            // window, and the frontend's first fetch lands well after it.
            tauri::async_runtime::spawn(async {
                if let Err(e) = store::reset_in_progress_sessions().await {
                    eprintln!("[status reset err] {e}");
                }
                // Sessions whose worktree was deleted before the index had a
                // field for it, which is what their PR tab reads to know its
                // branch outranks the shared checkout's HEAD.
                if let Err(e) = store::backfill_removed_worktrees().await {
                    eprintln!("[worktree backfill err] {e}");
                }
                // Dictations kept past a failure. Pruning on write alone left
                // the last one on disk forever, since nothing else sweeps them
                // and a reader who gives up after one failure writes no more.
                transcription::recordings::prune().await;
            });

            // Orchestration is a side channel: a socket that won't bind must
            // cost the feature, never the app. Logged and dropped for that
            // reason — there is nothing the reader could act on either.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = orchestration::serve(handle).await {
                    eprintln!("[orchestration err] {e:#}");
                }
            });

            // Spawned rather than awaited, but the two halves inside it are
            // ordered: the launch is reported only once the persisted opt-out
            // has been read, or an opted-out install would still send the one
            // event it opted out of.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                analytics::start(&handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_msg,
            read_attachments,
            list_models,
            refresh_models,
            agent_availability,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_open,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_tabs,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_activate,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_close,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_nav,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_layout,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_zoom,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_devtools,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            cef::browser_pick,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            chromium::chromium_status,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            chromium::chromium_download,
            #[cfg(all(feature = "cef", target_os = "macos"))]
            chromium::chromium_remove,
            local_servers::list_local_servers,
            get_settings,
            set_analytics_enabled,
            list_slash_commands,
            files::warm_file_index,
            files::search_files,
            store::list_sessions_by_project,
            store::list_session_index_items,
            store::get_session_by_id,
            projects::list_projects,
            projects::add_project,
            projects::remove_project,
            projects::set_last_selected_project,
            projects::set_project_space,
            projects::retag_space,
            git::list_branches,
            git::checkout_branch,
            git::changes_since,
            git::file_change,
            head_tree,
            git::log_commits,
            git::log_branch_commits,
            sync_status,
            work_status,
            git::commit_files,
            git::push_branch,
            store::set_session_flags,
            store::detach_session,
            delete_session,
            fork_session,
            worktree_disposition,
            remove_session_worktree,
            mark_session_idle,
            interrupt_session,
            stop_task,
            cancel_queued,
            respond_permission,
            answer_questions,
            notifications::notify_session,
            updater::check_update,
            updater::install_update,
            issues::get_integrations,
            issues::connect_linear,
            issues::disconnect_linear,
            issues::list_issues,
            issues::get_issue,
            issues::fetch_issue_asset,
            issues::list_issue_filters,
            issues::unlink_issue,
            github::prs_for_branch,
            github::pr_marks,
            github::merge_pr,
            github::delete_branch,
            github::reopen_pr,
            github::mark_pr_ready,
            quit::confirm_quit,
            quit::dismiss_quit,
            docs::read_doc,
            docs::save_doc,
            docs::watch_docs,
            apps::list_open_apps,
            apps::open_in_app,
            apps::open_login_terminal,
            transcription::transcription_status,
            transcription::download_transcription_model,
            transcription::cancel_transcription_download,
            transcription::delete_transcription_model,
            transcription::select_transcription_model,
            transcription::select_transcription_device,
            transcription::set_transcription_mute,
            transcription::start_transcription,
            transcription::transcription_level,
            transcription::stop_transcription,
            transcription::retry_transcription,
            transcription::cancel_transcription,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // The record of what the output was before a dictation muted it
            // lives in this process and nowhere else, so quitting mid-recording
            // is the one ordinary way to leave a machine silent with nothing
            // left to undo it. Synchronous and blocking, since the runtime is
            // already going down and there is nothing to spawn onto. A hard
            // kill still gets past this — see `Known issues`.
            if matches!(event, tauri::RunEvent::Exit) {
                transcription::audio::restore_other_audio();
                // Tao ends the process with `process::exit`, which runs the C
                // atexit chain — and ggml-metal's global device registry frees
                // its Metal residency sets there, after the Metal runtime is
                // already down, and `ggml_abort`s. So every quit filed a crash
                // report. `process::exit` skips every Rust destructor anyway,
                // so skipping the C half too costs nothing we still rely on.
                //
                // It skips the rest of Tauri's own exit arm too, which is where
                // `AppHandle::restart` relaunches from — so `restart` here is a
                // quit that never comes back. That was DRA-160; the updater
                // launches the new bundle itself before asking to exit.
                unsafe { libc::_exit(0) }
            }
        });
}
