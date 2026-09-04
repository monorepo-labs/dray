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
    encode_line, BrowserAction, BrowserRequest, CreateSession, Envelope, Get, Is, IssueInput,
    LinkIssues, ListSessions, Locator, Request, Response, SendMessage, SessionSummary,
};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// The skill, embedded rather than downloaded at install time — a skill that
/// describes a different version of the CLI than the one installed is worse
/// than no skill, and fetching it separately is exactly how that happens.
const SKILL: &str = include_str!("../skill/SKILL.md");

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
    /// Drive this session's browser: open pages, read them, click and type.
    Browser(BrowserCommand),
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

    /// low, medium, high, xhigh, max or ultra. Defaults to the calling session's
    /// effort, then the model's own.
    #[arg(long)]
    effort: Option<String>,

    /// Which agent runs it: claude_code or codex.
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
    /// Issue identifiers, like DRA-53, optionally preceded by the session they
    /// belong to as printed by `dray ls`. Inside a Dray session the session is
    /// read from the environment, so the identifiers alone are enough.
    #[arg(required = true, value_name = "SESSION | ISSUE")]
    session_and_issues: Vec<String>,

    /// The issue's title, so the tag reads as more than an identifier.
    #[arg(long, value_name = "TITLE")]
    title: Option<String>,

    /// The issue's web address, so the tag becomes a link.
    #[arg(long, value_name = "URL")]
    url: Option<String>,
}

/// Every verb lands on the session's active tab; `open` makes one if none.
/// A TARGET is `@e12` from the last `snapshot`, or a CSS selector.
const BROWSER_VERBS: &str = "\
Verbs:
  open <url> | back | forward | reload | close
  tab [new [url] | <id> | close [id]]
  snapshot [-i] [-c] [-s <selector>]
  click|dblclick|focus|hover|check|uncheck|scrollintoview <target>
  type|fill <target> <text> | select <target> <value> | press <key>
  scroll <up|down|left|right> [pixels]
  get <text|html|value|title|url|count|box> [target] | get attr <target> <name>
  is <visible|enabled|checked> <target>
  find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> <verb> [arg]
  wait [<selector> | <ms>] [--url ..] [--text ..] [--load ..]
  screenshot [path] [--full] | eval <js> | console | errors
  set viewport <w> <h> | set device <name>";

#[derive(Args)]
#[command(after_help = BROWSER_VERBS)]
struct BrowserCommand {
    /// A verb and its words; the list is below.
    #[arg(required = true, allow_negative_numbers = true, value_name = "VERB")]
    words: Vec<String>,

    /// The session whose browser to drive. Defaults to the session running
    /// this command.
    #[arg(long)]
    session: Option<String>,

    /// Answer as JSON rather than text.
    #[arg(long)]
    json: bool,

    /// snapshot: interactive elements only.
    #[arg(short, long)]
    interactive: bool,

    /// snapshot: interactive elements and headings only.
    #[arg(short, long)]
    compact: bool,

    /// snapshot: only inside this selector.
    #[arg(short, long)]
    selector: Option<String>,

    /// find role: the accessible name.
    #[arg(long)]
    name: Option<String>,

    /// find: match the whole string, not a part of it.
    #[arg(long)]
    exact: bool,

    /// wait: for the URL to contain this.
    #[arg(long)]
    url: Option<String>,

    /// wait: for this text to be on the page.
    #[arg(long)]
    text: Option<String>,

    /// wait: for the page to finish loading.
    #[arg(long)]
    load: Option<String>,

    /// screenshot: the whole document rather than the viewport.
    #[arg(long)]
    full: bool,
}

#[derive(Subcommand)]
enum SkillCommand {
    /// Write the skill to ~/.claude/skills/dray/ and ~/.codex/skills/dray/,
    /// where Claude Code and Codex find it.
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
        Command::Browser(args) => browser(args),
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
        other => Err(unexpected(other)),
    }
}

