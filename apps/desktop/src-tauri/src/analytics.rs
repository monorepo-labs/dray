//! Anonymous usage analytics over PostHog.
//!
//! Five events — a launch, a day the app was used, a session starting, a
//! feature being reached for the first time in a run, and something breaking —
//! carrying no content and no identity beyond a random id minted on this
//! machine. What they answer is how many people run Dray, on which version,
//! whether they come back, which of the things built here anybody actually
//! uses, and whether the build is failing under them in a way nothing else
//! would ever tell us.
//!
//! **The install id is minted only for an install that is opted in**, and
//! consent is read in the same hold of the settings lock that mints it —
//! [`settings::ensure_install_id`], which is why it lives over there rather
//! than here. Someone who turns this off never has an id written for them, and
//! turning the switch off clears the stored one, so opting back in is a new
//! person rather than the old one resurfacing. **Nothing caches it in this
//! process**: a cache would have to be invalidated by the settings command,
//! which is a second place for consent to be wrong, and the file read it saves
//! is small and happens a few times a session. A uuid v4 rather than the v7
//! used for session ids elsewhere: v7 embeds the moment it was minted, which
//! for an identifier meant to say nothing is one more thing it says.
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

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use ts_rs::TS;

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

/// What the webview needs to speak to PostHog for itself.
///
/// Handed over whole rather than looked up on the other side, and that is the
/// whole of why this type exists: a frontend reading `analytics_enabled` for
/// itself would be a second reader of consent, free to answer differently from
/// this one — which is the shape DRA-199 was already caught by once. Here the
/// answer to "may I", "as whom" and "where to" is one value, and its absence is
/// the refusal.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SurveyIdentity {
    pub key: String,
    pub host: String,
    /// The install id, so the SDK and this module are one person in PostHog
    /// rather than two. Bootstrapped on the other side, never `identify`d into
    /// existence — a person is already what the POSTs create.
    pub distinct_id: String,
    /// [`base_properties`], to be `$set` as **person** properties on the other
    /// side. Event properties are what this module sends and what surveys
    /// cannot target on, so without this the SDK arrives and the reason for
    /// wanting it — targeting a survey at a version or an OS — still does not
    /// work.
    #[ts(type = "Record<string, string | number | boolean>")]
    pub person_properties: Map<String, Value>,
}

/// Who the webview may report as, or `None` where it may not report at all.
///
/// The SDK on the other side exists for **surveys**, which are drawn by
/// `posthog-js` and by nothing else — there is no way to render one from here.
/// It captures no events of its own, so this is less a second analytics client
/// than a second surface of the same consent, and consent is still read in one
/// place: [`settings::ensure_install_id`] answers `None` for an install that
/// opted out, and that `None` is what stops the SDK ever being initialised.
pub async fn identity() -> Option<SurveyIdentity> {
    // Same order as `send`: no key compiled in is the ordinary case for a local
    // build, and checking it first keeps a build that sends nothing from
    // reading the settings file to find that out.
    let key = API_KEY.filter(|key| !key.is_empty())?;

    if env_opt_out() {
        return None;
    }

    let mut person_properties = base_properties().clone();

    // How many sessions this install has ever held, so a survey can be aimed at
    // somebody who has used Dray enough to have an opinion of it. PostHog has
    // no other way to know — nothing it receives counts sessions, and the index
    // is the only place the answer lives.
    //
    // Added here rather than folded into `base_properties`, which is a
    // `OnceLock` answering once for the life of the process where this moves
    // every time a session is made. A failed read leaves the property absent,
    // which a survey targeting a minimum reads as **not** matching — the safe
    // direction, since the cure is opening the app again.
    if let Ok(sessions) = crate::store::read_index().await {
        person_properties.insert("session_count".into(), sessions.len().into());
    }

    Some(SurveyIdentity {
        key: key.to_string(),
        host: host().to_string(),
        distinct_id: settings::ensure_install_id().await?,
        person_properties,
    })
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
    tauri::async_runtime::spawn(send(event, None, properties));
}

/// Reports the launch. What it uniquely answers is which build is in the wild:
/// this app gets left open for days, so launches undercount *use* badly and
/// [`active_day`] is what measures that.
pub fn app_started() {
    track("app_started", json!({}));
}

/// Reports `event` at most once per local day per `key`, for the life of this
/// process.
///
/// **Deliberately not persisted, and that is the whole design.** PostHog counts
/// distinct people per day, so an install reporting the same event three times
/// in one day still reads as one active user — a restart re-reporting costs one
/// event and moves no number, where remembering the date across runs would cost
/// a file, a lock and a corruption path on the launch path to prevent nothing.
///
/// **The day is claimed only once consent has answered**, inside [`send`] and
/// after the opt-out is read — never here, where the spawn happens. Claiming up
/// front looked equivalent and is the bug [`settings::ensure_install_id`] was
/// written to stop, one layer up: an install that launched opted *out* would
/// claim the day, send nothing, and then be silenced for the rest of that day
/// by its own claim if the reader turned reporting back on. Process state that
/// consent has to remember to clear is a second place for consent to be wrong;
/// claiming after it is asked leaves nothing to clear.
///
/// Known wrinkle, not worth solving: "day" is the machine's local date, which
/// disagrees with PostHog's project timezone at the edges for anyone outside
/// it.
pub fn track_daily(event: &'static str, key: String, properties: Value) {
    tauri::async_runtime::spawn(send(event, Some(key), properties));
}

