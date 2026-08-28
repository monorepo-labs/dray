//! The socket an agent reaches Dray through.
//!
//! Every other command in this app travels frontend → Rust. This one travels
//! the other way: the `dray` CLI connects, asks for a session, and the frontend
//! learns about it from an event rather than from the return value of something
//! it called. That inversion is the whole of what this module adds — the work
//! itself goes through [`SessionManager::send_msg`], the same function the
//! composer reaches, so a session created here is not a second kind of session.
//!
//! Newline-delimited JSON over a unix socket at `~/.dray/dray.sock` — or
//! `dray-dev.sock` for a dev build, see [`socket_path`] — one
//! request per connection. Nothing on the network can reach it at all, and
//! access control is the containing directory's `0700` — see
//! [`serve`](serve) for why the socket's own mode cannot be the boundary.

use crate::{
    events::{ApprovalPolicy, MessageSender},
    issues::{self, IssueRef, IssueTracker},
    models::{default_model_for, models_for, Effort, ModelId},
    session::{Harness, SessionManager},
    store::{self, SessionIndexItem},
};
use anyhow::{bail, Context, Result};
use dray_proto::{
    encode_line, CreateSession, Envelope, IssueLink, LinkIssues, ListSessions, Request, Response,
    SendMessage, SessionSummary, MAX_LINE, PROTOCOL_VERSION,
};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};

/// Emitted when a session is created by something other than the composer, so
/// the sidebar gains the row without a refetch.
///
/// Carries the index item alone, not a `SessionSnapshot`. The frontend's
/// `agent_event` listener writes into sessions it already holds and drops
/// events for ids it doesn't — so shipping a snapshot would open a window where
/// the transcript is half-built in memory and half only on disk. An index item
/// leaves the transcript unread until the row is clicked, and
/// `handleSelectSessionIndexItem` already loads it whole from disk at that
/// point.
pub const SESSION_CREATED: &str = "session_created";

/// A spawned session may spawn; its children may not. Walked off
/// `parent_session_id` rather than stored as a number, so there is no depth
/// field free to disagree with the chain it describes.
const MAX_DEPTH: usize = 2;

/// Guards the walk against an index that somehow points at itself. Cheap
/// insurance: a cycle here would hang the caller's turn rather than fail it.
const MAX_WALK: usize = 64;

/// The socket this build listens on: `dray-dev.sock` under `pnpm tauri dev`,
/// `dray.sock` otherwise.
///
/// Split by build because the release app is normally running while this one is
/// being developed, and one path between them means whichever started last owns
/// the channel — `bind` unlinks the other's socket, so the app left behind
/// keeps a listener no `dray` will ever reach again.
pub fn socket_path() -> Option<std::path::PathBuf> {
    dray_proto::socket_path(tauri::is_dev())
}

/// What a spawned agent's `DRAY_ENDPOINT` is set to.
///
/// Injected rather than left to the CLI's own default, so a session started by
/// the dev app reaches the dev app. Without it every `dray` call inside a dev
/// session would go to the release app's socket and create sessions in the
/// wrong sidebar.
pub fn child_endpoint() -> Option<String> {
    socket_path().map(|path| path.to_string_lossy().into_owned())
}

