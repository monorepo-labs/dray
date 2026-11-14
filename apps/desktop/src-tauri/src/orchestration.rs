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
//! the same name in this build's own home, see [`socket_path`] — one
//! request per connection. Nothing on the network can reach it at all, and
//! access control is the containing directory's `0700` — see
//! [`serve`](serve) for why the socket's own mode cannot be the boundary.

use crate::{
    bots,
    events::{ApprovalPolicy, MessageSender},
    issues::{self, IssueRef, IssueTracker},
    models::{default_model_for, id_for_arg, models_for, runs_on, Effort, ModelId},
    session::{manager, Harness},
    sink::Sink,
    drafts::{self, StoredDraft, DRAFTS_CHANGED},
    store::{self, SessionIndexItem},
};
use anyhow::{bail, Context, Result};
use dray_proto::{
    encode_line, CreateDraft, CreateSession, DraftSummary, Envelope, StartDraft, IssueInput, IssueLink, LinkIssues, ListSessions, Request,
    Response, SendMessage, SendToBot, SessionSummary, SetAside, MAX_LINE, OLDEST_SPOKEN, PROTOCOL_VERSION,
};
use std::path::Path;
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

/// A session's index entry changed from here — settled, unsettled, set aside —
/// carrying the entry as it now stands. The sidebar's own buttons need none:
/// the frontend made those writes and merges what they answered.
pub const SESSION_CHANGED: &str = "session_changed";

/// Emitted when `dray issue link` or `dray issue unlink` changes what a session
/// is tagged with, so the panel's Issue tab appears, redraws or goes away
/// without a reselect.
///
/// This socket is the one channel that reaches Rust without the frontend
/// asking, so a link made over it was invisible until the next send answered
/// with `SendOutcome.issues` — see #256. The *whole* list rides along rather
/// than a delta, which is the rule that answer already follows: re-tagging
/// replaces an entry rather than appending one.
pub const ISSUES_CHANGED: &str = "issues_changed";

/// The payload of [`ISSUES_CHANGED`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssuesChangedEvent {
    pub session_id: String,
    pub issues: Vec<IssueRef>,
}

/// A spawned session may spawn; its children may not. Walked off
/// `parent_session_id` rather than stored as a number, so there is no depth
/// field free to disagree with the chain it describes.
const MAX_DEPTH: usize = 2;

/// The socket this build listens on: `dray.sock`, in its own home.
///
/// Split by home because the release app is normally running while a dev build
/// is being worked on, and one path between them means whichever started last
/// owns the channel — `bind` unlinks the other's socket, so the app left behind
/// keeps a listener no `dray` will ever reach again. A dev build always has a
/// home of its own (`store::home_override`), which the CLI's own resolver
/// below knows nothing of.
///
/// Under `DRAY_HOME` the socket moves with the data, so a second process on
/// its own directory takes no channel from the app's.
pub fn socket_path() -> Option<std::path::PathBuf> {
    if let Some(home) = store::home_override() {
        return Some(home.join(dray_proto::SOCKET_NAME));
    }
    dray_proto::socket_path()
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
pub async fn serve(app: Sink) -> Result<()> {
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
    check_private(&dir).await?;

    let mut socket = Socket::bind(&path)?;

    let mut check = tokio::time::interval(SOCKET_CHECK);
    check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            accepted = socket.listener.accept() => {
                let stream = match accepted {
                    Ok((stream, _)) => stream,
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
            _ = check.tick() => {
                socket.heal(&path).await;
            }
        }
    }
}

/// How often the socket path is checked against the file this process bound.
/// One `stat` a tick; a longer gap is that much longer of every `dray` call
/// failing.
const SOCKET_CHECK: std::time::Duration = std::time::Duration::from_secs(5);

/// `(dev, ino)`: what tells the socket this process bound apart from another
/// file later put at the same path.
type FileId = (u64, u64);

fn file_id(path: &Path) -> std::io::Result<FileId> {
    use std::os::unix::fs::MetadataExt;

    let meta = std::fs::symlink_metadata(path)?;
    Ok((meta.dev(), meta.ino()))
}

/// What the socket path names on one check.
#[derive(Debug, PartialEq, Eq)]
enum PathState {
    Ours,
    Gone,
    Other(FileId),
}

fn path_state(bound: FileId, seen: std::io::Result<FileId>) -> PathState {
    match seen {
        Ok(id) if id == bound => PathState::Ours,
        Ok(id) => PathState::Other(id),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PathState::Gone,
        // Unreadable says nothing about whose socket it is, so it is left be.
        Err(_) => PathState::Ours,
    }
}

/// The listener, and what is known about the path it was bound at.
///
/// A listening socket is tied to its inode, not its name. Unlink the file or
/// put another in its place and this listener keeps accepting on an inode no
/// path reaches, while every `dray` call meets nothing or a dead file and reads
/// it as Dray not running. Deleting `~/.dray` does it; so did a sandbox
/// restored from a snapshot, whose disk was swapped under a running server and
/// left a copied socket file behind (#801). [`Socket::heal`] binds again.
struct Socket {
    listener: UnixListener,
    id: FileId,
    /// A live socket found holding the path, left to its owner. Probing it
    /// every tick would hand that process an empty connection each time.
    yielded: Option<FileId>,
    /// Whether the last rebind failed, so a lasting failure logs once.
    failing: bool,
}

impl Socket {
    /// Binds the path, unlinking whatever stale file holds it, and narrows the
    /// socket to `0600`.
    ///
    /// A socket file outlives the process that made it — a crash or a SIGKILL
    /// leaves one behind, and binding onto it fails with "address in use". The
    /// file is not a lock and holds nothing, so removing it is safe *because
    /// this path names one build*: unlinking can only ever take the channel
    /// from another copy of the same build, never from the release app a dev
    /// one is running beside.
    fn bind(path: &Path) -> Result<Self> {
        std::fs::remove_file(path).ok();

        let listener = UnixListener::bind(path)
            .with_context(|| format!("could not bind {}", path.display()))?;

        restrict(path)?;

        Ok(Self {
            listener,
            id: file_id(path).context("could not read the socket just bound")?,
            yielded: None,
            failing: false,
        })
    }

    /// Binds again when the path no longer names this socket and nothing live
    /// answers there. Returns whether it did.
    ///
    /// The connect is what keeps two processes from taking the path back and
    /// forth: one that answers owns it, so this one leaves it be. Only a path
    /// that is gone or refuses is ours to take.
    async fn heal(&mut self, path: &Path) -> bool {
        let seen = match path_state(self.id, file_id(path)) {
            PathState::Ours => return false,
            PathState::Gone => None,
            PathState::Other(id) => Some(id),
        };

        if seen.is_some() && seen == self.yielded {
            return false;
        }

        match UnixStream::connect(path).await {
            Ok(_) => {
                if let Some(id) = seen {
                    self.yielded = Some(id);
                    eprintln!(
                        "[orchestration] socket at {} belongs to another live process; leaving it",
                        path.display()
                    );
                }
                return false;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) => {}
            Err(_) => return false,
        }

        match rebind(path).await {
            Ok(socket) => {
                *self = socket;
                eprintln!("[orchestration] socket at {} was replaced; rebound", path.display());
                true
            }
            Err(e) => {
                if !self.failing {
                    eprintln!(
                        "[orchestration] socket at {} was replaced; could not rebind: {e:#}",
                        path.display()
                    );
                }
                self.failing = true;
                false
            }
        }
    }
}

/// Recreates the socket's directory if it went, narrows it to `0700` the way
/// startup does, checks it, then binds.
///
/// Not through `store::get_home_app_dir`, which answers from a cache and would
/// never notice the directory was deleted. The narrowing is not redundant with
/// creating at `0700`: a session's log write can recreate the directory first,
/// under the umask, and a check alone would then refuse it forever.
async fn rebind(path: &Path) -> Result<Socket> {
    let dir = path.parent().context("the socket path has no directory")?;
    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("could not create {}", dir.display()))?;
    store::restrict_to_owner(dir).await;

    check_private(dir).await?;
    Socket::bind(path)
}

