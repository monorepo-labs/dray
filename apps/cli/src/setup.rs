//! `dray setup`, `dray service` and `dray serve`: what makes a machine a Dray
//! server. See apps/desktop/SETUP-PLAN.md.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use clap::{Args, Subcommand};

#[derive(Args)]
pub struct Setup {
    /// Install these without asking, which is how a run with no terminal
    /// installs anything: git, gh, claude_code, codex, pi, fx, grok, and on
    /// Linux browser, ffmpeg and cloudflared.
    #[arg(long, value_delimiter = ',', value_name = "TOOL")]
    install: Vec<String>,
}

#[derive(Subcommand)]
pub enum ServiceCommand {
    /// Run the server in the background, surviving logout and reboot. Linux only.
    Start,
    /// Show whether the server is running, and its tunnel address.
    Status,
    /// Stop the server and remove it from the background.
    Uninstall,
    /// Keep a public address in front of the server, through a Cloudflare
    /// quick tunnel, or take it down. Linux only.
    Tunnel {
        #[arg(value_enum)]
        state: OnOff,
    },
}

#[derive(Clone, Copy, PartialEq, clap::ValueEnum)]
pub enum OnOff {
    On,
    Off,
}

#[derive(Args)]
pub struct Tunnel {
    /// The port dray-serve listens on.
    #[arg(long, default_value_t = dray_proto::SERVE_PORT)]
    port: u16,
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
    // A server's `dray browser` downloads its own Chromium; what it cannot
    // fetch is the system libraries that Chromium links against, nor ffmpeg
    // for `record`.
    if LINUX {
        tools.push(Tool { id: "browser", name: "Browser for agents", bin: "" });
        tools.push(Tool { id: "ffmpeg", name: "ffmpeg", bin: "ffmpeg" });
        tools.push(Tool { id: "cloudflared", name: "cloudflared", bin: "cloudflared" });
    }
    tools
}

fn present(tool: &Tool) -> bool {
    match tool.id {
        "browser" => browser_libs_present(),
        _ => find(tool.bin).is_some(),
    }
}

/// What headless Chromium links against and a fresh Ubuntu lacks, as `ldd`
/// reported it, each with the packages that carry it — the `t64` name first,
/// since noble and later renamed them and the old name became virtual, which
/// `apt-get install` refuses.
const BROWSER_LIBS: [(&str, &[&str]); 12] = [
    ("libnspr4.so", &["libnspr4"]),
    ("libnss3.so", &["libnss3"]),
    ("libatk-1.0.so.0", &["libatk1.0-0t64", "libatk1.0-0"]),
    ("libatk-bridge-2.0.so.0", &["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"]),
    ("libatspi.so.0", &["libatspi2.0-0t64", "libatspi2.0-0"]),
    ("libXcomposite.so.1", &["libxcomposite1"]),
    ("libXdamage.so.1", &["libxdamage1"]),
    ("libXfixes.so.3", &["libxfixes3"]),
    ("libXrandr.so.2", &["libxrandr2"]),
    ("libgbm.so.1", &["libgbm1"]),
    ("libxkbcommon.so.0", &["libxkbcommon0"]),
    ("libasound.so.2", &["libasound2t64", "libasound2"]),
];

/// No library Chromium links against, but without fontconfig's config it
/// aborts on start, and without a font every page draws as boxes.
const FONT_PACKAGES: [&str; 3] = ["fontconfig", "fonts-liberation", "fonts-dejavu-core"];

fn browser_libs_present() -> bool {
    let Some(cache) = output("/sbin/ldconfig", &["-p"]) else { return false };
    Path::new("/etc/fonts/fonts.conf").is_file()
        && BROWSER_LIBS.iter().all(|(lib, _)| cache.contains(lib))
}

