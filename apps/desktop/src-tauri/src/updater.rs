//! In-app updates over the Tauri updater plugin.
//!
//! Two channels, one manifest each, both served from the repo's GitHub Pages
//! branch. The channel is chosen per check rather than in `tauri.conf.json`,
//! so switching it needs no rebuild — the config endpoint is only the fallback
//! for a caller that names no channel.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use ts_rs::TS;

const STABLE_MANIFEST: &str = "https://monorepo-labs.github.io/dray/stable.json";
const BETA_MANIFEST: &str = "https://monorepo-labs.github.io/dray/beta.json";

/// The app menu's "Check for Updates…" item.
pub const CHECK_UPDATE_ID: &str = "check_update";

/// What that item emits. It asks the frontend to check rather than checking
/// here, because the channel is the frontend's — it lives in local storage, and
/// this side is handed one per call. Emitting also means the manual check runs
/// the same path as the scheduled one, in-flight guard included.
pub const CHECK_UPDATE_REQUESTED: &str = "check_update_requested";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    fn manifest(self) -> &'static str {
        match self {
            Self::Stable => STABLE_MANIFEST,
            Self::Beta => BETA_MANIFEST,
        }
    }
}

/// What the sidebar row draws. There is no idle variant: nothing is emitted
/// until an update exists, so the frontend's own `null` is the resting state
/// and a failed check leaves the UI exactly as it was.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateStatus {
    Downloading {
        version: String,
        /// `None` until the server sends a content length, which not every
        /// CDN does — the row shows an indeterminate state rather than 0%.
        percent: Option<u8>,
    },
    Ready {
        version: String,
        notes: Option<String>,
    },
}

/// The downloaded bundle, held between the background download and the user
/// pressing install. Kept in memory rather than spooled to a temp file: it is
/// ~15MB once, and a file would need its own cleanup on the paths where the
/// user never installs.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<(Update, Vec<u8>)>>);

/// Checks the channel's manifest and, when something newer is there, downloads
/// it in the background. Progress and readiness arrive as `update_status`
/// events; the returned `Ok(())` only means the run finished.
///
/// A failed check is not an error the user should see — no network is the
/// common case — so the caller logs and moves on.
#[tauri::command]
pub async fn check_update(
    channel: UpdateChannel,
    app: AppHandle,
) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![channel.manifest().parse().map_err(|e| format!("{e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };

    let version = update.version.clone();
    let notes = update.body.clone();

    emit_status(
        &app,
        UpdateStatus::Downloading {
            version: version.clone(),
            percent: None,
        },
    );

    // Chunks land every few KB, which is thousands of events over one bundle.
    // Only a change in whole percent is worth a render.
    let mut downloaded: u64 = 0;
    let mut last_percent: Option<u8> = None;
    let progress_app = app.clone();
    let progress_version = version.clone();

    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let Some(total) = total.filter(|t| *t > 0) else {
                    return;
                };
                let percent = ((downloaded * 100) / total).min(100) as u8;
                if last_percent == Some(percent) {
                    return;
                }
                last_percent = Some(percent);
                emit_status(
                    &progress_app,
                    UpdateStatus::Downloading {
                        version: progress_version.clone(),
                        percent: Some(percent),
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    app.state::<PendingUpdate>()
        .0
        .lock()
        .map_err(|_| "pending update lock poisoned".to_string())?
        .replace((update, bytes));

    emit_status(&app, UpdateStatus::Ready { version, notes });
    Ok(())
}

/// Swaps the bundle for the one already downloaded and relaunches.
///
/// Never returns on success — `restart` diverges — so the caller's `invoke`
/// resolving at all means the install failed. Whether any session is mid-turn
/// is the frontend's call: this is the point of no return, and the check
/// belongs where the button is.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    // Cloned rather than taken, so a failed install leaves the bundle in place
    // to be retried. Taking it would strand the row on a button that can only
    // ever error: the frontend stops checking once an update is ready, so
    // nothing would ever download a replacement.
    let pending = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .map_err(|_| "pending update lock poisoned".to_string())?
        .clone();

    let Some((update, bytes)) = pending else {
        return Err("no update has been downloaded".into());
    };

    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

fn emit_status(app: &AppHandle, status: UpdateStatus) {
    if let Err(e) = app.emit("update_status", &status) {
        eprintln!("[update status emit err] {e}");
    }
}
