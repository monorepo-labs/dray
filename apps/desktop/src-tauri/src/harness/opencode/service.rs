//! OpenCode 2's background service, stopped once nothing uses it (#1658).
//!
//! Every `opencode` command but `acp` and `run` talks to one shared service,
//! `opencode serve --service`, and starts it where none runs: `models`, `api`,
//! `debug agents` and `auth`, which are exactly what Dray reads its model list,
//! sign-ins and agent list with. The service never exits on its own (2.4.2 has
//! no idle timeout), so one model-list read left ~270MB running for good.
//! Dray's sessions don't need it — `opencode acp` runs a private
//! `serve --stdio` per child — so stopping it costs only the next read a cold
//! start, which [`GRACE`] spares a quick next task.
//!
//! The service is stopped only when every one of these holds:
//!
//! - nothing in Dray touched OpenCode for [`GRACE`], and no OpenCode turn,
//!   card or queued prompt is live here;
//! - the pid `service.json` names is an `opencode serve --service`, read off
//!   its command line, since 2.4.2's own `service stop` signals whatever pid
//!   the file names;
//! - `GET /api/session/active` answers with no session running. It lists every
//!   session running in the service, whichever client started it: the TUI, the
//!   app, `opencode run` (which joins a service that is up);
//! - no other OpenCode client is open. A TUI brings a stopped service back
//!   within a second, interrupting what it had in flight, so a TUI open at all
//!   holds the service, idle or not.
//!
//! Then OpenCode's own `opencode service stop` does it. The next command that
//! needs a service starts one, as it always has.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

/// How long OpenCode sits unused by Dray before its service may stop.
const GRACE: Duration = Duration::from_secs(5 * 60);

/// How often the service is looked at with nothing prompting a look.
const SWEEP_EVERY: Duration = Duration::from_secs(10 * 60);

static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// When Dray last used OpenCode, as milliseconds past [`EPOCH`].
static LAST_USE: AtomicU64 = AtomicU64::new(0);

/// Bumped by each [`settled`], so only the newest scheduled look runs.
static SETTLED: AtomicU64 = AtomicU64::new(0);

/// Notes that Dray is using OpenCode, which holds the service for [`GRACE`].
/// Called before every `opencode` command Dray runs and on every spawn.
pub fn touch() {
    LAST_USE.store(EPOCH.elapsed().as_millis() as u64, Ordering::Release);
}

/// An OpenCode turn ended or its child exited: look again once the grace has
/// run, rather than waiting on the slow sweep.
pub fn settled() {
    touch();
    let mine = SETTLED.fetch_add(1, Ordering::AcqRel) + 1;
    tokio::spawn(async move {
        tokio::time::sleep(GRACE + Duration::from_secs(5)).await;
        if SETTLED.load(Ordering::Acquire) == mine {
            stop_if_idle().await;
        }
    });
}

/// The slow sweep, for the life of the process hosting sessions. Boot counts
/// as a use, so a launch never stops a service in its first minutes.
pub async fn run() {
    touch();
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + SWEEP_EVERY, SWEEP_EVERY);
    loop {
        tick.tick().await;
        stop_if_idle().await;
    }
}

fn unused_for_grace() -> bool {
    let last = Duration::from_millis(LAST_USE.load(Ordering::Acquire));
    EPOCH.elapsed().saturating_sub(last) >= GRACE
}

#[cfg(not(unix))]
async fn stop_if_idle() {}