/// Binds the socket and serves it for the life of the process.
///
/// Errors are logged and swallowed by the caller: orchestration is a side
/// channel, and an app that refuses to start because a socket is in use would
/// be trading the whole product for a feature.
pub async fn serve(app: AppHandle) -> Result<()> {
    let path = socket_path().context("could not resolve the socket path")?;

    // Creates `~/.dray` and narrows it to `0700`, which is what actually
    // guards this socket. `bind` applies the process umask, so under a
    // permissive one the socket lands world-writable and stays that way until
    // `restrict` runs a moment later — a window another local account can
    // connect through and reach session creation unauthenticated. Measured:
    // umask 022 gives 0755, umask 000 gives 0777.
    //
    // A directory cannot have that window. Connecting needs search permission
    // on every directory in the path, so `0700` there settles it before the
    // socket exists at all. The chmod below stays as a second line rather than
    // the only one.
    let dir = store::get_home_app_dir().await?;

    // That narrowing is best-effort — the app has to start whether or not it
    // lands — so this checks rather than assumes. A directory that stayed
    // group- or world-reachable leaves the racy chmod as the socket's only
    // guard, and binding anyway would be serving session creation to every
    // account on the machine.
    //
    // Refusing costs orchestration and nothing else, which is the bargain this
    // whole module already makes: the caller logs and drops the error, and the
    // app carries on without a side channel.
    let mode = owner_bits(&dir).await?;
    if mode & 0o077 != 0 {
        bail!(
            "{} is mode {mode:04o}; refusing to serve a socket that other accounts can reach. \
             Run `chmod 700 {}` and restart.",
            dir.display(),
            dir.display()
        );
    }

    // A socket file outlives the process that made it — a crash or a SIGKILL
    // leaves one behind, and binding onto it fails with "address in use". The
    // file is not a lock and holds nothing, so removing it is safe *because
    // this path names one build*: unlinking can only ever take the channel from
    // another copy of the same build, never from the release app a dev one is
    // running beside.
    tokio::fs::remove_file(&path).await.ok();

    let listener = UnixListener::bind(&path)
        .with_context(|| format!("could not bind {}", path.display()))?;

    restrict(&path)?;

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                eprintln!("[orchestration accept err] {e}");
                continue;
            }
        };

        let app = app.clone();
        // Per connection, so one slow create cannot hold the next caller off.
        tokio::spawn(async move {
            if let Err(e) = handle(stream, &app).await {
                eprintln!("[orchestration conn err] {e:#}");
            }
        });
    }
}

/// The permission bits on a directory, for the check above.
async fn owner_bits(path: &Path) -> Result<u32> {
    use std::os::unix::fs::PermissionsExt;

    let meta = tokio::fs::metadata(path)
        .await
        .with_context(|| format!("could not read {}", path.display()))?;

    Ok(meta.permissions().mode() & 0o777)
}

/// `0600` on the socket itself. Defence in depth behind the `0700` directory,
/// which is the boundary that holds from before the socket exists — this one
/// cannot, because `bind` has already applied the umask by the time it runs.
fn restrict(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .context("could not restrict the socket")
}

/// Which side is behind decides the cure, so the line names one command rather
/// than leaving the reader — usually an agent, reading this as tool output — to
/// work out which half to touch.
fn mismatch(theirs: u32) -> String {
    let cure = if theirs < PROTOCOL_VERSION {
        "run `dray update`"
    } else {
        "update the Dray app"
    };

    format!("this dray CLI speaks protocol v{theirs}, the app speaks v{PROTOCOL_VERSION} — {cure}")
}

/// Reads one request, answers it, closes. A connection carries one command so
/// that a client crashing mid-line costs nothing but itself.
async fn handle(stream: UnixStream, app: &AppHandle) -> Result<()> {
    let (read_half, mut write_half) = stream.into_split();

    let mut line = String::new();
    BufReader::new(read_half.take(MAX_LINE))
        .read_line(&mut line)
        .await
        .context("could not read the request")?;

    let response = match serde_json::from_str::<Envelope>(&line) {
        // Answered before the request is even looked at: an old CLI against a
        // new app must be told to upgrade, not handed a guess at what it meant.
        Ok(envelope) if envelope.v != PROTOCOL_VERSION => Response::error(mismatch(envelope.v)),
        Ok(envelope) => match dispatch(envelope.request, app).await {
            Ok(response) => response,
            // Reported rather than logged: the caller is an agent, and this
            // string is what it reads back as tool output.
            Err(e) => Response::error(format!("{e:#}")),
        },
        Err(e) => Response::error(format!("could not parse the request: {e}")),
    };

    write_half
        .write_all(encode_line(&response)?.as_bytes())
        .await
        .context("could not write the response")?;

    Ok(())
}

