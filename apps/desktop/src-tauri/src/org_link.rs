//! Linking this server to an org at drayhq.com (#874), by RFC 8628's device
//! flow: the server asks the site for a code, someone approves it at
//! `/link`, and the server's poll is handed a credential of its own, tied to
//! its row on the site and never a copy of anyone's session. Unlinking on the
//! site deletes that row, which is what revokes it.
//!
//! The server runs the flow, not its client, so `dray login`, and the app's
//! sign-in later, start the same one and watch it through [`state`] or
//! [`CHANGED`].

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::{sink::Sink, store};

pub const CHANGED: &str = "org_link_changed";
const SITE: &str = "https://www.drayhq.com";
/// A code still this fresh is handed to a second caller rather than replaced,
/// so `dray login` beside the app's sign-in doesn't kill the code being typed.
const REUSE_MIN: Duration = Duration::from_secs(60);
/// How long a credential is trusted between checks with the site.
const RECHECK: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(10);
/// Shorter: a status read waits on it, holding the file.
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// The org a server is linked to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct LinkedOrg {
    pub id: String,
    pub name: String,
    pub slug: String,
}

/// A code waiting for approval.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct PendingLink {
    /// The approve page with the code filled in.
    pub url: String,
    /// The bare page, for typing the code on another device.
    pub short_url: String,
    /// `ABCD-EFGH`.
    pub code: String,
    pub expires_in_secs: u64,
    /// Started by the app's Sign in, which approving also signs in.
    pub sign_in: bool,
}

/// Where this server stands, as the app and `dray login` read it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct LinkState {
    pub linked: Option<Linked>,
    pub pending: Option<PendingLink>,
    /// Why the last link ended without linking: cancelled, expired, failed.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    /// What the org calls this server.
    pub server_name: String,
    pub org: LinkedOrg,
    /// The site that holds the link, `https://www.drayhq.com` outside testing.
    pub site: String,
}

/// What `<home>/org-link.json` holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Held {
    token: String,
    server_id: String,
    server_name: String,
    org: LinkedOrg,
    /// Where the credential was minted, so a check or an unlink goes there
    /// even if `DRAY_ACCOUNT_URL` has moved since.
    site: String,
}

struct Pending {
    device_code: String,
    shown: PendingLink,
    deadline: Instant,
    /// Tells a poll loop it has been replaced or cancelled.
    generation: u64,
}

#[derive(Default)]
struct Memory {
    pending: Option<Pending>,
    generation: u64,
    error: Option<String>,
    checked: Option<Instant>,
}

static MEMORY: Mutex<Memory> = Mutex::new(Memory { pending: None, generation: 0, error: None, checked: None });
/// Held across a read-change-write of the file.
static FILE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn memory() -> std::sync::MutexGuard<'static, Memory> {
    MEMORY.lock().unwrap_or_else(|e| e.into_inner())
}

