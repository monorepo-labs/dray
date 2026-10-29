//! Getting Chromium onto disk after install, and knowing when it is there.
//!
//! The in-app browser is CEF, and the framework it loads is ~330MB unpacked.
//! Shipped in the bundle it would ride every download and every update, so the
//! bundle carries only the five helper apps (on Linux, nothing: the app's own
//! binary is the subprocess) and this fetches the framework a
//! few seconds after the window first opens — from the CDN the `cef` crate's
//! own build script reads, pinned to the crate's CEF version. Same shape as the
//! transcription models: `.part` + rename, size and hash checked before
//! anything is unpacked, progress as an event every few megabytes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::{fs, sync::Notify};
use ts_rs::TS;

/// The CEF version the `cef` crate in Cargo.toml binds. Framework and
/// bindings have to agree, so bumping the crate means re-pinning [`ARM64`]
/// and [`X64`] below from `cef-builds.spotifycdn.com/index.json` as well.
pub const VERSION: &str = "154.0.34";
const BUILD: &str = "154.0.34+g14c5a08+chromium-154.0.8037.98";
const CDN: &str = "https://cef-builds.spotifycdn.com";
#[cfg(target_os = "macos")]
pub const FRAMEWORK: &str = "Chromium Embedded Framework.framework";
#[cfg(target_os = "macos")]
const LIBRARY: &str = "Chromium Embedded Framework";
/// Linux has no framework bundle: libcef.so wants its `.pak`s, `icudtl.dat`
/// and `locales/` in one directory, so the archive's `Release` and
/// `Resources` are unpacked together into this one.
#[cfg(target_os = "linux")]
pub const FRAMEWORK: &str = "lib";
#[cfg(target_os = "linux")]
const LIBRARY: &str = "libcef.so";

/// One minimal tarball per architecture. Size and hash are of the file as
/// downloaded and checked by hand; the CDN publishes only a sha1.
struct Tarball {
    platform: &'static str,
    size: u64,
    sha256: &'static str,
}

#[cfg(target_os = "macos")]
const ARM64: Tarball = Tarball {
    platform: "macosarm64",
    size: 132_210_884,
    sha256: "b7efb24bcce34b94e836a9f545005aea210e08abdf4ee1483ea03b8daf93f080",
};

#[cfg(target_os = "macos")]
const X64: Tarball = Tarball {
    platform: "macosx64",
    size: 138_623_289,
    sha256: "ebcb691252c9ccde63488a913e2381bce4e275acbbb96ce4763b318b7f0b781a",
};

#[cfg(target_os = "linux")]
const ARM64: Tarball = Tarball {
    platform: "linuxarm64",
    size: 423_940_526,
    sha256: "4598b350e5a43519dbb9f1c732e8b184333572da53244ff55cc063003c34c5e4",
};

#[cfg(target_os = "linux")]
const X64: Tarball = Tarball {
    platform: "linux64",
    size: 326_489_962,
    sha256: "e87e2c76304372dd28b899ceb6efa4b353f52700594ddc358a8237ec07ec6492",
};

fn tarball() -> Option<&'static Tarball> {
    match std::env::consts::ARCH {
        "aarch64" => Some(&ARM64),
        "x86_64" => Some(&X64),
        _ => None,
    }
}

impl Tarball {
    /// The archive's top-level directory, which is also its file stem.
    fn root(&self) -> String {
        format!("cef_binary_{BUILD}_{}_minimal", self.platform)
    }

    fn name(&self) -> String {
        format!("{}.tar.bz2", self.root())
    }

    /// `+` is a space to an S3 front, so it goes over the wire encoded.
    fn url(&self) -> String {
        format!("{CDN}/{}", self.name().replace('+', "%2B"))
    }
}

/// Where the download stands, for the settings row and the browser pane.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ChromiumStatus {
    /// Not on disk and nothing fetching it: before the first attempt, or
    /// after Remove.
    Absent,
    Downloading { received: u64, total: u64 },
    /// The tarball is verified and being unpacked, ~10s.
    Extracting,
    #[serde(rename_all = "camelCase")]
    Ready { version: String, size_bytes: u64 },
    Failed { message: String },
}

