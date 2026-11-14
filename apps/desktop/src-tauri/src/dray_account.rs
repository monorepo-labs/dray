//! Who the app on this machine is signed in to drayhq.com as (#874). The
//! app's Sign in is this server's link flow with `signIn` set: approving it
//! links the machine and hands the server's poll a second credential, the
//! app's, good for asking who you are and nothing else. The server keeps it
//! rather than the app, since only the server can collect it, and Sign out
//! forgets it here without touching the link.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::{sink::Sink, store};

pub const CHANGED: &str = "account_changed";
const RECHECK: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(5);

/// The account, as the site describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct DrayUser {
    pub id: String,
    pub name: String,
    pub username: Option<String>,
    /// The Google picture, where the account has one.
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct DrayAccountState {
    pub user: Option<DrayUser>,
}

/// What `<home>/account.json` holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Held {
    pub token: String,
    pub site: String,
    pub user: DrayUser,
}

static CHECKED: Mutex<Option<Instant>> = Mutex::new(None);
/// Held across a read-change-write of the file.
static FILE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn checked() -> std::sync::MutexGuard<'static, Option<Instant>> {
    CHECKED.lock().unwrap_or_else(|e| e.into_inner())
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

/// Reads the `account` a sign-in's claim carries.
pub(crate) fn from_claim(body: &Value, site: &str) -> Option<Held> {
    Some(Held {
        token: body["account"]["token"].as_str()?.into(),
        site: site.into(),
        user: serde_json::from_value(body["account"]["user"].clone()).ok()?,
    })
}

/// Keeps a fresh sign-in, replacing whoever was signed in before. The old
/// credential is revoked so the site lists one app per sign-in.
pub(crate) async fn save(sink: &Sink, held: Held) -> Result<(), String> {
    let _file = FILE.lock().await;
    if let Some(old) = read().await.filter(|old| old.token != held.token) {
        revoke(&old).await;
    }
    write(Some(&held)).await?;
    *checked() = Some(Instant::now());
    let _ = sink.emit(CHANGED, ());
    Ok(())
}

/// Who the app is signed in as. Asking checks with the site at most once a
/// minute, so a renamed account shows up and a revoked credential (a 401) is
/// forgotten. An unreachable site leaves what is held as it was.
pub async fn state(sink: &Sink) -> DrayAccountState {
    DrayAccountState { user: recheck(sink).await.map(|h| h.user) }
}

async fn recheck(sink: &Sink) -> Option<Held> {
    let _file = FILE.lock().await;
    let mut held = read().await?;
    {
        let mut checked = checked();
        if checked.is_some_and(|at| at.elapsed() < RECHECK) {
            return Some(held);
        }
        *checked = Some(Instant::now());
    }
    let Ok(answer) =
        crate::http().get(format!("{}/api/app/me", held.site)).bearer_auth(&held.token).timeout(TIMEOUT).send().await
    else {
        return Some(held);
    };
    if answer.status() == reqwest::StatusCode::UNAUTHORIZED {
        if write(None).await.is_ok() {
            let _ = sink.emit(CHANGED, ());
            return None;
        }
        *checked() = None;
        return Some(held);
    }
    let Ok(now) = answer.json::<Value>().await else { return Some(held) };
    let Ok(user) = serde_json::from_value::<DrayUser>(now["user"].clone()) else { return Some(held) };
    if user != held.user {
        held.user = user;
        if write(Some(&held)).await.is_ok() {
            let _ = sink.emit(CHANGED, ());
        }
    }
    Some(held)
}

/// Asks the site to revoke a credential. True once it holds none.
pub(crate) async fn revoke(held: &Held) -> bool {
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
