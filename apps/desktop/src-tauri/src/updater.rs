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

/// Which half of the install failed, and it is tagged because the two have
/// opposite cures: a swap that did not complete leaves nothing to open, so
/// pressing the button again is the answer, where a failed *relaunch* left the
/// new bundle on disk and only opening it finishes the job. Telling the reader
/// to quit and reopen for a swap that never landed sends them to do nothing.
///
/// "Did not complete" is deliberately weaker than "changed nothing": the
/// plugin moves the old bundle to a temp backup before unpacking, and a final
/// rename that fails returns `Err` without putting it back. Narrow, upstream,
/// and not something to claim the opposite of in a comment.
///
/// A tag rather than a sentence the frontend matches on, so rewording a message
/// cannot silently swap one cure for the other.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum InstallError {
    Install { message: String },
    Relaunch { message: String },
}

impl InstallError {
    fn install(message: impl Into<String>) -> Self {
        Self::Install {
            message: message.into(),
        }
    }
}

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

/// Swaps the bundle for the one already downloaded, launches it, and quits.
///
/// Whether any session is mid-turn is the frontend's call: this is the point of
/// no return, and the check belongs where the button is.
///
/// Launching *before* quitting is what makes a failure reportable. It is also
/// the whole of DRA-160: this used to end in `AppHandle::restart`, which off the
/// main thread only asks the event loop to exit and relaunches from inside
/// Tauri's own `RunEvent::Exit` arm — *after* this app's handler has run, and
/// that handler ends in `libc::_exit(0)` (see the run loop in `lib.rs`). So the
/// relaunch was never reached, the app simply quit, and there was nothing left
/// running to say so. Nothing here may call `restart` again for that reason.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), InstallError> {
    // Cloned rather than taken, so a failed install leaves the bundle in place
    // to be retried. Taking it would strand the row on a button that can only
    // ever error: the frontend stops checking once an update is ready, so
    // nothing would ever download a replacement.
    let pending = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .map_err(|_| InstallError::install("pending update lock poisoned"))?
        .clone();

    let Some((update, bytes)) = pending else {
        return Err(InstallError::install("no update has been downloaded"));
    };

    update
        .install(bytes)
        .map_err(|e| InstallError::install(e.to_string()))?;
    relaunch(&app).map_err(|message| InstallError::Relaunch { message })?;
    app.exit(0);
    Ok(())
}

/// Launches the bundle that was just installed, and answers whether the OS took
/// it. Returns while the new instance is still coming up — the caller quits
/// straight after, which is the same overlap `restart` had.
///
/// `open` rather than spawning the executable: it goes through Launch Services,
/// so the new instance is registered, and — the reason it is here — a refusal
/// comes back as a non-zero status with a sentence on it rather than as a
/// process that is already gone. `-n` is required, since this app is still
/// running and `open` would otherwise just activate it.
///
/// Environment carries across regardless: `open(1)` states that opened
/// applications inherit it "just as if you had launched the application
/// directly through its full path". `argv` does not, absent `--args`, and
/// nothing here reads any.
///
/// Success only means Launch Services took the request. A new instance that
/// starts and then dies looks the same from here, and telling them apart would
/// want a handshake from the child.
///
/// Falling through to the executable covers a dev build, which is a bare Mach-O
/// with no bundle around it.
fn relaunch(app: &AppHandle) -> Result<(), String> {
    let exe = tauri::process::current_binary(&app.env())
        .map_err(|e| format!("could not resolve this binary: {e}"))?;

    #[cfg(target_os = "macos")]
    if let Some(bundle) = bundle_of(&exe) {
        let out = std::process::Command::new("open")
            .arg("-n")
            .arg(bundle)
            .output()
            .map_err(|e| format!("could not run `open`: {e}"))?;

        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr);
            let why = why.trim();
            return Err(if why.is_empty() {
                format!("`open` refused {}", bundle.display())
            } else {
                why.to_string()
            });
        }
        return Ok(());
    }

    std::process::Command::new(&exe)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not launch {}: {e}", exe.display()))
}

/// The `.app` an executable sits in, or `None` for a bare binary.
///
/// `…/Dray.app/Contents/MacOS/dray` — the fourth ancestor. Counting it wrong
/// costs no error, it just falls through to spawning the executable, so this is
/// pinned rather than left to be read off the call site.
#[cfg(target_os = "macos")]
fn bundle_of(exe: &std::path::Path) -> Option<&std::path::Path> {
    exe.ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
}

fn emit_status(app: &AppHandle, status: UpdateStatus) {
    if let Err(e) = app.emit("update_status", &status) {
        eprintln!("[update status emit err] {e}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::bundle_of;
    use std::path::Path;

    #[test]
    fn finds_the_bundle_an_executable_sits_in() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Dray.app/Contents/MacOS/dray")),
            Some(Path::new("/Applications/Dray.app"))
        );
    }

    #[test]
    fn a_bare_binary_has_no_bundle() {
        // What `pnpm tauri dev` runs, and what the `open` branch must not take.
        assert_eq!(bundle_of(Path::new("/x/target/debug/dray")), None);
        // Deep enough to have a fourth ancestor, but it is not a bundle.
        assert_eq!(bundle_of(Path::new("/a/b/c/d/dray")), None);
    }
}
