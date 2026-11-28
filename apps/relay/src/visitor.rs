//! The visitor door: raw TLS in, routed by SNI to the server's bridge. The
//! relay holds no key for these names, so it can read nothing past the hello.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use dray_relay::Control;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

use crate::{bridge::MAX_STREAMS, log, sni, Relay};

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn listen(relay: Arc<Relay>, listener: TcpListener) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                log!("visitor.accept_failed", reason = e);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        tokio::spawn(visit(relay.clone(), stream, peer.to_string()));
    }
}

async fn visit(relay: Arc<Relay>, mut stream: TcpStream, peer: String) {
    let started = Instant::now();
    let (hello, sni) = match tokio::time::timeout(HELLO_TIMEOUT, sni::read_hello(&mut stream)).await {
        Ok(Ok(read)) => read,
        Ok(Err(reason)) => return log!("visitor.refused", peer = peer, reason = reason),
        Err(_) => return log!("visitor.refused", peer = peer, reason = "hello_timeout"),
    };
    let Some((_route, id)) = dray_relay::split_host(&sni, &relay.zone) else {
        return log!("visitor.refused", peer = peer, sni = sni, reason = "not_a_server_address");
    };
    let Some(bridge) = relay.registry.wait_for(id, dray_relay::HOLD).await else {
        return log!("visitor.miss", id = id, peer = peer, waited_ms = started.elapsed().as_millis());
    };
    if bridge.streams.len() >= MAX_STREAMS {
        return log!("visitor.refused", id = id, peer = peer, reason = "too_many_streams");
    }
    let conn = bridge.next_conn();
    let opened = bridge.streams.open(conn);
    let _ = bridge.out.control.send(Control::Open { conn, peer: peer.clone(), sni: sni.clone() });
    let held_ms = started.elapsed().as_millis();
    let io = Prefixed { head: hello, at: 0, inner: stream };
    let ended = bridge.streams.pump(opened, io, bridge.out.clone()).await;
    let after_s = started.elapsed().as_secs();
    match ended {
        Ok((up, down)) => log!("visitor.close", id = id, conn = conn, peer = peer, up = up, down = down, after_s = after_s, held_ms = held_ms),
        Err(e) => log!("visitor.close", id = id, conn = conn, peer = peer, after_s = after_s, held_ms = held_ms, reason = format!("{e:?}")),
    }
}

/// The visitor's socket with the hello already read put back in front.
struct Prefixed {
    head: Vec<u8>,
    at: usize,
    inner: TcpStream,
}

impl AsyncRead for Prefixed {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.at < self.head.len() {
            let n = (self.head.len() - self.at).min(buf.remaining());
            let at = self.at;
            buf.put_slice(&self.head[at..at + n]);
            self.at += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for Prefixed {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
