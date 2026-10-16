//! Public links to a session's dev servers, on the machine the dev server
//! runs on, so a link from a server keeps working with the Mac asleep. Routes
//! on the [`tunnel::SHARE`] tunnel, named per session and port, so sharing a
//! port again hands out the link it had before. See #434 and #518.
//!
//! Only a port the session's Browser tab lists can be shared — its agent's
//! own servers, or one started in its checkout — so an agent cannot publish a
//! database or another project's server. A link lasts until it is stopped or
//! the session is settled or deleted; a server restart takes every one with it.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use dray_proto::SharedPort;
use hyper::body::Incoming;
use hyper::header::{HeaderValue, HOST, ORIGIN, UPGRADE};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use crate::tunnel;

struct Link {
    /// The Host-rewriting proxy the route points at. Aborted on drop.
    proxy: JoinHandle<()>,
    /// The proxy's address, which tells this link's route from a later one.
    target: String,
    url: String,
}

impl Drop for Link {
    fn drop(&mut self) {
        self.proxy.abort();
    }
}

#[derive(Default)]
struct Links {
    live: HashMap<(String, u16), Link>,
    /// How many times each link, and (`None`) each session's every link, has
    /// been stopped. A start that waited through the relay publishes only if
    /// neither moved meanwhile, or a stop or a settle landing in that wait
    /// would leave a public link nobody can see.
    stops: HashMap<(String, Option<u16>), u64>,
}

impl Links {
    fn stamp(&self, session: &str, port: u16) -> (u64, u64) {
        let count = |p| self.stops.get(&(session.to_string(), p)).copied().unwrap_or(0);
        (count(None), count(Some(port)))
    }

    fn bump(&mut self, session: &str, port: Option<u16>) {
        *self.stops.entry((session.to_string(), port)).or_default() += 1;
    }
}

static LINKS: LazyLock<Mutex<Links>> = LazyLock::new(Default::default);

fn label(session: &str, port: u16) -> String {
    format!("{session}:{port}")
}

/// Takes a stopped link's route down, unless a later share of the same port
/// has repointed it already.
fn retire(session: &str, port: u16, link: Link) {
    let label = label(session, port);
    tokio::spawn(async move { tunnel::withdraw(tunnel::SHARE, &label, Some(&link.target)).await });
}

/// Publishes one of the session's dev servers, answering its public URL.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_port(session_id: String, port: u16) -> Result<String, String> {
    start(&session_id, port, "app").await
}

/// Takes a link down. Stopping one that is not up is no error.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn stop_share(session_id: String, port: u16) {
    stop(&session_id, port);
}

/// One session's live links by port, or every session's.
pub fn list(session: Option<&str>) -> Vec<SharedPort> {
    let links = LINKS.lock().unwrap();
    let mut shares: Vec<SharedPort> = links
        .live
        .iter()
        .filter(|((s, _), _)| session.is_none_or(|session| s == session))
        .map(|((s, port), l)| SharedPort { port: *port, url: l.url.clone(), session_id: s.clone() })
        .collect();
    shares.sort_by(|a, b| (&a.session_id, a.port).cmp(&(&b.session_id, b.port)));
    shares
}

