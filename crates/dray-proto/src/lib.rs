//! The wire shape between the Dray app and the `dray` CLI.
//!
//! Compiled into both sides so the two cannot drift. That is the whole reason
//! this is a crate rather than a struct in each: a drifted request shape is not
//! reported anywhere — the server fails to parse, answers an error, and the
//! command simply stops working. Same failure the harness's own control
//! protocol is typed against.
//!
//! Deliberately thin: serde, and the one function that decides where to
//! connect. No tokio and no tauri, so the CLI links none of either.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Bumped when an old side would answer a new request *wrongly and silently* —
/// the server refuses a version it doesn't know rather than guessing at it.
///
/// Not simply "a field changed meaning", which was the earlier rule and is too
/// narrow. What matters is whether the default an old side falls back to is
/// detectable. An added optional field usually needs no bump: an old app that
/// ignores `model` runs the session on its own default, which is a session the
/// caller can see and judge. `from` is the other kind — an old app ignores it,
/// starts the worktree from `origin/<default>`, and answers *identically to a
/// success*, so a session spawned to review unpushed work reviews none of it
/// and reports back that everything looks fine. Wrong work that looks like
/// right work is what earns a bump.
///
/// Refusing costs every command, not just the new one — but that cost falls
/// where it is cheapest. A CLI behind the app is told to run `dray update` and
/// fixes itself in one step; an app behind the CLI cannot be fixed from here at
/// all, and that is exactly the direction a silent default does the most
/// damage in. See [`Envelope`] and the app's own `mismatch`, which names which
/// half is behind so the reader — usually an agent, reading it as tool output —
/// runs the cure that applies rather than the one that doesn't.
/// v7 added the draft requests, which an older app fails to parse — refused by
/// version instead, so the answer names which half to update. v8 added
/// `share`, for the same reason, and v9 the server requests.
pub const PROTOCOL_VERSION: u32 = 9;

/// The oldest envelope the app still answers. Rises only when a shape is
/// *renamed*, never for an addition: v4 renamed `LinkIssues.identifiers` to
/// `issues`, so a v3 line parses on a newer app as "link nothing" — the silent
/// failure a bump exists to stop. Every bump since only added, so any v4+ line
/// means what it says; 6 is simply the oldest still in the wild.
pub const OLDEST_SPOKEN: u32 = 6;

/// Where the app listens, unless [`endpoint`] is overridden.
pub const SOCKET_NAME: &str = "dray.sock";

/// Where a `pnpm tauri dev` build listens instead.
///
/// One name per build, because the socket is a single file: a dev app binding
/// the release app's path unlinks it and takes the channel over, so from then
/// on every `dray` call reaches the dev app and the release app's own agents
/// write into a socket nothing is listening on. Restarting the release app
/// takes it back the same way. Two names let the two run side by side, which
/// is the ordinary state while developing this app.
pub const SOCKET_NAME_DEV: &str = "dray-dev.sock";

/// A line longer than this is refused unread. The socket is `0600`, so this is
/// hygiene rather than a threat model — but a length-prefixed-by-newline
/// protocol with no cap is one malformed writer away from an allocation the
/// size of the sender's patience.
pub const MAX_LINE: u64 = 1024 * 1024;

/// One request, with the protocol version flattened alongside it so the server
/// can check the version before it decides what the rest of the line means.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    #[serde(flatten)]
    pub request: Request,
}

impl Envelope {
    pub fn new(request: Request) -> Self {
        Self {
            v: request.version(),
            request,
        }
    }
}

