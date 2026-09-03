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
///
/// v2 added `CreateSession::from`. v3 added `CreateSession::issues` and
/// [`Request::LinkIssues`], for the same test: an app that ignored `issues`
/// would start the session with no issue linked and no line in its prompt
/// saying what the work is against, and answer identically to a success — so
/// the session runs, works on the wrong thing or on nothing, and reports back
/// that it is done.
///
/// v4 reshaped [`LinkIssues`]: `identifiers: Vec<String>` became
/// [`IssueInput`], carrying the title and URL the caller already has. The old
/// shape made the *app* resolve each identifier against the tracker, so a link
/// — a local record, on a session, about work — needed the network to be up and
/// a key to be stored. The field is renamed rather than extended so the two
/// shapes cannot be confused on the wire: an old app handed the new one finds
/// no `identifiers` and refuses, which is the loud failure wanted here.
///
/// v5 added [`Request::Browser`]. An older app fails to parse the variant and
/// answers "could not parse the request", which reads as a broken CLI rather
/// than an app with no browser; the bump turns that into "update the Dray
/// app", the one cure that applies.
pub const PROTOCOL_VERSION: u32 = 5;

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
            v: PROTOCOL_VERSION,
            request,
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
    /// visible text, or a load state (`load`, `networkidle`).
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
    /// PNG to `path`, or a file under `~/.dray/browser/shots`; `full` is the
    /// whole document rather than the viewport.
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
    /// `claude_code` today. `None` inherits the parent's, and defaults to
    /// Claude Code with no parent.
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
    /// Every issue the session carries *after* the change, so the caller sees
    /// the result rather than a diff it has to apply to what it believed.
    Linked { issues: Vec<IssueLink> },
    /// `queued` when the target had a turn in flight, so the prompt is held
    /// until it reaches a boundary rather than being dropped or interrupting.
    Sent { queued: bool },
    /// What a browser action answers: `output` as text for the agent to
    /// read, `data` the same answer for `--json`.
    Browser { output: String, data: serde_json::Value },
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

    Some(default_socket_path()?.to_string_lossy().into_owned())
}

/// `~/.dray/dray.sock`. Resolved through `dirs` rather than `$HOME` so it
/// agrees with the app's own `get_home_app_dir`, which is what creates the
/// directory this sits in.
pub fn default_socket_path() -> Option<PathBuf> {
    socket_path(false)
}

/// The socket one build of the app listens on.
///
/// The CLI never asks for the dev one: `dray` typed in a terminal means the app
/// the reader installed, and a dev app hands its own children `DRAY_ENDPOINT`
/// rather than leaving them to guess which build spawned them.
pub fn socket_path(dev: bool) -> Option<PathBuf> {
    let name = if dev { SOCKET_NAME_DEV } else { SOCKET_NAME };
    Some(dirs::home_dir()?.join(".dray").join(name))
}