/// Tags or untags a session, printing what it carries afterwards.
///
/// The whole list rather than what changed, because that is what the app
/// answers with — and a caller that tagged three issues wants to see three,
/// not to reconcile a diff against what it believed.
fn link_issues(args: IssueLinkArgs, unlink: bool) -> Result<(), String> {
    let (session_id, identifiers) =
        split_session_and_issues(args.session_and_issues, parent_session_id())?;

    // One title belongs to one issue. Refused rather than applied to all of
    // them or silently to the first: both are a wrong link that reads exactly
    // like a right one, which is the failure this whole protocol is arranged
    // to avoid.
    if identifiers.len() > 1 && (args.title.is_some() || args.url.is_some()) {
        return Err("--title and --url describe one issue, so name one".into());
    }

    let issues = identifiers
        .into_iter()
        .map(|identifier| IssueInput {
            identifier,
            title: args.title.clone(),
            url: args.url.clone(),
        })
        .collect();

    let request = Request::LinkIssues(LinkIssues {
        session_id,
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
                println!("{}: {}  {}", issue.identifier, issue.title, issue.url);
            }
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(other)),
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
        other => Err(unexpected(other)),
    }
}

fn browser(args: BrowserCommand) -> Result<(), String> {
    let session_id = args.session.clone().or_else(parent_session_id).ok_or(
        "which session's browser? Pass --session <id>, or run this from inside a Dray session.",
    )?;
    let action = browser_action(&args)?;
    match send(Request::Browser(BrowserRequest { session_id, action }))? {
        Response::Browser { output, data } => {
            if args.json {
                println!("{}", serde_json::to_string_pretty(&data).unwrap_or_default());
            } else {
                println!("{output}");
            }
            Ok(())
        }
        Response::Error { message } => Err(message),
        other => Err(unexpected(other)),
    }
}

fn target(t: String) -> Locator {
    Locator::Target { target: t }
}

/// `find <by> <value>` builds a locator and hands what follows to [`act`];
/// every other line is a verb `act` reads whole, target included.
fn browser_action(f: &BrowserCommand) -> Result<BrowserAction, String> {
    let mut words = f.words.iter().cloned();
    let verb = words.next().ok_or(BROWSER_VERBS)?;

    // Flat on the command so clap accepts them anywhere, so the verb has to
    // refuse the ones that are not its own: `click @e1 --full` did nothing
    // with `--full` and said nothing about it.
    let given = [
        (f.interactive, "-i"),
        (f.compact, "-c"),
        (f.selector.is_some(), "-s"),
        (f.name.is_some(), "--name"),
        (f.exact, "--exact"),
        (f.url.is_some(), "--url"),
        (f.text.is_some(), "--text"),
        (f.load.is_some(), "--load"),
        (f.full, "--full"),
    ];
    let allowed: &[&str] = match verb.as_str() {
        "snapshot" => &["-i", "-c", "-s"],
        "find" => &["--name", "--exact"],
        "wait" => &["--url", "--text", "--load"],
        "screenshot" => &["--full"],
        _ => &[],
    };
    if let Some((_, flag)) = given.iter().find(|(set, flag)| *set && !allowed.contains(flag)) {
        return Err(format!("browser {verb} takes no {flag}"));
    }

    if verb != "find" {
        return act(&verb, None, words, f);
    }

    let usage = "find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> <verb> [arg]";
    let by = words.next().ok_or(usage)?;
    let value = words.next().ok_or(usage)?;
    let (name, exact) = (f.name.clone(), f.exact);
    let at = match by.as_str() {
        "role" => Locator::Role { role: value, name, exact },
        "text" => Locator::Text { text: value, exact },
        "label" => Locator::Label { label: value, exact },
        "placeholder" => Locator::Placeholder { placeholder: value, exact },
        "alt" => Locator::Alt { alt: value, exact },
        "title" => Locator::Title { title: value, exact },
        "testid" => Locator::TestId { id: value },
        "first" => Locator::Nth { selector: value, index: 0 },
        "last" => Locator::Nth { selector: value, index: -1 },
        "nth" => {
            let index = value.parse().map_err(|_| "find nth <index> <selector> <verb>")?;
            Locator::Nth { selector: words.next().ok_or(usage)?, index }
        }
        other => return Err(format!("find {other}? {usage}")),
    };
    let verb = words.next().ok_or(usage)?;
    act(&verb, Some(at), words, f)
}