impl Request {
    /// The oldest version that carries this request whole. The CLI stamps that
    /// rather than its own, so an older app answers everything it understands
    /// and refuses only what it cannot — and that refusal still names the app
    /// as the half to update. No wildcard arm: a new variant has to say which.
    pub fn version(&self) -> u32 {
        match self {
            Request::CreateSession(_)
            | Request::ListSessions(_)
            | Request::SendMessage(_)
            | Request::LinkIssues(_)
            | Request::Browser(_) => 6,
            Request::CreateDraft(_)
            | Request::ListDrafts(_)
            | Request::RemoveDraft(_)
            | Request::StartDraft(_) => 7,
            Request::Share(_) => 8,
            Request::AddServer(_)
            | Request::ListServers
            | Request::RemoveServer(_)
            | Request::RenameServer(_)
            | Request::SetServerOn(_) => 9,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    CreateSession(CreateSession),
    ListSessions(ListSessions),
    SendMessage(SendMessage),
    LinkIssues(LinkIssues),
    Browser(BrowserRequest),
    CreateDraft(CreateDraft),
    ListDrafts(ListSessions),
    RemoveDraft(DraftId),
    StartDraft(StartDraft),
    Share(ShareRequest),
    AddServer(AddServer),
    ListServers,
    RemoveServer(ServerRef),
    RenameServer(RenameServer),
    SetServerOn(SetServerOn),
}

/// An empty `new_name` puts back the default, its host.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameServer {
    pub name: String,
    pub new_name: String,
}

/// Off keeps the row and its token; the app stops connecting. On, for a
/// server already on, is Try again, and answers once the attempt settles.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetServerOn {
    pub name: String,
    pub on: bool,
}

/// A server for the app's list, the same record Settings → Servers writes.
///
/// `token` is what tells the two kinds apart: present, `address` is a URL and
/// the token admits it; absent, `address` is the line the reader logs in with
/// and the token is read over that login, so none crosses this socket.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddServer {
    pub name: String,
    pub address: String,
    #[serde(default)]
    pub token: Option<String>,
}

/// A server by its name, or by its id where two share a name.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRef {
    pub name: String,
}

/// What the CLI is told about a server. No token, ever.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSummary {
    pub id: String,
    pub name: String,
    /// `ssh user@host` or the URL.
    pub address: String,
    /// `connected`, `connecting`, `disconnected` or `off`.
    pub status: String,
    /// Why the last connect failed.
    #[serde(default)]
    pub error: Option<String>,
}

/// A public link to one of a session's dev servers, made where the server
/// runs. Only a port the session's own Browser tab lists can be shared.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequest {
    pub session_id: String,
    pub action: ShareAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "verb", rename_all = "snake_case")]
pub enum ShareAction {
    Start { port: u16 },
    Stop { port: u16 },
    List,
}

/// One live link.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedPort {
    pub port: u16,
    pub url: String,
}

/// A task saved for later, the same thing ⌘S makes in the composer: a prompt
/// and the picks it will start with, and no session behind it yet.
///
/// The picks resolve exactly as [`CreateSession`]'s do — the caller's flag,
/// else the calling session's, else the app's default — so a draft an agent
/// leaves behind starts the way `dray new` would have.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraft {
    pub prompt: String,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub fast: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftId {
    pub id: String,
}

/// Starts a draft as a session, which takes it off the draft list.
///
/// The worktree is the draft's own pick. One made by `dray draft new` always
/// has it on; one saved in the app has whatever the reader set, so running in
/// the main checkout only ever happens because a person asked for it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDraft {
    pub id: String,
    /// The session making the call, which the new session nests under — the
    /// same lineage `dray new` records, and the same depth cap.
    #[serde(default)]
    pub parent_session_id: Option<String>,
}

/// What the CLI is told about a draft.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub prompt: String,
    pub project_path: String,
    pub harness: String,
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    /// Off only where a person saved it that way in the app.
    pub use_worktree: bool,
    pub created: String,
}

/// One step in a session's own browser — the tabs the app draws for it.
///
/// Every action lands on that session's active tab, so an agent can reach no
/// other session's pages by construction: there is no target id to guess, the
/// session is the address. The verbs follow agent-browser's, so an agent that
/// knows one knows the other.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRequest {
    pub session_id: String,
    pub action: BrowserAction,
}

/// How an element is named. `Target` is what the line carries — `@e12` from
/// the last snapshot, or a CSS selector; the rest are `find`'s locators,
/// matched the way a person reads the page rather than the way it is built.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum Locator {
    Target { target: String },
    Role {
        role: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        exact: bool,
    },
    Text {
        text: String,
        #[serde(default)]
        exact: bool,
    },
    Label {
        label: String,
        #[serde(default)]
        exact: bool,
    },
    Placeholder {
        placeholder: String,
        #[serde(default)]
        exact: bool,
    },
    Alt {
        alt: String,
        #[serde(default)]
        exact: bool,
    },
    Title {
        title: String,
        #[serde(default)]
        exact: bool,
    },
    TestId { id: String },
    /// One of a selector's matches; `-1` is the last.
    Nth { selector: String, index: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "what", rename_all = "snake_case")]
