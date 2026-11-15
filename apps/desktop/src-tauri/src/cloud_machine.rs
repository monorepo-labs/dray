//! Dray Cloud on the machine's side (#857): a `dray-serve` on the boat sandbox
//! the control plane started for one task. It names its sandbox, keeps it up
//! while it works, and keeps `gh` and git holding a token for its repo (#1013).

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
    /// This machine's own credential, bound to one user and one repo. Absent
    /// on a machine made without a repo, which then has no GitHub access.
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    github: Option<Binding>,
}

#[derive(Deserialize)]
struct Binding {
    author: Author,
}

/// Who commits on this machine: the user, by GitHub's noreply address.
/// Pushes and pull requests are the Dray GitHub App's.
#[derive(Deserialize)]
struct Author {
    name: String,
    email: String,
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

/// When the token now in `gh`'s config expires. Only the time: the token
/// itself lives in `hosts.yml` alone.
const TOKEN_STAMP: &str = "github-token.json";

/// A token is renewed this long before it expires, so a push started on an
/// old one still lands.
const RENEW_BEFORE: chrono::TimeDelta = chrono::TimeDelta::minutes(10);

const RENEW_CHECK_EVERY: Duration = Duration::from_secs(60);

/// One renewal at a time, so the loop and a clone never both mint.
static RENEWING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Minted {
    token: String,
    /// RFC 3339, as GitHub stamps it.
    expires_at: String,
}

/// Keeps the machine's GitHub token fresh for the life of the server. Checked
/// every minute against the wall clock rather than slept for an hour, since a
/// stopped and resumed machine wakes with its timers far behind the token.
pub async fn github(home: PathBuf) {
    let mut every = tokio::time::interval(RENEW_CHECK_EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last = String::new();
    loop {
        every.tick().await;
        let said = match renew(&home).await {
            Ok(true) => "ok".to_string(),
            Ok(false) => continue,
            Err(e) => format!("{e:#}"),
        };
        if said != last {
            eprintln!("[cloud] github token: {said}");
            last = said;
        }
    }
}

/// Before a clone: a fresh token where this is a cloud machine with a repo of
/// its own, nothing anywhere else. `Err` is worded for the task's error line.
pub async fn github_ready() -> Result<(), String> {
    let home = crate::store::get_home_app_dir().await.map_err(|e| e.to_string())?;
    renew(&home).await.map(drop).map_err(|e| format!("couldn't get a GitHub token for this machine: {e:#}"))
}

/// Makes sure `gh` holds a token good for at least `RENEW_BEFORE` more.
/// `Ok(false)` where this home has no repo binding to renew for.
async fn renew(home: &Path) -> Result<bool> {
    let _held = RENEWING.lock().await;
    let (minted, author) = match due(home).await? {
        Due::Unbound => return Ok(false),
        Due::Fresh => return Ok(true),
        Due::Minted(minted, author) => (minted, author),
    };
    write_hosts(&gh_config_dir()?, &minted.token).await?;
    setup_git(&author).await?;
    let stamp = serde_json::json!({ "expiresAt": minted.expires_at });
    write_atomic(&home.join(TOKEN_STAMP), &serde_json::to_vec(&stamp)?).await?;
    Ok(true)
}

enum Due {
    /// No repo of its own: a machine made without one, or not a cloud machine.
    Unbound,
    Fresh,
    Minted(Minted, Author),
}

/// A new token from the control plane where the one held is near expiry.
async fn due(home: &Path) -> Result<Due> {
    let Ok(text) = tokio::fs::read_to_string(home.join(CLOUD_FILE)).await else {
        return Ok(Due::Unbound);
    };
    let cloud: CloudFile = serde_json::from_str(&text).context("cloud.json is not {url, secret}")?;
    let (Some(key), Some(github)) = (cloud.key, cloud.github) else {
        return Ok(Due::Unbound);
    };
    if let Some(expires) = read_stamp(&home.join(TOKEN_STAMP)).await {
        if expires - chrono::Utc::now() > RENEW_BEFORE {
            return Ok(Due::Fresh);
        }
    }

    let url = format!("{}/github/token", cloud.url.trim_end_matches('/'));
    let answer = crate::http()
        .post(&url)
        .bearer_auth(key.trim())
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .with_context(|| format!("could not reach {url}"))?;
    let status = answer.status();
    let body: serde_json::Value = answer.json().await.unwrap_or_default();
    if !status.is_success() {
        // The control plane words a refusal the user can act on; say that.
        match body["message"].as_str() {
            Some(message) => anyhow::bail!("{message}"),
            None => anyhow::bail!("{url} answered {status}"),
        }
    }
    let minted: Minted = serde_json::from_value(body).context("the token answer is not {token, expiresAt}")?;
    minted.expires_at.parse::<chrono::DateTime<chrono::Utc>>().context("the token's expiry is not a time")?;
    Ok(Due::Minted(minted, github.author))
}

async fn read_stamp(path: &Path) -> Option<chrono::DateTime<chrono::Utc>> {
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["expiresAt"].as_str()?.parse().ok()
}

/// `gh`'s config directory, by its own rules.
fn gh_config_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("GH_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Ok(dir.into());
    }
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir).join("gh"));
    }
    Ok(std::env::home_dir().context("no home directory")?.join(".config/gh"))
}