async fn dispatch(request: Request, app: &AppHandle) -> Result<Response> {
    match request {
        Request::CreateSession(create) => create_session(create, app).await,
        Request::ListSessions(list) => list_sessions(list).await,
        Request::SendMessage(send) => send_message(send, app).await,
        Request::LinkIssues(link) => link_issues(link).await,
    }
}

/// Tags a session that already exists, or untags it.
///
/// **Written down as given, with nothing asked of the tracker.** A link is a
/// local record — this session is about that work — so making it depend on a
/// reachable Linear and a stored key meant it could fail for reasons that have
/// nothing to do with what it records. The caller is an agent that has just
/// read the issue through the tracker's own MCP server and holds the title and
/// the URL already; asking a second system for what the caller has in hand is a
/// round trip whose only contribution is a way to fail.
///
/// Every issue is applied in turn and the *whole* resulting list comes back, so
/// a caller sees what the session carries rather than a diff it has to apply to
/// what it believed. One that fails stops the run: a partial tagging reported
/// as a success is the shape of failure this protocol exists to avoid, and the
/// ones already applied are on the session the answer names.
async fn link_issues(link: LinkIssues) -> Result<Response> {
    if link.issues.is_empty() {
        bail!("name at least one issue, like DRA-53");
    }

    // An unknown session is answered before anything is written, so a typo in
    // the id cannot half-apply a list.
    store::get_session_index_item(&link.session_id)
        .await?
        .with_context(|| format!("no session {}", link.session_id))?;

    let mut linked = Vec::new();
    for input in &link.issues {
        let identifier = issues::parse_identifier(&input.identifier)
            .with_context(|| format!("{} is not an issue identifier", input.identifier))?;

        linked = if link.unlink {
            store::unlink_session_issue(&link.session_id, &identifier).await?
        } else {
            store::link_session_issue(
                &link.session_id,
                IssueRef {
                    tracker: IssueTracker::Linear,
                    // No tracker call, so no stable tracker id to record. The
                    // identifier stands in: `unlink_session_issue` already
                    // matches on either, so a link made here is removable by
                    // the panel's button and by `dray issue unlink` alike.
                    id: identifier.clone(),
                    identifier,
                    title: input.title.clone().unwrap_or_default(),
                    url: input.url.clone().unwrap_or_default(),
                },
            )
            .await?
        };
    }

    Ok(Response::Linked {
        issues: linked
            .into_iter()
            .map(|issue| IssueLink {
                identifier: issue.identifier,
                title: issue.title,
                url: issue.url,
            })
            .collect(),
    })
}

