//! Who the app on this machine is signed in to drayhq.com as (#874, #1277).
//!
//! Sign in happens in the browser. [`start`] makes a PKCE pair and a state
//! and hands back drayhq.com's `/api/app/authorize` address, with the reader's
//! pick of GitHub, Google or email; once they sign in there, the site sends
//! the browser straight back to this server's own `/auth/callback` with a
//! one-time code ([`callback`]). Trading that code, with the verifier only
//! this server holds, brings two credentials: the app's, good for asking who
//! you are and nothing else, and the machine's own link to the account's org
//! ([`crate::org_link::adopt`]). The server keeps them rather than the app,
//! and Sign out forgets the app's alone.

use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use ts_rs::TS;

use crate::{sink::Sink, store};

pub const CHANGED: &str = "account_changed";
const RECHECK: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(5);
/// How long a browser sign-in may take before the app calls it timed out.
const SIGN_IN_LIFE: Duration = Duration::from_secs(10 * 60);

/// The account, as the site describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct DrayUser {
    pub id: String,
    pub name: String,
    /// Absent from a site older than the account card, and from an
    /// `account.json` it wrote.
    #[serde(default)]
    pub email: Option<String>,
    pub username: Option<String>,
    /// The Google or GitHub picture, where the account has one.
    pub image: Option<String>,
}

/// How the reader chose to sign in, passed through to the site.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "lowercase")]
pub enum SignInMethod {
    Github,
    Google,
    Email,
}

impl SignInMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Google => "google",
            Self::Email => "email",
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct DrayAccountState {
    pub user: Option<DrayUser>,
    /// A browser sign-in started and not yet back.
    pub signing_in: Option<SignInMethod>,
    /// The browser is back and its code is being traded: too late to cancel,
    /// since the trade re-keys this machine's link on the site.
    pub finishing: bool,
    /// Why the last sign-in ended without signing in: `cancelled`,
    /// `timed_out`, `offline`, or a sentence for anything else.
    pub error: Option<String>,
    /// The site has email sign-in turned off (#1298), so the gate fades its
    /// card. False until the site says so, so a site that never answers
    /// takes no way in away.
    pub email_off: bool,
}

/// What [`start`] answers: the page the app opens in the browser.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SignInStarted {
    pub url: String,
}

/// What `<home>/account.json` holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Held {
    pub token: String,
    pub site: String,
    pub user: DrayUser,
}

#[derive(Clone)]
struct Pending {
    state: String,
    verifier: String,
    method: SignInMethod,
    site: String,
    /// Tells the timeout it has been replaced or finished.
    generation: u64,
    /// The browser came back and the code is being traded. Neither Cancel
    /// nor a new sign-in may replace it then: the site has re-keyed this
    /// machine's link by the time it answers, so dropping the answer would
    /// strand the link, and a second trade would race the first.
    finishing: bool,
}

#[derive(Default)]
struct Memory {
    pending: Option<Pending>,
    generation: u64,
    error: Option<String>,
}

static MEMORY: Mutex<Memory> = Mutex::new(Memory { pending: None, generation: 0, error: None });
static CHECKED: Mutex<Option<Instant>> = Mutex::new(None);
/// What `/api/app/sign-in-methods` last said about email, and when it was asked.
static EMAIL: Mutex<(Option<bool>, Option<Instant>)> = Mutex::new((None, None));
/// Held across a read-change-write of the file.
static FILE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The port this server's own listener is on, which the browser comes back to.
static PORT: OnceLock<u16> = OnceLock::new();

fn memory() -> std::sync::MutexGuard<'static, Memory> {
    MEMORY.lock().unwrap_or_else(|e| e.into_inner())
}

fn checked() -> std::sync::MutexGuard<'static, Option<Instant>> {
    CHECKED.lock().unwrap_or_else(|e| e.into_inner())
}

fn email() -> std::sync::MutexGuard<'static, (Option<bool>, Option<Instant>)> {
    EMAIL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Told by the server once it has bound its listener.
pub fn listening_on(port: u16) {
    let _ = PORT.set(port);
}