static STATUS: Mutex<Option<ChromiumStatus>> = Mutex::new(None);
/// One download loop at a time; a second request wakes the one in backoff.
static RUNNING: AtomicBool = AtomicBool::new(false);
static WAKE: Notify = Notify::const_new();

pub fn status() -> ChromiumStatus {
    STATUS.lock().unwrap().clone().unwrap_or(ChromiumStatus::Absent)
}

fn set(app: &AppHandle, status: ChromiumStatus) {
    *STATUS.lock().unwrap() = Some(status.clone());
    let _ = app.emit("chromium_status", status);
}

/// `~/.dray/cef/` (`cef-dev/` under `tauri dev`, `~/.dray-dev/cef` on
/// Linux), one version directory at a time.
fn cef_dir() -> PathBuf {
    // Split like the profile root: the sweep deletes every version but its
    // own, so a dev build on a newer CEF would take the release app's
    // framework out from under its running helpers.
    #[cfg(target_os = "macos")]
    let dir = if tauri::is_dev() { ".dray/cef-dev" } else { ".dray/cef" };
    // Linux dev builds keep out of `~/.dray` altogether: that home is the
    // release server's, the only one a Linux box may be running — sharing
    // `~/.dray-dev` the way every dev build shares projects and settings.
    #[cfg(target_os = "linux")]
    let dir = if tauri::is_dev() { ".dray-dev/cef" } else { ".dray/cef" };
    std::env::home_dir().unwrap_or_default().join(dir)
}

fn version_dir() -> PathBuf {
    cef_dir().join(VERSION)
}

/// The downloaded framework, if its library is there. The directory only
/// ever holds one that unpacked whole, since it lands by rename.
pub fn installed_framework() -> Option<PathBuf> {
    let framework = version_dir().join(FRAMEWORK);
    framework.join(LIBRARY).is_file().then_some(framework)
}

/// Why a tab cannot open right now, worded for the pane and `dray browser`.
pub fn not_ready_reason() -> String {
    match status() {
        ChromiumStatus::Downloading { received, total } => {
            format!("Chromium is still downloading ({}%)", (received * 100).checked_div(total).unwrap_or(0))
        }
        ChromiumStatus::Extracting => "Chromium is still downloading (unpacking)".into(),
        ChromiumStatus::Failed { message } => {
            format!("Chromium could not be downloaded: {message}. Retry it from Settings.")
        }
        ChromiumStatus::Absent => {
            "Chromium isn't downloaded. Download it from Settings › Integrations.".into()
        }
        ChromiumStatus::Ready { .. } => "Chromium could not start".into(),
    }
}

/// Call once from setup. `present` is a framework the build already has
/// beside its helpers — the dev layout — which makes the download moot.
/// Otherwise the fetch starts a few seconds later, so the window is up
/// first, and the reader is never asked.
pub fn start(app: AppHandle, present: Option<PathBuf>) {
    tauri::async_runtime::spawn(async move {
        if let Some(framework) = present.or_else(installed_framework) {
            set(&app, ready(&framework).await);
            return;
        }
        // Said before the wait, or a tab asked for in these seconds is told
        // to go and press Download in Settings for a download about to start.
        if let Some(tarball) = tarball() {
            set(&app, ChromiumStatus::Downloading { received: 0, total: tarball.size });
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        run(app).await;
    });
}

/// Download with backoff. Each failure is reported as it happens, so the
/// settings row reads "failed" with Retry through the wait, and Retry cuts
/// the wait short rather than starting a second loop.
async fn run(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        // `notify_one`, not `notify_waiters`: Failed is published before the
        // loop reaches `notified()`, and a Retry pressed in that gap would
        // otherwise wake nobody and leave the reader sitting out the backoff.
        // With no waiter the permit is stored and taken by the next wait.
        WAKE.notify_one();
        return;
    }
    let backoff = [10, 30, 120, 600];
    let mut attempt = 0;
    loop {
        match download(&app).await {
            Ok(()) => break,
            Err(e) => {
                eprintln!("[chromium download err] {e:#}");
                set(&app, ChromiumStatus::Failed { message: format!("{e:#}") });
                let Some(secs) = backoff.get(attempt) else { break };
                attempt += 1;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(*secs)) => {}
                    _ = WAKE.notified() => {}
                }
            }
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
}