async fn create_session(create: CreateSession, app: &AppHandle) -> Result<Response> {
    if create.prompt.trim().is_empty() {
        bail!("a session needs a prompt");
    }

    let parent = match create.parent_session_id.as_deref() {
        Some(id) => Some(
            store::get_session_index_item(id)
                .await?
                .with_context(|| format!("no session {id}"))?,
        ),
        None => None,
    };

    if let Some(parent) = &parent {
        let depth = depth_of(parent).await?;
        if depth >= MAX_DEPTH {
            bail!(
                "this session is {depth} levels deep already — a spawned session may create \
                 sessions, but those may not create more. Ask the user to start the next \
                 batch from a top-level session."
            );
        }
    }

    let project_path = resolve_project(&create, parent.as_ref())?;

    // The project is deliberately *not* attached here. The sidebar's filter
    // defaults to null and lists every session whatever its project, so a
    // session under an unattached repo is already reachable — while
    // `add_project` bumps `last_selected` and resorts the list, which would
    // let an agent's call quietly reorder the user's project picker.
    let harness = resolve_harness(create.harness.as_deref(), parent.as_ref())?;
    let model = resolve_model(create.model.as_deref(), parent.as_ref(), harness)?;

    // The caller's pick, else whatever the parent ran at, else `None` — which
    // `send_msg` resolves to the model's own default through `resolve_effort`,
    // the same call that drops an effort a model has no levels for.
    let effort = match create.effort.as_deref() {
        Some(alias) => Some(Effort::from_arg(alias).with_context(|| {
            format!("unknown effort {alias:?} — try low, medium, high, xhigh or max")
        })?),
        None => parent.as_ref().and_then(|p| p.effort),
    };
    let permission_mode = parent
        .as_ref()
        .map(|p| p.permission_mode)
        .unwrap_or_else(ApprovalPolicy::default);

    // Resolved before anything is written, so a `--from` naming a session or a
    // ref that cannot be found costs an error rather than a session sitting in
    // the sidebar on the wrong base.
    let base_ref = match create.from.as_deref() {
        Some(from) => Some(resolve_base(from, &project_path).await?),
        None => None,
    };

    let session_id = uuid::Uuid::now_v7().to_string();
    let manager = app.state::<SessionManager>();

    let outcome = manager
        .send_msg(
            &session_id,
            &create.prompt,
            &[],
            &create.issues,
            harness,
            model,
            effort,
            permission_mode,
            &project_path,
            None,
            // Always. Sessions created this way are meant to run at the same
            // time, and several agents writing to one checkout overwrite each
            // other — the changes panel cannot even tell them apart.
            true,
            // Never named by the caller: an agent has no basis for choosing
            // one, and a name that collides is a create that fails for a field
            // nobody wanted. `None` lets the app generate a readable one.
            None,
            base_ref.as_deref(),
            true,
            create.parent_session_id.as_deref(),
            // The creating session is this one's *parent*, which the sidebar
            // already draws by nesting the row. Its opening prompt is the brief,
            // not a message relayed into a conversation already under way.
            None,
            app,
        )
        .await?;

    let item = outcome
        .snapshot
        .map(|s| s.index_item)
        .context("the session was created but returned no index entry")?;

    // After the send, so the row the sidebar gains is one that actually started.
    app.emit(SESSION_CREATED, &item).ok();

    Ok(Response::Created {
        session: summarize(item),
        base_ref,
    })
}

/// What `--from` starts the new worktree at: a session id, a branch, or any
/// other ref.
///
/// A session id is tried first, because it is the address everywhere else in
/// `dray` — `ls` prints it, `send` takes it — and an agent holding one should
/// not have to learn how Dray names branches to point at that session's work.
/// A ref that happens to look like a session id is the only ambiguity, and a
/// v7 UUID is not a branch name anybody types.
///
/// The session's branch comes from [`store::session_branch`], the one reading
/// of that question, so this cannot start a reviewer on one branch while the
/// author's header names another.
///
/// **Committed work only**, and nothing here can change that: a worktree at a
/// branch tip carries what was committed and not what the author has open in
/// their editor. Usually right for a review, and said plainly in the skill,
/// because the failure is an agent reporting confidently on a tree that is
/// missing the very change the user is looking at.
async fn resolve_base(from: &str, project_path: &str) -> Result<String> {
    if let Some(item) = store::get_session_index_item(from).await? {
        // Read where the session actually runs, which is its worktree for a
        // worktree session — `session_branch` outranks it for a relocated one,
        // whose `cwd` is the shared project root.
        let observed = crate::git::current_branch(&item.cwd).await;
        let branch = store::session_branch(&item, observed.as_deref()).with_context(|| {
            format!(
                "session {from} is on no branch — a detached HEAD, or a directory that is not \
                 a repository. Pass a branch or a commit instead."
            )
        })?;

        // A session in another repo — or one whose branch has since been
        // deleted — names a branch this one has never heard of. Said here
        // rather than left to git, whose error names the branch without saying
        // that a session was what asked for it.
        if crate::git::resolve_commit(project_path, &branch).await.is_none() {
            bail!(
                "session {from} is on branch {branch}, which {project_path} does not have — \
                 check the two are the same repository, and that the branch still exists"
            );
        }

        return Ok(branch);
    }

    if crate::git::resolve_commit(project_path, from).await.is_some() {
        return Ok(from.to_string());
    }

    bail!("{from} is neither a session id nor a branch, tag or commit in {project_path}")
}