/// Stops the service where nothing uses it. Every doubt keeps it running.
#[cfg(unix)]
async fn stop_if_idle() {
    if !unused_for_grace() {
        return;
    }
    // A missing file is the common answer and costs one read.
    let Some(file) = registration_file() else { return };
    let Some(service) = read_registration(&file).await else { return };
    if !crate::binpath::opencode_v2().await || crate::session::manager().harness_busy(crate::harness::Harness::OpenCode).await {
        return;
    }
    let table = tokio::task::spawn_blocking(crate::local_servers::command_lines).await.unwrap_or_default();
    if let Err(why) = judge(service.pid, &table) {
        eprintln!("[opencode service] left running: {why}");
        return;
    }
    match active_sessions(&service).await {
        Ok(0) => {}
        Ok(running) => {
            eprintln!("[opencode service] left running: {running} session(s) running in it");
            return;
        }
        Err(why) => {
            eprintln!("[opencode service] left running: couldn't ask it what runs: {why}");
            return;
        }
    }
    // Asking took time; a use or a new registration in it wins.
    if !unused_for_grace() || read_registration(&file).await.is_none_or(|now| now.pid != service.pid) {
        return;
    }
    let bin = crate::binpath::opencode().await;
    let stopped = tokio::time::timeout(
        Duration::from_secs(30),
        crate::binpath::command(&bin)
            .args(["service", "stop"])
            .env("PATH", crate::harness::agent_path(&bin))
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    match stopped {
        Ok(Ok(out)) if out.status.success() => {
            eprintln!("[opencode service] stopped idle service, pid {}", service.pid)
        }
        Ok(Ok(out)) => eprintln!(
            "[opencode service] stop failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Ok(Err(err)) => eprintln!("[opencode service] couldn't run opencode service stop: {err}"),
        Err(_) => eprintln!("[opencode service] opencode service stop timed out"),
    }
}

/// What `service.json` holds: `{id?, version?, url, pid, password?}`.
#[derive(Debug, serde::Deserialize)]
struct Registration {
    url: String,
    pid: u32,
    #[serde(default)]
    password: Option<String>,
}

/// A stable 2.x's registration. Other channels name theirs
/// `service-<channel>.json` and are left alone.
// ponytail: XDG on macOS and Linux, as `opencode_set_key` reads it; Windows
// is unmeasured and never gets here.
fn registration_file() -> Option<std::path::PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|dir| !dir.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::home_dir().map(|home| home.join(".local/state")))?;
    Some(state.join("opencode/service.json"))
}

async fn read_registration(file: &std::path::Path) -> Option<Registration> {
    serde_json::from_str(&tokio::fs::read_to_string(file).await.ok()?).ok()
}

/// How many sessions run in the service now. Idle ones are absent from
/// `{"data": {"ses_…": {"type": "running"}}}`.
async fn active_sessions(service: &Registration) -> anyhow::Result<usize> {
    let response = crate::http()
        .get(format!("{}/api/session/active", service.url.trim_end_matches('/')))
        .basic_auth("opencode", service.password.as_deref())
        .timeout(Duration::from_secs(5))
        .send()
        .await?;
    anyhow::ensure!(response.status().is_success(), "it answered {}", response.status());
    running_in(&response.text().await?)
}

fn running_in(body: &str) -> anyhow::Result<usize> {
    let body: serde_json::Value = serde_json::from_str(body)?;
    let data = body.get("data").and_then(|d| d.as_object()).ok_or_else(|| anyhow::anyhow!("no session map in its answer"))?;
    Ok(data.len())
}

/// What an OpenCode process is to the service.
#[derive(Debug, PartialEq, Eq)]
enum Role {
    /// `serve`: the service itself or a client's private server.
    Server { service: bool },
    /// `acp`, which runs its own private server.
    Acp,
    /// Anything else — the TUI, `attach`, `web`, `run`, a command in flight —
    /// talks to the service.
    Client,
}

/// Reads a command line as an OpenCode process, or `None` for anything else.
/// The program is `opencode` under any install's spelling (`opencode2`,
/// brew's `opencode-v2`), run straight or through `node`/`bun`.
fn role(args: &str) -> Option<Role> {
    let mut words = args.split_whitespace();
    let base = |word: &str| word.rsplit('/').next().unwrap_or_default().to_string();
    let mut program = base(words.next()?);
    if matches!(program.as_str(), "node" | "bun") {
        program = base(words.next()?);
    }
    let program = program.trim_start_matches('.');
    let program = program.strip_suffix(".exe").unwrap_or(program);
    if !(program == "opencode" || program == "opencode2" || program == "opencode-v2") {
        return None;
    }
    let rest: Vec<&str> = words.collect();
    Some(match rest.iter().find(|word| !word.starts_with('-')) {
        Some(&"serve") => Role::Server { service: rest.contains(&"--service") },
        Some(&"acp") => Role::Acp,
        _ => Role::Client,
    })
}

