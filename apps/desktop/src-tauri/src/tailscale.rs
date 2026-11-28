//! Remote access over the reader's own tailnet (#1712), in place of the relay:
//! `tailscale serve` ends HTTPS at `https://<machine>.<tailnet>.ts.net` and
//! proxies to the server's listener on loopback. Nothing goes through Dray's
//! relay and nothing falls back to it, which is the point of picking it.
//!
//! The serve wire's token is still checked on every connection: the proxy
//! arrives from 127.0.0.1, and loopback earns nothing on that listener.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use ts_rs::TS;

use crate::store;

/// What stands between this machine and serving on its tailnet. `fix` is
/// whether [`fix`] can see to it here; where it can't, the row shows a guide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TailscaleNeed {
    /// Not on this machine.
    Install { fix: bool },
    /// Installed, with its daemon or app not running, or switched off.
    Start { fix: bool },
    /// Running and signed out. `url` is the sign-in page once one is asked for.
    SignIn { fix: bool, url: Option<String> },
    /// The tailnet has HTTPS certificates off. `url` is Tailscale's own page
    /// to turn them on, where `tailscale serve` named one.
    Https { url: Option<String> },
    /// This user may not change Tailscale's settings: Linux, not its
    /// operator, and no sudo without a password.
    Operator { user: String },
    /// This machine's HTTPS address already proxies to something else.
    Taken { target: String },
}

/// Where the last target Dray served is kept, so a restart on a new port
/// knows the handler it finds is its own and Off takes down only that.
const SERVED_FILE: &str = "tailscale-serve";

/// What a `tailscale` run may take. `serve` waits on the reader when Serve is
/// off for the tailnet, so a run past this is read for the page it named.
const RUN_WAIT: Duration = Duration::from_secs(15);
const INSTALL_WAIT: Duration = Duration::from_secs(600);

/// The CLI, checked on each ask: the reader may install it while the row waits.
pub fn binary() -> Option<PathBuf> {
    let known: &[&str] = if cfg!(target_os = "macos") {
        // The standalone and App Store apps carry the CLI inside the bundle.
        &["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
    } else if cfg!(windows) {
        &[r"C:\Program Files\Tailscale\tailscale.exe"]
    } else {
        &["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"]
    };
    let name = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).map(|d| d.join(name)).collect::<Vec<_>>())
        .chain(known.iter().map(PathBuf::from))
        .find(|p| p.is_file())
}

/// Whether Dray may run what Tailscale's install and settings need root for.
/// Linux alone: root, or sudo that asks no password.
async fn may_sudo() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    if crate::platform::is_root() {
        return true;
    }
    Command::new("sudo")
        .args(["-n", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|s| s.success())
}

