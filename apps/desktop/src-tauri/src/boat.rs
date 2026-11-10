//! Boat sandboxes, which stop on a timer and come back on a new address with a
//! new host key. Everything here goes through the reader's own `boat` login;
//! without one this answers nothing and a sandbox is just another server. See
//! docs/boat.md.

use crate::{machines::BoatLink, sandbox::Sandbox, ssh};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::process::Command;

const API: &str = "https://boat.dev/api/v1";

/// `boat resume` waits until the sandbox can run a command, itself capped at 30
/// minutes. Past this the row says so rather than spinning on.
pub const RESUMING: Duration = Duration::from_secs(10 * 60);
const QUICK: Duration = Duration::from_secs(20);

/// A sandbox id, as boat's API spells them. Checked since a server reports its
/// own and this one lands on a command line.
pub fn valid_id(id: &str) -> bool {
    id.strip_prefix("bx_").is_some_and(|rest| {
        rest.len() == 8 && rest.bytes().all(|c| b"23456789abcdefghjkmnpqrstuvwxyz".contains(&c))
    })
}

/// Runs `boat` with JSON output. `None` where the CLI is not here. No update
/// check: one reaches the network on every call, and this runs on a timer.
async fn run(args: &[&str], limit: Duration) -> Option<std::io::Result<std::process::Output>> {
    let bin = crate::binpath::boat()?;
    let out = Command::new(bin)
        .args(args)
        .arg("--json")
        .env("BOAT_NO_UPDATE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(limit, out).await {
        Ok(out) => Some(out),
        Err(_) => Some(Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "boat did not answer in time"))),
    }
}

/// The sandbox's state, or `None` for anything else: no CLI, logged out, offline,
/// a sandbox this login cannot see. All of those mean no boat UI.
pub async fn info(id: &str) -> Option<Sandbox> {
    let out = run(&["info", id], QUICK).await?.ok()?;
    out.status.success().then_some(())?;
    parse_info(&String::from_utf8_lossy(&out.stdout))
}

fn parse_info(text: &str) -> Option<Sandbox> {
    let value: Value = serde_json::from_str(text).ok()?;
    let sandbox = value.get("sandbox").unwrap_or(&value);
    let state = sandbox.get("state")?.as_str()?;
    // The API says archived where the CLI's words say stopped.
    let stopped = matches!(state, "archived" | "archiving" | "stopped" | "stopping");
    if !stopped && matches!(state, "error" | "cancelled") {
        return None;
    }
    let ip = sandbox.get("ip").and_then(Value::as_str);
    let via = sandbox.get("sshEndpoint").and_then(Value::as_str);
    Some(Sandbox {
        stopped,
        endpoint: (!stopped).then(|| endpoint(via, ip)).flatten(),
        stops_at: sandbox
            .get("archiveAfter")
            .and_then(Value::as_str)
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .map(|at| at.with_timezone(&Utc)),
    })
}

/// `host:port`: boat's own where the sandbox has no IPv4 of its own, else its
/// address on SSH's port.
fn endpoint(via: Option<&str>, ip: Option<&str>) -> Option<String> {
    via.filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| ip.filter(|i| !i.is_empty()).map(|i| format!("{i}:22")))
}

fn split_endpoint(endpoint: &str) -> Option<(&str, u16)> {
    let (host, port) = endpoint.rsplit_once(':')?;
    Some((host, port.parse().ok()?))
}

/// The sentence a failed `boat` call ends on: JSON's `error`, else its stderr.
fn said(out: &std::process::Output) -> String {
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let from_json = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok()?.get("error")?.as_str().map(str::to_string));
    from_json
        .or_else(|| stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).map(str::to_string))
        .unwrap_or_else(|| "boat gave no reason".into())
}

/// Resumes a stopped sandbox and returns once it can run a command, which is
/// before SSH and Dray are up on it.
pub async fn resume(id: &str) -> Result<(), String> {
    let out = run(&["resume", id], RESUMING).await.ok_or("boat isn't installed on this Mac.")?;
    let out = out.map_err(|e| format!("Could not run boat: {e}"))?;
    if out.status.success() { Ok(()) } else { Err(said(&out)) }
}

