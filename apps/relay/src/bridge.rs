//! Servers' bridges: one WebSocket per server, found by id when a visitor
//! arrives. Held in memory alone; a restart loses them all and every server
//! is back within a second, since it reconnects on its own.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use dray_relay::{codes, Control, Ordered, Outbound, Streams};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch, Notify};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::{log, Relay};

/// The most visitors one server carries at once.
pub const MAX_STREAMS: usize = 256;

pub struct Bridge {
    session: u64,
    pub id: String,
    pub out: Outbound,
    pub streams: Streams,
    next_conn: AtomicU32,
    stop: watch::Sender<Option<String>>,
}

impl Bridge {
    pub fn next_conn(&self) -> u32 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }
}

#[derive(Default)]
pub struct Registry {
    bridges: Mutex<HashMap<String, Arc<Bridge>>>,
    attached: Notify,
    sessions: AtomicU64,
}

impl Registry {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Bridge>>> {
        self.bridges.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn counts(&self) -> (usize, usize) {
        let map = self.map();
        (map.len(), map.values().map(|b| b.streams.len()).sum())
    }

    /// `id`'s bridge, waiting up to `hold` for one reconnecting: a phone's
    /// retry then lands the moment the server is back instead of failing.
    pub async fn wait_for(&self, id: &str, hold: std::time::Duration) -> Option<Arc<Bridge>> {
        let deadline = tokio::time::Instant::now() + hold;
        loop {
            let attached = self.attached.notified();
            tokio::pin!(attached);
            attached.as_mut().enable();
            if let Some(bridge) = self.map().get(id).cloned() {
                return Some(bridge);
            }
            if tokio::time::timeout_at(deadline, attached).await.is_err() {
                return None;
            }
        }
    }

    /// Every bridge, told to reconnect: this relay is going away.
    pub fn drain(&self, reason: &str) {
        for bridge in self.map().values() {
            let _ = bridge.out.control.send(Control::Drain { reason: reason.into() });
        }
    }
}

/// One server's bridge, from challenge to drop.
pub async fn serve(relay: Arc<Relay>, ws: WebSocketStream<TcpStream>, key: Option<String>, peer: String) {
    let started = Instant::now();
    let (mut sink, mut stream) = ws.split();
    let nonce = dray_relay::encode_key(&random::<32>());
    let challenge = Control::Challenge { protocol: dray_relay::PROTOCOL, nonce: nonce.clone() };
    if sink.send(text(&challenge)).await.is_err() {
        return;
    }
    let attach = tokio::time::timeout(dray_relay::ATTACH_TIMEOUT, async {
        while let Some(Ok(msg)) = stream.next().await {
            if let Message::Text(t) = msg {
                return serde_json::from_str::<Control>(&t).ok();
            }
        }
        None
    })
    .await;
    let refuse = |code: &str, message: &str| Control::AttachError { code: code.into(), message: message.into() };
    let (public_key, version) = match attach {
        Ok(Some(Control::Attach { protocol, key: public, signature, version })) => {
            if protocol != dray_relay::PROTOCOL {
                let _ = sink.send(text(&refuse(codes::BAD_PROTOCOL, &format!("this relay speaks protocol {}", dray_relay::PROTOCOL)))).await;
                return log!("bridge.refused", peer = peer, reason = "bad_protocol", protocol = protocol);
            }
            let verified = dray_relay::decode_key(&public).zip(dray_relay::decode_key(&signature)).filter(|(k, s)| {
                ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, k)
                    .verify(&dray_relay::attach_message(&nonce), s)
                    .is_ok()
            });
            match verified {
                Some((k, _)) => (k, version),
                None => {
                    let _ = sink.send(text(&refuse(codes::BAD_SIGNATURE, "the signature does not match the key"))).await;
                    return log!("bridge.refused", peer = peer, reason = "bad_signature");
                }
            }
        }
        Ok(_) => return log!("bridge.refused", peer = peer, reason = "no_attach"),
        Err(_) => return log!("bridge.refused", peer = peer, reason = "attach_timeout"),
    };
    let id = dray_relay::server_id(&public_key);
    if relay.draining.load(Ordering::SeqCst) {
        let _ = sink.send(text(&refuse(codes::DRAINING, "this relay is restarting"))).await;
        return log!("bridge.refused", id = id, peer = peer, reason = "draining");
    }
    // Checked after the signature, so the log names a real server.
    let Some(label) = relay.keys.label(key.as_deref()) else {
        let _ = sink.send(text(&refuse(codes::NOT_ALLOWED, "this relay URL carries no key it knows"))).await;
        return log!("bridge.refused", id = id, peer = peer, reason = "not_allowed");
    };

    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<Control>();
    let (data_tx, mut data_rx) = mpsc::channel::<Ordered>(64);
    let (stop_tx, mut stop_rx) = watch::channel(None);
    let session = relay.registry.sessions.fetch_add(1, Ordering::Relaxed);
    let bridge = Arc::new(Bridge {
        session,
        id: id.clone(),
        out: Outbound { control: control_tx.clone(), data: data_tx },
        streams: Streams::default(),
        next_conn: AtomicU32::new(1),
        stop: stop_tx,
    });
    // Queued before the bridge is findable: a visitor held for this server
    // wakes on the insert and its `open` must not reach the server first.
    let hostname = format!("{id}.{}", relay.zone);
    let attached = Control::Attached { id: id.clone(), hostname, port: relay.public_port, instance: relay.instance.clone() };
    let _ = control_tx.send(attached);
    // The newest attach wins: an old one still registered is usually a socket
    // that died without a close, which the server has already given up on.
    let replaced = relay.registry.map().insert(id.clone(), bridge.clone());
    if let Some(old) = &replaced {
        let _ = old.stop.send(Some("replaced by a newer attach".into()));
    }
    relay.registry.attached.notify_waiters();
    log!("bridge.attach", id = id, key = label, version = version, peer = peer, session = session, replaced = replaced.is_some());