async fn path() -> Result<std::path::PathBuf, String> {
    Ok(store::get_home_app_dir().await.map_err(|e| format!("{e:#}"))?.join("account.json"))
}

async fn read() -> Option<Held> {
    serde_json::from_slice(&tokio::fs::read(path().await.ok()?).await.ok()?).ok()
}

async fn write(held: Option<&Held>) -> Result<(), String> {
    let path = path().await?;
    match held {
        Some(held) => {
            let bytes = serde_json::to_vec_pretty(held).map_err(|e| e.to_string())?;
            store::write_private_atomic(&path, &bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
        }
        None => match tokio::fs::remove_file(&path).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("could not remove {}: {e}", path.display())),
            _ => Ok(()),
        },
    }
}

/// Reads the `account` a sign-in's answer carries.
fn from_claim(body: &Value, site: &str) -> Option<Held> {
    Some(Held {
        token: body["account"]["token"].as_str()?.into(),
        site: site.into(),
        user: serde_json::from_value(body["account"]["user"].clone()).ok()?,
    })
}

/// Keeps a fresh sign-in, replacing whoever was signed in before. The old
/// credential is revoked so the site lists one app per sign-in.
async fn save(sink: &Sink, held: Held) -> Result<(), String> {
    let _file = FILE.lock().await;
    if let Some(old) = read().await.filter(|old| old.token != held.token) {
        revoke(&old).await;
    }
    write(Some(&held)).await?;
    *checked() = Some(Instant::now());
    let _ = sink.emit(CHANGED, ());
    Ok(())
}

/// Who the app is signed in as, and how a sign-in in flight stands. Answers
/// from the file at once, since the app shows nothing until it hears, and at
/// most once a minute starts a check with the site behind it: a renamed
/// account shows up and a revoked credential (a 401) is forgotten, both
/// through [`CHANGED`]. An unreachable site leaves what is held as it was, so
/// a sign-in made before keeps working offline.
pub async fn state(sink: &Sink) -> DrayAccountState {
    let held = {
        let _file = FILE.lock().await;
        read().await
    };
    if held.is_some() {
        let mut checked = checked();
        if !checked.is_some_and(|at| at.elapsed() < RECHECK) {
            *checked = Some(Instant::now());
            tokio::spawn(recheck(sink.clone()));
        }
    } else {
        // Only the gate draws the methods, and it is up only while signed out.
        let mut email = email();
        if !email.1.is_some_and(|at| at.elapsed() < RECHECK) {
            email.1 = Some(Instant::now());
            tokio::spawn(check_methods(sink.clone()));
        }
    }
    let email_off = email().0 == Some(false);
    let memory = memory();
    DrayAccountState {
        user: held.map(|h| h.user),
        signing_in: memory.pending.as_ref().map(|p| p.method),
        finishing: memory.pending.as_ref().is_some_and(|p| p.finishing),
        error: memory.error.clone(),
        email_off,
    }
}

/// Asks the site which ways in are open, so its `EMAIL_SIGN_IN` switch
/// reaches a released app. Any failure keeps the last answer.
async fn check_methods(sink: Sink) {
    let site = crate::org_link::site();
    let Ok(answer) = crate::http().get(format!("{site}/api/app/sign-in-methods")).timeout(TIMEOUT).send().await else {
        return;
    };
    if !answer.status().is_success() {
        return;
    }
    let Ok(body) = answer.json::<Value>().await else { return };
    let Some(open) = body["email"].as_bool() else { return };
    let changed = email().0.replace(open) != Some(open);
    if changed {
        let _ = sink.emit(CHANGED, ());
    }
}