fn user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// Runs `bin` under sudo where `root` and this process isn't root.
fn command(bin: &Path, root: bool) -> Command {
    let mut cmd = if root && !crate::platform::is_root() {
        let mut sudo = Command::new("sudo");
        sudo.arg("-n").arg(bin);
        sudo
    } else {
        Command::new(bin)
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd
}

/// Runs to the end or for `wait`, whichever is first, and answers whether it
/// succeeded with all it printed. Read as it goes, so a run cut short still
/// says what it was waiting on.
async fn run(mut cmd: Command, wait: Duration) -> Result<(bool, String), String> {
    let mut child = cmd.spawn().map_err(|e| format!("could not run tailscale: {e}"))?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (mut a, mut b) = (Vec::new(), Vec::new());
    let done = tokio::time::timeout(wait, async {
        let _ = tokio::join!(out.read_to_end(&mut a), err.read_to_end(&mut b));
        child.wait().await
    })
    .await;
    let ok = matches!(done, Ok(Ok(status)) if status.success());
    a.extend_from_slice(&b);
    Ok((ok, String::from_utf8_lossy(&a).into_owned()))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Status {
    #[serde(default)]
    backend_state: String,
    #[serde(default, rename = "AuthURL")]
    auth_url: String,
    #[serde(default, rename = "Self")]
    me: Option<Peer>,
    /// Null or absent while the tailnet has HTTPS certificates off.
    #[serde(default)]
    cert_domains: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
struct Peer {
    #[serde(default, rename = "DNSName")]
    dns_name: String,
}

/// This machine's tailnet name, once Tailscale runs signed in with HTTPS on.
pub async fn check() -> Result<String, TailscaleNeed> {
    let Some(bin) = binary() else {
        return Err(TailscaleNeed::Install { fix: may_sudo().await });
    };
    let mut cmd = command(&bin, false);
    cmd.args(["status", "--json"]);
    let status = match run(cmd, RUN_WAIT).await {
        Ok((_, text)) => parse_status(&text),
        Err(_) => None,
    };
    // No JSON at all is a daemon, or on a Mac the app, that is not running.
    let Some(status) = status else {
        return Err(TailscaleNeed::Start { fix: cfg!(target_os = "macos") || may_sudo().await });
    };
    let sign_in = status.backend_state != "Running" && may_sign_in().await;
    need_of(&status, sign_in)
}

/// The JSON `status --json` prints, which a stopped daemon answers with
/// a sentence instead.
fn parse_status(text: &str) -> Option<Status> {
    let start = text.find('{')?;
    serde_json::from_str(&text[start..]).ok()
}

/// This machine's tailnet name while Tailscale runs, HTTPS on or not.
pub async fn host() -> Option<String> {
    let bin = binary()?;
    let mut cmd = command(&bin, false);
    cmd.args(["status", "--json"]);
    let status = parse_status(&run(cmd, RUN_WAIT).await.ok()?.1)?;
    Some(status.me?.dns_name.trim_end_matches('.').to_string()).filter(|n| !n.is_empty())
}

/// `tailscale up` asks for root on Linux unless this user is the operator,
/// which only sudo can make it.
async fn may_sign_in() -> bool {
    cfg!(target_os = "macos") || may_sudo().await
}

fn need_of(status: &Status, sign_in: bool) -> Result<String, TailscaleNeed> {
    let url = Some(status.auth_url.clone()).filter(|u| !u.is_empty());
    match status.backend_state.as_str() {
        "Running" => {}
        "Stopped" => return Err(TailscaleNeed::Start { fix: sign_in }),
        "NeedsLogin" | "NeedsMachineAuth" | "NoState" => return Err(TailscaleNeed::SignIn { fix: sign_in, url }),
        // Starting: the next look will say.
        _ => return Err(TailscaleNeed::Start { fix: false }),
    }
    let host = status.me.as_ref().map(|p| p.dns_name.trim_end_matches('.').to_string()).unwrap_or_default();
    if host.is_empty() || status.cert_domains.as_ref().is_none_or(|d| d.is_empty()) {
        return Err(TailscaleNeed::Https { url: None });
    }
    Ok(host)
}

async fn served_file() -> Option<PathBuf> {
    Some(store::get_home_app_dir().await.ok()?.join(SERVED_FILE))
}

/// What `host`'s HTTPS root proxies to now, `None` while nothing does.
async fn current_target(bin: &Path, host: &str) -> Option<String> {
    let mut cmd = command(bin, false);
    cmd.args(["serve", "status", "--json"]);
    let (_, text) = run(cmd, RUN_WAIT).await.ok()?;
    let start = text.find('{')?;
    let config: Value = serde_json::from_str(&text[start..]).ok()?;
    root_target(&config, host)
}

fn root_target(config: &Value, host: &str) -> Option<String> {
    let handler = config.get("Web")?.get(format!("{host}:443"))?.get("Handlers")?.get("/")?;
    // A handler serving files or text is somebody's too, just not a proxy.
    Some(handler.get("Proxy").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| handler.to_string()))
}

/// Serves `port` at `https://<host>`. Refuses to take over a root handler
/// Dray did not put there.
pub async fn serve(host: &str, port: u16) -> Result<(), Result<TailscaleNeed, String>> {
    let bin = binary().ok_or(Ok(TailscaleNeed::Install { fix: false }))?;
    let target = format!("http://127.0.0.1:{port}");
    let file = served_file().await;
    let ours = match &file {
        Some(f) => tokio::fs::read_to_string(f).await.ok().map(|t| t.trim().to_string()),
        None => None,
    };
    match current_target(&bin, host).await {
        Some(now) if now == target => return Ok(()),
        Some(now) if Some(&now) != ours.as_ref() => return Err(Ok(TailscaleNeed::Taken { target: now })),
        _ => {}
    }
    let mut asked_operator = false;
    loop {
        let mut cmd = command(&bin, false);
        cmd.args(["serve", "--bg", "--yes", "--https=443", &target]);
        let (ok, said) = run(cmd, RUN_WAIT).await.map_err(Err)?;
        if ok {
            if let Some(f) = &file {
                let _ = store::write_atomic(f, format!("{target}\n")).await;
            }
            return Ok(());
        }
        if let Some(url) = login_url(&said) {
            return Err(Ok(TailscaleNeed::Https { url: Some(url) }));
        }
        if !denied(&said) {
            return Err(Err(last_line(&said, "tailscale serve failed")));
        }
        // Not the operator: sudo makes this user one, once.
        if asked_operator || !may_sudo().await {
            return Err(Ok(TailscaleNeed::Operator { user: user() }));
        }
        asked_operator = true;
        let mut set = command(&bin, true);
        set.args(["set", &format!("--operator={}", user())]);
        let _ = run(set, RUN_WAIT).await;
    }
}

/// Whether `tailscale` refused for want of permission rather than anything
/// else. Its wording has moved across releases; each of these has shipped.
fn denied(said: &str) -> bool {
    let said = said.to_lowercase();
    ["access denied", "permission denied", "--operator", "use 'sudo tailscale"].iter().any(|w| said.contains(w))
}

/// Takes down the handler Dray put up, if it is still the one there.
pub async fn unserve() {
    let Some(file) = served_file().await else { return };
    let Ok(ours) = tokio::fs::read_to_string(&file).await else { return };
    if let Some(bin) = binary() {
        let host = check().await.ok();
        let now = match &host {
            Some(host) => current_target(&bin, host).await,
            None => None,
        };
        if host.is_some() && now.as_deref() == Some(ours.trim()) {
            let mut cmd = command(&bin, false);
            cmd.args(["serve", "--https=443", "--set-path=/", "off"]);
            if let Ok((false, said)) = run(cmd, RUN_WAIT).await {
                crate::tunnel::log("tailscale", &format!("could not stop serving: {}", said.trim()));
            }
        }
    }
    let _ = tokio::fs::remove_file(file).await;
}

/// Sees to what [`check`] reported, where Dray can: installs on Linux with
/// sudo, starts the daemon or the Mac app, or begins a sign-in. Answers the
/// sign-in page to open, where there is one.
pub async fn fix() -> Result<Option<String>, String> {
    match check().await {
        Ok(_) => Ok(None),
        Err(TailscaleNeed::Install { fix: true }) => install().await.map(|()| None),
        Err(TailscaleNeed::Start { fix: true }) => start().await.map(|()| None),
        Err(TailscaleNeed::SignIn { fix: true, url }) => match url {
            Some(url) => Ok(Some(url)),
            None => sign_in().await.map(Some),
        },
        Err(_) => Err("Dray can't do this one here".into()),
    }
}

async fn install() -> Result<(), String> {
    let line = if crate::platform::is_root() {
        "curl -fsSL https://tailscale.com/install.sh | sh"
    } else {
        "curl -fsSL https://tailscale.com/install.sh | sudo -n sh"
    };
    let mut cmd = Command::new("sh");
    cmd.args(["-c", line]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let (ok, said) = run(cmd, INSTALL_WAIT).await?;
    crate::tunnel::log("tailscale", &format!("install {}", if ok { "done" } else { "failed" }));
    if ok && binary().is_some() {
        return Ok(());
    }
    Err(format!("Tailscale did not install: {}", last_line(&said, "the install did not finish")))
}

async fn start() -> Result<(), String> {
    let bin = binary().ok_or("Tailscale is not installed")?;
    // A daemon that answers is one switched off, which `up` turns back on.
    let mut probe = command(&bin, false);
    probe.args(["status", "--json"]);
    if run(probe, RUN_WAIT).await.ok().and_then(|(_, t)| parse_status(&t)).is_some() {
        return sign_in().await.map(|_| ());
    }
    let line: &[&str] = if cfg!(target_os = "macos") {
        &["open", "-a", "Tailscale"]
    } else if crate::platform::is_root() {
        &["systemctl", "enable", "--now", "tailscaled"]
    } else {
        &["sudo", "-n", "systemctl", "enable", "--now", "tailscaled"]
    };
    let mut cmd = Command::new(line[0]);
    cmd.args(&line[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    match run(cmd, RUN_WAIT).await? {
        (true, _) => Ok(()),
        (false, said) => Err(last_line(&said, "could not start Tailscale")),
    }
}

/// The last thing a run said, which is where `tailscale` puts its reason.
fn last_line(said: &str, otherwise: &str) -> String {
    said.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or(otherwise).to_string()
}

/// The child running `tailscale up`, which waits for the sign-in to finish.
/// Held so it outlives the call; a second sign-in replaces it.
static SIGNING_IN: std::sync::Mutex<Option<tokio::process::Child>> = std::sync::Mutex::new(None);

/// Starts `tailscale up` and answers the sign-in page it prints. On Linux it
/// runs under sudo and makes this user the operator, so `serve` needs no root.
async fn sign_in() -> Result<String, String> {
    let bin = binary().ok_or("Tailscale is not installed")?;
    let linux = cfg!(target_os = "linux");
    let mut cmd = command(&bin, linux);
    cmd.arg("up");
    if linux {
        cmd.arg(format!("--operator={}", user()));
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not run tailscale: {e}"))?;
    // Both pipes are read to the end whatever happens here, or a full one
    // blocks the sign-in still waiting behind it.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static, tx: tokio::sync::mpsc::UnboundedSender<String>) {
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = pipe.read(&mut buf).await {
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            }
        });
    }
    drain(child.stdout.take().unwrap(), tx.clone());
    drain(child.stderr.take().unwrap(), tx);
    let found = tokio::time::timeout(RUN_WAIT, async {
        let mut text = String::new();
        while let Some(chunk) = rx.recv().await {
            text.push_str(&chunk);
            if let Some(url) = login_url(&text) {
                return Ok(url);
            }
        }
        Err(last_line(&text, "tailscale up ended"))
    })
    .await;
    *SIGNING_IN.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    // Timing out is `up` connecting a machine already signed in, which prints nothing.
    found.unwrap_or_else(|_| Err("Tailscale printed no sign-in page".into()))
}

/// The first Tailscale admin or sign-in page named in `text`.
fn login_url(text: &str) -> Option<String> {
    text.split_whitespace().find(|w| w.starts_with("https://login.tailscale.com/")).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(json: &str) -> Status {
        parse_status(json).unwrap()
    }

    #[test]
    fn reads_what_status_says() {
        let ready = r#"{"BackendState":"Running","AuthURL":"","Self":{"DNSName":"box.tail1a2b.ts.net."},"CertDomains":["box.tail1a2b.ts.net"]}"#;
        assert_eq!(need_of(&status(ready), true), Ok("box.tail1a2b.ts.net".into()));
        let no_https = r#"{"BackendState":"Running","Self":{"DNSName":"box.tail1a2b.ts.net."},"CertDomains":null}"#;
        assert_eq!(need_of(&status(no_https), true), Err(TailscaleNeed::Https { url: None }));
        let signed_out = r#"{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/abc","Self":null}"#;
        assert_eq!(
            need_of(&status(signed_out), false),
            Err(TailscaleNeed::SignIn { fix: false, url: Some("https://login.tailscale.com/a/abc".into()) })
        );
        assert_eq!(need_of(&status(r#"{"BackendState":"Stopped"}"#), true), Err(TailscaleNeed::Start { fix: true }));
    }

    #[test]
    fn a_stopped_daemon_is_no_status() {
        assert!(parse_status("failed to connect to local tailscaled; it doesn't appear to be running").is_none());
        assert!(parse_status("Warning: client version != tailscaled\n{\"BackendState\":\"Running\"}").is_some());
    }

    #[test]
    fn finds_the_root_handler() {
        let config: Value = serde_json::from_str(
            r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"box.t.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7317"}}}}}"#,
        )
        .unwrap();
        assert_eq!(root_target(&config, "box.t.ts.net").as_deref(), Some("http://127.0.0.1:7317"));
        assert_eq!(root_target(&config, "other.t.ts.net"), None);
        assert_eq!(root_target(&serde_json::json!({}), "box.t.ts.net"), None);
        let files: Value = serde_json::from_str(r#"{"Web":{"b:443":{"Handlers":{"/":{"Path":"/srv"}}}}}"#).unwrap();
        assert!(root_target(&files, "b").unwrap().contains("/srv"), "a non-proxy handler is still taken");
    }

    #[test]
    fn knows_a_refusal_for_permission() {
        assert!(denied("Access denied: serve config denied"));
        assert!(denied("use 'sudo tailscale serve ...'"));
        assert!(!denied("error: invalid port"));
    }
}