/// Whether the registered `pid` is OpenCode's service and nothing else holds
/// it. A server's or `acp`'s own descendants — a terminal daemon, MCP and
/// language servers — are its business, not clients.
fn judge(pid: u32, table: &[(u32, u32, String)]) -> Result<(), String> {
    let roles: std::collections::HashMap<u32, Option<Role>> =
        table.iter().map(|(pid, _, args)| (*pid, role(args))).collect();
    if roles.get(&pid) != Some(&Some(Role::Server { service: true })) {
        return Err(format!("pid {pid} is not an opencode serve --service"));
    }
    let parent: std::collections::HashMap<u32, u32> = table.iter().map(|(pid, ppid, _)| (*pid, *ppid)).collect();
    let under_a_server = |mut at: u32| {
        // Bounded, so a cycle in a stale table cannot spin.
        for _ in 0..64 {
            let Some(&up) = parent.get(&at) else { return false };
            if matches!(roles.get(&up), Some(Some(Role::Server { .. } | Role::Acp))) {
                return true;
            }
            at = up;
        }
        false
    };
    match table
        .iter()
        .find(|(pid, _, _)| roles.get(pid) == Some(&Some(Role::Client)) && !under_a_server(*pid))
    {
        Some((client, _, args)) => Err(format!("an OpenCode client is open (pid {client}: {args})")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, args: &str) -> (u32, u32, String) {
        (pid, ppid, args.to_string())
    }

    #[test]
    fn every_spelling_of_opencode_is_read() {
        assert_eq!(role("/opt/homebrew/bin/opencode-v2 serve --service"), Some(Role::Server { service: true }));
        assert_eq!(
            role("/home/u/.nvm/versions/node/v24/lib/node_modules/@opencode/cli-linux-x64/bin/opencode serve --stdio --port 0"),
            Some(Role::Server { service: false })
        );
        assert_eq!(role("node /usr/lib/node_modules/@opencode/cli/bin/opencode.exe acp"), Some(Role::Acp));
        assert_eq!(role("opencode2 --print-logs run slow prompt"), Some(Role::Client));
        assert_eq!(role("opencode"), Some(Role::Client));
        assert_eq!(role("/usr/local/bin/opencode /home/u/project"), Some(Role::Client));
        assert_eq!(role("opencode attach http://127.0.0.1:49374"), Some(Role::Client));
        assert_eq!(role("/usr/bin/vim opencode.json"), None);
        assert_eq!(role("opencode-pty --socket /tmp/x"), None);
    }

    #[test]
    fn a_lone_service_may_stop() {
        let table = [row(1, 0, "init"), row(50, 1, "opencode serve --service"), row(51, 50, "opencode-pty")];
        assert_eq!(judge(50, &table), Ok(()));
    }

    #[test]
    fn a_pid_that_is_not_the_service_is_never_stopped() {
        let table = [row(50, 1, "/usr/bin/python3 server.py"), row(60, 1, "opencode serve --stdio --port 0")];
        assert!(judge(50, &table).is_err());
        assert!(judge(60, &table).is_err());
        assert!(judge(70, &table).is_err());
    }

    #[test]
    fn an_open_tui_holds_the_service() {
        let table = [row(50, 1, "opencode serve --service"), row(80, 7, "opencode")];
        assert!(judge(50, &table).unwrap_err().contains("pid 80"));
    }

    #[test]
    fn a_run_holds_the_service_until_it_exits() {
        let table = [row(50, 1, "opencode serve --service"), row(81, 7, "opencode run write a poem")];
        assert!(judge(50, &table).is_err());
    }

    #[test]
    fn dray_sessions_and_their_children_hold_nothing() {
        let table = [
            row(50, 1, "opencode serve --service"),
            row(90, 2, "/usr/local/bin/opencode acp"),
            row(91, 90, "/usr/local/bin/opencode serve --stdio --port 0"),
            row(92, 91, "/usr/bin/python3 /home/u/.config/ascii/computer-mcp.py"),
            row(93, 91, "opencode run nested"),
        ];
        assert_eq!(judge(50, &table), Ok(()));
    }

    #[test]
    fn the_active_list_counts_running_sessions() {
        assert_eq!(running_in(r#"{"data":{}}"#).unwrap(), 0);
        assert_eq!(running_in(r#"{"data":{"ses_1":{"type":"running"},"ses_2":{"type":"running"}}}"#).unwrap(), 2);
        assert!(running_in(r#"{"error":"service_starting"}"#).is_err());
        assert!(running_in("HTTP 503").is_err());
    }
}