/// Installs each library's package as this machine's apt names it. Chosen in
/// the script, after `apt-get update`: a fresh image's lists are empty, so
/// asking apt-cache first finds nothing. Single-quote free, since `as_admin`
/// may wrap it in `sudo sh -c '…'`.
fn browser_script() -> String {
    let choose: String = BROWSER_LIBS
        .iter()
        .map(|(lib, packages)| {
            let candidates = packages.join(" ");
            format!(
                "p=; for c in {candidates}; do if apt-cache show $c >/dev/null 2>&1; then p=$c; break; fi; done; \
                 [ -n \"$p\" ] || {{ echo \"apt knows no package for {lib}\" >&2; exit 1; }}; pkgs=\"$pkgs $p\"; "
            )
        })
        .collect();
    format!(
        "apt-get update && pkgs=\"{}\" && {{ {choose}DEBIAN_FRONTEND=noninteractive apt-get install -y $pkgs; }}",
        FONT_PACKAGES.join(" ")
    )
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
    let (found, missing): (Vec<&Tool>, Vec<&Tool>) = all.iter().partition(|t| present(t));
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
                "browser" => (format!("Browser for agents {DIM}(system libraries for dray browser){RESET}"), false),
                "ffmpeg" => (format!("ffmpeg {DIM}(dray browser record){RESET}"), false),
                "cloudflared" => (format!("cloudflared {DIM}(public links to dev servers, dray tunnel){RESET}"), false),
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
            Ok(()) if present(tool) => done(&format!("{} installed", tool.name), ""),
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
        // The browser's two rows know apt's package names alone.
        "browser" | "ffmpeg" if find("apt-get").is_none() => {
            return Err(Failed("this installs with apt alone; use your package manager".into()))
        }
        "browser" => return as_admin(&browser_script(), stdin()),
        "ffmpeg" => return apt("ffmpeg", stdin()),
        "cloudflared" => cloudflared_script()?,
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
    let Some((_, cmd)) = dray_proto::GIT_INSTALLS.iter().find(|(pm, _)| find(pm).is_some()) else {
        return Err(Failed("no package manager this knows".into()));
    };
    as_admin(cmd, stdin)
}

fn apt(packages: &str, stdin: Stdio) -> Result<(), InstallError> {
    as_admin(&format!("apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y {packages}"), stdin)
}

fn as_admin(cmd: &str, stdin: Stdio) -> Result<(), InstallError> {
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

/// The release the app itself would download, into ~/.local/bin, where the
/// app looks first. Linux's asset is the bare binary.
fn cloudflared_script() -> Result<String, InstallError> {
    let build = dray_proto::cloudflared_build().ok_or_else(|| Failed("no cloudflared build for this machine".into()))?;
    Ok(format!(
        r#"set -eu
t=$(mktemp); trap 'rm -f "$t"' EXIT
curl -fsSL "{url}" -o "$t"
[ "$(sha256sum "$t" | cut -d' ' -f1)" = "{sha}" ] || {{ echo "cloudflared checksum mismatch" >&2; exit 1; }}
mkdir -p "$HOME/.local/bin" && install -m 755 "$t" "$HOME/.local/bin/cloudflared"
"#,
        url = build.url(),
        sha = build.sha256
    ))
}

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
            if systemctl(true, &["is-enabled", TUNNEL_UNIT]) {
                match tunnel_address()? {
                    Some(url) => println!("\n{}", connect_text(&url)?),
                    None => println!("\nThe tunnel has no address yet. See why: journalctl --user -u dray-tunnel -n 20"),
                }
            }
        }
        ServiceCommand::Tunnel { state: OnOff::On } => tunnel_on()?,
        ServiceCommand::Tunnel { state: OnOff::Off } => {
            tunnel_off()?;
            println!("The tunnel is down; the server is reachable over SSH alone.");
        }
        ServiceCommand::Uninstall => {
            tunnel_off()?;
            // `stop`, not `disable --now`: a unit stays loaded after its file
            // moved or went, and `disable` refuses one with no file.
            let stopped = systemctl(true, &["stop", UNIT]);
            // Where systemd loaded it from, which is not necessarily where
            // this environment's XDG_CONFIG_HOME would put it.
            let file = output("systemctl", &["--user", "show", UNIT, "--property=FragmentPath", "--value"])
                .map(PathBuf::from)
                .filter(|p| p.exists())
                .unwrap_or(unit_path()?);
            if !file.exists() {
                let _ = systemctl(true, &["daemon-reload"]);
                println!("{}", if stopped { "Stopped the background server." } else { "No background server is installed." });
                return Ok(());
            }
            // The unit file stays until the server is stopped, or it would be
            // left running with nothing to manage it by.
            if !stopped || !systemctl(true, &["disable", UNIT]) {
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
const TUNNEL_UNIT: &str = "dray-tunnel.service";

pub fn unit_path() -> Result<PathBuf, String> {
    unit_file(UNIT)
}

fn unit_file(name: &str) -> Result<PathBuf, String> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|h| h.join(".config")))
        .ok_or("could not resolve your home directory")?;
    Ok(config.join("systemd/user").join(name))
}

fn write_unit(file: &Path, unit: &str) -> Result<(), String> {
    std::fs::create_dir_all(file.parent().unwrap_or(file))
        .and_then(|()| std::fs::write(file, unit))
        .map_err(|e| format!("could not write {}: {e}", file.display()))
}