/// Writes `hosts.yml` by hand. `gh auth login --with-token` checks a token
/// against `/user`, which an installation token may not call, and `gh` reads
/// this file fresh on every run, so a rewrite reaches every agent's next call.
async fn write_hosts(dir: &Path, token: &str) -> Result<()> {
    // GitHub's tokens are `ghs_` and base62; anything else must not reach YAML.
    anyhow::ensure!(
        !token.is_empty() && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "the control plane sent a token of an unexpected shape"
    );
    tokio::fs::create_dir_all(dir).await?;
    // Without a versioned config, gh migrates `hosts.yml` first, and the
    // migration resolves an `x-access-token` user through `/user`: refused.
    let config = dir.join("config.yml");
    if !tokio::fs::try_exists(&config).await.unwrap_or(false) {
        write_atomic(&config, b"version: \"1\"\n").await?;
    }
    let yaml = format!(
        "github.com:\n    users:\n        x-access-token:\n            oauth_token: {token}\n    \
         git_protocol: https\n    oauth_token: {token}\n    user: x-access-token\n"
    );
    write_atomic(&dir.join("hosts.yml"), yaml.as_bytes()).await
}

/// Points git at `gh` for github.com credentials and sets the author. Every
/// renewal, not once: cheap, and a machine whose first try failed heals.
async fn setup_git(author: &Author) -> Result<()> {
    let gh = crate::binpath::gh().await.context("gh is not installed")?;
    run(tokio::process::Command::new(gh).args(["auth", "setup-git", "--hostname", "github.com"])).await?;
    for (k, v) in [("user.name", &author.name), ("user.email", &author.email)] {
        run(tokio::process::Command::new("git").args(["config", "--global", k, v])).await?;
    }
    Ok(())
}

async fn run(command: &mut tokio::process::Command) -> Result<()> {
    let out = command
        .stdin(std::process::Stdio::null())
        .env("GH_PROMPT_DISABLED", "1")
        .kill_on_drop(true)
        .output()
        .await
        .with_context(|| format!("could not run {:?}", command.as_std().get_program()))?;
    anyhow::ensure!(
        out.status.success(),
        "{:?} failed: {}",
        command.as_std().get_program(),
        String::from_utf8_lossy(&out.stderr).trim()
    );
    Ok(())
}