/// Refuses a directory any other account can reach.
///
/// `get_home_app_dir`'s narrowing is best-effort — the app has to start
/// whether or not it lands — so this checks rather than assumes. A directory
/// that stayed group- or world-reachable leaves the racy chmod as the socket's
/// only guard, and binding anyway would be serving session creation to every
/// account on the machine.
///
/// Refusing costs orchestration and nothing else, which is the bargain this
/// whole module already makes: the caller logs and drops the error, and the
/// app carries on without a side channel.
async fn check_private(dir: &Path) -> Result<()> {
    let mode = owner_bits(dir).await?;
    if mode & 0o077 != 0 {
        bail!(
            "{} is mode {mode:04o}; refusing to serve a socket that other accounts can reach. \
             Run `chmod 700 {}` and restart.",
            dir.display(),
            dir.display()
        );
    }
    Ok(())
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

/// Answered before the request is even looked at: a CLI older than
/// [`OLDEST_SPOKEN`] must be told to upgrade, not handed a guess at what it
/// meant — and one newer than this app must be told the same, which is why `v`
/// is read on its own first. `Envelope` flattens the request in, so a variant
/// this build cannot spell fails the whole parse and the version would never
/// be seen. Anything in between is answered: the CLI stamps each request with
/// the oldest version that carries it, so an in-range line means what it says.
fn refusal(line: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Version {
        v: u32,
    }
    let Version { v } = serde_json::from_str(line).ok()?;
    (!(OLDEST_SPOKEN..=PROTOCOL_VERSION).contains(&v)).then(|| mismatch(v))
}

/// Reads one request, answers it, closes. A connection carries one command so
/// that a client crashing mid-line costs nothing but itself.
async fn handle(stream: UnixStream, app: &Sink) -> Result<()> {
    let (read_half, mut write_half) = stream.into_split();

    let mut line = String::new();
    BufReader::new(read_half.take(MAX_LINE))
        .read_line(&mut line)
        .await
        .context("could not read the request")?;

    let response = match refusal(&line) {
        Some(error) => Response::error(error),
        None => match serde_json::from_str::<Envelope>(&line) {
            Ok(envelope) => match route(envelope.request, app).await {
            Ok(response) => response,
            // Reported rather than logged: the caller is an agent, and this
            // string is what it reads back as tool output.
                Err(e) => Response::error(format!("{e:#}")),
            },
            Err(e) => Response::error(format!("could not parse the request: {e}")),
        },
    };

    write_half
        .write_all(encode_line(&response)?.as_bytes())
        .await
        .context("could not write the response")?;

    Ok(())
}

/// What the socket answers: a request for another machine goes there, and one
/// naming a session this index has never heard of goes to whichever connected
/// machine holds it — asked only on that miss, so an ordinary call costs no
/// round trip. A forwarded request never comes through here, so it cannot
/// bounce on to a third machine.
async fn route(request: Request, app: &Sink) -> Result<Response> {
    if let Request::OnMachine(on) = request {
        return on_machine(&on.machine, *on.request, app).await;
    }
    #[cfg(any(feature = "serve", feature = "desktop"))]
    if let Some(id) = session_named(&request) {
        if store::get_session_index_item(id).await?.is_none() {
            // Where this server already knows the machine — a bot's task
            // started there, or a flag held for it — asked straight, since a
            // sweep cannot find one whose machine is down and set-aside holds
            // it then (#1050).
            if let Request::SetAside(aside) = &request {
                let known = match crate::held_flags::machine_of(id).await {
                    Some(machine) => Some(machine),
                    None => crate::remote_reports::machine_of(id).await,
                };
                if let Some(machine) = known {
                    return elsewhere::set_aside(&machine, aside.clone(), app).await;
                }
            }
            if let Some(machine) = elsewhere::locate(id).await {
                return on_machine(&machine, request, app).await;
            }
        }
    }
    dispatch(request, app).await
}

/// The session a verb acts on, for [`route`] to look for elsewhere.
#[cfg(any(feature = "serve", feature = "desktop"))]
fn session_named(request: &Request) -> Option<&str> {
    match request {
        Request::SendMessage(r) => Some(&r.session_id),
        Request::LinkIssues(r) => Some(&r.session_id),
        Request::RenameSession(r) => Some(&r.session_id),
        Request::StopSession(r) => Some(&r.session_id),
        Request::SettleSession(r) => Some(&r.session_id),
        Request::SetAside(r) => Some(&r.session_id),
        Request::Share(r) => Some(&r.session_id),
        Request::Browser(r) => Some(&r.session_id),
        Request::MergeCard(r) => Some(&r.session_id),
        Request::SetNeed(r) => Some(&r.session_id),
        // Never `AddVideo`: its path is this machine's, and forwarded it would
        // name a file the other machine does not have, or a different one.
        _ => None,
    }
}

/// Requests about the machine they run on — its server list, its listener —
/// which no other machine may make for it.
fn this_machine_only(request: &Request) -> bool {
    matches!(
        request,
        Request::OnMachine(_)
            | Request::AddServer(_)
            | Request::ListServers
            | Request::RemoveServer(_)
            | Request::RenameServer(_)
            | Request::SetServerOn(_)
            | Request::SetRemoteAccess(_)
            | Request::ShareMachines(_)
            | Request::PairAssistant(_)
            | Request::ListAssistants
            | Request::RevokeAssistant(_)
            | Request::Login
            | Request::LinkStatus
            | Request::Logout
    )
}

#[cfg(any(feature = "serve", feature = "desktop"))]
async fn on_machine(machine: &str, request: Request, app: &Sink) -> Result<Response> {
    if this_machine_only(&request) {
        bail!("`dray machine` and `dray server` act on this machine alone — drop --machine");
    }
    if machine == "all" {
        let Request::ListSessions(list) = request else {
            bail!("only `dray session ls` takes --machine all");
        };
        return elsewhere::list_everywhere(list).await;
    }
    if let Request::SetAside(aside) = request {
        return elsewhere::set_aside(machine, aside, app).await;
    }
    // Read before the send, since a flush landing during it empties the file.
    let held_at_send = match &request {
        Request::SendMessage(send) => crate::held_flags::list().await.into_iter().find(|h| h.session_id == send.session_id),
        _ => None,
    };
    let creates = matches!(request, Request::CreateSession(_));
    let forward = elsewhere::prepare(request).await?;
    let response = elsewhere::forward(machine, &forward).await?;
    // The task's server keeps its reports, and this server holds the link to
    // collect them by; the other way round usually does not exist.
    if let (true, Some(caller), Response::Created { session, .. }) = (creates, &forward.caller, &response) {
        if caller.bot_tree {
            let saved = crate::machines::on(machine).await.map_err(anyhow::Error::msg)?;
            crate::remote_reports::track(&saved.id, &session.session_id, &caller.session.session_id).await?;
        }
    }
    // A message brings a set-aside session back, so a flag held from before
    // it must not stay put away. Dropped behind any flush writing it, and
    // undone there where that flush may have landed after the message.
    if let (Some(held), Response::Sent { .. }) = (held_at_send, &response) {
        let released = crate::held_flags::release(&held.session_id, &held.at).await?;
        if released == crate::held_flags::Released::Held {
            crate::held_flags::announce(app, Vec::new()).await;
        }
        // Only a flag the flush wrote: a newer choice, held or written
        // directly, is the reader's and stands.
        if held.aside && released == crate::held_flags::Released::Landed {
            let back = elsewhere::prepare(Request::SetAside(SetAside { session_id: held.session_id, aside: false })).await?;
            if let Err(e) = elsewhere::forward(machine, &back).await {
                eprintln!("[held flags] could not bring back after a send: {e:#}");
            }
        }
    }
    Ok(response)
}

/// A build with no serve wire has no client half to reach one with.
#[cfg(not(any(feature = "serve", feature = "desktop")))]
async fn on_machine(_machine: &str, _request: Request, _app: &Sink) -> Result<Response> {
    bail!("this build reaches no other machines")
}

/// What a machine forwarding a request knows and the one it lands on cannot
/// look up: the calling session, the sender, and which repository a path
/// there names. The serve command `orchestrate` takes it as its arguments.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    /// The envelope, judged by version on the far side as the socket would.
    pub line: String,
    /// The project's `origin`, so the far side finds its own checkout.
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub caller: Option<Caller>,
    #[serde(default)]
    pub sender: Option<MessageSender>,
}

/// The calling session's row, carried whole with its depth, since the
/// machine making its child has no index entry to walk.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Caller {
    pub session: SessionIndexItem,
    pub depth: usize,
    /// The caller is a bot's chat or under one, so the child's reports are
    /// kept for the forwarding server to collect (#958). Absent from an
    /// older one, whose tasks report nowhere.
    #[serde(default)]
    pub bot_tree: bool,
}

/// The serve command `orchestrate`: a request a Mac forwarded, answered as the
/// socket answers one, with what the Mac carried standing in for the lookups
/// this index cannot make.
pub async fn answer_forward(forward: Forward, app: Sink) -> Response {
    let answered = async {
        if let Some(error) = refusal(&forward.line) {
            bail!(error);
        }
        let envelope: Envelope = serde_json::from_str(&forward.line).context("could not parse the request")?;
        let mut request = envelope.request;
        if this_machine_only(&request) {
            bail!("that acts on the machine it runs on, so run it there");
        }
        localize(&mut request, forward.origin.as_deref()).await?;
        // A session `--base` from the Mac arrives as its branch, which this
        // checkout may hold only as the copy pushed to `origin`. A session id
        // this index holds is left for `resolve_base`.
        match &mut request {
            Request::CreateSession(CreateSession { base: Some(base), project_path: Some(project), .. })
            | Request::CreateDraft(CreateDraft { base: Some(base), project_path: Some(project), .. })
                if store::get_session_index_item(base).await?.is_none() =>
            {
                *base = crate::git::pushed_branch(project, base).await?;
            }
            _ => {}
        }
        let caller = forward.caller.as_ref();
        match request {
            Request::CreateSession(create) => create_session(create, caller, &app).await,
            Request::CreateDraft(create) => create_draft(create, caller, &app).await,
            Request::StartDraft(start) => start_draft(start, caller, &app).await,
            Request::SendMessage(send) => send_message(send, forward.sender, &app).await,
            other => dispatch(other, &app).await,
        }
    };
    answered.await.unwrap_or_else(|e| Response::error(format!("{e:#}")))
}

/// Points a project path from the forwarding Mac at this machine's checkout of
/// the same repository, matched on `origin`. Failing that, a path this machine
/// has is taken as named, which is how `--project` names one here.
async fn localize(request: &mut Request, origin: Option<&str>) -> Result<()> {
    let slot = match request {
        Request::CreateSession(create) => &mut create.project_path,
        Request::CreateDraft(create) => &mut create.project_path,
        // `--all` names no project, whatever path rode along.
        Request::ListSessions(list) | Request::ListDrafts(list) | Request::ListShares(list) if list.all => {
            return Ok(());
        }
        Request::ListSessions(list) | Request::ListDrafts(list) | Request::ListShares(list) => &mut list.project_path,
        _ => return Ok(()),
    };
    let Some(path) = slot.clone() else { return Ok(()) };
    let projects = crate::projects::read_projects().await.map_err(anyhow::Error::from)?;
    if let Some(origin) = origin {
        for project in &projects {
            if crate::git::origin(&project.path).await.as_deref() == Some(origin) {
                *slot = Some(project.path.clone());
                return Ok(());
            }
        }
    }
    if Path::new(&path).is_dir() {
        return Ok(());
    }
    let attached: Vec<_> = projects.iter().map(|p| p.path.as_str()).collect();
    bail!(
        "this machine has no checkout of {} — attach one in Dray, or pass --project with a path here. Its projects: {}",
        origin.unwrap_or(&path),
        if attached.is_empty() { "none".to_string() } else { attached.join(", ") }
    )
}

/// Reaching other machines, through this server's own links to them
/// ([`crate::machines`]) — never the app's, so it works with the window closed
/// and on a server that has no app at all.
#[cfg(any(feature = "serve", feature = "desktop"))]
mod elsewhere {
    use super::*;
    use crate::machines;
    use anyhow::anyhow;
    use serde_json::json;

    /// The machine holding session `id`, where one does. Every machine is
    /// asked at once, each given [`machines::SWEEP`].
    pub async fn locate(id: &str) -> Option<String> {
        let list: Vec<_> = machines::load().await.into_iter().filter(|m| !m.off).collect();
        let asks = list.iter().map(|m| async move {
            let row =
                tokio::time::timeout(machines::SWEEP, machines::call(m, "session_index_item", json!({ "sessionId": id })))
                    .await;
            matches!(row, Ok(Ok(ref row)) if !row.is_null()).then(|| m.id.clone())
        });
        futures_util::future::join_all(asks).await.into_iter().flatten().next()
    }

    /// Session `id`'s row on the machine holding it, with that machine's id and
    /// name. Asked the way [`locate`] asks.
    pub async fn session_row(id: &str) -> Option<((String, String), SessionIndexItem)> {
        let list: Vec<_> = machines::load().await.into_iter().filter(|m| !m.off).collect();
        let asks = list.iter().map(|m| async move {
            let row = tokio::time::timeout(
                machines::SWEEP,
                machines::call(m, "session_index_item", json!({ "sessionId": id })),
            )
            .await;
            let row: SessionIndexItem = serde_json::from_value(row.ok()?.ok()?).ok()?;
            Some(((m.id.clone(), m.name.clone()), row))
        });
        futures_util::future::join_all(asks).await.into_iter().flatten().next()
    }

    /// The open pull request on `branch` of `project` on machine `id`: number
    /// and URL, read through that machine's own `gh` and checkout.
    pub async fn open_pr(id: &str, project: &str, branch: &str) -> Result<Option<(u64, String)>> {
        let saved = machines::on(id).await.map_err(anyhow::Error::msg)?;
        let prs = machines::call(&saved, "prs_for_branch", json!({ "cwd": project, "branch": branch }))
            .await
            .map_err(|e| anyhow!("could not read pull requests on {}: {e}", saved.name))?;
        Ok(prs.as_array().into_iter().flatten().find_map(|pr| {
            (pr.get("state")?.as_str()? == "OPEN").then_some(())?;
            Some((pr.get("number")?.as_u64()?, pr.get("url")?.as_str()?.to_string()))
        }))
    }

    /// Runs a prepared request on `machine`, a name or an id, and marks every
    /// session it answers with as that machine's.
    pub async fn forward(machine: &str, forward: &Forward) -> Result<Response> {
        forward_to(&machines::on(machine).await.map_err(anyhow::Error::msg)?, forward).await
    }

    async fn forward_to(saved: &machines::Saved, forward: &Forward) -> Result<Response> {
        let answer = machines::call(&saved, "orchestrate", serde_json::to_value(forward)?).await.map_err(|e| {
            match e.starts_with("unknown command") {
                true => anyhow!("{}'s Dray server is too old to take dray requests — update it", saved.name),
                false => anyhow!(e),
            }
        })?;
        let mut response: Response = serde_json::from_value(answer)?;
        let rows: Vec<&mut SessionSummary> = match &mut response {
            Response::Created { session, .. } | Response::Session { session } => vec![session],
            Response::Listed { sessions } => sessions.iter_mut().collect(),
            _ => vec![],
        };
        for row in rows {
            row.machine = Some(saved.name.clone());
        }
        Ok(response)
    }

