//! `dray setup`, `dray service` and `dray serve`: what makes a machine a Dray
//! server. See apps/desktop/SETUP-PLAN.md.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use clap::{Args, Subcommand};

#[derive(Args)]
pub struct Setup {
    /// Install these without asking, which is how a run with no terminal
    /// installs anything: git, gh, claude_code, codex, pi, fx, grok.
    #[arg(long, value_delimiter = ',', value_name = "TOOL")]
    install: Vec<String>,
}

#[derive(Subcommand)]
pub enum ServiceCommand {
    /// Run the server in the background, surviving logout and reboot. Linux only.
    Start,
    /// Show whether the server is running.
    Status,
    /// Stop the server and remove it from the background.
    Uninstall,
}

#[derive(Args)]
pub struct Serve {
    /// Passed to dray-serve, such as --port.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

const LINUX: bool = cfg!(target_os = "linux");

const BAR: &str = "\x1b[90m│\x1b[0m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

struct Tool {
    id: &'static str,
    name: &'static str,
    bin: &'static str,
}

fn tools() -> Vec<Tool> {
    let mut tools = vec![
        Tool { id: "git", name: "git", bin: "git" },
        Tool { id: "gh", name: "GitHub CLI", bin: "gh" },
    ];
    tools.extend(dray_proto::AGENTS.iter().map(|a| Tool { id: a.id, name: a.name, bin: a.bin }));
    tools
}

/// Where vendor installers put a binary, reaching `PATH` only through
/// `.bashrc`: which this process never read, and nor does the login shell the
/// server falls back to, since Ubuntu's `.bashrc` stops for a non-interactive
/// shell. Grok and pi land in their own dirs, the rest in `~/.local/bin`.
const HOME_BIN_DIRS: [&str; 5] = [".local/bin", ".grok/bin", ".pi/agent/bin", ".bun/bin", ".npm-global/bin"];

fn find(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let home = std::env::home_dir();
    std::env::split_paths(&path)
        .chain(home.iter().flat_map(|h| HOME_BIN_DIRS.map(|d| h.join(d))))
        .map(|dir| dir.join(bin))
        .find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

pub fn setup(args: Setup) -> Result<(), String> {
    let all = tools();
    if let Some(bad) = args.install.iter().find(|n| !all.iter().any(|t| t.id == *n)) {
        let names: Vec<_> = all.iter().map(|t| t.id).collect();
        return Err(format!("unknown tool {bad}; pick from {}", names.join(", ")));
    }

    println!("\x1b[90m┌\x1b[0m  Dray setup");
    let (found, missing): (Vec<&Tool>, Vec<&Tool>) = all.iter().partition(|t| find(t.bin).is_some());
    if !found.is_empty() {
        let names: Vec<_> = found.iter().map(|t| t.name).collect();
        done("Found", &names.join(", "));
    }

    let tty = OpenOptions::new().read(true).write(true).open("/dev/tty").ok();
    let picked: Vec<&Tool> = if missing.is_empty() || !args.install.is_empty() {
        missing.into_iter().filter(|t| args.install.iter().any(|n| n == t.id)).collect()
    } else if let Some(tty) = &tty {
        let items: Vec<(String, bool)> = missing
            .iter()
            .map(|t| match t.id {
                "git" => (format!("git {DIM}(Dray needs it){RESET}"), true),
                _ => (t.name.to_string(), false),
            })
            .collect();
        let on = multiselect(tty, "Install what is missing", &items)?;
        missing.into_iter().zip(on).filter_map(|(t, on)| on.then_some(t)).collect()
    } else {
        let names: Vec<_> = missing.iter().map(|t| t.id).collect();
        warn(&format!(
            "Not installed: {}\n{BAR}  {DIM}No terminal to ask in. Run dray setup, or name them with --install{RESET}",
            names.join(", ")
        ));
        Vec::new()
    };

    let mut todo = Vec::new();
    for tool in picked {
        println!("{BAR}\n\x1b[36m●\x1b[0m  Installing {}", tool.name);
        match install(tool, tty.as_ref()) {
            Ok(()) if find(tool.bin).is_some() => done(&format!("{} installed", tool.name), ""),
            Ok(()) => warn(&format!("{} installed, but not where dray can see it yet", tool.name)),
            Err(Manual(command)) => todo.push(command),
            Err(Failed(why)) => warn(&format!("{} did not install: {why}", tool.name)),
        }
    }
    if !todo.is_empty() {
        warn(&format!("Run this yourself, it needs admin rights:\n{BAR}  {}", todo.join(&format!("\n{BAR}  "))));
    }

    let logins = logins_to_do();
    if !logins.is_empty() {
        done("Sign in where you have not yet", &logins.join(&format!("\n{BAR}  ")));
    }

    if !LINUX {
        println!("\x1b[90m└\x1b[0m  Done.");
        return Ok(());
    }
    match service_start() {
        Ok(note) => done("Server running in the background", &note),
        // No line to paste: it would point the app at a server that is not there.
        Err(why) => {
            warn(&why);
            println!("\x1b[90m└\x1b[0m");
            return Err("the server is not running".into());
        }
    }
    println!("\x1b[90m└\x1b[0m  In the Dray app, Add server and paste:\n\n   {}\n{}", ssh_line(), private_note());
    Ok(())
}

fn done(title: &str, body: &str) {
    println!("{BAR}\n\x1b[32m◇\x1b[0m  {title}");
    if !body.is_empty() {
        println!("{BAR}  {body}");
    }
}

fn warn(body: &str) {
    println!("{BAR}\n\x1b[33m▲\x1b[0m  {body}");
}

enum InstallError {
    /// Needs admin rights this run does not have: the command to print.
    Manual(String),
    Failed(String),
}
use InstallError::{Failed, Manual};

fn install(tool: &Tool, tty: Option<&File>) -> Result<(), InstallError> {
    // The vendor scripts ask the odd question on /dev/tty; stdin under
    // `curl | sh` is the rest of the installer, which a child must not eat.
    let stdin = || tty.and_then(|t| t.try_clone().ok()).map_or(Stdio::null(), Stdio::from);
    let script = match tool.id {
        "git" => return install_git(stdin()),
        "gh" if LINUX => GH_LINUX.to_string(),
        "gh" if find("brew").is_some() => "brew install gh".to_string(),
        "gh" => return Err(Failed("get it from https://cli.github.com".into())),
        id => dray_proto::AGENTS.iter().find(|a| a.id == id).map(|a| a.install.to_string()).unwrap_or_default(),
    };
    sh(&script, stdin())
}

fn sh(script: &str, stdin: Stdio) -> Result<(), InstallError> {
    match Command::new("sh").args(["-c", script]).stdin(stdin).status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(Failed(s.to_string())),
        Err(e) => Err(Failed(e.to_string())),
    }
}

/// Root runs it, passwordless sudo runs it under sudo, anyone else is handed
/// the command — a password prompt in the middle of an installer is easy to
/// miss and easy to fat-finger.
fn install_git(stdin: Stdio) -> Result<(), InstallError> {
    if !LINUX {
        return Err(Manual("xcode-select --install".into()));
    }
    let managers = [
        ("apt-get", "apt-get update && apt-get install -y git"),
        ("dnf", "dnf install -y git"),
        ("yum", "yum install -y git"),
        ("apk", "apk add git"),
        ("pacman", "pacman -S --noconfirm git"),
        ("zypper", "zypper install -y git"),
    ];
    let Some((_, cmd)) = managers.iter().find(|(pm, _)| find(pm).is_some()) else {
        return Err(Failed("no package manager this knows".into()));
    };
    if output("id", &["-u"]).as_deref() == Some("0") {
        sh(cmd, stdin)
    } else if Command::new("sudo").args(["-n", "true"]).stderr(Stdio::null()).status().is_ok_and(|s| s.success()) {
        sh(&format!("sudo sh -c '{cmd}'"), stdin)
    } else {
        Err(Manual(format!("sudo sh -c '{cmd}'")))
    }
}

/// gh's own release tarball into ~/.local/bin, checked against the checksums
/// file published beside it. No package manager: a distro's gh is often years
/// old, and adding GitHub's apt repo wants root.
const GH_LINUX: &str = r#"set -eu
case $(uname -m) in x86_64|amd64) a=amd64 ;; aarch64|arm64) a=arm64 ;; *) echo "no gh build for $(uname -m)" >&2; exit 1 ;; esac
v=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$v" ] || { echo "could not find the latest gh release" >&2; exit 1; }
n=gh_${v}_linux_$a
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
curl -fsSL "https://github.com/cli/cli/releases/download/v$v/$n.tar.gz" -o "$t/gh.tgz"
curl -fsSL "https://github.com/cli/cli/releases/download/v$v/gh_${v}_checksums.txt" -o "$t/sums"
[ "$(grep " $n.tar.gz\$" "$t/sums" | cut -d' ' -f1)" = "$(sha256sum "$t/gh.tgz" | cut -d' ' -f1)" ] || { echo "gh checksum mismatch" >&2; exit 1; }
tar -xzf "$t/gh.tgz" -C "$t"
mkdir -p "$HOME/.local/bin" && mv "$t/$n/bin/gh" "$HOME/.local/bin/gh"
"#;

