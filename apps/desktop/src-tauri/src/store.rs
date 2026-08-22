use std::{path::PathBuf, vec};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    events::{now_rfc3339, AgentEvent, ApprovalPolicy},
    models::{Effort, ModelId},
    session::Harness,
};

/// Driven by [`StatusTracker`](crate::session::StatusTracker). `Completed`
/// means finished *and unread* — the transition back to `Idle` is the user
/// looking at the session, not anything the agent does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    InProgress,
    Completed,
}

impl Default for SessionStatus {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexItem {
    pub session_id: String,
    pub harness: Harness,
    /// Where the agent actually runs. Equals `project_path` for a normal
    /// session; points inside `.claude/worktrees/<name>` for a worktree one.
    pub cwd: String,
    /// Repo root — the grouping key, so worktree sessions still list under
    /// their project rather than each becoming a project of their own.
    pub project_path: String,
    pub branch: Option<String>,
    /// `Some` marks this a worktree session; Claude Code names the branch
    /// `worktree-<name>`.
    pub worktree_name: Option<String>,
    pub title: String,
    /// Remembered per session so switching between sessions restores the model
    /// the user last picked instead of resetting to a default.
    #[serde(default)]
    pub model: ModelId,
    /// `None` for models that take no effort flag.
    #[serde(default)]
    pub effort: Option<Effort>,
    /// Defaulted so entries written before this field read as the CLI's own
    /// default rather than failing the whole index.
    #[serde(default)]
    pub permission_mode: ApprovalPolicy,
    /// Defaulted so index entries written before this field parse as `Idle`.
    #[serde(default)]
    pub status: SessionStatus,
    pub created: String,
    pub modified: String,
    pub archived: bool,
    pub pinned: bool,
}

/// What crosses the IPC boundary for one session: its index entry plus the
/// replayed event log. Distinct from [`crate::session::Session`], which owns a
/// child process and cannot be serialized.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    #[serde(flatten)]
    #[ts(flatten)]
    pub index_item: SessionIndexItem,
    pub events: Vec<AgentEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexByProject {
    pub path: String,
    pub indexes: Vec<SessionIndexItem>,
}

static INDEX_LOCK: Mutex<()> = Mutex::const_new(());

/// `~/.dray`, creating it if this is the first run. If `~/.automedon` exists
/// from before the app's rename and `~/.dray` doesn't yet, the old directory
/// is moved into place so a rename never orphans a user's session history.
pub async fn get_home_app_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not resolve home directory")?;
    let path = home.join(".dray");

    if !fs::try_exists(&path).await.unwrap_or(false) {
        let legacy = home.join(".automedon");
        if fs::try_exists(&legacy).await.unwrap_or(false) {
            fs::rename(&legacy, &path).await?;
        }
    }

    fs::create_dir_all(&path).await?;
    Ok(path)
}

/// `~/.dray/sessions`, creating it if needed.
pub async fn get_sessions_dir() -> Result<PathBuf> {
    let path = get_home_app_dir().await?.join("sessions");

    fs::create_dir_all(&path).await?;

    Ok(path)
}

/// Reads and parses `index.json`. Missing or empty file reads as no sessions,
/// not an error.
pub async fn list_session_index_items() -> Result<Vec<SessionIndexItem>> {
    let path = get_sessions_dir().await?.join("index.json");

    let contents = match fs::read_to_string(path).await {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).context("could not open session file"),
    };

    if contents.is_empty() {
        return Ok(Vec::new());
    }

    let items = serde_json::from_str::<Vec<SessionIndexItem>>(&contents)?;

    Ok(items)
}

/// The index filtered to one side of `archived` — the sidebar shows exactly one
/// of the two at a time, so a parameter keeps it to one function rather than a
/// pair that would drift. Callers that need every entry (`set_*`, `get_*`) still
/// use [`list_session_index_items`] directly.
pub async fn list_session_index_items_by_archived(
    archived: bool,
) -> Result<Vec<SessionIndexItem>> {
    Ok(filter_by_archived(
        list_session_index_items().await?,
        archived,
    ))
}

/// Split out from the async read so it can be tested without an `index.json`.
fn filter_by_archived(items: Vec<SessionIndexItem>, archived: bool) -> Vec<SessionIndexItem> {
    items.into_iter().filter(|i| i.archived == archived).collect()
}

