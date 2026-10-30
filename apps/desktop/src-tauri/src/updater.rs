//! In-app updates over the Tauri updater plugin.
//!
//! Two channels, one manifest each, both served from the repo's GitHub Pages
//! branch. The channel is chosen per check rather than in `tauri.conf.json`,
//! so switching it needs no rebuild — the config endpoint is only the fallback
//! for a caller that names no channel.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use ts_rs::TS;

use crate::{analytics, binpath, store::get_home_app_dir};

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

    /// The CLI's spelling, for `--channel` and `DRAY_CHANNEL`.
    fn cli_name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
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

    /// The tag, as the frontend reads it. Written out rather than derived from
    /// the `Serialize` above, since serializing to find out would carry the
    /// message along with it — and the message is the one thing that must not
    /// reach a report.
    fn stage(&self) -> &'static str {
        match self {
            Self::Install { .. } => "install",
            Self::Relaunch { .. } => "relaunch",
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
    // Here because this is where the channel arrives: it lives in the
    // frontend's local storage, out of reach of `setup`.
    tauri::async_runtime::spawn(sync_cli(channel));

    // A bundle already downloaded is the version to beat, not the one running:
    // judged against the running one, a newer release than the bundle could
    // never be found until the reader restarted onto the stale one.
    let pending = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .map_err(|_| "pending update lock poisoned".to_string())?
        .as_ref()
        .map(|(update, _)| update.version.clone());
    // A newer bundle downloads under the one already ready, so its row keeps
    // its button rather than turning into a bar that a failed download strands.
    let quiet = pending.is_some();

    let updater = app
        .updater_builder()
        .endpoints(vec![channel.manifest().parse().map_err(|e| format!("{e}"))?])
        .map_err(|e| e.to_string())?
        .version_comparator(move |running, release| {
            release.version > version_to_beat(running, pending.as_deref())
        })
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };

    let version = update.version.clone();
    let notes = update.body.clone();

    if !quiet {
        emit_status(
            &app,
            UpdateStatus::Downloading {
                version: version.clone(),
                percent: None,
            },
        );
    }

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
                if quiet {
                    return;
                }
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
    let outcome = install(app).await;

    // One report for four ways to fail, which is why the body is split out. A
    // broken updater is otherwise entirely invisible: the reader stops getting
    // versions and nothing anywhere says so. Only the tag goes — the message
    // beside it is the plugin's, free to name a path on the reader's disk.
    if let Err(e) = &outcome {
        analytics::error("update_install", json!({ "stage": e.stage() }));
    }

    outcome
}

/// The body of [`install_update`], split out so every failure passes one point.
async fn install(app: AppHandle) -> Result<(), InstallError> {
    // Cloned rather than taken, so a failed install leaves the bundle in place
    // to be retried. Taking it would strand the row on a button that can only
    // ever error until the next check found something newer.
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
    // The plugin's own save runs on exit, after the new instance has already
    // read the file, so the relaunch would open at the previous quit's size.
    if let Err(e) = app.save_window_state(StateFlags::all()) {
        eprintln!("[window state save err] {e}");
    }
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
            return Err(crate::git::stderr_or(&out, || format!("`open` refused {}", bundle.display())));
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

/// Runs the installed CLI's own `dray update` on the first launch of a new app
/// version, so an app that bumped `PROTOCOL_VERSION` does not leave every
/// agent's `dray` call refused until somebody updates it by hand.
///
/// `dray update` decides whether anything is newer, so nothing here compares
/// versions. Only a CLI already installed is touched: the app still installs
/// nothing. Dev and debug builds skip it, since the CLI on disk belongs to the
/// release app. The version is recorded only once that is answered, so a launch
/// with no network tries again next time.
///
/// The marker is its own file rather than a field on `settings.json`: that file
/// is rewritten whole, and a second app instance (the `open -n` relaunch is
/// one) writing a marker from a stale read would undo the reader's settings.
///
/// The CLI takes the app's channel, and only here: flipping the switch moves
/// the CLI at the next app update, the same moment it moves the app. Leaving
/// beta downgrades nothing, since the installer keeps a CLI newer than what
/// the channel offers.
///
/// Every update check calls this, so one run at a time: a manual check during
/// the first one would otherwise start a second installer beside it.
async fn sync_cli(channel: UpdateChannel) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if tauri::is_dev() || cfg!(debug_assertions) || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    sync_cli_once(channel).await;
    RUNNING.store(false, Ordering::SeqCst);
}

