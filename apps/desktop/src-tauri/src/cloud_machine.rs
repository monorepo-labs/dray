//! Dray Cloud on the machine's side (#857): a `dray-serve` on the boat sandbox
//! the control plane started for one task. It names its sandbox and keeps it
//! up while it works.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where the control plane leaves its address and this machine's secret, at
/// create.
const CLOUD_FILE: &str = "cloud.json";

const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);

/// This sandbox's id, or `None` off boat. `BOAT_ID` is set for a login alone,
/// and the systemd unit that runs `dray-serve` is not one, so it is read
/// through a login shell, once, at start.
pub async fn boat_id() -> Option<String> {
    if let Some(id) = std::env::var("BOAT_ID").ok().filter(|id| sandbox_id(id)) {
        return Some(id);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // Behind a marker, since an rc file is free to print on its own.
    let run = tokio::process::Command::new(shell)
        .args(["-l", "-c", "echo __DRAY_BOAT__; printenv BOAT_ID"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(10), run).await.ok()?.ok()?;
    let out = String::from_utf8(out.stdout).ok()?;
    let id = out.rsplit_once("__DRAY_BOAT__\n")?.1.trim();
    sandbox_id(id).then(|| id.to_string())
}

/// boat's id shape, `bx_` and a few letters. Checked because the value lands
/// in a file and in a request.
fn sandbox_id(id: &str) -> bool {
    id.len() <= 64
        && id.strip_prefix("bx_").is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

#[derive(Deserialize)]
struct CloudFile {
    url: String,
    secret: String,
}

/// Tells the control plane, every minute, whether this machine is working, so
/// a busy one keeps pushing its auto-stop out. Runs for the life of the
/// server; `cloud.json` is read per beat, so one written after start counts.
pub async fn heartbeat(home: PathBuf, sandbox: String) {
    let mut every = tokio::time::interval(HEARTBEAT_EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Said once per change, not once a minute.
    let mut last = String::new();
    loop {
        every.tick().await;
        let busy = crate::session::manager().busy().await;
        let said = match beat(&home, &sandbox, busy).await {
            Ok(true) => "ok".to_string(),
            Ok(false) => continue,
            Err(e) => format!("{e:#}"),
        };
        if said != last {
            eprintln!("[cloud] heartbeat: {said}");
            last = said;
        }
    }
}

/// One `POST <url>/heartbeat`. `Ok(false)` where this home has no `cloud.json`.
async fn beat(home: &Path, sandbox: &str, busy: bool) -> Result<bool> {
    let Ok(text) = tokio::fs::read_to_string(home.join(CLOUD_FILE)).await else {
        return Ok(false);
    };
    let cloud: CloudFile = serde_json::from_str(&text).context("cloud.json is not {url, secret}")?;
    let url = format!("{}/heartbeat", cloud.url.trim_end_matches('/'));
    let answer = crate::http()
        .post(&url)
        .bearer_auth(cloud.secret.trim())
        .json(&serde_json::json!({ "sandbox": sandbox, "busy": busy }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .with_context(|| format!("could not reach {url}"))?;
    if !answer.status().is_success() {
        anyhow::bail!("{url} answered {}", answer.status());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dray-cloud-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        dir
    }

    #[test]
    fn only_a_boat_id_is_taken() {
        assert!(sandbox_id("bx_23456789"));
        for bad in ["", "bx_", "23456789", "bx_23 456", "bx_../x", &format!("bx_{}", "a".repeat(80))] {
            assert!(!sandbox_id(bad), "{bad:?}");
        }
    }

    /// The heartbeat as a control plane receives it, off a local listener.
    #[tokio::test]
    async fn a_beat_posts_the_sandbox_and_whether_it_is_busy() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let home = temp_home();
        assert!(!beat(&home, "bx_23456789", true).await.unwrap(), "no cloud.json, no beat");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(
            home.join(CLOUD_FILE),
            format!(r#"{{"url":"http://127.0.0.1:{port}/api/cloud/","secret":"machine-secret"}}"#),
        )
        .unwrap();
        let received = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            // Head and body: the body is the JSON object, so read to its close.
            while !request.ends_with(b"}") {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0, "closed early");
                request.extend_from_slice(&buf[..n]);
            }
            socket.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").await.unwrap();
            String::from_utf8(request).unwrap()
        });

        assert!(beat(&home, "bx_23456789", true).await.unwrap());
        let request = received.await.unwrap();
        let (head, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /api/cloud/heartbeat HTTP/1.1\r\n"), "{head}");
        assert!(head.to_ascii_lowercase().contains("authorization: bearer machine-secret\r\n"), "{head}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({ "sandbox": "bx_23456789", "busy": true })
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[tokio::test]
    async fn a_refused_beat_says_so() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let home = temp_home();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(home.join(CLOUD_FILE), format!(r#"{{"url":"http://127.0.0.1:{port}","secret":"wrong"}}"#)).unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = socket.read(&mut [0; 4096]).await;
            socket.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n").await.unwrap();
        });
        let err = beat(&home, "bx_23456789", false).await.unwrap_err();
        assert!(err.to_string().contains("401"), "{err:#}");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
