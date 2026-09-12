//! Anonymous usage analytics over PostHog.
//!
//! Three events — a launch, a session starting, and a feature being reached for
//! the first time in a run — carrying no content and no identity beyond a
//! random id minted on this machine. What they answer is how many people run
//! Dray, on which version, whether they come back, and which of the things
//! built here anybody actually uses.
//!
//! **The install id is minted only for an install that is opted in.** Someone
//! who turns this off never has an id written for them at all, because
//! [`track`] asks [`enabled`] before it asks [`install_id`], and turning the
//! switch off again clears the stored id — so opting back in is a new person
//! rather than the old one resurfacing. A uuid v4 rather than the v7 used for
//! session ids elsewhere: v7 embeds the moment it was minted, which for an
//! identifier meant to say nothing is one more thing it says.
//!
//! **No transport plugin.** `reqwest` is already here for Linear, and PostHog's
//! capture API is one POST, so an event is a request rather than a queue with a
//! flush interval. At this volume — single figures per session — batching would
//! buy nothing and cost a background task and a drain on the quit path.
//!
//! **Nothing is stamped for us.** Aptabase's plugin put `appVersion`, `osName`
//! and friends on every envelope itself; PostHog does not, so
//! [`base_properties`] builds that set once. Without it version adoption — the
//! one question the old single-event setup could answer — would be lost.
//!
//! The project key is compiled in from `POSTHOG_KEY`. An absent key is the
//! ordinary case rather than a failure: every local build compiles with none
//! and sends nothing, which is what keeps `pnpm tauri dev` out of the numbers.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::OnceCell;
use uuid::Uuid;

use crate::settings;

/// Set at build time by the release workflow. `option_env!` resolves at compile
/// time, so `build.rs` has to declare the rerun — otherwise a key exported
/// after the first build stays baked in as absent.
const API_KEY: Option<&str> = option_env!("POSTHOG_KEY");

/// Set at build time only if the project moves off US cloud. Wrong host means a
/// key that authenticates nowhere and events that vanish with a 401, so it is
/// worth a knob rather than a constant somebody has to remember to edit.
const HOST_OVERRIDE: Option<&str> = option_env!("POSTHOG_HOST");

const DEFAULT_HOST: &str = "https://us.i.posthog.com";

/// Where events go.
///
/// The empty string is treated as unset, and that is not defensive: the release
/// workflow passes this through from a repository *variable*, which expands to
/// `""` when undefined rather than being absent — so a `Some("")` here is the
/// ordinary case for every build that has not set one, and taking it literally
/// would post every event at a URL with no host in it.
fn host() -> &'static str {
    HOST_OVERRIDE
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_HOST)
}

/// Short. Nothing waits on this, and a request still in flight when the app
/// quits is a dropped event either way — so the only thing a long timeout buys
/// is a task outliving the thing it was reporting about.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Shared, because a `Client` owns the connection pool — the same reason
/// `linear.rs` keeps one.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("Dray/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client")
    })
}

/// Whether this run reports at all — what the settings dialog draws, and not
/// the same as what is on disk whenever [`env_opt_out`] holds.
///
/// Read from disk on every ask rather than held: a copy kept here would be one
/// more thing to keep in step with the file, and the read is one small file
/// that nothing asks for on a hot path.
///
/// The environment wins over the file in one direction only. `DRAY_NO_ANALYTICS`
/// can turn reporting off; it cannot turn it on over a stored `false`.
pub async fn enabled() -> bool {
    !env_opt_out() && settings::read().await.analytics_enabled
}

/// Whether the environment has forced reporting off for this run.
///
/// Read live rather than remembered, and in one place: two call sites reading
/// the same variable is how the flag and the switch drawn from it drift apart.
pub fn env_opt_out() -> bool {
    std::env::var_os("DRAY_NO_ANALYTICS").is_some()
}

/// Enqueues one event, or drops it if this run opted out.
///
/// Deliberately **not** `async` and takes no `AppHandle`: an event is
/// fire-and-forget, and a call that had to be awaited would put a file read and
/// an HTTPS request in front of whatever the reader just did. That is also what
/// lets the sites that report features call this — several are synchronous
/// commands with no handle in reach.
///
/// Consent is read inside the spawned half, on every call, so a new call site
/// cannot forget to ask and cannot run ahead of the persisted answer.
///
/// `event` is `&'static str` because every one is a literal, and taking it by
/// value is what keeps the spawned future `'static` without an allocation.
pub fn track(event: &'static str, properties: Value) {
    tauri::async_runtime::spawn(send(event, properties));
}

/// Reports the launch. Retention is answered by this event alone — one per
/// install per day is all a return visit is — so the other two exist for
/// adoption rather than for this.
pub fn app_started() {
    track("app_started", json!({}));
}