/// `%` is systemd's specifier character, so a literal one is doubled.
fn unit_escape(text: &str) -> String {
    text.replace('%', "%%")
}

/// The `PATH` a unit runs with: `bin`'s own dir first, then every agent dir
/// whether or not it exists yet, so one installed after the server starts is
/// found without rewriting the unit, then the reader's own.
fn unit_env_path(bin: &Path) -> Result<String, String> {
    let dir = bin.parent().unwrap_or(bin).display().to_string();
    let home = std::env::home_dir().ok_or("could not resolve your home directory")?;
    let homes: Vec<String> = HOME_BIN_DIRS.iter().map(|d| home.join(d).display().to_string()).collect();
    Ok(format!("{dir}:{}:{}", homes.join(":"), std::env::var("PATH").unwrap_or_default()))
}

/// Installs `dray-tunnel.service` beside the server and waits for its address.
/// `PartOf` restarts and stops it with `dray.service`, and `WantedBy` starts it
/// whenever the server starts, boot included. Off until asked for: a public
/// address is the reader's call.
fn tunnel_on() -> Result<(), String> {
    cloudflared().ok_or(NO_CLOUDFLARED)?;
    service_start()?;
    let dray = std::env::current_exe().map_err(|e| format!("could not find the running dray binary: {e}"))?;
    let unit = format!(
        "[Unit]\nDescription=Dray tunnel\nAfter={UNIT}\nPartOf={UNIT}\n\n[Service]\nExecStart=\"{}\" tunnel\n\
         Environment=\"PATH={}\"\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy={UNIT}\n",
        unit_escape(&dray.display().to_string()),
        unit_escape(&unit_env_path(&dray)?),
    );
    write_unit(&unit_file(TUNNEL_UNIT)?, &unit)?;
    // A tunnel that died hard leaves its address behind, which the wait below
    // would hand out before the new one is up.
    if !systemctl(true, &["is-active", "--quiet", TUNNEL_UNIT]) {
        let _ = std::fs::remove_file(dray_home()?.join(dray_proto::TUNNEL_URL_FILE));
    }
    if !systemctl(true, &["daemon-reload"]) || !systemctl(true, &["enable", "--now", TUNNEL_UNIT]) {
        return Err(format!("systemd would not start the tunnel. See: systemctl --user status {TUNNEL_UNIT}"));
    }
    // Measured at ~6s from start to a registered address.
    for _ in 0..60 {
        if let Some(url) = tunnel_address()? {
            println!("{}", connect_text(&url)?);
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err("the tunnel has no address after 30s. See why: journalctl --user -u dray-tunnel -n 20".into())
}

/// Takes the tunnel unit away, if there is one. The tunnel removes its own
/// address file as it stops.
fn tunnel_off() -> Result<(), String> {
    let file = unit_file(TUNNEL_UNIT)?;
    // Separately, and judged by what is left running: `disable --now` can
    // refuse a unit whose file is already gone and still be running it. An
    // absent unit fails both and is not running, which is the answer wanted.
    let _ = systemctl(true, &["disable", TUNNEL_UNIT]);
    let _ = systemctl(true, &["stop", TUNNEL_UNIT]);
    if systemctl(true, &["is-active", "--quiet", TUNNEL_UNIT]) {
        return Err(format!("the tunnel is still running. See: systemctl --user status {TUNNEL_UNIT}"));
    }
    if file.exists() {
        std::fs::remove_file(&file).map_err(|e| format!("could not remove {}: {e}", file.display()))?;
    }
    let _ = systemctl(true, &["daemon-reload"]);
    Ok(())
}

const NO_CLOUDFLARED: &str = "cloudflared is not installed. dray setup offers it: dray setup --install cloudflared";

/// The Dray directory, `DRAY_HOME` where set, as the server reads it.
fn dray_home() -> Result<PathBuf, String> {
    std::env::var_os("DRAY_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|h| h.join(".dray")))
        .ok_or_else(|| "could not resolve your home directory".into())
}

/// cloudflared where `dray setup` or a package manager put it, or where an
/// earlier `dray share` downloaded it.
fn cloudflared() -> Option<PathBuf> {
    let downloaded = dray_home().ok()?.join("cloudflared").join(dray_proto::CLOUDFLARED_VERSION).join("cloudflared");
    find("cloudflared").or_else(|| downloaded.is_file().then_some(downloaded))
}

/// The address the running tunnel wrote, if one is up.
fn tunnel_address() -> Result<Option<String>, String> {
    let file = dray_home()?.join(dray_proto::TUNNEL_URL_FILE);
    Ok(std::fs::read_to_string(file).ok().map(|u| u.trim().to_string()).filter(|u| !u.is_empty()))
}

fn serve_token() -> Result<String, String> {
    std::fs::read_to_string(dray_home()?.join("serve-token"))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "the server has no token yet; start it first: dray service start".into())
}

/// What the reader reads off a terminal: the address, and the line Add server
/// takes whole. The token is in that line, so it is printed to a terminal
/// alone — under systemd stdout is the journal.
fn connect_text(url: &str) -> Result<String, String> {
    use std::io::IsTerminal;
    let wss = url.replacen("https://", "wss://", 1);
    if !std::io::stdout().is_terminal() {
        return Ok(format!("Tunnel up: {wss}"));
    }
    Ok(format!(
        "Tunnel up: {wss}\n\nIn the Dray app, Settings, Servers, Add server, Use an address and token, \
         and paste this into Address:\n\n   {wss} {}\n\n{DIM}Anyone holding that line can use this server. \
         The address changes when the tunnel restarts; the token does not.{RESET}",
        serve_token()?
    ))
}

/// `dray tunnel`: a Cloudflare quick tunnel in front of this machine's
/// server, in the foreground. Writes the address where the app's SSH connect
/// reads it, and removes it once the tunnel is down.
pub fn tunnel(args: Tunnel) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::sync::atomic::Ordering;

    serve_token()?;
    if std::net::TcpStream::connect(("127.0.0.1", args.port)).is_err() {
        return Err(format!("no Dray server on port {}. Start it first: dray service start", args.port));
    }
    let exe = cloudflared().ok_or(NO_CLOUDFLARED)?;
    let mut child = Command::new(exe)
        .args(["tunnel", "--no-autoupdate", "--grace-period", "1s"])
        .args(["--url", &format!("http://127.0.0.1:{}", args.port)])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run cloudflared: {e}"))?;
    hand_stop_signals_to(child.id());

    let mut lines = BufReader::new(child.stderr.take().expect("piped")).lines();
    let (mut url, mut registered, mut said) = (None, false, None);
    for line in lines.by_ref() {
        let Ok(line) = line else { break };
        url = url.or_else(|| dray_proto::quick_tunnel_url(&line));
        registered |= line.contains(dray_proto::TUNNEL_REGISTERED);
        if line.contains(" ERR ") {
            said = Some(line);
        } else if let (true, Some(url)) = (registered, &url) {
            wait_for_dns(url);
            if STOPPED.load(Ordering::Relaxed) {
                // Stopped while waiting: the address is already dead.
                let _ = child.wait();
                return Ok(());
            }
            let file = dray_home()?.join(dray_proto::TUNNEL_URL_FILE);
            let published = (|| {
                let part = file.with_extension("part");
                std::fs::write(&part, format!("{url}\n"))
                    .and_then(|()| std::fs::rename(&part, &file))
                    .map_err(|e| format!("could not write {}: {e}", file.display()))?;
                connect_text(url)
            })();
            match published {
                Ok(text) => println!("{text}"),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    remove_if_ours(&file, url);
                    return Err(e);
                }
            }
            // cloudflared logs for as long as it runs, and a pipe nobody
            // drains fills and stalls it.
            std::thread::spawn(move || lines.for_each(drop));
            let _ = child.wait();
            remove_if_ours(&file, url);
            return if STOPPED.load(Ordering::Relaxed) { Ok(()) } else { Err("the tunnel went down".into()) };
        }
    }
    let _ = child.wait();
    if STOPPED.load(Ordering::Relaxed) {
        return Ok(());
    }
    let said = said.map(|l| format!(": {}", l.trim())).unwrap_or_default();
    Err(format!("cloudflared exited without an address{said}"))
}

