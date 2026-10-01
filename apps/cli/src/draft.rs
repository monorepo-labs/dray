use std::path::PathBuf;

use clap::{Args, Subcommand};
use dray_proto::{CreateDraft, DraftId, DraftSummary, ListSessions, Request, Response, StartDraft};

use super::{parent_session_id, resolve_project, send, unexpected};

#[derive(Subcommand)]
pub enum DraftCommand {
    /// Save a task for the user to start later. Nothing runs until it starts.
    New(NewDraft),
    /// List saved drafts.
    Ls(DraftLs),
    /// Delete a draft.
    Rm(DraftRef),
    /// Start a draft as a session. It leaves the draft list.
    Start(DraftRef),
}

#[derive(Args)]
pub struct NewDraft {
    /// The task. Write it for someone who has not read your conversation.
    prompt: String,
    /// Repo it will run in. Defaults to the calling session's project, or the
    /// git repo of the current directory.
    #[arg(long)]
    project: Option<PathBuf>,
    /// A model alias the harness knows. Defaults to the calling session's.
    #[arg(long)]
    model: Option<String>,
    /// low, medium, high, xhigh, max or ultra.
    #[arg(long)]
    effort: Option<String>,
    /// claude_code, codex, pi, fx or grok.
    #[arg(long)]
    harness: Option<String>,
    /// Run at the agent's faster tier once started.
    #[arg(long)]
    fast: bool,
}

#[derive(Args)]
pub struct DraftLs {
    /// Every project, not just this one.
    #[arg(long)]
    all: bool,
    /// One JSON array, for reading with a program.
    #[arg(long)]
    json: bool,
    /// Repo to list. Defaults to the calling session's project.
    #[arg(long)]
    project: Option<PathBuf>,
}

#[derive(Args)]
pub struct DraftRef {
    /// The draft, as printed by `dray draft ls`.
    id: String,
}

pub fn run(command: DraftCommand) -> Result<(), String> {
    match command {
        DraftCommand::New(args) => {
            let request = Request::CreateDraft(CreateDraft {
                prompt: args.prompt,
                project_path: resolve_project(args.project),
                model: args.model,
                effort: args.effort,
                harness: args.harness,
                parent_session_id: parent_session_id(),
                fast: args.fast.then_some(true),
            });
            match send(request)? {
                Response::Draft { draft } => {
                    println!("{}", draft.id);
                    eprintln!("Saved a draft. It shows in the user's sidebar until started.");
                    Ok(())
                }
                Response::Error { message } => Err(message),
                other => Err(unexpected(other)),
            }
        }
        DraftCommand::Ls(args) => {
            let request = Request::ListDrafts(ListSessions {
                all: args.all,
                project_path: resolve_project(args.project),
                parent_session_id: parent_session_id(),
            });
            match send(request)? {
                Response::Drafts { drafts } => {
                    if args.json {
                        println!("{}", serde_json::to_string_pretty(&drafts).unwrap_or_default());
                    } else if drafts.is_empty() {
                        eprintln!("No drafts.");
                    } else {
                        for draft in &drafts {
                            println!("{}", line(draft));
                        }
                    }
                    Ok(())
                }
                Response::Error { message } => Err(message),
                other => Err(unexpected(other)),
            }
        }
        DraftCommand::Rm(args) => match send(Request::RemoveDraft(DraftId { id: args.id }))? {
            Response::Draft { draft } => {
                eprintln!("Removed \"{}\".", first_line(&draft.prompt));
                Ok(())
            }
            Response::Error { message } => Err(message),
            other => Err(unexpected(other)),
        },
        DraftCommand::Start(args) => {
            let request = Request::StartDraft(StartDraft {
                id: args.id,
                parent_session_id: parent_session_id(),
            });
            match send(request)? {
                Response::Created { session, .. } => {
                    println!("{}", session.session_id);
                    eprintln!(
                        "Started \"{}\"{}",
                        session.title,
                        match &session.worktree_name {
                            Some(name) => format!(" in worktree {name}"),
                            None => " in the project checkout".to_string(),
                        }
                    );
                    Ok(())
                }
                Response::Error { message } => Err(message),
                other => Err(unexpected(other)),
            }
        }
    }
}

/// One draft per line: id, where it runs, then the task. The checkout case is
/// spelled out because starting one there shares the user's own working tree.
fn line(draft: &DraftSummary) -> String {
    format!(
        "{}  {}  {}{}  {}",
        draft.id,
        draft.harness,
        draft.model,
        if draft.use_worktree { "" } else { "  [checkout]" },
        first_line(&draft.prompt)
    )
}

fn first_line(prompt: &str) -> &str {
    prompt.trim().lines().next().unwrap_or("")
}
