//! Dray Cloud on the machine's side (#857): a `dray-serve` on a boat sandbox
//! the control plane started. It names its sandbox, drops the sessions a fork
//! copied in, answers `machine_load` and keeps the sandbox up while it works.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where the control plane leaves its address and this machine's secret, at
/// create. A fork copies it.
const CLOUD_FILE: &str = "cloud.json";

/// The sandbox id this home last ran on.
const BOAT_ID_FILE: &str = "boat-id";

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

/// A fork copies the whole disk, `~/.dray` included, so its first start would
/// list the source's sessions — whose agents and checkouts never came along
/// in any live sense, and which the source still owns. A sandbox id other than
/// the one recorded is that fork: the session index and logs go, everything
/// else stays. No record is a first start, or a server from before this, and
/// keeps all. Answers whether it dropped anything.
pub fn scrub_if_forked(home: &Path, id: &str) -> Result<bool> {
    let file = home.join(BOAT_ID_FILE);
    let recorded = std::fs::read_to_string(&file).ok().map(|r| r.trim().to_string());
    let forked = recorded.as_deref().is_some_and(|r| r != id);
    if forked {
        match std::fs::remove_dir_all(home.join("sessions")) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(e).context("could not drop the sessions a fork copied");
            }
            _ => eprintln!("[cloud] forked from {} to {id}: dropped its sessions", recorded.as_deref().unwrap_or_default()),
        }
    }
    // Written after the drop, so a start that dies halfway drops again.
    if recorded.as_deref() != Some(id) {
        crate::store::write_private_atomic(&file, id.as_bytes()).context("could not record the sandbox id")?;
    }
    Ok(forked)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineLoad {
    pub turns: usize,
    /// `None` where neither `/proc` nor a cgroup says, which is any Mac.
    pub mem_available_mb: Option<u64>,
}

/// What placing a new task here reads: turns running now, and memory left.
pub async fn machine_load() -> MachineLoad {
    let (turns, _) = crate::session::manager().load().await;
    let mem_available_mb = tokio::task::spawn_blocking(mem_available).await.ok().flatten().map(|b| b >> 20);
    MachineLoad { turns, mem_available_mb }
}

/// Bytes free to allocate: the kernel's `MemAvailable`, or less where a cgroup
/// above this process caps it lower. On boat the cap is the one that bites —
/// `user.slice` sits under the machine's RAM with no swap (#708), so
/// `MemAvailable` alone reads hundreds of MB more than there is.
fn mem_available() -> Option<u64> {
    let system = std::fs::read_to_string("/proc/meminfo").ok().and_then(|m| meminfo_available(&m));
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").ok().and_then(|c| {
        let mut dir = PathBuf::from("/sys/fs/cgroup").join(cgroup_path(&c)?.trim_start_matches('/'));
        let mut least: Option<u64> = None;
        loop {
            let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
            if let (Some(max), Some(current)) = (read("memory.max"), read("memory.current")) {
                if let Some(room) = headroom(&max, &current, &read("memory.stat").unwrap_or_default()) {
                    least = Some(least.map_or(room, |l| l.min(room)));
                }
            }
            if dir == Path::new("/sys/fs/cgroup") || !dir.pop() {
                break;
            }
        }
        least
    });
    match (system, cgroup) {
        (Some(s), Some(c)) => Some(s.min(c)),
        (s, c) => s.or(c),
    }
}

/// `MemAvailable` from `/proc/meminfo`, in bytes.
fn meminfo_available(meminfo: &str) -> Option<u64> {
    let line = meminfo.lines().find_map(|l| l.strip_prefix("MemAvailable:"))?;
    let kb: u64 = line.trim().trim_end_matches("kB").trim().parse().ok()?;
    Some(kb * 1024)
}

/// This process's cgroup v2 path, off `/proc/self/cgroup`'s `0::` line.
fn cgroup_path(proc_cgroup: &str) -> Option<&str> {
    proc_cgroup.lines().find_map(|l| l.strip_prefix("0::"))
}