/// Logins still to do, as commands. Asked where a CLI answers by exit code;
/// pi, fx and grok have no such question, so they are listed whenever present.
fn logins_to_do() -> Vec<String> {
    let signed_in = |bin: &PathBuf, args: &[&str]| {
        Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status().is_ok_and(|s| s.success())
    };
    let mut todo = Vec::new();
    for agent in &dray_proto::AGENTS {
        let Some(bin) = find(agent.bin) else { continue };
        let probe: &[&str] = match agent.id {
            "claude_code" => &["auth", "status"],
            "codex" => &["login", "status"],
            _ => &[],
        };
        if probe.is_empty() || !signed_in(&bin, probe) {
            todo.push(agent.login.to_string());
        }
    }
    if find("gh").is_some_and(|gh| !signed_in(&gh, &["auth", "status"])) {
        todo.push("gh auth login".into());
    }
    todo
}

/// What the reader pastes into the app: the address they reached this machine
/// on, which sshd hands every session as the third word of `SSH_CONNECTION`.
fn ssh_line() -> String {
    let user = output("id", &["-un"]).unwrap_or_else(|| "root".into());
    let conn = std::env::var("SSH_CONNECTION").unwrap_or_default();
    ssh_line_for(&user, &conn).unwrap_or_else(|| {
        format!("ssh {user}@{}", output("hostname", &[]).unwrap_or_else(|| "this-machine".into()))
    })
}