async fn recheck(sink: Sink) {
    let Some(held) = ({
        let _file = FILE.lock().await;
        read().await
    }) else {
        return;
    };
    let Ok(answer) =
        crate::http().get(format!("{}/api/app/me", held.site)).bearer_auth(&held.token).timeout(TIMEOUT).send().await
    else {
        return;
    };
    let _file = FILE.lock().await;
    // A sign-in or sign-out while the check was out wins over its answer.
    let Some(mut now_held) = read().await.filter(|h| h.token == held.token) else { return };
    if answer.status() == reqwest::StatusCode::UNAUTHORIZED {
        if write(None).await.is_ok() {
            let _ = sink.emit(CHANGED, ());
        } else {
            *checked() = None;
        }
        return;
    }
    let Ok(body) = answer.json::<Value>().await else { return };
    let Ok(user) = serde_json::from_value::<DrayUser>(body["user"].clone()) else { return };
    if user != now_held.user {
        now_held.user = user;
        if write(Some(&now_held)).await.is_ok() {
            let _ = sink.emit(CHANGED, ());
        }
    }
}

/// Whether drayhq.com answers at all. Any answer counts, a 401 included:
/// the question is the network, not the credential.
pub async fn reachable() -> bool {
    let site = crate::org_link::site();
    crate::http().get(format!("{site}/api/app/me")).timeout(TIMEOUT).send().await.is_ok()
}

fn random() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Starts a browser sign-in with `method`, replacing any still waiting on
/// the browser, and answers the page to open. An unreachable site ends it at
/// once as `offline`, so the reader isn't sent to a browser that can't load.
pub async fn start(sink: Sink, method: SignInMethod) -> Result<SignInStarted, String> {
    if finishing() {
        return Err("A sign-in is finishing.".into());
    }
    let port = *PORT.get().ok_or("This server can't take a sign-in.")?;
    let site = crate::org_link::site();
    if !reachable().await {
        {
            let mut memory = memory();
            memory.pending = None;
            memory.error = Some("offline".into());
        }
        let _ = sink.emit(CHANGED, ());
        return Err("offline".into());
    }
    let (state, verifier) = (random(), random());
    let challenge =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("provider", method.as_str())
        .append_pair("state", &state)
        .append_pair("challenge", &challenge)
        .append_pair("redirect", &format!("http://127.0.0.1:{port}/auth/callback"))
        .append_pair("name", &dray_proto::machine_name())
        .finish();
    let url = format!("{site}/api/app/authorize?{query}");
    let generation = {
        let mut memory = memory();
        memory.generation += 1;
        memory.error = None;
        memory.pending =
            Some(Pending { state, verifier, method, site, generation: memory.generation, finishing: false });
        memory.generation
    };
    let timer = sink.clone();
    tokio::spawn(async move {
        tokio::time::sleep(SIGN_IN_LIFE).await;
        let ended = {
            let mut memory = memory();
            let ours = memory.pending.as_ref().is_some_and(|p| p.generation == generation && !p.finishing);
            if ours {
                memory.pending = None;
                memory.error = Some("timed_out".into());
            }
            ours
        };
        if ended {
            let _ = timer.emit(CHANGED, ());
        }
    });
    let _ = sink.emit(CHANGED, ());
    Ok(SignInStarted { url })
}

/// Stops waiting on the browser. A code it sends back later finds nothing
/// to match and is turned away. Too late once the code is being traded,
/// which the gate says by offering no Cancel then.
pub async fn cancel(sink: Sink) {
    {
        let mut memory = memory();
        if memory.pending.as_ref().is_some_and(|p| p.finishing) {
            return;
        }
        memory.pending = None;
        memory.error = None;
    }
    let _ = sink.emit(CHANGED, ());
}

fn finishing() -> bool {
    memory().pending.as_ref().is_some_and(|p| p.finishing)
}

