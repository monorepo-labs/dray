//! `dray` — create and list Dray sessions from outside the app.
//!
//! Deliberately standalone. It links neither the app nor tokio: one connect,
//! one write, one read, exit. That keeps startup instant, which matters because
//! the usual caller is an agent shelling out to it — and it is what lets this
//! ship for linux, where there is no Dray app to be part of.
//!
//! Everything about *where* to connect lives in [`dray_proto::endpoint`], so
//! moving the app to a server changes one function and nothing here.

use clap::{Args, Parser, Subcommand};
use dray_proto::{
    encode_line, CreateSession, Envelope, ListSessions, Request, Response, SendMessage,
    SessionSummary,
};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The skill, embedded rather than downloaded at install time — a skill that
/// describes a different version of the CLI than the one installed is worse
/// than no skill, and fetching it separately is exactly how that happens.
const SKILL: &str = include_str!("../skill/SKILL.md");

/// `update` runs the same script a first install runs rather than doing its own
/// fetch, verify and swap: two copies of that drift on exactly the step that
/// checks what is about to be executed.
const INSTALLER_URL: &str = "https://www.drayhq.com/install.sh";

#[derive(Parser)]
#[command(
    name = "dray",
    version,
    about = "Create and list Dray sessions.",
    long_about = "Create and list Dray sessions.\n\nDray runs coding agents in parallel, one \
                  session per piece of work. This creates those sessions from the command line, \
                  so an agent in one session can fan work out into several.\n\nRequires the Dray \
                  app to be running."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start a new session working on a prompt.
    New(New),
    /// List sessions.
    Ls(Ls),
    /// Send a message into a session that already exists.
    Send(Send),
    /// Upgrade this binary to the newest release.
    Update,
    /// Manage the Claude Code skill that documents this CLI.
    #[command(subcommand)]
    Skill(SkillCommand),
}

#[derive(Args)]
struct New {
    /// What the session should work on. Write it for someone who has not read
    /// your conversation — the new session inherits no context.
    prompt: String,

    /// Repo to run in. Defaults to the calling session's project, or the git
    /// repo of the current directory.
    #[arg(long)]
    project: Option<PathBuf>,

    /// Name the worktree instead of letting Dray generate one. Every session
    /// gets one — they are meant to run at the same time.
    #[arg(long)]
    worktree_name: Option<String>,

    /// opus, sonnet, fable or haiku. Defaults to the calling session's model.
    #[arg(long)]
    model: Option<String>,

    /// low, medium, high, xhigh or max. Defaults to the calling session's
    /// effort, then the model's own.
    #[arg(long)]
    effort: Option<String>,

    /// Which agent runs it. claude_code today.
    #[arg(long)]
    harness: Option<String>,
}

#[derive(Args)]
struct Send {
    /// The session to send to, as printed by `dray ls`.
    session_id: String,

    /// The message. Write it for someone who cannot see your conversation.
    prompt: String,
}

#[derive(Args)]
struct Ls {
    /// Every project, not just this one.
    #[arg(long)]
    all: bool,

    /// One JSON array, for reading with a program.
    #[arg(long)]
    json: bool,

    /// Repo to list. Defaults to the calling session's project, or the git repo
    /// of the current directory.
    #[arg(long)]
    project: Option<PathBuf>,
}

#[derive(Subcommand)]
enum SkillCommand {
    /// Write the skill to ~/.claude/skills/dray/, where Claude Code finds it.
    Install,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("dray: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    match Cli::parse().command {
        Command::New(args) => new(args),
        Command::Ls(args) => ls(args),
        Command::Send(args) => send_message(args),
        Command::Update => update(),
        Command::Skill(SkillCommand::Install) => install_skill(),
    }
}

fn new(args: New) -> Result<(), String> {
    let request = Request::CreateSession(CreateSession {
        prompt: args.prompt,
        project_path: resolve_project(args.project),
        worktree_name: args.worktree_name,
        model: args.model,
        effort: args.effort,
        harness: args.harness,
        parent_session_id: parent_session_id(),
    });

    match send(request)? {
        Response::Created { session } => {
            // The id alone on stdout, so `$(dray new …)` captures something
            // usable; everything a human wants goes to stderr beside it.
            println!("{}", session.session_id);
            eprintln!(
                "Started \"{}\"{}",
                session.title,
                match &session.worktree_name {
                    Some(name) => format!(" in worktree {name}"),
                    None => String::new(),
                }
            );
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(&other)),
    }
}