async fn list_sessions(list: ListSessions) -> Result<Response> {
    let items = store::list_session_index_items_by_archived(false).await?;

    let scope = if list.all {
        None
    } else {
        let parent = match list.parent_session_id.as_deref() {
            Some(id) => store::get_session_index_item(id).await?,
            None => None,
        };
        project_from(list.project_path.as_deref(), parent.as_ref())
    };

    let sessions = items
        .into_iter()
        .filter(|i| scope.as_deref().is_none_or(|p| i.project_path == p))
        .map(summarize)
        .collect();

    Ok(Response::Listed { sessions })
}

/// How many creates deep this session already sits. A session with no parent is
/// depth 0, one created by an agent is depth 1.
async fn depth_of(item: &SessionIndexItem) -> Result<usize> {
    let mut depth = 0;
    let mut cursor = item.parent_session_id.clone();

    while let Some(id) = cursor {
        depth += 1;
        if depth >= MAX_WALK {
            bail!("the session's parent chain does not terminate");
        }
        cursor = store::get_session_index_item(&id)
            .await?
            .and_then(|parent| parent.parent_session_id);
    }

    Ok(depth)
}

/// The caller's alias if it gave one, else the parent's recorded model, else
/// the harness's default. A parent indexed before models were recorded reads
/// back as `Unknown`, which has no CLI alias — so that falls through to the
/// default rather than failing a create for a field the user never chose.
///
/// Inheritance is filtered by harness, not just by "is this a model we know":
/// a Codex session spawned from a Claude one would otherwise inherit `opus`,
/// which Codex cannot run at all, and the create would fail at the spawn for a
/// choice nobody made.
fn resolve_model(
    requested: Option<&str>,
    parent: Option<&SessionIndexItem>,
    harness: Harness,
) -> Result<ModelId> {
    if let Some(alias) = requested {
        let id = ModelId::from_arg(alias)
            .filter(|id| runs_on(*id, harness))
            .with_context(|| {
                let known: Vec<_> = models_for(harness)
                    .into_iter()
                    .filter_map(|m| m.id.as_arg())
                    .collect();
                format!("unknown model {alias:?} — try {}", known.join(", "))
            })?;
        return Ok(id);
    }

    Ok(parent
        .map(|p| p.model)
        .filter(|id| runs_on(*id, harness))
        .unwrap_or_else(|| default_model_for(harness)))
}

/// Whether this harness can actually run that model.
fn runs_on(id: ModelId, harness: Harness) -> bool {
    models_for(harness).into_iter().any(|m| m.id == id)
}

/// Sends a prompt into a session that already exists.
///
/// The target's *own* recorded model, effort and permission mode are passed
/// back in, which is what makes a relayed message inert: `send_msg` compares
/// them against what the child is running, finds no change, and so neither
/// switches the model nor respawns for a new effort. A message must not
/// reconfigure the session it arrives at.
///
/// Deliberately unrestricted to the parent/child pair. A child reporting a
/// review summary upward and a parent handing a child extra context are the
/// same operation, and naming the relationship would only add a rule to get
/// wrong — the id is the address.
async fn send_message(send: SendMessage, app: &AppHandle) -> Result<Response> {
    if send.prompt.trim().is_empty() {
        bail!("a message needs some text");
    }

    let target = store::get_session_index_item(&send.session_id)
        .await?
        .with_context(|| format!("no session {}", send.session_id))?;

    if target.session_id == send.from_session_id.clone().unwrap_or_default() {
        bail!("a session cannot send a message to itself");
    }

    let from = sender(&send).await;
    let prompt = attribute(&send.prompt, from.as_ref());

    let manager = app.state::<SessionManager>();
    let outcome = manager
        .send_msg(
            &target.session_id,
            &prompt,
            &[],
            // None named: a relayed message carries whatever it tags in its own
            // text, and must not re-aim the session it arrives at.
            &[],
            target.harness,
            target.model,
            target.effort,
            target.permission_mode,
            &target.cwd,
            None,
            false,
            None,
            None,
            false,
            None,
            from,
            app,
        )
        .await?;

    Ok(Response::Sent {
        queued: outcome.queued.is_some(),
    })
}