    // Its own task, so a server slow to read never stops this one reading.
    let (wrote_tx, mut wrote_rx) = tokio::sync::oneshot::channel::<String>();
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
                else => break "closed".to_string(),
            };
            if let Err(e) = sink.send(msg).await {
                break format!("write: {e}");
            }
        };
        let _ = sink.close().await;
        let _ = wrote_tx.send(why);
    });

    let mut heard = tokio::time::Instant::now();
    let reason = loop {
        tokio::select! {
            msg = stream.next() => {
                heard = tokio::time::Instant::now();
                match msg {
                    Some(Ok(Message::Binary(frame))) => {
                        let Some((conn, payload)) = dray_relay::decode_data(&frame) else { continue };
                        if !bridge.streams.data(conn, payload) {
                            let _ = control_tx.send(Control::Reset { conn, reason: "window exceeded".into() });
                        }
                    }
                    Some(Ok(Message::Text(t))) => match serde_json::from_str::<Control>(&t) {
                        Ok(Control::Window { conn, bytes }) => bridge.streams.window(conn, bytes),
                        Ok(Control::End { conn }) => bridge.streams.end(conn),
                        Ok(Control::Reset { conn, .. }) => bridge.streams.reset(conn),
                        Ok(Control::Certify { csr }) => certify(&relay, &id, csr, control_tx.clone()),
                        _ => {}
                    },
                    Some(Ok(Message::Close(frame))) => break format!("closed by server: {}", frame.map(|f| f.to_string()).unwrap_or_default()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break format!("read: {e}"),
                    None => break "eof".into(),
                }
            }
            _ = tokio::time::sleep_until(heard + dray_relay::IDLE_TIMEOUT) => break format!("silent {}s", dray_relay::IDLE_TIMEOUT.as_secs()),
            why = &mut wrote_rx => break why.unwrap_or_else(|_| "writer ended".into()),
            _ = stop_rx.changed() => break stop_rx.borrow().clone().unwrap_or_default(),
        }
    };
    writer.abort();
    {
        let mut map = relay.registry.map();
        if map.get(&id).is_some_and(|b| b.session == session) {
            map.remove(&id);
        }
    }
    let streams = bridge.streams.len();
    bridge.streams.reset_all();
    log!("bridge.drop", id = id, session = session, reason = reason, after_s = started.elapsed().as_secs(), streams = streams);
}

fn certify(relay: &Arc<Relay>, id: &str, csr: String, reply: mpsc::UnboundedSender<Control>) {
    let (relay, id) = (relay.clone(), id.to_string());
    tokio::spawn(async move {
        let hostname = format!("{id}.{}", relay.zone);
        let answer = match relay.issuing.issue(&id, &hostname, &csr).await {
            Ok(chain) => Control::Certificate { chain },
            Err(reason) => Control::CertificateError { reason },
        };
        let _ = reply.send(answer);
    });
}

fn text(c: &Control) -> Message {
    Message::Text(serde_json::to_string(c).expect("controls serialize").into())
}

pub fn random<const N: usize>() -> [u8; N] {
    use ring::rand::SecureRandom;
    let mut out = [0u8; N];
    ring::rand::SystemRandom::new().fill(&mut out).expect("system randomness");
    out
}
