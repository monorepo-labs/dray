//! `dray-relay`: Remote access for Dray servers, in place of opentunnel. See
//! README.md for the design and what a deploy needs.

mod bridge;
mod issuer;
mod log;
mod sni;
mod visitor;

use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;

use crate::issuer::{Issuer, Issuing};

pub struct Relay {
    /// Visitors' addresses end in this: `relay.drayhq.com`.
    pub zone: String,
    /// The visitor port as clients dial it, which behind Railway's TCP proxy
    /// is the proxy's port, not the one this process binds.
    pub public_port: u16,
    pub instance: String,
    pub keys: Keys,
    pub registry: bridge::Registry,
    pub issuing: Issuing,
    /// Set on SIGTERM: a server told to reconnect must not reattach here.
    pub draining: std::sync::atomic::AtomicBool,
}

/// Who may attach, as `RELAY_KEYS=name:key,name:key`: a key per contributor,
/// so one can be revoked alone. Logs name the person, never the key.
pub struct Keys {
    keys: Vec<(String, String)>,
    open: bool,
}

impl Keys {
    fn parse(raw: &str, open: bool) -> Self {
        let keys = raw
            .split(',')
            .filter_map(|pair| pair.trim().split_once(':'))
            .filter(|(_, k)| k.len() >= 16)
            .map(|(n, k)| (n.to_string(), k.to_string()))
            .collect();
        Self { keys, open }
    }

    pub fn label(&self, given: Option<&str>) -> Option<String> {
        if let Some(given) = given {
            for (name, key) in &self.keys {
                if same(given.as_bytes(), key.as_bytes()) {
                    return Some(name.clone());
                }
            }
        }
        self.open.then(|| "open".to_string())
    }
}

/// Equal-time compare, so a key cannot be read back off how fast it fails.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn port(name: &str, default: u16) -> u16 {
    env(name).and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http_port = port("PORT", 8080);
    let visitor_port = port("VISITOR_PORT", 7443);
    let zone = env("RELAY_ZONE").unwrap_or_else(|| "relay.localhost".into()).to_ascii_lowercase();
    let public_port = port("RELAY_PUBLIC_PORT", visitor_port);
    let instance = env("RAILWAY_REPLICA_ID")
        .or_else(|| env("HOSTNAME"))
        .unwrap_or_else(|| dray_relay::encode_key(&bridge::random::<6>()));
    let keys = Keys::parse(&env("RELAY_KEYS").unwrap_or_default(), env("RELAY_OPEN").as_deref() == Some("1"));

    let issuer = if let Some(dir) = env("RELAY_DEV_CA") {
        let days = env("RELAY_DEV_DAYS").and_then(|d| d.parse().ok()).unwrap_or(90);
        Issuer::Dev(issuer::Dev::open(dir.into(), days).unwrap_or_else(|e| fail(&e)))
    } else if let (Some(token), Some(zone_id), Some(target)) =
        (env("CLOUDFLARE_API_TOKEN"), env("CLOUDFLARE_ZONE_ID"), env("RELAY_VISITOR_TARGET"))
    {
        let settings = issuer::AcmeSettings {
            directory: env("ACME_DIRECTORY").unwrap_or_else(|| instant_acme::LetsEncrypt::Production.url().to_string()),
            credentials: env("ACME_ACCOUNT_JSON"),
            root_cert: env("ACME_ROOT_CERT"),
            cf_api: env("CLOUDFLARE_API_BASE").unwrap_or_else(|| "https://api.cloudflare.com/client/v4".into()),
            cf_token: token,
            cf_zone: zone_id,
            doh: match env("RELAY_DOH").as_deref() {
                Some("off") => None,
                Some(url) => Some(url.to_string()),
                None => Some("https://cloudflare-dns.com/dns-query".into()),
            },
            visitor_target: target,
        };
        let acme = issuer::Acme::open(settings).await;
        Issuer::Acme(Box::new(acme.unwrap_or_else(|e| fail(&format!("ACME: {e}")))))
    } else {
        log!("issuer.none", reason = "neither RELAY_DEV_CA nor the Cloudflare and ACME settings are set");
        Issuer::None
    };

    let relay = Arc::new(Relay {
        zone,
        public_port,
        instance,
        keys,
        registry: bridge::Registry::default(),
        issuing: Issuing::new(issuer),
        draining: Default::default(),
    });
    let http = TcpListener::bind(("::", http_port)).await.unwrap_or_else(|e| fail(&format!("port {http_port}: {e}")));
    let visitors = TcpListener::bind(("::", visitor_port)).await.unwrap_or_else(|e| fail(&format!("port {visitor_port}: {e}")));
    log!(
        "relay.start",
        instance = relay.instance,
        zone = relay.zone,
        http = http_port,
        visitors = visitor_port,
        public_port = relay.public_port,
        keys = relay.keys.keys.len(),
        open = relay.keys.open,
    );
    tokio::spawn(visitor::listen(relay.clone(), visitors));
    tokio::spawn(serve_http(relay.clone(), http));

    shutdown_signal().await;
    // Every server reconnects at once, onto whichever relay replaces this one.
    let (bridges, _) = relay.registry.counts();
    log!("relay.drain", bridges = bridges);
    relay.draining.store(true, std::sync::atomic::Ordering::SeqCst);
    relay.registry.drain("relay restarting");
    tokio::time::sleep(Duration::from_millis(500)).await;
}

