//! The Dray relay's wire, shared by the relay (`apps/relay`) and `dray-serve`.
//!
//! A server keeps one WebSocket open to the relay, the *bridge*. A visitor
//! (phone, another Mac) opens TLS to `<route>.<id>.<zone>`; the relay reads
//! only the SNI, finds the bridge for `<id>` and carries the raw bytes over it.
//! TLS ends in the server, so the relay never sees a token or plaintext.
//!
//! ```text
//! ← {"type":"challenge","protocol":1,"nonce":"…"}      relay, first frame
//! → {"type":"attach","key":"…","signature":"…",…}       Ed25519 over [`attach_message`]
//! ← {"type":"attached","id":"…","hostname":"<id>.<zone>","port":443,…}
//! ← {"type":"open","conn":7,"peer":"…","sni":"…"}       a visitor arrived
//! ⇄ binary [u32 conn, big-endian][payload]              its bytes, both ways
//! ⇄ {"type":"window","conn":7,"bytes":65536}            credit back, both ways
//! ⇄ {"type":"end","conn":7} / {"type":"reset",…}
//! → {"type":"certify","csr":"…"}  ← {"type":"certificate","chain":"…"}
//! ← {"type":"drain","reason":"…"}                       reconnect now, relay restarting
//! ```
//!
//! Each stream gets [`WINDOW`] bytes of credit per direction and is given more
//! with `window` as the far side writes it out. One slow visitor then fills its
//! own window and nothing else: the bridge reader never waits on a stream.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};

pub const PROTOCOL: u32 = 1;
pub const BRIDGE_PATH: &str = "/v1/bridge";

/// Both ends ping this often, so each hears the other however one-way the
/// traffic is, and a NAT or proxy never sees the socket idle.
pub const HEARTBEAT: Duration = Duration::from_secs(10);
/// Silence this long means the other end is gone, whatever TCP says. Three
/// heartbeats: a socket dead without a close is found in 30s, not opentunnel's 45.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a bridge's attach may take, handshake to `attached`.
pub const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a visitor arriving for a server that is reconnecting is held
/// before being refused, so a client's retry lands as the bridge comes back.
pub const HOLD: Duration = Duration::from_secs(10);

pub const WINDOW: u32 = 256 * 1024;
/// Credit is handed back in steps this big. Below [`WINDOW`] minus one
/// payload, or a sender could wait on credit the receiver is still holding.
pub const ACK_EVERY: u32 = 64 * 1024;
pub const MAX_PAYLOAD: usize = 32 * 1024;
pub const CONN_ID_SIZE: usize = 4;

/// Every control frame, both directions, as one enum: a side ignores what it
/// would never be sent, and a type it does not know parses as [`Control::Unknown`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Control {
    Challenge { protocol: u32, nonce: String },
    Attach {
        protocol: u32,
        /// The server's Ed25519 public key, base64url.
        key: String,
        /// Over [`attach_message`] of the challenge's nonce, base64url.
        signature: String,
        version: String,
    },
    Attached {
        id: String,
        /// `<id>.<zone>`: a visitor's address is `<route>.` this.
        hostname: String,
        /// The visitor port, which is not 443 on Railway's TCP proxy.
        port: u16,
        /// Which relay process took it, so two logs can be lined up.
        instance: String,
    },
    AttachError { code: String, message: String },
    Open { conn: u32, peer: String, sni: String },
    Window { conn: u32, bytes: u32 },
    End { conn: u32 },
    Reset { conn: u32, reason: String },
    /// A PEM CSR naming `*.<hostname>` alone, signed by the key the server
    /// keeps; the relay never holds it.
    Certify { csr: String },
    /// The leaf first, then its intermediates, PEM.
    Certificate { chain: String },
    CertificateError { reason: String },
    Drain { reason: String },
    #[serde(other)]
    Unknown,
}

pub mod codes {
    /// The relay URL's key is missing or not one the relay was given.
    pub const NOT_ALLOWED: &str = "not_allowed";
    pub const BAD_SIGNATURE: &str = "bad_signature";
    pub const BAD_PROTOCOL: &str = "bad_protocol";
    /// This relay is shutting down; the next try reaches its replacement.
    pub const DRAINING: &str = "draining";

    /// Attach errors that will not succeed on retry, so the server stops.
    pub fn is_fatal(code: &str) -> bool {
        matches!(code, NOT_ALLOWED | BAD_PROTOCOL)
    }
}

/// What a server signs to prove it holds the key its id is made from.
pub fn attach_message(nonce: &str) -> Vec<u8> {
    format!("dray-relay-attach\0{nonce}").into_bytes()
}