fn ssh_line_for(user: &str, conn: &str) -> Option<String> {
    match conn.split_whitespace().collect::<Vec<_>>()[..] {
        [_, _, addr, "22"] => Some(format!("ssh {user}@{addr}")),
        [_, _, addr, port] => Some(format!("ssh -p {port} {user}@{addr}")),
        _ => None,
    }
}

/// A cloud VM behind NAT sees its private address, not the public one the
/// reader typed. Said rather than guessed at: only the reader knows.
fn private_note() -> String {
    let conn = std::env::var("SSH_CONNECTION").unwrap_or_default();
    let private = match conn.split_whitespace().nth(2).and_then(|a| a.parse().ok()) {
        Some(std::net::IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback(),
        Some(std::net::IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        None => true,
    };
    if private {
        format!("   {DIM}If you reached this machine on another address, use that one.{RESET}\n")
    } else {
        String::new()
    }
}

fn output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

pub fn serve(args: Serve) -> Result<(), String> {
    if !LINUX {
        return Err("dray serve runs on Linux for now. On a Mac, the Dray app is the server.".into());
    }
    let bin = beside("dray-serve")?;
    let err = Command::new(&bin).args(args.args).exec();
    Err(format!("could not run {}: {err}", bin.display()))
}

fn beside(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("could not find the running dray binary: {e}"))?;
    let bin = exe.with_file_name(name);
    if bin.is_file() {
        Ok(bin)
    } else {
        Err(format!(
            "{} is missing. Reinstall: curl -fsSL {} | sh",
            bin.display(),
            super::INSTALLER_URL
        ))
    }
}

pub fn service(command: ServiceCommand) -> Result<(), String> {
    if !LINUX {
        return Err("dray service runs on Linux for now.".into());
    }
    match command {
        ServiceCommand::Start => {
            let note = service_start()?;
            println!("The server is running in the background.\n{note}");
        }
        ServiceCommand::Status => {
            if !systemctl(false, &["status", UNIT, "--no-pager"]) {
                return Err("the server is not running".into());
            }
        }
        ServiceCommand::Uninstall => {
            let file = unit_path()?;
            if !file.exists() {
                println!("No background server is installed.");
                return Ok(());
            }
            // The unit file stays until the server is stopped, or it would be
            // left running with nothing to manage it by.
            if !systemctl(false, &["disable", "--now", UNIT]) {
                return Err("systemd would not stop the server; it is still installed".into());
            }
            std::fs::remove_file(&file).map_err(|e| format!("could not remove {}: {e}", file.display()))?;
            let _ = systemctl(true, &["daemon-reload"]);
            println!("Removed the background server.");
        }
    }
    Ok(())
}

const UNIT: &str = "dray.service";

pub fn unit_path() -> Result<PathBuf, String> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|h| h.join(".config")))
        .ok_or("could not resolve your home directory")?;
    Ok(config.join("systemd/user").join(UNIT))
}