/// One verb, typed bare (`click @e1`) or after `find`'s locator (`find text
/// Submit click`). `found` is that locator; without one, a verb acting on an
/// element reads its target as the next word.
fn act(
    verb: &str,
    found: Option<Locator>,
    mut words: impl Iterator<Item = String>,
    f: &BrowserCommand,
) -> Result<BrowserAction, String> {
    use BrowserAction as A;
    let mut word = |usage: &str| words.next().ok_or_else(|| usage.to_string());
    let action = match verb {
        "open" => A::Open { url: word("open <url>")? },
        "back" => A::Back,
        "forward" => A::Forward,
        "reload" => A::Reload,
        "close" => A::Close,
        "tab" => match word("").ok().as_deref() {
            None => A::Tabs,
            Some("new") => A::TabNew { url: word("").ok() },
            Some("close") => A::TabClose { id: word("").ok().map(|s| parse_id(&s)).transpose()? },
            Some(id) => A::TabSwitch { id: parse_id(id)? },
        },
        "snapshot" => A::Snapshot {
            interactive: f.interactive,
            compact: f.compact,
            selector: f.selector.clone(),
        },
        "press" => A::Press { key: word("press <key>")? },
        "scroll" => A::Scroll {
            direction: word("scroll <up|down|left|right> [pixels]")?,
            amount: match word("").ok() {
                None => 500.0,
                Some(px) => px.parse().map_err(|_| "scroll <direction> [pixels]")?,
            },
        },
        "click" | "dblclick" | "focus" | "hover" | "check" | "uncheck" | "scrollintoview"
        | "type" | "fill" | "select" | "text" | "count" | "visible" => {
            let at = match found {
                Some(at) => at,
                None => target(word(&format!("{verb} <target>"))?),
            };
            match verb {
                "click" => A::Click { at },
                "dblclick" => A::DblClick { at },
                "focus" => A::Focus { at },
                "hover" => A::Hover { at },
                "check" => A::Check { at },
                "uncheck" => A::Uncheck { at },
                "scrollintoview" => A::ScrollIntoView { at },
                "type" => A::Type { at, text: word("type <target> <text>")? },
                "fill" => A::Fill { at, text: word("fill <target> <text>")? },
                "select" => A::Select { at, value: word("select <target> <value>")? },
                "text" => A::Get { what: Get::Text, at: Some(at) },
                "count" => A::Get { what: Get::Count, at: Some(at) },
                _ => A::Is { what: Is::Visible, at },
            }
        }
        "get" => {
            let usage = "get <text|html|value|attr|title|url|count|box> [target]";
            match word(usage)?.as_str() {
                "attr" => {
                    let at = match found {
                        Some(at) => at,
                        None => target(word("get attr <target> <name>")?),
                    };
                    let name = word("get attr <target> <name>")?;
                    A::Get { what: Get::Attr { name }, at: Some(at) }
                }
                other => {
                    let what = match other {
                        "text" => Get::Text,
                        "html" => Get::Html,
                        "value" => Get::Value,
                        "title" => Get::Title,
                        "url" => Get::Url,
                        "count" => Get::Count,
                        "box" => Get::Box,
                        _ => return Err(format!("get {other}? {usage}")),
                    };
                    A::Get { what, at: found.or_else(|| word("").ok().map(target)) }
                }
            }
        }
        "is" => {
            let what = match word("is <visible|enabled|checked> <target>")?.as_str() {
                "visible" => Is::Visible,
                "enabled" => Is::Enabled,
                "checked" => Is::Checked,
                other => return Err(format!("is {other}? visible, enabled or checked")),
            };
            let at = match found {
                Some(at) => at,
                None => target(word("is <what> <target>")?),
            };
            A::Is { what, at }
        }
        "wait" => {
            let t = word("").ok();
            let ms = t.as_deref().and_then(|s| s.parse::<u64>().ok());
            A::Wait {
                selector: if ms.is_some() { None } else { t },
                ms,
                url: f.url.clone(),
                text: f.text.clone(),
                load: f.load.clone(),
            }
        }
        "screenshot" => A::Screenshot { path: word("").ok(), full: f.full },
        "eval" => A::Eval { js: word("eval <js>")? },
        "console" => A::Console,
        "errors" => A::Errors,
        "set" => match word("set viewport <w> <h>, or set device <name>")?.as_str() {
            "viewport" => {
                let mut dim = || -> Result<u32, String> {
                    word("")?.parse().map_err(|_| "set viewport <width> <height>".to_string())
                };
                A::SetViewport { width: dim()?, height: dim()? }
            }
            "device" => A::SetDevice { name: word("set device <name>")? },
            _ => return Err("set viewport <w> <h>, or set device <name>".into()),
        },
        other => return Err(format!("browser {other}? {BROWSER_VERBS}")),
    };
    // `click @e1 garbage` used to be refused by clap; a word nothing read is
    // a command the caller meant differently.
    if let Some(extra) = words.next() {
        return Err(format!("browser {verb}: unexpected `{extra}`"));
    }
    Ok(action)
}

