//! Vercel sandboxes. Their state is read and moved through Vercel's API with
//! the token the reader's `sandbox login` saved; Dray's server inside is
//! started through the CLI's `exec`, since nothing there keeps one running
//! and a resume kills every process. A sandbox has no SSH, so Dray reaches it
//! by its server's own Remote access address, which lives on the sandbox's disk
//! and so outlives a stop. See docs/sandboxes.md.

use crate::{machines::VercelLink, sandbox::Sandbox};
use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;
use ts_rs::TS;

const API: &str = "https://api.vercel.com";

/// A resume answered in a second when measured. Room for a big snapshot.
pub const RESUMING: Duration = Duration::from_secs(3 * 60);
const QUICK: Duration = Duration::from_secs(20);
/// Turning Remote access on provisions a certificate the first time: 31s measured.
const STARTING: Duration = Duration::from_secs(3 * 60);
/// Installing Dray over `exec`, its download included.
const INSTALLING: Duration = Duration::from_secs(10 * 60);
/// Refresh the token this long before it lapses, rather than send a dying one.
const TOKEN_MARGIN: i64 = 60;

/// Names, team ids and project ids all reach a command line or a URL path.
pub fn valid_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 128
        && !part.starts_with(['-', '.'])
        && part.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}

fn valid(link: &VercelLink) -> Result<(), String> {
    [&link.name, &link.team, &link.project]
        .iter()
        .all(|p| valid_part(p))
        .then_some(())
        .ok_or_else(|| format!("{} is not a Vercel sandbox name", link.name))
}

/// The login `sandbox login` saved. Never `vercel login`'s: that CLI can keep
/// its token in the keychain, where nothing here reads it.
fn auth_file() -> Option<PathBuf> {
    let home = std::env::home_dir()?;
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/com.vercel.cli")
    } else {
        home.join(".local/share/com.vercel.cli")
    };
    Some(dir.join("auth.json"))
}

/// The token and when it lapses, in unix seconds.
async fn read_auth() -> Option<(String, Option<i64>)> {
    let text = tokio::fs::read_to_string(auth_file()?).await.ok()?;
    parse_auth(&text)
}

fn parse_auth(text: &str) -> Option<(String, Option<i64>)> {
    let auth: Value = serde_json::from_str(text).ok()?;
    let token = auth.get("token")?.as_str().filter(|t| !t.is_empty())?.to_string();
    Some((token, auth.get("expiresAt").and_then(Value::as_i64)))
}

fn lapsing(expires_at: Option<i64>) -> bool {
    expires_at.is_some_and(|at| at - TOKEN_MARGIN <= Utc::now().timestamp())
}

/// The saved token, read each call so a logout takes effect. One about to lapse
/// is refreshed by running the CLI, which refreshes as any command starts and
/// saves the result: refreshing here would rotate the refresh token out from
/// under it. A refresh that fails makes the CLI ask for a login, which with no
/// terminal waits out `QUICK` and leaves the token lapsed, so no UI.
async fn token() -> Option<String> {
    static REFRESHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let (token, expires_at) = read_auth().await?;
    if !lapsing(expires_at) {
        return Some(token);
    }
    let _one = REFRESHING.lock().await;
    // Another caller may have refreshed it while this one waited.
    let (token, expires_at) = read_auth().await?;
    if !lapsing(expires_at) {
        return Some(token);
    }
    let _ = cli(&["ls"], QUICK).await;
    let (token, expires_at) = read_auth().await?;
    (!lapsing(expires_at)).then_some(token)
}

/// Runs the CLI. `None` where it is not here.
async fn cli(args: &[&str], limit: Duration) -> Option<std::io::Result<std::process::Output>> {
    let bin = crate::binpath::vercel_sandbox()?;
    let out = Command::new(&bin)
        .args(args)
        .env("PATH", crate::binpath::node_path(&bin))
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(limit, out).await {
        Ok(out) => Some(out),
        Err(_) => Some(Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Vercel's CLI did not answer in time"))),
    }
}

/// One call to Vercel's API, scoped to `query`.
async fn call(method: Method, path: &str, query: &[(&str, &str)], body: Option<Value>, limit: Duration) -> Result<Value, String> {
    let token = token().await.ok_or("Vercel's sandbox CLI isn't logged in on this Mac. Run: sandbox login")?;
    let mut request = crate::http().request(method, format!("{API}{path}")).query(query).bearer_auth(token).timeout(limit);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let answer = request.send().await.map_err(|e| format!("Could not reach Vercel: {e}"))?;
    let status = answer.status();
    let value: Value = answer.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(value)
    } else {
        Err(refusal(&value))
    }
}