    /// `dray session set-aside` for a session on `machine`, a name or an id:
    /// written there, or held here when that machine does not answer (#1050).
    /// A machine turned off is held for too — turning it back on lands it.
    pub async fn set_aside(machine: &str, aside: SetAside, app: &Sink) -> Result<Response> {
        let saved = machines::find(&machines::load().await, machine).map_err(anyhow::Error::msg)?;
        // An older flag held here is superseded either way. Dropped first, and
        // behind any flush writing it, so this write lands after it.
        if crate::held_flags::unhold(&aside.session_id).await?.is_some() {
            crate::held_flags::announce(app, Vec::new()).await;
        }
        if !saved.off {
            let forward = prepare(Request::SetAside(aside.clone())).await?;
            match tokio::time::timeout(machines::SWEEP, forward_to(&saved, &forward)).await {
                Ok(Ok(response)) => return Ok(response),
                // A server too old for `orchestrate` still takes the flush's
                // `set_session_flags`, so it is held like any other.
                Ok(Err(e)) => eprintln!("[set aside] holding for {}: {e:#}", saved.name),
                Err(_) => eprintln!("[set aside] holding for {}: no answer", saved.name),
            }
        }
        let held = crate::held_flags::hold(&saved.id, &aside.session_id, aside.aside, None).await?;
        crate::held_flags::announce(app, Vec::new()).await;
        Ok(Response::Session {
            session: SessionSummary {
                session_id: held.session_id.clone(),
                title: held.session_id,
                cwd: String::new(),
                project_path: String::new(),
                branch: None,
                worktree_name: None,
                status: "idle".into(),
                modified: held.at,
                parent_session_id: None,
                hidden: false,
                machine: Some(saved.name),
                held: true,
            },
        })
    }

    /// Fills in what only this machine's index knows before a request leaves:
    /// the caller and sender carried whole, a session `--base` turned into the
    /// branch it names, and the project's `origin`.
    pub async fn prepare(mut request: Request) -> Result<Forward> {
        let mut forward = Forward::default();
        let mut project = None;
        match &mut request {
            Request::CreateSession(create) => {
                let parent = parent_of(create.parent_session_id.as_deref()).await?;
                forward.caller = caller(parent.as_ref()).await?;
                create.project_path = project_from(create.project_path.as_deref(), parent.as_ref());
                project = create.project_path.clone();
                create.base = branch_of(create.base.take(), project.as_deref()).await?;
            }
            Request::CreateDraft(create) => {
                let parent = parent_of(create.parent_session_id.as_deref()).await?;
                forward.caller = caller(parent.as_ref()).await?;
                create.project_path = project_from(create.project_path.as_deref(), parent.as_ref());
                project = create.project_path.clone();
                create.base = branch_of(create.base.take(), project.as_deref()).await?;
            }
            Request::StartDraft(start) => {
                forward.caller = caller(parent_of(start.parent_session_id.as_deref()).await?.as_ref()).await?;
            }
            Request::SendMessage(send) => {
                if let Some(from) = sender(send.from_session_id.as_deref()).await {
                    forward.sender = Some(MessageSender { machine: Some(this_machine().await), ..from });
                }
            }
            Request::ListSessions(list) | Request::ListDrafts(list) | Request::ListShares(list) => {
                list.project_path = match list.all {
                    true => None,
                    false => scope_of(list).await?,
                };
                project = list.project_path.clone();
                list.parent_session_id = None;
            }
            _ => {}
        }
        if let Some(path) = project {
            forward.origin = crate::git::origin(&path).await;
        }
        forward.line = encode_line(&Envelope::new(request))?.trim_end().to_string();
        Ok(forward)
    }

    async fn caller(parent: Option<&SessionIndexItem>) -> Result<Option<Caller>> {
        let Some(parent) = parent else { return Ok(None) };
        Ok(Some(Caller {
            session: parent.clone(),
            depth: depth_of(parent).await?,
            bot_tree: crate::bots::in_bot_tree(parent).await,
        }))
    }

    /// A `--base` naming a session here means its branch there, which the far
    /// side can only find if that branch was pushed. A ref passes as written.
    async fn branch_of(base: Option<String>, project: Option<&str>) -> Result<Option<String>> {
        match (base, project) {
            (Some(base), Some(project)) if store::get_session_index_item(&base).await?.is_some() => {
                Ok(Some(resolve_base(&base, project).await?))
            }
            (base, _) => Ok(base),
        }
    }

    /// The name a relayed sender gives this machine, which the far side may
    /// hold under a name of its own.
    async fn this_machine() -> String {
        tokio::task::spawn_blocking(dray_proto::machine_name).await.unwrap_or_else(|_| "another machine".into())
    }

    /// `session ls --machine all`: this machine's sessions, then each
    /// connected one's, every row naming where it runs.
    pub async fn list_everywhere(list: ListSessions) -> Result<Response> {
        let forward = prepare(Request::ListSessions(list.clone())).await?;
        let Response::Listed { mut sessions } = list_sessions(list).await? else {
            bail!("listing this machine's sessions answered something else");
        };
        let list: Vec<_> = machines::load().await.into_iter().filter(|m| !m.off).collect();
        let asks = list.iter().map(|m| tokio::time::timeout(machines::SWEEP, self::forward(&m.id, &forward)));
        // ponytail: a machine that fails to answer is skipped unsaid; give
        // `Listed` a warnings field if agents start missing rows.
        for answer in futures_util::future::join_all(asks).await {
            if let Ok(Ok(Response::Listed { sessions: theirs })) = answer {
                sessions.extend(theirs);
            }
        }
        Ok(Response::Listed { sessions })
    }
}

/// Answers a request here and nowhere else, for a caller already inside this
/// process: an MCP assistant's start, send and stop take the same path as
/// `dray session new`, `send` and `stop`. Never through [`route`], which
/// sends a session id this index lacks on to other machines under their own
/// tokens — an assistant is signed in to this server alone.
#[cfg(any(feature = "serve", feature = "desktop"))]
pub async fn answer_here(request: Request, app: &Sink) -> Response {
    if this_machine_only(&request) || matches!(request, Request::OnMachine(_)) {
        return Response::error("not an assistant's request");
    }
    dispatch(request, app).await.unwrap_or_else(|e| Response::error(format!("{e:#}")))
}

#[cfg(any(feature = "serve", feature = "desktop"))]
fn linked_org(org: crate::org_link::LinkedOrg, site: String) -> dray_proto::LinkedOrg {
    dray_proto::LinkedOrg { name: org.name, slug: org.slug, site }
}

#[cfg(any(feature = "serve", feature = "desktop"))]
fn assistants(list: Result<Vec<crate::mcp::AssistantSummary>, String>) -> Result<Response> {
    let assistants = list
        .map_err(anyhow::Error::msg)?
        .into_iter()
        .map(|a| dray_proto::AssistantSummary {
            id: a.id,
            name: a.name,
            access: serde_json::to_value(a.access).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
            created: a.created,
            last_used: a.last_used,
        })
        .collect();
    Ok(Response::Assistants { assistants })
}

async fn dispatch(request: Request, app: &Sink) -> Result<Response> {
    if !dray_proto::REMOTE_MCP
        && matches!(request, Request::PairAssistant(_) | Request::ListAssistants | Request::RevokeAssistant(_))
    {
        anyhow::bail!("Assistants are not available in this build yet.");
    }
    match request {
        Request::CreateSession(create) => create_session(create, None, app).await,
        Request::ListSessions(list) => list_sessions(list).await,
        Request::SendMessage(send) => send_message(send, None, app).await,
        Request::LinkIssues(link) => link_issues(link, app).await,
        Request::CreateDraft(create) => create_draft(create, None, app).await,
        Request::ListDrafts(list) => list_drafts(list).await,
        Request::RemoveDraft(draft) => remove_draft(&draft.id, app).await,
        Request::StartDraft(start) => start_draft(start, None, app).await,
        Request::AddVideo(video) => add_video(video).await,
        Request::MergeCard(card) => post_merge_card(card, app).await,
        Request::SetNeed(need) => {
            let text = Some(need.need.trim().to_string()).filter(|t| !t.is_empty());
            crate::store::set_session_need(&need.session_id, text)
                .await?
                .with_context(|| format!("no session {}", need.session_id))?;
            announce_change(std::slice::from_ref(&need.session_id), app).await;
            answer_session(&need.session_id).await
        }
        Request::Share(share) => share_port(share).await,
        Request::ListShares(list) => list_shares(list).await,
        Request::RenameSession(rename) => {
            crate::rename_session(rename.session_id.clone(), rename.title, app.clone()).await?;
            answer_session(&rename.session_id).await
        }
        Request::StopSession(stop) => {
            crate::interrupt_session(&stop.session_id, app.clone()).await?;
            answer_session(&stop.session_id).await
        }
        Request::SettleSession(settle) => settle_session(settle, app).await,
        Request::CreateBot(create) => {
            let avatar = bots::face(create.shape.as_deref(), create.hue)?;
            let bot = bots::create_bot(create.name, Some(avatar)).await?;
            app.emit(bots::BOTS_CHANGED, ()).ok();
            Ok(Response::Bot { bot: bots::summary(bot).await })
        }
        Request::ListBots => {
            let mut summaries = Vec::new();
            for bot in bots::list_bots().await? {
                summaries.push(bots::summary(bot).await);
            }
            Ok(Response::Bots { bots: summaries })
        }
        Request::RenameBot(rename) => {
            let bot = bots::rename_bot(&rename.bot, &rename.name, app).await?;
            app.emit(bots::BOTS_CHANGED, ()).ok();
            Ok(Response::Bot { bot: bots::summary(bot).await })
        }
        Request::RemoveBot(remove) => {
            let bot = bots::find_bot(&remove.bot).await?;
            let summary = bots::summary(bot.clone()).await;
            bots::delete_bot(bot.id, app.clone()).await?;
            app.emit(bots::BOTS_CHANGED, ()).ok();
            Ok(Response::Bot { bot: summary })
        }
        Request::SendToBot(send) => send_to_bot(send, app).await,
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::SetRemoteAccess(set) => {
            let now = crate::remote_access::set_remote_access(app.clone(), set.on).await.map_err(anyhow::Error::msg)?;
            Ok(Response::RemoteAccess { on: now.on })
        }
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::ShareMachines(share) => {
            let now = crate::machines::set_sharing(share.on).await.map_err(anyhow::Error::msg)?;
            let names = now["machines"].as_array().into_iter().flatten();
            let machines = names.filter_map(|m| m["name"].as_str().map(str::to_string)).collect();
            Ok(Response::MachinesShared { on: share.on, machines })
        }
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::PairAssistant(pair) => {
            let pairing = crate::mcp::pair(app.clone(), pair.read_only, None).await.map_err(anyhow::Error::msg)?;
            Ok(Response::AssistantPairing {
                url: pairing.url,
                code: pairing.code,
                expires_in_secs: pairing.expires_in_secs,
                read_only: pair.read_only,
            })
        }
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::ListAssistants => assistants(crate::mcp::assistants().await),
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::RevokeAssistant(revoke) => assistants(crate::mcp::revoke(app.clone(), revoke.id).await),
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::Login => {
            let pending = crate::org_link::start(app.clone()).await.map_err(anyhow::Error::msg)?;
            Ok(Response::LinkPending {
                url: pending.url,
                short_url: pending.short_url,
                code: pending.code,
                expires_in_secs: pending.expires_in_secs,
            })
        }
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::LinkStatus => {
            let state = crate::org_link::state(app).await;
            Ok(Response::LinkStatus {
                linked: state.linked.map(|l| linked_org(l.org, l.site)),
                pending: state.pending.is_some(),
                error: state.error,
            })
        }
        #[cfg(any(feature = "serve", feature = "desktop"))]
        Request::Logout => {
            let done = crate::org_link::unlink(app.clone()).await.map_err(anyhow::Error::msg)?;
            Ok(Response::Unlinked { org: linked_org(done.org, done.site), warning: done.warning })
        }
        Request::SetAside(aside) => {
            crate::set_session_flags(&aside.session_id, None, None, None, Some(aside.aside), app.clone()).await?;
            answer_session(&aside.session_id).await
        }
        mut on_screen => {
            // Resolved here, where the index lives, before the step goes to
            // the app's CEF or a headless Chromium.
            if let Request::Browser(step) = &mut on_screen {
                step.session_id = crate::bots::browser_owner(&step.session_id).await;
            }
            #[cfg(feature = "desktop")]
            if crate::is_server() {
                return ask_app(on_screen).await;
            }
            answer_on_screen(on_screen).await
        }
    }
}