/// Room left under one cgroup's cap, in bytes. `None` for no cap. Inactive
/// page cache counts as room, since the kernel drops it before it kills
/// anything; active cache is left out, so this errs low.
fn headroom(max: &str, current: &str, stat: &str) -> Option<u64> {
    let max: u64 = max.trim().parse().ok()?;
    let current: u64 = current.trim().parse().ok()?;
    let inactive: u64 = stat
        .lines()
        .find_map(|l| l.strip_prefix("inactive_file "))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    Some(max.saturating_sub(current.saturating_sub(inactive)))
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
        let (_, busy) = crate::session::manager().load().await;
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
    fn a_fork_drops_sessions_and_keeps_the_rest() {
        let home = temp_home();
        std::fs::write(home.join("sessions/index.json"), "[]").unwrap();
        std::fs::write(home.join("sessions/s1.jsonl"), "{}").unwrap();
        std::fs::write(home.join("projects.json"), "{}").unwrap();
        std::fs::write(home.join("serve-token"), "t").unwrap();

        assert!(!scrub_if_forked(&home, "bx_source23").unwrap(), "a first start keeps all");
        assert!(home.join("sessions/index.json").exists());
        assert_eq!(std::fs::read_to_string(home.join("boat-id")).unwrap(), "bx_source23");

        assert!(!scrub_if_forked(&home, "bx_source23").unwrap(), "a resume keeps all");
        assert!(home.join("sessions/s1.jsonl").exists());

        assert!(scrub_if_forked(&home, "bx_forked45").unwrap());
        assert!(!home.join("sessions").exists());
        for kept in ["projects.json", "serve-token"] {
            assert!(home.join(kept).exists(), "{kept} stays");
        }
        assert_eq!(std::fs::read_to_string(home.join("boat-id")).unwrap(), "bx_forked45");

        assert!(!scrub_if_forked(&home, "bx_forked45").unwrap(), "the fork's own restart keeps all");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_fork_with_no_sessions_yet_still_records_itself() {
        let home = temp_home();
        std::fs::remove_dir_all(home.join("sessions")).unwrap();
        std::fs::write(home.join("boat-id"), "bx_source23\n").unwrap();
        assert!(scrub_if_forked(&home, "bx_forked45").unwrap());
        assert_eq!(std::fs::read_to_string(home.join("boat-id")).unwrap(), "bx_forked45");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn only_a_boat_id_is_taken() {
        assert!(sandbox_id("bx_23456789"));
        for bad in ["", "bx_", "23456789", "bx_23 456", "bx_../x", &format!("bx_{}", "a".repeat(80))] {
            assert!(!sandbox_id(bad), "{bad:?}");
        }
    }

    /// Shapes as a Debian kernel and systemd write them.
    #[test]
    fn memory_is_read_off_proc_and_the_cgroup() {
        let meminfo = "MemTotal:        8135008 kB\nMemFree:          512000 kB\nMemAvailable:    6291456 kB\n";
        assert_eq!(meminfo_available(meminfo), Some(6291456 * 1024));
        assert_eq!(meminfo_available("MemTotal: 1 kB\n"), None);

        let cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/dray.service\n";
        assert_eq!(cgroup_path(cgroup), Some("/user.slice/user-1000.slice/user@1000.service/app.slice/dray.service"));
        assert_eq!(cgroup_path("12:memory:/x\n"), None, "cgroup v1 names no unified path");

        let stat = "anon 4000000000\nfile 1500000000\ninactive_file 1000000000\nactive_file 500000000\n";
        assert_eq!(headroom("7784628224\n", "6000000000\n", stat), Some(7784628224 - 5000000000));
        assert_eq!(headroom("max\n", "6000000000\n", stat), None, "no cap");
        assert_eq!(headroom("1000\n", "5000\n", ""), Some(0), "over the cap is no room");
    }

    #[tokio::test]
    async fn the_load_counts_no_turns_on_an_idle_server() {
        let load = machine_load().await;
        assert_eq!(load.turns, 0);
        assert_eq!(serde_json::to_value(&load).unwrap().as_object().unwrap().len(), 2);
        assert!(serde_json::to_value(&load).unwrap().get("memAvailableMb").is_some());
        #[cfg(target_os = "linux")]
        assert!(load.mem_available_mb.is_some_and(|mb| mb > 0));
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