fn refusal(value: &Value) -> String {
    match value.pointer("/error/message").and_then(Value::as_str) {
        Some(why) => format!("Vercel refused: {why}"),
        None => "Vercel refused, and gave no reason.".into(),
    }
}

/// A call about one sandbox. Its own query spelling: the list takes `project`
/// where every call on one sandbox takes `projectId`.
async fn on(link: &VercelLink, method: Method, path: &str, extra: &[(&str, &str)], body: Option<Value>, limit: Duration) -> Result<Value, String> {
    valid(link)?;
    let mut query = vec![("teamId", link.team.as_str()), ("projectId", link.project.as_str())];
    query.extend_from_slice(extra);
    call(method, path, &query, body, limit).await
}

/// The sandbox's state, or `None` for anything else: no CLI, logged out,
/// offline, a sandbox this login cannot see. All of those mean no UI.
pub async fn info(link: &VercelLink) -> Option<Sandbox> {
    let value = on(link, Method::GET, &format!("/v2/sandboxes/{}", link.name), &[], None, QUICK).await.ok()?;
    parse_info(&value)
}

fn parse_info(value: &Value) -> Option<Sandbox> {
    let sandbox = value.get("sandbox")?;
    let stopped = match sandbox.get("status")?.as_str()? {
        "running" | "pending" => false,
        "stopped" | "stopping" | "snapshotting" => true,
        _ => return None,
    };
    let stops_at = sandbox
        .get("expiresAt")
        .and_then(Value::as_i64)
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .filter(|_| !stopped);
    Some(Sandbox { stopped, endpoint: None, stops_at })
}

/// Starts a new session from the sandbox's saved disk. Returns once Vercel says
/// it runs, which is before Dray's server does: see [`start_server`].
pub async fn resume(link: &VercelLink) -> Result<(), String> {
    let value = on(link, Method::GET, &format!("/v2/sandboxes/{}", link.name), &[("resume", "true")], None, RESUMING).await?;
    match parse_info(&value) {
        Some(sandbox) if !sandbox.stopped => Ok(()),
        _ => Err(format!("Vercel didn't start {} again.", link.name)),
    }
}

/// Sets the time left to `minutes`, and every later session's length, the way
/// boat's `--ttl` does. Vercel only adds, so the session gets the difference;
/// one already running longer is left alone, since nothing shortens it.
pub async fn extend(link: &VercelLink, minutes: u32) -> Result<(), String> {
    let want = i64::from(minutes) * 60_000;
    let value = on(link, Method::GET, &format!("/v2/sandboxes/{}", link.name), &[], None, QUICK).await?;
    let sandbox = value.get("sandbox").ok_or("Vercel sent no sandbox")?;
    let session = sandbox.get("currentSessionId").and_then(Value::as_str).filter(|s| valid_part(s));
    let expires_at = sandbox.get("expiresAt").and_then(Value::as_i64);
    if let (Some(session), Some(expires_at)) = (session, expires_at) {
        let more = want - (expires_at - Utc::now().timestamp_millis());
        if more > 0 {
            let path = format!("/v2/sandboxes/sessions/{session}/extend-timeout");
            on(link, Method::POST, &path, &[], Some(json!({ "duration": more })), QUICK).await?;
        }
    }
    on(link, Method::PATCH, &format!("/v2/sandboxes/{}", link.name), &[], Some(json!({ "timeout": want })), QUICK).await?;
    Ok(())
}