fn systemctl(quiet: bool, args: &[&str]) -> bool {
    let out = || if quiet { Stdio::null() } else { Stdio::inherit() };
    Command::new("systemctl").arg("--user").args(args).stdout(out()).stderr(out())
        .status().is_ok_and(|s| s.success())
}

/// A systemd user unit, kept alive across logout and reboot by linger. Writes
/// the unit every time, so `PATH` follows wherever the reader last ran this
/// from, and never restarts a running server — that would kill its agents.
fn service_start() -> Result<String, String> {
    if !systemctl(true, &["show-environment"]) {
        return Err("No systemd user session here, so nothing can keep the server running. \
                    Start it yourself under tmux or nohup: dray serve"
            .into());
    }
    let serve = beside("dray-serve")?;
    let dir = serve.parent().unwrap_or(&serve).display().to_string();
    // Every agent dir whether or not it exists yet, so one installed after the
    // server starts is found without rewriting the unit.
    let home = std::env::home_dir().ok_or("could not resolve your home directory")?;
    let homes: Vec<String> = HOME_BIN_DIRS.iter().map(|d| home.join(d).display().to_string()).collect();
    let path = format!("{dir}:{}:{}", homes.join(":"), std::env::var("PATH").unwrap_or_default());
    // `%` is systemd's specifier character, so a literal one is doubled.
    let unit = format!(
        "[Unit]\nDescription=Dray server\n\n[Service]\nExecStart=\"{}\"\nEnvironment=\"PATH={}\"\n\
         Restart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
        serve.display().to_string().replace('%', "%%"),
        path.replace('%', "%%"),
    );
    let file = unit_path()?;
    std::fs::create_dir_all(file.parent().unwrap_or(&file))
        .and_then(|()| std::fs::write(&file, unit))
        .map_err(|e| format!("could not write {}: {e}", file.display()))?;

    let was_running = systemctl(true, &["is-active", UNIT]);
    if !systemctl(true, &["daemon-reload"]) || !systemctl(true, &["enable", "--now", UNIT]) {
        return Err(format!("systemd would not start the server. See: systemctl --user status {UNIT}"));
    }
    // A server that cannot bind exits at once, and `enable --now` has already
    // answered success by then.
    std::thread::sleep(std::time::Duration::from_millis(1500));
    if !systemctl(true, &["is-active", UNIT]) {
        return Err("The server did not stay up. See why: journalctl --user -u dray -n 20".into());
    }

    let mut note = String::from("dray service status");
    if !linger() {
        let user = output("id", &["-un"]).unwrap_or_default();
        note += &format!(
            "\n{BAR}  It stops when you log out. To keep it running: sudo loginctl enable-linger {user}"
        );
    }
    if was_running {
        note += &format!(
            "\n{BAR}  It was already running. A newer dray-serve takes over on restart, \
             which stops running agents: systemctl --user restart dray"
        );
    }
    Ok(note)
}

/// Without linger, systemd stops a user's services at their last logout and
/// starts none at boot.
fn linger() -> bool {
    let user = output("id", &["-un"]).unwrap_or_default();
    let on = || output("loginctl", &["show-user", &user, "--property=Linger", "--value"]).as_deref() == Some("yes");
    let quiet = |cmd: &mut Command| cmd.stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    on() || quiet(Command::new("loginctl").args(["enable-linger", &user]))
        || quiet(Command::new("sudo").args(["-n", "loginctl", "enable-linger", &user]))
}

