//! Reaching a remote `dray-serve` through the reader's own SSH login. See
//! SSH-PLAN.md.
//!
//! **The system `ssh`, never a library.** It reads the reader's config, keys,
//! agent and `known_hosts`, so host keys are checked exactly as they would be
//! in a terminal and Dray stores nothing but the destination.

use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use ts_rs::TS;

const SSH: &str = "/usr/bin/ssh";
const KEYSCAN: &str = "/usr/bin/ssh-keyscan";
const KEYGEN: &str = "/usr/bin/ssh-keygen";

/// Where `dray-serve` listens on the server, as `dray setup` leaves it.
const REMOTE_PORT: u16 = 7317;

/// The longest line the script is read for, and the most of `dray service
/// start`'s output kept. A server on the far side of a network decides what
/// it sends, and an unbounded `read_line` would grow until the app fell over.
const MAX_READ: usize = 4096;

/// A whole connect: login, script, `dray service start`'s own 1.5s check.
const OPEN: Duration = Duration::from_secs(45);

pub const INSTALL_LINE: &str = "curl -fsSL https://www.drayhq.com/install.sh | sh";

/// Where `dray setup` puts agents (the CLI's `HOME_BIN_DIRS`). A non-login
/// `ssh host cmd` reads no `.profile`, so none of these are on its `PATH`.
const AGENT_DIRS: &str =
    "$HOME/.local/bin:$HOME/.grok/bin:$HOME/.pi/agent/bin:$HOME/.bun/bin:$HOME/.npm-global/bin";

/// What the reader typed, kept as typed: a `~/.ssh/config` alias stays an
/// alias, so every `ssh` here resolves it the way their terminal does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub dest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

impl Target {
    /// `ssh`'s own arguments for this target, ending in the destination.
    fn args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = self.port {
            args.extend(["-p".into(), port.to_string()]);
        }
        args.extend(["--".into(), self.dest.clone()]);
        args
    }

    /// The machine without the user, which is how a sentence names it.
    pub fn host(&self) -> &str {
        self.dest.rsplit('@').next().unwrap_or(&self.dest)
    }

    /// The line the reader would type, which is how a row names the server.
    pub fn line(&self) -> String {
        match self.port {
            Some(port) => format!("ssh -p {port} {}", self.dest),
            None => format!("ssh {}", self.dest),
        }
    }

    fn copy_id(&self) -> String {
        match self.port {
            Some(port) => format!("ssh-copy-id -p {port} {}", self.dest),
            None => format!("ssh-copy-id {}", self.dest),
        }
    }
}

/// Reads `ssh user@host`, `ssh -p 2222 alias`, or the same without `ssh`.
/// Every other option is refused: it belongs under a `Host` in the reader's
/// config, which every `ssh` this app runs reads anyway.
pub fn parse(line: &str) -> Result<Target, String> {
    let mut words = line.split_whitespace().peekable();
    if words.peek() == Some(&"ssh") {
        words.next();
    }
    let (mut dest, mut port) = (None, None);
    while let Some(word) = words.next() {
        let number = if word == "-p" {
            Some(words.next().ok_or("-p needs a port")?)
        } else {
            word.strip_prefix("-p").filter(|_| word.len() > 2)
        };
        if let Some(number) = number {
            port = Some(number.parse::<u16>().map_err(|_| format!("{number} is not a port"))?);
        } else if word.starts_with('-') {
            return Err(format!(
                "Only -p is understood here. Put {word} under a Host in ~/.ssh/config and use that name."
            ));
        } else if dest.replace(word).is_some() {
            return Err("Only one address, please: ssh user@address".into());
        }
    }
    let dest = dest.ok_or("Paste the line you use to log in: ssh user@address")?;
    // No shell sees it, so only `ssh` parsing it as something else matters.
    if !dest.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:[]%".contains(c)) {
        return Err(format!("{dest} is not an address"));
    }
    // Kept even when 22: it overrides a `Port` the reader's config sets.
    Ok(Target { dest: dest.to_string(), port })
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// `ssh` is logging in.
    Connecting,
    /// Logged in; looking for Dray and its token.
    Finding,
    /// The server was stopped, and `dray service start` is running.
    Starting,
}