/// Sets the time left, and the length of every later resume. It does not add.
pub async fn extend(id: &str, minutes: u32) -> Result<(), String> {
    let seconds = (u64::from(minutes) * 60).to_string();
    let out = run(&["extend", id, "--ttl", &seconds], QUICK).await.ok_or("boat isn't installed on this Mac.")?;
    let out = out.map_err(|e| format!("Could not run boat: {e}"))?;
    if out.status.success() { Ok(()) } else { Err(said(&out)) }
}

/// The address and the host key boat's API gives for a sandbox, authorizing
/// `key` on it as it answers. The one source a new host key may come from: the
/// answer is over TLS from boat, so it can check what SSH then connects to,
/// which a key read off that connection never could.
async fn access(id: &str, key: &str) -> Result<(String, String), String> {
    let token = api_token().await.ok_or("boat isn't logged in on this Mac.")?;
    let answer = crate::http()
        .post(format!("{API}/sandboxes/{id}/sshkey"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "key": key }))
        .timeout(QUICK)
        .send()
        .await
        .map_err(|e| format!("Could not reach boat: {e}"))?;
    let status = answer.status();
    let value: Value = answer.json().await.map_err(|e| format!("boat answered oddly: {e}"))?;
    if !status.is_success() {
        let why = value.get("message").and_then(Value::as_str).unwrap_or("no reason given");
        return Err(format!("boat refused: {why}"));
    }
    let host_key = value.get("hostKey").and_then(Value::as_str).ok_or("boat sent no host key")?;
    let via = value.get("sshEndpoint").and_then(Value::as_str);
    let ip = value.get("machineIp").and_then(Value::as_str);
    let endpoint = endpoint(via, ip).ok_or("boat sent no address")?;
    Ok((endpoint, host_key.to_string()))
}

/// The session `boat login` saved. Read each time, so logging out takes effect.
async fn api_token() -> Option<String> {
    let dir = config_dir()?;
    let text = tokio::fs::read_to_string(dir.join("config.json")).await.ok()?;
    let config: Value = serde_json::from_str(&text).ok()?;
    config.get("token")?.as_str().filter(|t| !t.is_empty()).map(str::to_string)
}

/// Where the CLI keeps its config: macOS's Application Support, or the XDG
/// directory its installer writes to elsewhere.
fn config_dir() -> Option<PathBuf> {
    let home = std::env::home_dir()?;
    let mac = home.join("Library/Application Support/ascii/boat");
    Some(if cfg!(target_os = "macos") { mac } else { home.join(".config/ascii/boat") })
}

/// Why a sandbox's SSH details were left alone.
#[derive(Debug, PartialEq)]
pub enum Refused {
    /// The block doesn't exist, names several hosts, or now points elsewhere.
    NotOurs,
    Failed(String),
}

impl Refused {
    /// The row's sentence.
    pub fn sentence(&self, dest: &str) -> String {
        match self {
            Refused::NotOurs => format!(
                "It's running again, but the Host {dest} block in ~/.ssh/config doesn't point at this sandbox any more, so Dray left it alone."
            ),
            Refused::Failed(why) => format!("It's running again, but Dray couldn't update its SSH details: {why}"),
        }
    }
}