/// One request or response as it goes on the wire. Newline-delimited JSON, the
/// same framing the harness pipe uses, so no second convention enters either
/// codebase.
pub fn encode_line<T: Serialize>(value: &T) -> serde_json::Result<String> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_flattens_the_version_beside_the_command() {
        let line = serde_json::to_value(Envelope::new(Request::CreateSession(CreateSession {
            prompt: "hi".into(),
            ..Default::default()
        })))
        .unwrap();

        assert_eq!(line["v"], PROTOCOL_VERSION);
        assert_eq!(line["cmd"], "create_session");
        assert_eq!(line["prompt"], "hi");
        // Flattened, not nested — a `request` key here means the server reads
        // the version and finds nothing else it recognizes.
        assert!(line.get("request").is_none());
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

    #[test]
    fn a_base_travels_on_the_create() {
        let line = serde_json::to_string(&Envelope::new(Request::CreateSession(CreateSession {
            prompt: "review it".into(),
            from: Some("worktree-calm-owl".into()),
            ..Default::default()
        })))
        .unwrap();
        assert!(line.contains(r#""from":"worktree-calm-owl""#));

        let back: Envelope = serde_json::from_str(&line).unwrap();
        let Request::CreateSession(create) = back.request else {
            panic!("wrong variant");
        };
        assert_eq!(create.from.as_deref(), Some("worktree-calm-owl"));
    }

    /// `from` is what v2 exists for: a v1 app would have ignored the field,
    /// started the worktree from `origin/<default>`, and answered like a
    /// success. The envelope carries the version ahead of the command so that
    /// is refused before the request is read at all.
    #[test]
    fn a_create_carrying_a_base_goes_out_at_the_version_that_added_it() {
        let line = serde_json::to_value(Envelope::new(Request::CreateSession(CreateSession {
            prompt: "review it".into(),
            from: Some("worktree-calm-owl".into()),
            ..Default::default()
        })))
        .unwrap();

        assert_eq!(line["v"], PROTOCOL_VERSION);
        assert!(PROTOCOL_VERSION >= 2, "from must not travel under v1");
    }

    /// The field is defaulted, so a response shape without it parses rather
    /// than failing the create. No longer a compatibility signal — the bump
    /// took that job — but an unexercised `serde(default)` is one nobody checks.
    #[test]
    fn a_create_answered_without_a_base_still_parses() {
        let response: Response = serde_json::from_str(
            r#"{"status":"created","session":{"sessionId":"a","title":"t","cwd":"/p",
                "projectPath":"/p","branch":null,"worktreeName":null,"status":"idle",
                "modified":"now"}}"#,
        )
        .unwrap();

        let Response::Created { base_ref, .. } = response else {
            panic!("wrong variant");
        };
        assert_eq!(base_ref, None);
    }

    /// Same test `from` earned its bump on: an app that ignored these would
    /// start a session against no issue at all and answer like a success.
    #[test]
    fn issues_travel_on_the_create_at_the_version_that_added_them() {
        let line = serde_json::to_value(Envelope::new(Request::CreateSession(CreateSession {
            prompt: "do it".into(),
            issues: vec!["DRA-53".into()],
            ..Default::default()
        })))
        .unwrap();

        assert_eq!(line["issues"][0], "DRA-53");
        assert!(PROTOCOL_VERSION >= 3, "issues must not travel under v2");
    }

    #[test]
    fn linking_round_trips_and_says_which_way_it_goes() {
        let line = serde_json::to_string(&Envelope::new(Request::LinkIssues(LinkIssues {
            session_id: "abc".into(),
            issues: vec![
                IssueInput { identifier: "DRA-1".into(), ..Default::default() },
                IssueInput { identifier: "DRA-2".into(), ..Default::default() },
            ],
            unlink: true,
        })))
        .unwrap();
        assert!(line.contains(r#""cmd":"link_issues""#));

        let back: Envelope = serde_json::from_str(&line).unwrap();
        let Request::LinkIssues(link) = back.request else {
            panic!("wrong variant");
        };
        assert_eq!(link.issues.len(), 2);
        assert!(link.unlink);
    }

    /// Absent reads as *adding*, which is the direction that cannot be
    /// destructive — the one worth having as a default.
    #[test]
    fn a_link_with_no_direction_adds() {
        let request: Request = serde_json::from_str(
            r#"{"cmd":"link_issues","sessionId":"a","issues":[{"identifier":"DRA-1"}]}"#,
        )
        .unwrap();

        let Request::LinkIssues(link) = request else {
            panic!("wrong variant");
        };
        assert!(!link.unlink);
    }

    #[test]
    fn send_message_round_trips() {
        let line = serde_json::to_string(&Envelope::new(Request::SendMessage(SendMessage {
            session_id: "abc".into(),
            prompt: "review is done".into(),
            from_session_id: Some("parent".into()),
        })))
        .unwrap();
        assert!(line.contains(r#""cmd":"send_message""#));

        let back: Envelope = serde_json::from_str(&line).unwrap();
        let Request::SendMessage(send) = back.request else {
            panic!("wrong variant");
        };
        assert_eq!(send.session_id, "abc");
        assert_eq!(send.from_session_id.as_deref(), Some("parent"));
    }

    /// Added after the CLI shipped, so an app that predates it sends no such
    /// key — which has to read as "no parent" rather than failing the list.
    #[test]
    fn a_summary_without_a_parent_key_still_parses() {
        let summary: SessionSummary = serde_json::from_str(
            r#"{"sessionId":"a","title":"t","cwd":"/p","projectPath":"/p","branch":null,
                "worktreeName":null,"status":"idle","modified":"now"}"#,
        )
        .unwrap();
        assert_eq!(summary.parent_session_id, None);
    }

    #[test]
    fn responses_round_trip_through_their_tag() {
        let listed = Response::Listed { sessions: vec![] };
        let json = serde_json::to_string(&listed).unwrap();
        assert!(json.contains(r#""status":"listed""#));

        let back: Response = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, Response::Listed { sessions } if sessions.is_empty()));
    }

    #[test]
    fn encoded_lines_carry_exactly_one_newline() {
        let line = encode_line(&Response::error("nope")).unwrap();
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
    }

    #[test]
    fn dev_and_release_sockets_are_different_files() {
        // The whole point: a dev app must not be able to unlink the socket the
        // installed app is serving on.
        assert_ne!(socket_path(true), socket_path(false));
        assert_eq!(socket_path(false), default_socket_path());
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