/// Removes the address file only while it holds `url`: another tunnel may own
/// it, and taking its address hides it from SSH and the Origin check.
fn remove_if_ours(file: &Path, url: &str) {
    if std::fs::read_to_string(file).is_ok_and(|u| u.trim() == url) {
        let _ = std::fs::remove_file(file);
    }
}

/// Until the tunnel's name resolves, so nobody's resolver asks early and
/// caches the miss: see `TUNNEL_REGISTERED`. Through curl, which every server
/// that ran the install line has; give up after 15s and hand it out anyway.
fn wait_for_dns(url: &str) {
    let query = format!("{}{}", dray_proto::DOH_QUERY, url.trim_start_matches("https://"));
    // A deadline, not a count: with 1.1.1.1 unreachable each ask takes its
    // whole timeout. And a stop ends the wait, the tunnel already going down.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline && !STOPPED.load(std::sync::atomic::Ordering::Relaxed) {
        let answer = Command::new("curl")
            .args(["-fsS", "--max-time", "3", "-H", "accept: application/dns-json", &query])
            .stderr(Stdio::null())
            .output();
        match answer {
            Ok(out) if String::from_utf8_lossy(&out.stdout).contains("\"Status\":0") => return,
            Err(_) => return std::thread::sleep(std::time::Duration::from_secs(5)),
            _ => std::thread::sleep(std::time::Duration::from_millis(500)),
        }
    }
}