/// Points a sandbox's login at where boat says it now is: the alias's `HostName`
/// and `Port`, and its pinned key. Answers the new link and the target to save.
/// Does nothing when the address and the key are already these.
///
/// Refuses unless the login still points where this sandbox last was, so an
/// alias the reader has since aimed at another machine stays theirs.
pub async fn repoint(link: &BoatLink, target: &ssh::Target) -> Result<(BoatLink, ssh::Target, bool), Refused> {
    // Two sandboxes resuming at once would each rewrite the whole file from the
    // same read, and the last rename would undo the other's alias.
    static EDITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one_at_a_time = EDITING.lock().await;
    let before = ssh::resolve(target).await.map_err(Refused::Failed)?;
    let was = format!("{}:{}", before.hostname, before.port);
    if link.endpoint.as_deref() != Some(was.as_str()) {
        return Err(Refused::NotOurs);
    }
    let key = public_key(&before.identity).await.map_err(Refused::Failed)?;
    let (endpoint, host_key) = access(&link.id, &key).await.map_err(Refused::Failed)?;
    let (host, port) = split_endpoint(&endpoint).ok_or(Refused::Failed(format!("boat sent a bad address: {endpoint}")))?;
    let host_key = clean_key(&host_key).ok_or(Refused::Failed("boat sent a bad host key".into()))?;
    ssh::fingerprint(&host_key).await.map_err(Refused::Failed)?;

    let mut next = target.clone();
    let alias = target.host().to_string();
    let config = ssh_config().ok_or(Refused::Failed("no home directory".into()))?;
    let text = std::fs::read_to_string(&config).unwrap_or_default();
    let mut pinned = None;
    if has_block(&text, &alias) {
        let edited = repoint_block(&text, &alias, host, port).ok_or(Refused::NotOurs)?;
        if next.port.is_some() {
            next.port = Some(port);
        }
        if edited != text {
            pinned = Some(write_config(&config, &edited, &before, &next, host, port, &host_key).await.map_err(Refused::Failed)?);
        }
    } else if alias == before.hostname {
        // Typed as an address, with no alias to edit: the row holds the address.
        next.dest = match target.dest.rsplit_once('@') {
            Some((user, _)) => format!("{user}@{host}"),
            None => host.to_string(),
        };
        next.port = (port != 22).then_some(port);
    } else {
        return Err(Refused::NotOurs);
    }

    let moved = match pinned {
        Some(moved) => moved,
        None => {
            let after = ssh::resolve(&next).await.map_err(Refused::Failed)?;
            ssh::pin_key(&before, &after, &host_key).await.map_err(Refused::Failed)?
        }
    };
    let link = BoatLink { id: link.id.clone(), endpoint: Some(endpoint.clone()) };
    Ok((link, next, moved || was != endpoint))
}

/// The login's public half, which boat authorizes as it answers. Derived from
/// the private file where no `.pub` sits beside it.
async fn public_key(identities: &[PathBuf]) -> Result<String, String> {
    for file in identities {
        let public = PathBuf::from(format!("{}.pub", file.display()));
        if let Ok(text) = tokio::fs::read_to_string(&public).await {
            if let Some(line) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
                return Ok(line.to_string());
            }
        }
    }
    Err("this login has no public key file beside its IdentityFile".into())
}

/// `<type> <base64>` on one line, or nothing: this goes into a known-hosts file,
/// so a newline in it would be a second entry.
fn clean_key(key: &str) -> Option<String> {
    let mut parts = key.split_ascii_whitespace();
    let (kind, blob) = (parts.next()?, parts.next()?);
    let kind_ok = kind.starts_with("ssh-") || kind.starts_with("ecdsa-");
    let blob_ok = blob.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c));
    (kind_ok && blob_ok && !key.contains(['\n', '\r'])).then(|| format!("{kind} {blob}"))
}

fn ssh_config() -> Option<PathBuf> {
    Some(std::env::home_dir()?.join(".ssh/config"))
}

/// A line's keyword, separator-free value and the byte range of that value.
fn field(line: &str) -> Option<(&str, &str, std::ops::Range<usize>)> {
    let body = line.trim_end_matches(['\r', '\n']);
    let start = body.len() - body.trim_start().len();
    let key_len = body[start..].find(|c: char| c.is_whitespace() || c == '=')?;
    let key = &body[start..start + key_len];
    let rest = &body[start + key_len..];
    let sep = rest.len() - rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').len();
    let at = start + key_len + sep;
    let tail = &body[at..];
    let len = if let Some(quoted) = tail.strip_prefix('"') {
        quoted.find('"').map_or(tail.len(), |end| end + 2)
    } else {
        tail.find(char::is_whitespace).unwrap_or(tail.len())
    };
    Some((key, &body[at..at + len], at..at + len))
}

/// Whether `alias` is named by a `Host` line of its own. A line naming several
/// hosts is not ours to edit: changing it moves the others too.
fn has_block(config: &str, alias: &str) -> bool {
    config.split_inclusive('\n').any(|line| {
        field(line).is_some_and(|(key, _, _)| {
            key.eq_ignore_ascii_case("host") && host_names(line).iter().any(|name| name == alias)
        })
    })
}

fn host_names(line: &str) -> Vec<String> {
    let body = line.trim();
    let after = body.get(4..).unwrap_or_default().trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    let before_comment = after.split(" #").next().unwrap_or(after);
    before_comment.split_whitespace().map(|n| n.trim_matches('"').to_string()).collect()
}