fn fail(why: &str) -> ! {
    log!("relay.fatal", reason = why);
    std::process::exit(1)
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

async fn serve_http(relay: Arc<Relay>, listener: TcpListener) {
    loop {
        let Ok((stream, peer)) = listener.accept().await else { continue };
        let _ = stream.set_nodelay(true);
        let relay = relay.clone();
        tokio::spawn(async move {
            let mut line = [0u8; 64];
            let n = match tokio::time::timeout(Duration::from_secs(10), stream.peek(&mut line)).await {
                Ok(Ok(n)) => n,
                _ => return,
            };
            let head = String::from_utf8_lossy(&line[..n]);
            if head.starts_with("GET /healthz ") || head.starts_with("GET /status ") {
                return answer(stream, &relay, head.starts_with("GET /status ")).await;
            }
            accept_bridge(relay, stream, peer.to_string()).await;
        });
    }
}

/// `/healthz` for Railway's health check; `/status` counts, naming nobody.
async fn answer(mut stream: TcpStream, relay: &Relay, status: bool) {
    let body = if status {
        let (bridges, streams) = relay.registry.counts();
        serde_json::json!({ "instance": relay.instance, "bridges": bridges, "streams": streams }).to_string()
    } else {
        "ok".to_string()
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(format!("{head}{body}").as_bytes()).await;
}

async fn accept_bridge(relay: Arc<Relay>, stream: TcpStream, tcp_peer: String) {
    let mut key = None;
    let mut peer = tcp_peer;
    let callback = |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
        if req.uri().path() != dray_relay::BRIDGE_PATH {
            let mut err = ErrorResponse::new(Some("not found".into()));
            *err.status_mut() = StatusCode::NOT_FOUND;
            return Err(err);
        }
        key = req.uri().query().and_then(|q| {
            q.split('&').find_map(|kv| kv.strip_prefix("key=")).map(str::to_string)
        });
        // Railway's edge names the real client; the socket's peer is the edge.
        if let Some(fwd) = req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            peer = fwd.split(',').next().unwrap_or(fwd).trim().to_string();
        }
        Ok(res)
    };
    let ws = tokio_tungstenite::accept_hdr_async(stream, callback).await;
    match ws {
        Ok(ws) => bridge::serve(relay, ws, key, peer).await,
        Err(e) => log!("bridge.handshake_failed", peer = peer, reason = e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_name_their_holder_and_nobody_else() {
        let keys = Keys::parse("yogesh:aaaaaaaaaaaaaaaa, alice:bbbbbbbbbbbbbbbb,short:abc", false);
        assert_eq!(keys.label(Some("aaaaaaaaaaaaaaaa")).as_deref(), Some("yogesh"));
        assert_eq!(keys.label(Some("bbbbbbbbbbbbbbbb")).as_deref(), Some("alice"));
        assert_eq!(keys.label(Some("abc")), None, "a short key is never taken");
        assert_eq!(keys.label(None), None);
        assert_eq!(Keys::parse("", true).label(None).as_deref(), Some("open"));
    }
}