/// A checklist in the `npx skills` style, read off the terminal rather than
/// stdin, which under `curl | sh` is the installer itself. Arrows move, space
/// ticks, enter confirms; ctrl-c cancels.
fn multiselect(tty: &File, title: &str, items: &[(String, bool)]) -> Result<Vec<bool>, String> {
    let stty = |args: &[&str]| -> Option<String> {
        let out = Command::new("stty").args(args).stdin(tty.try_clone().ok()?).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let saved = stty(&["-g"]).ok_or("could not read the terminal's settings")?;
    stty(&["raw", "-echo"]).ok_or("could not set up the terminal")?;
    // Restored on every way out, panics included, or the reader's shell is
    // left with no echo.
    struct Restore<'a>(&'a dyn Fn(&[&str]) -> Option<String>, String, &'a File);
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            (self.0)(&[self.1.as_str()]);
            let _ = write!(self.2, "\x1b[?25h");
        }
    }
    let _restore = Restore(&stty, saved, tty);
    let (mut out, mut input) = (tty, tty);

    let mut on: Vec<bool> = items.iter().map(|(_, on)| *on).collect();
    let mut at = 0;
    let mut first = true;
    let picked = loop {
        let mut frame = String::new();
        if !first {
            frame += &format!("\x1b[{}A\r\x1b[J", items.len() + 2);
        }
        first = false;
        frame += &format!("\x1b[?25l{BAR}\r\n\x1b[36m◆\x1b[0m  {title} {DIM}(space to pick, enter to install){RESET}\r\n");
        for (i, (label, _)) in items.iter().enumerate() {
            let mark = match (on[i], i == at) {
                (true, _) => "\x1b[32m◼\x1b[0m",
                (false, true) => "\x1b[36m◻\x1b[0m",
                (false, false) => "\x1b[2m◻\x1b[0m",
            };
            let text = if i == at { label.clone() } else { format!("{DIM}{label}{RESET}") };
            frame += &format!("\x1b[36m│\x1b[0m  {mark} {text}\r\n");
        }
        frame += "\x1b[36m└\x1b[0m\r\n";
        out.write_all(frame.as_bytes()).map_err(|e| e.to_string())?;

        let mut key = [0u8; 3];
        let mut n = input.read(&mut key).map_err(|e| e.to_string())?;
        // Over SSH an arrow's three bytes can arrive in two reads.
        while n > 0 && n < 3 && key[0] == 0x1b {
            match input.read(&mut key[n..]).map_err(|e| e.to_string())? {
                0 => break,
                more => n += more,
            }
        }
        match &key[..n] {
            b"\x1b[A" | b"k" => at = (at + items.len() - 1) % items.len(),
            b"\x1b[B" | b"j" => at = (at + 1) % items.len(),
            b" " => on[at] = !on[at],
            b"\r" | b"\n" => break Some(on),
            b"\x03" | b"q" => break None,
            _ => {}
        }
    };

    // Collapse to the clack-style summary line, as the prompt answered.
    let summary: Vec<&str> = match &picked {
        Some(on) => items.iter().zip(on).filter(|(_, on)| **on).map(|((l, _), _)| l.as_str()).collect(),
        None => vec!["cancelled"],
    };
    let summary = if summary.is_empty() { "nothing".to_string() } else { summary.join(", ") };
    let head = if picked.is_some() { "\x1b[32m◇\x1b[0m" } else { "\x1b[31m■\x1b[0m" };
    let _ = write!(out, "\x1b[{}A\r\x1b[J{BAR}\r\n{head}  {title}\r\n{BAR}  {DIM}{summary}{RESET}\r\n", items.len() + 2);
    picked.ok_or_else(|| "cancelled".to_string())
}

#[cfg(test)]
mod tests {
    use super::ssh_line_for;

    #[test]
    fn the_ssh_line_names_the_address_and_port_the_reader_used() {
        let at = |conn| ssh_line_for("ana", conn);
        assert_eq!(at("203.0.113.9 51234 198.51.100.7 22").as_deref(), Some("ssh ana@198.51.100.7"));
        assert_eq!(at("203.0.113.9 51234 198.51.100.7 2222").as_deref(), Some("ssh -p 2222 ana@198.51.100.7"));
        assert_eq!(at("2001:db8::1 51234 2001:db8::7 22").as_deref(), Some("ssh ana@2001:db8::7"));
        assert_eq!(at(""), None);
    }
}