fn send_message(args: Send) -> Result<(), String> {
    let request = Request::SendMessage(SendMessage {
        session_id: args.session_id,
        prompt: args.prompt,
        from_session_id: parent_session_id(),
    });

    match send(request)? {
        // Queued is not a failure and must not read as one: the target had a
        // turn in flight, so the prompt waits for a boundary rather than
        // interrupting it.
        Response::Sent { queued } => {
            eprintln!(
                "{}",
                if queued {
                    "Queued — the session is mid-turn and will pick it up."
                } else {
                    "Delivered."
                }
            );
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(&other)),
    }
}

/// The app answered something this command never asks for, which means the two
/// sides disagree about the protocol rather than that anything went wrong with
/// the request.
fn unexpected(response: &Response) -> String {
    let kind = match response {
        Response::Created { .. } => "a create",
        Response::Listed { .. } => "a list",
        Response::Sent { .. } => "a send",
        Response::Error { .. } => "an error",
    };
    format!("the app answered {kind} to a different command — versions may disagree")
}

fn ls(args: Ls) -> Result<(), String> {
    let request = Request::ListSessions(ListSessions {
        all: args.all,
        project_path: resolve_project(args.project),
        parent_session_id: parent_session_id(),
    });

    match send(request)? {
        Response::Listed { sessions } => {
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?
                );
            } else {
                print_table(&sessions);
            }
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(&other)),
    }
}

/// Columns padded to the widest cell, so ids and titles line up without pulling
/// in a table crate for the one place this is needed.
fn print_table(sessions: &[SessionSummary]) {
    if sessions.is_empty() {
        eprintln!("No sessions.");
        return;
    }

    let width = |pick: fn(&SessionSummary) -> &str| {
        sessions.iter().map(|s| pick(s).len()).max().unwrap_or(0)
    };

    let status_width = width(|s| s.status.as_str());
    let title_width = width(|s| s.title.as_str()).min(60);

    for session in sessions {
        let title: String = session.title.chars().take(title_width).collect();
        println!(
            "{}  {:<status_width$}  {:<title_width$}  {}",
            session.session_id,
            session.status,
            title,
            session.branch.as_deref().unwrap_or("-"),
        );
    }
}

fn update() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not find the running dray binary: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("the running dray binary sits in no directory")?;

    let scratch = scratch_dir()?;
    let script = scratch.join("install.sh");
    let result = download(INSTALLER_URL, &script).and_then(|()| run_installer(&script, dir));

    // On the failing paths too, or a refused download leaves a half-written
    // script behind every time someone retries.
    let _ = std::fs::remove_dir_all(&scratch);

    result
}

/// A directory of our own to download the installer into, because the next step
/// executes what lands there.
///
/// `create_dir` refuses a path that already exists — symlink included — so
/// another local account cannot park something at the predictable name and have
/// it run. `0700` closes the window between creating it and writing into it.
fn scratch_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let path = std::env::temp_dir().join(format!("dray-update-{}", std::process::id()));

    std::fs::create_dir(&path)
        .map_err(|e| format!("could not create {}: {e}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("could not restrict {}: {e}", path.display()))?;

    Ok(path)
}

fn run_installer(script: &Path, install_dir: &Path) -> Result<(), String> {
    let status = std::process::Command::new("sh")
        .arg(script)
        // So the upgrade lands where the install did instead of defaulting back
        // to ~/.local/bin. Overwriting this very binary is safe on unix: the
        // installer renames over the path and this process keeps the inode it
        // started from.
        .env("DRAY_INSTALL_DIR", install_dir)
        .status();

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("the installer failed ({status})")),
        Err(e) => Err(format!("could not run the installer: {e}")),
    }
}

/// curl or wget, the same pair `install.sh` accepts.
///
/// To a file rather than `curl … | sh`, because `pipefail` is not POSIX: piped
/// straight into a shell, a failed download reports success and installs
/// nothing.
fn download(url: &str, path: &Path) -> Result<(), String> {
    for (program, args) in [
        (
            "curl",
            vec![
                OsStr::new("-fsSL"),
                OsStr::new(url),
                OsStr::new("-o"),
                path.as_os_str(),
            ],
        ),
        (
            "wget",
            vec![OsStr::new("-qO"), path.as_os_str(), OsStr::new(url)],
        ),
    ] {
        match std::process::Command::new(program).args(args).status() {
            Ok(status) if status.success() => return Ok(()),
            // It ran and failed, which is a real failure rather than a reason
            // to reach for the other one.
            Ok(_) => return Err(format!("{program} could not download {url}")),
            Err(_) => continue,
        }
    }

    Err("curl or wget is required to update.".into())
}