/// Runs `script` in the sandbox through the CLI, and answers the lines it
/// marked as its own. The CLI echoes the command first, script and all, so
/// only a line *starting* with the mark counts.
async fn exec(link: &VercelLink, script: &str, limit: Duration) -> Result<Vec<String>, String> {
    valid(link)?;
    let args = ["exec", &link.name, "--scope", &link.team, "--project", &link.project, "--", "sh", "-c", script];
    let out = cli(&args, limit).await.ok_or("Vercel's sandbox CLI isn't installed on this Mac.")?;
    let out = out.map_err(|e| format!("Could not run Vercel's sandbox CLI: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let said: Vec<String> = text.lines().filter_map(|l| l.strip_prefix("DRAY-VERCEL ")).map(str::to_string).collect();
    if out.status.success() {
        return Ok(said);
    }
    Err(format!("Vercel's sandbox CLI failed: {}", failure(&String::from_utf8_lossy(&out.stderr), &text)))
}

/// Why a run failed: stderr's last word, where the CLI also echoes the command
/// as `$ …`, else stdout's. Stdout's last line alone was a progress line that
/// said nothing ("Downloading dray…") over a 504 on stderr.
fn failure<'a>(stderr: &'a str, stdout: &'a str) -> &'a str {
    let last = |text: &'a str| text.lines().map(str::trim).rfind(|l| !l.is_empty() && !l.starts_with("$ "));
    last(stderr).or_else(|| last(stdout)).unwrap_or("no reason given")
}

/// Starts Dray's server in the sandbox unless one runs. Answers whether it
/// started one. Remote access is a setting the server keeps on disk, so a
/// server started here serves its old address again.
pub async fn start_server(link: &VercelLink) -> Result<bool, String> {
    let said = exec(link, &start_script(), QUICK).await?;
    match said.first().map(String::as_str) {
        Some("up") => Ok(false),
        Some("started") => Ok(true),
        Some("missing") => Err(format!("Dray isn't installed on {} any more. Remove it and add it again.", link.name)),
        _ => Err(format!("Dray's server didn't start on {}.", link.name)),
    }
}

/// `ps` rather than `pgrep`: Vercel's image has no `pgrep`, `nohup` or
/// `setsid`. A plain `&` is enough, measured: `exec` returning leaves the
/// server running, handed to the sandbox's init.
fn start_script() -> String {
    format!(
        "PATH=\"{dirs}:$PATH\"; \
         command -v dray >/dev/null 2>&1 || {{ echo DRAY-VERCEL missing; exit 0; }}; \
         if ps -eo comm= | grep -qx dray-serve; then echo DRAY-VERCEL up; exit 0; fi; \
         mkdir -p \"$HOME/.dray\"; \
         dray server run >\"$HOME/.dray/serve.log\" 2>&1 </dev/null & \
         echo DRAY-VERCEL started",
        dirs = crate::ssh::AGENT_DIRS
    )
}

/// What adding a sandbox reached: its server's public address and token.
pub struct Reached {
    pub url: String,
    pub token: String,
}

/// Makes a sandbox a Dray server: resumes it if stopped, installs Dray if it
/// isn't there, starts the server and turns Remote access on, then reads back
/// the address and token. Each step is a no-op where already done.
pub async fn bring_up(link: &VercelLink) -> Result<Reached, String> {
    let sandbox = info(link).await.ok_or_else(|| format!("Vercel can't see {} from this login.", link.name))?;
    if sandbox.stopped {
        resume(link).await?;
    }
    // A sandbox just started or resumed answers its first GitHub download with
    // a 504, for a while: four of six tries failed, then the same download
    // took 0.06s. So wait it out. The script is a no-op once installed.
    let mut tries = 1;
    while let Err(why) = exec(link, &install_script(), INSTALLING).await {
        if tries == 5 {
            return Err(why);
        }
        tries += 1;
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
    start_server(link).await?;
    let said = exec(link, &tunnel_script(), STARTING).await?;
    let read = |key: &str| said.iter().find_map(|l| l.strip_prefix(key)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let url = read("url ").ok_or_else(|| format!("Dray's server on {} has no public address yet. Try again in a minute.", link.name))?;
    let token = read("token ").ok_or_else(|| format!("Dray's server on {} has no token.", link.name))?;
    Ok(Reached { url: url.replacen("https://", "wss://", 1), token })
}

/// Dray's own installer, with its setup's server start skipped: that wants
/// systemd, which a sandbox has none of. Vercel's image already carries the
/// agents and `gh`.
fn install_script() -> String {
    format!(
        "PATH=\"{dirs}:$PATH\"; command -v dray >/dev/null 2>&1 && exit 0; \
         s=$(curl -fsSL {url}) || {{ echo Could not download {url} >&2; exit 1; }}; \
         DRAY_UPDATING=1 sh -c \"$s\"",
        dirs = crate::ssh::AGENT_DIRS,
        url = "https://www.drayhq.com/install.sh",
    )
}

/// `dray tunnel` turns Remote access on and nothing else, where `dray service
/// tunnel on` would first ask systemd for the server.
fn tunnel_script() -> String {
    format!(
        "PATH=\"{dirs}:$PATH\"; i=0; \
         while [ $i -lt 30 ] && ! dray tunnel >/dev/null 2>&1; do sleep 1; i=$((i+1)); done; \
         i=0; while [ $i -lt 150 ] && [ ! -s \"$HOME/.dray/tunnel-url\" ]; do sleep 1; i=$((i+1)); done; \
         echo \"DRAY-VERCEL url $(cat \"$HOME/.dray/tunnel-url\" 2>/dev/null)\"; \
         echo \"DRAY-VERCEL token $(cat \"$HOME/.dray/serve-token\" 2>/dev/null)\"",
        dirs = crate::ssh::AGENT_DIRS
    )
}

/// The line Terminal runs to sign an agent in on the sandbox: the CLI's own
/// interactive shell, where SSH would be used on any other server.
pub fn terminal_line(link: &VercelLink, command: &str) -> Result<String, String> {
    use crate::apps::sh_quote;
    valid(link)?;
    let bin = crate::binpath::vercel_sandbox().ok_or("Vercel's sandbox CLI isn't installed on this Mac.")?;
    let path = crate::binpath::node_path(&bin);
    let remote = format!("PATH=\"{}:$PATH\"; exec {command}", crate::ssh::AGENT_DIRS);
    Ok(format!(
        "PATH={} {} exec -i {} --scope {} --project {} -- sh -c {}",
        sh_quote(&path.to_string_lossy()),
        sh_quote(&bin.to_string_lossy()),
        link.name,
        link.team,
        link.project,
        sh_quote(&remote)
    ))
}

/// Whether to offer Vercel at all: the CLI is here and has a login saved. No
/// network, since the Add dialog asks every time it opens.
pub async fn available() -> bool {
    crate::binpath::vercel_sandbox().is_some() && read_auth().await.is_some()
}

/// A sandbox the reader can add, as the Add dialog lists it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct VercelSandbox {
    pub name: String,
    pub team: String,
    pub team_name: String,
    pub project: String,
    pub project_name: String,
    pub stopped: bool,
}

/// Every sandbox this login can see, across its teams and their projects:
/// Vercel lists sandboxes per project only, and the CLI puts its own in a
/// project of its own, `vercel-sandbox-default-project`.
pub async fn list() -> Result<Vec<VercelSandbox>, String> {
    let teams = call(Method::GET, "/v2/teams", &[("limit", "100")], None, QUICK).await?;
    let mut projects = tokio::task::JoinSet::new();
    for team in teams.get("teams").and_then(Value::as_array).into_iter().flatten() {
        let (Some(id), Some(slug)) = (team.get("id").and_then(Value::as_str), team.get("slug").and_then(Value::as_str)) else {
            continue;
        };
        let (id, slug) = (id.to_string(), slug.to_string());
        projects.spawn(async move {
            let found = call(Method::GET, "/v10/projects", &[("teamId", id.as_str()), ("limit", "100")], None, QUICK).await;
            (id, slug, found)
        });
    }
    let mut sandboxes = tokio::task::JoinSet::new();
    while let Some(Ok((team, team_name, found))) = projects.join_next().await {
        for project in found?.get("projects").and_then(Value::as_array).into_iter().flatten() {
            let (Some(id), Some(name)) = (project.get("id").and_then(Value::as_str), project.get("name").and_then(Value::as_str)) else {
                continue;
            };
            let (team, team_name, project, project_name) = (team.clone(), team_name.clone(), id.to_string(), name.to_string());
            sandboxes.spawn(async move {
                // 50 is this list's cap, where teams and projects take 100.
                let query = [("teamId", team.as_str()), ("project", project.as_str()), ("limit", "50")];
                let found = call(Method::GET, "/v2/sandboxes", &query, None, QUICK).await;
                found.map(|value| parse_list(&value, &team, &team_name, &project, &project_name))
            });
        }
    }
    let mut all = Vec::new();
    while let Some(Ok(found)) = sandboxes.join_next().await {
        all.extend(found?);
    }
    all.sort_by(|a, b| (&a.team_name, &a.project_name, &a.name).cmp(&(&b.team_name, &b.project_name, &b.name)));
    Ok(all)
}

fn parse_list(value: &Value, team: &str, team_name: &str, project: &str, project_name: &str) -> Vec<VercelSandbox> {
    let found = value.get("sandboxes").and_then(Value::as_array).into_iter().flatten();
    found
        .filter_map(|sandbox| {
            let name = sandbox.get("name")?.as_str().filter(|n| valid_part(n))?;
            let status = sandbox.get("status").and_then(Value::as_str).unwrap_or_default();
            Some(VercelSandbox {
                name: name.to_string(),
                team: team.to_string(),
                team_name: team_name.to_string(),
                project: project.to_string(),
                project_name: project_name.to_string(),
                stopped: status != "running" && status != "pending",
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_sandbox_as_vercel_sends_it() {
        let running = json!({ "sandbox": { "name": "dray-test-800", "status": "running", "expiresAt": 1794208239856_i64 } });
        let sandbox = parse_info(&running).unwrap();
        assert!(!sandbox.stopped);
        assert_eq!(sandbox.stops_at.unwrap().timestamp_millis(), 1794208239856);

        let stopped = json!({ "sandbox": { "status": "stopped", "currentSessionId": "sbx_x" }, "session": { "status": "stopped" } });
        assert_eq!(parse_info(&stopped), Some(Sandbox { stopped: true, endpoint: None, stops_at: None }));

        assert_eq!(parse_info(&json!({ "sandbox": { "status": "failed" } })), None);
        assert_eq!(parse_info(&json!({ "error": { "message": "not found" } })), None);
    }

    #[test]
    fn reads_the_saved_login() {
        let (token, at) = parse_auth(r#"{"token":"t","refreshToken":"r","expiresAt":1794235000}"#).unwrap();
        assert_eq!((token.as_str(), at), ("t", Some(1794235000)));
        assert_eq!(parse_auth("{}"), None, "logged out writes an empty object");
        assert!(lapsing(Some(Utc::now().timestamp() + 10)));
        assert!(!lapsing(Some(Utc::now().timestamp() + 3600)));
        assert!(!lapsing(None));
    }

    #[test]
    fn only_a_plain_name_reaches_a_command_line() {
        assert!(valid_part("dray-test-800"));
        assert!(valid_part("team_IQqYoyLyifSYMByffWgy1tiI"));
        for bad in ["", "-rf", "a b", "a;b", "../x", "a/b", "$(x)"] {
            assert!(!valid_part(bad), "{bad}");
        }
    }

    #[test]
    fn lists_what_a_project_holds() {
        let value = json!({ "sandboxes": [
            { "name": "a", "status": "running" },
            { "name": "b", "status": "stopped" },
            { "name": "bad name", "status": "running" }
        ] });
        let listed = parse_list(&value, "team_1", "acme", "prj_1", "web");
        assert_eq!(listed.iter().map(|l| (l.name.as_str(), l.stopped)).collect::<Vec<_>>(), [("a", false), ("b", true)]);
    }

    /// A sandbox this Mac's `sandbox login` can see, made a Dray server from
    /// whatever state it is in: `DRAY_TEST_VERCEL="name team_… prj_…"`.
    /// Stop it first to cover resume and the first download after it.
    #[tokio::test]
    #[ignore]
    async fn brings_up_a_live_sandbox() {
        let spec = std::env::var("DRAY_TEST_VERCEL").expect("DRAY_TEST_VERCEL");
        let [name, team, project] = spec.split_whitespace().collect::<Vec<_>>()[..] else { panic!("name team project") };
        let link = VercelLink { name: name.into(), team: team.into(), project: project.into() };
        let reached = bring_up(&link).await.unwrap();
        assert!(reached.url.starts_with("wss://"), "{}", reached.url);
        assert_eq!(reached.token.len(), 64);
        assert!(!start_server(&link).await.unwrap(), "a second start finds it running");
    }

    #[test]
    fn a_failure_says_why_from_stderr() {
        let stderr = "$ sh -c PATH=...\ncurl: (22) The requested URL returned error: 504\ninstall: could not download x.tar.gz\n";
        let stdout = "Finding the latest dray release (stable)…\nDownloading dray (x86_64-unknown-linux-gnu)…\n";
        assert_eq!(failure(stderr, stdout), "install: could not download x.tar.gz");
        assert_eq!(failure("$ sh -c x\n", "boom\n"), "boom", "the echoed command is no reason");
        assert_eq!(failure("", ""), "no reason given");
    }

    #[test]
    fn scripts_hold_no_single_quote() {
        // They ride `sh -c` as one argv word, but the Terminal line quotes them.
        for script in [start_script(), install_script(), tunnel_script()] {
            assert!(!script.contains('\''), "{script}");
        }
    }
}
