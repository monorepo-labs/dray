//! Public links to a session's dev servers: a Cloudflare quick tunnel run on
//! the machine the dev server runs on, so a link from a server keeps working
//! with the Mac asleep. No account, a random `*.trycloudflare.com` URL each
//! time, and Cloudflare promises no uptime for it. See #434.
//!
//! Only a port the session's Browser tab lists can be shared — its agent's
//! own servers, or one started in its checkout — so an agent cannot publish a
//! database or another project's server. A link lasts until it is stopped or
//! the session is settled or deleted; a server restart takes every one with it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use dray_proto::SharedPort;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

struct Tunnel {
    child: Child,
    url: String,
}

static TUNNELS: LazyLock<Mutex<HashMap<(String, u16), Tunnel>>> = LazyLock::new(Default::default);
/// One download at a time; a second share waits for the first's.
static FETCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Measured at ~6s from start to the URL on a VPS.
const URL_WAIT: Duration = Duration::from_secs(30);

/// Publishes one of the session's dev servers, answering its public URL.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_port(session_id: String, port: u16) -> Result<String, String> {
    start(&session_id, port).await
}

/// Takes a link down. Stopping one that is not up is no error.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn stop_share(session_id: String, port: u16) {
    stop(&session_id, port);
}

/// The session's live links, by port. A tunnel whose cloudflared exited is
/// dropped here, so a link Cloudflare closed stops being offered.
pub fn list(session: &str) -> Vec<SharedPort> {
    let mut tunnels = TUNNELS.lock().unwrap();
    tunnels.retain(|_, t| matches!(t.child.try_wait(), Ok(None)));
    let mut shares: Vec<SharedPort> = tunnels
        .iter()
        .filter(|((s, _), _)| s == session)
        .map(|((_, port), t)| SharedPort { port: *port, url: t.url.clone() })
        .collect();
    shares.sort_by_key(|s| s.port);
    shares
}

pub async fn start(session: &str, port: u16) -> Result<String, String> {
    if let Some(live) = list(session).into_iter().find(|s| s.port == port) {
        return Ok(live.url);
    }
    let listed = crate::local_servers::list_local_servers(session.to_string()).await?;
    if !listed.iter().any(|s| s.port == port) {
        return Err(format!(
            "nothing in this session is serving port {port}. Only the session's own dev servers can be shared."
        ));
    }
    let exe = binary().await.map_err(|e| format!("{e:#}"))?;
    let mut child = Command::new(exe)
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://localhost:{port}")])
        // Vite and its kin refuse a Host they do not know, and the visitor's
        // is `*.trycloudflare.com`; to the dev server it is local traffic.
        .args(["--http-host-header", "localhost"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run cloudflared: {e}"))?;
    let mut lines = BufReader::new(child.stderr.take().expect("piped")).lines();
    // The URL is printed a moment before the tunnel is registered, and a link
    // opened in that gap fails — a failed DNS lookup the visitor's resolver
    // may then cache — so it is handed out only once both have been said.
    let found = tokio::time::timeout(URL_WAIT, async {
        let (mut said, mut url, mut registered) = (None, None, false);
        while let Ok(Some(line)) = lines.next_line().await {
            if url.is_none() {
                url = tunnel_url(&line);
            }
            registered |= line.contains("Registered tunnel connection");
            if let (true, Some(url)) = (registered, &url) {
                return Ok(url.clone());
            }
            if line.contains(" ERR ") {
                said = Some(line);
            }
        }
        Err(said)
    })
    .await;
    let url = match found {
        Ok(Ok(url)) => url,
        Ok(Err(said)) => {
            let said = said.map(|l| format!(": {}", l.trim())).unwrap_or_default();
            return Err(format!("cloudflared exited without a link{said}"));
        }
        Err(_) => return Err(format!("Cloudflare handed out no link in {}s; try again", URL_WAIT.as_secs())),
    };
    // cloudflared logs for as long as it runs, and a pipe nobody drains
    // fills and stalls it.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    // Two shares racing: the first link stays, so a URL already handed out
    // keeps working, and the second child is dropped, which kills it.
    let mut tunnels = TUNNELS.lock().unwrap();
    Ok(tunnels.entry((session.to_string(), port)).or_insert(Tunnel { child, url }).url.clone())
}

pub fn stop(session: &str, port: u16) {
    TUNNELS.lock().unwrap().remove(&(session.to_string(), port));
}

/// Every link the session has, for settle and delete.
pub fn close_session(session: &str) {
    TUNNELS.lock().unwrap().retain(|(s, _), _| s != session);
}

/// The quick tunnel's address out of cloudflared's banner, which boxes it:
/// `|  https://four-random-words.trycloudflare.com   |`.
fn tunnel_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..].chars().take_while(|c| !c.is_whitespace() && *c != '|').collect();
    url.ends_with(".trycloudflare.com").then_some(url)
}