/// What the reader can do about a failure, drawn beside its sentence.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fix {
    /// A line to run in the reader's own terminal.
    Copy { command: String },
    /// SSH has never met this server: show its key and ask.
    #[serde(rename_all = "camelCase")]
    TrustHost { host: String, key_type: String, fingerprint: String },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub message: String,
    pub fix: Option<Fix>,
    /// Trying again on its own would not help: a key, a host key, an install.
    /// A refused key retried every few seconds is also what fail2ban bans.
    #[serde(skip)]
    pub permanent: bool,
}

impl Failure {
    fn new(message: impl Into<String>, fix: Option<Fix>, permanent: bool) -> Self {
        Failure { message: message.into(), fix, permanent }
    }
}

/// A live login carrying the forward. Dropping it kills `ssh`, which closes the
/// forwarded socket, which is how the connection on top of it learns.
pub struct Tunnel {
    _child: Child,
    // Held open: the remote script ends in `exec cat`, which exits on EOF.
    _stdin: ChildStdin,
    _stdout: BufReader<ChildStdout>,
    pub port: u16,
    pub token: String,
    stderr: Arc<Mutex<String>>,
}

impl Tunnel {
    /// ssh's last word, for a connection that dropped while this was up — a
    /// refused forward, a dead link.
    pub fn said(&self) -> Option<String> {
        last_line(&self.stderr.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// The script the login runs. Single-quoted whole by the caller, so it holds no
/// single quote and no backslash: the reader's login shell parses that quoting
/// first, and fish reads backslashes inside single quotes where sh does not.
const SCRIPT: &str = concat!(
    "PATH=\"$HOME/.local/bin:$PATH\"; echo DRAY-SSH hello; ",
    "command -v dray >/dev/null 2>&1 || { echo DRAY-SSH missing; exit 0; }; ",
    "if ! systemctl --user is-active --quiet dray 2>/dev/null && systemctl --user show-environment >/dev/null 2>&1; then ",
    "echo DRAY-SSH starting; if ! out=$(dray service start 2>&1); then echo DRAY-SSH failed; echo \"$out\"; exit 0; fi; fi; ",
    "[ -r \"$HOME/.dray/serve-token\" ] || { echo DRAY-SSH notoken; exit 0; }; ",
    "echo \"DRAY-SSH token $(cat \"$HOME/.dray/serve-token\")\"; exec cat",
);

/// Logs in, makes sure the server is up, reads its token and forwards a free
/// local port to it. `stage` hears each step as it happens.
pub async fn open(target: &Target, stage: impl Fn(Stage)) -> Result<Tunnel, Failure> {
    stage(Stage::Connecting);
    let port = free_port().map_err(|e| Failure::new(format!("no free local port: {e}"), None, false))?;
    let mut child = Command::new(SSH)
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes"])
        .args(["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"])
        .args(["-L", &format!("127.0.0.1:{port}:127.0.0.1:{REMOTE_PORT}")])
        .args(target.args())
        .arg(format!("sh -c '{SCRIPT}'"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Failure::new(format!("could not run ssh: {e}"), None, true))?;

    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut pipe) = child.stderr.take() {
        let stderr = stderr.clone();
        tokio::spawn(async move {
            let mut chunk = [0u8; 1024];
            while let Ok(n @ 1..) = pipe.read(&mut chunk).await {
                let mut said = stderr.lock().unwrap_or_else(|e| e.into_inner());
                said.push_str(&String::from_utf8_lossy(&chunk[..n]));
                // Only the end is ever read; a chatty server must not grow this.
                if said.len() > 8192 {
                    let cut = said.len() - 4096;
                    let cut = (cut..said.len()).find(|&i| said.is_char_boundary(i)).unwrap_or(0);
                    said.drain(..cut);
                }
            }
        });
    }
    let stdin = child.stdin.take().expect("piped");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped"));

    let script = async {
        let mut line = String::new();
        let mut failed: Option<String> = None;
        loop {
            line.clear();
            let read = (&mut stdout).take(MAX_READ as u64).read_line(&mut line).await.unwrap_or(0);
            if read == 0 {
                return Err(failed);
            }
            if read == MAX_READ && !line.ends_with('\n') {
                return Ok(Err("oversize"));
            }
            let said = line.trim_end();
            if let Some(out) = failed.as_mut() {
                if out.len() < MAX_READ {
                    out.push_str(said);
                    out.push('\n');
                }
                continue;
            }
            match said.strip_prefix("DRAY-SSH ") {
                Some("hello") => stage(Stage::Finding),
                Some("starting") => stage(Stage::Starting),
                Some("missing") => return Ok(Err("missing")),
                Some("notoken") => return Ok(Err("notoken")),
                Some("failed") => failed = Some(String::new()),
                Some(rest) => {
                    if let Some(token) = rest.strip_prefix("token ") {
                        return Ok(Ok(token.trim().to_string()));
                    }
                }
                // Whatever a dotfile echoes on login.
                None => {}
            }
        }
    };
    let outcome = tokio::time::timeout(OPEN, script).await;
    let host = target.host();
    match outcome {
        Ok(Ok(Ok(token))) if !token.is_empty() => {
            Ok(Tunnel { _child: child, _stdin: stdin, _stdout: stdout, port, token, stderr })
        }
        Ok(Ok(Ok(_) | Err("notoken"))) => Err(Failure::new(
            format!("Dray is on {host} but its server has never run there."),
            Some(Fix::Copy { command: "dray service start".into() }),
            true,
        )),
        Ok(Ok(Err("oversize"))) => Err(Failure::new(
            format!("{host} answered with something that is not Dray."),
            None,
            true,
        )),
        Ok(Ok(Err(_))) => Err(Failure::new(
            format!("Dray isn't installed on {host}. Install it there, then try again:"),
            Some(Fix::Copy { command: INSTALL_LINE.into() }),
            true,
        )),
        Ok(Err(Some(out))) => Err(Failure::new(
            format!("Could not start the server on {host}: {}", out.trim()),
            None,
            true,
        )),
        Ok(Err(None)) => {
            // ssh exited before the script said anything useful: read why.
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            // The reader task may still hold the last chunk.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let said = stderr.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Err(classify(&said, target).await)
        }
        Err(_) => Err(Failure::new(format!("{host} did not answer in time"), None, false)),
    }
}

/// Reads why `ssh` gave up, in its own words.
async fn classify(stderr: &str, target: &Target) -> Failure {
    let host = target.host();
    if stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        let name = resolve(target).await.map(|r| r.known_as()).unwrap_or_else(|_| host.to_string());
        return Failure::new(
            format!(
                "{host} is answering with a different host key than last time. That can mean \
                 someone is in the middle. If you know why it changed, remove the old key and try again:"
            ),
            Some(Fix::Copy { command: format!("ssh-keygen -R {}", crate::apps::sh_quote(&name)) }),
            true,
        );
    }
    if stderr.contains("Host key verification failed") {
        return match scan(target).await {
            Ok(key) => Failure::new(
                format!("This Mac has never connected to {host}."),
                Some(Fix::TrustHost { host: key.host, key_type: key.key_type, fingerprint: key.fingerprint }),
                true,
            ),
            Err(e) => Failure::new(format!("This Mac has never connected to {host}, and {e}"), None, true),
        };
    }
    if stderr.contains("Permission denied") {
        return Failure::new(
            format!("{host} wants a password. Set up a key first, then try again:"),
            Some(Fix::Copy { command: target.copy_id() }),
            true,
        );
    }
    let said = last_line(stderr).unwrap_or_else(|| "ssh exited".into());
    Failure::new(format!("Could not reach {host}: {said}"), None, false)
}

fn last_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).last().map(str::to_string)
}