/// Temp file and rename, owner-only, so a reader never sees half a token.
async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&tmp)?;
    std::io::Write::write_all(&mut file, bytes)?;
    drop(file);
    tokio::fs::rename(&tmp, path).await.with_context(|| format!("could not write {}", path.display()))
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

    /// One HTTP exchange off a local listener: answers `status` and `body`,
    /// hands back the request it read.
    async fn answer_once(status: &'static str, body: String) -> (u16, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let got = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0, "closed early");
                request.extend_from_slice(&buf[..n]);
            }
            let reply = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len());
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        (port, got)
    }

    fn bound_cloud_json(home: &Path, port: u16) {
        std::fs::write(
            home.join(CLOUD_FILE),
            serde_json::json!({
                "url": format!("http://127.0.0.1:{port}/api/cloud"),
                "secret": "machine-secret",
                "key": "dmk1.claims.sig",
                "github": { "repo": "acme/app", "author": { "name": "octo", "email": "42+octo@users.noreply.github.com" } },
            })
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_machine_without_a_repo_asks_for_no_token() {
        let home = temp_home();
        assert!(matches!(due(&home).await.unwrap(), Due::Unbound), "no cloud.json");
        std::fs::write(home.join(CLOUD_FILE), r#"{"url":"http://127.0.0.1:9/api/cloud","secret":"s"}"#).unwrap();
        assert!(matches!(due(&home).await.unwrap(), Due::Unbound), "made without a repo");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[tokio::test]
    async fn a_token_is_asked_for_with_the_machines_own_key() {
        let home = temp_home();
        let expires = (chrono::Utc::now() + chrono::TimeDelta::hours(1)).to_rfc3339();
        let (port, got) =
            answer_once("200 OK", serde_json::json!({ "token": "ghs_abc123", "expiresAt": expires, "repo": "acme/app" }).to_string())
                .await;
        bound_cloud_json(&home, port);
        let Due::Minted(minted, author) = due(&home).await.unwrap() else { panic!("expected a mint") };
        assert_eq!(minted.token, "ghs_abc123");
        assert_eq!(author.email, "42+octo@users.noreply.github.com");
        let request = got.await.unwrap();
        assert!(request.starts_with("POST /api/cloud/github/token HTTP/1.1\r\n"), "{request}");
        assert!(request.to_ascii_lowercase().contains("authorization: bearer dmk1.claims.sig\r\n"), "{request}");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[tokio::test]
    async fn a_held_token_is_kept_until_ten_minutes_before_it_expires() {
        let home = temp_home();
        // Port 9 answers nothing: a request here would fail the test.
        bound_cloud_json(&home, 9);
        let stamp = |at: chrono::DateTime<chrono::Utc>| {
            std::fs::write(home.join(TOKEN_STAMP), serde_json::json!({ "expiresAt": at.to_rfc3339() }).to_string())
                .unwrap()
        };
        stamp(chrono::Utc::now() + chrono::TimeDelta::minutes(30));
        assert!(matches!(due(&home).await.unwrap(), Due::Fresh));
        stamp(chrono::Utc::now() + chrono::TimeDelta::minutes(5));
        assert!(due(&home).await.is_err(), "near expiry, so it asks, and nothing answers");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[tokio::test]
    async fn a_refusal_carries_the_control_planes_own_sentence() {
        let home = temp_home();
        let (port, _) = answer_once(
            "409 Conflict",
            r#"{"error":"github","message":"octo can no longer push to acme/app."}"#.to_string(),
        )
        .await;
        bound_cloud_json(&home, port);
        let err = due(&home).await.err().expect("refused");
        assert_eq!(err.to_string(), "octo can no longer push to acme/app.");
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// The file is the whole hand-off to `gh` and git, so it is read back
    /// through `gh` itself where one is installed.
    #[tokio::test]
    async fn gh_reads_the_token_written_for_it() {
        let dir = temp_home().join("gh");
        write_hosts(&dir, "ghs_abc123").await.unwrap();
        assert!(write_hosts(&dir, "ghs_x\n    evil: 1").await.is_err());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("hosts.yml")).unwrap().permissions().mode() & 0o777, 0o600);
        let Some(gh) = crate::binpath::gh().await else { return };
        let out = std::process::Command::new(gh).args(["auth", "token"]).env("GH_CONFIG_DIR", &dir).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ghs_abc123");
        let out = std::process::Command::new(crate::binpath::gh().await.unwrap())
            .args(["auth", "git-credential", "get"])
            .env("GH_CONFIG_DIR", &dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(b"protocol=https\nhost=github.com\n\n")?;
                child.wait_with_output()
            })
            .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("password=ghs_abc123"));
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
