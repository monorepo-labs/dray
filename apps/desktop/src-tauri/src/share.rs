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
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use dray_proto::SharedPort;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::task::AbortHandle;

struct Tunnel {
    child: Child,
    url: String,
    _proxy: Proxy,
}

#[derive(Default)]
struct Tunnels {
    live: HashMap<(String, u16), Tunnel>,
    /// How many times each link, and (`None`) each session's every link, has
    /// been stopped. A start that waited through a download and Cloudflare's
    /// registration publishes only if neither moved meanwhile, or a stop or a
    /// settle landing in that wait would leave a public link nobody can see.
    stops: HashMap<(String, Option<u16>), u64>,
}

impl Tunnels {
    fn stamp(&self, session: &str, port: u16) -> (u64, u64) {
        let count = |p| self.stops.get(&(session.to_string(), p)).copied().unwrap_or(0);
        (count(None), count(Some(port)))
    }

    fn bump(&mut self, session: &str, port: Option<u16>) {
        *self.stops.entry((session.to_string(), port)).or_default() += 1;
    }
}

static TUNNELS: LazyLock<Mutex<Tunnels>> = LazyLock::new(Default::default);
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

/// One session's live links by port, or every session's. A tunnel whose
/// cloudflared exited is dropped here, so a link Cloudflare closed stops being
/// offered.
pub fn list(session: Option<&str>) -> Vec<SharedPort> {
    let mut tunnels = TUNNELS.lock().unwrap();
    tunnels.live.retain(|_, t| matches!(t.child.try_wait(), Ok(None)));
    let mut shares: Vec<SharedPort> = tunnels
        .live
        .iter()
        .filter(|((s, _), _)| session.is_none_or(|session| s == session))
        .map(|((s, port), t)| SharedPort { port: *port, url: t.url.clone(), session_id: s.clone() })
        .collect();
    shares.sort_by(|a, b| (&a.session_id, a.port).cmp(&(&b.session_id, b.port)));
    shares
}

pub async fn start(session: &str, port: u16) -> Result<String, String> {
    if let Some(live) = list(Some(session)).into_iter().find(|s| s.port == port) {
        return Ok(live.url);
    }
    let stamp = TUNNELS.lock().unwrap().stamp(session, port);
    let listed = crate::local_servers::list_local_servers(session.to_string()).await?;
    if !listed.iter().any(|s| s.port == port) {
        return Err(format!(
            "nothing in this session is serving port {port}. Only the session's own dev servers can be shared."
        ));
    }
    let proxy = proxy(port).await.map_err(|e| format!("could not start the share's proxy: {e}"))?;
    // Vite and its kin refuse a Host they do not know, and the visitor's is
    // `*.trycloudflare.com`; to the dev server it is local traffic.
    let (child, url) =
        quick_tunnel(&format!("http://127.0.0.1:{}", proxy.port), &["--http-host-header", "localhost"]).await?;
    let _ = proxy.tunnel.set(url.clone());
    // Two shares racing: the first link stays, so a URL already handed out
    // keeps working, and the second child is dropped, which kills it.
    let mut tunnels = TUNNELS.lock().unwrap();
    if tunnels.stamp(session, port) != stamp {
        return Err("sharing was stopped before the link was ready".into());
    }
    let tunnel = Tunnel { child, url, _proxy: proxy };
    Ok(tunnels.live.entry((session.to_string(), port)).or_insert(tunnel).url.clone())
}

/// What a visitor's `Origin` naming the tunnel becomes: what the dev server
/// would see from a browser on its own machine. Port-less on purpose, to match
/// the `Host` cloudflared sends, or Next's server actions refuse the pair.
const LOCAL_ORIGIN: &str = "http://localhost";
/// A request head bigger than this is not a browser's, and is dropped.
const MAX_HEAD: usize = 64 * 1024;

/// The hop between cloudflared and a shared dev server, alive while its
/// tunnel is. Next's dev server answers `/_next/*` 403 for any `Origin` but
/// localhost, and cloudflared can rewrite `Host` but not `Origin`, so a shared
/// Next page loaded with none of its code (#527).
struct Proxy {
    port: u16,
    /// The tunnel's URL, once cloudflared names it: the one origin rewritten.
    /// Any other passes untouched, so the dev server still refuses other sites.
    tunnel: Arc<OnceLock<String>>,
    task: AbortHandle,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Listens on a free loopback port and relays every connection to `target`.
async fn proxy(target: u16) -> std::io::Result<Proxy> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let tunnel = Arc::new(OnceLock::<String>::new());
    let named = tunnel.clone();
    let task = tokio::spawn(async move {
        while let Ok((visitor, _)) = listener.accept().await {
            let named = named.clone();
            tokio::spawn(async move {
                let _ = relay(visitor, target, named.get().map(String::as_str)).await;
            });
        }
    })
    .abort_handle();
    Ok(Proxy { port, tunnel, task })
}