async fn sync_cli_once(channel: UpdateChannel) {
    let version = env!("CARGO_PKG_VERSION");
    let Ok(marker) = get_home_app_dir().await.map(|dir| dir.join("cli-synced")) else {
        return;
    };
    if tokio::fs::read_to_string(&marker)
        .await
        .is_ok_and(|synced| synced.trim() == version)
    {
        return;
    }

    if let Some((dray, cli_version)) = installed_cli().await {
        let mut command = tokio::process::Command::new(&dray);
        command.arg("update");
        // A CLI before 0.12 refuses `--channel` but hands `DRAY_CHANNEL` on to
        // the installer; a newer one sets that variable itself, from the flag.
        command.env("DRAY_CHANNEL", channel.cli_name());
        if takes_channel_flag(&cli_version) {
            command.args(["--channel", channel.cli_name()]);
        }
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(e) => {
                eprintln!("[cli sync] could not run {}: {e}", dray.display());
                return;
            }
        };
        match tokio::time::timeout(CLI_UPDATE_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) if status.success() => {}
            Ok(Ok(status)) => {
                eprintln!("[cli sync] dray update failed ({status})");
                return;
            }
            Ok(Err(e)) => {
                eprintln!("[cli sync] dray update did not finish: {e}");
                return;
            }
            // The installer is `sh` running curl under `dray`, so killing the
            // child alone leaves the download running.
            Err(_) => {
                if let Some(root) = child.id() {
                    crate::local_servers::kill_descendants(root).await;
                }
                let _ = child.kill().await;
                eprintln!("[cli sync] dray update timed out");
                return;
            }
        }
    }

    if let Err(e) = tokio::fs::write(&marker, version).await {
        eprintln!("[cli sync] could not record the version: {e}");
    }
}

/// Generous: a slow link pulling a few MB, plus the skill write.
const CLI_UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

/// The `dray` on disk, only where it answers `--version` the way Dray's CLI
/// does — the name is generic enough for something else on `PATH` to carry it,
/// and this is about to be run with `update`. Answers the version beside it.
async fn installed_cli() -> Option<(PathBuf, String)> {
    let dray = binpath::dray().await?;
    let out = tokio::process::Command::new(&dray)
        .arg("--version")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(5), out).await.ok()?.ok()?;
    let version = String::from_utf8_lossy(&out.stdout).strip_prefix("dray ")?.trim().to_owned();
    out.status.success().then_some((dray, version))
}

/// Whether `dray update` knows `--channel`, which arrived in CLI 0.12.
fn takes_channel_flag(version: &str) -> bool {
    let mut parts = version.split(['.', '-']).map(|p| p.parse::<u64>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0)) >= (0, 12)
}

/// The running version, or the downloaded bundle's where one is newer. A pending
/// version that will not parse is ignored, which costs a repeat download and
/// never a missed release.
fn version_to_beat(running: semver::Version, pending: Option<&str>) -> semver::Version {
    pending
        .and_then(|v| semver::Version::parse(v).ok())
        .map_or(running.clone(), |p| p.max(running))
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

    /// A wrong answer one way fails every sync on an unknown flag; the other
    /// way leaves a 0.12 CLI on the channel its own version names.
    #[test]
    fn only_a_cli_from_0_12_is_handed_the_channel_flag() {
        for (version, takes) in [
            ("0.11.0", false),
            ("0.9.5", false),
            ("0.12.0-beta.1", true),
            ("0.12.0", true),
            ("1.0.0", true),
        ] {
            assert_eq!(super::takes_channel_flag(version), takes, "{version}");
        }
    }

    /// A ready bundle must not be fetched again, nor replaced by anything but a
    /// newer release — a stable one older than a beta already downloaded
    /// included.
    #[test]
    fn a_ready_bundle_is_replaced_only_by_a_newer_release() {
        let v = |s: &str| semver::Version::parse(s).unwrap();
        let newer = |release: &str, pending: Option<&str>| {
            v(release) > super::version_to_beat(v("0.29.12"), pending)
        };
        assert!(newer("0.29.13", None));
        assert!(!newer("0.29.12", None));
        assert!(!newer("0.29.13", Some("0.29.13")));
        assert!(newer("0.29.14", Some("0.29.13")));
        assert!(!newer("0.29.13", Some("0.30.0-beta.1")));
        assert!(newer("0.30.0", Some("0.30.0-beta.1")));
        assert!(newer("0.29.13", Some("not a version")));
    }

    #[test]
    fn finds_the_bundle_an_executable_sits_in() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Dray.app/Contents/MacOS/dray")),
            Some(Path::new("/Applications/Dray.app"))
        );
    }

    /// The stage is stated twice — once for the frontend to match a cure on,
    /// once for a report that must not carry the message beside it — so the two
    /// spellings are pinned together rather than left free to drift.
    #[test]
    fn a_reported_stage_is_the_one_the_frontend_reads() {
        for error in [
            super::InstallError::install("swap failed"),
            super::InstallError::Relaunch {
                message: "open refused".into(),
            },
        ] {
            let wire = serde_json::to_value(&error).expect("serializes");
            assert_eq!(wire["stage"], error.stage());
        }
    }

    #[test]
    fn a_bare_binary_has_no_bundle() {
        // What `pnpm tauri dev` runs, and what the `open` branch must not take.
        assert_eq!(bundle_of(Path::new("/x/target/debug/dray")), None);
        // Deep enough to have a fourth ancestor, but it is not a bundle.
        assert_eq!(bundle_of(Path::new("/a/b/c/d/dray")), None);
    }
}