fn install_skill() -> Result<(), String> {
    let dir = dirs::home_dir()
        .ok_or("could not resolve your home directory")?
        .join(".claude")
        .join("skills")
        .join("dray");

    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let path = dir.join("SKILL.md");
    std::fs::write(&path, SKILL).map_err(|e| format!("could not write {}: {e}", path.display()))?;

    eprintln!("Installed the dray skill to {}", path.display());
    Ok(())
}

/// One request, one response, connection closed.
fn send(request: Request) -> Result<Response, String> {
    let endpoint = dray_proto::endpoint().ok_or("could not work out where Dray is listening")?;

    // A missing or unaccepting socket is the ordinary case — the app is closed —
    // and must read as a fact rather than as a crash.
    let mut stream = UnixStream::connect(&endpoint)
        .map_err(|_| "Dray isn't running. Start the app and try again.".to_string())?;

    let line = encode_line(&Envelope::new(request)).map_err(|e| e.to_string())?;
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("could not send the request: {e}"))?;
    // Without this the app blocks reading a line that never terminates, because
    // this end is still notionally able to write more of it.
    stream
        .flush()
        .map_err(|e| format!("could not send the request: {e}"))?;

    let mut response = String::new();
    BufReader::new(&stream)
        .read_line(&mut response)
        .map_err(|e| format!("could not read the response: {e}"))?;

    if response.trim().is_empty() {
        return Err("Dray closed the connection without answering.".into());
    }

    serde_json::from_str(&response).map_err(|e| format!("could not parse the response: {e}"))
}

/// Which session is making this call, if one is. Injected into every agent Dray
/// spawns; absent when a person runs this in their own terminal, which is
/// ordinary rather than an error.
fn parent_session_id() -> Option<String> {
    std::env::var("DRAY_SESSION_ID").ok().filter(|v| !v.is_empty())
}

/// `--project` if given, else the repo the current directory sits in.
///
/// `None` is a real answer, not a failure: the app falls back to the calling
/// session's own project, and only refuses when there is no parent either.
fn resolve_project(explicit: Option<PathBuf>) -> Option<String> {
    if let Some(path) = explicit {
        return Some(path.to_string_lossy().into_owned());
    }

    git_toplevel()
}

fn git_toplevel() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn there_is_no_way_to_opt_out_of_the_worktree() {
        // Sessions created here run at the same time by design, so sharing a
        // checkout is never the right answer — the flag is gone rather than
        // defaulted.
        assert!(Cli::try_parse_from(["dray", "new", "x", "--no-worktree"]).is_err());
    }

    #[test]
    fn send_takes_a_target_and_a_message() {
        let cli = Cli::parse_from(["dray", "send", "abc-123", "review is done"]);
        let Command::Send(args) = cli.command else {
            panic!("wrong subcommand");
        };
        assert_eq!(args.session_id, "abc-123");
        assert_eq!(args.prompt, "review is done");
    }

    #[test]
    fn the_prompt_is_positional_and_survives_spaces() {
        let cli = Cli::parse_from(["dray", "new", "fix the login redirect loop"]);
        let Command::New(args) = cli.command else {
            panic!("wrong subcommand");
        };
        assert_eq!(args.prompt, "fix the login redirect loop");
    }

    #[test]
    fn an_explicit_project_beats_the_working_directory() {
        assert_eq!(
            resolve_project(Some(PathBuf::from("/x/proj"))).as_deref(),
            Some("/x/proj")
        );
    }

    #[test]
    fn update_takes_no_arguments() {
        assert!(matches!(
            Cli::parse_from(["dray", "update"]).command,
            Command::Update
        ));
        assert!(Cli::try_parse_from(["dray", "update", "--version"]).is_err());
    }

    #[test]
    fn the_skill_documents_the_command_the_mismatch_error_names() {
        // The app tells a stale CLI to run this, so the skill has to say what
        // it is — that sentence is the whole self-heal path.
        assert!(SKILL.contains("dray update"));
    }

    #[test]
    fn the_skill_carries_frontmatter_claude_code_can_read() {
        assert!(SKILL.starts_with("---\n"), "skill needs YAML frontmatter");
        assert!(SKILL.contains("\nname: dray\n"));
        assert!(SKILL.contains("\ndescription: "));
    }
}