/// One request: its head rewritten, then bytes both ways until either side
/// closes, which carries a WebSocket upgrade through unchanged.
async fn relay(mut visitor: TcpStream, target: u16, tunnel: Option<&str>) -> std::io::Result<()> {
    let mut head = Vec::new();
    let mut buf = [0u8; 8192];
    let end = loop {
        let n = visitor.read(&mut buf).await?;
        if n == 0 || head.len() + n > MAX_HEAD {
            return Ok(());
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(i) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let mut server = TcpStream::connect(("localhost", target)).await?;
    server.write_all(&rewrite(&head[..end], tunnel)).await?;
    server.write_all(&head[end..]).await?;
    tokio::io::copy_bidirectional(&mut visitor, &mut server).await?;
    Ok(())
}

/// The request head with a tunnel `Origin` made local and the connection
/// closed after the reply.
// ponytail: one request per connection, so the head is all that is parsed and
// a body passes through as bytes. A keep-alive connection would need each
// request's length read to find the next head; cloudflared opens a new
// loopback connection per request instead, which costs well under a millisecond.
fn rewrite(head: &[u8], tunnel: Option<&str>) -> Vec<u8> {
    let head = head.strip_suffix(b"\r\n\r\n").unwrap_or(head);
    let mut out = Vec::with_capacity(head.len() + 32);
    let mut upgrade = false;
    for (i, line) in head.split(|&b| b == b'\n').enumerate() {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let (name, value) = match line.iter().position(|&b| b == b':') {
            Some(colon) if i > 0 => (&line[..colon], line[colon + 1..].trim_ascii()),
            _ => (&b""[..], &b""[..]),
        };
        let connection = name.eq_ignore_ascii_case(b"connection");
        if connection && !value.to_ascii_lowercase().windows(7).any(|w| w == b"upgrade") {
            continue;
        }
        upgrade |= connection;
        if name.eq_ignore_ascii_case(b"origin") && tunnel.is_some_and(|t| value == t.as_bytes()) {
            out.extend_from_slice(format!("Origin: {LOCAL_ORIGIN}").as_bytes());
        } else {
            out.extend_from_slice(line);
        }
        out.extend_from_slice(b"\r\n");
    }
    if !upgrade {
        out.extend_from_slice(b"Connection: close\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// A quick tunnel to `origin`, answering its process and its address once the
/// address is registered and in DNS. Dropping the child takes it down.
pub async fn quick_tunnel(origin: &str, extra: &[&str]) -> Result<(Child, String), String> {
    let exe = binary().await.map_err(|e| format!("{e:#}"))?;
    let mut child = Command::new(exe)
        .args(["tunnel", "--no-autoupdate", "--url", origin])
        .args(extra)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run cloudflared: {e}"))?;
    let mut lines = BufReader::new(child.stderr.take().expect("piped")).lines();
    // Handed out only once the tunnel is registered too: see TUNNEL_REGISTERED.
    let found = tokio::time::timeout(URL_WAIT, async {
        let (mut said, mut url, mut registered) = (None, None, false);
        while let Ok(Some(line)) = lines.next_line().await {
            if url.is_none() {
                url = dray_proto::quick_tunnel_url(&line);
            }
            registered |= line.contains(dray_proto::TUNNEL_REGISTERED);
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
    wait_for_dns(&url).await;
    Ok((child, url))
}

pub fn stop(session: &str, port: u16) {
    let mut tunnels = TUNNELS.lock().unwrap();
    tunnels.bump(session, Some(port));
    tunnels.live.remove(&(session.to_string(), port));
}

/// Every link the session has, for settle and delete.
pub fn close_session(session: &str) {
    let mut tunnels = TUNNELS.lock().unwrap();
    tunnels.bump(session, None);
    tunnels.live.retain(|(s, _), _| s != session);
}

/// Until the link's name resolves, so a visitor's resolver never asks early
/// and caches the miss — see `dray_proto::TUNNEL_REGISTERED`. Gives up after
/// 15s and hands the link out anyway.
async fn wait_for_dns(url: &str) {
    let query = format!("{}{}", dray_proto::DOH_QUERY, url.trim_start_matches("https://"));
    let client = reqwest::Client::new();
    // A deadline, not a count: with 1.1.1.1 unreachable each ask takes its
    // whole timeout, and thirty of them were a minute and a half.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        let answer = client.get(&query).header("accept", "application/dns-json").timeout(Duration::from_secs(3)).send();
        if let Ok(answer) = answer.await {
            if answer.text().await.is_ok_and(|body| body.contains("\"Status\":0")) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
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

    /// A name that resolves answers on the first ask, not after the cap.
    #[tokio::test]
    #[ignore]
    async fn a_resolving_name_waits_for_nothing() {
        let t0 = std::time::Instant::now();
        wait_for_dns("https://www.cloudflare.com").await;
        assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
    }

    const TUNNEL: &str = "https://a-b-c.trycloudflare.com";

    #[test]
    fn only_the_tunnels_own_origin_is_made_local() {
        let head = b"GET /_next/x.js HTTP/1.1\r\nHost: localhost\r\norigin:  https://a-b-c.trycloudflare.com\r\nConnection: keep-alive\r\n\r\n";
        assert_eq!(
            String::from_utf8(rewrite(head, Some(TUNNEL))).unwrap(),
            "GET /_next/x.js HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost\r\nConnection: close\r\n\r\n"
        );
        let other = b"GET / HTTP/1.1\r\nOrigin: https://evil.example\r\n\r\n";
        assert_eq!(
            String::from_utf8(rewrite(other, Some(TUNNEL))).unwrap(),
            "GET / HTTP/1.1\r\nOrigin: https://evil.example\r\nConnection: close\r\n\r\n"
        );
        let early = b"GET / HTTP/1.1\r\nOrigin: https://a-b-c.trycloudflare.com\r\n\r\n";
        assert!(String::from_utf8(rewrite(early, None)).unwrap().contains(TUNNEL), "no tunnel named yet, nothing rewritten");
    }

    #[test]
    fn an_upgrade_keeps_its_connection() {
        let head = b"GET /_next/webpack-hmr HTTP/1.1\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n";
        let out = String::from_utf8(rewrite(head, Some(TUNNEL))).unwrap();
        assert!(out.contains("Connection: keep-alive, Upgrade\r\n"));
        assert!(!out.contains("close"));
    }

    /// The dev server gets the rewritten head, then the body as sent, and the
    /// visitor gets the reply.
    #[tokio::test]
    async fn a_request_crosses_the_proxy() {
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target = server.local_addr().unwrap().port();
        let got = tokio::spawn(async move {
            let (mut conn, _) = server.accept().await.unwrap();
            let mut seen = Vec::new();
            while !seen.ends_with(b"hello") {
                let mut buf = [0u8; 1024];
                let n = conn.read(&mut buf).await.unwrap();
                seen.extend_from_slice(&buf[..n]);
            }
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await.unwrap();
            String::from_utf8(seen).unwrap()
        });
        let proxy = proxy(target).await.unwrap();
        proxy.tunnel.set(TUNNEL.into()).unwrap();
        let mut visitor = TcpStream::connect(("127.0.0.1", proxy.port)).await.unwrap();
        let request = format!("POST /a HTTP/1.1\r\nOrigin: {TUNNEL}\r\nContent-Length: 5\r\n\r\nhello");
        // Split mid-head, the way a slow network delivers it.
        visitor.write_all(&request.as_bytes()[..20]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        visitor.write_all(&request.as_bytes()[20..]).await.unwrap();
        assert_eq!(
            got.await.unwrap(),
            "POST /a HTTP/1.1\r\nOrigin: http://localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"
        );
        let mut reply = String::new();
        visitor.read_to_string(&mut reply).await.unwrap();
        assert!(reply.ends_with("ok"), "{reply}");
    }

    #[test]
    fn a_stop_during_the_wait_moves_the_stamp() {
        let mut t = Tunnels::default();
        let before = t.stamp("s", 5173);
        t.bump("s", Some(3000));
        t.bump("other", None);
        assert_eq!(t.stamp("s", 5173), before, "another port or session leaves it");
        t.bump("s", Some(5173));
        assert_ne!(t.stamp("s", 5173), before);
        let before = t.stamp("s", 5173);
        t.bump("s", None);
        assert_ne!(t.stamp("s", 5173), before, "a settle stops every port");
    }
}
