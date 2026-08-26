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
/// v2 added `CreateSession::from`.
pub const PROTOCOL_VERSION: u32 = 2;

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
    /// `queued` when the target had a turn in flight, so the prompt is held
    /// until it reaches a boundary rather than being dropped or interrupting.
    Sent { queued: bool },
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

        assert_eq!(line["v"], 2);
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