/// A server's id: its public key hashed, 16 DNS-safe characters (80 bits).
/// Nothing is stored anywhere: the key is the registration.
pub fn server_id(public_key: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(public_key);
    data_encoding::BASE32_DNSSEC.encode(&digest[..10])
}

pub fn encode_key(bytes: &[u8]) -> String {
    data_encoding::BASE64URL_NOPAD.encode(bytes)
}

pub fn decode_key(text: &str) -> Option<Vec<u8>> {
    data_encoding::BASE64URL_NOPAD.decode(text.as_bytes()).ok()
}

fn is_label(value: &str) -> bool {
    let b = value.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 63 && ok(&b[0]) && ok(&b[b.len() - 1]) && b.iter().all(|c| ok(c) || *c == b'-')
}

/// `<route>.<id>.<zone>` as `(route, id)`, or `None` for any other shape.
pub fn split_host<'a>(host: &'a str, zone: &str) -> Option<(&'a str, &'a str)> {
    let rest = host.strip_suffix(zone)?.strip_suffix('.')?;
    let (route, id) = rest.split_once('.')?;
    (is_label(route) && is_label(id)).then_some((route, id))
}

pub fn encode_data(conn: u32, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(CONN_ID_SIZE + payload.len());
    frame.extend_from_slice(&conn.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub fn decode_data(frame: &[u8]) -> Option<(u32, &[u8])> {
    if frame.len() < CONN_ID_SIZE {
        return None;
    }
    let (head, payload) = frame.split_at(CONN_ID_SIZE);
    Some((u32::from_be_bytes(head.try_into().ok()?), payload))
}

/// Where a stream's frames go: controls on their own unbounded queue, which
/// the bridge writer drains first, so credit never waits behind data.
#[derive(Clone)]
pub struct Outbound {
    pub control: mpsc::UnboundedSender<Control>,
    pub data: mpsc::Sender<Ordered>,
}

/// What must reach the far side in the order sent. `end` rides here, not on
/// the control queue, or it overtakes the stream's last bytes.
#[derive(Debug)]
pub enum Ordered {
    Data(u32, Bytes),
    End(u32),
}

enum Inbound {
    Data(Bytes),
    End,
}

struct Handle {
    inbound: mpsc::UnboundedSender<Inbound>,
    /// What this side may still send.
    credit: Arc<Semaphore>,
    /// What the far side may still send, so one that ignores its window is
    /// reset rather than queued without bound.
    allowance: Arc<AtomicI64>,
}

/// One bridge's open streams, shared by its reader and each stream's pump.
#[derive(Clone, Default)]
pub struct Streams(Arc<Mutex<HashMap<u32, Handle>>>);

/// A stream opened on [`Streams`], ready for [`Streams::pump`].
pub struct Opened {
    conn: u32,
    inbound: mpsc::UnboundedReceiver<Inbound>,
    credit: Arc<Semaphore>,
    allowance: Arc<AtomicI64>,
}

/// Why a stream ended badly. A `Peer` reset is not answered with one.
#[derive(Debug)]
pub enum Broken {
    Local(String),
    Peer(String),
}

impl Streams {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Handle>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn open(&self, conn: u32) -> Opened {
        let (tx, rx) = mpsc::unbounded_channel();
        let credit = Arc::new(Semaphore::new(WINDOW as usize));
        let allowance = Arc::new(AtomicI64::new(WINDOW as i64));
        self.map().insert(conn, Handle { inbound: tx, credit: credit.clone(), allowance: allowance.clone() });
        Opened { conn, inbound: rx, credit, allowance }
    }

    pub fn len(&self) -> usize {
        self.map().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Hands `payload` to its stream. `false` where the far side overran its
    /// window: the stream is closed here and the caller sends the reset.
    pub fn data(&self, conn: u32, payload: &[u8]) -> bool {
        let mut map = self.map();
        let Some(handle) = map.get(&conn) else { return true };
        if handle.allowance.fetch_sub(payload.len() as i64, Ordering::AcqRel) < payload.len() as i64 {
            if let Some(h) = map.remove(&conn) {
                h.credit.close();
            }
            return false;
        }
        let _ = handle.inbound.send(Inbound::Data(Bytes::copy_from_slice(payload)));
        true
    }

    pub fn window(&self, conn: u32, bytes: u32) {
        if let Some(handle) = self.map().get(&conn) {
            // Capped, so a peer cannot overflow the semaphore's counter.
            let room = (WINDOW as usize).saturating_sub(handle.credit.available_permits());
            handle.credit.add_permits((bytes as usize).min(room));
        }
    }

    pub fn end(&self, conn: u32) {
        if let Some(handle) = self.map().get(&conn) {
            let _ = handle.inbound.send(Inbound::End);
        }
    }

    /// Ends one stream at once: its pump sees the queue close and its credit
    /// go, and stops both ways.
    pub fn reset(&self, conn: u32) {
        if let Some(handle) = self.map().remove(&conn) {
            handle.credit.close();
        }
    }

    /// Every stream, as when the bridge drops.
    pub fn reset_all(&self) {
        for (_, handle) in self.map().drain() {
            handle.credit.close();
        }
    }

    fn remove(&self, conn: u32) {
        self.map().remove(&conn);
    }

    /// Carries `io` over the bridge until both directions end or either
    /// breaks, sending the `end`, `window` and `reset` frames that takes.
    /// Answers the bytes carried each way, up (from `io`) then down.
    pub async fn pump<S>(&self, opened: Opened, io: S, out: Outbound) -> Result<(u64, u64), Broken>
    where
        S: AsyncRead + AsyncWrite + Send,
    {
        let Opened { conn, mut inbound, credit, allowance } = opened;
        let (mut reader, mut writer) = tokio::io::split(io);
        let up_out = out.clone();
        let resets = out.control.clone();
        let up = async move {
            let mut buf = vec![0u8; MAX_PAYLOAD];
            let mut sent = 0u64;
            loop {
                let permit = credit
                    .acquire_many(MAX_PAYLOAD as u32)
                    .await
                    .map_err(|_| Broken::Peer("reset".into()))?;
                let n = match reader.read(&mut buf).await {
                    Ok(n) => n,
                    Err(e) => return Err(Broken::Local(format!("read: {e}"))),
                };
                // Take only what was read; the rest of the reservation goes back.
                permit.forget();
                credit.add_permits(MAX_PAYLOAD - n);
                if n == 0 {
                    let _ = up_out.data.send(Ordered::End(conn)).await;
                    return Ok(sent);
                }
                sent += n as u64;
                if up_out.data.send(Ordered::Data(conn, Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                    return Err(Broken::Peer("bridge closed".into()));
                }
            }
        };
        let down = async move {
            let mut received = 0u64;
            let mut unacked = 0u32;
            loop {
                match inbound.recv().await {
                    Some(Inbound::Data(bytes)) => {
                        writer.write_all(&bytes).await.map_err(|e| Broken::Local(format!("write: {e}")))?;
                        received += bytes.len() as u64;
                        unacked += bytes.len() as u32;
                        if unacked >= ACK_EVERY {
                            allowance.fetch_add(unacked as i64, Ordering::AcqRel);
                            let _ = out.control.send(Control::Window { conn, bytes: unacked });
                            unacked = 0;
                        }
                    }
                    Some(Inbound::End) => {
                        let _ = writer.shutdown().await;
                        return Ok(received);
                    }
                    None => return Err(Broken::Peer("reset".into())),
                }
            }
        };
        tokio::pin!(up, down);
        let (mut up_done, mut down_done) = (None, None);
        let ended = loop {
            tokio::select! {
                r = &mut up, if up_done.is_none() => match r {
                    Ok(n) => up_done = Some(n),
                    Err(e) => break Err(e),
                },
                r = &mut down, if down_done.is_none() => match r {
                    Ok(n) => down_done = Some(n),
                    Err(e) => break Err(e),
                },
            }
            if let (Some(u), Some(d)) = (up_done, down_done) {
                break Ok((u, d));
            }
        };
        self.remove(conn);
        if let Err(Broken::Local(reason)) = &ended {
            let _ = resets.send(Control::Reset { conn, reason: reason.clone() });
        }
        ended
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_dns_labels_from_the_key() {
        let id = server_id(b"a public key");
        assert_eq!(id, server_id(b"a public key"));
        assert_ne!(id, server_id(b"another key"));
        assert_eq!(id.len(), 16);
        assert!(is_label(&id), "{id}");
    }

    #[test]
    fn hosts_split_into_route_and_id() {
        assert_eq!(split_host("remote-ab.k3j9.relay.drayhq.com", "relay.drayhq.com"), Some(("remote-ab", "k3j9")));
        assert_eq!(split_host("k3j9.relay.drayhq.com", "relay.drayhq.com"), None, "no route");
        assert_eq!(split_host("a.b.c.relay.drayhq.com", "relay.drayhq.com"), None, "one route label");
        assert_eq!(split_host("a.b.evilrelay.drayhq.com", "relay.drayhq.com"), None);
        assert_eq!(split_host("a.b.relay.drayhq.com.evil", "relay.drayhq.com"), None);
    }

    #[test]
    fn controls_round_trip_and_unknowns_survive() {
        let open = Control::Open { conn: 7, peer: "1.2.3.4:5".into(), sni: "a.b.z".into() };
        let text = serde_json::to_string(&open).unwrap();
        assert_eq!(text, r#"{"type":"open","conn":7,"peer":"1.2.3.4:5","sni":"a.b.z"}"#);
        assert_eq!(serde_json::from_str::<Control>(&text).unwrap(), open);
        assert_eq!(serde_json::from_str::<Control>(r#"{"type":"from_the_future","x":1}"#).unwrap(), Control::Unknown);
    }

    #[test]
    fn data_frames_carry_their_stream() {
        let frame = encode_data(0x01020304, b"hi");
        assert_eq!(decode_data(&frame), Some((0x01020304, &b"hi"[..])));
        assert_eq!(decode_data(&[1, 2]), None);
    }
    /// Routes one side's frames into the other's streams, as a bridge does.
    fn wire(streams: Streams) -> Outbound {
        let (control, mut controls) = mpsc::unbounded_channel::<Control>();
        let (data, mut datas) = mpsc::channel::<Ordered>(8);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    Some(c) = controls.recv() => match c {
                        Control::Window { conn, bytes } => streams.window(conn, bytes),
                        Control::End { conn } => streams.end(conn),
                        Control::Reset { conn, .. } => streams.reset(conn),
                        _ => {}
                    },
                    Some(o) = datas.recv() => match o {
                        Ordered::Data(conn, bytes) => assert!(streams.data(conn, &bytes), "within its window"),
                        Ordered::End(conn) => streams.end(conn),
                    },
                    else => return,
                }
            }
        });
        Outbound { control, data }
    }

    /// Writes `out` and reads everything back at once, as a real peer does.
    async fn app(io: tokio::io::DuplexStream, out: Vec<u8>) -> Vec<u8> {
        let (mut r, mut w) = tokio::io::split(io);
        let writing = tokio::spawn(async move {
            w.write_all(&out).await.unwrap();
            w.shutdown().await.unwrap();
        });
        let mut got = Vec::new();
        r.read_to_end(&mut got).await.unwrap();
        writing.await.unwrap();
        got
    }

    #[tokio::test]
    async fn a_stream_carries_more_than_its_window_both_ways() {
        let (a, b) = (Streams::default(), Streams::default());
        let (to_b, to_a) = (wire(b.clone()), wire(a.clone()));
        let (a_io, a_app) = tokio::io::duplex(4096);
        let (b_io, b_app) = tokio::io::duplex(4096);
        let (opened_a, opened_b) = (a.open(1), b.open(1));
        let pa = tokio::spawn({ let a = a.clone(); async move { a.pump(opened_a, a_io, to_b).await.map_err(|e| format!("{e:?}")) } });
        let pb = tokio::spawn({ let b = b.clone(); async move { b.pump(opened_b, b_io, to_a).await.map_err(|e| format!("{e:?}")) } });
        let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let (sent_a, sent_b) = (big.clone(), big.clone());
        let write_a = tokio::spawn(app(a_app, sent_a));
        let write_b = tokio::spawn(app(b_app, sent_b));
        let (got_a, got_b) = tokio::time::timeout(Duration::from_secs(20), async { (write_a.await.unwrap(), write_b.await.unwrap()) }).await.expect("no stall");
        assert!(got_a == big && got_b == big);
        assert_eq!(pa.await.unwrap().unwrap(), (3_000_000, 3_000_000));
        pb.await.unwrap().unwrap();
        assert!(a.is_empty() && b.is_empty(), "both ends forget the stream");
    }

    #[tokio::test]
    async fn a_reset_stops_the_stream() {
        let (a, b) = (Streams::default(), Streams::default());
        let to_b = wire(b.clone());
        let (a_io, _a_app) = tokio::io::duplex(4096);
        let opened = a.open(9);
        let _ = b.open(9);
        let pump = tokio::spawn({ let a = a.clone(); async move { a.pump(opened, a_io, to_b).await } });
        a.reset(9);
        let ended = tokio::time::timeout(Duration::from_secs(2), pump).await.expect("stops").unwrap();
        assert!(matches!(ended, Err(Broken::Peer(_))), "{ended:?}");
    }

    #[test]
    fn a_peer_overrunning_its_window_is_cut_off() {
        let streams = Streams::default();
        let _opened = streams.open(3);
        let chunk = vec![0u8; MAX_PAYLOAD];
        for _ in 0..(WINDOW as usize / MAX_PAYLOAD) {
            assert!(streams.data(3, &chunk));
        }
        assert!(!streams.data(3, &chunk), "one past its window");
        assert!(streams.is_empty());
    }
}
