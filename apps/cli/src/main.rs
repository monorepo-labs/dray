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
    encode_line, CreateSession, Envelope, IssueInput, LinkIssues, ListSessions, Request, Response,
    SendMessage,
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
    /// Tag a session with the issue its work is against.
    #[command(subcommand)]
    Issue(IssueCommand),
    /// Upgrade this binary to the newest release.
    Update(Update),
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

    /// Base the new session's worktree on existing work: a session id, a
    /// branch, or any git ref. Committed work only. Defaults to
    /// origin/<default>.
    #[arg(long, value_name = "SESSION|REF")]
    from: Option<String>,

    /// The issue this work is against, like DRA-53. Repeat for several.
    #[arg(long = "issue", value_name = "ISSUE")]
    issues: Vec<String>,
}

#[derive(Args)]
struct Update {
    /// Install the newest release even when it is the one already running.
    /// Reinstalls a damaged binary; `DRAY_VERSION=<tag>` downgrades.
    #[arg(long)]
    force: bool,
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
enum IssueCommand {
    /// Tag a session with one or more issues.
    Link(IssueLinkArgs),
    /// Remove issues from a session. The issues themselves are untouched.
    Unlink(IssueLinkArgs),
}

#[derive(Args)]
struct IssueLinkArgs {
    /// The session, as printed by `dray ls`.
    session_id: String,

    /// Issue identifiers, like DRA-53.
    #[arg(required = true, value_name = "ISSUE")]
    identifiers: Vec<String>,

    /// The issue's title, so the tag reads as more than an identifier.
    #[arg(long, value_name = "TITLE")]
    title: Option<String>,

    /// The issue's web address, so the tag becomes a link.
    #[arg(long, value_name = "URL")]
    url: Option<String>,
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
        Command::Issue(IssueCommand::Link(args)) => link_issues(args, false),
        Command::Issue(IssueCommand::Unlink(args)) => link_issues(args, true),
        Command::Update(args) => update(args),
        Command::Skill(SkillCommand::Install) => install_skill(),
    }
}

fn new(args: New) -> Result<(), String> {
    let request = Request::CreateSession(CreateSession {
        prompt: args.prompt,
        project_path: resolve_project(args.project),
        model: args.model,
        effort: args.effort,
        harness: args.harness,
        parent_session_id: parent_session_id(),
        from: args.from,
        issues: args.issues,
    });

    match send(request)? {
        Response::Created { session, base_ref } => {
            // The id alone on stdout, so `$(dray new …)` captures something
            // usable; everything a human wants goes to stderr beside it.
            println!("{}", session.session_id);
            eprintln!(
                "Started \"{}\"{}{}",
                session.title,
                match &session.worktree_name {
                    Some(name) => format!(" in worktree {name}"),
                    None => String::new(),
                },
                // `--from <session-id>` names a session, so the branch it
                // resolved to is news: the caller asked with an id and only the
                // app could say what that session's work is on.
                match &base_ref {
                    Some(base) => format!(", based on {base}"),
                    None => String::new(),
                }
            );
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(&other)),
    }
}

