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
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::ExitCode;

/// The skill, embedded rather than downloaded at install time — a skill that
/// describes a different version of the CLI than the one installed is worse
/// than no skill, and fetching it separately is exactly how that happens.
const SKILL: &str = include_str!("../skill/SKILL.md");

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
    fn the_skill_carries_frontmatter_claude_code_can_read() {
        assert!(SKILL.starts_with("---\n"), "skill needs YAML frontmatter");
        assert!(SKILL.contains("\nname: dray\n"));
        assert!(SKILL.contains("\ndescription: "));
    }
}
