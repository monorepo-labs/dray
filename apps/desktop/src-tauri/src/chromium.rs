//! Getting Chromium onto disk after install, and knowing when it is there.
//!
//! The in-app browser is CEF, and the framework it loads is ~330MB unpacked.
//! Shipped in the bundle it would ride every download and every update, so the
//! bundle carries only the five helper apps and this fetches the framework a
//! few seconds after the window first opens — from the CDN the `cef` crate's
//! own build script reads, pinned to the crate's CEF version. Same shape as the
//! transcription models: `.part` + rename, size and hash checked before
//! anything is unpacked, progress as an event every few megabytes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::{
    fs,
    io::{AsyncWriteExt, BufWriter},
    sync::Notify,
};
use ts_rs::TS;

/// The CEF version the `cef` crate in Cargo.toml binds. Framework and
/// bindings have to agree, so bumping the crate means re-pinning [`ARM64`]
/// and [`X64`] below from `cef-builds.spotifycdn.com/index.json` as well.
pub const VERSION: &str = "151.3.24";
const BUILD: &str = "151.3.24+g2384915+chromium-151.0.7922.174";
const CDN: &str = "https://cef-builds.spotifycdn.com";
pub const FRAMEWORK: &str = "Chromium Embedded Framework.framework";
const LIBRARY: &str = "Chromium Embedded Framework";

/// One minimal tarball per architecture. Size and hash are of the file as
/// downloaded and checked by hand; the CDN publishes only a sha1.
struct Tarball {
    platform: &'static str,
    size: u64,
    sha256: &'static str,
}

const ARM64: Tarball = Tarball {
    platform: "macosarm64",
    size: 130_984_661,
    sha256: "3557fa980ce83103ec488dd2e5cc6cc51d2b890718c41005b3ef15ca5944a811",
};

const X64: Tarball = Tarball {
    platform: "macosx64",
    size: 136_754_636,
    sha256: "7663a7e92f1d77d04e699ccf4d8a429e5498ba7a7202d22feed274831b18b2e9",
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

/// `~/.dray/cef/`, holding one version directory at a time.
fn cef_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".dray/cef")
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
            format!("Chromium is still downloading ({}%)", percent(received, total))
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

fn percent(received: u64, total: u64) -> u64 {
    if total == 0 {
        0
    } else {
        received * 100 / total
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

/// Fetches now, or wakes a loop already waiting out a failure.
pub fn download_now(app: AppHandle) {
    tauri::async_runtime::spawn(run(app));
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

    set(app, ChromiumStatus::Downloading { received: 0, total: tarball.size });
    if let Err(e) = stream_to(app, tarball, &part).await {
        let _ = fs::remove_file(&part).await;
        return Err(e);
    }

    set(app, ChromiumStatus::Extracting);
    let stage = dir.join(format!("{VERSION}.part"));
    let _ = fs::remove_dir_all(&stage).await;
    fs::create_dir_all(&stage).await?;
    // bsdtar, which every Mac has, reads bzip2 itself. Only the framework is
    // taken: the rest of the archive is the SDK the build already used.
    let out = tokio::process::Command::new("/usr/bin/tar")
        .arg("-xjf")
        .arg(&part)
        .arg("-C")
        .arg(&stage)
        .arg("--strip-components=2")
        .arg(format!("{}/Release/{FRAMEWORK}", tarball.root()))
        .output()
        .await
        .context("could not run tar")?;
    let _ = fs::remove_file(&part).await;
    if !out.status.success() {
        bail!("could not unpack the archive: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
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

async fn stream_to(app: &AppHandle, tarball: &Tarball, part: &Path) -> Result<()> {
    let response = reqwest::get(tarball.url())
        .await
        .context("could not reach the CEF download server")?;
    if !response.status().is_success() {
        bail!("download failed with status {}", response.status());
    }

    let file = fs::File::create(part).await.context("could not open the download file")?;
    let mut writer = BufWriter::new(file);
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_emit = 0u64;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("the download was interrupted")?;
        hasher.update(&chunk);
        writer.write_all(&chunk).await.context("could not write to disk")?;
        received += chunk.len() as u64;
        if received - last_emit >= 4 << 20 {
            last_emit = received;
            set(app, ChromiumStatus::Downloading { received, total: tarball.size });
        }
    }
    writer.flush().await?;

    if received != tarball.size {
        bail!("downloaded {received} bytes where {} were expected", tarball.size);
    }
    let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest != tarball.sha256 {
        bail!("the download does not match its published checksum");
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

#[tauri::command]
pub fn chromium_download(app: AppHandle) {
    download_now(app);
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
    #[test]
    fn tarball_names_match_the_cdn_index() {
        assert_eq!(
            ARM64.name(),
            "cef_binary_151.3.24+g2384915+chromium-151.0.7922.174_macosarm64_minimal.tar.bz2"
        );
        assert_eq!(
            X64.name(),
            "cef_binary_151.3.24+g2384915+chromium-151.0.7922.174_macosx64_minimal.tar.bz2"
        );
        assert!(ARM64.url().starts_with("https://cef-builds.spotifycdn.com/cef_binary_151.3.24%2B"));
        assert!(!ARM64.url().contains('+'));
    }

    #[test]
    fn version_is_the_crate_build_prefix() {
        assert!(BUILD.starts_with(VERSION));
        assert!(version_dir().ends_with("cef/151.3.24"));
    }

    #[test]
    fn hashes_are_sha256_hex() {
        for t in [&ARM64, &X64] {
            assert_eq!(t.sha256.len(), 64);
            assert!(t.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn a_percent_of_nothing_is_zero() {
        assert_eq!(percent(5, 0), 0);
        assert_eq!(percent(50, 200), 25);
    }
}
