//! Remote access: this Mac as a Dray server, reached through a Cloudflare
//! quick tunnel. The app runs the same listener `dray-serve` runs, in this
//! process and on `127.0.0.1`, so another Mac connects to the very sessions
//! on this screen — one process, one data dir, no second writer. See
//! TUNNEL-PLAN.md.

use std::{path::PathBuf, sync::LazyLock, time::Duration};

use serde::Serialize;
use std::sync::Mutex;
use ts_rs::TS;

use crate::{serve, share, sink::Sink, store};

/// What the This Mac row draws. No token: it is asked for on Copy, and never
/// stored in the webview.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccess {
    pub on: bool,
    /// `wss://…`, once the tunnel is registered and in DNS.
    pub address: Option<String>,
    /// Why this Mac is not answering, while on.
    pub error: Option<String>,
}

static STATE: LazyLock<Mutex<(RemoteAccess, Option<tokio::task::JoinHandle<()>>)>> = LazyLock::new(Default::default);

fn state() -> std::sync::MutexGuard<'static, (RemoteAccess, Option<tokio::task::JoinHandle<()>>)> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A dev build serves beside the release app, as its socket does.
fn port() -> u16 {
    if crate::is_dev() { dray_proto::SERVE_PORT + 1 } else { dray_proto::SERVE_PORT }
}

/// Where the address lives for the Origin check. The two builds share
/// `~/.dray`, so each keeps its own.
async fn tunnel_file() -> anyhow::Result<PathBuf> {
    let name = if crate::is_dev() { "tunnel-url-dev" } else { dray_proto::TUNNEL_URL_FILE };
    Ok(store::get_home_app_dir().await?.join(name))
}

/// Held across a whole change, the saved setting included. Two presses racing
/// otherwise interleave across `switch`'s awaits, and an "on" finishing after
/// an "off" starts serving while the row says it is off.
static SWITCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The running cloudflared and the address file it backs, for [`stop_on_exit`].
static TUNNEL: Mutex<Option<(u32, PathBuf)>> = Mutex::new(None);

/// Serves at launch if the switch was left on.
pub async fn start(sink: Sink) {
    let _held = SWITCHING.lock().await;
    if crate::settings::read().await.remote_access {
        switch(&sink, true).await;
    }
}

/// Takes the tunnel down on quit. The app leaves through `_exit`, which runs
/// no destructor, so `kill_on_drop` never fires and cloudflared would outlive
/// it, still answering at an address nobody shows.
pub fn stop_on_exit() {
    if let Some((pid, file)) = TUNNEL.lock().unwrap_or_else(|e| e.into_inner()).take() {
        // SIGKILL: on SIGTERM cloudflared drains for its 30s grace period,
        // serving the address all the while.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        let _ = std::fs::remove_file(file);
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_remote_access() -> RemoteAccess {
    state().0.clone()
}

/// The switch on the This Mac row. Remembered, so the app serves again
/// whenever it opens.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_remote_access(sink: Sink, on: bool) -> Result<RemoteAccess, String> {
    let _held = SWITCHING.lock().await;
    crate::settings::update(|s| s.remote_access = on).await.map_err(|e| format!("{e:#}"))?;
    switch(&sink, on).await;
    Ok(get_remote_access())
}

/// The token another Mac's Add server asks for. Asked for on Copy alone, so
/// it sits in no state the webview keeps.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn remote_access_token() -> Result<String, String> {
    let (token, _) = serve::mint_token().await.map_err(|e| format!("{e:#}"))?;
    Ok(token)
}