/// The site to link with: drayhq.com, or `DRAY_ACCOUNT_URL` for a local one.
fn site() -> String {
    std::env::var("DRAY_ACCOUNT_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| SITE.into()).trim_end_matches('/').into()
}

async fn path() -> Result<std::path::PathBuf, String> {
    Ok(store::get_home_app_dir().await.map_err(|e| format!("{e:#}"))?.join("org-link.json"))
}

/// An unreadable file reads as unlinked: linking again mends it.
async fn read() -> Option<Held> {
    let bytes = tokio::fs::read(path().await.ok()?).await.ok()?;
    serde_json::from_slice(&bytes).ok()
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

fn pending_now() -> Option<PendingLink> {
    let memory = memory();
    memory.pending.as_ref().filter(|p| p.deadline > Instant::now()).map(|p| p.shown.clone())
}

/// Where this server stands. Asking checks the credential with the site, at
/// most once a minute, so an unlink on the Servers page and an org renamed
/// there show up on the next ask; a 401 forgets it. An unreachable site
/// leaves what is held as it was.
pub async fn state(sink: &Sink) -> LinkState {
    let held = recheck(sink).await;
    LinkState {
        linked: held.map(|h| Linked { server_name: h.server_name, org: h.org, site: h.site }),
        pending: pending_now(),
        error: memory().error.clone(),
    }
}

async fn recheck(sink: &Sink) -> Option<Held> {
    let _file = FILE.lock().await;
    let mut held = read().await?;
    // Judged and stamped under the lock, before asking, so callers queued
    // behind one check share it and an unreachable site is tried once a
    // minute, not on every ask.
    {
        let mut memory = memory();
        if memory.checked.is_some_and(|at| at.elapsed() < RECHECK) {
            return Some(held);
        }
        memory.checked = Some(Instant::now());
    }
    let answer = crate::http()
        .get(format!("{}/api/link/server", held.site))
        .bearer_auth(&held.token)
        .timeout(CHECK_TIMEOUT)
        .send()
        .await;
    let Ok(answer) = answer else { return Some(held) };
    if answer.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Unlinked on the site. Kept if a write fails, and checked again.
        if write(None).await.is_ok() {
            let _ = sink.emit(CHANGED, ());
            return None;
        }
        memory().checked = None;
        return Some(held);
    }
    let Ok(now) = answer.json::<Value>().await else { return Some(held) };
    let (Some(name), Ok(org)) =
        (now["server"]["name"].as_str(), serde_json::from_value::<LinkedOrg>(now["org"].clone()))
    else {
        return Some(held);
    };
    if name != held.server_name || org != held.org {
        held.server_name = name.into();
        held.org = org;
        if write(Some(&held)).await.is_ok() {
            let _ = sink.emit(CHANGED, ());
        }
    }
    Some(held)
}

/// Asks the site for a code and polls it until someone approves, cancels or
/// it expires, telling clients through [`CHANGED`] each time it moves. A
/// server already linked sends its credential, so approving moves its row
/// rather than adding a second. `sign_in` is the app's Sign in, whose
/// approval also hands over the app's credential ([`crate::dray_account`]).
pub async fn start(sink: Sink, sign_in: bool) -> Result<PendingLink, String> {
    // Held throughout, so the credential sent is the one on disk when the
    // new flow is published, and a finishing poll can't land in between.
    let _file = FILE.lock().await;
    {
        let memory = memory();
        // Only a code of the same kind: one from `dray login` would link
        // without signing in, and a sign-in's would sign in whoever links.
        let fresh = |p: &&Pending| p.deadline > Instant::now() + REUSE_MIN && p.shown.sign_in == sign_in;
        if let Some(p) = memory.pending.as_ref().filter(fresh) {
            return Ok(p.shown.clone());
        }
    }
    let held = read().await;
    let site = site();
    let mut body = json!({ "name": dray_proto::machine_name() });
    if let Some(held) = held.as_ref().filter(|h| h.site == site) {
        body["token"] = json!(held.token);
    }
    if sign_in {
        body["signIn"] = json!(true);
    }
    let answer = crate::http()
        .post(format!("{site}/api/link"))
        .json(&body)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {site}: {e}"))?;
    let status = answer.status();
    let answer: Value = answer.json().await.map_err(|e| format!("{site} answered oddly: {e}"))?;
    if !status.is_success() {
        let said = answer["error_description"].as_str().or(answer["error"].as_str()).unwrap_or("no reason given");
        return Err(format!("{site} refused: {said}"));
    }
    let text = |key: &str| answer[key].as_str().map(str::to_string).ok_or_else(|| format!("{site} sent no {key}"));
    let shown = PendingLink {
        url: text("verificationUriComplete")?,
        short_url: text("verificationUri")?,
        code: text("userCode")?,
        expires_in_secs: answer["expiresIn"].as_u64().unwrap_or(600),
        sign_in,
    };
    let interval = Duration::from_secs(answer["interval"].as_u64().unwrap_or(3).max(1));
    let generation = {
        let mut memory = memory();
        memory.generation += 1;
        memory.error = None;
        memory.pending = Some(Pending {
            device_code: text("deviceCode")?,
            shown: shown.clone(),
            deadline: Instant::now() + Duration::from_secs(shown.expires_in_secs),
            generation: memory.generation,
        });
        memory.generation
    };
    tokio::spawn(poll(sink.clone(), site, generation, interval));
    let _ = sink.emit(CHANGED, ());
    Ok(shown)
}

/// How one poll of the token endpoint ended.
enum Poll {
    Wait,
    SlowDown,
    /// With the app's credential where the flow was a sign-in.
    Linked(Held, Option<crate::dray_account::Held>),
    Ended(String),
}

async fn poll_once(site: &str, device_code: &str) -> Poll {
    let Ok(answer) = crate::http()
        .post(format!("{site}/api/link/token"))
        .json(&json!({ "deviceCode": device_code }))
        .timeout(TIMEOUT)
        .send()
        .await
    else {
        // The network blinking mid-flow costs a poll, not the link.
        return Poll::Wait;
    };
    let ok = answer.status().is_success();
    let Ok(body) = answer.json::<Value>().await else { return Poll::Wait };
    if ok {
        let held = (|| {
            Some(Held {
                token: body["token"].as_str()?.into(),
                server_id: body["server"]["id"].as_str()?.into(),
                server_name: body["server"]["name"].as_str()?.into(),
                org: serde_json::from_value(body["org"].clone()).ok()?,
                site: site.into(),
            })
        })();
        let account = crate::dray_account::from_claim(&body, site);
        return held.map_or_else(
            || Poll::Ended(format!("{site} sent a credential this server can't read.")),
            |held| Poll::Linked(held, account),
        );
    }
    match body["error"].as_str() {
        Some("authorization_pending") => Poll::Wait,
        Some("slow_down") => Poll::SlowDown,
        Some("access_denied") => Poll::Ended("Cancelled on drayhq.com.".into()),
        Some("expired_token") => Poll::Ended("The code expired before anyone approved it.".into()),
        _ => Poll::Wait,
    }
}

async fn poll(sink: Sink, site: String, generation: u64, mut interval: Duration) {
    loop {
        tokio::time::sleep(interval).await;
        let (device_code, deadline, sign_in) = {
            let memory = memory();
            match memory.pending.as_ref() {
                Some(p) if p.generation == generation => (p.device_code.clone(), p.deadline, p.shown.sign_in),
                _ => return,
            }
        };
        let outcome = match poll_once(&site, &device_code).await {
            Poll::Wait if Instant::now() > deadline => Poll::Ended("The code expired before anyone approved it.".into()),
            Poll::Wait => continue,
            Poll::SlowDown => {
                interval += Duration::from_secs(5);
                continue;
            }
            done => done,
        };
        // Under the file lock, which `start` and `unlink` hold too: either
        // finished first and replaced or cancelled this flow, or waits and
        // sees what this writes.
        let _file = FILE.lock().await;
        let current = memory().pending.as_ref().is_some_and(|p| p.generation == generation);
        let error = match outcome {
            Poll::Linked(held, account) if !current => {
                // Cancelled while the claim was in flight: the site already
                // made the link, so take it back rather than drop the credential.
                revoke(&held).await;
                if let Some(account) = account {
                    crate::dray_account::revoke(&account).await;
                }
                return;
            }
            Poll::Linked(held, account) => match write(Some(&held)).await {
                Err(e) => Some(e),
                Ok(()) => match account {
                    Some(account) => crate::dray_account::save(&sink, account).await.err(),
                    None if sign_in => Some(format!("Linked, but {site} didn't sign you in.")),
                    None => None,
                },
            },
            Poll::Ended(_) if !current => return,
            Poll::Ended(why) => Some(why),
            Poll::Wait | Poll::SlowDown => unreachable!(),
        };
        {
            let mut memory = memory();
            if memory.pending.as_ref().is_some_and(|p| p.generation == generation) {
                memory.pending = None;
                memory.error = error;
            }
            memory.checked = Some(Instant::now());
        }
        let _ = sink.emit(CHANGED, ());
        return;
    }
}

/// Asks the site to delete this credential's row. True once the site has
/// none, whether this call deleted it or someone already had.
async fn revoke(held: &Held) -> bool {
    let answer = crate::http()
        .delete(format!("{}/api/link/server", held.site))
        .bearer_auth(&held.token)
        .timeout(TIMEOUT)
        .send()
        .await;
    answer.is_ok_and(|a| a.status().is_success() || a.status() == reqwest::StatusCode::UNAUTHORIZED)
}

/// Stops waiting on a code. The site's row expires on its own, and an
/// approval nobody collects leaves nothing behind.
pub async fn cancel(sink: Sink) {
    let _file = FILE.lock().await;
    {
        let mut memory = memory();
        memory.pending = None;
        memory.error = None;
    }
    let _ = sink.emit(CHANGED, ());
}

/// What `dray logout` reports.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Unlinked {
    pub org: LinkedOrg,
    pub site: String,
    /// Set when the site couldn't be told, so its Servers page still lists
    /// this server.
    pub warning: Option<String>,
}

/// Unlinks this server: the site deletes its row, revoking the credential,
/// and the server forgets it. A site that can't be reached is no reason to
/// stay linked here; the warning says to finish on the Servers page.
pub async fn unlink(sink: Sink) -> Result<Unlinked, String> {
    let _file = FILE.lock().await;
    {
        let mut memory = memory();
        memory.pending = None;
        memory.error = None;
    }
    let held = read().await.ok_or("This server isn't linked to an org.")?;
    let told = revoke(&held).await;
    write(None).await?;
    let _ = sink.emit(CHANGED, ());
    Ok(Unlinked {
        org: held.org,
        site: held.site.clone(),
        warning: (!told).then(|| {
            format!("Couldn't reach {}, so its Servers page still lists this server. Unlink it there too.", held.site)
        }),
    })
}