fn parse_id(s: &str) -> Result<i32, String> {
    s.parse().map_err(|_| format!("{s} is not a tab id; `dray browser tab` lists them"))
}

/// The app answered something this command never asks for: the two sides
/// disagree about the protocol rather than about the request.
fn unexpected(response: Response) -> String {
    let kind = serde_json::to_value(&response).map(|v| v["status"].to_string());
    format!(
        "the app answered {} to a different command — versions may disagree",
        kind.unwrap_or_default()
    )
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
        other => Err(unexpected(other)),
    }
}

fn print_table(sessions: &[SessionSummary]) {
    if sessions.is_empty() {
        eprintln!("No sessions.");
        return;
    }

    for s in sessions {
        // Named rather than given a column: two bare ids on one row under no
        // header is a table nobody can read, and most rows have no parent.
        let parent = s
            .parent_session_id
            .as_deref()
            .map(|id| format!("  spawned by {id}"))
            .unwrap_or_default();
        println!(
            "{}  {:<12} {:<40.40}  {:<24}{parent}",
            s.session_id,
            s.status,
            s.title,
            s.branch.as_deref().unwrap_or("-"),
        );
    }
}

/// Runs the installer a first install runs, with the env it documents.
///
/// To a file first, not `curl | sh`: `pipefail` is not POSIX, so piped straight
/// into a shell a failed download runs an empty script and reports success.
/// curl or wget, the pair the installer itself accepts.
fn update(args: Update) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("could not find the running dray binary: {e}"))?;
    let dir = exe
        .parent()
        .ok_or("the running dray binary sits in no directory")?;

    let mut sh = std::process::Command::new("sh");
    sh.args([
        "-c",
        "t=$(mktemp) && trap 'rm -f \"$t\"' EXIT && \
         if command -v curl >/dev/null; then curl -fsSL \"$0\" -o \"$t\"; else wget -qO \"$t\" \"$0\"; fi && \
         sh \"$t\"",
        INSTALLER_URL,
    ])
    // Where this binary lives, not ~/.local/bin. Renaming over a running
    // unix binary is safe: the process keeps the inode it started from.
    .env("DRAY_INSTALL_DIR", dir);

    if args.force {
        // Cleared rather than left alone, or a value the caller exported makes
        // the flag do nothing.
        sh.env_remove("DRAY_CURRENT_VERSION");
    } else {
        sh.env("DRAY_CURRENT_VERSION", current_tag());
    }

    match sh.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("the installer failed ({status})")),
        Err(e) => Err(format!("could not run the installer: {e}")),
    }
}

/// The release tag this binary was built as — the one fact the installer cannot
/// work out for itself, since it cannot tell which `dray` on disk ran it.
fn current_tag() -> String {
    format!("cli-v{}", env!("CARGO_PKG_VERSION"))
}

/// Every agent reads the same SKILL.md format from its own home dir, so one
/// file lands in three places. Every install writes all of them: which agent
/// the user runs is not something the CLI can know, and a session with no
/// skill is told by its prompt to read one.
///
/// pi's is `.agents`, not `.pi` — its trust manager treats `~/.agents/skills`
/// as the user-global directory, where a project-local one needs trusting
/// first. Read out of the shipped binary rather than guessed: a skill written
/// to a directory pi does not read is a feature that fails in total silence.
const SKILL_HOMES: [&str; 3] = [".claude", ".codex", ".agents"];

