//! Remote access through Dray's own relay ([apps/relay](../../../relay)), in
//! place of opentunnel while one is configured: `DRAY_RELAY`, or the first
//! line of `<home>/relay-url`. See apps/relay/README.md (#1669).
//!
//! Blind, as opentunnel is: this process keeps the TLS key and ends TLS
//! itself, and the relay routes the raw bytes by SNI. So the token in a
//! client's hello never leaves an encrypted channel that ends here.
//!
//! One bridge WebSocket to the relay, pinged every 10s and given up after 30s
//! of silence, reconnected at once on a network change or a relay's drain,
//! else after a backoff capped at 8s.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use dray_relay::{codes, Control, Ordered, Outbound, Streams};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch, Notify};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;

use crate::netwatch::Change;
use crate::store;

/// The file that turns the relay on for a home, beside `DRAY_RELAY`.
pub const URL_FILE: &str = "relay-url";

/// A first start waits on its certificate.
const READY_WAIT: Duration = Duration::from_secs(120);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
/// Lower than opentunnel's 30s: a server the phone cannot reach is the whole
/// complaint, and a reconnect costs the relay one handshake.
const BACKOFF_MAX: Duration = Duration::from_secs(8);
/// A session that lived this long starts the backoff over.
const STEADY: Duration = Duration::from_secs(30);
/// After a network change, a connected bridge must answer a ping this fast
/// or is taken for dead: its socket may sit on an address that is gone.
const PROBE: Duration = Duration::from_secs(5);
/// Renewed once less than a third of its life is left.
const RENEW_CHECK: Duration = Duration::from_secs(6 * 60 * 60);
const TLS_HANDSHAKE: Duration = Duration::from_secs(10);
/// A refused certificate is asked for again after this, doubling to
/// [`CERT_RETRY_MAX`]: the relay's DNS or Let's Encrypt may be down a while.
const CERT_RETRY: Duration = Duration::from_secs(30);
const CERT_RETRY_MAX: Duration = Duration::from_secs(15 * 60);

/// The relay's base URL for this home, if one is set.
pub async fn configured() -> Option<String> {
    if let Some(url) = std::env::var("DRAY_RELAY").ok().filter(|u| !u.trim().is_empty()) {
        return Some(url.trim().to_string());
    }
    let file = store::get_home_app_dir().await.ok()?.join(URL_FILE);
    let text = tokio::fs::read_to_string(file).await.ok()?;
    text.lines().next().map(str::trim).filter(|u| !u.is_empty()).map(str::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Connecting,
    Connected,
    Reconnecting,
    Stopped,
}

#[derive(Debug, Clone)]
pub struct Status {
    pub state: State,
    /// `https://<route>.<id>.<zone>[:port]`, once attached with a certificate.
    pub url: Option<String>,
    pub last_error: Option<String>,
}

struct Live {
    task: tokio::task::JoinHandle<()>,
    status: watch::Receiver<Status>,
    kick: Arc<Kick>,
    key: (String, String),
}

impl Drop for Live {
    fn drop(&mut self) {
        self.task.abort();
    }
}

static LIVE: tokio::sync::Mutex<Option<Live>> = tokio::sync::Mutex::const_new(None);

/// Starts the bridge to `base` fronting `target` (`host:port`) and answers
/// the address once the relay has attached it and its certificate is in.
pub async fn expose(base: String, target: String) -> Result<String> {
    let mut status = {
        let mut live = LIVE.lock().await;
        if live.as_ref().is_none_or(|l| l.key != (base.clone(), target.clone()) || l.task.is_finished()) {
            *live = None;
            let files = Files::at(store::get_home_app_dir().await?.join("relay"));
            let (tx, rx) = watch::channel(Status { state: State::Connecting, url: None, last_error: None });
            let kick = Arc::new(Kick::default());
            let task = tokio::spawn(run(base.clone(), target.clone(), files, tx, kick.clone()));
            *live = Some(Live { task, status: rx, kick, key: (base, target) });
            crate::tunnel::follow_network();
        }
        live.as_ref().expect("set above").status.clone()
    };
    let ready = tokio::time::timeout(READY_WAIT, async {
        loop {
            let now = status.borrow_and_update().clone();
            match (now.state, now.url) {
                (State::Connected, Some(url)) => return Ok(url),
                (State::Stopped, _) => return Err(anyhow!("the relay refused this server: {}", now.last_error.unwrap_or_default())),
                _ => {}
            }
            if status.changed().await.is_err() {
                return Err(anyhow!("the relay connection stopped"));
            }
        }
    })
    .await;
    match ready {
        Ok(answer) => answer,
        Err(_) => {
            let why = status.borrow().last_error.clone().unwrap_or_else(|| "no answer".into());
            Err(anyhow!("the relay did not attach this server in {}s: {why}", READY_WAIT.as_secs()))
        }
    }
}

/// The bridge's state as it moves, while there is one.
pub async fn status() -> Option<watch::Receiver<Status>> {
    LIVE.lock().await.as_ref().map(|l| l.status.clone())
}

/// Ends the bridge, and with it every visitor on it.
pub async fn withdraw() {
    *LIVE.lock().await = None;
}

/// The network moved: a waiting bridge tries now, a connected one is probed.
pub async fn network_changed(change: Change) {
    if let Some(live) = LIVE.lock().await.as_ref() {
        live.kick.send(change);
    }
}

/// A [`Change`] handed to the running bridge, the newest one kept.
#[derive(Default)]
struct Kick {
    notify: Notify,
    last: std::sync::Mutex<Option<Change>>,
}

impl Kick {
    fn send(&self, change: Change) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(change);
        self.notify.notify_one();
    }

    async fn recv(&self) -> Change {
        loop {
            if let Some(change) = self.last.lock().unwrap_or_else(|e| e.into_inner()).take() {
                return change;
            }
            self.notify.notified().await;
        }
    }
}