/// The Mac's server hands the app what lives in it: browser steps while the
/// app runs Chromium, and the machine list while the app is open, since the
/// app holds that list in memory and rewrites the file whole. See
/// MAC-SERVER-PLAN.md.
#[cfg(feature = "desktop")]
async fn ask_app(request: Request) -> Result<Response> {
    let browser = match &request {
        Request::Browser(browser) => Some(browser.clone()),
        _ => None,
    };
    if let Some(browser) = browser.clone().filter(|_| !crate::serve::host_browser()) {
        return browse(browser).await;
    }
    match crate::serve::host_call("request", serde_json::to_value(&request)?).await {
        Some(Ok(answer)) => Ok(serde_json::from_value(answer)?),
        Some(Err(err)) => Ok(Response::error(err.as_str().map(str::to_string).unwrap_or_else(|| err.to_string()))),
        // No app, or it left between the two questions: the file is this
        // server's alone until the app opens again and reads it.
        None => answer_on_screen(request).await,
    }
}

/// What the Mac's server asks of the app it hosts, answered in the app.
#[cfg(feature = "desktop")]
pub async fn answer_host(cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(reply) = crate::transcription::answer_host(cmd, &args).await {
        return reply;
    }
    match cmd {
        "request" => {
            let request: Request = serde_json::from_value(args).map_err(|e| e.to_string())?;
            let response = answer_on_screen(request).await.unwrap_or_else(|e| Response::error(format!("{e:#}")));
            serde_json::to_value(response).map_err(|e| e.to_string())
        }
        "reload_servers" => {
            crate::servers::reload().await;
            Ok(serde_json::Value::Null)
        }
        "island_links" => serde_json::to_value(crate::servers::island_links()).map_err(|e| e.to_string()),
        // The island's Extend, on a timer only the app is reading.
        "extend_boat" => {
            let id = args["id"].as_str().ok_or("extend_boat wants an id")?.to_string();
            let minutes = args["minutes"].as_u64().ok_or("extend_boat wants minutes")? as u32;
            crate::servers::extend_boat(id, minutes).await.map(|()| serde_json::Value::Null)
        }
        "show_session" => {
            let id = args["sessionId"].as_str().ok_or("show_session wants a sessionId")?;
            let app = crate::transcription::app().ok_or("Dray is not ready yet.")?;
            crate::notifications::activate(app, id);
            Ok(serde_json::Value::Null)
        }
        // Only while the window has focus: the island opens on Dray's pick when
        // tapped over Dray, and asking here rather than by bundle id there also
        // covers `tauri dev`, whose bare binary has none.
        "selected_session" => {
            use tauri::Manager;
            let app = crate::transcription::app().ok_or("Dray is not ready yet.")?;
            let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            Ok(serde_json::json!(focused.then(crate::apps::app_selection).flatten()))
        }
        "close_session" => {
            #[cfg(all(feature = "cef", any(target_os = "macos", target_os = "linux")))]
            if let Some(id) = args["sessionId"].as_str() {
                crate::cef::close_session(id);
            }
            Ok(serde_json::Value::Null)
        }
        _ => Err(format!("the app does not answer {cmd}")),
    }
}

/// Requests answered where the screen is: the browser, and the machine list —
/// the app's own in the app, else this server's file.
async fn answer_on_screen(request: Request) -> Result<Response> {
    match request {
        Request::Browser(browser) => browse(browser).await,
        #[cfg(feature = "desktop")]
        list if !crate::is_server() => server_list::answer(list).await,
        #[cfg(any(feature = "serve", feature = "desktop"))]
        list => machine_list(list).await,
        #[cfg(not(any(feature = "serve", feature = "desktop")))]
        other => bail!("{other:?} is not answered here"),
    }
}

/// `dray machine` on a server with no app to ask: a Linux `dray-serve`, a
/// headless Mac, the Mac's own server while the window is closed.
#[cfg(any(feature = "serve", feature = "desktop"))]
async fn machine_list(request: Request) -> Result<Response> {
    use crate::machines;
    let summarize = |row: machines::Row| dray_proto::ServerSummary {
        address: row.saved.address(),
        id: row.saved.id,
        name: row.saved.name,
        status: row.status.into(),
        error: row.error,
    };
    let row = match request {
        Request::ListServers => {
            return Ok(Response::Servers { servers: machines::list().await.into_iter().map(summarize).collect() });
        }
        Request::AddServer(add) => machines::add(add.name, add.address, add.token).await,
        Request::RemoveServer(server) => machines::remove(&server.name).await,
        Request::RenameServer(rename) => machines::rename(&rename.name, &rename.new_name).await,
        Request::SetServerOn(set) => machines::set_on(&set.name, set.on).await,
        other => bail!("{other:?} is not answered here"),
    };
    Ok(Response::Server { server: summarize(row.map_err(anyhow::Error::msg)?) })
}

/// `dray machine`, through Settings → Servers' own commands, so the CLI is
/// refused exactly where the Add dialog would be and the page hears the same
/// `servers_changed`.
#[cfg(feature = "desktop")]
mod server_list {
    use crate::servers::{self, ServerInfo, ServerStatus};
    use anyhow::{bail, Context, Result};
    use dray_proto::{AddServer, Request, Response, ServerSummary};

    pub async fn answer(request: Request) -> Result<Response> {
        match request {
            Request::AddServer(add) => self::add(add).await,
            Request::ListServers => Ok(Response::Servers { servers: servers::list_servers().into_iter().map(summarize).collect() }),
            Request::RemoveServer(server) => remove(&server.name).await,
            Request::RenameServer(rename) => self::rename(rename).await,
            Request::SetServerOn(set) => set_on(set).await,
            other => bail!("{other:?} is not answered here"),
        }
    }

    async fn add(add: AddServer) -> Result<Response> {
        let name = Some(add.name);
        let added = match add.token {
            Some(token) => servers::add_server(add.address, token, name, None).await.map_err(anyhow::Error::msg)?,
            None => {
                // The whole login, port and user included: `[box]:2222` is the
                // key the add needs trusted, not `box`'s.
                let login = crate::ssh::parse(&add.address).map(|t| t.line()).unwrap_or_else(|_| add.address.clone());
                servers::add_ssh_server(add.address, name, None)
                    .await
                    .map_err(|f| anyhow::anyhow!(crate::machines::explain(f, &login)))?
            }
        };
        Ok(Response::Server { server: summarize(added) })
    }

    /// By name, or by id where two servers share one. An id wins outright, or
    /// a server renamed to another's id would make the cure ambiguous too.
    fn find(name: &str) -> Result<ServerInfo> {
        let list = servers::list_servers();
        if let Some(server) = list.iter().find(|s| s.id == name) {
            return Ok(server.clone());
        }
        let mut matches: Vec<_> = list.into_iter().filter(|s| s.name == name).collect();
        match matches.len() {
            0 => bail!("no server named {name}"),
            1 => Ok(matches.remove(0)),
            n => bail!(
                "{n} servers are named {name} — name one by id: {}",
                matches.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")
            ),
        }
    }

    fn current(id: &str) -> Result<ServerInfo> {
        servers::list_servers().into_iter().find(|s| s.id == id).context("the server was removed meanwhile")
    }

    /// Takes the token with it.
    async fn remove(name: &str) -> Result<Response> {
        let server = find(name)?;
        servers::remove_server(server.id.clone()).await.map_err(anyhow::Error::msg)?;
        Ok(Response::Server { server: summarize(server) })
    }

    async fn rename(rename: dray_proto::RenameServer) -> Result<Response> {
        let id = find(&rename.name)?.id;
        servers::rename_server(id.clone(), rename.new_name).await.map_err(anyhow::Error::msg)?;
        Ok(Response::Server { server: summarize(current(&id)?) })
    }

    /// On waits for the attempt to settle, so `dray machine connect` answers
    /// whether it connected rather than "connecting". A whole SSH connect is
    /// capped at 45s; past that the answer is the row as it stands.
    async fn set_on(set: dray_proto::SetServerOn) -> Result<Response> {
        let id = find(&set.name)?.id;
        servers::set_server_on(id.clone(), set.on).await.map_err(anyhow::Error::msg)?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(50);
        while set.on && current(&id)?.status == ServerStatus::Connecting && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        Ok(Response::Server { server: summarize(current(&id)?) })
    }