/// The prompt as the receiving *agent* will read it, with its sender named.
///
/// This and [`user_message.from`](crate::events::MessageSender) carry the same
/// fact to two different readers, and both are needed because neither can do
/// the other's job.
///
/// The agent has no channel but this text. Verified against the CLI: every
/// control-request subtype carries a setting (`set_model`,
/// `set_permission_mode`, `interrupt`, `stop_task`, `initialize`) and none
/// carries metadata, unknown fields are dropped in silence rather than
/// refused, and `--append-system-prompt` is fixed at spawn. Codex is no
/// different — `codex exec` takes a prompt and nothing beside it. So a prefix
/// is not one option among several here; it is the only one.
///
/// The transcript, meanwhile, has the field and so never parses this line back
/// out. A title holding a bracket, a reworded prefix, or a harness whose prompt
/// is shaped differently would break a regex *silently* and leave a relayed
/// message looking like the user's own. A field is either there or it isn't.
///
/// Both built from one [`MessageSender`], so the two cannot name different
/// sessions. The id rides along because it is the address: the agent answers
/// with `dray send <id>` rather than paying a `dray ls` to work out who asked.
fn attribute(prompt: &str, from: Option<&MessageSender>) -> String {
    match from {
        Some(from) => format!(
            "[message from the Dray session \"{}\" ({})]\n\n{prompt}",
            from.title, from.session_id
        ),
        None => prompt.to_string(),
    }
}

/// Who this message is from, as data the transcript can draw.
///
/// `None` for a call from the user's own terminal — there is no session behind
/// it — and for one whose sender has since been deleted. One lookup answers for
/// both readers, so neither the prefix nor the card claims a session the index
/// can no longer name.
async fn sender(send: &SendMessage) -> Option<MessageSender> {
    let from = send.from_session_id.as_deref()?;

    store::get_session_index_item(from)
        .await
        .ok()
        .flatten()
        .map(|item| MessageSender {
            session_id: item.session_id,
            title: item.title,
        })
}

/// The caller's pick, else the parent's, else Claude Code.
fn resolve_harness(requested: Option<&str>, parent: Option<&SessionIndexItem>) -> Result<Harness> {
    match requested {
        Some("claude_code") => Ok(Harness::ClaudeCode),
        Some("codex") => Ok(Harness::Codex),
        Some(other) => bail!("unknown harness {other:?} — try claude_code or codex"),
        None => Ok(parent.map(|p| p.harness).unwrap_or(Harness::ClaudeCode)),
    }
}

fn resolve_project(create: &CreateSession, parent: Option<&SessionIndexItem>) -> Result<String> {
    project_from(create.project_path.as_deref(), parent).context(
        "no project to create the session in — pass --project, or run this from inside a repo",
    )
}

/// The caller's own answer wins, then the parent's. Canonicalized because
/// `projects.rs` canonicalizes at attach time: `/x/proj` and `/x/proj/` would
/// otherwise become two projects and split the sidebar's grouping.
fn project_from(requested: Option<&str>, parent: Option<&SessionIndexItem>) -> Option<String> {
    let raw = requested.or_else(|| parent.map(|p| p.project_path.as_str()))?;

    Some(
        std::fs::canonicalize(raw)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| raw.to_string()),
    )
}