/// All sessions, bucketed by `project_path` — the sidebar's project grouping.
pub async fn list_sessions_by_project() -> Result<Vec<SessionIndexByProject>> {
    let sessions = list_session_index_items().await?;
    let mut sessions_grouped: Vec<SessionIndexByProject> = Vec::new();

    for session in sessions {
        if let Some(project) = sessions_grouped
            .iter_mut()
            .find(|p| p.path == session.project_path)
        {
            project.indexes.push(session);
        } else {
            sessions_grouped.push(SessionIndexByProject {
                path: session.project_path.clone(),
                indexes: vec![session],
            });
        }
    }

    Ok(sessions_grouped)
}

impl SessionIndexItem {
    /// Everything the index needs is known when the first prompt is sent, so a
    /// session appears in the list even if its process fails to start.
    pub fn new(
        session_id: &str,
        harness: Harness,
        cwd: &str,
        project_path: &str,
        worktree_name: Option<&str>,
        branch: Option<&str>,
        first_prompt: &str,
        model: ModelId,
        effort: Option<Effort>,
        permission_mode: ApprovalPolicy,
    ) -> Self {
        let now = now_rfc3339();

        Self {
            session_id: session_id.to_string(),
            harness,
            cwd: cwd.to_string(),
            project_path: project_path.to_string(),
            // A worktree's branch is the CLI's to name, so it's derived rather
            // than read; everything else records the branch actually checked out.
            branch: match worktree_name {
                Some(name) => Some(format!("worktree-{name}")),
                None => branch.map(str::to_string),
            },
            worktree_name: worktree_name.map(str::to_string),
            title: title_from_prompt(first_prompt),
            model,
            effort,
            permission_mode,
            status: SessionStatus::default(),
            created: now.clone(),
            modified: now,
            archived: false,
            pinned: false,
        }
    }
}