/// `GET /auth/callback?code=…&state=…`, or `?error=…&state=…`: the browser
/// coming back from drayhq.com. Answers the page the browser shows, which is
/// all the reader sees of it; the app hears through [`CHANGED`].
pub async fn callback(sink: &Sink, query: &str) -> (u16, String) {
    let (mut code, mut state, mut error) = (None, None, None);
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match &*key {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    // Marked, not read: a second visit to the same address finds it
    // finishing and is turned away, and so are Cancel and a new start.
    let pending = {
        let mut memory = memory();
        match memory.pending.as_mut() {
            Some(p) if !p.finishing && state.as_deref() == Some(p.state.as_str()) => {
                p.finishing = true;
                Some(p.clone())
            }
            _ => None,
        }
    };
    let Some(pending) = pending else {
        return (400, page("This sign-in has ended", "Go back to Dray and start again.", true));
    };
    let _ = sink.emit(CHANGED, ());
    let finished = match (error, code) {
        (Some(_), _) => Err("cancelled".to_string()),
        (None, Some(code)) => finish(sink, &pending, &code).await,
        (None, None) => Err("The site sent no code.".to_string()),
    };
    let reply = match &finished {
        Ok(()) => (200, page("You're signed in", "You can close this tab and go back to Dray.", false)),
        Err(why) if why == "cancelled" => (200, page("Sign-in was cancelled", "Go back to Dray to try again.", true)),
        Err(why) => (502, page("Couldn't finish signing in", why, true)),
    };
    {
        let mut memory = memory();
        memory.pending = None;
        memory.error = finished.err();
    }
    let _ = sink.emit(CHANGED, ());
    reply
}

async fn finish(sink: &Sink, pending: &Pending, code: &str) -> Result<(), String> {
    let site = &pending.site;
    let held = crate::org_link::held_token(site).await;
    let answer = crate::http()
        .post(format!("{site}/api/app/token"))
        .json(&json!({ "code": code, "verifier": pending.verifier, "held": held }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {site}: {e}"))?;
    let ok = answer.status().is_success();
    let body: Value = answer.json().await.map_err(|e| format!("{site} answered oddly: {e}"))?;
    if !ok {
        return Err(format!("{site} refused the sign-in: {}", body["error"].as_str().unwrap_or("no reason given")));
    }
    let account = from_claim(&body, site).ok_or_else(|| format!("{site} sent a sign-in this server can't read."))?;
    crate::org_link::adopt(sink, &body, site).await?;
    save(sink, account).await
}

/// The page the browser lands on, drawn like the gate and drayhq.com's
/// sign-in pages: what happened as the mono label (red when it went wrong),
/// what to do next as the heading, the striped tiles along the bottom.
fn page(label: &str, heading: &str, danger: bool) -> String {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let tiles: String = TILES
        .iter()
        .flat_map(|(fill, list)| {
            list.split(',').map(move |p| {
                let (x, y) = p.split_once(' ').unwrap_or(("0", "0"));
                format!("<rect x='{x}' y='{y}' width='60' height='60' fill='{fill}'/><rect x='{x}' y='{y}' width='60' height='60' fill='url(#s)'/>")
            })
        })
        .collect();
    format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>{l}</title>\
         <style>@media (min-width:1024px){{main{{padding-left:126px!important}}}}</style>\
         <body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;\
         background:#000;color:#fff;font-family:Inter,-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased\">\
         <svg width=1440 height=300 viewBox='0 0 1440 300' style='position:fixed;bottom:0;left:50%;transform:translateX(-50%)' aria-hidden=true>\
         <defs><pattern id=s width=6 height=60 patternUnits=userSpaceOnUse><rect width=2 height=60 fill='#00000080'/></pattern></defs>{tiles}</svg>\
         <main style=\"position:relative;width:100%;max-width:960px;padding:0 24px 200px;box-sizing:border-box\">\
         <p style=\"display:flex;align-items:center;gap:8px;margin:0;font:11px/14px ui-monospace,SFMono-Regular,Menlo,monospace;\
         letter-spacing:.06em;text-transform:uppercase;color:{c}\">\
         <svg width=11 height=14 viewBox='0 0 159 200' aria-hidden=true><path fill=currentColor d='{MARK}'/></svg>{l}</p>\
         <h1 style=\"margin:14px 0 0;font-size:36px;line-height:40px;font-weight:300;letter-spacing:-.03em\">{h}</h1></main>",
        l = escape(label),
        h = escape(heading),
        c = if danger { "#FF6467" } else { "#ffffff80" },
    )
}

const MARK: &str = "M101.004 0C104.603 0 107.52 2.926 107.52 6.536V18.301C107.52 36.349 122.108 50.98 140.102 50.98H152.484C156.083 50.98 159 53.907 159 57.516V142.484C159 146.093 156.083 149.02 152.484 149.02H140.102C122.108 149.02 107.52 163.651 107.52 181.699V193.464C107.52 197.074 104.603 200 101.004 200H0.326C0.146 200 0 199.854 0 199.673V134.967C0 134.787 0.146 134.641 0.326 134.641H61.254C79.249 134.641 93.836 120.009 93.836 101.961V98.039C93.836 79.991 79.249 65.36 61.254 65.36H0.326C0.146 65.36 0 65.213 0 65.033V0.327C0 0.146 0.146 0 0.326 0H101.004Z";

/// The gate's tiles, by fill, as `x y` corners on a 60px grid.
const TILES: [(&str, &str); 4] = [
    ("#121212", "0 180,60 60,180 240,300 180,420 240,480 180,660 180,720 120,960 120,1020 180,1020 240,1080 240,1140 120,1140 240,1200 240,1260 120"),
    ("#0C0C0C", "0 240,120 240,180 120,180 180,240 180,300 120,420 180,540 180,540 240,660 120,660 240,720 240,780 240,840 120,900 120,960 180,1260 240,1380 240"),
    ("#181818", "60 180,60 240,240 240,300 240,360 60,360 240,600 180,600 240,840 180,840 240,900 240,1140 180,1260 60,1320 240"),
    ("#1F1F1F", "480 240,960 240,1260 180"),
];

/// Asks the site to revoke a credential. True once it holds none.
async fn revoke(held: &Held) -> bool {
    let answer =
        crate::http().delete(format!("{}/api/app/me", held.site)).bearer_auth(&held.token).timeout(TIMEOUT).send().await;
    answer.is_ok_and(|a| a.status().is_success() || a.status() == reqwest::StatusCode::UNAUTHORIZED)
}

/// Sign out: forgets who the app is signed in as and revokes the credential.
/// The machine stays linked. A site that can't be reached is no reason to
/// stay signed in; its credential then lingers on the site, good for
/// nothing but reading a name.
pub async fn sign_out(sink: Sink) -> Result<(), String> {
    let _file = FILE.lock().await;
    let Some(held) = read().await else { return Ok(()) };
    revoke(&held).await;
    write(None).await?;
    let _ = sink.emit(CHANGED, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_account_a_sign_in_brings() {
        let body = json!({
            "token": "drs_x",
            "account": { "token": "dra_y", "user": { "id": "u1", "name": "Sam", "email": "sam@example.com", "username": "sam", "image": null } },
        });
        let held = from_claim(&body, "https://drayhq.com").unwrap();
        assert_eq!(held.token, "dra_y");
        assert_eq!(held.user.username.as_deref(), Some("sam"));
        assert_eq!(held.user.email.as_deref(), Some("sam@example.com"));
        assert!(from_claim(&json!({ "token": "drs_x" }), "s").is_none());
    }

    #[test]
    fn the_landing_page_escapes_what_it_shows() {
        assert!(page("a", "<script>", true).contains("&lt;script&gt;"));
    }

    #[tokio::test]
    async fn a_callback_with_no_matching_state_is_turned_away() {
        let sink = Sink::new(|_, _| {});
        let (status, body) = callback(&sink, "code=c&state=nobody").await;
        assert_eq!(status, 400);
        assert!(body.contains("This sign-in has ended"));
    }

    #[tokio::test]
    async fn a_sign_in_being_traded_survives_cancel_start_and_a_second_visit() {
        let sink = Sink::new(|_, _| {});
        memory().pending = Some(Pending {
            state: "traded".into(),
            verifier: "v".into(),
            method: SignInMethod::Email,
            site: "http://site.invalid".into(),
            generation: 0,
            finishing: true,
        });
        cancel(sink.clone()).await;
        assert!(finishing());
        assert!(start(sink.clone(), SignInMethod::Github).await.is_err());
        let (status, _) = callback(&sink, "code=c&state=traded").await;
        assert_eq!(status, 400);
        assert!(finishing());
        memory().pending = None;
    }
}