/// Stops whatever is serving and, if `on`, starts afresh: a new listener and
/// a new tunnel. Dropping the task drops the listener, every connection it
/// holds and cloudflared with it. Callers hold [`SWITCHING`].
async fn switch(sink: &Sink, on: bool) {
    let old = {
        let mut state = state();
        state.0 = RemoteAccess { on, address: None, error: None };
        state.1.take()
    };
    if let Some(task) = old {
        task.abort();
        // Until it is dropped, so the port is free before the next bind.
        let _ = task.await;
    }
    TUNNEL.lock().unwrap_or_else(|e| e.into_inner()).take();
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
    let port = port();
    let prepared = async {
        let (token, _) = serve::mint_token().await.map_err(|e| format!("{e:#}"))?;
        let file = tunnel_file().await.map_err(|e| format!("{e:#}"))?;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
            format!("Port {port} is taken ({e}). A dray-serve running on this Mac holds it; stop it and turn this on again.")
        })?;
        Ok::<_, String>((token, file, listener))
    };
    let (token, file, listener) = match prepared.await {
        Ok(ready) => ready,
        Err(e) => return set(&sink, None, Some(e)),
    };
    let listening = serve::listen(listener, serve::HUB.clone(), sink.clone(), token.into(), file.clone().into());
    let tunnel = async {
        let mut backoff = Duration::from_secs(2);
        loop {
            match share::quick_tunnel(&format!("http://127.0.0.1:{port}"), &[]).await {
                Ok((mut child, url)) => {
                    if let Some(pid) = child.id() {
                        *TUNNEL.lock().unwrap_or_else(|e| e.into_inner()) = Some((pid, file.clone()));
                    }
                    let _ = tokio::fs::write(&file, format!("{url}\n")).await;
                    set(&sink, Some(url.replacen("https://", "wss://", 1)), None);
                    backoff = Duration::from_secs(2);
                    let _ = child.wait().await;
                    // Its pid may be anybody's now.
                    TUNNEL.lock().unwrap_or_else(|e| e.into_inner()).take();
                    let _ = tokio::fs::remove_file(&file).await;
                    set(&sink, None, Some("The tunnel dropped. Starting a new one, under a new address.".into()));
                }
                Err(e) => set(&sink, None, Some(e)),
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    };
    tokio::select! {
        served = listening => {
            let why = served.err().map(|e| format!("{e:#}")).unwrap_or_default();
            set(&sink, None, Some(format!("This Mac stopped serving: {why}")));
        }
        () = tunnel => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    /// This process serving through a real quick tunnel, in a throwaway
    /// `DRAY_HOME`: a client admitted at the address, a call answered, an
    /// event the core emits reaching it, and off dropping it.
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
        // The cloudflared an earlier share downloaded, rather than another.
        let version = std::path::Path::new(dray_proto::CLOUDFLARED_VERSION);
        let downloaded = std::env::home_dir().unwrap().join(".dray/cloudflared").join(version);
        std::fs::create_dir_all(home.join("cloudflared")).unwrap();
        let _ = std::os::unix::fs::symlink(downloaded, home.join("cloudflared").join(version));
        let sink = Sink::new(|_, _| {});

        let t0 = std::time::Instant::now();
        switch(&sink, true).await;
        let address = loop {
            let now = get_remote_access();
            if let Some(address) = now.address {
                break address;
            }
            assert!(now.error.is_none() || t0.elapsed() < Duration::from_secs(5), "{:?}", now.error);
            assert!(t0.elapsed() < Duration::from_secs(60), "no address");
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        eprintln!("address in {:?}", t0.elapsed());
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

        // Quit's path: cloudflared killed and the address gone, by hand.
        let (pid, file) = TUNNEL.lock().unwrap().clone().expect("a tunnel is recorded");
        stop_on_exit();
        assert!(!file.exists(), "quit removes the address");
        tokio::time::sleep(Duration::from_millis(500)).await;
        // Gone, or a zombie this process has not reaped yet.
        let stat = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let stat = String::from_utf8_lossy(&stat.stdout);
        assert!(stat.trim().is_empty() || stat.starts_with('Z'), "quit kills cloudflared: {stat}");

        switch(&sink, false).await;
        let closed = tokio::time::timeout(Duration::from_secs(10), async { while let Some(Ok(_)) = ws.next().await {} }).await;
        assert!(closed.is_ok(), "off drops the client");
        assert!(!home.join("tunnel-url-dev").exists() && !home.join("tunnel-url").exists());
    }
}