/// Reports a feature being reached for.
///
/// One event carrying the feature as a property, never an event per feature:
/// PostHog breaks a single insight down by property, where a name each is a
/// chart each to keep in step — and a feature added later then shows up in the
/// existing breakdown rather than needing a dashboard change to be visible at
/// all.
///
/// Reported on the feature *working*, not on the control being pressed. A click
/// that errored says nothing about adoption.
pub fn feature_used(feature: &'static str) {
    track("feature_used", json!({ "feature": feature }));
}

/// The body of [`track`], split out so the spawn site stays one line.
///
/// Best-effort throughout, like the notification path next door: analytics that
/// surfaced an error would be worse than analytics that went missing. A
/// non-success status is logged rather than dropped, since the two ways this
/// silently reports nothing — a wrong key and a wrong region — both land there.
async fn send(event: &'static str, properties: Value) {
    let Some(key) = API_KEY.filter(|key| !key.is_empty()) else {
        return;
    };

    if !enabled().await {
        return;
    }

    let Some(distinct_id) = install_id().await else {
        return;
    };

    let mut props = base_properties().clone();
    if let Value::Object(extra) = properties {
        props.extend(extra);
    }

    let body = json!({
        "api_key": key,
        "event": event,
        "distinct_id": distinct_id,
        "properties": props,
    });

    let endpoint = format!("{}/i/v0/e/", host());

    match client().post(&endpoint).json(&body).send().await {
        Ok(response) if !response.status().is_success() => {
            eprintln!("[analytics err] {} from {endpoint}", response.status());
        }
        Err(e) => eprintln!("[analytics err] {e}"),
        Ok(_) => {}
    }
}

/// What every event carries, built once.
///
/// Deliberately short. The OS *version* is absent because nothing in the tree
/// knows it — reading it means a new dependency or spawning `sw_vers` on the
/// launch path, and neither is worth a figure nobody has asked a question of
/// yet. `arch` is free from the same module and does answer one, since Apple
/// Silicon is what decides the transcription backend.
fn base_properties() -> &'static Map<String, Value> {
    static BASE: OnceLock<Map<String, Value>> = OnceLock::new();

    BASE.get_or_init(|| {
        let mut props = Map::new();
        props.insert("app_version".into(), env!("CARGO_PKG_VERSION").into());
        props.insert("os".into(), std::env::consts::OS.into());
        props.insert("arch".into(), std::env::consts::ARCH.into());
        // Only reachable by a debug build compiled *with* a key, which is not
        // how anything ships — but that is exactly the build whose events would
        // otherwise be indistinguishable from a release one's.
        props.insert("is_debug".into(), cfg!(debug_assertions).into());
        props
    })
}

/// This install's id, minted and persisted on first use.
///
/// Read once per process: every event after the first needs no file read, and
/// two events racing at launch cannot mint two ids.
///
/// A failed write still answers with the id it just minted rather than `None` —
/// the launch is better counted under an id that does not survive the process
/// than not counted at all, and the next run simply mints another.
async fn install_id() -> Option<String> {
    static INSTALL_ID: OnceCell<Option<String>> = OnceCell::const_new();

    INSTALL_ID
        .get_or_init(|| async {
            let settings = settings::read().await;
            if settings.install_id.is_some() {
                return settings.install_id;
            }

            let id = Uuid::new_v4().to_string();
            let next = settings::AppSettings {
                install_id: Some(id.clone()),
                ..settings
            };

            if let Err(e) = settings::write(&next).await {
                eprintln!("[analytics err] install id not persisted: {e:#}");
            }

            Some(id)
        })
        .await
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one thing in here worth pinning: an event's own properties reach the
    /// payload, and they win over the base set rather than being dropped by it.
    #[test]
    fn event_properties_override_the_base_set() {
        let mut props = base_properties().clone();
        let Value::Object(extra) = json!({ "harness": "codex", "os": "plan9" }) else {
            unreachable!()
        };
        props.extend(extra);

        assert_eq!(props["harness"], json!("codex"));
        assert_eq!(props["os"], json!("plan9"));
        assert_eq!(props["app_version"], json!(env!("CARGO_PKG_VERSION")));
    }

    /// The release workflow passes the host through from a repository variable,
    /// which expands to `""` rather than nothing when undefined — so the empty
    /// string has to read as unset. Taken literally it would post every event
    /// to `/i/v0/e/` with no host, and the failure is one line in a log nobody
    /// reads.
    #[test]
    fn an_empty_host_override_falls_back() {
        assert_eq!(Some("").filter(|host: &&str| !host.is_empty()), None);
        assert_eq!(
            Some("https://eu.i.posthog.com").filter(|host: &&str| !host.is_empty()),
            Some("https://eu.i.posthog.com")
        );
        assert!(host().starts_with("https://"));
    }
}