/// Tarball to `.part`, verified, unpacked into a `.part` directory, renamed
/// into place. The real path only ever holds a framework that passed every
/// check, so a killed process leaves nothing [`installed_framework`] believes.
async fn download(app: &AppHandle) -> Result<()> {
    let tarball = tarball().context("no Chromium build for this architecture")?;
    let dir = cef_dir();
    fs::create_dir_all(&dir).await.context("could not create ~/.dray/cef")?;
    let part = dir.join(format!("{}.part", tarball.name()));

    let total = tarball.size;
    set(app, ChromiumStatus::Downloading { received: 0, total });
    let fetched = crate::download::download_verified(
        &tarball.url(),
        &part,
        total,
        tarball.sha256,
        // Nothing cancels this one: no prompt, no opt-out.
        || false,
        |received| set(app, ChromiumStatus::Downloading { received, total }),
    )
    .await;
    if let Err(e) = fetched {
        let _ = fs::remove_file(&part).await;
        return Err(e);
    }

    set(app, ChromiumStatus::Extracting);
    let stage = dir.join(format!("{VERSION}.part"));
    let _ = fs::remove_dir_all(&stage).await;
    fs::create_dir_all(&stage).await?;
    let unpacked = unpack(tarball, &part, &stage).await;
    let _ = fs::remove_file(&part).await;
    unpacked?;
    let framework = stage.join(FRAMEWORK);
    if !framework.join(LIBRARY).is_file() {
        bail!("the archive did not contain the framework");
    }

    let _ = fs::remove_dir_all(version_dir()).await;
    fs::rename(&stage, version_dir())
        .await
        .context("could not move Chromium into place")?;
    sweep(&dir).await;

    set(app, ready(&version_dir().join(FRAMEWORK)).await);
    Ok(())
}

/// bsdtar, which every Mac has, reads bzip2 itself. Only the framework is
/// taken: the rest of the archive is the SDK the build already used.
#[cfg(target_os = "macos")]
async fn unpack(tarball: &Tarball, part: &Path, stage: &Path) -> Result<()> {
    let out = tokio::process::Command::new("/usr/bin/tar")
        .arg("-xjf")
        .arg(part)
        .arg("-C")
        .arg(stage)
        .arg("--strip-components=2")
        .arg(format!("{}/Release/{FRAMEWORK}", tarball.root()))
        .output()
        .await
        .context("could not run tar")?;
    if !out.status.success() {
        bail!("could not unpack the archive: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// In-process, since nothing promises a Linux desktop has `bzip2`. `Release`
/// and `Resources` both land in [`FRAMEWORK`]. `chrome-sandbox` is left
/// out: it is only of use installed setuid root, and Chromium runs
/// unsandboxed here as on the Mac.
#[cfg(target_os = "linux")]
async fn unpack(tarball: &Tarball, part: &Path, stage: &Path) -> Result<()> {
    let root = PathBuf::from(tarball.root());
    let (part, lib) = (part.to_path_buf(), stage.join(FRAMEWORK));
    tokio::task::spawn_blocking(move || unpack_runtime(&part, &root, &lib))
        .await
        .context("unpack task failed")?
        .context("could not unpack the archive")
}

/// The archive's `<root>/Release/*` and `<root>/Resources/*` into `lib`, one
/// level up. Paths are taken apart by component, so an entry naming `..`
/// or an absolute path is refused rather than written outside `lib`.
#[cfg(target_os = "linux")]
fn unpack_runtime(part: &Path, root: &Path, lib: &Path) -> Result<()> {
    use std::path::Component;
    std::fs::create_dir_all(lib)?;
    let file = std::fs::File::open(part)?;
    let mut archive = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    archive.set_preserve_permissions(true);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let Ok(inside) = path.strip_prefix(root) else { continue };
        let mut parts = inside.components();
        if !matches!(parts.next(), Some(Component::Normal(d)) if d == "Release" || d == "Resources") {
            continue;
        }
        let rel = parts.as_path();
        if rel.as_os_str().is_empty() || rel == Path::new("chrome-sandbox") {
            continue;
        }
        if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            bail!("the archive names a path outside its own: {}", path.display());
        }
        let dest = lib.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry.unpack(&dest)?;
    }
    Ok(())
}

/// Everything in `~/.dray/cef` but the current version: older frameworks,
/// stale `.part`s from a killed run.
async fn sweep(dir: &Path) {
    let Ok(mut entries) = fs::read_dir(dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_name() == VERSION.as_ref() as &std::ffi::OsStr {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path).await;
        } else {
            let _ = fs::remove_file(&path).await;
        }
    }
}