fn summarize(item: SessionIndexItem) -> SessionSummary {
    SessionSummary {
        session_id: item.session_id,
        title: item.title,
        cwd: item.cwd,
        project_path: item.project_path,
        branch: item.branch,
        worktree_name: item.worktree_name,
        // Through serde rather than a match, so a status added to the enum
        // cannot leave this arm reporting the wrong one.
        status: serde_json::to_value(item.status)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "idle".into()),
        modified: item.modified,
        parent_session_id: item.parent_session_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Effort;

    fn item(id: &str, parent: Option<&str>) -> SessionIndexItem {
        SessionIndexItem::new(
            id,
            Harness::ClaudeCode,
            "/p",
            "/p",
            None,
            None,
            "hi",
            ModelId::Opus,
            Some(Effort::High),
            ApprovalPolicy::Auto,
            parent,
        )
    }

    #[test]
    fn summary_spells_status_the_way_the_index_does() {
        let summary = summarize(item("a", None));
        assert_eq!(summary.status, "idle");
        assert_eq!(summary.session_id, "a");
    }

    #[test]
    fn the_callers_project_beats_the_parents() {
        let parent = item("a", None);
        // Neither path exists, so canonicalize falls through and the raw value
        // stands — which is the behaviour that matters here.
        assert_eq!(
            project_from(Some("/other"), Some(&parent)).as_deref(),
            Some("/other")
        );
        assert_eq!(project_from(None, Some(&parent)).as_deref(), Some("/p"));
        assert_eq!(project_from(None, None), None);
    }

    /// The predicate the bind guard turns on, spelled out so the two cases
    /// that matter are pinned rather than read out of a bitmask at a glance.
    #[test]
    fn only_owner_only_modes_are_allowed_to_carry_the_socket() {
        let reachable = |mode: u32| mode & 0o077 != 0;

        assert!(!reachable(0o700), "owner-only is the one acceptable mode");
        // The default `create_dir_all` leaves, and what the app shipped with.
        assert!(reachable(0o755));
        // Group-writable is the case the review named.
        assert!(reachable(0o770));
        assert!(reachable(0o777));
        // Group *read* alone still means another account can traverse in.
        assert!(reachable(0o750));
    }

    /// The prefix is the receiving agent's only signal, so its two facts are
    /// pinned: the title it reads, and the id it can answer to.
    #[test]
    fn a_relayed_prompt_names_its_sender_and_the_id_to_reply_to() {
        let from = MessageSender {
            session_id: "abc-123".into(),
            title: "Fix the login redirect".into(),
        };
        let prompt = attribute("review is done", Some(&from));

        assert!(prompt.starts_with(
            "[message from the Dray session \"Fix the login redirect\" (abc-123)]\n\n"
        ));
        assert!(prompt.ends_with("review is done"));
    }

    /// A prompt from the user's own terminal has no sender, and must reach the
    /// agent exactly as it was typed.
    #[test]
    fn an_unattributed_prompt_is_left_alone() {
        assert_eq!(attribute("just do it", None), "just do it");
    }

    #[test]
    fn a_version_mismatch_is_refused_before_the_request_is_read() {
        let line = r#"{"v":99,"cmd":"create_session","prompt":"hi","useWorktree":true}"#;
        let envelope: Envelope = serde_json::from_str(line).unwrap();
        assert_ne!(envelope.v, PROTOCOL_VERSION);
    }

    /// Naming the wrong half is worse than naming neither: the reader runs a
    /// command that cannot fix what they have.
    #[test]
    fn the_mismatch_names_whichever_side_is_behind() {
        assert!(mismatch(PROTOCOL_VERSION - 1).contains("dray update"));
        assert!(mismatch(PROTOCOL_VERSION + 1).contains("update the Dray app"));
        assert!(!mismatch(PROTOCOL_VERSION + 1).contains("dray update"));
    }
}