/// `config` with `alias`'s own block pointing at `host` and `port`, every other
/// byte as it was. `None` where no block names `alias` alone.
fn repoint_block(config: &str, alias: &str, host: &str, port: u16) -> Option<String> {
    let mut out = String::with_capacity(config.len() + 32);
    let (mut inside, mut found, mut wrote_host, mut wrote_port) = (false, false, false, false);
    let mut hostname_line: Option<(usize, String, String)> = None;
    for line in config.split_inclusive('\n') {
        let parsed = field(line);
        let key = parsed.as_ref().map(|(k, _, _)| k.to_ascii_lowercase()).unwrap_or_default();
        if key == "host" || key == "match" {
            if inside {
                inside = false;
                insert_port(&mut out, &hostname_line, port, wrote_port);
                hostname_line = None;
            }
            if key == "host" && !found && host_names(line) == [alias] {
                inside = true;
                found = true;
            }
        }
        match (inside, key.as_str(), &parsed) {
            (true, "hostname", Some((_, _, range))) if !wrote_host => {
                wrote_host = true;
                let ending = &line[line.trim_end_matches(['\r', '\n']).len()..];
                let indent = &line[..line.len() - line.trim_start().len()];
                out.push_str(&line[..range.start]);
                out.push_str(host);
                out.push_str(&line[range.end..]);
                hostname_line = Some((out.len(), indent.to_string(), ending.to_string()));
            }
            (true, "port", Some((_, _, range))) if !wrote_port => {
                wrote_port = true;
                out.push_str(&line[..range.start]);
                out.push_str(&port.to_string());
                out.push_str(&line[range.end..]);
            }
            _ => out.push_str(line),
        }
    }
    if inside {
        insert_port(&mut out, &hostname_line, port, wrote_port);
    }
    (found && wrote_host).then_some(out)
}

/// A block with no `Port` line gets one under its `HostName`, off the default.
fn insert_port(out: &mut String, hostname: &Option<(usize, String, String)>, port: u16, wrote: bool) {
    if wrote || port == 22 {
        return;
    }
    if let Some((at, indent, ending)) = hostname {
        let ending = if ending.is_empty() { "\n" } else { ending };
        let lead = if out[..*at].ends_with('\n') { "" } else { ending };
        let tail = if out[..*at].ends_with('\n') { ending } else { "" };
        out.insert_str(*at, &format!("{lead}{indent}Port {port}{tail}"));
    }
}