async fn ready(framework: &Path) -> ChromiumStatus {
    let path = framework.to_path_buf();
    let size_bytes = tokio::task::spawn_blocking(move || dir_size(&path))
        .await
        .unwrap_or(0);
    ChromiumStatus::Ready { version: VERSION.into(), size_bytes }
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// Whether the framework is mapped into this process. `cef::start` holds
/// the lock from finding the framework to loading it and leaves `true`
/// behind, never cleared: CEF cannot be shut down and started again in one
/// process. [`remove`] holds it across its check and delete, so neither can
/// slip between the other's two halves.
static LOADED: Mutex<bool> = Mutex::new(false);

pub fn load_guard() -> std::sync::MutexGuard<'static, bool> {
    LOADED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Takes the framework off disk. Refused once CEF has loaded it: the
/// browser process would carry on, but Chromium spawns fresh renderer and
/// GPU helpers for the life of a tab, and each of those loads the framework
/// from disk anew.
pub async fn remove(app: &AppHandle) -> Result<()> {
    if RUNNING.load(Ordering::SeqCst) {
        bail!("Chromium is still downloading");
    }
    // Blocking, since the guard is a std mutex `cef::start` takes on the
    // main thread and cannot be held across an await.
    tokio::task::spawn_blocking(|| {
        let loaded = load_guard();
        if *loaded {
            bail!("Chromium is in use. Quit and reopen Dray, then remove it.");
        }
        match std::fs::remove_dir_all(version_dir()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).context("could not remove Chromium"),
        }
    })
    .await
    .context("remove task failed")??;
    set(app, ChromiumStatus::Absent);
    Ok(())
}

#[tauri::command]
pub fn chromium_status() -> ChromiumStatus {
    status()
}

/// Fetches now, or wakes a loop already waiting out a failure.
#[tauri::command]
pub fn chromium_download(app: AppHandle) {
    tauri::async_runtime::spawn(run(app));
}

#[tauri::command]
pub async fn chromium_remove(app: AppHandle) -> Result<(), String> {
    remove(&app).await.map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file names are what the CDN's index lists for this version, spelled
    /// out here so a re-pin cannot drift from the hashes beside them.
    #[cfg(target_os = "macos")]
    #[test]
    fn tarball_names_match_the_cdn_index() {
        assert_eq!(
            ARM64.name(),
            "cef_binary_154.0.34+g14c5a08+chromium-154.0.8037.98_macosarm64_minimal.tar.bz2"
        );
        assert_eq!(
            X64.name(),
            "cef_binary_154.0.34+g14c5a08+chromium-154.0.8037.98_macosx64_minimal.tar.bz2"
        );
        assert!(ARM64.url().starts_with("https://cef-builds.spotifycdn.com/cef_binary_154.0.34%2B"));
        assert!(!ARM64.url().contains('+'));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tarball_names_match_the_cdn_index() {
        assert_eq!(
            ARM64.name(),
            "cef_binary_154.0.34+g14c5a08+chromium-154.0.8037.98_linuxarm64_minimal.tar.bz2"
        );
        assert_eq!(X64.name(), "cef_binary_154.0.34+g14c5a08+chromium-154.0.8037.98_linux64_minimal.tar.bz2");
    }

    #[test]
    fn version_is_the_crate_build_prefix() {
        assert!(BUILD.starts_with(VERSION));
        // Tests run as a dev build, so this also pins the split from the
        // release app's `.dray/cef`.
        #[cfg(target_os = "macos")]
        assert!(version_dir().ends_with(Path::new(".dray/cef-dev").join(VERSION)));
        #[cfg(target_os = "linux")]
        assert!(version_dir().ends_with(Path::new(".dray-dev/cef").join(VERSION)));
    }

    #[test]
    fn hashes_are_sha256_hex() {
        for t in [&ARM64, &X64] {
            assert_eq!(t.sha256.len(), 64);
            assert!(t.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }
}