fn free_port() -> std::io::Result<u16> {
    // ponytail: the port is free when asked and taken by ssh a moment later; a
    // loser of that race fails on ExitOnForwardFailure and the loop retries.
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// The bits of `ssh -G` that decide how `known_hosts` names a server.
struct Resolved {
    hostname: String,
    port: u16,
    alias: Option<String>,
    known_hosts: PathBuf,
    /// `HostKeyAlgorithms`, in ssh's order of preference.
    algorithms: Vec<String>,
    proxied: bool,
}

impl Resolved {
    /// The name ssh files a key under: the alias if one is set, `[host]:port`
    /// off 22.
    fn known_as(&self) -> String {
        let name = self.alias.clone().unwrap_or_else(|| self.hostname.clone());
        if self.port == 22 { name } else { format!("[{name}]:{}", self.port) }
    }
}

async fn resolve(target: &Target) -> Result<Resolved, String> {
    let out = Command::new(SSH)
        .arg("-G")
        .args(target.args())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("could not run ssh: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix(' '))
            .map(str::trim)
            .filter(|v| !v.is_empty() && *v != "none")
            .map(str::to_string)
    };
    let home = std::env::home_dir().ok_or("no home directory")?;
    let known_hosts = field("userknownhostsfile")
        .and_then(|v| v.split_whitespace().next().map(str::to_string))
        .map(|p| match p.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(p),
        })
        .unwrap_or_else(|| home.join(".ssh/known_hosts"));
    Ok(Resolved {
        hostname: field("hostname").ok_or("ssh could not resolve that name")?,
        port: field("port").and_then(|p| p.parse().ok()).unwrap_or(22),
        alias: field("hostkeyalias"),
        known_hosts,
        algorithms: field("hostkeyalgorithms").map(|v| v.split(',').map(str::to_string).collect()).unwrap_or_default(),
        proxied: field("proxyjump").is_some() || field("proxycommand").is_some(),
    })
}