    fn summarize(server: ServerInfo) -> ServerSummary {
        let status = match server.on {
            true => serde_json::to_value(server.status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
            false => "off".to_string(),
        };
        ServerSummary { id: server.id, name: server.name, address: server.ssh.unwrap_or(server.url), status, error: server.error }
    }
}

/// `dray share`: a public link to one of the session's dev servers, made on
/// this machine. Every verb answers the session's links after it.
async fn share_port(request: dray_proto::ShareRequest) -> Result<Response> {
    use dray_proto::ShareAction;
    let session = request.session_id;
    let done = match request.action {
        ShareAction::Start { port } => crate::share::start(&session, port, "cli").await.map(drop),
        ShareAction::Stop { port } => Ok(crate::share::stop(&session, port)),
        ShareAction::List => Ok(()),
    };
    Ok(match done {
        Ok(()) => Response::Shared { shares: crate::share::list(Some(&session)) },
        Err(message) => Response::error(message),
    })
}

/// `dray share ls`: links in the caller's project, or every one with `--all`.
async fn list_shares(list: ListSessions) -> Result<Response> {
    let scope = scope_of(&list).await?;
    let items = store::list_session_index_items(false).await?;
    let shares = crate::share::list(None)
        .into_iter()
        .filter(|s| {
            scope.as_deref().is_none_or(|p| {
                items.iter().any(|i| i.session_id == s.session_id && i.project_path == p)
            })
        })
        .collect();
    Ok(Response::Shared { shares })
}

/// Settles or unsettles through the sidebar's own command, which also stops
/// a settled session's processes and carries its hidden children along.
async fn settle_session(settle: dray_proto::SettleSession, app: &Sink) -> Result<Response> {
    let id = settle.session_id.as_str();
    let item = store::get_session_index_item(id).await?.with_context(|| format!("no session {id}"))?;
    if settle.settled && manager().turn_in_flight(id).await {
        bail!("session {id} is mid-turn — settle it once the turn finishes, or stop it first");
    }
    if settle.settled && settle.delete_worktree && item.worktree_name.is_none() {
        bail!("session {id} has no worktree of its own to delete");
    }
    crate::set_session_flags(id, Some(settle.settled), None, None, None, app.clone()).await?;
    if settle.settled && settle.delete_worktree {
        let removed = manager().remove_worktree(id).await;
        // Removal moves `cwd` out of each tree, hidden children's first, so even
        // a refusal partway has entries past what the settle announced.
        let mut moved = vec![id.to_string()];
        moved.extend(store::hidden_descendants(id).await?);
        announce_change(&moved, app).await;
        removed.context("settled, but the worktree was not deleted")?;
    }
    answer_session(id).await
}

/// Index entries changed from here, re-read and handed to the sidebar, which
/// otherwise only learns of a change it made itself.
pub(crate) async fn announce_change(ids: &[String], app: &Sink) {
    for id in ids {
        if let Ok(Some(item)) = store::get_session_index_item(id).await {
            app.emit(SESSION_CHANGED, &item).ok();
        }
    }
}

async fn answer_session(id: &str) -> Result<Response> {
    let item = store::get_session_index_item(id).await?.with_context(|| format!("no session {id}"))?;
    Ok(Response::Session { session: summarize(item) })
}

/// One `dray browser` step: CEF's tabs in the Mac app, a headless Chromium
/// in a server or an app built without CEF.
async fn browse(request: dray_proto::BrowserRequest) -> Result<Response> {
    let answered = |answer: Result<_, String>| match answer {
        Ok((output, data)) => Response::Browser { output, data },
        Err(message) => Response::error(message),
    };
    #[cfg(all(feature = "cef", any(target_os = "macos", target_os = "linux")))]
    if !crate::is_server() {
        return Ok(answered(crate::cef::automation::run(&request.session_id, request.action).await));
    }
    Ok(answered(crate::headless::automation::run(&request.session_id, request.action).await))
}

/// Files a video for a session's chat. The folder is worked out here because
/// only the server knows its home, and it is the one the session's delete sweeps.
async fn add_video(request: dray_proto::AddVideo) -> Result<Response> {
    let dray_proto::AddVideo { session_id, path, name } = request;
    store::get_session_index_item(&session_id).await?.with_context(|| format!("no session {session_id}"))?;
    let dir = store::get_home_app_dir().await?.join("browser/recordings").join(&session_id);
    let filed = tokio::task::spawn_blocking(move || {
        crate::recording::add(Path::new(&path), &dir, name.as_deref())
    })
    .await?;
    Ok(match filed {
        Ok(path) => Response::Video { path: path.to_string_lossy().into_owned() },
        Err(message) => Response::error(message),
    })
}

/// Posts a merge card for a task's open pull request into the calling chat.
/// The PR is looked up now, so an agent posting too early is told so rather
/// than leaving a card with nothing to merge.
async fn post_merge_card(card: dray_proto::MergeCard, app: &Sink) -> Result<Response> {
    let chat = store::get_session_index_item(&card.session_id)
        .await?
        .with_context(|| format!("no session {}", card.session_id))?;
    let task_id = &card.task_session_id;
    let task = CardTask::find(task_id).await?.with_context(|| format!("no session {task_id}"))?;
    let branch = task.branch().await.with_context(|| format!("session {task_id} has no branch"))?;
    let (number, url) = task.open_pr(&branch).await?;
    let title = task.row.title.clone();
    let payload = task.card(branch, number, url.clone());
    let _held = POSTING_CARD.lock().await;
    manager().post_event(&card.session_id, chat.harness, payload, app).await?;
    Ok(Response::MergeCard { number, url, title })
}

/// Held over every merge card's post, by hand or automatic, so the automatic
/// one's check of the log and its append cannot straddle another post.
static POSTING_CARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The task a merge card names: its row, and the machine holding it (id, name)
/// where that is not this one — a bot's task run in a sandbox of its own.
struct CardTask {
    row: SessionIndexItem,
    machine: Option<(String, String)>,
}

impl CardTask {
    /// Here first; a miss asks every machine this server reaches.
    async fn find(id: &str) -> Result<Option<Self>> {
        if let Some(row) = store::get_session_index_item(id).await? {
            return Ok(Some(Self { row, machine: None }));
        }
        #[cfg(any(feature = "serve", feature = "desktop"))]
        if let Some((machine, row)) = elsewhere::session_row(id).await {
            return Ok(Some(Self { row, machine: Some(machine) }));
        }
        Ok(None)
    }

    /// The frontend's `sessionBranch`: git's own HEAD while a tree here exists,
    /// since an agent may have pushed from a branch it named itself.
    async fn branch(&self) -> Option<String> {
        let row = &self.row;
        let observed = match self.machine.is_none() && !row.worktree_removed {
            true => crate::git::current_branch(&row.cwd).await,
            false => None,
        };
        observed.or_else(|| row.worktree_name.as_deref().map(crate::git::worktree_branch)).or(row.branch.clone())
    }

    /// The open pull request on `branch`, read where the task's checkout is.
    async fn open_pr(&self, branch: &str) -> Result<(u64, String)> {
        let open = match &self.machine {
            None => crate::github::prs_for_branch(self.row.project_path.clone(), branch.to_string())
                .await
                .map_err(|e| anyhow::anyhow!("could not read pull requests: {e:?}"))?
                .into_iter()
                .find(|pr| pr.state == "OPEN")
                .map(|pr| (pr.number, pr.url)),
            #[cfg(any(feature = "serve", feature = "desktop"))]
            Some((id, _)) => elsewhere::open_pr(id, &self.row.project_path, branch).await?,
            #[cfg(not(any(feature = "serve", feature = "desktop")))]
            Some(_) => None,
        };
        open.with_context(|| format!("no open pull request on {branch}; open one first"))
    }