/// Whether `key` still owes a report for `day`, marking it reported if so.
///
/// Split out so the throttle can be tested without a clock or a request, and so
/// the lock is visibly released before anything is sent. Atomic under that
/// lock, which is what stops two events landing together from both claiming.
fn claim_day(key: String, day: String) -> bool {
    static REPORTED: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

    // Recovered rather than unwrapped: a poisoned lock is not a reason to take
    // the app down over an event nobody is waiting on.
    let mut reported = REPORTED.lock().unwrap_or_else(|e| e.into_inner());
    if reported.get(&key).is_some_and(|last| *last == day) {
        return false;
    }
    reported.insert(key, day);

    true
}

/// Reports that this install was used today, at most once a day per run.
///
/// Neither event beside it answers activity. [`app_started`] measures installs
/// and version adoption, since this app is left open for days at a time, and
/// `session_started` fires only for a session being *created* — so somebody
/// working all day in one resumed session was invisible, and the most engaged
/// readers read as churned.
///
/// Three call sites, each covering a hole the others leave. **Launch** is the
/// only one guaranteed to fire: `focus.ts` seeds itself from
/// `document.hasFocus()` and reports changes alone, so a window that comes up
/// already frontmost never reports *gaining* focus and somebody who opens Dray,
/// works and quits without switching apps would go uncounted. **Focus gained**
/// catches coming back to check on a session an agent is running, which reaches
/// no prompt at all and is real use of an app about parallel agents. **The
/// `send_msg` command** covers a reader who leaves the app open and frontmost
/// across a date boundary — the *command*, not `SessionManager::send_msg` one
/// call down, since the orchestration socket reaches that directly to relay a
/// `dray send` and to start a session `dray new` asked for. A Tauri command is
/// reachable from the webview alone, so it needs no gate to mean a person.
///
/// The throttle is what makes a third site free rather than a third event: all
/// three share one key, so whichever gets there first claims the day and the
/// other two are no-ops. It is also why none of them asks what the others did
/// — "report this only if nothing reported today" is exactly what the claim
/// already is.
pub fn active_day() {
    track_daily("active_day", "active_day".into(), json!({}));
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

/// Reports something that broke, by **where** it broke and never by what it
/// said.
///
/// One event with the kind as a property, the bargain [`feature_used`] makes,
/// so a fourth kind later shows up in the existing breakdown rather than
/// needing a dashboard change to be visible at all.
///
/// The rule every call site here has to keep: an error string or a stack frame
/// carries file paths, and a path carries the project, the branch and the
/// client's name. The settings dialog promises prompts, code and conversations
/// are never collected, so `properties` may hold a closed set of tags — a
/// stage, a harness, a `file:line` of our own source — and never a `String`
/// that came out of an error.
pub fn error(kind: &'static str, properties: Value) {
    track("error", error_properties(kind, properties));
}

/// The merge [`error`] sends, split out because it is the one part of that call
/// a test can hold: the kind goes in **last**, so a call site carrying one of
/// its own cannot rename what the breakdown is read by. The opposite of
/// [`track`]'s rule, where a call site correcting a base property is the point.
fn error_properties(kind: &'static str, properties: Value) -> Value {
    let mut props = Map::new();
    if let Value::Object(extra) = properties {
        props.extend(extra);
    }
    props.insert("kind".into(), kind.into());

    Value::Object(props)
}

/// Reports panics by location, and leaves what a panic *does* alone.
///
/// Two closed things go out: `file:line` from the panic's own `Location`, and
/// the thread's name, which is one this app or tokio chose. **The payload never
/// does** — a panic message is arbitrary text, and `expect` is routinely handed
/// a path to explain itself with.
///
/// Chained to the previous hook rather than replacing it, so the default
/// printing and whatever the profile does about aborting are unchanged.
/// Fire-and-forget like every other event: a panic on the main thread takes the
/// process before the request could land, which is a dropped event and not a
/// reason to hold a dying app open.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        error(
            "panic",
            json!({
                "location": info
                    .location()
                    .map(|at| format!("{}:{}", trim_source_path(at.file()), at.line())),
                "thread": std::thread::current().name().map(str::to_string),
            }),
        );

        previous(info);
    }));
}