/// `claude -w <name>` places the tree here and names its branch
/// `worktree-<name>` — both confirmed against the worktree fixtures.
pub fn worktree_path(project_path: &str, name: &str) -> String {
    PathBuf::from(project_path)
        .join(".claude")
        .join("worktrees")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

const ADJECTIVES: [&str; 16] = [
    "amber", "brisk", "calm", "dusky", "eager", "fleet", "gentle", "hazy", "ivory", "jolly",
    "keen", "lucid", "mellow", "noble", "opal", "quiet",
];

const COLORS: [&str; 16] = [
    "azure", "bronze", "crimson", "denim", "emerald", "fuchsia", "gold", "hazel", "indigo", "jade",
    "khaki", "lilac", "maroon", "navy", "olive", "plum",
];

const NOUNS: [&str; 16] = [
    "atlas", "beacon", "cedar", "delta", "ember", "fjord", "grove", "harbor", "isle", "jetty",
    "kite", "lantern", "meadow", "nimbus", "orchard", "pebble",
];

/// Three-word name from v7 UUID entropy — avoids a `rand` dependency, and
/// collisions only matter against worktrees that already exist on disk.
fn random_worktree_name() -> String {
    let bytes = Uuid::now_v7().into_bytes();
    let pick = |i: usize, list: &[&'static str; 16]| list[(bytes[i] as usize) % list.len()];

    format!(
        "{}-{}-{}",
        pick(8, &ADJECTIVES),
        pick(10, &COLORS),
        pick(12, &NOUNS)
    )
}

/// Worktrees outlive the sessions that made them, so a name already on disk
/// would silently attach this session to someone else's tree.
pub fn resolve_worktree_name(project_path: &str, requested: Option<&str>) -> Result<String> {
    if let Some(name) = requested {
        let path = worktree_path(project_path, name);
        if PathBuf::from(&path).exists() {
            bail!("a worktree named '{name}' already exists at {path}");
        }
        return Ok(name.to_string());
    }

    for _ in 0..16 {
        let name = random_worktree_name();
        if !PathBuf::from(worktree_path(project_path, &name)).exists() {
            return Ok(name);
        }
    }

    bail!("could not find an unused worktree name after 16 attempts")
}

/// Char-based so a multi-byte prompt can't panic on a byte-index slice.
fn title_from_prompt(prompt: &str) -> String {
    const MAX: usize = 60;
    let title = prompt.trim().replace('\n', " ");

    if title.chars().count() <= MAX {
        return title;
    }

    let truncated: String = title.chars().take(MAX).collect();
    format!("{}…", truncated.trim_end())
}

/// Adds one entry to the index and rewrites it to disk.
pub async fn append_session_index_item(session: SessionIndexItem) -> Result<()> {
    let _guard = INDEX_LOCK.lock().await;

    let mut sessions = list_session_index_items().await?;
    sessions.push(session);

    write_session_index(&sessions).await
}

/// Bumps `modified`, and the settable per-session fields when they changed.
/// Callers hold the live session's values, so an unchanged send skips the
/// rewrite entirely — the whole index is serialized on every write.
pub async fn touch_session_index_item(
    session_id: &str,
    model: ModelId,
    effort: Option<Effort>,
    permission_mode: ApprovalPolicy,
) -> Result<()> {
    let _guard = INDEX_LOCK.lock().await;

    let mut sessions = list_session_index_items().await?;
    let Some(item) = sessions.iter_mut().find(|i| i.session_id == session_id) else {
        return Ok(());
    };

    item.modified = now_rfc3339();
    item.model = model;
    item.effort = effort;
    item.permission_mode = permission_mode;

    write_session_index(&sessions).await
}

/// Sets `archived` and/or `pinned` on one entry. `None` leaves that flag alone,
/// so the two sidebar controls share one command without either clobbering the
/// other's field. Returns the entry as written, or `None` if the id is unknown.
pub async fn set_session_flags(
    session_id: &str,
    archived: Option<bool>,
    pinned: Option<bool>,
) -> Result<Option<SessionIndexItem>> {
    let _guard = INDEX_LOCK.lock().await;

    let mut sessions = list_session_index_items().await?;
    let Some(item) = sessions.iter_mut().find(|i| i.session_id == session_id) else {
        return Ok(None);
    };

    if let Some(v) = archived {
        item.archived = v;
    }
    if let Some(v) = pinned {
        item.pinned = v;
    }

    // `modified` is deliberately left alone: it orders the list, and flipping a
    // flag would jump the session to the top of it.
    let updated = item.clone();

    write_session_index(&sessions).await?;

    Ok(Some(updated))
}

/// Drops one session from the index and deletes its `.jsonl` log. Returns
/// whether the index held it — a `false` still means the log was removed if one
/// was there, so an orphaned log can't outlive the entry that named it.
///
/// Index first: a log with no entry is invisible, an entry with no log reads
/// back as a session with no events. Only one of those is a lie the UI shows.
pub async fn delete_session(session_id: &str) -> Result<bool> {
    let existed = {
        let _guard = INDEX_LOCK.lock().await;

        let mut sessions = list_session_index_items().await?;
        let before = sessions.len();
        sessions.retain(|i| i.session_id != session_id);

        if sessions.len() == before {
            false
        } else {
            write_session_index(&sessions).await?;
            true
        }
    };

    let path = get_session_path(session_id).await?;
    match fs::remove_file(&path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).context("failed to delete session log"),
    }

    Ok(existed)
}

/// Sets one entry's status. Returns the entry as written, or `None` if the id
/// is unknown.
///
/// Only completion bumps `modified`: the field means "last activity", and the
/// agent finishing is activity. `InProgress` is already covered by the send's
/// touch, and clearing the unread mark is a read, not activity.
pub async fn set_session_status(
    session_id: &str,
    status: SessionStatus,
) -> Result<Option<SessionIndexItem>> {
    let _guard = INDEX_LOCK.lock().await;

    let mut sessions = list_session_index_items().await?;
    let Some(item) = sessions.iter_mut().find(|i| i.session_id == session_id) else {
        return Ok(None);
    };

    item.status = status;
    if status == SessionStatus::Completed {
        item.modified = now_rfc3339();
    }
    let updated = item.clone();

    write_session_index(&sessions).await?;

    Ok(Some(updated))
}

/// A persisted `in_progress` is a lie after a restart — no child survives the
/// process — so every one resets to `idle` at startup. `completed` survives:
/// unread is still unread.
pub async fn reset_in_progress_sessions() -> Result<()> {
    let _guard = INDEX_LOCK.lock().await;

    let mut sessions = list_session_index_items().await?;
    let mut changed = false;
    for item in sessions.iter_mut() {
        if item.status == SessionStatus::InProgress {
            item.status = SessionStatus::Idle;
            changed = true;
        }
    }

    if changed {
        write_session_index(&sessions).await?;
    }

    Ok(())
}

/// Replaces one entry's title. Returns the entry as written, or `None` if the
/// id is unknown — a session deleted while its title was being generated.
///
/// `modified` is left alone, like [`set_session_flags`]: it orders the sidebar,
/// and a title landing seconds after the send would jump the session to the top
/// of it for a reason the user never took.
pub async fn set_session_title(
    session_id: &str,
    title: &str,
) -> Result<Option<SessionIndexItem>> {
    let _guard = INDEX_LOCK.lock().await;

    let mut sessions = list_session_index_items().await?;
    let Some(item) = sessions.iter_mut().find(|i| i.session_id == session_id) else {
        return Ok(None);
    };

    item.title = title.to_string();
    let updated = item.clone();

    write_session_index(&sessions).await?;

    Ok(Some(updated))
}

/// Caller must hold `INDEX_LOCK`: this rewrites the whole file, so a concurrent
/// writer would drop the other's entry.
async fn write_session_index(sessions: &[SessionIndexItem]) -> Result<()> {
    let path = get_sessions_dir().await?.join("index.json");
    let contents = serde_json::to_string(sessions)?;
    let tmp = path.with_extension("json.tmp");

    fs::write(&tmp, contents)
        .await
        .context("failed to write session index")?;

    fs::rename(&tmp, &path)
        .await
        .context("failed to rename session index")?;

    Ok(())
}

/// Looks up one session's index entry by id.
pub async fn get_session_index_item(session_id: &str) -> Result<Option<SessionIndexItem>> {
    let items = list_session_index_items().await?;

    Ok(items.into_iter().find(|i| i.session_id == session_id))
}

/// `None` means the id isn't in the index. An indexed session with no log yet
/// is normal — it was written before its process spawned — and yields empty
/// `events` rather than `None`.
pub async fn get_session_by_id(session_id: &str) -> Result<Option<SessionSnapshot>> {
    let Some(index_item) = get_session_index_item(session_id).await? else {
        return Ok(None);
    };

    let events = list_session_events(session_id).await?;

    Ok(Some(SessionSnapshot { index_item, events }))
}

/// Replays a session's `.jsonl` log into its full event list. Missing file
/// reads as no events, not an error.
pub async fn list_session_events(session_id: &str) -> Result<Vec<AgentEvent>> {
    let path = get_session_path(session_id).await?;

    let buffer = match fs::read_to_string(&path).await {
        Ok(buf) => buf,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).context("could not open session file"),
    };

    let events = buffer
        .lines()
        .map(serde_json::from_str::<AgentEvent>)
        .collect::<Result<Vec<_>, _>>()
        .context("malformed session file")?;

    Ok(events)
}

