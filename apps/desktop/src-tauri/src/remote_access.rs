//! Remote access: this machine as a Dray server, reached through an
//! OpenTunnel address that stays the same across restarts ([`crate::tunnel`]).
//! On a Mac the server runs a listener of its own for it, apart from the
//! app's, so a remote Mac is never handed the host calls; `dray-serve` fronts
//! the listener it already has ([`fronts`]). See TUNNEL-PLAN.md.

use std::{future::Future, path::PathBuf, sync::LazyLock, sync::OnceLock, time::Duration};

use serde::Serialize;
use std::sync::Mutex;
use ts_rs::TS;

use crate::{serve, sink::Sink, store, tunnel};

/// What the This Mac row draws. No token: it is asked for on Copy, and never
/// stored in the webview.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccess {
    pub on: bool,
    /// `wss://…`, once the relay has it attached.
    pub address: Option<String>,
    /// Why this Mac is not answering, while on.
    pub error: Option<String>,
}

static STATE: LazyLock<Mutex<(RemoteAccess, Option<tokio::task::JoinHandle<()>>)>> = LazyLock::new(Default::default);

fn state() -> std::sync::MutexGuard<'static, (RemoteAccess, Option<tokio::task::JoinHandle<()>>)> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// The route's label on the [`tunnel::REMOTE`] tunnel.
const ROUTE: &str = "remote";

/// The port `dray-serve` already listens on, which the tunnel fronts instead
/// of a listener of its own.
static FRONTED: OnceLock<u16> = OnceLock::new();

/// Fronts `port` rather than binding a listener for Remote access.
pub fn fronts(port: u16) {
    let _ = FRONTED.set(port);
}

/// Where the address lives, for the Origin check and an SSH login to read.
async fn tunnel_file() -> anyhow::Result<PathBuf> {
    Ok(store::get_home_app_dir().await?.join(dray_proto::TUNNEL_URL_FILE))
}

/// Held across a whole change, the saved setting included. Two presses racing
/// otherwise interleave across `switch`'s awaits, and an "on" finishing after
/// an "off" starts serving while the row says it is off.
static SWITCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Somebody turned Remote access on, and its address has not attached yet. A
/// launch serving from the saved setting is no new use, so it reports nothing.
static ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The address file while one is written, for [`stop_on_exit`].
static WRITTEN: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Serves at launch if the switch was left on.
pub async fn start(sink: Sink) {
    let _held = SWITCHING.lock().await;
    if crate::settings::read().await.remote_access {
        switch(&sink, true).await;
    }
}

/// Removes the address on quit, which leaves through `_exit` and runs no
/// destructor. The tunnel goes with the process.
pub fn stop_on_exit() {
    if let Some(file) = WRITTEN.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = std::fs::remove_file(file);
    }
}

pub fn get_remote_access() -> RemoteAccess {
    state().0.clone()
}

/// The switch on the This Mac row. Remembered, so the server serves again
/// whenever it starts.
///
/// Boxed behind a named type: it starts a listener whose connections
/// dispatch back here, and an `async fn` would be a future containing itself.
pub fn set_remote_access(sink: Sink, on: bool) -> std::pin::Pin<Box<dyn Future<Output = Result<RemoteAccess, String>> + Send>> {
    Box::pin(async move {
        let _held = SWITCHING.lock().await;
        crate::settings::update(|s| s.remote_access = on).await.map_err(|e| format!("{e:#}"))?;
        ASKED.store(on, std::sync::atomic::Ordering::Relaxed);
        switch(&sink, on).await;
        Ok(get_remote_access())
    })
}

/// The token another Mac's Add server asks for. Asked for on Copy alone, so
/// it sits in no state the webview keeps.
pub async fn remote_access_token() -> Result<String, String> {
    let (token, _) = serve::mint_token().await.map_err(|e| format!("{e:#}"))?;
    Ok(token)
}

/// Stops whatever is serving and, if `on`, starts afresh. Dropping the task
/// drops the listener and every connection it holds. Callers hold
/// [`SWITCHING`].
async fn switch(sink: &Sink, on: bool) {
    let old = {
        let mut state = state();
        state.0 = RemoteAccess { on, address: None, error: None };
        state.1.take()
    };
    if let Some(task) = old {
        task.abort();
        // Until it is dropped, so the listener is gone before the next bind.
        let _ = task.await;
    }
    tunnel::withdraw(tunnel::REMOTE, ROUTE, None).await;
    WRITTEN.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Ok(file) = tunnel_file().await {
        let _ = tokio::fs::remove_file(file).await;
    }
    if on {
        let task = tokio::spawn(serve_and_tunnel(sink.clone()));
        state().1 = Some(task);
    }
    announce(sink);
}

fn announce(sink: &Sink) {
    let _ = sink.emit("remote_access_changed", get_remote_access());
}

fn set(sink: &Sink, address: Option<String>, error: Option<String>) {
    {
        let mut state = state();
        state.0.address = address;
        state.0.error = error;
    }
    announce(sink);
}

