use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    events::ApprovalPolicy,
    models::{Effort, ModelId},
    session::Harness,
    store::{get_home_app_dir, read_json, write_atomic},
    Fail,
};

/// A task written but not started, in `drafts.json` beside the index rather
/// than in it: an older build reading a draft there would draw a session with
/// no conversation behind it, and resuming one fails.
///
/// The file holds JSON and is read and written as JSON, so a draft carrying a
/// pick this build cannot spell is kept whole rather than failing the file —
/// the trap the index's own enums keep falling in. [`StoredDraft`] is the shape
/// for the places that have to read the picks; it matches `Draft` in
/// `useDrafts.ts` field for field.
static DRAFTS_LOCK: Mutex<()> = Mutex::const_new(());

/// Ids removed this run. An autosave already queued when the CLI removes or
/// starts its draft would otherwise write it straight back; no caller ever
/// saves a removed id again, so refusing them costs nothing.
static TAKEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn taken(id: &str) -> bool {
    TAKEN.lock().unwrap().iter().any(|t| t == id)
}

/// Emitted when the CLI changes the list, so the sidebar follows without the
/// reader asking. The app's own writes need none: the frontend made them.
pub const DRAFTS_CHANGED: &str = "drafts_changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDraft {
    pub id: String,
    pub prompt: String,
    pub project_path: String,
    pub harness: Harness,
    pub model: ModelId,
    pub effort: Option<Effort>,
    pub permission_mode: ApprovalPolicy,
    pub fast: bool,
    pub use_worktree: bool,
    pub created: String,
}

async fn drafts_path() -> Result<std::path::PathBuf> {
    Ok(get_home_app_dir().await?.join("drafts.json"))
}

/// Caller holds `DRAFTS_LOCK`: the file is rewritten whole.
async fn write_drafts(drafts: &[Value]) -> Result<()> {
    write_atomic(&drafts_path().await?, serde_json::to_string(drafts)?).await
}

fn id_of(draft: &Value) -> Option<&str> {
    draft.get("id")?.as_str()
}

/// Every saved draft, in the order they were first saved.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_drafts() -> Result<Vec<Value>, Fail> {
    Ok(read_json(&drafts_path().await?).await?)
}

/// The drafts this build can read the picks of. One it cannot is left out of
/// the answer and left alone in the file.
pub async fn stored() -> Result<Vec<StoredDraft>> {
    Ok(list_drafts()
        .await?
        .into_iter()
        .filter_map(|d| serde_json::from_value(d).ok())
        .collect())
}

/// Writes a draft, replacing the one with the same `id` or adding it at the end.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_draft(draft: Value) -> Result<(), Fail> {
    let id = id_of(&draft).ok_or_else(|| anyhow!("a draft needs an id"))?.to_owned();
    let _guard = DRAFTS_LOCK.lock().await;
    if taken(&id) {
        return Ok(());
    }
    let mut drafts = list_drafts().await?;
    match drafts.iter_mut().find(|d| id_of(d) == Some(id.as_str())) {
        Some(existing) => *existing = draft,
        None => drafts.push(draft),
    }
    Ok(write_drafts(&drafts).await?)
}

/// Removes a draft. An unknown id is not an error: the send that turns a
/// draft into a session and the reader's own delete can both reach here.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_draft(id: String) -> Result<(), Fail> {
    take(&id).await?;
    Ok(())
}

/// Removes a draft and hands back what it held, or `None` where there was none.
pub async fn take(id: &str) -> Result<Option<Value>> {
    let _guard = DRAFTS_LOCK.lock().await;
    let mut drafts = list_drafts().await?;
    let Some(at) = drafts.iter().position(|d| id_of(d) == Some(id)) else {
        return Ok(None);
    };
    let draft = drafts.remove(at);
    write_drafts(&drafts).await?;
    TAKEN.lock().unwrap().push(id.to_owned());
    Ok(Some(draft))
}

/// Puts back a draft [`take`] removed, for a start that failed.
pub async fn restore(draft: Value) -> Result<()> {
    let id = id_of(&draft).unwrap_or_default().to_owned();
    TAKEN.lock().unwrap().retain(|t| *t != id);
    save_draft(draft).await.map_err(|e| e.0)
}
