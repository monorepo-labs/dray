//! Remote access: this machine as a Dray server, reached through an
//! OpenTunnel address that stays the same across restarts ([`crate::tunnel`]),
//! or through Dray's own relay where one is configured ([`crate::relay`]).
//! On a Mac the server runs a listener of its own for it, apart from the
//! app's, so a remote Mac is never handed the host calls; `dray-serve` fronts
//! the listener it already has ([`fronts`]). See TUNNEL-PLAN.md.
//!
//! Or, where the reader picked it, over their own tailnet alone
//! ([`crate::tailscale`], #1712): the relay and tunnel are taken down, and a
//! phone with Tailscale off reaches nothing.

use std::{future::Future, path::PathBuf, sync::LazyLock, sync::OnceLock, time::Duration};

use serde::Serialize;
use std::sync::Mutex;
use ts_rs::TS;

use crate::{serve, sink::Sink, store, tunnel};

/// What the This Mac row draws. No token: it is asked for on Copy, and never
/// stored in the webview.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccess {
    pub on: bool,
    /// Over Tailscale rather than Dray's relay. A server from before #1712
    /// sends none, which a client reads as the relay.
    pub tailscale: bool,
    /// `wss://…`, once the relay has it attached.
    pub address: Option<String>,
    /// Why this Mac is not answering, while on.
    pub error: Option<String>,
    /// What Tailscale still wants on this machine, while on over it.
    pub need: Option<crate::tailscale::TailscaleNeed>,
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

