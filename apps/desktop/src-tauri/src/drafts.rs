use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    store::{get_home_app_dir, read_json, write_atomic},
    Fail,
};

/// A task written but not started, in `drafts.json` beside the index rather
/// than in it: an older build reading a draft there would draw a session with
/// no conversation behind it, and resuming one fails.
///
/// Held as JSON the frontend shapes. Rust only needs the `id` to replace or
/// remove an entry, and an untyped draft cannot fail a parse on a pick this
/// build has no spelling for — the trap the index's own enums keep falling in.
static DRAFTS_LOCK: Mutex<()> = Mutex::const_new(());

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
#[tauri::command]
pub async fn list_drafts() -> Result<Vec<Value>, Fail> {
    Ok(read_json(&drafts_path().await?).await?)
}

/// Writes a draft, replacing the one with the same `id` or adding it at the end.
#[tauri::command]
pub async fn save_draft(draft: Value) -> Result<(), Fail> {
    let id = id_of(&draft).ok_or_else(|| anyhow!("a draft needs an id"))?.to_owned();
    let _guard = DRAFTS_LOCK.lock().await;
    let mut drafts = list_drafts().await?;
    match drafts.iter_mut().find(|d| id_of(d) == Some(id.as_str())) {
        Some(existing) => *existing = draft,
        None => drafts.push(draft),
    }
    Ok(write_drafts(&drafts).await?)
}

/// Removes a draft. An unknown id is not an error: the send that turns a
/// draft into a session and the reader's own delete can both reach here.
#[tauri::command]
pub async fn delete_draft(id: String) -> Result<(), Fail> {
    let _guard = DRAFTS_LOCK.lock().await;
    let mut drafts = list_drafts().await?;
    drafts.retain(|d| id_of(d) != Some(id.as_str()));
    Ok(write_drafts(&drafts).await?)
}