struct ScannedKey {
    host: String,
    key_type: String,
    fingerprint: String,
    /// `<type> <base64>`, ready to file under a name.
    key: String,
    resolved: Resolved,
}

/// The server's host key as ssh would pick it — ED25519, then ECDSA, then RSA,
/// OpenSSH's own order — fetched with `ssh-keyscan` and fingerprinted the way
/// ssh's own question prints it.
async fn scan(target: &Target) -> Result<ScannedKey, String> {
    let resolved = resolve(target).await?;
    if resolved.proxied {
        return Err("it is reached through a jump host, which this app cannot check. Connect once with ssh in a terminal.".into());
    }
    let out = Command::new(KEYSCAN)
        .args(["-T", "5", "-p", &resolved.port.to_string(), "--", &resolved.hostname])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("could not run ssh-keyscan: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let keys: Vec<(&str, &str)> = text
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            parts.next()?;
            Some((parts.next()?, parts.next()?))
        })
        .collect();
    let (kind, blob) = pick_key(&resolved.algorithms, &keys).ok_or(
        "none of its host keys is one your ssh config accepts. Connect once with ssh in a terminal.",
    )?;
    let key = format!("{kind} {blob}");
    let (key_type, fingerprint) = fingerprint(&key).await?;
    Ok(ScannedKey { host: target.host().to_string(), key_type, fingerprint, key, resolved })
}

/// The scanned key ssh will check: the first of its `HostKeyAlgorithms` the
/// server has a key for. Certificate and security-key algorithms name no plain
/// key keyscan returns; every `rsa-sha2-*` signs with an `ssh-rsa` key.
fn pick_key<'a>(algorithms: &[String], keys: &[(&'a str, &'a str)]) -> Option<(&'a str, &'a str)> {
    algorithms
        .iter()
        .filter(|alg| !alg.ends_with("-cert-v01@openssh.com") && !alg.contains("sk-"))
        .map(|alg| if alg.starts_with("rsa-sha2-") { "ssh-rsa" } else { alg.as_str() })
        .find_map(|kind| keys.iter().find(|(k, _)| *k == kind).copied())
}

/// `ssh-keygen -lf -` reads one public key and answers
/// `256 SHA256:… comment (ED25519)`.
async fn fingerprint(key: &str) -> Result<(String, String), String> {
    let printed = pipe(KEYGEN, &["-lf", "-"], &format!("{key}\n")).await?;
    let mut parts = printed.split_whitespace();
    let fingerprint = parts.nth(1).ok_or("ssh-keygen printed no fingerprint")?.to_string();
    let key_type = printed
        .trim()
        .rsplit_once('(')
        .map(|(_, t)| t.trim_end_matches(')').to_string())
        .unwrap_or_default();
    Ok((key_type, fingerprint))
}

async fn pipe(program: &str, args: &[&str], input: &str) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped");
    stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Files the server's key in `known_hosts` once the reader said yes to