pub enum Get {
    Text,
    Html,
    Value,
    Attr { name: String },
    Title,
    Url,
    Count,
    /// The bounding box, in viewport pixels.
    Box,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Is {
    Visible,
    Enabled,
    Checked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum BrowserAction {
    Open { url: String },
    Back,
    Forward,
    Reload,
    /// Close the active tab.
    Close,
    Tabs,
    TabNew {
        #[serde(default)]
        url: Option<String>,
    },
    TabSwitch { id: i32 },
    TabClose {
        #[serde(default)]
        id: Option<i32>,
    },
    /// Interactive elements and headings, each with a ref for the actions.
    Snapshot {
        #[serde(default)]
        interactive: bool,
        #[serde(default)]
        compact: bool,
        #[serde(default)]
        selector: Option<String>,
    },
    Click { at: Locator },
    DblClick { at: Locator },
    Focus { at: Locator },
    Hover { at: Locator },
    /// Keystrokes into an element, after whatever it holds.
    Type { at: Locator, text: String },
    /// Replace what an element holds.
    Fill { at: Locator, text: String },
    /// A key name (`Enter`, `Tab`, `Escape`, `ArrowDown`, `a`), with
    /// `Meta+`/`Ctrl+`/`Shift+`/`Alt+` prefixes.
    Press { key: String },
    Check { at: Locator },
    Uncheck { at: Locator },
    /// Pick an option by value or label.
    Select { at: Locator, value: String },
    /// `up`, `down`, `left`, `right` by `amount` pixels.
    Scroll { direction: String, amount: f64 },
    ScrollIntoView { at: Locator },
    Get {
        #[serde(flatten)]
        what: Get,
        #[serde(default)]
        at: Option<Locator>,
    },
    Is { what: Is, at: Locator },
    /// Whichever is set: a selector to appear, milliseconds, a URL fragment,
    /// visible text, or `load` for the page to finish loading.
    Wait {
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        ms: Option<u64>,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        load: Option<String>,
    },
    /// PNG to `path`, which must sit under the session's checkout, or a file
    /// under `~/.dray/browser/shots`; `full` is the whole document rather
    /// than the viewport.
    Screenshot {
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        full: bool,
    },
    /// Evaluate JavaScript in the page and answer its JSON value.
    Eval { js: String },
    /// What the page logged since last asked.
    Console,
    /// Errors alone, since last asked.
    Errors,
    SetViewport { width: u32, height: u32 },
    /// A device preset by name, as the pane's device bar lists them.
    SetDevice { name: String },
    /// Page zoom in percent, 100 being the page's own size. The same zoom
    /// the pane's ⌘= sets, so the reader sees it and captures carry it.
    Zoom { percent: u32 },
    /// Start recording the active tab, at the size `screenshot` uses.
    RecordStart,
    /// Stop recording and answer the MP4's path, named after `name` where
    /// one is given.
    RecordStop {
        #[serde(default)]
        name: Option<String>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    pub prompt: String,
    /// The repo the session runs in — the main worktree, which the CLI fills
    /// from `git worktree list` when `--project` is absent, so a call from a
    /// terminal lands in the repo it was made from and a call from inside a
    /// linked worktree still names the repo rather than that tree. `None` falls
    /// back to the parent session's project, and with neither the server
    /// refuses.
    #[serde(default)]
    pub project_path: Option<String>,
    /// `None` inherits the parent session's model, or the app's default with no
    /// parent. A bare alias (`opus`), matching what the composer stores.
    #[serde(default)]
    pub model: Option<String>,
    /// `low`..`max`. `None` inherits the parent's, and failing that the model's
    /// own default — which the app resolves, since a model with no effort
    /// levels must be sent none at all.
    #[serde(default)]
    pub effort: Option<String>,
    /// `claude_code`, `codex`, `pi`, `fx` or `grok`. `None` inherits the
    /// parent's, and defaults to Claude Code with no parent.
    #[serde(default)]
    pub harness: Option<String>,
    /// The session whose agent is making this call, from `DRAY_SESSION_ID`.
    /// Absent for a call from the user's own terminal, which is ordinary.
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// Where the new session's worktree starts from: a session id, a branch, or
    /// any git ref. `None` is the ordinary case and means `origin/<default>`,
    /// which is what the harness would have picked on its own.
    ///
    /// A session id is resolved to the branch that session's work lands on, and
    /// that resolution is the app's — the CLI has no index to read and no
    /// business learning how a session's branch is named.
    #[serde(default)]
    pub from: Option<String>,
    /// Issue identifiers (`DRA-53`) the new session's work is against.
    ///
    /// Resolved by the app, not here: the CLI holds no key and has no business
    /// learning what a tracker is. Each one becomes a link on the session and a
    /// line in the prompt — identifier and title, nothing more, since the agent
    /// has the tracker's own MCP server for the rest.
    #[serde(default)]
    pub issues: Vec<String>,
    /// Whether the session runs at its harness's faster, dearer tier.
    ///
    /// `None` inherits the parent's, and only within one harness — the same
    /// boundary `model` and `effort` stop at, for a nearer reason: a `true`
    /// carried from a Claude parent onto a Codex child turns on a paid tier on
    /// a different vendor's account, which is not what inheriting "run this one
    /// like me" can be taken to mean.
    ///
    /// **This is what earns the v6 bump.** An old app ignores the field and
    /// runs the session at ordinary speed — which answers *identically to a
    /// success*, since nothing in the transcript says which tier served it. An
    /// agent told to fan a deadline out fast would read every session back as
    /// fine and none of them would have been.
    #[serde(default)]
    pub fast: Option<bool>,
    /// Keep the session out of the sidebar; it shows in its parent's crew
    /// alone. Needs a parent, since without one no crew can draw it.
    ///
    /// No protocol bump: an old app ignores it and lists the session, which
    /// the reader can see, and [`SessionSummary::hidden`] comes back `false`
    /// so the CLI can say so.
    #[serde(default)]
    pub hidden: bool,
}

/// Tagging a session that already exists — or untagging it.
///
/// One request with a flag rather than two, because the halves differ by a
/// single word and every field is otherwise the same.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkIssues {
    pub session_id: String,
    pub issues: Vec<IssueInput>,
    /// Remove these links instead of adding them. Only `identifier` is read.
    #[serde(default)]
    pub unlink: bool,
}

/// One issue to tag a session with, as the caller already knows it.
///
/// **The app writes this down and asks the tracker nothing.** A link is a local
/// record — this session is about that work — and making it depend on a
/// reachable tracker meant a link could fail for reasons that have nothing to
/// do with what it records. The caller is an agent that has just read the issue
/// through the tracker's own MCP server, so it has the title and the URL in
/// hand; asking a second system for what the caller already holds is a round
/// trip that can only introduce a way to fail.
///
/// `title` and `url` are optional because a bare identifier is still a usable
/// link: the tag reads `#DRA-53` with no title after it, and stays plain text
/// rather than becoming a link to nowhere.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInput {
    /// As a person writes it; case is the app's to normalize.
    pub identifier: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// A prompt sent into a session that already exists.
///
/// Both directions on purpose: a spawned session reporting a summary back to
/// its parent and a parent handing a child extra context are the same
/// operation, so there is one command rather than a reply channel and a
/// separate send.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessage {
    pub session_id: String,
    pub prompt: String,
    /// Who is sending, for the line the receiving agent actually reads. Absent
    /// from a terminal call, where the message is the user's own.
    #[serde(default)]
    pub from_session_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessions {
    /// Every project rather than just the one this call resolves to.
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub parent_session_id: Option<String>,
}

/// Tagged rather than an `ok` boolean beside a bag of optional payloads: the
/// three answers carry disjoint fields, and a struct that can hold all of them
/// at once can also hold none of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Created {
        session: SessionSummary,
        /// What `from` resolved to, echoed back because the caller asked with a
        /// string and the answer is a branch: `--from <session-id>` names a
        /// session, and only the app can say which branch that session's work
        /// is on. `None` for an ordinary create, which starts where the harness
        /// would have started it anyway.
        ///
        /// Not a compatibility signal. It was one before [`PROTOCOL_VERSION`]
        /// was bumped for `from` — its absence stood in for "this app is too
        /// old to honour the flag" — and the bump is what made that job
        /// unreachable: such an app now refuses the envelope before it ever
        /// reads the request.
        #[serde(default)]
        base_ref: Option<String>,
    },
    Listed { sessions: Vec<SessionSummary> },
    /// A draft written, or one taken off the list — the answer to
    /// `CreateDraft` and `RemoveDraft` alike.
    Draft { draft: DraftSummary },
    Drafts { drafts: Vec<DraftSummary> },
    /// Every issue the session carries *after* the change, so the caller sees
    /// the result rather than a diff it has to apply to what it believed.
    Linked { issues: Vec<IssueLink> },
    /// `queued` when the target had a turn in flight, so the prompt is held
    /// until it reaches a boundary rather than being dropped or interrupting.
    Sent { queued: bool },
    /// What a browser action answers: `output` as text for the agent to
    /// read, `data` the same answer for `--json`.
    Browser { output: String, data: serde_json::Value },
    /// The session's live links after the change, whichever verb asked.
    Shared { shares: Vec<SharedPort> },
    /// The server a verb acted on, as it stands after — or as it stood, for
    /// one taken off the list.
    Server { server: ServerSummary },
    Servers { servers: Vec<ServerSummary> },
    Error { message: String },
}

