use std::path::PathBuf;

use clap::{Args, Subcommand};
use dray_proto::{CreateDraft, DraftId, DraftSummary, ListSessions, Request, Response, StartDraft};

use super::{on_machine, parent_session_id, resolve_project, send, unexpected};

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
    /// claude_code, codex, pi, fx, grok or opencode.
    #[arg(long)]
    harness: Option<String>,
    /// Run at the agent's faster tier once started.
    #[arg(long)]
    fast: bool,
    /// Base its worktree on existing work once started: a session id, a
    /// branch, or any git ref. Committed work only.
    #[arg(long, value_name = "SESSION|REF")]
    base: Option<String>,
    /// auto, manual (ask every time), plan or bypassPermissions. Defaults to
    /// the calling session's, or auto when a bot or its task is calling.
    #[arg(long, value_name = "MODE")]
    permission_mode: Option<String>,
}

#[derive(Args)]
pub struct DraftLs {
    /// Every project, which is the default now; kept so older scripts run.
    #[arg(long, hide = true)]
    all: bool,
    /// One JSON array, for reading with a program.
    #[arg(long)]
    json: bool,
    /// Only this repo's drafts. Defaults to every draft.
    #[arg(long)]
    project: Option<PathBuf>,
}

/// Every draft unless `--project` names one repo. Scoped to where the caller
/// stands, a bot's chat listed its own folder and saw none of the drafts
/// `start` could start.
fn ls_request(args: &DraftLs) -> ListSessions {
    let project_path = args.project.clone().and_then(|p| resolve_project(Some(p)));
    ListSessions { all: args.all || project_path.is_none(), project_path, parent_session_id: None }
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
                base: args.base,
                base_as_branch: false,
                permission_mode: args.permission_mode,
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
            match send(Request::ListDrafts(ls_request(&args)))? {
                Response::Drafts { drafts } => {
                    if args.json {
                        println!("{}", serde_json::to_string_pretty(&drafts).unwrap_or_default());
                    } else if drafts.is_empty() {
                        eprintln!("No drafts{}.", if args.project.is_some() { " in that project" } else { "" });
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
                Response::Created { session, base_ref, .. } => {
                    println!("{}", session.session_id);
                    eprintln!(
                        "Started \"{}\"{}{}{}",
                        session.title,
                        on_machine(&session),
                        match &session.worktree_name {
                            Some(name) => format!(" in worktree {name}"),
                            None => " in the project checkout".to_string(),
                        },
                        base_ref.map(|b| format!(", based on {b}")).unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ls(project: Option<&str>, all: bool) -> ListSessions {
        ls_request(&DraftLs { all, json: false, project: project.map(PathBuf::from) })
    }

    #[test]
    fn ls_lists_every_draft_unless_a_project_is_named() {
        let every = ls(None, false);
        assert!(every.all);
        assert_eq!(every.project_path, None);
        assert_eq!(every.parent_session_id, None, "the caller's project never narrows it");

        let repo = std::env::temp_dir().to_string_lossy().into_owned();
        let one = ls(Some(&repo), false);
        assert!(!one.all);
        assert_eq!(one.project_path, Some(repo.clone()));

        assert!(ls(Some(&repo), true).all);
    }
}