/// Writes the config beside itself and renames it in, after asking `ssh` itself
/// whether the new file reaches `host:port`: a `Host *` above the block or a
/// `-p` on the row would beat the edit, and a config that doesn't do what it
/// was edited for must not land. The key is pinned before the rename, so a
/// failed write leaves the alias where `before` was and a retry still owns it.
async fn write_config(
    config: &Path,
    text: &str,
    before: &ssh::Resolved,
    target: &ssh::Target,
    host: &str,
    port: u16,
    key: &str,
) -> Result<bool, String> {
    // Through a symlink, or a dotfile manager's link becomes a plain file.
    let real = std::fs::canonicalize(config).map_err(|e| format!("could not read {}: {e}", config.display()))?;
    let mode = std::fs::metadata(&real).map_err(|e| e.to_string())?.permissions();
    let tmp = real.with_file_name(format!(".config.dray-{}", uuid::Uuid::now_v7()));
    let done = async {
        std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
        std::fs::set_permissions(&tmp, mode).map_err(|e| e.to_string())?;
        let reached = ssh::resolve_with(target, Some(&tmp)).await?;
        if reached.hostname != host || reached.port != port {
            return Err(format!(
                "another rule in ~/.ssh/config decides where {} goes, so the edit would not take",
                target.host()
            ));
        }
        let moved = ssh::pin_key(before, &reached, key).await?;
        std::fs::rename(&tmp, &real).map_err(|e| format!("could not write {}: {e}", real.display()))?;
        Ok(moved)
    }
    .await;
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_an_id_a_server_reported() {
        assert!(valid_id("bx_45mhxj2m"));
        assert!(!valid_id("bx_45mhxj2"));
        assert!(!valid_id("--help"));
        assert!(!valid_id("bx_45mhxj2l"), "boat's alphabet has no l");
    }

    #[test]
    fn reads_boats_info() {
        let running = parse_info(r#"{"sandbox":{"state":"idle","ip":"1.2.3.4","sshEndpoint":"5.6.7.8:19042","archiveAfter":"2026-11-07T10:00:00.000Z"}}"#).unwrap();
        assert!(!running.stopped);
        assert_eq!(running.endpoint.as_deref(), Some("5.6.7.8:19042"));
        assert!(running.stops_at.is_some());

        let own_ip = parse_info(r#"{"state":"running","ip":"1.2.3.4","sshEndpoint":null,"archiveAfter":null}"#).unwrap();
        assert_eq!(own_ip.endpoint.as_deref(), Some("1.2.3.4:22"));
        assert_eq!(own_ip.stops_at, None);

        let stopped = parse_info(r#"{"sandbox":{"state":"archived","ip":"1.2.3.4"}}"#).unwrap();
        assert!(stopped.stopped);
        assert_eq!(stopped.endpoint, None, "a stopped sandbox's last address means nothing");

        assert_eq!(parse_info(r#"{"sandbox":{"state":"error"}}"#), None);
        assert_eq!(parse_info("not json"), None);
    }

    const CONFIG: &str = "# mine\nHost other\n  HostName 9.9.9.9\n  Port 2200\n\nHost boat-dray\n    HostName 37.187.24.197\n    Port 19042\n    User user\n    HostKeyAlias ascii-sandbox-0b1f\n\nHost *\n  ServerAliveInterval 60\n";

    #[test]
    fn edits_only_the_matching_block() {
        let out = repoint_block(CONFIG, "boat-dray", "5.6.7.8", 2222).unwrap();
        assert_eq!(out, CONFIG.replace("37.187.24.197", "5.6.7.8").replace("19042", "2222"));
    }

    #[test]
    fn adds_a_port_only_where_one_is_needed() {
        let config = "Host a\n\tHostName 1.1.1.1\n\tUser u\nHost b\n  HostName 2.2.2.2\n";
        assert_eq!(repoint_block(config, "a", "3.3.3.3", 22).unwrap(), config.replace("1.1.1.1", "3.3.3.3"));
        assert_eq!(
            repoint_block(config, "a", "3.3.3.3", 2222).unwrap(),
            "Host a\n\tHostName 3.3.3.3\n\tPort 2222\n\tUser u\nHost b\n  HostName 2.2.2.2\n"
        );
        assert_eq!(
            repoint_block("Host a\n  HostName 1.1.1.1", "a", "3.3.3.3", 2222).unwrap(),
            "Host a\n  HostName 3.3.3.3\n  Port 2222"
        );
    }

    #[test]
    fn keeps_spelling_and_line_endings() {
        let config = "host a\r\n  hostname=1.1.1.1 # home\r\n  PORT 22\r\n";
        assert_eq!(repoint_block(config, "a", "3.3.3.3", 2222).unwrap(), "host a\r\n  hostname=3.3.3.3 # home\r\n  PORT 2222\r\n");
    }

    #[test]
    fn refuses_a_block_it_does_not_own() {
        assert_eq!(repoint_block("Host a b\n  HostName 1.1.1.1\n", "a", "3.3.3.3", 22), None, "b would move too");
        assert_eq!(repoint_block("Host a*\n  HostName 1.1.1.1\n", "a", "3.3.3.3", 22), None);
        assert_eq!(repoint_block("Host a\n  User u\n", "a", "3.3.3.3", 22), None, "nothing says it is this sandbox");
        assert_eq!(repoint_block("Host other\n  HostName 1.1.1.1\n", "a", "3.3.3.3", 22), None);
        assert_eq!(repoint_block("Match all\n  HostName 1.1.1.1\n", "a", "3.3.3.3", 22), None);
    }

    #[test]
    fn stops_at_a_match_line() {
        let config = "Host a\n  HostName 1.1.1.1\nMatch host a\n  Port 9\n";
        assert_eq!(repoint_block(config, "a", "3.3.3.3", 22).unwrap(), "Host a\n  HostName 3.3.3.3\nMatch host a\n  Port 9\n");
    }

    #[test]
    fn only_a_clean_key_reaches_known_hosts() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN8u";
        assert_eq!(clean_key(key).as_deref(), Some(key));
        assert_eq!(clean_key(&format!("{key} root@box")).as_deref(), Some(key));
        assert_eq!(clean_key(&format!("{key}\nevil.example ssh-rsa AAAA")), None);
        assert_eq!(clean_key("ssh-ed25519 not;base64"), None);
        assert_eq!(clean_key("nonsense AAAA"), None);
    }
}