/// Cuts the build machine out of a panic's source path.
///
/// A `Location` is baked in at compile time, so it names wherever this was
/// built and never the reader's disk — this crate's own code reports
/// `src/session.rs`, but a dependency reports the release runner's home
/// directory on the way to the cargo registry, and the app's own path on a
/// local build. Cargo's `trim-paths` is the proper cure and is not stable on
/// the toolchain the release workflow pins, so the report trims instead: a
/// registry or git checkout keeps the part naming the crate, and anything else
/// still absolute is cut to its file name, since an absolute path arriving here
/// came from a build directory.
fn trim_source_path(file: &str) -> &str {
    for marker in ["/registry/src/", "/git/checkouts/"] {
        if let Some((_, crate_path)) = file.split_once(marker) {
            return crate_path;
        }
    }

    if file.starts_with('/') {
        return file.rsplit('/').next().unwrap_or(file);
    }

    file
}

/// The body of [`track`], split out so the spawn site stays one line.
///
/// Best-effort throughout, like the notification path next door: analytics that
/// surfaced an error would be worse than analytics that went missing. A
/// non-success status is logged rather than dropped, since the two ways this
/// silently reports nothing — a wrong key and a wrong region — both land there.
async fn send(event: &'static str, daily_key: Option<String>, properties: Value) {
    let Some(key) = API_KEY.filter(|key| !key.is_empty()) else {
        return;
    };

    if env_opt_out() {
        return;
    }

    // The consent check *is* this call. `ensure_install_id` reads the stored
    // opt-out and mints under the same hold of the settings lock, so there is
    // no window where consent is read here and acted on a moment later — which
    // is what let an id be minted for an install that had just opted out.
    let Some(distinct_id) = settings::ensure_install_id().await else {
        return;
    };

    // After consent, never before it: a day claimed by a run that was opted out
    // would suppress every later report that run made, including the ones the
    // reader turned back on to get.
    if let Some(daily_key) = daily_key {
        if !claim_day(daily_key, chrono::Local::now().format("%Y-%m-%d").to_string()) {
            return;
        }
    }

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
        // The marketing site reports into this same project under a *cookieless
        // per-visit* id where this one is a stable install uuid, so any
        // unfiltered "unique users" figure is the sum of two incompatible
        // populations. `$lib` half-separates them already — posthog-js sets it
        // and this POST sets nothing — but a dashboard built on a property's
        // *absence* breaks the day something else stops setting one. The one
        // thing here that cannot be added retroactively.
        props.insert("source".into(), "app".into());
        props
    })
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

    /// The kind is what the breakdown is read by, so a call site's own
    /// properties must not be able to rename it.
    #[test]
    fn a_call_site_cannot_rename_the_kind() {
        let props = error_properties("parse_failure", json!({ "kind": "map", "stage": "map" }));

        assert_eq!(props["kind"], json!("parse_failure"));
        assert_eq!(props["stage"], json!("map"));
    }

    /// What the webview `$set`s as person properties, and the whole reason
    /// [`SurveyIdentity`] carries them: a survey targets *persons*, so these
    /// are the only fields a survey can be aimed with. `source` most of all —
    /// it is what tells an app person from a marketing-site one, and the site
    /// reports into the same project. Dropping one of these from
    /// [`base_properties`] costs a targeting option in PostHog's UI and says
    /// nothing at all here, which is what this pins.
    #[test]
    fn the_person_properties_carry_what_a_survey_is_targeted_by() {
        let props = base_properties();

        assert_eq!(props["source"], json!("app"));
        assert_eq!(props["app_version"], json!(env!("CARGO_PKG_VERSION")));
        assert!(props.contains_key("os"));
        assert!(props.contains_key("arch"));
    }

    /// What a panic report may carry. A dependency's path names the machine it
    /// was built on, and a local build's names this checkout — both are cut
    /// back to something that identifies the *code*, which is the whole of what
    /// the report is for.
    #[test]
    fn a_panic_location_names_code_and_not_a_machine() {
        assert_eq!(
            trim_source_path(
                "/Users/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.47.1/src/task.rs"
            ),
            "index.crates.io-1949cf8c6b5b557f/tokio-1.47.1/src/task.rs"
        );
        assert_eq!(trim_source_path("src/session.rs"), "src/session.rs");
        assert_eq!(
            trim_source_path("/Users/yogesh/Documents/ade/apps/desktop/src-tauri/src/lib.rs"),
            "lib.rs"
        );
    }

    /// The throttle itself: a day is claimed once, keys do not throttle each
    /// other, and the next day is a fresh claim. Distinct keys per test, since
    /// the state behind this is process-wide by design.
    #[test]
    fn a_key_reports_once_a_day() {
        assert!(claim_day("first".into(), "2026-09-13".into()));
        assert!(!claim_day("first".into(), "2026-09-13".into()));
        assert!(claim_day("second".into(), "2026-09-13".into()));
        assert!(claim_day("first".into(), "2026-09-14".into()));
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
