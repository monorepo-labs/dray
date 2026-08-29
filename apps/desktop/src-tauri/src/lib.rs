use crate::{
    attachments::Attachment,
    events::ApprovalPolicy,
    files::FileMatch,
    git::BranchList,
    harness::claude_code::commands::SlashCommand,
    models::{Effort, Model, ModelId},
    projects::Project,
    session::{Harness, QueuedMessage, SendOutcome, SessionManager},
    store::{SessionIndexByProject, SessionIndexItem, SessionSnapshot, SessionStatus},
};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

pub mod analytics;
pub mod apps;
pub mod attachments;
pub mod binpath;
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
pub mod updater;

#[tauri::command]
async fn send_msg(
    session_id: &str,
    prompt: &str,
    attachment_paths: Vec<String>,
    harness: &str,
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
    let harness = match harness {
        "claude_code" => Harness::ClaudeCode,
        "codex" => Harness::Codex,
        _ => return Err("invalid harness".into()),
    };

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

#[tauri::command]
fn list_models() -> Vec<Model> {
    models::claude_models()
}

/// The preferences Rust owns. Everything else the settings dialog draws is the
/// frontend's own local storage — see [`settings`].
///
/// Answers with the **effective** state, off `analytics::enabled`, not with
/// what is on disk. The two differ whenever `DRAY_NO_ANALYTICS` is set, and a
/// switch drawn from the file there would sit at `on` while nothing was being
/// sent.
#[tauri::command]
fn get_settings() -> settings::SettingsView {
    settings_view()
}

/// Persists the analytics opt-out and applies it to this run at once, so the
/// switch does not need a restart to mean anything.
///
/// Read-modify-write rather than a fresh struct: with a second field here one
/// day, building this from `enabled` alone would reset whatever the caller did
/// not name.
#[tauri::command]
async fn set_analytics_enabled(enabled: bool) -> Result<settings::SettingsView, String> {
    let mut next = settings::read().await;
    next.analytics_enabled = enabled;

    settings::write(&next).await.map_err(|e| e.to_string())?;
    analytics::set_enabled(enabled && !analytics::env_opt_out());

    Ok(settings_view())
}

fn settings_view() -> settings::SettingsView {
    settings::SettingsView {
        analytics_enabled: analytics::enabled(),
        analytics_locked: analytics::env_opt_out(),
    }
}

/// The slash commands available in a directory. Cached per directory in the
/// backend, so the composer may call this whenever the project changes.
#[tauri::command]
async fn list_slash_commands(cwd: &str) -> Result<Vec<SlashCommand>, String> {
    harness::claude_code::commands::list_commands(cwd)
        .await
        .map_err(|e| e.to_string())
}

/// Starts indexing a directory's files so the `@` picker opens on a warm index.
/// Fire-and-forget: the walk runs on its own thread and this returns at once.
#[tauri::command]
async fn warm_file_index(cwd: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || files::warm(&cwd))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Fuzzy file search for the `@` picker.
///
/// On `spawn_blocking` because the index is synchronous throughout — the search
/// holds a `parking_lot` read guard across the whole scoring pass, which is not
/// something that may be held across an await point.
#[tauri::command]
async fn search_files(cwd: String, query: String, limit: usize) -> Result<Vec<FileMatch>, String> {
    tokio::task::spawn_blocking(move || files::search(&cwd, &query, limit))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions_by_project() -> Result<Vec<SessionIndexByProject>, String> {
    store::list_sessions_by_project()
        .await
        .map_err(|e| e.to_string())
}

/// One side of the archived split. The sidebar's toggle is the only caller, and
/// it never wants both at once, so the flag it holds is the argument.
#[tauri::command]
async fn list_session_index_items(archived: bool) -> Result<Vec<SessionIndexItem>, String> {
    store::list_session_index_items_by_archived(archived)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_session_by_id(session_id: &str) -> Result<Option<SessionSnapshot>, String> {
    store::get_session_by_id(session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_projects() -> Result<Vec<Project>, String> {
    projects::read_projects().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_project(path: &str) -> Result<Vec<Project>, String> {
    projects::add_project(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_project(path: &str) -> Result<Vec<Project>, String> {
    projects::remove_project(path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_last_selected_project(path: &str) -> Result<(), String> {
    projects::set_last_selected_project(path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_branches(cwd: &str) -> Result<BranchList, String> {
    git::list_branches(cwd).await.map_err(|e| e.to_string())
}

/// Returns the branch list as it stands after the switch, so the picker
/// re-renders from one round trip rather than following up with its own.
#[tauri::command]
async fn checkout_branch(cwd: &str, branch: &str, stash: bool) -> Result<BranchList, String> {
    git::checkout_branch(cwd, branch, stash)
        .await
        .map_err(|e| e.to_string())?;

    git::list_branches(cwd).await.map_err(|e| e.to_string())
}

/// What changed in `cwd` since `baseline` — the tree id carried on a
/// `user_message`, so "since the last prompt" is the caller picking which one.
///
/// `head` is the frozen snapshot from the turn's own `turn_completed`, passed
/// for a finished turn so the diff describes the turn rather than everything
/// that has touched the checkout since. Absent — a live turn, or one that
/// never closed — the working tree is snapshotted to answer, and that
/// snapshot's id comes back on `head`. Pass it to [`file_change`] either way:
/// the agent keeps writing while the panel is open, and a list and a diff
/// taken from two different snapshots would disagree about what the file says.
#[tauri::command]
async fn changes_since(
    cwd: &str,
    baseline: &str,
    head: Option<&str>,
) -> Result<git::ChangeSet, String> {
    git::changes_since(cwd, baseline, head)
        .await
        .map_err(|e| e.to_string())
}

/// Both sides of one file, fetched only when the reader opens that row. The
/// file list is cheap and the contents are not, so a turn touching thirty files
/// costs thirty rows and nothing else until something is expanded.
#[tauri::command]
async fn file_change(
    cwd: &str,
    base: &str,
    head: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<git::FileVersions, String> {
    git::file_versions(cwd, base, head, path, old_path)
        .await
        .map_err(|e| e.to_string())
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

/// A page of the current branch's history, newest first. `skip` is what the
/// list's "load more" advances; the page size is the caller's, capped in `git`.
#[tauri::command]
async fn log_commits(cwd: &str, limit: u32, skip: u32) -> Result<Vec<git::Commit>, String> {
    git::log_commits(cwd, limit, skip)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_status(cwd: String) -> git::SyncStatus {
    git::sync_status(&cwd).await
}

#[tauri::command]
async fn work_status(cwd: String) -> git::WorkStatus {
    git::work_status(&cwd).await
}

/// Commits the checked files alone. `paths` are this session's own change list,
/// so a path the reader unchecked is one this never sees.
#[tauri::command]
async fn commit_files(
    cwd: &str,
    summary: &str,
    description: Option<&str>,
    paths: Vec<String>,
) -> Result<(), String> {
    git::commit_files(cwd, summary, description, &paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn push_branch(cwd: &str) -> Result<(), String> {
    git::push_branch(cwd).await.map_err(|e| e.to_string())
}

/// Returns the entry as written so the sidebar re-renders from the stored value
/// rather than its own guess at it. `None` for an unknown id.
#[tauri::command]
async fn set_session_flags(
    session_id: &str,
    archived: Option<bool>,
    pinned: Option<bool>,
) -> Result<Option<SessionIndexItem>, String> {
    store::set_session_flags(session_id, archived, pinned)
        .await
        .map_err(|e| e.to_string())
}

/// Cuts a spawned session loose from its parent, so the sidebar stops nesting
/// it. Returns the entry as written; `None` for an unknown id.
#[tauri::command]
async fn detach_session(session_id: &str) -> Result<Option<SessionIndexItem>, String> {
    store::detach_session(session_id)
        .await
        .map_err(|e| e.to_string())
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
) -> Result<(), String> {
    manager
        .interrupt(session_id)
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(analytics::plugin())
        .manage(SessionManager::default())
        .manage(updater::PendingUpdate::default())
        .manage(quit::PendingQuit::default())
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
            get_settings,
            set_analytics_enabled,
            list_slash_commands,
            warm_file_index,
            search_files,
            list_sessions_by_project,
            list_session_index_items,
            get_session_by_id,
            list_projects,
            add_project,
            remove_project,
            set_last_selected_project,
            list_branches,
            checkout_branch,
            changes_since,
            file_change,
            head_tree,
            log_commits,
            sync_status,
            work_status,
            commit_files,
            push_branch,
            set_session_flags,
            detach_session,
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
            apps::list_open_apps,
            apps::open_in_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
