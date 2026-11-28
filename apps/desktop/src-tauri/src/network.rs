//! Whether this machine can reach the internet, so a server that stops
//! answering while the network is down reads as "You're offline" rather than
//! as that server's fault, and every connection retries the moment it is back.
//!
//! The OS says when the network moved ([`crate::netwatch`]) and the webview
//! says when it thinks it is offline, but neither sees a captive portal or a
//! link that is up and carries nothing, so the verdict is always a probe's.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::sink::Sink;

/// Over HTTPS, so a captive portal's own page fails the certificate rather
/// than passing for an answer. Two hosts, so one of them down is not the
/// network down.
const PROBES: [&str; 2] = ["https://drayhq.com/", "https://github.com/"];
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// While offline, how often to look again. The OS's own news cuts it short.
const RECHECK: Duration = Duration::from_secs(2);
/// A server down with the network fine fails every backoff round, and each
/// failure asks again; this caps that at one probe per gap.
const TRUSTED: Duration = Duration::from_secs(30);

static OFFLINE: AtomicBool = AtomicBool::new(false);
static CHECKING: AtomicBool = AtomicBool::new(false);
static LAST_UP: Mutex<Option<Instant>> = Mutex::new(None);
static SINK: OnceLock<Sink> = OnceLock::new();
/// Bumped when the network comes back, which every reconnect loop's backoff
/// waits on beside its timer.
static BACK: LazyLock<watch::Sender<u64>> = LazyLock::new(|| watch::channel(0).0);

/// Starts following the OS's network news. Called once, from `servers::start`.
pub fn start(sink: Sink) {
    if SINK.set(sink).is_err() {
        return;
    }
    let mut changes = crate::netwatch::changes();
    tokio::spawn(async move {
        while changes.recv().await.is_some() {
            check(true);
        }
    });
}

/// Whether the last probe found no network.
pub fn offline() -> bool {
    OFFLINE.load(Ordering::Relaxed)
}

/// Ticks each time the network comes back.
pub fn back() -> watch::Receiver<u64> {
    BACK.subscribe()
}

/// Wakes every reconnect loop waiting out its backoff.
pub fn came_back() {
    BACK.send_modify(|n| *n = n.wrapping_add(1));
}

/// A server stopped answering. Probes, unless one said the network was fine
/// a moment ago.
pub fn suspect() {
    check(false);
}

/// Probes now, and while that fails keeps probing until it passes. `fresh`
/// skips the [`TRUSTED`] gap: the OS or the webview said something moved.
fn check(fresh: bool) {
    if cfg!(test) {
        return;
    }
    let trusted = LAST_UP.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|at| at.elapsed() < TRUSTED);
    if (!fresh && trusted && !offline()) || CHECKING.swap(true, Ordering::AcqRel) {
        return;
    }
    tokio::spawn(async move {
        loop {
            let up = probe().await;
            if up {
                *LAST_UP.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            }
            let was = OFFLINE.swap(!up, Ordering::AcqRel);
            if was == up {
                announce(!up);
            }
            // A move the OS reported can leave a server's socket dead under
            // a network that is fine, so that wakes the loops as well.
            if up && (was || fresh) {
                came_back();
            }
            if up {
                break;
            }
            tokio::time::sleep(RECHECK).await;
        }
        CHECKING.store(false, Ordering::Release);
    });
}

/// Any answer from any probe host is a network.
async fn probe() -> bool {
    let tries = PROBES.map(|url| async move { crate::http().head(url).timeout(PROBE_TIMEOUT).send().await.is_ok() });
    let [a, b] = tries;
    tokio::pin!(a, b);
    tokio::select! {
        up = &mut a => up || b.await,
        up = &mut b => up || a.await,
    }
}

fn announce(offline: bool) {
    if let Some(sink) = SINK.get() {
        let _ = sink.emit("network_changed", offline);
    }
}

/// Whether this machine is offline, as last probed.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn network_offline() -> bool {
    offline()
}

/// The webview's `online`/`offline` events. Offline is taken at its word, since
/// the OS only says so with no route at all; online is probed first.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn network_hint(online: bool) {
    if !online && !OFFLINE.swap(true, Ordering::AcqRel) {
        announce(true);
    }
    check(true);
}