    fn card(self, branch: String, number: u64, url: String) -> crate::events::AgentEventPayload {
        let repo = self.machine.as_ref().and_then(|_| crate::github::slug_from_pr_url(&url));
        crate::events::AgentEventPayload::MergeCard {
            task_id: self.row.session_id,
            title: self.row.title,
            project_path: self.row.project_path,
            branch,
            number,
            url,
            machine: self.machine.map(|(_, name)| name),
            repo,
        }
    }
}

/// The chat a merge card goes in for a task `parent` started, as its sessions
/// oldest first: the card is posted in the last, and a card in any of them
/// counts. A normal task's is `parent` itself. A bot's task goes to the bot's
/// chat, since Start fresh settles the session that started it, and an agent
/// switch leaves earlier sessions on screen in the same conversation. Empty
/// where there is none.
async fn card_chat(parent: SessionIndexItem) -> Result<Vec<SessionIndexItem>> {
    Ok(match bots::bot_at(&parent.cwd).await {
        Some(bot) => bots::chat_sessions(&bot.path).await?,
        None if parent.archived => Vec::new(),
        None => vec![parent],
    })
}

/// Posts a merge card for task `task_id`'s pull request in the chat that its
/// parent `session_id` belongs to, once the app judges the PR ready, unless
/// that chat already holds a card for it — one the agent posted by hand
/// counts. Answers the chat the card is in, or `None` where there is no chat
/// to post in yet, which the caller asks again about.
///
/// Called on the parent's server, so a task on another machine finds its chat
/// here; the task itself is looked up here or on the machines this server
/// reaches. The PR comes from the app's own marks read, so no `gh` runs. The
/// log is the record of what was posted, so a restart or a second client
/// never posts twice.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn auto_merge_card(
    session_id: String,
    task_id: String,
    number: u64,
    url: String,
    branch: String,
    sink: Sink,
) -> Result<Option<String>, crate::Fail> {
    let _held = POSTING_CARD.lock().await;

    let Some(parent) = store::get_session_index_item(&session_id).await? else {
        return Ok(None);
    };
    let sessions = card_chat(parent).await?;
    let Some(chat) = sessions.last() else {
        return Ok(None);
    };
    for session in &sessions {
        let events = store::list_session_events(&session.session_id).await?;
        if events.iter().any(|e| matches!(&e.payload, crate::events::AgentEventPayload::MergeCard { url: u, .. } if *u == url)) {
            return Ok(Some(chat.session_id.clone()));
        }
    }
    let Some(task) = CardTask::find(&task_id).await? else {
        return Ok(None);
    };
    if task.row.archived {
        return Ok(None);
    }
    manager().post_event(&chat.session_id, chat.harness, task.card(branch, number, url), &sink).await?;
    Ok(Some(chat.session_id.clone()))
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
async fn link_issues(link: LinkIssues, app: &Sink) -> Result<Response> {
    if link.issues.is_empty() {
        bail!("name at least one issue, like DRA-53");
    }

    // An unknown session is answered before anything is written, so a typo in
    // the id cannot half-apply a list.
    store::get_session_index_item(&link.session_id)
        .await?
        .with_context(|| format!("no session {}", link.session_id))?;

    let mut linked = Vec::new();
    let mut applied = 0usize;
    let mut failure = None;
    for input in &link.issues {
        match apply_issue(&link, input).await {
            Ok(list) => {
                linked = list;
                applied += 1;
            }
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }

    // Announced before the failure is returned, since each issue is its own
    // index write: one that landed is on the session whatever the next one
    // did, and leaving it unannounced is the very staleness this event exists
    // to remove. `linked` is the whole list as of the last write that worked,
    // so it needs no assembling — but it is only *news* if something wrote,
    // and an empty list is real news when the last link was the one removed.
    if applied > 0 {
        app.emit(
            ISSUES_CHANGED,
            &IssuesChangedEvent { session_id: link.session_id.clone(), issues: linked.clone() },
        )
        .ok();
    }

    if let Some(e) = failure {
        return Err(e);
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

/// One issue applied to one session, answering the session's whole list.
///
/// Split out of [`link_issues`] so the loop there can keep hold of a failure
/// instead of returning through it — the writes before it have already landed.
async fn apply_issue(link: &LinkIssues, input: &IssueInput) -> Result<Vec<IssueRef>> {
    let identifier = issues::parse_identifier(&input.identifier)
        .with_context(|| format!("{} is not an issue identifier", input.identifier))?;

    if link.unlink {
        store::unlink_session_issue(&link.session_id, &identifier).await
    } else {
        store::link_session_issue(
            &link.session_id,
            IssueRef {
                // By shape: `dray issue link` asks the tracker nothing, so
                // the identifier is the only thing that can say which one
                // this belongs to — `owner/repo#12` is GitHub's.
                tracker: IssueTracker::of(&identifier),
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
        .await
    }
}

async fn create_session(create: CreateSession, caller: Option<&Caller>, app: &Sink) -> Result<Response> {
    if create.prompt.trim().is_empty() {
        bail!("a session needs a prompt");
    }

    let calling = calling(create.parent_session_id.as_deref(), caller).await?;
    check_depth(calling.as_ref().map(|c| c.1))?;
    let parent = calling.map(|c| c.0);

    // A hidden session surfaces only as cards beside its parent, so one
    // made from a terminal would be listed nowhere at all.
    if create.hidden && parent.is_none() {
        bail!("--hidden needs a calling session: a hidden session shows only beside its parent");
    }

    // Everything under a bot runs hidden: the bot is the one place its work is
    // run from, and each child reports back to it on its own.
    let in_bot_tree = match parent.as_ref() {
        Some(p) => crate::bots::in_bot_tree(p).await,
        None => false,
    };
    let hidden = create.hidden || in_bot_tree;

    let project_path = resolve_project(&create, parent.as_ref())?;
    // A bot's folder is its own notes, not a project to work in. Its history
    // makes it a repository, so a task there would start in a worktree of it.
    if crate::bots::bot_holding(&project_path).await.is_some() {
        bail!("a bot's folder is not a project — pass --project <repo path>");
    }

    // The project is deliberately *not* attached here. The sidebar's filter
    // defaults to null and lists every session whatever its project, so a
    // session under an unattached repo is already reachable — while
    // `add_project` bumps `last_selected` and resorts the list, which would
    // let an agent's call quietly reorder the user's project picker.
    let harness = resolve_harness(create.harness.as_deref(), parent.as_ref())?;
    let model = resolve_model(create.model.as_deref(), parent.as_ref(), harness).await?;

    let effort = resolve_effort(create.effort.as_deref(), parent.as_ref(), harness)?;
    let permission_mode = parent
        .as_ref()
        .map(|p| p.permission_mode)
        .unwrap_or_else(ApprovalPolicy::default);
    let fast = resolve_fast(create.fast, parent.as_ref(), harness);

    // Resolved before anything is written, so a `--base` naming a session or a
    // ref that cannot be found costs an error rather than a session sitting in
    // the sidebar on the wrong base.
    let base_ref = match create.base.as_deref() {
        Some(from) => Some(resolve_base(from, &project_path).await?),
        None => None,
    };

    let session_id = uuid::Uuid::now_v7().to_string();
    // Before the spawn, which reads it for the task's own prompt.
    if caller.is_some_and(|c| c.bot_tree) {
        crate::remote_reports::owe(&session_id).await?;
    }
    let manager = manager();

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
            fast,
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
            hidden,
            create.title.as_deref(),
            // The creating session is this one's *parent*, which the sidebar
            // already draws by nesting the row. Its opening prompt is the brief,
            // not a message relayed into a conversation already under way.
            None,
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

/// Saves a task for later with the picks `dray new` would have given it, and
/// always with a worktree: an agent that leaves work for the reader has no
/// standing to put it in the reader's own checkout.
async fn create_draft(create: CreateDraft, caller: Option<&Caller>, app: &Sink) -> Result<Response> {
    if create.prompt.trim().is_empty() {
        bail!("a draft needs a prompt");
    }
    let parent = calling(create.parent_session_id.as_deref(), caller).await?.map(|c| c.0);
    let project_path = project_from(create.project_path.as_deref(), parent.as_ref())
        .context("no project — run this inside a git repo or pass --project")?;
    let harness = resolve_harness(create.harness.as_deref(), parent.as_ref())?;
    // Checked now so a typo fails here rather than when the reader starts it;
    // stored as written, and resolved again at the start.
    if let Some(base) = create.base.as_deref() {
        resolve_base(base, &project_path).await?;
    }
    let draft = StoredDraft {
        id: uuid::Uuid::now_v7().to_string(),
        prompt: create.prompt,
        project_path,
        harness,
        model: resolve_model(create.model.as_deref(), parent.as_ref(), harness).await?,
        effort: resolve_effort(create.effort.as_deref(), parent.as_ref(), harness)?,
        permission_mode: parent.as_ref().map(|p| p.permission_mode).unwrap_or_default(),
        fast: resolve_fast(create.fast, parent.as_ref(), harness),
        use_worktree: true,
        base: create.base,
        created: crate::events::now_rfc3339(),
    };
    drafts::save_draft(serde_json::to_value(&draft)?).await?;
    app.emit(DRAFTS_CHANGED, ()).ok();
    Ok(Response::Draft { draft: summarize_draft(draft) })
}

/// Drafts in the caller's project, or every one with `--all`, newest first.
async fn list_drafts(list: ListSessions) -> Result<Response> {
    let scope = scope_of(&list).await?;
    let mut drafts: Vec<_> = drafts::stored()
        .await?
        .into_iter()
        .filter(|d| scope.as_deref().is_none_or(|p| d.project_path == p))
        .collect();
    drafts.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(Response::Drafts { drafts: drafts.into_iter().map(summarize_draft).collect() })
}

/// The project a listing is narrowed to, or `None` for `--all`.
async fn scope_of(list: &ListSessions) -> Result<Option<String>> {
    if list.all {
        return Ok(None);
    }
    let parent = parent_of(list.parent_session_id.as_deref()).await?;
    Ok(project_from(list.project_path.as_deref(), parent.as_ref()))
}

/// Read before it is taken, so a draft this build cannot spell is refused
/// rather than deleted unseen.
async fn remove_draft(id: &str, app: &Sink) -> Result<Response> {
    let draft = find_draft(id).await?;
    drafts::take(id).await?.with_context(|| format!("no draft {id}"))?;
    app.emit(DRAFTS_CHANGED, ()).ok();
    Ok(Response::Draft { draft: summarize_draft(draft) })
}

async fn find_draft(id: &str) -> Result<StoredDraft> {
    drafts::stored()
        .await?
        .into_iter()
        .find(|d| d.id == id)
        .with_context(|| format!("no draft {id}"))
}

/// Starts a draft as a session nested under the caller. The draft is taken off
/// the list first, so two starts racing make one session, and put back if the
/// start fails.
///
/// The worktree is the draft's own pick: off only where a person saved it so in
/// the app, which is the one way an agent can start work in the main checkout.
async fn start_draft(start: StartDraft, caller: Option<&Caller>, app: &Sink) -> Result<Response> {
    let draft = find_draft(&start.id).await?;
    check_depth(calling(start.parent_session_id.as_deref(), caller).await?.map(|c| c.1))?;
    let held = drafts::take(&draft.id)
        .await?
        .with_context(|| format!("no draft {}", draft.id))?;
    app.emit(DRAFTS_CHANGED, ()).ok();
    let started = start_session(&draft, start.parent_session_id.as_deref(), app).await;
    let Err(error) = started else { return started };
    // The prompt rides the error where the draft cannot go back, so the task
    // survives in the caller's output even with the file unwritable.
    if let Err(lost) = drafts::restore(held).await {
        bail!(
            "{error:#}, and the draft could not be put back ({lost:#}). It read:\n{}",
            draft.prompt
        );
    }
    app.emit(DRAFTS_CHANGED, ()).ok();
    Err(error)
}

async fn start_session(
    draft: &StoredDraft,
    parent: Option<&str>,
    app: &Sink,
) -> Result<Response> {
    // Read again at the start rather than trusted from the save: the branch a
    // session id names, or the ref itself, may have moved or gone since.
    let base_ref = match draft.base.as_deref() {
        Some(base) => Some(resolve_base(base, &draft.project_path).await?),
        None => None,
    };
    let session_id = uuid::Uuid::now_v7().to_string();
    let outcome = manager()
        .send_msg(
            &session_id,
            &draft.prompt,
            &[],
            &[],
            draft.harness,
            draft.model.clone(),
            draft.effort,
            draft.permission_mode,
            draft.fast,
            &draft.project_path,
            None,
            draft.use_worktree,
            None,
            base_ref.as_deref(),
            true,
            parent,
            false,
            None,
            None,
            None,
            app,
        )
        .await?;
    let item = outcome
        .snapshot
        .map(|s| s.index_item)
        .context("the session was created but returned no index entry")?;

    app.emit(SESSION_CREATED, &item).ok();
    Ok(Response::Created { session: summarize(item), base_ref })
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
pub(crate) async fn resolve_base(from: &str, project_path: &str) -> Result<String> {
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
    let items = store::list_session_index_items(false).await?;

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

/// Refuses a create from a caller already [`MAX_DEPTH`] deep.
fn check_depth(depth: Option<usize>) -> Result<()> {
    let Some(depth) = depth else { return Ok(()) };
    if depth >= MAX_DEPTH {
        bail!(
            "this session is {depth} levels deep already — a spawned session may create \
             sessions, but those may not create more. Ask the user to start the next \
             batch from a top-level session."
        );
    }
    Ok(())
}

/// How many creates deep this session already sits, up to [`MAX_DEPTH`]. A
/// session with no parent is depth 0, one created by an agent is depth 1.
///
/// The walk stops at the cap rather than counting on: anything past it is
/// refused whatever the number, and stopping is what keeps an index that
/// somehow points at itself from hanging the caller's turn.
async fn depth_of(item: &SessionIndexItem) -> Result<usize> {
    let mut depth = 0;
    let mut cursor = item.parent_session_id.clone();

    while let Some(id) = cursor {
        depth += 1;
        if depth >= MAX_DEPTH {
            break;
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
///
/// Codex answers both halves itself, since its list is the machine's: an alias
/// it reports resolves even where this build's table has never heard of it, and
/// the default is the list's first row rather than a model named here that the
/// *installed* Codex may not have.
async fn resolve_model(
    requested: Option<&str>,
    parent: Option<&SessionIndexItem>,
    harness: Harness,
) -> Result<ModelId> {
    if let Some(alias) = requested {
        let found = match harness {
            Harness::Codex => crate::harness::codex::models::id_for_arg(alias).await,
            _ => id_for_arg(alias, harness),
        };

        return found.with_context(|| {
            let known: Vec<_> = models_for(harness).into_iter().map(|m| m.arg).collect();
            format!("unknown model {alias:?} — try {}", known.join(", "))
        });
    }

    if let Some(inherited) = parent.map(|p| p.model.clone()).filter(|id| runs_on(id, harness)) {
        return Ok(inherited);
    }

    Ok(match harness {
        Harness::Codex => crate::harness::codex::models::default_model().await,
        // `None` is pi's answer and means "pass no `--model`": pi is
        // multi-provider, so any constant named here might not exist on the
        // machine, and its own settings already say which model the reader
        // wants. The unset sentinel is what carries that through the index.
        _ => default_model_for(harness).unwrap_or_default(),
    })
}

/// The caller's level if it gave one, else the parent's, else `None` — which
/// `send_msg` resolves to the model's own default through
/// [`models::resolve_effort`], the same call that drops an effort a model has
/// no levels for.
///
/// Inheritance is filtered by harness for [`resolve_model`]'s reason, one step
/// further on: the two ladders share their names but not their scale. Codex
/// reasons at every level and starts at Medium, where Claude's models start at
/// High — so a Claude parent's `high` carried onto Codex sets a level nobody
/// picked, and does it silently, since Codex accepts the flag.
fn resolve_effort(
    requested: Option<&str>,
    parent: Option<&SessionIndexItem>,
    harness: Harness,
) -> Result<Option<Effort>> {
    if let Some(alias) = requested {
        return Ok(Some(Effort::from_arg(alias).with_context(|| {
            format!("unknown effort {alias:?} — try low, medium, high, xhigh, max or ultra")
        })?));
    }

    Ok(parent.filter(|p| p.harness == harness).and_then(|p| p.effort))
}

/// The new session's fast mode: the flag if given, else the parent's, else off.
///
/// Inherited **within one harness only**, the boundary `model` and `effort`
/// already stop at. Their reason is that the two ladders share every name while
/// meaning different things; this one's is plainer — a `true` carried from a
/// Claude parent onto a Codex child turns on a paid tier on another vendor's
/// account, which is more than "run this one like me" can be read to ask for.
fn resolve_fast(requested: Option<bool>, parent: Option<&SessionIndexItem>, harness: Harness) -> bool {
    requested.unwrap_or_else(|| parent.is_some_and(|p| p.harness == harness && p.fast))
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
/// `carried` is the sender a forwarding Mac looked up, which this index cannot.
async fn send_message(send: SendMessage, carried: Option<MessageSender>, app: &Sink) -> Result<Response> {
    if send.prompt.trim().is_empty() {
        bail!("a message needs some text");
    }

    let target = store::get_session_index_item(&send.session_id)
        .await?
        .with_context(|| format!("no session {}", send.session_id))?;
    let target = crate::bots::current_chat(target).await;

    if target.session_id == send.from_session_id.clone().unwrap_or_default() {
        bail!("a session cannot send a message to itself");
    }

    let from = match carried {
        Some(from) => Some(from),
        None => sender(send.from_session_id.as_deref()).await,
    };
    let prompt = attribute(&send.prompt, from.as_ref());

    let manager = manager();
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
            // The target's own, like everything beside it: a relayed message
            // must not move the session it arrives at onto another tier.
            target.fast,
            &target.cwd,
            None,
            false,
            None,
            None,
            false,
            None,
            false,
            None,
            from,
            None,
            app,
        )
        .await?;

    Ok(Response::Sent {
        queued: outcome.queued.is_some(),
    })
}

/// `dray bot send`: a message into a bot's chat, by the bot's name.
///
/// Nothing reports back, unlike a task's turns: the bot answers, if it wants
/// to, with a send of its own. A bot nobody has written to yet has no chat, so
/// the message opens one, on the agent its last chat ran — else the sender's.
async fn send_to_bot(send: SendToBot, app: &Sink) -> Result<Response> {
    if send.prompt.trim().is_empty() {
        bail!("a message needs some text");
    }
    let bot = bots::find_bot(&send.bot).await?;
    let from = sender(send.from_session_id.as_deref()).await;
    if from.as_ref().is_some_and(|f| f.bot_id.as_deref() == Some(&bot.id)) {
        bail!("a bot cannot message itself");
    }
    // Held from the lookup until a new chat is on the index, or two first
    // messages would each start an agent in the one folder.
    let lock = bots::first_chat_lock(&bot.id);
    let first = lock.lock().await;
    // Deleted while this waited: its folder is gone, and a chat started there
    // would outlive the bot.
    if !bots::list_bots().await?.iter().any(|b| b.id == bot.id) {
        bail!("bot {:?} was just deleted", bot.name);
    }
    if let Some(chat) = bots::chat_of(&bot).await {
        drop(first);
        let send = SendMessage { session_id: chat.session_id, prompt: send.prompt, from_session_id: send.from_session_id };
        let queued = matches!(send_message(send, None, app).await?, Response::Sent { queued: true });
        return Ok(Response::BotSent { bot: bots::summary(bot).await, queued });
    }

    let calling = match send.from_session_id.as_deref() {
        Some(id) => store::get_session_index_item(id).await?,
        None => None,
    };
    let own = bots::last_session_of(&bot).await;
    let like = own.clone().or(calling);
    let harness = like.as_ref().map_or(Harness::ClaudeCode, |l| l.harness);
    let model = resolve_model(None, like.as_ref(), harness).await?;
    let effort = resolve_effort(None, like.as_ref(), harness)?;
    // The bot's own stance, never the sender's: a bot chat runs on Auto and
    // its toolbar has no picker, so a Plan or bypass sender would leave it
    // on a stance nobody could see.
    let permission_mode = own.map_or(ApprovalPolicy::Auto, |o| o.permission_mode);
    let fast = resolve_fast(None, like.as_ref(), harness);
    let prompt = attribute(&send.prompt, from.as_ref());
    let session_id = uuid::Uuid::now_v7().to_string();
    let outcome = manager()
        .send_msg(
            &session_id, &prompt, &[], &[], harness, model, effort, permission_mode, fast, &bot.path, None, false,
            None, None, true, None, false, Some(&bot.name), from, None, app,
        )
        .await?;
    let item = outcome.snapshot.map(|s| s.index_item).context("the bot's chat started but returned no index entry")?;
    app.emit(SESSION_CREATED, &item).ok();
    Ok(Response::BotSent { bot: bots::summary(bot).await, queued: false })
}

/// How much of a task's last message a stall nudge carries; the tail, where an
/// agent puts its question.
const NUDGE_TAIL: usize = 4000;

/// Wakes the bot a stalled task belongs to, once per stall, as the app judges
/// it (`stalledTasks`). Sent from the task, the way its reports are, so the
/// bot's queue view and transcript treat it as one and the reader never sees
/// it. `problem` is what stands in the bot's way to fix through the task (a
/// conflict, failing checks); `ready` the number of a PR the reader can merge,
/// so the bot can name what to try first. Without either the task waits on the
/// reader. Bar a problem, the task's last message rides along, since the bot
/// has no way to read it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn nudge_bot(
    session_id: String,
    problem: Option<String>,
    ready: Option<u32>,
    sink: Sink,
) -> Result<(), crate::Fail> {
    let task = store::get_session_index_item(&session_id).await?.with_context(|| format!("no session {session_id}"))?;
    let Some(chat) = bots::bot_chat_of(&task).await else { return Ok(()) };
    if task.archived || chat.archived || chat.session_id == task.session_id {
        return Ok(());
    }
    // A need written while the PR waited on review would outlive the review
    // on the ready row, since approving a PR does not move its task.
    if ready.is_some() && problem.is_none() && task.need.is_some() {
        store::set_session_need(&session_id, None).await?;
        announce_change(std::slice::from_ref(&session_id), &sink).await;
    }
    let idle = idle_since(&task.modified);
    let prompt = match (problem, ready) {
        (Some(problem), _) => format!("Stall nudge: this task has sat untouched for {idle}. {problem}"),
        (None, Some(n)) => format!(
            "Stall nudge: this task's PR #{n} is ready to merge and has sat for {idle}; the user merges it from the card. Its last message:\n\n{}",
            last_message_tail(&session_id).await?
        ),
        (None, None) => format!(
            "Stall nudge: this task has sat idle for {idle}, waiting on the user. Its last message:\n\n{}",
            last_message_tail(&session_id).await?
        ),
    };
    let send = SendMessage { session_id: chat.session_id, prompt, from_session_id: Some(session_id) };
    send_message(send, None, &sink).await?;
    Ok(())
}

/// The last [NUDGE_TAIL] characters of a task's last message.
async fn last_message_tail(session_id: &str) -> Result<String> {
    let last = store::last_reply(session_id).await?.0.unwrap_or_else(|| "(it wrote none)".into());
    let chars: Vec<char> = last.chars().collect();
    Ok(chars[chars.len().saturating_sub(NUDGE_TAIL)..].iter().collect())
}

/// "45m", "2h", "3d" since an RFC3339 time; the app's `compactAge`.
fn idle_since(at: &str) -> String {
    let min = chrono::DateTime::parse_from_rfc3339(at)
        .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_minutes().max(1))
        .unwrap_or(1);
    match min {
        ..60 => format!("{min}m"),
        60..1440 => format!("{}h", min / 60),
        _ => format!("{}d", min / 1440),
    }
}

/// Sends what a bot's child closed its turn with to the session that started it.
///
/// Every turn, not only the last one, and mechanical rather than left to the
/// child: a report the agent is asked to send is one it can forget, and the bot
/// is where the user is. The same path as `dray session send`, so the bot sees
/// it exactly as it would a message the child sent itself.
///
/// Boxed because the read loop calling it lives inside a harness's `init`, and
/// this send can reach `init` again: left unboxed, the compiler cannot name
/// either future without first naming the other.
pub fn report_to_parent(
    child_id: String,
    text: String,
    app: Sink,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
    Box::pin(async move {
        let Some(child) = store::get_session_index_item(&child_id).await? else {
            return Ok(());
        };
        let Some(parent_id) = child.parent_session_id.clone() else {
            return Ok(());
        };
        if child.archived {
            return Ok(());
        }
        let Some(parent) = store::get_session_index_item(&parent_id).await? else {
            // A bot's task started from another machine: its bot's server
            // collects this, since this one rarely holds a way back to it.
            if crate::remote_reports::owed(&child_id).await {
                crate::remote_reports::keep(&child_id, &parent_id, &child.title, text).await?;
            }
            return Ok(());
        };
        if parent.archived || !crate::bots::in_bot_tree(&child).await {
            return Ok(());
        }
        let Some(from) = sender(Some(&child_id)).await else { return Ok(()) };
        deliver_report(parent_id, text, from, app).await
    })
}

/// A task's report into the bot chat `parent_id`, from this machine's task or
/// one collected from another (#958). The same path as `dray session send`, so
/// the bot sees it exactly as it would a message the task sent itself.
pub fn deliver_report(
    parent_id: String,
    text: String,
    from: MessageSender,
    app: Sink,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
    Box::pin(async move {
        // A settled chat — Start fresh, or the child put away — takes no more
        // reports: sending would resume a conversation the reader closed.
        if store::get_session_index_item(&parent_id).await?.is_none_or(|p| p.archived) {
            return Ok(());
        }
        let send = SendMessage { session_id: parent_id.clone(), prompt: text, from_session_id: Some(from.session_id.clone()) };
        send_message(send, Some(from), &app).await?;
        // Settling writes the flag and then stops the child, so a Start fresh
        // landing between the check above and this send resumed the chat it
        // had just closed. Read again and stop it: one landing after this read
        // waits on the slot lock the send held, and stops the child itself.
        if store::get_session_index_item(&parent_id).await?.is_some_and(|p| p.archived) {
            manager().settle(&parent_id).await?;
        }
        Ok(())
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
///
/// A sender on another machine is named with it. `dray session send <id>`
/// finds that machine where this one holds a token for it.
fn attribute(prompt: &str, from: Option<&MessageSender>) -> String {
    let Some(MessageSender { session_id, title, machine, bot_id }) = from else {
        return prompt.to_string();
    };
    let kind = if bot_id.is_some() { "bot" } else { "session" };
    let on = machine.as_deref().map(|m| format!(" on {m}")).unwrap_or_default();
    format!("[message from the Dray {kind} \"{title}\" ({session_id}){on}]\n\n{prompt}")
}

/// Who this message is from, as data the transcript can draw.
///
/// `None` for a call from the user's own terminal — there is no session behind
/// it — and for one whose sender has since been deleted. One lookup answers for
/// both readers, so neither the prefix nor the card claims a session the index
/// can no longer name.
async fn sender(from_session_id: Option<&str>) -> Option<MessageSender> {
    let from = from_session_id?;
    let item = store::get_session_index_item(from).await.ok().flatten()?;
    // A bot is named as the bot rather than by its chat's title, so the reader
    // and the receiving agent both know which bot wrote.
    let bot = crate::bots::bot_at(&item.cwd).await;
    Some(MessageSender {
        session_id: item.session_id,
        title: bot.as_ref().map_or(item.title, |b| b.name.clone()),
        machine: None,
        bot_id: bot.map(|b| b.id),
    })
}

/// The caller's pick, else the parent's, else Claude Code.
fn resolve_harness(requested: Option<&str>, parent: Option<&SessionIndexItem>) -> Result<Harness> {
    let Some(requested) = requested else {
        return Ok(parent.map(|p| p.harness).unwrap_or(Harness::ClaudeCode));
    };

    // Named outright, so it has to resolve to something this build offers. The
    // tolerant `Deserialize` is for values read *off the index*, and reusing it
    // here would let `--harness` invent one.
    Harness::from_wire_name(requested).with_context(|| {
        // Named from the table rather than listed here, or the sentence goes
        // on offering two of three — which is exactly how `pi` came to be
        // refused by an app that could already run it.
        let known: Vec<_> = Harness::ALL.into_iter().map(Harness::wire_name).collect();
        format!("unknown harness {requested:?} — try {}", known.join(", "))
    })
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

/// The calling session, or `None` for a call from a terminal. An id that names
/// nothing is an error, since every caller then nests or scopes by it.
/// The calling session and how many creates deep it sits: read from this
/// index, or carried by the Mac that forwarded the call, whose index holds it.
// ponytail: a child made on another machine walks only edges this index holds,
// so its own children see depth 1 there; carry depth on the row if that matters.
async fn calling(id: Option<&str>, caller: Option<&Caller>) -> Result<Option<(SessionIndexItem, usize)>> {
    if let Some(caller) = caller {
        return Ok(Some((caller.session.clone(), caller.depth)));
    }
    let Some(parent) = parent_of(id).await? else { return Ok(None) };
    let depth = depth_of(&parent).await?;
    Ok(Some((parent, depth)))
}

async fn parent_of(id: Option<&str>) -> Result<Option<SessionIndexItem>> {
    match id {
        Some(id) => Ok(Some(
            store::get_session_index_item(id).await?.with_context(|| format!("no session {id}"))?,
        )),
        None => Ok(None),
    }
}

fn summarize_draft(draft: StoredDraft) -> DraftSummary {
    DraftSummary {
        id: draft.id,
        prompt: draft.prompt,
        project_path: draft.project_path,
        harness: draft.harness.wire_name(),
        model: draft.model.as_str().to_string(),
        effort: draft.effort.map(|e| e.as_arg().to_string()),
        use_worktree: draft.use_worktree,
        created: draft.created,
    }
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
        hidden: item.hidden,
        machine: None,
        held: false,
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
            ModelId::new("opus"),
            Some(Effort::High),
            ApprovalPolicy::Auto,
            false,
            parent,
        )
    }

    /// The two harnesses' ladders share their names and not their scale —
    /// Codex starts at Medium where Claude's models start at High — so a
    /// parent's level must not cross onto a child on the other harness. It
    /// falls through to `None`, which resolves to that model's own default.
    #[test]
    fn an_effort_does_not_cross_harnesses() {
        let parent = item("a", None);

        assert_eq!(
            resolve_effort(None, Some(&parent), Harness::ClaudeCode).unwrap(),
            Some(Effort::High)
        );
        assert_eq!(resolve_effort(None, Some(&parent), Harness::Codex).unwrap(), None);
        // A level the caller named stands whatever the parent ran.
        assert_eq!(
            resolve_effort(Some("max"), Some(&parent), Harness::Codex).unwrap(),
            Some(Effort::Max)
        );
    }

    /// Same boundary the effort above stops at, for a nearer reason: a `true`
    /// carried onto a child on another harness turns on a paid tier on a
    /// different vendor's account. And the bare flag means "yes", never "no" —
    /// `--fast` absent has to inherit, or a session spawned by one already
    /// running fast would quietly drop to ordinary speed.
    #[test]
    fn fast_mode_inherits_within_one_harness_and_no_further() {
        let mut parent = item("a", None);
        parent.fast = true;

        assert!(resolve_fast(None, Some(&parent), Harness::ClaudeCode));
        assert!(!resolve_fast(None, Some(&parent), Harness::Codex));
        // Named outright, it stands whatever the parent ran — both ways.
        assert!(resolve_fast(Some(true), Some(&parent), Harness::Codex));
        assert!(!resolve_fast(Some(false), Some(&parent), Harness::ClaudeCode));
        // No parent at all is the ordinary terminal call: off.
        assert!(!resolve_fast(None, None, Harness::ClaudeCode));
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

    /// The prefix is the receiving agent's only signal, so its two facts are
    /// pinned: the title it reads, and the id it can answer to.
    #[test]
    fn a_relayed_prompt_names_its_sender_and_the_id_to_reply_to() {
        let from = MessageSender {
            session_id: "abc-123".into(),
            title: "Fix the login redirect".into(),
            machine: None,
            bot_id: None,
        };
        let prompt = attribute("review is done", Some(&from));

        assert!(prompt.starts_with(
            "[message from the Dray session \"Fix the login redirect\" (abc-123)]\n\n"
        ));
        assert!(prompt.ends_with("review is done"));
    }

    /// A sender on another machine is named with it, so the agent knows where
    /// its answer goes.
    #[test]
    fn a_sender_on_another_machine_is_named() {
        let from = MessageSender {
            session_id: "abc-123".into(),
            title: "Fan out".into(),
            machine: Some("Yogesh's Mac".into()),
            bot_id: None,
        };
        assert_eq!(
            attribute("go", Some(&from)),
            "[message from the Dray session \"Fan out\" (abc-123) on Yogesh's Mac]\n\ngo"
        );
    }

    /// A bot is named as one, so the receiving agent knows a bot wrote rather
    /// than one of its tasks.
    #[test]
    fn a_bot_sender_is_named_as_a_bot() {
        let from = MessageSender {
            session_id: "abc-123".into(),
            title: "Ops".into(),
            machine: None,
            bot_id: Some("b1".into()),
        };
        assert_eq!(attribute("hi", Some(&from)), "[message from the Dray bot \"Ops\" (abc-123)]\n\nhi");
    }

    /// A prompt from the user's own terminal has no sender, and must reach the
    /// agent exactly as it was typed.
    #[test]
    fn an_unattributed_prompt_is_left_alone() {
        assert_eq!(attribute("just do it", None), "just do it");
    }

    /// Naming the wrong half is worse than naming neither: the reader runs a
    /// command that cannot fix what they have.
    #[test]
    fn the_mismatch_names_whichever_side_is_behind() {
        assert!(mismatch(PROTOCOL_VERSION - 1).contains("dray update"));
        assert!(mismatch(PROTOCOL_VERSION + 1).contains("update the Dray app"));
        assert!(!mismatch(PROTOCOL_VERSION + 1).contains("dray update"));
    }

    /// CLI 0.9.0 stamps v6 on everything a stable 0.26.0 app can run, and
    /// cli-v0.8.0 stamps v6 on everything — both have to be answered here, or
    /// one release of either half breaks the other.
    #[test]
    fn a_line_in_the_spoken_range_is_answered_and_one_outside_is_refused() {
        let line = |v: u32| format!(r#"{{"v":{v},"cmd":"create_session","prompt":"hi"}}"#);

        assert_eq!(refusal(&line(OLDEST_SPOKEN)), None);
        assert_eq!(refusal(&line(PROTOCOL_VERSION)), None);
        assert!(refusal(&line(OLDEST_SPOKEN - 1)).unwrap().contains("dray update"));
        assert!(refusal(&line(PROTOCOL_VERSION + 1))
            .unwrap()
            .contains("update the Dray app"));
    }

    /// Every harness the app can run is reachable by name from the CLI.
    ///
    /// This was a hand-written match of two arms, so `--harness pi` was
    /// refused by an app that could already spawn one — and the refusal named
    /// the two it did know, which read as pi not being a harness at all rather
    /// than as this function being behind.
    #[test]
    fn every_harness_can_be_asked_for_by_name() {
        for harness in Harness::ALL {
            let name = harness.wire_name();
            assert_eq!(
                resolve_harness(Some(&name), None).unwrap(),
                harness,
                "{name} is not reachable from the CLI"
            );
        }
    }

    /// And an unknown one is refused with every name it could have taken.
    #[test]
    fn an_unknown_harness_is_refused_by_naming_the_real_ones() {
        let err = resolve_harness(Some("nope"), None).unwrap_err().to_string();

        for harness in Harness::ALL {
            assert!(err.contains(&harness.wire_name()), "{err} omits a harness");
        }
    }

    /// A private dir of its own per test, short enough for a socket path's
    /// 108-byte limit.
    fn socket_dir(name: &str) -> std::path::PathBuf {
        use std::os::unix::fs::DirBuilderExt;

        let dir = std::env::temp_dir().join(format!("dray-sock-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).unwrap();
        dir
    }

    /// A connection reaching the listener, proven by the accept landing.
    async fn reaches(socket: &Socket, path: &Path) {
        let client = UnixStream::connect(path).await.expect("connect");
        socket.listener.accept().await.expect("accept");
        drop(client);
    }

    #[test]
    fn the_path_state_follows_the_inode() {
        let missing = || Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        let denied = || Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));

        assert_eq!(path_state((1, 2), Ok((1, 2))), PathState::Ours);
        assert_eq!(path_state((1, 2), Ok((1, 3))), PathState::Other((1, 3)));
        assert_eq!(path_state((1, 2), Ok((9, 2))), PathState::Other((9, 2)));
        assert_eq!(path_state((1, 2), missing()), PathState::Gone);
        assert_eq!(path_state((1, 2), denied()), PathState::Ours);
    }

    #[tokio::test]
    async fn a_socket_still_in_place_is_left_alone() {
        let dir = socket_dir("kept");
        let path = dir.join("dray.sock");
        let mut socket = Socket::bind(&path).unwrap();

        assert!(!socket.heal(&path).await);
        reaches(&socket, &path).await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_deleted_socket_is_bound_again() {
        let dir = socket_dir("deleted");
        let path = dir.join("dray.sock");
        let mut socket = Socket::bind(&path).unwrap();

        std::fs::remove_file(&path).unwrap();
        assert!(UnixStream::connect(&path).await.is_err());

        assert!(socket.heal(&path).await);
        reaches(&socket, &path).await;
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `rm -rf ~/.dray` takes the directory too, and the rebind brings it back
    /// private.
    #[tokio::test]
    async fn a_deleted_directory_is_made_again_private() {
        use std::os::unix::fs::PermissionsExt;

        let dir = socket_dir("dir-gone");
        let path = dir.join("dray.sock");
        let mut socket = Socket::bind(&path).unwrap();

        std::fs::remove_dir_all(&dir).unwrap();

        assert!(socket.heal(&path).await);
        reaches(&socket, &path).await;

        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&path), 0o600);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A session's log write can recreate the directory before the check runs,
    /// under a `022` umask. The rebind narrows it rather than refusing it.
    #[tokio::test]
    async fn a_directory_recreated_open_is_narrowed_and_bound() {
        use std::os::unix::fs::PermissionsExt;

        let dir = socket_dir("dir-open");
        let path = dir.join("dray.sock");
        let mut socket = Socket::bind(&path).unwrap();

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(socket.heal(&path).await);
        reaches(&socket, &path).await;
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The case seen live (#801): a copied socket file with nothing behind it.
    #[tokio::test]
    async fn a_dead_socket_file_in_its_place_is_replaced() {
        let dir = socket_dir("dead");
        let path = dir.join("dray.sock");
        let mut socket = Socket::bind(&path).unwrap();

        let stale = dir.join("stale.sock");
        drop(UnixListener::bind(&stale).unwrap());
        std::fs::rename(&stale, &path).unwrap();
        assert!(UnixStream::connect(&path).await.is_err());

        assert!(socket.heal(&path).await);
        reaches(&socket, &path).await;
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Two processes on one path must not take it from each other in turn.
    #[tokio::test]
    async fn a_live_socket_in_its_place_is_left_to_its_owner() {
        let dir = socket_dir("live");
        let path = dir.join("dray.sock");
        let mut socket = Socket::bind(&path).unwrap();

        let other = Socket::bind(&path).unwrap();

        assert!(!socket.heal(&path).await);
        assert_eq!(socket.yielded, Some(other.id));

        // The probe above reached the owner; drain it so the next proof is clean.
        other.listener.accept().await.unwrap();

        assert!(!socket.heal(&path).await);
        reaches(&other, &path).await;
        std::fs::remove_dir_all(&dir).ok();
    }
}