fn log(what: &str) {
    crate::tunnel::log("relay", what);
}

/// The keys a home keeps: which server this is, and the TLS key no one else
/// ever holds, with the certificate the relay got for it.
struct Files {
    dir: PathBuf,
}

impl Files {
    fn at(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn private(&self, name: &str, make: impl FnOnce() -> Result<Vec<u8>>) -> Result<Vec<u8>> {
        let path = self.dir.join(name);
        if let Ok(bytes) = std::fs::read(&path) {
            return Ok(bytes);
        }
        std::fs::create_dir_all(&self.dir)?;
        let bytes = make()?;
        store::write_private_atomic(&path, &bytes).with_context(|| format!("could not write {}", path.display()))?;
        Ok(bytes)
    }

    /// Ed25519, PKCS#8: the server's identity, its id being this key hashed.
    fn identity(&self) -> Result<ring::signature::Ed25519KeyPair> {
        let pkcs8 = self.private("identity.pk8", || {
            let rng = ring::rand::SystemRandom::new();
            Ok(ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).map_err(|e| anyhow!("{e}"))?.as_ref().to_vec())
        })?;
        ring::signature::Ed25519KeyPair::from_pkcs8(&pkcs8).map_err(|e| anyhow!("identity.pk8: {e}"))
    }

    fn tls_key(&self) -> Result<rcgen::KeyPair> {
        let pem = self.private("tls-key.pem", || Ok(rcgen::KeyPair::generate()?.serialize_pem().into_bytes()))?;
        Ok(rcgen::KeyPair::from_pem(std::str::from_utf8(&pem)?)?)
    }

    fn cert_path(&self) -> PathBuf {
        self.dir.join("cert.pem")
    }
}

