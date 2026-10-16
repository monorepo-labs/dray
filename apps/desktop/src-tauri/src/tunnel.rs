//! Public addresses through OpenTunnel, a blind TLS relay: TLS ends in this
//! process, so the relay never sees plaintext. A tunnel's identity is kept in
//! `<home>/opentunnel`, so its addresses outlive a restart, and each Dray home
//! (dev build, worktree) gets its own. Deleting that directory is the only
//! way to new ones. See #518.
//!
//! One tunnel per profile: [`REMOTE`] for Remote access and [`SHARE`] for dev
//! server links. Adding or removing a route ends every connection on its
//! tunnel, so a shared link coming and going must not do that to every Mac
//! connected to this one.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use opentunnel::{Client, ClientOptions, Routes, State, Storage, Tunnel};
use sha2::{Digest, Sha256};

pub const REMOTE: &str = "remote";
pub const SHARE: &str = "share";

/// A first start provisions a certificate before anything connects.
const READY_WAIT: Duration = Duration::from_secs(90);

struct Live {
    tunnel: Tunnel,
    hostname: String,
    token: String,
    /// Every route asked for. The tunnel's status names only those attached.
    routes: Routes,
}

// One lock per profile: a first share's certificate wait must not hold up
// turning Remote access off.
static REMOTE_LIVE: tokio::sync::Mutex<Option<Live>> = tokio::sync::Mutex::const_new(None);
static SHARE_LIVE: tokio::sync::Mutex<Option<Live>> = tokio::sync::Mutex::const_new(None);

fn slot(profile: &str) -> &'static tokio::sync::Mutex<Option<Live>> {
    if profile == REMOTE { &REMOTE_LIVE } else { &SHARE_LIVE }
}

async fn client() -> Result<Client> {
    let root = crate::store::get_home_app_dir().await?.join("opentunnel");
    Ok(Client::new(ClientOptions { api: None, storage: Some(Storage::at(root)) }))
}

/// Whether `profile` already has a tunnel on disk, so its first route waits
/// on no certificate.
pub async fn provisioned(profile: &str) -> bool {
    client().await.is_ok_and(|c| matches!(c.get(profile), Ok(Some(_))))
}

/// Route name for `label`: the same on every start, and unguessable, since
/// the tunnel's token is secret. Route names stay out of certificate logs, so
/// a visitor needs the whole address.
fn route_name(token: &str, label: &str) -> String {
    let digest = Sha256::digest(format!("{token}\0{label}"));
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Routes `label` on `profile`'s tunnel to `target` (`host:port`), answering
/// its `https://` address once the relay has it attached.
pub async fn expose(profile: &'static str, label: &str, target: String) -> Result<String> {
    let (name, url, mut status) = {
        let mut live = slot(profile).lock().await;
        if live.is_none() {
            let client = client().await?;
            let identity = client.ensure(profile).await.context("could not set up the tunnel")?;
            let tunnel = client.connect(profile, Routes::new())?;
            *live = Some(Live { tunnel, hostname: identity.hostname, token: identity.token, routes: Routes::new() });
        }
        let entry = live.as_mut().expect("set above");
        let name = route_name(&entry.token, label);
        entry.routes.insert(name.clone(), target.clone().into());
        entry.tunnel.set_routes(entry.routes.clone())?;
        let url = format!("https://{name}.{}", entry.hostname);
        (name, url, entry.tunnel.status_watch())
    };
    let attached = tokio::time::timeout(READY_WAIT, async {
        loop {
            let now = status.borrow_and_update().clone();
            match now.state {
                State::Connected if now.routes.contains_key(&name) => return Ok(()),
                State::Stopped => bail!("the tunnel stopped: {}", now.last_error.unwrap_or_default()),
                _ => {}
            }
            if status.changed().await.is_err() {
                bail!("the tunnel stopped");
            }
        }
    })
    .await;
    match attached {
        Ok(Ok(())) => Ok(url),
        Ok(Err(e)) => {
            // A stopped tunnel stays stopped; the next expose starts over.
            *slot(profile).lock().await = None;
            Err(e)
        }
        Err(_) => {
            // The caller records no link, so nothing else would take it down.
            withdraw(profile, label, Some(&target)).await;
            bail!("the relay did not attach the link in {}s; try again", READY_WAIT.as_secs())
        }
    }
}

/// Takes `label` off `profile`'s tunnel, and the tunnel down with its last
/// route. Withdrawing one that is not there is no error.
///
/// With `target`, only while the route still points there: a share stopped
/// and started again names the same route, and the stop's late withdrawal must
/// not take the new one down.
pub async fn withdraw(profile: &'static str, label: &str, target: Option<&str>) {
    let mut live = slot(profile).lock().await;
    let Some(entry) = live.as_mut() else { return };
    let name = route_name(&entry.token, label);
    let owned = entry.routes.get(&name).is_some_and(|r| target.is_none_or(|t| r.target == t));
    if !owned {
        return;
    }
    entry.routes.remove(&name);
    if entry.routes.is_empty() {
        // Dropping the handle stops it.
        *live = None;
    } else {
        let _ = entry.tunnel.set_routes(entry.routes.clone());
    }
}

/// `profile`'s tunnel state as it moves, while it has one.
pub async fn status(profile: &str) -> Option<tokio::sync::watch::Receiver<opentunnel::Status>> {
    slot(profile).lock().await.as_ref().map(|entry| entry.tunnel.status_watch())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_names_are_stable_and_per_label() {
        let a = route_name("secret", "remote");
        assert_eq!(a, route_name("secret", "remote"), "the same address every start");
        assert_ne!(a, route_name("secret", "s:5173"));
        assert_ne!(a, route_name("other", "remote"), "another tunnel, another name");
        assert_eq!(a.len(), 16);
        assert!(opentunnel::Route::new("127.0.0.1:1").validate(&a).is_ok(), "a name the relay takes");
    }
}