/// Tags or untags a session, printing what it carries afterwards.
///
/// The whole list rather than what changed, because that is what the app
/// answers with — and a caller that tagged three issues wants to see three,
/// not to reconcile a diff against what it believed.
fn link_issues(args: IssueLinkArgs, unlink: bool) -> Result<(), String> {
    // One title belongs to one issue. Refused rather than applied to all of
    // them or silently to the first: both are a wrong link that reads exactly
    // like a right one, which is the failure this whole protocol is arranged
    // to avoid.
    if args.identifiers.len() > 1 && (args.title.is_some() || args.url.is_some()) {
        return Err("--title and --url describe one issue, so name one".into());
    }

    let issues = args
        .identifiers
        .into_iter()
        .map(|identifier| IssueInput {
            identifier,
            title: args.title.clone(),
            url: args.url.clone(),
        })
        .collect();

    let request = Request::LinkIssues(LinkIssues {
        session_id: args.session_id,
        issues,
        unlink,
    });

    match send(request)? {
        Response::Linked { issues } => {
            if issues.is_empty() {
                eprintln!("No issues on this session.");
                return Ok(());
            }

            for issue in issues {
                println!("{}: {}", issue.identifier, issue.title);
            }
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
        Response::Linked { .. } => "an issue link",
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
    let branch_width = width(|s| s.branch.as_deref().unwrap_or("-"));

    for session in sessions {
        let title: String = session.title.chars().take(title_width).collect();
        // Named rather than given a column of its own: two bare ids on one row
        // under no header is a table nobody can read, and most rows have no
        // parent to print at all.
        let parent = match &session.parent_session_id {
            Some(id) => format!("  spawned by {id}"),
            None => String::new(),
        };
        println!(
            "{}  {:<status_width$}  {:<title_width$}  {:<branch_width$}{}",
            session.session_id,
            session.status,
            title,
            session.branch.as_deref().unwrap_or("-"),
            parent,
        );
    }
}

fn update(args: Update) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not find the running dray binary: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("the running dray binary sits in no directory")?;

    let scratch = scratch_dir()?;
    let script = scratch.join("install.sh");
    let result = download(INSTALLER_URL, &script)
        .and_then(|()| run_installer(&script, dir, (!args.force).then(current_tag)));

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

    std::fs::create_dir(&path).map_err(|e| format!("could not create {}: {e}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("could not restrict {}: {e}", path.display()))?;

    Ok(path)
}

/// The release tag this binary was built as.
///
/// The one fact the installer cannot work out for itself: it can see a `dray`
/// on disk but not which of them is the process that ran it, and asking the
/// wrong one its version is worse than not asking.
fn current_tag() -> String {
    format!("cli-v{}", env!("CARGO_PKG_VERSION"))
}

/// `current` is the tag to stop at — the installer resolves the newest release
/// and exits without downloading anything when the two match. `None` forces the
/// install through.
fn run_installer(script: &Path, install_dir: &Path, current: Option<String>) -> Result<(), String> {
    let mut command = std::process::Command::new("sh");
    command
        .arg(script)
        // So the upgrade lands where the install did instead of defaulting back
        // to ~/.local/bin. Overwriting this very binary is safe on unix: the
        // installer renames over the path and this process keeps the inode it
        // started from.
        .env("DRAY_INSTALL_DIR", install_dir);

    match current {
        // An installer too old to know this variable ignores it and installs
        // unconditionally, which is what this command did before — so the worst
        // a stale deploy costs is one wasted download, never a skipped upgrade.
        Some(tag) => command.env("DRAY_CURRENT_VERSION", tag),
        // Cleared rather than left alone: `--force` has to beat a value the
        // caller exported, or the flag silently does nothing.
        None => command.env_remove("DRAY_CURRENT_VERSION"),
    };

    let status = command.status();

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

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

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
    std::env::var("DRAY_SESSION_ID")
        .ok()
        .filter(|v| !v.is_empty())
}

/// `--project` if given, else the repo the current directory sits in.
///
/// `None` is a real answer, not a failure: the app falls back to the calling
/// session's own project, and only refuses when there is no parent either.
fn resolve_project(explicit: Option<PathBuf>) -> Option<String> {
    if let Some(path) = explicit {
        return Some(path.to_string_lossy().into_owned());
    }

    repo_root(Path::new("."))
}

/// The repo `dir` belongs to — its **main** worktree, not whichever linked one
/// we happen to be standing in.
///
/// `rev-parse --show-toplevel` answers the linked worktree, and that is what an
/// agent running in a Dray worktree session was putting on the wire as the new
/// session's project. The app then computed a `cwd` of
/// `<that worktree>/.claude/worktrees/<name>`, which `claude -w` never creates —
/// it resolves the repo for itself — so Changes, commit and PR all read a
/// directory that does not exist.
///
/// `worktree list` puts the main worktree first whatever you run it from, and
/// that is what `project_path` has always meant: the grouping key worktree
/// sessions list under.
fn repo_root(dir: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .current_dir(dir)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    main_worktree(&String::from_utf8(output.stdout).ok()?)
}

/// The first record's path, or `None` for a bare repo — nothing is checked out
/// there, so it is no place to run a session, and `None` sends the app to the
/// calling session's own project instead.
///
/// Not `-z`: that needs git 2.36, and anything older fails the command outright
/// and answers nothing. The line format is only ambiguous for a repo root with
/// a newline in its path.
fn main_worktree(porcelain: &str) -> Option<String> {
    let mut lines = porcelain.lines();
    let path = lines.next()?.strip_prefix("worktree ")?;

    // Records are separated by a blank line, so this reads the first one alone.
    if lines.take_while(|l| !l.is_empty()).any(|l| l == "bare") {
        return None;
    }

    (!path.is_empty()).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    /// The title belongs to one issue. Applying it to all of them, or silently
    /// to the first, is a wrong link that reads exactly like a right one.
    #[test]
    fn metadata_describes_one_issue() {
        let args = Cli::try_parse_from([
            "dray", "issue", "link", "s1", "DRA-53", "DRA-54", "--title", "One",
        ])
        .unwrap();

        let Command::Issue(IssueCommand::Link(args)) = args.command else {
            panic!("expected an issue link");
        };

        assert!(link_issues(args, false).is_err());
    }

    /// A bare identifier is still a usable link — the tag just reads `#DRA-53`
    /// with nothing after it. Refusing one would make the flags mandatory in
    /// everything but name.
    #[test]
    fn identifiers_alone_are_accepted() {
        assert!(Cli::try_parse_from(["dray", "issue", "link", "s1", "DRA-53", "DRA-54"]).is_ok());
    }

    #[test]
    fn there_is_no_way_to_opt_out_of_the_worktree() {
        // Sessions created here run at the same time by design, so sharing a
        // checkout is never the right answer — the flag is gone rather than
        // defaulted.
        assert!(Cli::try_parse_from(["dray", "new", "x", "--no-worktree"]).is_err());
    }

    #[test]
    fn the_worktree_cannot_be_named_either() {
        // An agent has no basis for picking a name, Dray generates a readable
        // one, and a caller-supplied name is one more thing that can collide.
        assert!(Cli::try_parse_from(["dray", "new", "x", "--worktree-name", "n"]).is_err());
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
    fn a_base_can_be_a_session_or_a_ref() {
        // One flag for both, because the app is the only side that can tell
        // them apart — it holds the index, and this does not.
        for value in ["0198f0a2-1c5e-7000-8000-000000000000", "feature/login"] {
            let cli = Cli::parse_from(["dray", "new", "review it", "--from", value]);
            let Command::New(args) = cli.command else {
                panic!("wrong subcommand");
            };
            assert_eq!(args.from.as_deref(), Some(value));
        }

        let cli = Cli::parse_from(["dray", "new", "x"]);
        let Command::New(args) = cli.command else {
            panic!("wrong subcommand");
        };
        assert_eq!(args.from, None);
    }

    /// The tree is still Dray's to make either way — `--from` moves where the
    /// branch starts, and there is no flag for running in somebody else's
    /// checkout.
    #[test]
    fn a_base_does_not_bring_back_a_way_into_someone_elses_tree() {
        assert!(Cli::try_parse_from(["dray", "new", "x", "--in", "abc"]).is_err());
        assert!(Cli::try_parse_from(["dray", "new", "x", "--detach"]).is_err());
    }

    #[test]
    fn an_explicit_project_beats_the_working_directory() {
        assert_eq!(
            resolve_project(Some(PathBuf::from("/x/proj"))).as_deref(),
            Some("/x/proj")
        );
    }

    #[test]
    fn update_checks_the_installed_version_unless_forced() {
        let Command::Update(args) = Cli::parse_from(["dray", "update"]).command else {
            panic!("wrong subcommand");
        };
        assert!(!args.force);

        let Command::Update(args) = Cli::parse_from(["dray", "update", "--force"]).command else {
            panic!("wrong subcommand");
        };
        assert!(args.force);
    }

    /// `--force` is the only argument. `--version` still means the top-level
    /// flag and nothing else, so a subcommand answering it would report the
    /// same number twice under two meanings.
    #[test]
    fn update_takes_no_other_arguments() {
        assert!(Cli::try_parse_from(["dray", "update", "--version"]).is_err());
        assert!(Cli::try_parse_from(["dray", "update", "cli-v0.1.0"]).is_err());
    }

    /// The comparison is a string one against a git tag, so the shape is the
    /// whole contract: `cli-v0.2.0` is what the release workflow pushes and
    /// what the installer resolves out of the releases API.
    #[test]
    fn the_current_tag_is_shaped_like_a_release_tag() {
        let tag = current_tag();
        assert_eq!(tag, format!("cli-v{}", env!("CARGO_PKG_VERSION")));
        assert!(tag.starts_with("cli-v"));
        assert!(tag[5..].starts_with(|c: char| c.is_ascii_digit()));
    }

    #[test]
    fn the_skill_documents_the_command_the_mismatch_error_names() {
        // The app tells a stale CLI to run this, so the skill has to say what
        // it is — that sentence is the whole self-heal path.
        assert!(SKILL.contains("dray update"));
    }

    /// A version bump refuses *every* command, and that is only tolerable
    /// because the refusal is actionable. Which half is behind decides which
    /// cure applies, and only one of the two can be run from here — so the
    /// skill has to teach both, or an agent meeting the app-is-behind half
    /// burns the turn running `dray update` at a problem it cannot touch.
    ///
    /// Anchored on the two cures `mismatch` emits verbatim rather than on the
    /// prose around them: those strings are the actual contract, and the prose
    /// wraps.
    #[test]
    fn the_skill_teaches_both_halves_of_a_protocol_refusal() {
        assert!(SKILL.contains("update the Dray app"));
        // And that a refusal is safe to retry, or it reads as a failed create
        // and earns a second session nobody asked for.
        assert!(SKILL.contains("Nothing was created"));
    }

    /// A worktree carries what was committed, so a reviewer pointed at work in
    /// progress reports on a tree missing the very change the user is looking
    /// at. Nothing in the mechanism can fix that, which makes saying it part of
    /// the feature rather than documentation around it.
    #[test]
    fn the_skill_says_a_base_carries_committed_work_only() {
        assert!(SKILL.contains("--from"));
        assert!(SKILL.contains("Committed work only"));
    }

    #[test]
    fn the_skill_carries_frontmatter_claude_code_can_read() {
        assert!(SKILL.starts_with("---\n"), "skill needs YAML frontmatter");
        assert!(SKILL.contains("\nname: dray\n"));
        assert!(SKILL.contains("\ndescription: "));
    }

    #[test]
    fn a_bare_repo_is_no_project() {
        assert_eq!(main_worktree("worktree /srv/repo.git\nbare\n"), None);
    }

    #[test]
    fn only_the_first_record_is_read() {
        // `bare` on a later record would be a repo that has no main worktree
        // at all, but reading past the blank line is how a second record's
        // attribute gets mistaken for the first one's.
        let porcelain = "worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nbare\n";
        assert_eq!(main_worktree(porcelain).as_deref(), Some("/a"));
    }

    #[test]
    fn nothing_at_all_is_no_project() {
        assert_eq!(main_worktree(""), None);
        assert_eq!(main_worktree("HEAD abc\n"), None);
    }

    /// The one that matters, and it needs a real linked worktree: the whole
    /// defect was a git subcommand answering differently depending on which
    /// directory it ran in, which no string fixture can show.
    #[test]
    fn resolving_from_inside_a_worktree_answers_the_repo() {
        let Some(repo) = scratch_repo() else {
            return;
        };

        let tree = repo.join(".claude").join("worktrees").join("child");
        git(&repo, &["worktree", "add", "-q", tree.to_str().unwrap()]);

        let root = repo.to_string_lossy().into_owned();
        assert_eq!(repo_root(&repo).as_deref(), Some(root.as_str()));
        assert_eq!(repo_root(&tree).as_deref(), Some(root.as_str()));

        // The reading this replaced, kept as the reason the test exists.
        assert_eq!(
            show_toplevel(&tree).as_deref(),
            Some(tree.to_string_lossy().as_ref())
        );

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_plain_directory_is_no_project() {
        let dir = std::env::temp_dir().join(format!("dray-clitest-plain-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(repo_root(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A throwaway repo with one commit, canonicalized because git prints real
    /// paths and macOS hands out `/var/…` symlinks into `/private/var/…`.
    /// `None` when there is no usable git, which is not a failure worth failing
    /// the suite over.
    fn scratch_repo() -> Option<PathBuf> {
        let dir = std::env::temp_dir().join(format!("dray-clitest-{}", std::process::id()));
        // A run that failed before its cleanup would otherwise leave a repo
        // here whose `child` worktree already exists.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        let dir = std::fs::canonicalize(&dir).ok()?;

        if !git(&dir, &["init", "-q", "."]) {
            return None;
        }
        git(&dir, &["config", "user.email", "t@example.com"]);
        git(&dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("keep.txt"), "a\n").ok()?;
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "init"]);

        Some(dir)
    }

    fn git(at: &Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .current_dir(at)
            .args(args)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn show_toplevel(at: &Path) -> Option<String> {
        let out = std::process::Command::new("git")
            .current_dir(at)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .ok()?;

        Some(String::from_utf8(out.stdout).ok()?.trim().to_string())
    }
}