/// Wakes the tailnet loop to look again now, after a fix.
static KICK: tokio::sync::Notify = tokio::sync::Notify::const_new();

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
///
/// `tailscale` picks the way in, kept where it is when absent; switching it
/// changes the address, so every device pairs again.
pub fn set_remote_access(
    sink: Sink,
    on: bool,
    tailscale: Option<bool>,
) -> std::pin::Pin<Box<dyn Future<Output = Result<RemoteAccess, String>> + Send>> {
    Box::pin(async move {
        let _held = SWITCHING.lock().await;
        crate::settings::update(|s| {
            s.remote_access = on;
            if let Some(tailscale) = tailscale {
                s.remote_tailscale = tailscale;
            }
        })
        .await
        .map_err(|e| format!("{e:#}"))?;
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

/// Sees to what Tailscale still wants here, where Dray can, then looks again
/// at once. Answers a sign-in page for the reader to open.
pub async fn remote_access_fix() -> Result<Option<String>, String> {
    let page = crate::tailscale::fix().await;
    KICK.notify_one();
    page
}

/// The phone's pairing QR, as SVG: [`dray_proto::pair_link`] for this
/// address. It carries the token, so it is asked for when the reader opens it,
/// the same as Copy.
pub async fn remote_access_qr() -> Result<String, String> {
    let address = get_remote_access().address.ok_or("Remote access has no address yet")?;
    let token = remote_access_token().await?;
    let name = tokio::task::spawn_blocking(dray_proto::machine_name).await.map_err(|e| e.to_string())?;
    let code = qrcode::QrCode::new(dray_proto::pair_link(&address, &token, &name)).map_err(|e| e.to_string())?;
    Ok(code.render::<qrcode::render::svg::Color>().min_dimensions(176, 176).build())
}

/// Stops whatever is serving and, if `on`, starts afresh. Dropping the task
/// drops the listener and every connection it holds. Callers hold
/// [`SWITCHING`].
async fn switch(sink: &Sink, on: bool) {
    let tailscale = crate::settings::read().await.remote_tailscale;
    let old = {
        let mut state = state();
        state.0 = RemoteAccess { on, tailscale, ..Default::default() };
        state.1.take()
    };
    if let Some(task) = old {
        task.abort();
        // Until it is dropped, so the listener is gone before the next bind.
        let _ = task.await;
    }
    tunnel::withdraw(tunnel::REMOTE, ROUTE, None).await;
    crate::relay::withdraw().await;
    crate::tailscale::unserve().await;
    WRITTEN.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Ok(file) = tunnel_file().await {
        let _ = tokio::fs::remove_file(file).await;
    }
    if on {
        let task = tokio::spawn(serve_and_tunnel(sink.clone(), tailscale));
        state().1 = Some(task);
        // A machine reachable remotely is one a phone may ask to share from.
        // Not one kept to a tailnet: a share is a public address.
        if !tailscale {
            tokio::spawn(tunnel::warm(tunnel::SHARE));
        }
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

/// [`set`] for the tailnet loop, which looks every few seconds: only a
/// change is announced.
fn set_tailnet(sink: &Sink, address: Option<String>, error: Option<String>, need: Option<crate::tailscale::TailscaleNeed>) {
    let changed = {
        let mut state = state();
        let next = RemoteAccess { address, error, need, ..state.0.clone() };
        std::mem::replace(&mut state.0, next.clone()) != next
    };
    if changed {
        announce(sink);
    }
}

/// Serves `port` on the tailnet and keeps it served: Tailscale signed out,
/// stopped or reconfigured underneath is noticed within [`TAILNET_LOOK`] and
/// put back once it can be.
async fn tailnet(sink: &Sink, port: u16, file: &std::path::Path) {
    use crate::tailscale::{self, TailscaleNeed};
    let mut served: Option<String> = None;
    // Tailscale's page to turn HTTPS on, asked of `serve` once: it waits on
    // the reader for as long as it is let.
    let mut https_page: Option<Option<String>> = None;
    loop {
        let now = match tailscale::check().await {
            Ok(host) => tailscale::serve(&host, port).await.map(|()| host),
            Err(TailscaleNeed::Https { url: None }) => {
                if https_page.is_none() {
                    let asked = match tailscale::host().await {
                        Some(host) => tailscale::serve(&host, port).await,
                        None => Err(Ok(TailscaleNeed::Https { url: None })),
                    };
                    https_page = Some(match asked {
                        Err(Ok(TailscaleNeed::Https { url })) => url,
                        _ => None,
                    });
                }
                Err(Ok(TailscaleNeed::Https { url: https_page.clone().flatten() }))
            }
            Err(need) => Err(Ok(need)),
        };
        match now {
            Ok(host) => {
                let url = format!("https://{host}");
                if served.as_deref() != Some(&url) {
                    let _ = store::write_atomic(file, format!("{url}\n")).await;
                    *WRITTEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(file.to_path_buf());
                    tunnel::log("tailscale", &format!("serving at {url}"));
                    if ASKED.swap(false, std::sync::atomic::Ordering::Relaxed) {
                        crate::analytics::feature_used("remote_access");
                    }
                    served = Some(url.clone());
                }
                set_tailnet(sink, Some(url.replacen("https://", "wss://", 1)), None, None);
            }
            Err(blocked) => {
                if served.take().is_some() {
                    let _ = tokio::fs::remove_file(file).await;
                    tunnel::log("tailscale", "stopped serving");
                }
                match blocked {
                    Ok(need) => set_tailnet(sink, None, None, Some(need)),
                    Err(e) => set_tailnet(sink, None, Some(e), None),
                }
            }
        }
        let wait = if served.is_some() { TAILNET_LOOK } else { Duration::from_secs(4) };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = KICK.notified() => {}
        }
    }
}

/// How often a served tailnet address is looked at again.
const TAILNET_LOOK: Duration = Duration::from_secs(15);

async fn serve_and_tunnel(sink: Sink, tailscale: bool) {
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
        if tailscale {
            return tailnet(&sink, port, &file).await;
        }
        let mut backoff = Duration::from_secs(2);
        loop {
            let target = format!("127.0.0.1:{port}");
            // Read each try, so writing `relay-url` takes effect on the next.
            let relay = crate::relay::configured().await;
            let exposed = match &relay {
                Some(base) => crate::relay::expose(base.clone(), target).await,
                None => tunnel::expose(tunnel::REMOTE, ROUTE, target).await,
            };
            match exposed {
                Ok(url) => {
                    let _ = store::write_atomic(&file, format!("{url}\n")).await;
                    *WRITTEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(file.clone());
                    let address = url.replacen("https://", "wss://", 1);
                    set(&sink, Some(address.clone()), None);
                    if ASKED.swap(false, std::sync::atomic::Ordering::Relaxed) {
                        crate::analytics::feature_used("remote_access");
                    }
                    backoff = Duration::from_secs(2);
                    match relay {
                        Some(_) => follow_relay(&sink, &address).await,
                        None => follow(&sink, &address).await,
                    }
                }
                Err(e) => {
                    let profile = if relay.is_some() { "relay" } else { tunnel::REMOTE };
                    tunnel::log(profile, &format!("could not open, trying again in {}s: {e:#}", backoff.as_secs()));
                    set(&sink, None, Some(format!("{e:#}")));
                }
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

/// [`follow`] for the relay's bridge, which also reconnects on its own
/// under the same address.
async fn follow_relay(sink: &Sink, address: &str) {
    use crate::relay::State;
    let Some(mut status) = crate::relay::status().await else { return };
    let mut drawn = None;
    loop {
        let now = status.borrow_and_update().clone();
        if drawn.replace(now.state.clone()) != Some(now.state.clone()) {
            match now.state {
                State::Connected => set(sink, Some(address.into()), None),
                State::Stopped => {
                    let why = now.last_error.unwrap_or_default();
                    return set(sink, None, Some(format!("The relay stopped: {why}. Starting it again.")));
                }
                State::Connecting | State::Reconnecting => {
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