fn install_skill() -> Result<(), String> {
    let home = std::env::home_dir().ok_or("could not resolve your home directory")?;

    for agent_home in SKILL_HOMES {
        let dir = home.join(agent_home).join("skills").join("dray");

        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

        let path = dir.join("SKILL.md");
        std::fs::write(&path, SKILL)
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;

        eprintln!("Installed the dray skill to {}", path.display());
    }

    Ok(())
}

/// Why the connect failed, in terms the caller can act on.
///
/// Three answers, because the caller does three different things with them.
///
/// `NotFound` and `ConnectionRefused` are the two shapes a closed app leaves —
/// no socket file, and a file with nobody behind it — and they are the only
/// kinds that say anything about whether it is running. Naming them explicitly
/// rather than using them as the fallback matters: `EAGAIN` from a full listen
/// backlog, a timeout, an interrupted call are all failures of *this connect*
/// with the app very much alive, and reporting them as a closed app sends the
/// reader to restart something that was never down.
///
/// `PermissionDenied` is the one that had a bug in it: it used to fall in with
/// the closed-app sentence, so an agent under Codex's default `workspace-write`
/// sandbox reported the user's app closed while it was open, and the only cure
/// there is went unnamed. It is deliberately *not* stated as a sandbox, because
/// this kind covers `EACCES` as well as `EPERM` — `connect(2)` returns it for
/// search permission on a path component and for write access to the socket
/// itself, neither of which any escalation fixes. So the sentence names both
/// causes and makes the cure conditional on the one escalation can help.
///
/// Everything else keeps the underlying error rather than being translated,
/// since a kind nobody anticipated is better read out than guessed at.
fn connect_failure(error: &std::io::Error, endpoint: &str) -> String {
    match error.kind() {
        ErrorKind::PermissionDenied => format!(
            "permission denied reaching Dray at {endpoint}. The app may well be \
             running: a sandbox, or the filesystem permissions on that path, \
             blocked the connection. If this command is sandboxed, retry this one \
             command with escalated permissions."
        ),
        ErrorKind::NotFound | ErrorKind::ConnectionRefused => {
            "Dray isn't running. Start the app and try again.".to_string()
        }
        _ => format!("could not connect to Dray at {endpoint}: {error}"),
    }
}