/// One start at a time, so two racing for one port cannot point its route at
/// the proxy the loser is about to drop.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `via` is who asked — `app` for the reader, `cli` for an agent — reported
/// beside the feature and nothing else: no port, session or link.
pub async fn start(session: &str, port: u16, via: &'static str) -> Result<String, String> {
    let _held = STARTING.lock().await;
    if let Some(live) = list(Some(session)).into_iter().find(|s| s.port == port) {
        return Ok(live.url);
    }
    let stamp = LINKS.lock().unwrap().stamp(session, port);
    let listed = crate::local_servers::list_local_servers(session.to_string()).await?;
    if !listed.iter().any(|s| s.port == port) {
        return Err(format!(
            "nothing in this session is serving port {port}. Only the session's own dev servers can be shared."
        ));
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("could not listen: {e}"))?;
    let target = listener.local_addr().map_err(|e| format!("could not listen: {e}"))?.to_string();
    let link = Arc::new(OnceLock::new());
    let proxy = tokio::spawn(proxy(listener, port, link.clone()));
    let url = match tunnel::expose(tunnel::SHARE, &label(session, port), target.clone()).await {
        Ok(url) => url,
        Err(e) => {
            proxy.abort();
            return Err(format!("{e:#}"));
        }
    };
    let _ = link.set(url.clone());
    let published = {
        let mut links = LINKS.lock().unwrap();
        let current = links.stamp(session, port) == stamp;
        if current {
            links.live.insert((session.to_string(), port), Link { proxy, target: target.clone(), url: url.clone() });
        } else {
            proxy.abort();
        }
        current
    };
    if !published {
        // The stop found nothing live to withdraw, so the route is still up.
        tunnel::withdraw(tunnel::SHARE, &label(session, port), Some(&target)).await;
        return Err("sharing was stopped before the link was ready".into());
    }
    crate::analytics::track("feature_used", serde_json::json!({ "feature": "share", "via": via }));
    Ok(url)
}

pub fn stop(session: &str, port: u16) {
    let mut links = LINKS.lock().unwrap();
    links.bump(session, Some(port));
    if let Some(link) = links.live.remove(&(session.to_string(), port)) {
        retire(session, port, link);
    }
}

/// Every link the session has, for settle and delete.
pub fn close_session(session: &str) {
    let mut links = LINKS.lock().unwrap();
    links.bump(session, None);
    let ports: Vec<u16> = links.live.keys().filter(|(s, _)| s == session).map(|(_, p)| *p).collect();
    for port in ports {
        if let Some(link) = links.live.remove(&(session.to_string(), port)) {
            retire(session, port, link);
        }
    }
}

/// Whether a share can start without the tunnel's first certificate, so the
/// row can say which wait the reader is in.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_ready() -> bool {
    tunnel::provisioned(tunnel::SHARE).await
}

/// Forwards each connection to `localhost:<port>` as local traffic. The
/// relay forwards bytes untouched, so the visitor's `Host` names the link, and
/// Vite and its kin refuse a Host they do not know. Next's dev server also
/// answers `/_next/*` 403 for any `Origin` but localhost (#527), so the link's
/// own origin is made local too; any other passes untouched, and the dev
/// server still refuses other sites. `link` is the URL, once the relay names it.
async fn proxy(listener: TcpListener, port: u16, link: Arc<OnceLock<String>>) {
    // Owned here, so aborting the share aborts every open connection with it:
    // an idle stream or an HMR socket never ends on its own.
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((visitor, _)) => drop(conns.spawn(relay(visitor, port, link.clone()))),
                Err(_) => return,
            },
            Some(_) = conns.join_next() => {}
        }
    }
}

