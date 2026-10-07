//! Getting Chrome for Testing's `chrome-headless-shell` onto a server, the
//! first time an agent asks for a browser. The Mac's `chromium.rs` reading
//! without the app: zip to `.part`, size and sha256 checked, unpacked into a
//! `.part` directory, renamed into place, older versions swept. Nothing
//! reports progress but the sentence `dray browser` answers meanwhile.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::{fs, sync::Notify};

/// Chrome for Testing's version. Every hash below is of that version's zip as
/// downloaded and checked by hand; Google publishes md5 and crc32c only.
pub const VERSION: &str = "155.0.8059.39";
const CDN: &str = "https://storage.googleapis.com/chrome-for-testing-public";

struct Zip {
    platform: &'static str,
    size: u64,
    sha256: &'static str,
}

const LINUX_X64: Zip = Zip {
    platform: "linux64",
    size: 124_203_329,
    sha256: "39dcb8c46550632a3d911850ab3b8af840b4e3f6d8622faa2018eb8756278786",
};
const LINUX_ARM64: Zip = Zip {
    platform: "linux-arm64",
    size: 124_553_121,
    sha256: "9fb86f7c0b2734c5febc0bbb4e85f37da43553f3f8a7970949828c5713e87e94",
};
const MAC_ARM64: Zip = Zip {
    platform: "mac-arm64",
    size: 102_429_510,
    sha256: "b3e093c06001c41e68decbc8dd4a62f9efe4bf4e4dd247a686ea531863448d75",
};
const MAC_X64: Zip = Zip {
    platform: "mac-x64",
    size: 107_758_350,
    sha256: "6338a784c691f42dd1ed6aeeef650171c7d72cf74bdb8450d0079864e72a8074",
};

fn zip() -> Option<&'static Zip> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some(&LINUX_X64),
        ("linux", "aarch64") => Some(&LINUX_ARM64),
        ("macos", "aarch64") => Some(&MAC_ARM64),
        ("macos", "x86_64") => Some(&MAC_X64),
        _ => None,
    }
}

impl Zip {
    /// The archive's top-level directory, which is also its file stem.
    fn root(&self) -> String {
        format!("chrome-headless-shell-{}", self.platform)
    }

    fn url(&self) -> String {
        format!("{CDN}/{VERSION}/{}/{}.zip", self.platform, self.root())
    }
}

enum Status {
    Absent,
    Downloading { received: u64, total: u64 },
    Extracting,
    Ready,
    Failed(String),
}

static STATUS: Mutex<Status> = Mutex::new(Status::Absent);
/// One download loop at a time; a second request wakes the one in backoff.
static RUNNING: AtomicBool = AtomicBool::new(false);
static WAKE: Notify = Notify::const_new();

fn set(status: Status) {
    *STATUS.lock().unwrap() = status;
}

/// `<home>/chromium`, under `DRAY_HOME` where that is set.
async fn dir() -> Result<PathBuf> {
    Ok(crate::store::get_home_app_dir().await?.join("chromium"))
}

fn binary_in(version_dir: &Path, zip: &Zip) -> PathBuf {
    version_dir.join(zip.root()).join("chrome-headless-shell")
}