/// `fingerprint`. The key is fetched again and must still be the one they saw;
/// only that one is written, so ssh then insists on exactly it.
pub async fn trust(target: &Target, fingerprint: &str) -> Result<(), String> {
    let key = scan(target).await?;
    if key.fingerprint != fingerprint {
        return Err(format!(
            "{} answered with a different key ({}) than the one you accepted. Nothing was saved.",
            key.host, key.fingerprint
        ));
    }
    // Unhashed even where `HashKnownHosts` is on: that option decides what ssh
    // writes, and ssh reads both forms.
    let line = format!("{} {}\n", key.resolved.known_as(), key.key);
    append(&key.resolved.known_hosts, &line)
        .map_err(|e| format!("could not write {}: {e}", key.resolved.known_hosts.display()))
}

fn append(path: &std::path::Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if let Some(dir) = path.parent() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    // A file whose last line has no newline would have this glued onto it.
    let ends_clean = std::fs::read(path).map(|b| b.last().is_none_or(|&c| c == b'\n')).unwrap_or(true);
    if !ends_clean {
        file.write_all(b"\n")?;
    }
    file.write_all(line.as_bytes())
}

/// The `.command` line that opens an interactive login on the server running
/// `command` — a literal from `accounts::auth_options`, never typed text.
pub fn terminal_line(target: &Target, command: &str) -> String {
    use crate::apps::sh_quote;
    let remote = format!("sh -c {}", sh_quote(&format!("PATH=\"{AGENT_DIRS}:$PATH\"; exec {command}")));
    let mut line = String::from("ssh -t");
    for arg in target.args() {
        line.push(' ');
        line.push_str(&sh_quote(&arg));
    }
    line.push(' ');
    line.push_str(&sh_quote(&remote));
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_line_a_reader_types() {
        let t = |dest: &str, port| Target { dest: dest.into(), port };
        assert_eq!(parse("ssh root@1.2.3.4").unwrap(), t("root@1.2.3.4", None));
        assert_eq!(parse("  root@1.2.3.4 ").unwrap(), t("root@1.2.3.4", None));
        assert_eq!(parse("ssh -p 2222 me@box").unwrap(), t("me@box", Some(2222)));
        assert_eq!(parse("ssh -p2222 vps").unwrap(), t("vps", Some(2222)));
        assert_eq!(parse("ssh vps -p 22").unwrap(), t("vps", Some(22)));
        assert!(parse("ssh -i key me@box").unwrap_err().contains("~/.ssh/config"));
        assert!(parse("ssh -oProxyCommand=x box").is_err());
        assert!(parse("ssh a b").is_err());
        assert!(parse("ssh").is_err());
        assert!(parse("ssh -p nope box").is_err());
        assert!(parse("ssh box;rm").is_err());
    }

    #[test]
    fn names_the_line_back() {
        assert_eq!(parse("ssh -p 2222 me@box").unwrap().line(), "ssh -p 2222 me@box");
        assert_eq!(parse("me@box").unwrap().copy_id(), "ssh-copy-id me@box");
    }

    /// The script is single-quoted whole for the reader's login shell, which
    /// may be fish: a quote ends it early, a backslash means something there.
    #[test]
    fn script_survives_the_outer_quotes() {
        assert!(!SCRIPT.contains('\''));
        assert!(!SCRIPT.contains('\\'));
    }

    #[tokio::test]
    async fn sorts_ssh_failures() {
        let target = parse("me@box").unwrap();
        let denied = classify("me@box: Permission denied (publickey,password).\n", &target).await;
        assert!(denied.permanent);
        assert_eq!(denied.fix, Some(Fix::Copy { command: "ssh-copy-id me@box".into() }));
        let offline = classify("ssh: connect to host box port 22: Operation timed out\n", &target).await;
        assert!(!offline.permanent);
        assert!(offline.message.ends_with("Operation timed out"));
    }

    #[test]
    fn picks_the_key_ssh_will_check() {
        let keys = [("ssh-rsa", "R"), ("ecdsa-sha2-nistp256", "E"), ("ssh-ed25519", "D")];
        let algs = |list: &str| list.split(',').map(str::to_string).collect::<Vec<_>>();
        let default = algs("ssh-ed25519-cert-v01@openssh.com,ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512");
        assert_eq!(pick_key(&default, &keys), Some(("ssh-ed25519", "D")));
        assert_eq!(pick_key(&algs("ecdsa-sha2-nistp256"), &keys), Some(("ecdsa-sha2-nistp256", "E")));
        assert_eq!(pick_key(&algs("rsa-sha2-256"), &keys), Some(("ssh-rsa", "R")));
        assert_eq!(pick_key(&algs("sk-ssh-ed25519@openssh.com"), &keys), None);
    }

    #[test]
    fn files_keys_the_way_ssh_does() {
        let r = |port, alias: Option<&str>| Resolved {
            hostname: "1.2.3.4".into(),
            port,
            alias: alias.map(str::to_string),
            known_hosts: PathBuf::new(),
            algorithms: Vec::new(),
            proxied: false,
        };
        assert_eq!(r(22, None).known_as(), "1.2.3.4");
        assert_eq!(r(2222, None).known_as(), "[1.2.3.4]:2222");
        assert_eq!(r(22, Some("vps")).known_as(), "vps");
    }

    /// `DRAY_TEST_SSH="ssh root@host" cargo test ssh::tests::opens_a_live_tunnel -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn opens_a_live_tunnel() {
        let target = parse(&std::env::var("DRAY_TEST_SSH").expect("DRAY_TEST_SSH")).unwrap();
        let stages = Mutex::new(Vec::new());
        let tunnel = open(&target, |s| stages.lock().unwrap().push(s)).await.map_err(|f| f.message).unwrap();
        assert_eq!(tunnel.token.len(), 64);
        assert_eq!(stages.lock().unwrap()[..2], [Stage::Connecting, Stage::Finding]);
        tokio::net::TcpStream::connect(("127.0.0.1", tunnel.port)).await.expect("forwarded port answers");
    }

    /// A host `known_hosts` does not list yet — the VPS by a nip.io name works:
    /// `DRAY_TEST_SSH_NEW="root@1.2.3.4.nip.io"`. Removes the key it wrote.
    #[tokio::test]
    #[ignore]
    async fn trusts_a_live_host() {
        let target = parse(&std::env::var("DRAY_TEST_SSH_NEW").expect("DRAY_TEST_SSH_NEW")).unwrap();
        let fix = open(&target, |_| {}).await.err().and_then(|f| f.fix);
        let Some(Fix::TrustHost { fingerprint, .. }) = fix else { panic!("not an unknown host: {fix:?}") };
        assert!(trust(&target, "SHA256:not-it").await.unwrap_err().contains("different key"));
        trust(&target, &fingerprint).await.unwrap();
        let opened = open(&target, |_| {}).await;
        let name = resolve(&target).await.unwrap().known_as();
        Command::new(KEYGEN).args(["-R", &name]).output().await.unwrap();
        assert!(opened.is_ok(), "{:?}", opened.err().map(|f| f.message));
    }

    /// The Sign in line, run with `--version` in place of a login so it ends.
    #[tokio::test]
    #[ignore]
    async fn a_live_terminal_line_finds_agents() {
        let target = parse(&std::env::var("DRAY_TEST_SSH").expect("DRAY_TEST_SSH")).unwrap();
        for agent in ["claude", "codex", "pi", "fx", "grok"] {
            let line = terminal_line(&target, &format!("{agent} --version"));
            let out = Command::new("/bin/sh").args(["-c", &line]).stdin(Stdio::null()).output().await.unwrap();
            println!("{agent}: {} {}", out.status, String::from_utf8_lossy(&out.stdout).trim());
        }
    }

    /// Prints what each line in `DRAY_TEST_SSH_FAILS` (`;`-separated) fails with.
    #[tokio::test]
    #[ignore]
    async fn says_why_live_lines_fail() {
        for line in std::env::var("DRAY_TEST_SSH_FAILS").expect("DRAY_TEST_SSH_FAILS").split(';') {
            match open(&parse(line).unwrap(), |_| {}).await {
                Ok(_) => println!("{line}\n  connected"),
                Err(f) => println!("{line}\n  {} | permanent={} | {:?}", f.message, f.permanent, f.fix),
            }
        }
    }

    #[test]
    fn a_terminal_login_finds_the_agent() {
        let line = terminal_line(&parse("ssh -p 2222 me@box").unwrap(), "claude auth login");
        assert!(line.starts_with("ssh -t '-p' '2222' '--' 'me@box' "), "{line}");
        assert!(line.contains("exec claude auth login"), "{line}");
    }
}