/// Appends one event as a line to the session's `.jsonl` log.
pub async fn append_session_event(session_id: &str, event: AgentEvent) -> Result<()> {
    let path = get_session_path(session_id).await?;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .context("failed to open session file")?;

    let line = format!("{}\n", serde_json::to_string(&event)?);

    file.write_all(line.as_bytes()).await?;

    Ok(())
}

/// One unreadable line, kept for investigation.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseFailure {
    pub ts: String,
    pub session_id: String,
    /// Which stage gave up: `parse` (no variant matched the wire), `map` (the
    /// mapper errored), or `unknown_subtype` (parsed only by a catch-all).
    pub stage: String,
    pub detail: String,
    /// The raw line, whole. Truncating it would cost exactly the context these
    /// records exist to provide.
    pub raw: String,
}

static FAILURES_LOCK: Mutex<()> = Mutex::const_new(());

/// Records a line the harness layer could not turn into an event.
///
/// One file for the whole app, not one per session: these describe how well
/// this build covers the wire format, which is a property of the build rather
/// than of any conversation — and hunting a coverage gap across N session logs
/// is the thing that makes it never get done. Deliberately kept out of the
/// session `.jsonl`, whose contract is the normalized event model.
///
/// Unlike a session log this file has many concurrent writers, so it takes a
/// lock: a raw line can exceed the size the OS appends atomically, and two
/// sessions failing at once would interleave into unparseable records.
pub async fn record_parse_failure(
    session_id: &str,
    stage: &str,
    detail: &str,
    raw: &str,
) -> Result<()> {
    let failure = ParseFailure {
        ts: now_rfc3339(),
        session_id: session_id.to_string(),
        stage: stage.to_string(),
        detail: detail.to_string(),
        raw: raw.to_string(),
    };

    let path = get_home_app_dir().await?.join("parse_failures.jsonl");
    let line = format!("{}\n", serde_json::to_string(&failure)?);

    let _guard = FAILURES_LOCK.lock().await;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .context("failed to open parse failure log")?;

    file.write_all(line.as_bytes()).await?;

    Ok(())
}