/// The binary, if it is on disk; otherwise a download is started (or a
/// failed one woken) and the answer is the sentence the agent reads.
pub async fn binary() -> Result<PathBuf, String> {
    let zip = zip().ok_or_else(|| {
        format!(
            "there is no headless Chromium for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let dir = dir().await.map_err(|e| format!("{e:#}"))?;
    let binary = binary_in(&dir.join(VERSION), zip);
    if binary.is_file() {
        return Ok(binary);
    }
    if !matches!(*STATUS.lock().unwrap(), Status::Downloading { .. } | Status::Extracting) {
        set(Status::Downloading { received: 0, total: zip.size });
        crate::spawn(run(dir, zip));
    }
    Err(not_ready_reason())
}

/// Why a tab cannot open yet, in the Mac's words where they apply.
fn not_ready_reason() -> String {
    match &*STATUS.lock().unwrap() {
        Status::Downloading { received, total } => {
            format!("Chromium is still downloading ({}%)", (received * 100).checked_div(*total).unwrap_or(0))
        }
        Status::Extracting => "Chromium is still downloading (unpacking)".into(),
        Status::Failed(message) => {
            format!("Chromium could not be downloaded: {message}. Trying again; ask in a minute.")
        }
        Status::Absent | Status::Ready => "Chromium is still downloading (0%)".into(),
    }
}

/// Download with backoff. Each failure is reported as it happens; the next
/// `dray browser` call wakes the wait rather than starting a second loop.
async fn run(dir: PathBuf, zip: &'static Zip) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        // `notify_one`: a permit is stored if the loop is between publishing
        // the failure and starting to wait.
        WAKE.notify_one();
        return;
    }
    let backoff = [10, 30, 120, 600];
    let mut attempt = 0;
    loop {
        match download(&dir, zip).await {
            Ok(()) => break,
            Err(e) => {
                eprintln!("[headless chromium download err] {e:#}");
                set(Status::Failed(format!("{e:#}")));
                let Some(secs) = backoff.get(attempt) else { break };
                attempt += 1;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(*secs)) => {}
                    _ = WAKE.notified() => {}
                }
                set(Status::Downloading { received: 0, total: zip.size });
            }
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
}

/// Zip to `.part`, verified, unpacked into a `.part` directory, renamed into
/// place. The real path only ever holds a binary that passed every check.
async fn download(dir: &Path, zip: &'static Zip) -> Result<()> {
    fs::create_dir_all(dir).await.with_context(|| format!("could not create {}", dir.display()))?;
    let part = dir.join(format!("{}-{VERSION}.zip.part", zip.root()));
    let total = zip.size;
    let fetched = crate::download::download_verified(
        &zip.url(),
        &part,
        total,
        zip.sha256,
        || false,
        |received| set(Status::Downloading { received, total }),
    )
    .await;
    if let Err(e) = fetched {
        let _ = fs::remove_file(&part).await;
        return Err(e);
    }

    set(Status::Extracting);
    let stage = dir.join(format!("{VERSION}.part"));
    let _ = fs::remove_dir_all(&stage).await;
    let (from, into) = (part.clone(), stage.clone());
    // The `zip` crate rather than `unzip`, which a fresh Ubuntu has not got.
    // It sets each entry's unix mode, so the binary lands executable.
    let unpacked = tokio::task::spawn_blocking(move || -> Result<()> {
        let file = std::fs::File::open(&from)?;
        zip::ZipArchive::new(file)?.extract(&into)?;
        Ok(())
    })
    .await
    .context("unpack task failed")?;
    let _ = fs::remove_file(&part).await;
    unpacked.context("could not unpack the archive")?;
    if !binary_in(&stage, zip).is_file() {
        bail!("the archive did not contain chrome-headless-shell");
    }

    let version_dir = dir.join(VERSION);
    let _ = fs::remove_dir_all(&version_dir).await;
    fs::rename(&stage, &version_dir).await.context("could not move Chromium into place")?;
    sweep(dir).await;
    set(Status::Ready);
    Ok(())
}

/// Everything in `<home>/chromium` but the current version.
async fn sweep(dir: &Path) {
    let Ok(mut entries) = fs::read_dir(dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_name() == VERSION {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_chrome_for_testing_s() {
        assert_eq!(
            LINUX_ARM64.url(),
            "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/linux-arm64/chrome-headless-shell-linux-arm64.zip"
        );
        for z in [&LINUX_X64, &LINUX_ARM64, &MAC_ARM64, &MAC_X64] {
            assert_eq!(z.sha256.len(), 64);
            assert!(z.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }
}