/// One request, one response, connection closed.
fn send(request: Request) -> Result<Response, String> {
    let endpoint = dray_proto::endpoint().ok_or("could not work out where Dray is listening")?;

    let mut stream =
        UnixStream::connect(&endpoint).map_err(|e| connect_failure(&e, &endpoint))?;

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

/// Splits `issue link`'s positionals into the session and the issues it names.
///
/// The session is optional so that the documented invocation can name no
/// environment variable at all. The Claude Code harness refuses any command that
/// names one inside a worktree-isolated session — which is every session `dray
/// new` makes — so the documented `dray issue link "$DRAY_SESSION_ID" DRA-53`
/// was refused before it spawned, and refused silently: the agent read the
/// refusal, carried on, and the issue was never linked.
///
/// Shape tells the two apart, and they cannot collide: a session id is a uuid,
/// so five hyphen-separated groups, where an identifier is a team key and a
/// number, so two. That keeps the old `<session> <ISSUE>...` form parsing, which
/// it must — it is shipped, and an agent holding an older skill still emits it.
fn split_session_and_issues(
    mut given: Vec<String>,
    from_environment: Option<String>,
) -> Result<(String, Vec<String>), String> {
    let session_id = if given.first().is_some_and(|first| is_session_id(first)) {
        given.remove(0)
    } else {
        from_environment.ok_or(
            "no session named, and DRAY_SESSION_ID is not set: name the session, \
             as printed by `dray ls`",
        )?
    };

    if given.is_empty() {
        return Err("name at least one issue, like DRA-53".into());
    }

    Ok((session_id, given))
}

/// Whether a positional is a session id rather than an issue identifier.
///
/// A uuid: 36 characters in groups of 8-4-4-4-12 hex. An identifier is a
/// letter-leading team key and a number, so it has two groups and can never
/// match this. The app reads Linear's own ids the same way, in `is_stable_id`.
fn is_session_id(value: &str) -> bool {
    value.len() == 36
        && value.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
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

    /// Collapses every run of whitespace to one space, so an assertion about
    /// prose cannot fail over a line break.
    fn unwrapped(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn failure(kind: ErrorKind) -> String {
        unwrapped(&connect_failure(
            &std::io::Error::from(kind),
            "/Users/me/.dray/dray.sock",
        ))
    }

    const CURE: &str = "retry this one command with escalated permissions";
    const CLOSED: &str = "Dray isn't running. Start the app and try again.";

    /// The bug this arm exists for: a sandbox refusing the connect used to
    /// report the user's app closed, which is a false fact about their machine
    /// and names no cure.
    ///
    /// It must not overcorrect either. This kind is `EACCES` as well as
    /// `EPERM`, so the sentence has to leave room for plain filesystem
    /// permissions and make the escalation conditional — asserted here, because
    /// "that is a sandbox" is exactly what it said before and it was too sure.
    #[test]
    fn permission_denied_hedges_the_cause_and_names_the_conditional_cure() {
        let message = failure(ErrorKind::PermissionDenied);

        assert!(message.contains("/Users/me/.dray/dray.sock"));
        assert!(message.contains("The app may well be running"));
        assert!(message.contains("a sandbox, or the filesystem permissions"));
        assert!(message.contains(CURE));
        // The closed-app claim must not survive here, or the caller reads both
        // answers and reports the wrong one.
        assert!(!message.contains("isn't running"));
    }

    /// Both shapes a closed app actually leaves, and the only two: no socket
    /// file at all, and a file with nobody behind it. Measured on macOS —
    /// `ENOENT` and `ECONNREFUSED` respectively.
    #[test]
    fn only_the_two_closed_app_shapes_say_the_app_is_closed() {
        for kind in [ErrorKind::NotFound, ErrorKind::ConnectionRefused] {
            assert_eq!(failure(kind), CLOSED);
        }
    }

    /// These are failures of *this connect* with the app alive — a full listen
    /// backlog answers `EAGAIN`, a call can be interrupted or time out. Each
    /// used to be reported as a closed app, which sends the reader to restart
    /// something that was never down.
    #[test]
    fn a_failure_unrelated_to_liveness_claims_nothing_about_liveness() {
        for kind in [
            ErrorKind::TimedOut,
            ErrorKind::WouldBlock,
            ErrorKind::Interrupted,
        ] {
            let message = failure(kind);

            assert!(message.contains("could not connect to Dray at"));
            assert!(message.contains("/Users/me/.dray/dray.sock"));
            assert!(!message.contains("isn't running"));
            assert!(!message.contains(CURE));
        }
    }

    const SESSION: &str = "0198f0a2-1c5e-7000-8000-000000000000";

    /// One parser serves the bare form and `find`'s, so a target read off the
    /// line and a locator `find` built have to land on the same action.
    #[test]
    fn a_verb_reads_the_same_bare_or_after_find() {
        let action = |line: &[&str]| {
            let cli = Cli::parse_from([&["dray", "browser"][..], line].concat());
            let Command::Browser(args) = cli.command else { panic!("wrong subcommand") };
            browser_action(&args)
        };

        assert!(matches!(
            action(&["click", "@e1"]),
            Ok(BrowserAction::Click { at: Locator::Target { .. } })
        ));
        assert!(matches!(
            action(&["find", "text", "Submit", "click", "--exact"]),
            Ok(BrowserAction::Click { at: Locator::Text { exact: true, .. } })
        ));
        assert!(matches!(
            action(&["find", "role", "button", "type", "hi", "--name", "Search"]),
            Ok(BrowserAction::Type { at: Locator::Role { name: Some(_), .. }, text }) if text == "hi"
        ));
        assert!(matches!(
            action(&["get", "attr", "@e1", "href"]),
            Ok(BrowserAction::Get { what: Get::Attr { .. }, at: Some(_) })
        ));
        assert!(matches!(
            action(&["scroll", "down", "-100"]),
            Ok(BrowserAction::Scroll { amount, .. }) if amount == -100.0
        ));
        assert!(action(&["find", "text", "Submit"]).is_err());
        assert!(action(&["frob"]).is_err());
        // What clap used to refuse: a word nothing reads, a flag of another verb.
        assert!(action(&["click", "@e1", "garbage"]).is_err());
        assert!(action(&["back", "garbage"]).is_err());
        assert!(action(&["click", "@e1", "--full"]).is_err());
        assert!(action(&["find", "text", "Submit", "click", "-i"]).is_err());
        assert!(action(&["snapshot", "-i", "-s", "main"]).is_ok());
    }

    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    /// The title belongs to one issue. Applying it to all of them, or silently
    /// to the first, is a wrong link that reads exactly like a right one.
    #[test]
    fn metadata_describes_one_issue() {
        let args = Cli::try_parse_from([
            "dray", "issue", "link", SESSION, "DRA-53", "DRA-54", "--title", "One",
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
        assert!(
            Cli::try_parse_from(["dray", "issue", "link", SESSION, "DRA-53", "DRA-54"]).is_ok()
        );
    }

    /// The shipped form. An agent holding an older skill still emits it, so it
    /// has to keep naming its own session and ignoring the environment.
    #[test]
    fn a_named_session_still_wins() {
        let split = split_session_and_issues(
            vec![SESSION.into(), "DRA-53".into(), "DRA-54".into()],
            Some("some-other-session".into()),
        );

        assert_eq!(
            split,
            Ok((SESSION.into(), vec!["DRA-53".into(), "DRA-54".into()]))
        );
    }

    /// The whole point: the documented invocation names no environment variable,
    /// because the Claude Code harness refuses a command that does inside a
    /// worktree — which is every session `dray new` makes.
    #[test]
    fn issues_alone_take_the_session_from_the_environment() {
        let split =
            split_session_and_issues(vec!["DRA-53".into(), "DRA-54".into()], Some(SESSION.into()));

        assert_eq!(
            split,
            Ok((SESSION.into(), vec!["DRA-53".into(), "DRA-54".into()]))
        );
    }

    /// The ambiguous case, and it is only apparent: a session id has five
    /// hyphen-separated groups where an identifier has two, so a leading
    /// `DRA-53` can never be read as the session it is being linked to.
    #[test]
    fn an_identifier_is_never_read_as_a_session() {
        assert!(!is_session_id("DRA-53"));
        assert!(!is_session_id(""));
        assert!(!is_session_id("0198f0a2-1c5e-7000-8000-00000000000z"));
        assert!(is_session_id(SESSION));

        // A lone identifier is the whole issue list, never the session.
        let split = split_session_and_issues(vec!["DRA-53".into()], Some(SESSION.into()));
        assert_eq!(split, Ok((SESSION.into(), vec!["DRA-53".into()])));
    }

    /// Run from a person's own terminal there is no session in the environment,
    /// so the refusal names the cure rather than linking to whatever it can find.
    #[test]
    fn without_a_session_anywhere_it_says_so() {
        assert!(split_session_and_issues(vec!["DRA-53".into()], None).is_err());
    }

    /// A session with nothing after it names no work. Same sentence the app
    /// answers with, so the two cannot drift into two ways of saying it.
    #[test]
    fn a_session_alone_is_refused() {
        assert_eq!(
            split_session_and_issues(vec![SESSION.into()], Some(SESSION.into())),
            Err("name at least one issue, like DRA-53".into())
        );
    }

    /// Both forms have to reach the parser before the split can see them, and
    /// `unlink` shares the arguments so it gains the short form too.
    #[test]
    fn both_forms_parse() {
        assert!(Cli::try_parse_from(["dray", "issue", "link", "DRA-53"]).is_ok());
        assert!(Cli::try_parse_from(["dray", "issue", "unlink", "DRA-53"]).is_ok());
        assert!(Cli::try_parse_from(["dray", "issue", "link", SESSION, "DRA-53"]).is_ok());
        assert!(Cli::try_parse_from(["dray", "issue", "link"]).is_err());
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
