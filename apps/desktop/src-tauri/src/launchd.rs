//! The login agent that runs the Mac's background server: this app's own
//! binary with `--serve`, started by launchd at login and kept alive through
//! app quits and crashes. The app installs it on every launch. See
//! MAC-SERVER-PLAN.md.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use tokio::process::Command;

/// A dev build gets its own agent, running the binary cargo just built on
/// `~/.dray-dev`, so it never replaces the release app's server.
fn label() -> &'static str {
    if crate::is_dev() { "com.yogesh.dray.server.dev" } else { "com.yogesh.dray.server" }
}

fn target() -> String {
    format!("gui/{}/{}", unsafe { libc::getuid() }, label())
}

fn plist_path() -> Result<PathBuf> {
    let home = std::env::home_dir().context("no home directory")?;
    Ok(home.join("Library/LaunchAgents").join(format!("{}.plist", label())))
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `Interactive` because the server is the app's own backend: agents run
/// builds under it, and the default applies the light throttling launchd
/// gives background jobs.
fn plist(exe: &str, log: &str) -> String {
    let (label, exe, log) = (label(), escape(exe), escape(log));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>--serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#
    )
}

async fn launchctl(args: &[&str]) -> Result<std::process::Output> {
    Command::new("/bin/launchctl").args(args).output().await.context("could not run launchctl")
}

/// Installs the agent, or points it at this binary where it names another —
/// Dray.app moved, or a second copy opened. Loading a changed plist means
/// unloading the old one, which stops that server and every turn under it, so
/// an unchanged plist is left alone.
pub async fn ensure() -> Result<()> {
    let exe = std::env::current_exe().context("no path to this binary")?;
    let log = crate::store::get_home_app_dir().await?.join(crate::serve::SERVER_LOG);
    if crate::is_dev() {
        return spawn_dev(&exe, &log);
    }
    let wanted = plist(&exe.to_string_lossy(), &log.to_string_lossy());
    let path = plist_path()?;
    let loaded = launchctl(&["print", &target()]).await?.status.success();
    if loaded && tokio::fs::read_to_string(&path).await.is_ok_and(|on_disk| on_disk == wanted) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    tokio::fs::write(&path, wanted).await.with_context(|| format!("could not write {}", path.display()))?;
    if loaded {
        let _ = launchctl(&["bootout", &target()]).await;
    }
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let out = launchctl(&["bootstrap", &domain, &path.to_string_lossy()]).await?;
    if !out.status.success() {
        bail!("launchctl bootstrap: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// A dev build starts its server as a child rather than through launchd. TCC
/// judges a launchd job on its own code identity, and an unsigned binary cargo
/// just rebuilt is a new identity every time, so each rebuild asked for
/// Documents access again and blocked the server in dyld until answered. A
/// child is attributed to the app that started it, which already has access.
/// Cost: nothing restarts a dev server that dies, until the app asks again.
/// A second one exits on its own when the socket already answers, so asking
/// while one runs costs a spawn.
/// Set by [`stop`], or the reconnect loop would start a dev server again in
/// the moment between it stopping and the app exiting.
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn spawn_dev(exe: &std::path::Path, log: &std::path::Path) -> Result<()> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    if STOPPED.load(std::sync::atomic::Ordering::Relaxed) || last.is_some_and(|at| at.elapsed() < Duration::from_secs(5)) {
        return Ok(());
    }
    *last = Some(Instant::now());
    let out = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
    // Its own process group, so Ctrl-C on `pnpm tauri dev` leaves it running
    // the way quitting the release app does.
    Command::new(exe)
        .arg("--serve")
        .stdin(std::process::Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(out)
        .process_group(0)
        .spawn()
        .context("could not start the dev server")?;
    Ok(())
}

/// Stops the server and keeps it stopped until the agent is loaded again —
/// the next launch of the app, or the next login. A dev server has no agent,
/// so it is signalled by the pid it wrote beside its port.
pub async fn stop() -> Result<()> {
    if crate::is_dev() {
        let home = crate::store::get_home_app_dir().await?;
        let written = tokio::fs::read_to_string(home.join(crate::serve::PORT_FILE)).await?;
        let pid: i32 = written.lines().nth(2).and_then(|l| l.trim().parse().ok()).context("no pid in serve-port")?;
        STOPPED.store(true, std::sync::atomic::Ordering::Relaxed);
        unsafe { libc::kill(pid, libc::SIGTERM) };
        return Ok(());
    }
    launchctl(&["bootout", &target()]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plist_runs_this_binary_as_the_server() {
        let text = plist("/Applications/A & B.app/Contents/MacOS/dray", "/Users/me/.dray/server.log");
        assert!(text.contains("<string>/Applications/A &amp; B.app/Contents/MacOS/dray</string><string>--serve</string>"));
        assert!(text.contains("<key>KeepAlive</key><true/>"));
        assert!(text.contains(label()));
    }
}
