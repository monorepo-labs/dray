//! Anonymous usage analytics over Aptabase.
//!
//! One event, `app_started`, and that is the whole of it: how many people run
//! Dray, on which version, on which OS. The plugin stamps `appVersion`,
//! `osName`, `osVersion`, `locale`, `engineVersion` and `isDebug` onto every
//! event itself, so the call site carries no properties — everything worth
//! knowing at this scope is already on the envelope, and `isDebug` is what
//! keeps `pnpm tauri dev` runs out of the release numbers.
//!
//! **No persistent identifier is sent.** The client mints a session id that
//! rolls over after four idle hours and writes nothing to disk, so this
//! measures launches rather than people: actives and version adoption are
//! answerable, retention cohorts are not. That is the trade Aptabase makes, and
//! it is why there is no install id in `~/.dray` to go with it.
//!
//! **`app_exited` is deliberately absent.** It buys session duration and
//! nothing else, and it cannot be tracked for free: Tauri dispatches plugin
//! `on_event` handlers *before* the app's own `run` callback, so the plugin's
//! flush-on-exit has already run by the time anything in that callback could
//! enqueue. Sending it would mean a second `flush_events_blocking` on the quit
//! path — `futures::executor::block_on` around a request with a 10s timeout,
//! on the main thread, after the window is gone. Not worth a duration figure.
//!
//! The app key is compiled in from `APTABASE_KEY`. An absent key is the
//! ordinary case rather than a failure: the plugin stays registered and drops
//! every event before it reaches the queue, which is what an unconfigured
//! checkout runs as.

use std::time::Duration;

use tauri::{plugin::TauriPlugin, AppHandle, Runtime};
use tauri_plugin_aptabase::{EventTracker, InitOptions};

/// Set at build time by the release workflow. `option_env!` resolves at compile
/// time, so `build.rs` has to declare the rerun — otherwise a key exported
/// after the first build stays baked in as absent.
const APP_KEY: Option<&str> = option_env!("APTABASE_KEY");

/// The plugin's own default is 60s, which is longer than a good many launches:
/// opening Dray to look at a running session and quitting is well under it, and
/// those runs would then report only through the blocking flush on exit. Short
/// enough that the queue is normally already empty by the time someone quits,
/// and free when it is — the poll returns without a request on an empty queue.
const FLUSH_INTERVAL: Duration = Duration::from_secs(15);

/// Whether this run reports at all — what the settings dialog draws, and not
/// the same as what is on disk whenever [`env_opt_out`] holds.
///
/// Read from disk on every ask rather than held: the plugin decides its own
/// enablement once, at `build` time, from the key alone, which cannot answer a
/// toggle someone flips while the app is running — and a copy held here was
/// one more thing to keep in step with the file. The read is one small file
/// and nothing asks on a hot path.
///
/// The environment wins over the file in one direction only. `DRAY_NO_ANALYTICS`
/// can turn reporting off; it cannot turn it on over a stored `false`.
pub async fn enabled() -> bool {
    !env_opt_out() && crate::settings::read().await.analytics_enabled
}

/// Whether the environment has forced reporting off for this run.
///
/// Read live rather than remembered, and in one place: two call sites reading
/// the same variable is how the flag and the switch drawn from it drift apart.
pub fn env_opt_out() -> bool {
    std::env::var_os("DRAY_NO_ANALYTICS").is_some()
}

/// Reports the launch, once consent has been read. Awaited inside `setup`'s
/// own spawn rather than blocking it — nothing on screen waits for this.
pub async fn start(app: &AppHandle) {
    track(app, "app_started").await;
}

/// The plugin.
///
/// Registered whether or not a key exists: an inert plugin keeps [`track`] an
/// ordinary call rather than an `Option` every call site unwraps, and the
/// managed state the tracking trait reaches for only exists once it is.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_aptabase::Builder::new(APP_KEY.unwrap_or_default())
        .with_options(InitOptions {
            host: None,
            flush_interval: Some(FLUSH_INTERVAL),
        })
        .build()
}

/// Enqueues one event, or drops it if this run opted out.
///
/// Consent is read here, on every call, so a second call site cannot forget to
/// ask — and cannot run ahead of the persisted answer, which would send an
/// opted-out install the one event it opted out of.
///
/// Best-effort throughout, like the notification path next door: analytics that
/// surfaced an error would be worse than analytics that went missing.
pub async fn track(app: &AppHandle, name: &str) {
    if !enabled().await {
        return;
    }

    if let Err(e) = app.track_event(name, None) {
        eprintln!("[analytics err] {e}");
    }
}
