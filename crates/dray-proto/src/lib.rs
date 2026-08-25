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

/// Bumped when a field changes meaning rather than when one is added — the
/// server refuses a version it doesn't know instead of guessing at it. An
/// added optional field needs no bump, since both sides default it.
pub const PROTOCOL_VERSION: u32 = 1;

/// Where the app listens, unless [`endpoint`] is overridden.
pub const SOCKET_NAME: &str = "dray.sock";

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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    pub prompt: String,
    /// The repo the session runs in. The CLI fills this from `git rev-parse
    /// --show-toplevel` when `--project` is absent, so a call from a terminal
    /// lands in the repo it was made from; `None` falls back to the parent
    /// session's project, and with neither the server refuses.
    #[serde(default)]
    pub project_path: Option<String>,
    /// Defaults to true at the CLI, not here: parallel sessions sharing one
    /// checkout overwrite each other, and fanning out is the whole use case.
    pub use_worktree: bool,
    /// `None` lets the app generate one, which is what it does for a worktree
    /// session started from the composer.
    #[serde(default)]
    pub worktree_name: Option<String>,
    /// `None` inherits the parent session's model, or the app's default with no
    /// parent. A bare alias (`opus`), matching what the composer stores.
    #[serde(default)]
    pub model: Option<String>,
    /// The session whose agent is making this call, from `DRAY_SESSION_ID`.
    /// Absent for a call from the user's own terminal, which is ordinary.
    #[serde(default)]
    pub parent_session_id: Option<String>,
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
    Created { session: SessionSummary },
    Listed { sessions: Vec<SessionSummary> },
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
    Some(dirs::home_dir()?.join(".dray").join(SOCKET_NAME))
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
            use_worktree: true,
            ..Default::default()
        })))
        .unwrap();

        assert_eq!(line["v"], 1);
        assert_eq!(line["cmd"], "create_session");
        assert_eq!(line["prompt"], "hi");
        // Flattened, not nested — a `request` key here means the server reads
        // the version and finds nothing else it recognizes.
        assert!(line.get("request").is_none());
    }

    #[test]
    fn absent_optionals_parse_as_none() {
        let envelope: Envelope =
            serde_json::from_str(r#"{"v":1,"cmd":"create_session","prompt":"hi","useWorktree":false}"#)
                .unwrap();

        let Request::CreateSession(create) = envelope.request else {
            panic!("wrong variant");
        };
        assert_eq!(create.project_path, None);
        assert_eq!(create.parent_session_id, None);
        assert_eq!(create.model, None);
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