impl Response {
    pub fn error(message: impl Into<String>) -> Self {
        Self::Error {
            message: message.into(),
        }
    }
}

/// What the CLI is told about a session. A deliberate subset of the app's own
/// `SessionIndexItem`: that type carries ts-rs derives and the app's model and
/// permission enums, none of which the CLI has any use for, and every field
/// named here is one the server has to keep answering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    /// Where the agent runs — the worktree for a worktree session, so this is
    /// the directory a reader would `cd` into.
    pub cwd: String,
    pub project_path: String,
    pub branch: Option<String>,
    pub worktree_name: Option<String>,
    /// `idle`, `in_progress` or `completed`, as the app's own index spells them.
    pub status: String,
    pub modified: String,
    /// Which session created this one, so a caller can answer "who spawned
    /// that" without reading the app's own index. Absent for a session started
    /// from the composer or from a terminal, and for one since detached.
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// Out of the sidebar, in its parent's crew alone. Absent from an app that
    /// predates the flag, which reads as `false` — the truth there.
    #[serde(default)]
    pub hidden: bool,
}

/// One issue a session is tagged with, as the CLI prints it.
///
/// A deliberate subset of the app's own `IssueRef`, for [`SessionSummary`]'s
/// reason: that type carries ts-rs derives and a tracker enum, neither of which
/// this side has any use for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueLink {
    pub identifier: String,
    pub title: String,
    pub url: String,
}