/// One visitor's connection, request by request, with WebSocket upgrades
/// (HMR) spliced through whole.
async fn relay(visitor: TcpStream, port: u16, link: Arc<OnceLock<String>>) {
    // `localhost`, not `127.0.0.1`: a dev server may listen on `::1` alone.
    let Ok(upstream) = TcpStream::connect(("localhost", port)).await else { return };
    let Ok((sender, conn)) = hyper::client::conn::http1::handshake(TokioIo::new(upstream)).await else { return };
    // The upstream driver and any spliced upgrade, held so they end with this task.
    let tasks = Arc::new(Mutex::new(JoinSet::new()));
    tasks.lock().unwrap().spawn(async move { drop(conn.with_upgrades().await) });
    let sender = Arc::new(tokio::sync::Mutex::new(sender));
    let host = HeaderValue::from_str(&format!("localhost:{port}")).expect("ascii");
    // With the port, to match `Host`, or Next's server actions refuse the pair.
    let local = HeaderValue::from_str(&format!("http://localhost:{port}")).expect("ascii");
    let spliced = tasks.clone();
    let service = hyper::service::service_fn(move |mut req: Request<Incoming>| {
        let (sender, host, local, link, spliced) = (sender.clone(), host.clone(), local.clone(), link.clone(), spliced.clone());
        async move {
            req.headers_mut().insert(HOST, host);
            let from_link = req.headers().get(ORIGIN).zip(link.get()).is_some_and(|(o, l)| o.as_bytes() == l.as_bytes());
            if from_link {
                req.headers_mut().insert(ORIGIN, local);
            }
            let upgrading = req.headers().contains_key(UPGRADE).then(|| hyper::upgrade::on(&mut req));
            let mut res = sender.lock().await.send_request(req).await?;
            if let (Some(visitor), StatusCode::SWITCHING_PROTOCOLS) = (upgrading, res.status()) {
                let server = hyper::upgrade::on(&mut res);
                spliced.lock().unwrap().spawn(async move {
                    if let (Ok(visitor), Ok(server)) = tokio::join!(visitor, server) {
                        let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(visitor), &mut TokioIo::new(server)).await;
                    }
                });
            }
            Ok::<_, hyper::Error>(res)
        }
    });
    let _ = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(visitor), service)
        .with_upgrades()
        .await;
    let mut tasks = std::mem::take(&mut *tasks.lock().unwrap());
    while tasks.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn a_stop_during_the_wait_moves_the_stamp() {
        let mut t = Links::default();
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

    /// A link through the real relay, in a throwaway `DRAY_HOME`: a visitor's
    /// request reaches the dev server as local traffic, and the link comes
    /// back the same after it was taken down.
    ///
    /// ```text
    /// cargo test share::tests::a_link_reaches_the_dev_server -- --ignored --nocapture
    /// ```
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn a_link_reaches_the_dev_server() {
        let home = std::env::temp_dir().join(format!("dray-share-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("DRAY_HOME", &home);
        // Answers with the Host it was sent, the way Vite judges one.
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = server.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                    let host = head.lines().find_map(|l| l.strip_prefix("host: ")).unwrap_or("").trim().to_string();
                    let reply = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{host}", host.len());
                    let _ = s.write_all(reply.as_bytes()).await;
                });
            }
        });
        let front = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target = front.local_addr().unwrap().to_string();
        tokio::spawn(proxy(front, port, Default::default()));

        let t0 = std::time::Instant::now();
        let url = tunnel::expose(tunnel::SHARE, "s:1", target.clone()).await.unwrap();
        eprintln!("link {url} in {:?}", t0.elapsed());
        let body = loop {
            match reqwest::get(&url).await {
                Ok(answer) => break answer.text().await.unwrap(),
                Err(e) => {
                    assert!(t0.elapsed() < std::time::Duration::from_secs(60), "never reached: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        };
        eprintln!("reached in {:?}", t0.elapsed());
        assert_eq!(body, format!("localhost:{port}"));

        tunnel::withdraw(tunnel::SHARE, "s:1", None).await;
        assert_eq!(tunnel::expose(tunnel::SHARE, "s:1", target).await.unwrap(), url, "shared again, the same link");
        tunnel::withdraw(tunnel::SHARE, "s:1", None).await;
    }

    /// A WebSocket — Vite's hot reload — is spliced through whole after the
    /// upgrade.
    #[cfg(feature = "desktop")]
    #[tokio::test]
    async fn the_proxy_carries_a_websocket() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = server.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                ws.send(Message::text(format!("echo {text}"))).await.unwrap();
            }
        });
        let front = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let front_addr = front.local_addr().unwrap();
        tokio::spawn(proxy(front, port, Default::default()));

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{front_addr}/hmr")).await.unwrap();
        for word in ["one", "two"] {
            ws.send(Message::text(word)).await.unwrap();
            let Some(Ok(Message::Text(back))) = ws.next().await else { panic!("no echo") };
            assert_eq!(back.as_str(), format!("echo {word}"));
        }
    }

    /// The link's own `Origin` reaches the dev server as localhost, the way
    /// Next's `/_next/*` and server actions want it; another site's does not.
    #[tokio::test]
    async fn only_the_links_own_origin_is_made_local() {
        const LINK: &str = "https://abc.def.opentunnel.xyz";
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let mut heads = Vec::new();
            for _ in 0..2 {
                let (mut s, _) = server.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).await.unwrap();
                heads.push(String::from_utf8_lossy(&buf[..n]).to_lowercase());
                s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok").await.unwrap();
            }
            heads
        });
        let front = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let front_addr = front.local_addr().unwrap();
        tokio::spawn(proxy(front, port, Arc::new(OnceLock::from(LINK.to_string()))));
        for origin in [LINK, "https://evil.example"] {
            let mut visitor = TcpStream::connect(front_addr).await.unwrap();
            let req = format!("GET /_next/x.js HTTP/1.1\r\nhost: abc.def.opentunnel.xyz\r\norigin: {origin}\r\n\r\n");
            visitor.write_all(req.as_bytes()).await.unwrap();
            let mut buf = [0u8; 512];
            let _ = visitor.read(&mut buf).await.unwrap();
        }
        let heads = seen.await.unwrap();
        assert!(heads[0].contains(&format!("origin: http://localhost:{port}\r\n")), "{}", heads[0]);
        assert!(heads[1].contains("origin: https://evil.example\r\n"), "{}", heads[1]);
    }

    /// A stream the dev server never ends is closed when the share is.
    #[tokio::test]
    async fn stopping_the_proxy_closes_an_open_relay() {
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let front = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let front_addr = front.local_addr().unwrap();
        let proxy = tokio::spawn(proxy(front, port, Default::default()));
        let mut visitor = TcpStream::connect(front_addr).await.unwrap();
        visitor.write_all(b"GET /stream HTTP/1.1\r\nhost: x\r\n\r\n").await.unwrap();
        let (mut conn, _) = server.accept().await.unwrap();
        let mut head = [0u8; 256];
        let _ = conn.read(&mut head).await.unwrap();
        proxy.abort();
        let mut rest = Vec::new();
        let closed = tokio::time::timeout(std::time::Duration::from_secs(2), conn.read_to_end(&mut rest)).await;
        assert!(closed.is_ok(), "the relay outlived its proxy");
    }

    /// The dev server sees `Host: localhost:<port>` on every request of a
    /// kept-alive connection, whatever the visitor sent.
    #[tokio::test]
    async fn the_proxy_rewrites_every_host() {
        let server = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut s, _) = server.accept().await.unwrap();
            let mut heads = String::new();
            let mut buf = [0u8; 4096];
            for _ in 0..2 {
                let n = s.read(&mut buf).await.unwrap();
                heads.push_str(&String::from_utf8_lossy(&buf[..n]));
                s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok").await.unwrap();
            }
            heads
        });
        let front = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let front_addr = front.local_addr().unwrap();
        tokio::spawn(proxy(front, port, Default::default()));

        let mut visitor = TcpStream::connect(front_addr).await.unwrap();
        let mut buf = [0u8; 4096];
        for path in ["/a", "/b"] {
            let req = format!("GET {path} HTTP/1.1\r\nhost: abc.def.opentunnel.xyz\r\n\r\n");
            visitor.write_all(req.as_bytes()).await.unwrap();
            let n = visitor.read(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).ends_with("ok"));
        }
        let heads = seen.await.unwrap().to_lowercase();
        assert_eq!(heads.matches(&format!("host: localhost:{port}")).count(), 2, "{heads}");
        assert!(!heads.contains("opentunnel"), "{heads}");
    }
}