/// Tail-reads the log's last line to continue its `seq` counter on resume.
pub async fn next_seq_by_session_id(session_id: &str) -> Result<u64> {
    let path = get_session_path(session_id).await?;

    let buf = match fs::read_to_string(&path).await {
        Ok(buf) => buf,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e).context("could not read session file"),
    };

    let seq = match buf.lines().next_back() {
        Some(v) => {
            let json: Value = serde_json::from_str(v)?;
            json.get("seq").and_then(|s| s.as_u64()).unwrap_or(0)
        }
        None => 0,
    };

    Ok(seq + 1)
}

/// Path to a session's `.jsonl` log under the sessions dir.
pub async fn get_session_path(session_id: &str) -> Result<PathBuf> {
    let path = get_sessions_dir()
        .await?
        .join(format!("{session_id}.jsonl"));

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_entries_written_before_these_fields_still_read() {
        let legacy = r#"{"sessionId":"a","harness":"claude_code","cwd":"/p","projectPath":"/p",
            "branch":null,"worktreeName":null,"title":"t","created":"c","modified":"m",
            "archived":false,"pinned":false}"#;

        let item: SessionIndexItem = serde_json::from_str(legacy).unwrap();

        assert_eq!(item.status, SessionStatus::Idle);
        // Reads back as a model no build lists, so it can never reach a spawn.
        assert_eq!(item.model, ModelId::Unknown);
        assert!(crate::models::find_model(item.model).is_none());
        // Absent reads as the composer's own default, so an old session resumes
        // under the mode its picker would show.
        assert_eq!(item.permission_mode, ApprovalPolicy::Auto);
    }

    #[test]
    fn archived_filter_splits_the_index_into_two_disjoint_views() {
        let item = |id: &str, archived: bool| {
            let mut i = SessionIndexItem::new(
                id,
                Harness::ClaudeCode,
                "/p",
                "/p",
                None,
                None,
                "hi",
                ModelId::Opus,
                None,
                ApprovalPolicy::Auto,
            );
            i.archived = archived;
            i
        };
        let items = vec![item("a", false), item("b", true), item("c", false)];

        let active = filter_by_archived(items.clone(), false);
        let settled = filter_by_archived(items, true);

        assert_eq!(
            active.iter().map(|i| i.session_id.as_str()).collect::<Vec<_>>(),
            ["a", "c"]
        );
        assert_eq!(
            settled.iter().map(|i| i.session_id.as_str()).collect::<Vec<_>>(),
            ["b"]
        );
    }

    #[test]
    fn snapshot_flattens_index_fields_beside_events() {
        let item = SessionIndexItem::new(
            "a",
            Harness::ClaudeCode,
            "/p",
            "/p",
            None,
            Some("main"),
            "hi",
            ModelId::Opus,
            Some(Effort::High),
            ApprovalPolicy::AcceptEdits,
        );
        let json = serde_json::to_value(SessionSnapshot {
            index_item: item,
            events: vec![],
        })
        .unwrap();

        assert_eq!(json["sessionId"], "a");
        assert_eq!(json["status"], "idle");
        assert!(json["events"].is_array());
        assert!(
            json.get("indexItem").is_none(),
            "must stay flat for the generated TS type"
        );
    }
}