/// Where to reach the app: `DRAY_ENDPOINT` if set, else the socket under the
/// app's own directory.
///
/// The env var is what lets this survive the app moving to a server — a cloud
/// build hands the child an HTTPS URL instead, and nothing above this function
/// knows the difference.
pub fn endpoint() -> Option<String> {
    if let Ok(value) = std::env::var("DRAY_ENDPOINT") {
        if !value.is_empty() {
            return Some(value);
        }
    }

    Some(socket_path(false)?.to_string_lossy().into_owned())
}

/// The socket one build of the app listens on, `~/.dray/dray.sock` by default.
/// Resolved through `std::env::home_dir`, the same call the app's own
/// `get_home_app_dir` makes when it creates the directory this sits in.
///
/// The CLI never asks for the dev one: `dray` typed in a terminal means the app
/// the reader installed, and a dev app hands its own children `DRAY_ENDPOINT`
/// rather than leaving them to guess which build spawned them.
pub fn socket_path(dev: bool) -> Option<PathBuf> {
    let name = if dev { SOCKET_NAME_DEV } else { SOCKET_NAME };
    Some(std::env::home_dir()?.join(".dray").join(name))
}

/// One request or response as it goes on the wire. Newline-delimited JSON, the
/// same framing the harness pipe uses, so no second convention enters either
/// codebase.
pub fn encode_line<T: Serialize>(value: &T) -> serde_json::Result<String> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    Ok(line)
}

/// An agent CLI as `dray setup` installs it. Not wire, but this is the one
/// crate both sides compile, and the app's `Harness::install_command` and
/// `login_command` are pinned to it by a test there.
pub struct Agent {
    /// `Harness::wire_name`, and what `dray setup --install` takes.
    pub id: &'static str,
    pub name: &'static str,
    pub bin: &'static str,
    pub install: &'static str,
    pub login: &'static str,
}