/// The route label: unguessable, since the identity key is secret, and the
/// same every start. Certificates name `*.<id>.<zone>`, so it stays out of
/// certificate logs and a visitor needs the whole address.
fn route_label(identity_pkcs8_hash: &[u8]) -> String {
    let digest = Sha256::digest([b"dray-relay-route\0".as_slice(), identity_pkcs8_hash].concat());
    format!("r{}", digest[..8].iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// `base` (`wss://relay.drayhq.com/?key=…`) as the bridge's URL.
fn bridge_url(base: &str) -> String {
    let base = base.trim().replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    let (head, query) = base.split_once('?').map_or((base.as_str(), None), |(h, q)| (h, Some(q)));
    let head = head.trim_end_matches('/').trim_end_matches(dray_relay::BRIDGE_PATH);
    match query {
        Some(q) => format!("{head}{}?{q}", dray_relay::BRIDGE_PATH),
        None => format!("{head}{}", dray_relay::BRIDGE_PATH),
    }
}

/// The visitor's address for `route` on `hostname`, the port left off at 443.
fn public_url(route: &str, hostname: &str, port: u16) -> String {
    if port == 443 { format!("https://{route}.{hostname}") } else { format!("https://{route}.{hostname}:{port}") }
}

/// Jittered, doubling from [`BACKOFF_MIN`] to [`BACKOFF_MAX`].
fn backoff(attempt: u32) -> Duration {
    let base = BACKOFF_MIN.saturating_mul(1 << attempt.min(8)).min(BACKOFF_MAX);
    // Half to all of it, so servers dropped together do not return together.
    let jitter = 0.5 + (uuid::Uuid::new_v4().as_u128() % 1000) as f64 / 2000.0;
    base.mul_f64(jitter)
}

enum End {
    Fatal(String),
    Retry { reason: String, lasted: Duration, now: bool },
}

async fn run(base: String, target: String, files: Files, status: watch::Sender<Status>, kick: Arc<Kick>) {
    let prepared = (|| -> Result<_> {
        let identity = files.identity()?;
        let tls_key = files.tls_key()?;
        let route = route_label(&Sha256::digest(std::fs::read(files.dir.join("identity.pk8"))?));
        Ok((identity, tls_key, route))
    })();
    let (identity, tls_key, route) = match prepared {
        Ok(p) => p,
        Err(e) => {
            log(&format!("could not start: {e:#}"));
            status.send_modify(|s| {
                s.state = State::Stopped;
                s.last_error = Some(format!("{e:#}"));
            });
            return;
        }
    };
    let mut bridge = BridgeState { identity, tls_key, route, files, target, acceptor: Arc::new(RwLock::new(None)), cert_wait: CERT_RETRY };
    let url = bridge_url(&base);
    let mut attempt = 0u32;
    loop {
        log(&format!("connecting to {}, attempt {attempt}", redact(&url)));
        match bridge.session(&url, &status, &kick).await {
            End::Fatal(why) => {
                log(&format!("stopped: {why}"));
                status.send_modify(|s| {
                    s.state = State::Stopped;
                    s.url = None;
                    s.last_error = Some(why);
                });
                return;
            }
            End::Retry { reason, lasted, now } => {
                if lasted >= STEADY {
                    attempt = 0;
                }
                let delay = if now { Duration::ZERO } else { backoff(attempt) };
                attempt = attempt.saturating_add(1);
                log(&format!("dropped after {}s: {reason}; reconnecting in {}ms", lasted.as_secs(), delay.as_millis()));
                status.send_modify(|s| {
                    s.state = State::Reconnecting;
                    s.last_error = Some(reason);
                });
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    change = kick.recv() => log(&format!("{change}, reconnecting now")),
                }
            }
        }
    }
}

/// Never logs the relay URL's key.
fn redact(url: &str) -> String {
    match url.split_once('?') {
        Some((head, _)) => format!("{head}?…"),
        None => url.to_string(),
    }
}

struct BridgeState {
    identity: ring::signature::Ed25519KeyPair,
    tls_key: rcgen::KeyPair,
    route: String,
    files: Files,
    target: String,
    acceptor: Arc<RwLock<Option<TlsAcceptor>>>,
    /// The next wait after a refused certificate, kept across reconnects.
    cert_wait: Duration,
}

/// Never, for `None`.
async fn sleep_until_some(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

impl BridgeState {
    async fn session(&mut self, url: &str, status: &watch::Sender<Status>, kick: &Kick) -> End {
        use ring::signature::KeyPair;
        let started = Instant::now();
        let retry = |reason: String| End::Retry { reason, lasted: started.elapsed(), now: false };
        let connect = tokio::time::timeout(dray_relay::ATTACH_TIMEOUT, tokio_tungstenite::connect_async(url)).await;
        let mut ws = match connect {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => return retry(format!("connect: {e}")),
            Err(_) => return retry("connect timed out".into()),
        };
        let first = tokio::time::timeout(dray_relay::ATTACH_TIMEOUT, next_control(&mut ws)).await;
        let nonce = match first {
            Ok(Some(Control::Challenge { nonce, .. })) => nonce,
            Ok(_) => return retry("no challenge".into()),
            Err(_) => return retry("challenge timed out".into()),
        };
        let attach = Control::Attach {
            protocol: dray_relay::PROTOCOL,
            key: dray_relay::encode_key(self.identity.public_key().as_ref()),
            signature: dray_relay::encode_key(self.identity.sign(&dray_relay::attach_message(&nonce)).as_ref()),
            version: env!("CARGO_PKG_VERSION").into(),
        };
        if let Err(e) = ws.send(text(&attach)).await {
            return retry(format!("write: {e}"));
        }
        let answer = tokio::time::timeout(dray_relay::ATTACH_TIMEOUT, next_control(&mut ws)).await;
        let (id, hostname, port, instance) = match answer {
            Ok(Some(Control::Attached { id, hostname, port, instance })) => (id, hostname, port, instance),
            Ok(Some(Control::AttachError { code, message })) if codes::is_fatal(&code) => return End::Fatal(format!("{code}: {message}")),
            Ok(Some(Control::AttachError { code, message })) => return retry(format!("{code}: {message}")),
            Ok(_) => return retry("no attach answer".into()),
            Err(_) => return retry("attach timed out".into()),
        };
        let address = public_url(&self.route, &hostname, port);
        log(&format!("connected as {id} on relay {instance}, serving {address}"));

        let (mut sink, mut stream) = ws.split();
        let (control_tx, mut control_rx) = mpsc::unbounded_channel::<Control>();
        let (data_tx, mut data_rx) = mpsc::channel::<Ordered>(64);
        let out = Outbound { control: control_tx.clone(), data: data_tx };
        let (wrote_tx, mut wrote_rx) = tokio::sync::oneshot::channel::<String>();
        let poke = Arc::new(Notify::new());
        let ping_now = poke.clone();
        // Its own task, so a relay slow to read never stops this one reading.
        let writer = tokio::spawn(async move {
            let mut ping = tokio::time::interval(dray_relay::HEARTBEAT);
            ping.tick().await;
            let why = loop {
                let msg = tokio::select! {
                    biased;
                    Some(c) = control_rx.recv() => text(&c),
                    Some(o) = data_rx.recv() => match o {
                        Ordered::Data(conn, bytes) => Message::Binary(dray_relay::encode_data(conn, &bytes).into()),
                        Ordered::End(conn) => text(&Control::End { conn }),
                    },
                    _ = ping.tick() => Message::Ping(Default::default()),
                    _ = ping_now.notified() => Message::Ping(Default::default()),
                    else => break "closed".to_string(),
                };
                if let Err(e) = sink.send(msg).await {
                    break format!("write: {e}");
                }
            };
            let _ = sink.close().await;
            let _ = wrote_tx.send(why);
        });
        struct Abort(tokio::task::JoinHandle<()>);
        impl Drop for Abort {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _writer = Abort(writer);

        let streams = Streams::default();
        // What is on disk serves until a renewal lands, even inside its last third.
        let kept = std::fs::read(self.files.cert_path()).ok().and_then(|pem| Some((check_cert(&pem, &hostname).ok()??, pem)));
        let loaded = kept.as_ref().and_then(|(_, pem)| acceptor(pem, self.tls_key.serialize_pem().as_bytes()).ok());
        let ready = loaded.is_some();
        *self.acceptor.write().unwrap_or_else(|e| e.into_inner()) = loaded;
        let mut certifying = false;
        if !kept.is_some_and(|(fresh, _)| fresh) {
            certifying = self.certify(&hostname, &control_tx);
        }
        status.send_modify(|s| {
            s.state = State::Connected;
            s.url = ready.then(|| address.clone());
            s.last_error = None;
        });
        let mut heard = tokio::time::Instant::now();
        let mut probe: Option<tokio::time::Instant> = None;
        let mut renew = tokio::time::interval(RENEW_CHECK);
        renew.tick().await;
        let mut cert_retry: Option<tokio::time::Instant> = None;
        let end = loop {
            let probe_at = probe.unwrap_or_else(|| heard + dray_relay::IDLE_TIMEOUT);
            tokio::select! {
                msg = stream.next() => {
                    heard = tokio::time::Instant::now();
                    probe = None;
                    match msg {
                        Some(Ok(Message::Binary(frame))) => {
                            let Some((conn, payload)) = dray_relay::decode_data(&frame) else { continue };
                            if !streams.data(conn, payload) {
                                let _ = control_tx.send(Control::Reset { conn, reason: "window exceeded".into() });
                            }
                        }
                        Some(Ok(Message::Text(t))) => match serde_json::from_str::<Control>(&t) {
                            Ok(Control::Open { conn, peer, sni }) => self.open(conn, &peer, &sni, &hostname, &streams, &out),
                            Ok(Control::Window { conn, bytes }) => streams.window(conn, bytes),
                            Ok(Control::End { conn }) => streams.end(conn),
                            Ok(Control::Reset { conn, .. }) => streams.reset(conn),
                            Ok(Control::Certificate { chain }) => {
                                certifying = false;
                                self.cert_wait = CERT_RETRY;
                                match self.install(&chain) {
                                    Ok(expiry) => {
                                        log(&format!("certificate installed, expires {expiry}"));
                                        status.send_modify(|s| s.url = Some(address.clone()));
                                    }
                                    Err(e) => log(&format!("certificate refused: {e:#}")),
                                }
                            }
                            Ok(Control::CertificateError { reason }) => {
                                certifying = false;
                                let wait = self.cert_wait.min(CERT_RETRY_MAX);
                                self.cert_wait = (wait * 2).min(CERT_RETRY_MAX);
                                cert_retry = Some(tokio::time::Instant::now() + wait);
                                log(&format!("no certificate: {reason}; asking again in {}s", wait.as_secs()));
                                status.send_modify(|s| s.last_error = Some(format!("no certificate: {reason}")));
                            }
                            Ok(Control::Drain { reason }) => break End::Retry { reason: format!("relay drained: {reason}"), lasted: started.elapsed(), now: true },
                            _ => {}
                        },
                        Some(Ok(Message::Close(frame))) => break retry(format!("closed by relay: {}", frame.map(|f| f.to_string()).unwrap_or_default())),
                        Some(Ok(_)) => {}
                        Some(Err(e)) => break retry(format!("read: {e}")),
                        None => break retry("eof".into()),
                    }
                }
                _ = tokio::time::sleep_until(probe_at) => break retry(if probe.is_some() {
                    format!("no answer {}s after the network changed", PROBE.as_secs())
                } else {
                    format!("relay silent {}s", dray_relay::IDLE_TIMEOUT.as_secs())
                }),
                why = &mut wrote_rx => break retry(why.unwrap_or_else(|_| "writer ended".into())),
                change = kick.recv() => {
                    // A ping the relay must answer within PROBE: the socket
                    // may sit on an address the machine no longer has.
                    log(&format!("{change}, probing the bridge"));
                    probe = Some(tokio::time::Instant::now() + PROBE);
                    poke.notify_one();
                }
                _ = renew.tick() => if !certifying && self.needs_certificate(&hostname) {
                    certifying = self.certify(&hostname, &control_tx);
                },
                _ = sleep_until_some(cert_retry) => {
                    cert_retry = None;
                    if !certifying && self.needs_certificate(&hostname) {
                        certifying = self.certify(&hostname, &control_tx);
                    }
                }
            }
        };
        streams.reset_all();
        end
    }

    /// Whether the kept certificate is missing, for another name, or into
    /// the last third of its life.
    fn needs_certificate(&self, hostname: &str) -> bool {
        let Ok(pem) = std::fs::read(self.files.cert_path()) else { return true };
        !matches!(check_cert(&pem, hostname), Ok(Some(true)))
    }

    fn certify(&self, hostname: &str, out: &mpsc::UnboundedSender<Control>) -> bool {
        let csr = rcgen::CertificateParams::new(vec![format!("*.{hostname}")])
            .and_then(|p| p.serialize_request(&self.tls_key))
            .and_then(|c| c.pem());
        match csr {
            Ok(csr) => {
                log("asking the relay for a certificate");
                out.send(Control::Certify { csr }).is_ok()
            }
            Err(e) => {
                log(&format!("could not make a CSR: {e}"));
                false
            }
        }
    }

    /// Saves `chain` and serves new visitors with it. Answers its expiry.
    fn install(&self, chain: &str) -> Result<String> {
        let acceptor = acceptor(chain.as_bytes(), self.tls_key.serialize_pem().as_bytes())?;
        let (_, pem) = x509_parser::pem::parse_x509_pem(chain.as_bytes())?;
        let expiry = pem.parse_x509()?.validity().not_after.to_string();
        store::write_private_atomic(&self.files.cert_path(), chain.as_bytes())?;
        *self.acceptor.write().unwrap_or_else(|e| e.into_inner()) = Some(acceptor);
        Ok(expiry)
    }

    fn open(&self, conn: u32, peer: &str, sni: &str, hostname: &str, streams: &Streams, out: &Outbound) {
        let refuse = |reason: &str| {
            let _ = out.control.send(Control::Reset { conn, reason: reason.into() });
        };
        if sni != format!("{}.{hostname}", self.route) {
            return refuse("unknown route");
        }
        let Some(acceptor) = self.acceptor.read().unwrap_or_else(|e| e.into_inner()).clone() else {
            return refuse("no certificate yet");
        };
        log(&format!("visitor {conn} from {peer}"));
        let opened = streams.open(conn);
        let (near, far) = tokio::io::duplex(64 * 1024);
        let (streams, out, target, peer) = (streams.clone(), out.clone(), self.target.clone(), peer.to_string());
        tokio::spawn(async move {
            let pump = streams.pump(opened, near, out);
            let serve = async {
                let tls = tokio::time::timeout(TLS_HANDSHAKE, acceptor.accept(far))
                    .await
                    .map_err(|_| anyhow!("TLS handshake timed out"))?
                    .context("TLS handshake")?;
                let mut upstream = tokio::net::TcpStream::connect(&target).await.with_context(|| format!("connect {target}"))?;
                let _ = upstream.set_nodelay(true);
                let mut tls = tls;
                match tokio::io::copy_bidirectional(&mut tls, &mut upstream).await {
                    // A client that just closes its socket, as most do.
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(()),
                    copied => copied.map(drop).context("copy"),
                }
            };
            let (pumped, served) = tokio::join!(pump, serve);
            if let Err(e) = served {
                log(&format!("visitor {conn} from {peer} closed: {e:#}"));
            } else if let Err(e) = pumped {
                log(&format!("visitor {conn} from {peer} closed: {e:?}"));
            }
        });
    }
}

/// `None` where `pem`'s leaf does not name `*.<hostname>` or has expired,
/// else whether a third of its life is left.
fn check_cert(pem: &[u8], hostname: &str) -> Result<Option<bool>> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(pem)?;
    let cert = pem.parse_x509()?;
    let want = format!("*.{hostname}");
    let names = cert
        .subject_alternative_name()?
        .map(|san| {
            san.value
                .general_names
                .iter()
                .filter_map(|n| match n {
                    x509_parser::extensions::GeneralName::DNSName(d) => Some(d.to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let validity = cert.validity();
    let (from, to) = (validity.not_before.timestamp(), validity.not_after.timestamp());
    let now = chrono::Utc::now().timestamp();
    if !names.contains(&want) || now >= to {
        return Ok(None);
    }
    Ok(Some((to - now) * 3 > (to - from)))
}

fn acceptor(chain_pem: &[u8], key_pem: &[u8]) -> Result<TlsAcceptor> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let certs = CertificateDer::pem_slice_iter(chain_pem).collect::<std::result::Result<Vec<_>, _>>()?;
    let key = PrivateKeyDer::from_pem_slice(key_pem)?;
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

async fn next_control<S>(ws: &mut S) -> Option<Control>
where
    S: futures_util::Stream<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(Ok(msg)) = ws.next().await {
        if let Message::Text(t) = msg {
            return serde_json::from_str(&t).ok();
        }
    }
    None
}

fn text(c: &Control) -> Message {
    Message::Text(serde_json::to_string(c).expect("controls serialize").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_url_keeps_the_key_and_gains_the_path() {
        assert_eq!(bridge_url("wss://relay.drayhq.com"), "wss://relay.drayhq.com/v1/bridge");
        assert_eq!(bridge_url("https://relay.drayhq.com/?key=abc"), "wss://relay.drayhq.com/v1/bridge?key=abc");
        assert_eq!(bridge_url("ws://127.0.0.1:8080/v1/bridge?key=k"), "ws://127.0.0.1:8080/v1/bridge?key=k");
        assert_eq!(redact("wss://r/v1/bridge?key=secret"), "wss://r/v1/bridge?…");
    }

    #[test]
    fn addresses_drop_the_default_port() {
        assert_eq!(public_url("r1", "id.relay.drayhq.com", 443), "https://r1.id.relay.drayhq.com");
        assert_eq!(public_url("r1", "id.relay.drayhq.com", 41234), "https://r1.id.relay.drayhq.com:41234");
    }

    #[test]
    fn routes_are_labels_and_stable() {
        let a = route_label(b"one");
        assert_eq!(a, route_label(b"one"));
        assert_ne!(a, route_label(b"two"));
        assert!(dray_relay::split_host(&format!("{a}.abc.relay.localhost"), "relay.localhost").is_some());
    }

    #[test]
    fn backoff_stays_under_its_cap() {
        assert!(backoff(0) <= BACKOFF_MIN && backoff(0) >= BACKOFF_MIN / 2);
        assert!((0..40).all(|n| backoff(n) <= BACKOFF_MAX));
    }

    #[test]
    fn a_certificate_is_kept_only_for_its_own_name_and_while_fresh() {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["*.abc.relay.localhost".to_string()]).unwrap();
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::days(10);
        params.not_after = now + time::Duration::days(80);
        let fresh = params.self_signed(&key).unwrap().pem();
        assert_eq!(check_cert(fresh.as_bytes(), "abc.relay.localhost").unwrap(), Some(true));
        assert_eq!(check_cert(fresh.as_bytes(), "xyz.relay.localhost").unwrap(), None, "another server's name");
        params.not_before = now - time::Duration::days(70);
        params.not_after = now + time::Duration::days(20);
        let old = params.self_signed(&key).unwrap().pem();
        assert_eq!(check_cert(old.as_bytes(), "abc.relay.localhost").unwrap(), Some(false), "past two thirds of its life, still served");
        params.not_after = now - time::Duration::days(1);
        let gone = params.self_signed(&key).unwrap().pem();
        assert_eq!(check_cert(gone.as_bytes(), "abc.relay.localhost").unwrap(), None, "expired");
        assert!(acceptor(fresh.as_bytes(), key.serialize_pem().as_bytes()).is_ok());
    }
}
