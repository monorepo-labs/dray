//! Getting a model onto disk, and knowing when one already is.
//!
//! Downloads are hundreds of megabytes over a link that may not survive them,
//! so nothing here trusts a file's existence: a model counts as installed only
//! at the catalog's exact size, and is verified against the catalog's hash
//! before it is moved into place. The failure this prevents is the quiet one —
//! a truncated GGUF loads far enough to produce garbage rather than an error.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::{
    fs,
    io::{AsyncWriteExt, BufWriter},
};
use ts_rs::TS;

use super::catalog::{self, TranscriptionModel};
use crate::store::get_home_app_dir;

/// Progress for the settings tab's bar.
///
/// Emitted rather than returned because a download outlives the dialog that
/// started it — closing settings mid-download must not cancel it, and reopening
/// must find it still running.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub received: u64,
    pub total: u64,
    /// Set once, on the last event, when the model failed to land.
    pub error: Option<String>,
}

/// `~/.dray/models/`, created on demand.
///
/// Beside the sessions and attachments rather than in the OS cache directory:
/// these are hundreds of megabytes the reader chose to download, and a cache is
/// a place the system is entitled to empty without asking.
pub async fn models_dir() -> Result<PathBuf> {
    let dir = get_home_app_dir().await?.join("models");
    fs::create_dir_all(&dir)
        .await
        .context("could not create the models directory")?;

    Ok(dir)
}

pub async fn model_path(model: &TranscriptionModel) -> Result<PathBuf> {
    Ok(models_dir().await?.join(model.file_name()))
}

/// Whether a model is on disk and the right size.
///
/// Size alone, not the hash: hashing 700MB takes long enough to be felt every
/// time the settings tab opens, and the hash is already checked at the one
/// moment it can catch anything — before a fresh download is moved into place.
pub async fn is_installed(model: &TranscriptionModel) -> bool {
    let Ok(path) = model_path(model).await else {
        return false;
    };

    matches!(fs::metadata(&path).await, Ok(m) if m.len() == model.size_bytes)
}

/// Which catalog ids are currently installed.
pub async fn installed_ids() -> Vec<String> {
    let mut ids = Vec::new();

    for model in catalog::MODELS {
        if is_installed(model).await {
            ids.push(model.id.to_string());
        }
    }

    ids
}

pub async fn delete(model: &TranscriptionModel) -> Result<()> {
    let path = model_path(model).await?;

    match fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        // Already gone is the outcome asked for.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).context("could not delete the model"),
    }
}

/// Downloads currently running, so one can be called off.
///
/// A cancelled entry is *removed* rather than set false, so "is this cancelled"
/// and "is this running" are one question. Keyed by model id, since that is
/// what the button in settings has to hand.
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn cancel_flag(model_id: &str, set: bool) {
    let mut guard = CANCELLED.lock().expect("cancel set poisoned");
    let ids = guard.get_or_insert_with(HashSet::new);

    if set {
        ids.insert(model_id.to_string());
    } else {
        ids.remove(model_id);
    }
}

fn is_cancelled(model_id: &str) -> bool {
    CANCELLED
        .lock()
        .expect("cancel set poisoned")
        .as_ref()
        .is_some_and(|ids| ids.contains(model_id))
}

/// Asks a running download to stop. Harmless where none is.
///
/// Cooperative rather than aborting the task: the stream loop owns a half-written
/// file and a hasher, and the one safe place to give up is between chunks, where
/// it can delete the `.part` on its way out.
pub fn cancel(model_id: &str) {
    cancel_flag(model_id, true);
}

/// Raised when the reader called the download off. Carried as an error so the
/// `.part` cleanup and the cancelled state share one path out.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "download cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// Whether the bytes actually landed on disk.
///
/// A cancel is what the reader asked for, so [`download`] answers `Ok` — which
/// left the caller unable to tell it from a finished download, and it went on
/// to select a model that was never written. Selection then named a file
/// `is_installed` does not believe in, so the tab drew a tick beside a model
/// the composer kept refusing to dictate with. The distinction has to ride the
/// success path, since that is the path both take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Downloaded {
    Installed,
    Cancelled,
}

/// Streams the model to a temp file, verifies it, then renames it into place.
///
/// The rename is what makes the whole thing safe to interrupt: the real path
/// only ever holds a file that already passed verification, so a process killed
/// mid-download leaves a `.part` to be overwritten and nothing that
/// [`is_installed`] would believe.
pub async fn download(app: &AppHandle, model: &TranscriptionModel) -> Result<Downloaded> {
    let path = model_path(model).await?;
    let part = path.with_extension("part");

    // Clears a flag left by a previous cancel, so starting again actually runs.
    cancel_flag(model.id, false);

    let result = stream_to(app, model, &part).await;

    if let Err(e) = result {
        let _ = fs::remove_file(&part).await;
        cancel_flag(model.id, false);

        // A cancel is what the reader asked for, so it ends the progress entry
        // without an error message the settings tab would have to draw.
        if e.downcast_ref::<Cancelled>().is_some() {
            emit(app, model, 0, model.size_bytes, None);
            return Ok(Downloaded::Cancelled);
        }

        emit(app, model, 0, model.size_bytes, Some(e.to_string()));

        return Err(e);
    }

    fs::rename(&part, &path)
        .await
        .context("could not move the downloaded model into place")?;

    emit(app, model, model.size_bytes, model.size_bytes, None);

    Ok(Downloaded::Installed)
}