async fn serve_and_tunnel(sink: Sink) {
    let prepared = async {
        let file = tunnel_file().await.map_err(|e| format!("{e:#}"))?;
        if let Some(&port) = FRONTED.get() {
            return Ok::<_, String>((port, file, None));
        }
        let (token, _) = serve::mint_token().await.map_err(|e| format!("{e:#}"))?;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("could not listen: {e}"))?;
        let port = listener.local_addr().map_err(|e| format!("could not listen: {e}"))?.port();
        let listening = serve::listen(listener, serve::HUB.clone(), sink.clone(), token.into(), file.clone().into(), false);
        Ok((port, file, Some(listening)))
    };
    let (port, file, listening) = match prepared.await {
        Ok(ready) => ready,
        Err(e) => return set(&sink, None, Some(e)),
    };
    let tunnel = async {
        let mut backoff = Duration::from_secs(2);
        loop {
            match tunnel::expose(tunnel::REMOTE, ROUTE, format!("127.0.0.1:{port}")).await {
                Ok(url) => {
                    let _ = store::write_atomic(&file, format!("{url}\n")).await;
                    *WRITTEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(file.clone());
                    let address = url.replacen("https://", "wss://", 1);
                    set(&sink, Some(address.clone()), None);
                    if ASKED.swap(false, std::sync::atomic::Ordering::Relaxed) {
                        crate::analytics::feature_used("remote_access");
                    }
                    backoff = Duration::from_secs(2);
                    follow(&sink, &address).await;
                }
                Err(e) => set(&sink, None, Some(format!("{e:#}"))),
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    };
    match listening {
        Some(listening) => tokio::select! {
            served = listening => {
                let why = served.err().map(|e| format!("{e:#}")).unwrap_or_default();
                set(&sink, None, Some(format!("This Mac stopped serving: {why}")));
            }
            () = tunnel => {}
        },
        None => tunnel.await,
    }
}

/// Draws the relay dropping and coming back, which the tunnel does on its
/// own under the same address. Returns once it has stopped for good.
async fn follow(sink: &Sink, address: &str) {
    let Some(mut status) = tunnel::status(tunnel::REMOTE).await else { return };
    let mut drawn = None;
    loop {
        let now = status.borrow_and_update().clone();
        // The status moves with every connection too; only the state is news.
        if drawn.replace(now.state.clone()) != Some(now.state.clone()) {
            match now.state {
                opentunnel::State::Connected => set(sink, Some(address.into()), None),
                opentunnel::State::Stopped => {
                    let why = now.last_error.unwrap_or_default();
                    return set(sink, None, Some(format!("The tunnel stopped: {why}. Starting it again.")));
                }
                _ => {
                    let why = now.last_error.map(|e| format!(": {e}")).unwrap_or_default();
                    set(sink, Some(address.into()), Some(format!("Reconnecting to the relay{why}")));
                }
            }
        }
        if status.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(all(test, feature = "desktop"))]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    /// This process serving through a real tunnel, in a throwaway
    /// `DRAY_HOME`: a client admitted at the address, an event the core emits
    /// reaching it, off dropping it, and on again answering the same address.
    ///
    /// ```text
    /// cargo test remote_access::tests::serves_through_a_tunnel -- --ignored --nocapture
    /// ```
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn serves_through_a_tunnel() {
        let home = std::env::temp_dir().join(format!("dray-remote-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("DRAY_HOME", &home);
        let sink = Sink::new(|_, _| {});
        let wait_for_address = || async {
            let t0 = std::time::Instant::now();
            loop {
                let now = get_remote_access();
                if let (Some(address), None) = (now.address, &now.error) {
                    return address;
                }
                assert!(t0.elapsed() < Duration::from_secs(120), "no address: {:?}", now.error);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        };

        let t0 = std::time::Instant::now();
        switch(&sink, true).await;
        let address = wait_for_address().await;
        eprintln!("address {address} in {:?}", t0.elapsed());
        assert!(address.starts_with("wss://") && address.ends_with(".opentunnel.xyz"), "{address}");
        let file = home.join(dray_proto::TUNNEL_URL_FILE);
        assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), address.replacen("wss://", "https://", 1));
        let token = remote_access_token().await.unwrap();

        let (mut ws, _) = tokio_tungstenite::connect_async(&address).await.unwrap();
        ws.send(Message::text(format!(r#"{{"v":1,"token":"{token}"}}"#))).await.unwrap();
        let mut texts = Vec::new();
        while texts.len() < 2 {
            if let Some(Ok(Message::Text(text))) = ws.next().await {
                texts.push(text.to_string());
            }
        }
        assert_eq!(texts[0], r#"{"v":1}"#);
        assert!(texts[1].contains("live_state"));
        eprintln!("admitted in {:?}", t0.elapsed());
        serve::HUB.publish("session_title", &serde_json::json!({ "sessionId": "s", "title": "from the core" }));
        loop {
            if let Some(Ok(Message::Text(text))) = ws.next().await {
                assert!(text.contains("from the core"), "an event the core emits reaches the client: {text}");
                break;
            }
        }

        switch(&sink, false).await;
        let closed = tokio::time::timeout(Duration::from_secs(10), async { while let Some(Ok(_)) = ws.next().await {} }).await;
        assert!(closed.is_ok(), "off drops the client");
        assert!(!file.exists(), "off removes the address");

        switch(&sink, true).await;
        assert_eq!(wait_for_address().await, address, "on again, the same address");
        switch(&sink, false).await;
    }
}