pub const AGENTS: [Agent; 5] = [
    Agent {
        id: "claude_code",
        name: "Claude Code",
        bin: "claude",
        install: "curl -fsSL https://claude.ai/install.sh | bash",
        login: "claude auth login",
    },
    Agent {
        id: "codex",
        name: "Codex",
        bin: "codex",
        install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        login: "codex login",
    },
    Agent {
        id: "pi",
        name: "pi",
        bin: "pi",
        install: "curl -fsSL https://pi.dev/install.sh | sh",
        login: "pi",
    },
    Agent {
        id: "fx",
        name: "fx",
        bin: "fx",
        install: "curl -fsSL https://fx.sh/setup.sh | bash",
        login: "fx login",
    },
    Agent {
        id: "grok",
        name: "Grok Build",
        bin: "grok",
        install: "curl -fsSL https://x.ai/cli/install.sh | bash",
        login: "grok login",
    },
];

/// The cloudflared release public links run on, pinned so its bytes cannot
/// move under the hashes: the app downloads it on first share, and `dray
/// setup` offers it. Hashes are the release assets' own sha256, which GitHub
/// publishes beside each.
pub const CLOUDFLARED_VERSION: &str = "2026.10.0";

pub struct CloudflaredBuild {
    /// The release asset's name: a bare binary on Linux, a `.tgz` holding one
    /// on macOS.
    pub asset: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// This machine's build, by `(std::env::consts::OS, ARCH)`.
pub fn cloudflared_build() -> Option<CloudflaredBuild> {
    let (asset, size, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => (
            "cloudflared-linux-amd64",
            40_129_756,
            "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
        ),
        ("linux", "aarch64") => (
            "cloudflared-linux-arm64",
            37_687_584,
            "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08",
        ),
        ("macos", "aarch64") => (
            "cloudflared-darwin-arm64.tgz",
            19_809_074,
            "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70",
        ),
        ("macos", "x86_64") => (
            "cloudflared-darwin-amd64.tgz",
            21_741_581,
            "903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f",
        ),
        _ => return None,
    };
    Some(CloudflaredBuild { asset, size, sha256 })
}

impl CloudflaredBuild {
    pub fn url(&self) -> String {
        format!(
            "https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{}",
            self.asset
        )
    }
}

/// The port `dray-serve` listens on unless told otherwise, and so the one
/// `dray tunnel` points cloudflared at.
pub const SERVE_PORT: u16 = 7317;

/// The file in the Dray directory holding the server's current tunnel
/// address, written by `dray tunnel` on every start and removed on exit.
pub const TUNNEL_URL_FILE: &str = "tunnel-url";

/// A quick tunnel's address out of cloudflared's banner, which boxes it:
/// `|  https://four-random-words.trycloudflare.com   |`.
pub fn quick_tunnel_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..].chars().take_while(|c| !c.is_whitespace() && *c != '|').collect();
    url.ends_with(".trycloudflare.com").then_some(url)
}

/// cloudflared prints the address a moment before the tunnel is registered,
/// and is said before the name exists in DNS too: measured, 1.6–2.6s after
/// this line, and a resolver asked in that gap caches the miss for the zone's
/// 60s. So an address is handed out only once this line has been said and
/// [`DOH_QUERY`] answers for the name.
pub const TUNNEL_REGISTERED: &str = "Registered tunnel connection";

/// Cloudflare's DNS-over-HTTPS; append the host. Polled every 0.5s through
/// the gap, it answered as soon as the name existed rather than caching the
/// miss. JSON, where `"Status":0` means the name resolves.
pub const DOH_QUERY: &str = "https://1.1.1.1/dns-query?type=A&name=";