async fn stream_to(app: &AppHandle, model: &TranscriptionModel, part: &Path) -> Result<()> {
    let response = reqwest::get(model.url())
        .await
        .context("could not reach Hugging Face")?;

    if !response.status().is_success() {
        bail!("download failed with status {}", response.status());
    }

    // The catalog's size is the one used for progress, not `content_length`:
    // the header can be absent or wrong, and it is also what the finished file
    // is checked against, so the bar and the check agree by construction.
    let total = model.size_bytes;

    let file = fs::File::create(part)
        .await
        .context("could not open the download file")?;
    let mut writer = BufWriter::new(file);
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit = 0u64;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        // Between chunks is the one point where giving up leaves nothing half
        // written that the caller has to reason about.
        if is_cancelled(model.id) {
            return Err(Cancelled.into());
        }

        let chunk = chunk.context("the download was interrupted")?;

        hasher.update(&chunk);
        writer
            .write_all(&chunk)
            .await
            .context("could not write the model to disk")?;

        received += chunk.len() as u64;

        // Roughly every 4MB. One event per chunk is thousands of round trips to
        // the webview for a bar that redraws at screen resolution.
        if received - last_emit >= 4 << 20 {
            last_emit = received;
            emit(app, model, received, total, None);
        }
    }

    writer
        .flush()
        .await
        .context("could not finish writing the model")?;

    if received != model.size_bytes {
        bail!(
            "downloaded {received} bytes where the catalog expects {}",
            model.size_bytes
        );
    }

    let digest = hex(&hasher.finalize());
    if digest != model.sha256 {
        bail!("the downloaded model does not match its published checksum");
    }

    Ok(())
}

fn emit(app: &AppHandle, model: &TranscriptionModel, received: u64, total: u64, error: Option<String>) {
    let _ = app.emit(
        "transcription_download_progress",
        DownloadProgress {
            model_id: model.id.to_string(),
            received,
            total,
            error,
        },
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolves an id to the path of an installed model, or says why not.
pub async fn installed_path(model_id: &str) -> Result<PathBuf> {
    let model =
        catalog::find(model_id).ok_or_else(|| anyhow!("unknown model \"{model_id}\""))?;

    if !is_installed(model).await {
        bail!("{} is not downloaded yet", model.name);
    }

    model_path(model).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    /// The catalog's hashes are compared against this spelling, so a change in
    /// width or case here silently fails every download.
    #[test]
    fn hex_of_a_known_digest_matches_the_catalog_spelling() {
        let digest = hex(&Sha256::digest(b""));

        assert_eq!(
            digest,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(digest.len(), 64);
    }

    #[tokio::test]
    async fn unknown_model_id_is_an_error() {
        assert!(installed_path("not-a-model").await.is_err());
    }

    /// Ids are namespaced by the catalog, so these use names no model has —
    /// the flag set is process-wide and a real id would leak between tests.
    #[test]
    fn cancelling_marks_only_the_named_download() {
        cancel("test-cancel-a");

        assert!(is_cancelled("test-cancel-a"));
        assert!(!is_cancelled("test-cancel-b"));

        cancel_flag("test-cancel-a", false);
    }

    /// The flag is cleared at the *start* of a download, or a model cancelled
    /// once could never be downloaded again for the life of the process.
    #[test]
    fn clearing_lets_a_download_run_again() {
        cancel("test-cancel-retry");
        assert!(is_cancelled("test-cancel-retry"));

        cancel_flag("test-cancel-retry", false);

        assert!(!is_cancelled("test-cancel-retry"));
    }

    #[test]
    fn an_untouched_model_is_not_cancelled() {
        assert!(!is_cancelled("test-cancel-never-touched"));
    }

    /// `download` distinguishes a cancel from a real failure by downcasting,
    /// so the error has to survive the trip through `anyhow`.
    #[test]
    fn cancelled_survives_being_boxed_as_anyhow() {
        let e: anyhow::Error = Cancelled.into();

        assert!(e.downcast_ref::<Cancelled>().is_some());
        assert_eq!(e.to_string(), "download cancelled");
    }

    #[test]
    fn part_and_final_paths_differ() {
        let path = PathBuf::from("/tmp/models/whisper-small.gguf");

        assert_ne!(path.with_extension("part"), path);
    }
}