/// Whether a share can start without downloading cloudflared first, so the
/// row can say which wait the reader is in.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_ready() -> bool {
    matches!(installed().await, Ok(Some(_)))
}

/// cloudflared where `dray setup` or a package manager put it, or where an
/// earlier share downloaded it.
async fn installed() -> Result<Option<PathBuf>> {
    let home = std::env::home_dir().unwrap_or_default();
    let found = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .chain([home.join(".local/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()])
        .chain([download_dir().await?])
        .map(|dir| dir.join("cloudflared"))
        .find(|p| p.is_file());
    Ok(found)
}

async fn download_dir() -> Result<PathBuf> {
    Ok(crate::store::get_home_app_dir()
        .await?
        .join("cloudflared")
        .join(dray_proto::CLOUDFLARED_VERSION))
}

/// cloudflared already on the machine, else the pinned release, downloaded
/// into `<home>/cloudflared/<version>/` the first time anything is shared.
async fn binary() -> Result<PathBuf> {
    if let Some(found) = installed().await? {
        return Ok(found);
    }
    let build = dray_proto::cloudflared_build().context("Cloudflare publishes no cloudflared for this machine")?;
    let dir = download_dir().await?;
    let exe = dir.join("cloudflared");
    let _held = FETCH.lock().await;
    if exe.is_file() {
        return Ok(exe);
    }
    tokio::fs::create_dir_all(&dir).await?;
    let part = dir.join(format!("{}.part", build.asset));
    let fetched =
        crate::download::download_verified(&build.url(), &part, build.size, build.sha256, || false, |_| {}).await;
    if let Err(e) = fetched {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e.context("could not download cloudflared"));
    }
    if build.asset.ends_with(".tgz") {
        // The macOS release is a tarball holding the one binary.
        let unpacked = Command::new("/usr/bin/tar").arg("-xzf").arg(&part).arg("-C").arg(&dir).status().await;
        let _ = tokio::fs::remove_file(&part).await;
        if !unpacked.is_ok_and(|s| s.success()) {
            bail!("could not unpack cloudflared");
        }
    } else {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).await?;
        tokio::fs::rename(&part, &exe).await?;
    }
    if !exe.is_file() {
        bail!("the cloudflared download held no cloudflared");
    }
    Ok(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_link_out_of_the_banner() {
        let banner = "2026-10-07T05:26:15Z INF |  https://eligible-recipients-expanded-pepper.trycloudflare.com                             |";
        assert_eq!(tunnel_url(banner).as_deref(), Some("https://eligible-recipients-expanded-pepper.trycloudflare.com"));
        // The terms line names Cloudflare's own site, which is no link.
        assert_eq!(tunnel_url("INF ... (https://www.cloudflare.com/website-terms/), and"), None);
        assert_eq!(tunnel_url("INF Requesting new quick Tunnel on trycloudflare.com..."), None);
    }
}