/// How each package manager installs git, the first one found winning. The
/// app shows the same line to copy where `dray setup` would print it, so the
/// two are one table.
pub const GIT_INSTALLS: [(&str, &str); 6] = [
    ("apt-get", "apt-get update && apt-get install -y git"),
    ("dnf", "dnf install -y git"),
    ("yum", "yum install -y git"),
    ("apk", "apk add git"),
    ("pacman", "pacman -S --noconfirm git"),
    ("zypper", "zypper install -y git"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_address_out_of_the_banner() {
        let banner = "2026-10-07T05:26:15Z INF |  https://eligible-recipients-expanded-pepper.trycloudflare.com                             |";
        assert_eq!(
            quick_tunnel_url(banner).as_deref(),
            Some("https://eligible-recipients-expanded-pepper.trycloudflare.com")
        );
        // The terms line names Cloudflare's own site, which is no address.
        assert_eq!(quick_tunnel_url("INF ... (https://www.cloudflare.com/website-terms/), and"), None);
        assert_eq!(quick_tunnel_url("INF Requesting new quick Tunnel on trycloudflare.com..."), None);
    }

    /// Deliberately a v1 line, and that is half the point: an envelope from a
    /// version we no longer speak still has to *parse*, or the app answers
    /// "could not parse the request" where it should be answering "run
    /// `dray update`". The version check is a layer above this, not a way in.
    #[test]
    fn absent_optionals_parse_as_none() {
        let envelope: Envelope =
            serde_json::from_str(r#"{"v":1,"cmd":"create_session","prompt":"hi"}"#).unwrap();
        assert_ne!(envelope.v, PROTOCOL_VERSION, "this line is the old shape");

        let Request::CreateSession(create) = envelope.request else {
            panic!("wrong variant");
        };
        assert_eq!(create.project_path, None);
        assert_eq!(create.parent_session_id, None);
        assert_eq!(create.model, None);
        assert_eq!(create.effort, None);
        assert_eq!(create.harness, None);
        assert_eq!(create.from, None);
    }

    /// Everything an app 0.26.0 (v6) could parse goes out as v6, so a stable
    /// app answers it; drafts go out as v7 and are refused there by version.
    /// And the constant is the newest any request needs — a bump that raises
    /// it and stamps nothing with it would ship a version nobody sends.
    #[test]
    fn each_request_stamps_the_oldest_version_that_carries_it() {
        let browser = BrowserRequest {
            session_id: "s".into(),
            action: BrowserAction::Back,
        };
        let old = [
            Request::CreateSession(Default::default()),
            Request::ListSessions(Default::default()),
            Request::SendMessage(Default::default()),
            Request::LinkIssues(Default::default()),
            Request::Browser(browser),
        ];
        let drafts = [
            Request::CreateDraft(Default::default()),
            Request::ListDrafts(Default::default()),
            Request::RemoveDraft(Default::default()),
            Request::StartDraft(Default::default()),
        ];

        for request in &old {
            assert_eq!(Envelope::new(request.clone()).v, 6, "{request:?}");
        }
        for request in &drafts {
            assert_eq!(Envelope::new(request.clone()).v, 7, "{request:?}");
        }
        let share = Request::Share(ShareRequest { session_id: "s".into(), action: ShareAction::List });
        assert_eq!(Envelope::new(share.clone()).v, 8);
        let servers = [
            Request::AddServer(Default::default()),
            Request::ListServers,
            Request::RemoveServer(Default::default()),
            Request::RenameServer(Default::default()),
            Request::SetServerOn(Default::default()),
        ];
        for request in &servers {
            assert_eq!(Envelope::new(request.clone()).v, 9, "{request:?}");
        }
        let newest = old.iter().chain(&drafts).chain([&share]).chain(&servers).map(Request::version).max();
        assert_eq!(newest, Some(PROTOCOL_VERSION));
        assert!(OLDEST_SPOKEN <= PROTOCOL_VERSION);
    }

    /// A unit variant inside a flattened, internally tagged enum: the one shape
    /// no other request exercises.
    #[test]
    fn list_servers_round_trips() {
        let line = encode_line(&Envelope::new(Request::ListServers)).unwrap();
        assert_eq!(line.trim(), r#"{"v":9,"cmd":"list_servers"}"#);
        let back: Envelope = serde_json::from_str(&line).unwrap();
        assert!(matches!(back.request, Request::ListServers));
    }

    #[test]
    fn endpoint_prefers_the_environment() {
        // Serialized against the other env-reading test by running in one
        // process; `set_var` is process-wide.
        std::env::set_var("DRAY_ENDPOINT", "/tmp/custom.sock");
        assert_eq!(endpoint().as_deref(), Some("/tmp/custom.sock"));

        // Empty reads as unset rather than as an address, so an exported-but-
        // blank var falls back instead of failing to connect to "".
        std::env::set_var("DRAY_ENDPOINT", "");
        assert!(endpoint().unwrap().ends_with("dray.sock"));

        std::env::remove_var("DRAY_ENDPOINT");
    }
}