static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static CHILD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Ctrl-C, `systemctl stop` or a plain `kill` reach cloudflared, which takes
/// the tunnel down, while this process lives on to remove the address file. A
/// handler rather than ignoring them, since an ignored signal stays ignored
/// across `exec` — cloudflared is spawned first for that reason too.
fn hand_stop_signals_to(pid: u32) {
    extern "C" {
        fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
        fn kill(pid: i32, sig: i32) -> i32;
    }
    extern "C" fn pass_on(sig: i32) {
        STOPPED.store(true, std::sync::atomic::Ordering::Relaxed);
        // Async-signal-safe: an atomic load and kill(2).
        unsafe { kill(CHILD.load(std::sync::atomic::Ordering::Relaxed), sig) };
    }
    CHILD.store(pid as i32, std::sync::atomic::Ordering::Relaxed);
    // SIGHUP, SIGINT, SIGTERM: the same numbers on Linux and macOS.
    for sig in [1, 2, 15] {
        unsafe { signal(sig, pass_on) };
    }
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
    let unit = format!(
        "[Unit]\nDescription=Dray server\n\n[Service]\nExecStart=\"{}\"\nEnvironment=\"PATH={}\"\n\
         Restart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
        unit_escape(&serve.display().to_string()),
        unit_escape(&unit_env_path(&serve)?),
    );
    write_unit(&unit_path()?, &unit)?;

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
        // Over SSH an arrow's three bytes can arrive in two reads. Read on only
        // while what came is still the start of one, so a lone Escape does
        // not swallow the next key.
        while matches!(&key[..n], [0x1b] | [0x1b, b'[']) {
            match input.read(&mut key[n..]).map_err(|e| e.to_string())? {
                0 => break,
                more => n += more,
            }
        }
        if key[..n].contains(&0x03) {
            break None;
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

    /// Runs the browser script against a fake apt that knows only the old
    /// spellings plus `libasound2t64`, and reads back what it installed.
    #[test]
    fn browser_script_picks_names_after_updating() {
        use std::os::unix::fs::PermissionsExt;
        let script = super::browser_script();
        assert!(!script.contains('\''), "as_admin wraps it in single quotes");
        let dir = std::env::temp_dir().join(format!("dray-apt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("log");
        let stub = |name: &str, body: &str| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // Lists are empty until `update` has run, the way a fresh image's are.
        stub("apt-get", &format!("[ \"$1\" = update ] && touch {0}/updated; echo \"$@\" >> {0}/log", dir.display()));
        stub(
            "apt-cache",
            &format!("[ -e {}/updated ] || exit 100; case $2 in libasound2t64) exit 0;; *t64) exit 100;; esac", dir.display()),
        );
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap());
        let ok = std::process::Command::new("sh").args(["-c", &script]).env("PATH", path).status().unwrap();
        let installed = std::fs::read_to_string(&log).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert!(ok.success(), "{installed}");
        let install = installed.lines().last().unwrap();
        assert!(install.starts_with("install -y fontconfig"), "{install}");
        assert!(install.contains(" libatk1.0-0 ") && install.contains(" libasound2t64"), "{install}");
    }

    #[test]
    fn the_ssh_line_names_the_address_and_port_the_reader_used() {
        let at = |conn| ssh_line_for("ana", conn);
        assert_eq!(at("203.0.113.9 51234 198.51.100.7 22").as_deref(), Some("ssh ana@198.51.100.7"));
        assert_eq!(at("203.0.113.9 51234 198.51.100.7 2222").as_deref(), Some("ssh -p 2222 ana@198.51.100.7"));
        assert_eq!(at("2001:db8::1 51234 2001:db8::7 22").as_deref(), Some("ssh ana@2001:db8::7"));
        assert_eq!(at(""), None);
    }
}
