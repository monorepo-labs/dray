//! The issue a session is working on, whoever tracks it.
//!
//! Linear is the only tracker wired up, and it is the only word in here that
//! says so: everything a reader sees is an *issue*, and everything below this
//! file's vocabulary lives in `linear.rs`. A second tracker is a module and a
//! variant, not a rename of every surface — which is why [`IssueRef`] carries
//! its own [`IssueTracker`] even while there is one.
//!
//! Two halves, and they answer different questions. The **connection** is the
//! account, and it is workspace-wide: no project is bound to a team, so the
//! picker and the issues page read whatever the connected user is assigned. The
//! **link** is per session, recorded on its index entry, and it is what draws
//! the panel's tab and what a tag resolves to.

#[path = "linear.rs"]
pub mod linear;

use std::{collections::HashMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::{settings, store, store::get_home_app_dir};

/// Who tracks the issue. One variant today; it is on the wire and on disk so a
/// session linked to a Linear issue stays readable once there are two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum IssueTracker {
    Linear,
}

/// What a session records about an issue it is working on.
///
/// Deliberately a *copy*, not a pointer: the title and the URL are what the
/// sidebar and the prompt block need, and re-reading the tracker to draw a row
/// would put a network call behind a session opening. It goes stale — a
/// retitled issue keeps the old words here until the panel reads it back — and
/// that is the right way round, since the alternative is a row that cannot be
/// drawn while the workspace is unreachable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    pub tracker: IssueTracker,
    /// The tracker's own stable id, which survives a move between teams where
    /// `identifier` does not.
    pub id: String,
    /// What a person calls it: `DRA-53`.
    pub identifier: String,
    pub title: String,
    pub url: String,
}

/// Where an issue has got to, folded from the tracker's own vocabulary.
///
/// Linear reports a workflow state's `type`, which is this set exactly — the
/// state's *name* is per-team prose ("In Review", "Shipping") and belongs on
/// screen, not in a match arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum IssueStateKind {
    Triage,
    Backlog,
    Unstarted,
    Started,
    Completed,
    Canceled,
    /// A state type we don't model. Drawn from `name` like any other, so a
    /// vocabulary Linear adds later costs a glyph rather than the whole read.
    Other,
}

impl IssueStateKind {
    /// Whether the work is over, either way it went. What "unfinished" means in
    /// the issues page's default filter.
    pub fn settled(self) -> bool {
        matches!(self, Self::Completed | Self::Canceled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueState {
    pub name: String,
    pub kind: IssueStateKind,
    /// The tracker's own colour, so a status reads the same here as it does in
    /// the app the reader also has open.
    pub color: String,
}

/// Linear's five levels, by name rather than by its `0..4` integer — where `0`
/// is *no* priority and therefore sorts nothing like a number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum IssuePriority {
    Urgent,
    High,
    Medium,
    Low,
    None,
}

impl IssuePriority {
    /// Wire integer to level. Anything outside the documented range reads as
    /// `None`, which sorts last rather than first.
    pub fn from_wire(value: i64) -> Self {
        match value {
            1 => Self::Urgent,
            2 => Self::High,
            3 => Self::Medium,
            4 => Self::Low,
            _ => Self::None,
        }
    }

    /// Sort key, urgent first and unprioritized last. The whole reason this is
    /// an enum: ordering by Linear's own integer puts "No priority" at the top.
    pub fn rank(self) -> u8 {
        match self {
            Self::Urgent => 0,
            Self::High => 1,
            Self::Medium => 2,
            Self::Low => 3,
            Self::None => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssuePerson {
    pub name: String,
    /// `None` for an account with no picture, which the panel draws as an
    /// initial rather than as a gap — same bargain the PR panel makes.
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueLabel {
    pub name: String,
    pub color: String,
}

/// One row in a list, and everything a row draws.
///
/// Distinct from [`IssueDetail`] rather than one type with empty fields: a list
/// read does not ask for descriptions or comments, and a struct that carries
/// them anyway hands the panel an issue whose body is silently missing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub tracker: IssueTracker,
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
    pub state: IssueState,
    pub priority: IssuePriority,
    pub assignee: Option<IssuePerson>,
    pub labels: Vec<IssueLabel>,
    /// Team key (`DRA`) — what the identifier is built from, so a row filtered
    /// across teams still says which one it belongs to.
    pub team: Option<String>,
    pub project: Option<String>,
    pub updated_at: String,
}

impl Issue {
    /// The subset a session records. Built here rather than in the frontend so
    /// there is one answer to "what does a link hold".
    pub fn to_ref(&self) -> IssueRef {
        IssueRef {
            tracker: self.tracker,
            id: self.id.clone(),
            identifier: self.identifier.clone(),
            title: self.title.clone(),
            url: self.url.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub author: IssuePerson,
    pub body: String,
    pub created_at: String,
    pub url: Option<String>,
}

/// One issue, opened. The panel's read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    #[serde(flatten)]
    #[ts(flatten)]
    pub issue: Issue,
    /// Markdown, as the tracker holds it. `None` for an issue nobody wrote one
    /// for, which the panel says plainly rather than drawing an empty box.
    pub description: Option<String>,
    pub comments: Vec<IssueComment>,
}

/// Whose issues to list.
///
/// The tracker's own two answers to "my issues", and a third for looking past
/// them. Deliberately not a pair of booleans: assigned *and* created is a
/// question nobody asks, and two flags can express it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum IssueScope {
    #[default]
    Assigned,
    Created,
    All,
}

/// What the issues page can narrow to, and what the picker asks with.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase", default)]
pub struct IssueQuery {
    /// Free text. Matched against title and identifier; an empty query is the
    /// resting state and lists rather than searches.
    pub text: Option<String>,
    pub scope: IssueScope,
    /// Linear team id.
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    /// Which half of the workspace to read: the unfinished issues, or the done
    /// and cancelled ones.
    ///
    /// Two reads rather than one flag that widens a single read, because the
    /// settled half is most of a workspace and is nearly always dead weight —
    /// so the page draws its groups collapsed and asks for them only when one
    /// is opened. Splitting it here rather than filtering client-side is what
    /// makes that possible: a read that never happens costs nothing, and the
    /// two answers cache under separate keys.
    pub settled: bool,
}

/// The filter row's options, read once per connection rather than per keystroke.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueFilters {
    pub teams: Vec<IssueGroup>,
    pub projects: Vec<IssueGroup>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueGroup {
    pub id: String,
    pub name: String,
}

/// The connected account, as the settings row draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct TrackerAccount {
    pub tracker: IssueTracker,
    pub user_id: String,
    pub user_name: String,
    pub org_name: String,
}

/// Why there is nothing to show.
///
/// Typed for [`PrUnavailable`](crate::github::PrUnavailable)'s reason: the
/// frontend acts differently on each. `NotConnected` is the resting state of an
/// app nobody has connected — an empty state pointing at settings, never an
/// error — where `Unauthorized` means a key that has been revoked or rotated
/// and is the one the reader has to do something about.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum IssueUnavailable {
    NotConnected,
    Unauthorized,
    /// The workspace could not be reached — offline, or the API is down.
    Offline(String),
    Other(String),
}

impl IssueUnavailable {
    pub fn other(e: impl std::fmt::Display) -> Self {
        Self::Other(e.to_string())
    }
}

/// Written for whoever reads it as a sentence — a CLI user, or an agent
/// reading tool output. The frontend draws its own words instead, because a
/// panel can point at the settings row and a terminal cannot.
impl std::fmt::Display for IssueUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConnected => write!(
                f,
                "Dray is not connected to an issue tracker. Connect Linear in Dray's settings."
            ),
            Self::Unauthorized => write!(
                f,
                "Linear rejected the stored key. Reconnect it in Dray's settings."
            ),
            Self::Offline(detail) => write!(f, "Could not reach Linear: {detail}"),
            Self::Other(detail) => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for IssueUnavailable {}

// ── the connection ───────────────────────────────────────────────────────────

/// Where the key lives: `~/.dray/credentials.json`, `0600`.
///
/// **Not the OS keychain, and that was a considered retreat.** macOS ties a
/// keychain grant to the exact binary that asked for it, so every rebuild is a
/// new application as far as the ACL is concerned and the grant never sticks —
/// which on a development machine is an authorisation dialog several times an
/// hour, forever. Signing with a stable Developer ID settles it for a shipped
/// build and does nothing for anyone working on the app.
///
/// What the retreat costs is worth stating plainly: this key is readable by
/// anything running as the user, where a keychain entry is not. What makes it
/// tolerable is the company it keeps — `~/.dray` is `0700` and already holds
/// every transcript, which is to say every file the agent has read or written
/// on this machine. A read-only issue-tracker key is not the most sensitive
/// thing in that directory by a wide margin. `gh`, `npm` and `aws` all make the
/// same trade.
///
/// Its own file rather than a field on `settings.json`, for two reasons that
/// both bite: settings are rewritten by every analytics toggle and read on the
/// launch path where a parse failure falls back to defaults — which would
/// silently forget the key — and `get_settings` hands that struct to the
/// frontend, which a credential must never ride along with.
const CREDENTIALS_FILE: &str = "credentials.json";

/// Serializes writers, like every other whole-file rewrite here.
static CREDENTIALS_LOCK: Mutex<()> = Mutex::const_new(());

impl IssueTracker {
    /// The key this tracker's credential is filed under. Stable across
    /// renames of the enum, because it is written to disk.
    fn credential_key(self) -> &'static str {
        match self {
            Self::Linear => "linear",
        }
    }
}

async fn credentials_path() -> Result<PathBuf, String> {
    get_home_app_dir()
        .await
        .map(|dir| dir.join(CREDENTIALS_FILE))
        .map_err(|e| format!("could not open the Dray directory: {e}"))
}

async fn read_credentials() -> HashMap<String, String> {
    let Ok(path) = credentials_path().await else {
        return HashMap::new();
    };

    match tokio::fs::read_to_string(&path).await {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            // A file that exists and cannot be parsed reads as no key, which
            // presents as "not connected" and is curable by connecting again.
            eprintln!("[credentials parse err] {e}");
            HashMap::new()
        }),
        // Absent is the ordinary case, and says nothing worth logging.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(e) => {
            eprintln!("[credentials read err] {e}");
            HashMap::new()
        }
    }
}

/// The key for a tracker, or `None` for one nothing is stored under.
///
/// Unreadable reads as *not connected* rather than as an error — the cure is
/// the same either way, which is to connect again.
pub async fn read_key(tracker: IssueTracker) -> Option<String> {
    read_credentials()
        .await
        .get(tracker.credential_key())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// Writes the file whole at `0600`, temp file included.
///
/// The mode rides the **create**, on the temp file, rather than being set after
/// the write or on the final file after the rename. `fs::write` creates at the
/// process umask, so every other order leaves a window in which the key sits on
/// disk world-readable — a `chmod` after the write closes a wide window and
/// leaves a narrow one, where `OpenOptions::mode` leaves none at all: the file
/// never exists with a wider mode for a single byte to be written into.
///
/// `mode` applies only to a file this call creates, which is what the
/// `create_new` beside it guarantees. A temp file left behind by a crashed
/// write could otherwise be one somebody else made, at whatever mode they chose.
async fn write_credentials(next: &HashMap<String, String>) -> Result<(), String> {
    write_credentials_at(&credentials_path().await?, next).await
}

/// Takes the path so a test can round-trip against a tempdir and read the mode
/// back, rather than writing into the real `~/.dray`.
async fn write_credentials_at(
    path: &std::path::Path,
    next: &HashMap<String, String>,
) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");

    let body = serde_json::to_string_pretty(next).map_err(|e| e.to_string())?;

    // Cleared first, so `create_new` below is answering "did this call make the
    // file" rather than failing over one a crashed write left behind.
    let _ = tokio::fs::remove_file(&tmp).await;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // `mode` is inherent on tokio's own `OpenOptions` under unix — no ext trait
    // to import, and none to forget.
    #[cfg(unix)]
    options.mode(0o600);

    let mut file = options
        .open(&tmp)
        .await
        .map_err(|e| format!("could not write the credentials file: {e}"))?;

    let written = async {
        use tokio::io::AsyncWriteExt;
        file.write_all(body.as_bytes()).await?;
        file.sync_all().await
    }
    .await;

    if let Err(e) = written {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("could not write the credentials file: {e}"));
    }
    drop(file);

    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        // Or the next write inherits a stale temp file holding an old key.
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("could not replace the credentials file: {e}"));
    }

    Ok(())
}

async fn write_key(tracker: IssueTracker, key: &str) -> Result<(), String> {
    let _guard = CREDENTIALS_LOCK.lock().await;

    let mut next = read_credentials().await;
    next.insert(tracker.credential_key().to_string(), key.to_string());

    write_credentials(&next).await
}

async fn delete_key(tracker: IssueTracker) -> Result<(), String> {
    let _guard = CREDENTIALS_LOCK.lock().await;

    let mut next = read_credentials().await;
    // Already gone is what the caller asked for, and rewriting the file to say
    // the same thing is work with no reader.
    if next.remove(tracker.credential_key()).is_none() {
        return Ok(());
    }

    write_credentials(&next).await
}

// ── what a tag puts in front of the model ────────────────────────────────────

/// A tag as it is written into a prompt: the identifier, then the title.
///
/// Identifier and title, and deliberately nothing else. The agent has the
/// tracker's own MCP server to read descriptions, comments and links with, and
/// it fetches what it needs in the shape it wants — where a description pasted
/// in here is a wall of text at the top of every prompt, stale the moment
/// somebody edits the issue, and paid for again on every follow-up. The
/// identifier is the address; the title is what makes the prompt readable
/// before anything has been fetched.
///
/// The same string the composer's picker writes, so a tag typed by hand, picked
/// from the menu, or named with `--issue` all read identically in the
/// transcript and to the model. That is what retired the separate block this
/// used to append: with the title in the tag, the block had nothing left to
/// say, and a transcript that had to strip its own prompt back apart is a
/// pattern match waiting to eat somebody's sentence.
pub fn tag_text(issue: &IssueRef) -> String {
    // A link made without a title — `dray issue link` writes down what it is
    // given — leaves the identifier standing alone rather than a trailing
    // space nobody typed. Matches `issueTag` in issue.ts, which has to agree
    // with this or a tag reads one way in the composer and another once sent.
    if issue.title.trim().is_empty() {
        return format!("#{}", issue.identifier);
    }

    format!("#{} {}", issue.identifier, issue.title)
}

/// Every `#ABC-123` in a prompt, in the order they appear and without repeats.
///
/// The rule is the token's, the same one `@` mentions follow on the other side
/// of the bridge: a `#` has to *open* a word, so a colour like `#fff` mid
/// sentence stays prose — and what follows has to be a team key and a number,
/// which is what keeps a markdown heading out.
pub fn issue_tags(prompt: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();

    for token in prompt.split_whitespace() {
        // Leading punctuation is stripped so `(#DRA-1)` tags; trailing is left
        // to `parse_identifier`, which stops at the first non-digit anyway.
        let token = token.trim_start_matches(['(', '[', '"', '\'']);
        let Some(rest) = token.strip_prefix('#') else {
            continue;
        };

        if let Some(id) = parse_identifier(rest) {
            if !found.iter().any(|seen| seen == &id) {
                found.push(id);
            }
        }
    }

    found
}

/// `DRA-53` out of `DRA-53),` — or `None` when what follows the `#` is not an
/// identifier at all.
///
/// Uppercased, because Linear's own identifiers are and a tag typed in lower
/// case has to reach the same issue as one picked from the menu.
pub fn parse_identifier(text: &str) -> Option<String> {
    let (key, number) = text.split_once('-')?;

    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    // A team key always starts with a letter, which is what keeps `#1-2` out.
    if !key.chars().next()?.is_ascii_alphabetic() {
        return None;
    }

    let digits: String = number.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }

    Some(format!("{}-{}", key.to_uppercase(), digits))
}

/// What a prompt's tags came to.
///
/// Two lists because a tag answers two different questions. `mentioned` is what
/// this prompt names — it rides the `user_message` event, so the tag in the
/// bubble draws as a button opening the tracker. `linked` is what the *session*
/// is about, and only a caller naming an issue outright puts one there: a
/// `#DRA-53` in prose is a mention, and "unrelated to #DRA-53" must not file the
/// session under it forever.
pub struct ExpandedTags {
    pub prompt: String,
    pub mentioned: Vec<IssueRef>,
    pub linked: Vec<IssueRef>,
}

/// The prompt as the model will see it, and every issue it is against.
///
/// Two sources, one answer: the `#ABC-123` tags already in the text, and
/// identifiers named outright — `dray new --issue`, the only caller that does.
/// A named issue that is not already tagged in the text
/// is **appended as a tag**, in the same `#DRA-53 Title` form the composer's
/// picker writes, so there is one shape a tag takes and one thing the
/// transcript has to draw. Nothing is appended for an issue the text already
/// names: the reader wrote it, and repeating it under their own sentence is the
/// same fact twice.
///
/// **Best effort, always.** A send must never fail because Linear is
/// unreachable, a key has been revoked, or a tag names an issue that does not
/// exist: the tag stays in the text, the link is not recorded, and nothing is
/// said. The reverse — refusing the prompt — would make an issue tracker a
/// dependency of typing.
///
/// **Best effort does not extend to losing a named issue.** A tag the reader
/// wrote is *in the prompt already*, so an unresolved one costs its title and
/// nothing else. One arriving through `--issue` is not: dropping it left the
/// model a prompt with no mention of the work at all, and answered identically
/// to success — the caller asked for a session about `DRA-53` and got one about
/// nothing. So a named issue that could not be resolved is appended bare and
/// linked bare, exactly as `dray issue link` writes one. Absent metadata is an
/// ordinary state here, not an error.
///
/// Sequential rather than concurrent: a prompt carries a handful of tags at
/// most, and one at a time keeps the order they were written in.
/// A link with the identifier and nothing else — what is written down when the
/// tracker could not be asked, and what `dray issue link` writes when its caller
/// passes no `--title`. `tag_text` drops the trailing space for one of these and
/// `issueUrl` reads the empty address as none, so it draws as coloured text
/// rather than a button opening nowhere.
fn bare_ref(identifier: String) -> IssueRef {
    IssueRef {
        tracker: IssueTracker::Linear,
        id: identifier.clone(),
        identifier,
        title: String::new(),
        url: String::new(),
    }
}

pub async fn expand_tags(prompt: &str, named: &[String]) -> ExpandedTags {
    let wanted = wanted_tags(prompt, named);

    if wanted.is_empty() {
        return ExpandedTags {
            prompt: prompt.to_string(),
            mentioned: Vec::new(),
            linked: Vec::new(),
        };
    }

    // `None` is ordinary: nobody has connected a tracker. The named issues below
    // still have to reach the prompt, so this is not a return.
    let key = read_key(IssueTracker::Linear).await;

    let mut resolved = Vec::with_capacity(wanted.len());
    for WantedTag { id: tag, .. } in &wanted {
        resolved.push(match &key {
            // No id to try: a tag is a spelling, and the whole point of this
            // call is to find out what it names.
            Some(key) => match linear::get_issue(key, tag, None).await {
                Ok(detail) => Some(detail.issue.to_ref()),
                Err(e) => {
                    eprintln!("[issue tag {tag}] {e:?}");
                    None
                }
            },
            None => None,
        });
    }

    apply_tags(prompt, &wanted, resolved)
}

/// One issue this prompt is about, and how it came to be here.
///
/// Two flags rather than one, because they answer different questions and an
/// issue can be both: `in_text` decides whether a tag has to be *appended*, and
/// `named` decides whether the session gets *linked*. Folded into one, an
/// `--issue DRA-53` on a prompt that also writes `#DRA-53` deduplicated onto the
/// in-text entry and lost the link the caller asked for outright.
#[derive(Debug, PartialEq)]
struct WantedTag {
    id: String,
    in_text: bool,
    named: bool,
}

/// Every issue this prompt is about. Text first, in the order it was written;
/// anything `--issue` named and the text did not, after.
fn wanted_tags(prompt: &str, named: &[String]) -> Vec<WantedTag> {
    let mut wanted: Vec<WantedTag> = issue_tags(prompt)
        .into_iter()
        .map(|id| WantedTag {
            id,
            in_text: true,
            named: false,
        })
        .collect();

    for identifier in named {
        // Through the same parse the text goes through: a caller may write
        // `#DRA-53` or `dra-53`, and both have to reach the issue the picker
        // would have.
        if let Some(id) = parse_identifier(identifier.trim_start_matches('#')) {
            match wanted.iter_mut().find(|seen| seen.id == id) {
                // The text names it too. One entry still, so nothing is
                // appended twice — but naming it outright is what links it, and
                // that intent must survive the merge.
                Some(seen) => seen.named = true,
                None => wanted.push(WantedTag {
                    id,
                    in_text: false,
                    named: true,
                }),
            }
        }
    }

    wanted
}

/// Builds the prompt the model is given and the links recorded beside it, from
/// whatever the tracker managed to answer.
///
/// Split from the read above so the rule is testable without a key and without
/// a network: what happens when nothing resolves is exactly the case worth
/// pinning, and it is the one a test process cannot reach by asking Linear.
fn apply_tags(
    prompt: &str,
    wanted: &[WantedTag],
    resolved: Vec<Option<IssueRef>>,
) -> ExpandedTags {
    let mut mentioned = Vec::new();
    let mut linked = Vec::new();
    let mut appended = Vec::new();

    for (tag, found) in wanted.iter().zip(resolved) {
        let reference = match found {
            Some(reference) => reference,
            // A tag the reader typed is already in the text and already says
            // what it says, so an unresolved one is left alone. A named one is
            // a link that was asked for, so it goes in bare rather than being
            // lost — in the text already or not.
            None if !tag.named => continue,
            None => bare_ref(tag.id.clone()),
        };

        // Only what the text does not already say: repeating a tag under the
        // reader's own sentence is the same fact twice.
        if !tag.in_text {
            appended.push(tag_text(&reference));
        }
        // Naming an issue outright is what links it. A `#DRA-53` in prose is a
        // mention, whether or not `--issue` also named it.
        if tag.named {
            linked.push(reference.clone());
        }
        mentioned.push(reference);
    }

    let text = if appended.is_empty() {
        prompt.to_string()
    } else {
        format!("{prompt}\n\n{}", appended.join("\n"))
    };

    ExpandedTags {
        prompt: text,
        mentioned,
        linked,
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// What the settings dialog draws. `None` is a tracker nobody has connected.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsView {
    pub linear: Option<TrackerAccount>,
}

/// The connected accounts.
///
/// Read from two files at once, deliberately: `credentials.json` says whether
/// there is a key, and `settings.json` remembers whose it is. A cached account with
/// no key behind it reads as disconnected — the key *is* the connection, and
/// the cache only saves a round trip to draw a name.
#[tauri::command]
pub async fn get_integrations() -> IntegrationsView {
    let cached = settings::read().await.linear_account;
    let connected = read_key(IssueTracker::Linear).await.is_some();

    IntegrationsView {
        linear: connected.then_some(cached).flatten(),
    }
}

/// Validates a personal API key, then saves it.
///
/// Validated first, always: a key stored without being tried is one the reader
/// finds out about the next time they open the picker, by which point they have
/// left settings and the failure looks like the feature being broken. The
/// identity comes back from the same call, which is what the row draws.
#[tauri::command]
pub async fn connect_linear(key: String) -> Result<IntegrationsView, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("Paste a Linear API key first.".into());
    }

    let account = linear::verify(&key).await.map_err(|e| match e {
        IssueUnavailable::Unauthorized => {
            "Linear rejected that key. Check it was copied whole and has not been revoked."
                .to_string()
        }
        IssueUnavailable::Offline(detail) => format!("Could not reach Linear: {detail}"),
        IssueUnavailable::Other(detail) => detail,
        IssueUnavailable::NotConnected => "No key.".to_string(),
    })?;

    write_key(IssueTracker::Linear, &key).await?;

    let mut next = settings::read().await;
    next.linear_account = Some(account);
    settings::write(&next).await.map_err(|e| e.to_string())?;

    Ok(get_integrations().await)
}

/// Forgets the key and the account. Sessions keep their linked issues: a link
/// records what the work was about, and it stays readable — identifier and
/// title are already on it — whether or not anyone can still reach the tracker.
#[tauri::command]
pub async fn disconnect_linear() -> Result<IntegrationsView, String> {
    delete_key(IssueTracker::Linear).await?;

    let mut next = settings::read().await;
    next.linear_account = None;
    settings::write(&next).await.map_err(|e| e.to_string())?;

    Ok(get_integrations().await)
}

/// Issues matching `query`, best first.
///
/// One command behind both the page and the composer's `#` picker, because they
/// ask the same question with different filters — two commands would be two
/// orderings of one list, which reads as the picker disagreeing with the page
/// about which issue is most urgent.
#[tauri::command]
pub async fn list_issues(query: IssueQuery, limit: usize) -> Result<Vec<Issue>, IssueUnavailable> {
    let key = read_key(IssueTracker::Linear).await.ok_or(IssueUnavailable::NotConnected)?;

    linear::list_issues(&key, &query, limit).await
}

/// One issue, opened — description and comments included.
///
/// `id` is optional because the caller does not always have one: the panel is
/// drawing a link that already carries the tracker's own id, while the page is
/// opening a row it just read. Passing it is what keeps an issue readable after
/// it moves team and its identifier renumbers.
#[tauri::command]
pub async fn get_issue(
    identifier: String,
    id: Option<String>,
) -> Result<IssueDetail, IssueUnavailable> {
    let key = read_key(IssueTracker::Linear).await.ok_or(IssueUnavailable::NotConnected)?;

    linear::get_issue(&key, &identifier, id.as_deref()).await
}

/// A file uploaded to an issue, fetched with the stored key.
///
/// **The whole reason this command exists.** Linear's uploads live behind the
/// same auth the API does, so the `<img src>` in a description resolves to a
/// 401 and the webview draws its broken-image box — which reads as "Dray cannot
/// show this" rather than "this needs a key". Fetching here and handing back a
/// `data:` URL is what makes an image in an issue an image on screen.
///
/// Bytes rather than a signed URL because Linear issues none, and `data:`
/// rather than a local file because these are read once and thrown away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueAsset {
    /// `image/png`, `text/plain`… as the server reported it.
    pub mime: String,
    /// `data:<mime>;base64,…`, ready to put in a `src` or an `href`.
    pub data_url: String,
    pub bytes: u64,
}

/// Anything larger is refused rather than read into memory and turned into a
/// string a third bigger again. Well past a screenshot, which is what these
/// nearly always are.
const MAX_ASSET: u64 = 10 * 1024 * 1024;

#[tauri::command]
pub async fn fetch_issue_asset(url: String) -> Result<IssueAsset, IssueUnavailable> {
    let key = read_key(IssueTracker::Linear)
        .await
        .ok_or(IssueUnavailable::NotConnected)?;

    linear::fetch_asset(&key, &url, MAX_ASSET).await
}

/// The teams and projects the filter row offers.
#[tauri::command]
pub async fn list_issue_filters() -> Result<IssueFilters, IssueUnavailable> {
    let key = read_key(IssueTracker::Linear).await.ok_or(IssueUnavailable::NotConnected)?;

    linear::list_filters(&key).await
}

/// Tags a session with an issue, by identifier.
///
/// Reads the issue back before recording it, so the link carries the current
/// title rather than whatever the caller believed — the CLI passes a string a
/// person typed, and the picker one it read a moment ago.
/// Untags a session. The issue itself is untouched — this app never writes to
/// the tracker, so removing a link is a fact about the session alone.
#[tauri::command]
pub async fn unlink_issue(
    session_id: String,
    key: String,
) -> Result<Vec<IssueRef>, IssueUnavailable> {
    store::unlink_session_issue(&session_id, &key)
        .await
        .map_err(IssueUnavailable::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_ref(identifier: &str, title: &str) -> IssueRef {
        IssueRef {
            tracker: IssueTracker::Linear,
            id: format!("uuid-{identifier}"),
            identifier: identifier.into(),
            title: title.into(),
            url: format!("https://linear.app/x/issue/{identifier}"),
        }
    }

    /// The whole of what this file buys over the keychain it replaced: nobody
    /// but the owner can read it. Worth a test because the failure is silent —
    /// a key written at the process umask sits there world-readable and behaves
    /// identically in every other respect.
    #[test]
    fn a_named_issue_reaches_the_prompt_even_when_nothing_resolves() {
        let wanted = wanted_tags("do the thing", &["DRA-53".into()]);
        // No tracker connected, a revoked key, an unreachable Linear — every
        // one of them arrives here as `None`, and this is the case that used to
        // drop the issue and answer identically to success.
        let out = apply_tags("do the thing", &wanted, vec![None]);

        assert!(
            out.prompt.contains("#DRA-53"),
            "the tag is missing from {:?}",
            out.prompt
        );
        assert_eq!(out.linked.len(), 1);
        assert_eq!(out.linked[0].identifier, "DRA-53");
        // Bare — an identifier and no more, exactly as `dray issue link` writes
        // one with no `--title`.
        assert!(out.linked[0].title.is_empty());
        assert!(out.linked[0].url.is_empty());
    }

    #[test]
    fn a_tag_the_reader_typed_is_left_where_it_is() {
        let prompt = "look at #DRA-53 please";
        let wanted = wanted_tags(prompt, &[]);
        let out = apply_tags(prompt, &wanted, vec![None]);

        // Already in the text, so nothing is appended and nothing is doubled.
        assert_eq!(out.prompt, prompt);
        // And nothing is recorded: the tag says what it says without a link
        // behind it, where a named issue would have been lost entirely.
        assert!(out.mentioned.is_empty());
        assert!(out.linked.is_empty());
    }

    /// The whole of what a tag in prose is: a mention. "unrelated to #DRA-53"
    /// files the session under DRA-53 forever if this ever links again, and the
    /// reader has no way to see it happen. Resolved so the bubble can draw a
    /// button, and only that.
    #[test]
    fn a_tag_the_reader_typed_is_mentioned_but_never_linked() {
        let prompt = "this is unrelated to #DRA-53";
        let wanted = wanted_tags(prompt, &[]);
        let out = apply_tags(prompt, &wanted, vec![Some(issue_ref("DRA-53", "Tracker"))]);

        assert_eq!(out.prompt, prompt);
        assert_eq!(out.mentioned.len(), 1);
        assert!(out.linked.is_empty());
    }

    #[test]
    fn a_named_issue_the_text_already_names_is_not_appended_twice() {
        let prompt = "look at #DRA-53 please";
        let wanted = wanted_tags(prompt, &["dra-53".into()]);

        // One entry, not two: `--issue` naming what the text already names is
        // the same issue, however it was spelled.
        assert_eq!(
            wanted,
            vec![WantedTag {
                id: "DRA-53".to_string(),
                in_text: true,
                named: true,
            }]
        );

        let out = apply_tags(prompt, &wanted, vec![None]);
        assert_eq!(out.prompt, prompt);
        // And the link survives the merge. Deduplicating onto the in-text entry
        // dropped it, so `--issue DRA-53` on a prompt that also wrote `#DRA-53`
        // silently started a session against nothing.
        assert_eq!(out.linked.len(), 1);
        assert_eq!(out.linked[0].identifier, "DRA-53");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_credentials_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "dray-credentials-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("credentials.json");

        let mut creds = HashMap::new();
        creds.insert("linear".to_string(), "lin_api_secret".to_string());
        write_credentials_at(&path, &creds).await.unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "credentials must be owner-only");

        // And the temp file it landed through is gone, not left beside it
        // holding the same key at whatever mode the umask gave.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn a_tag_has_to_open_a_word() {
        assert_eq!(issue_tags("fix #DRA-53 please"), vec!["DRA-53"]);
        assert_eq!(issue_tags("#DRA-53"), vec!["DRA-53"]);
        // A colour, and a markdown heading: both are prose, and neither is an
        // identifier. This is the whole reason the shape is checked at all.
        assert!(issue_tags("use #fff for the border").is_empty());
        assert!(issue_tags("# Heading").is_empty());
        // Mid-word, so not a tag — the same rule `@` mentions follow.
        assert!(issue_tags("channel#DRA-1").is_empty());
    }

    #[test]
    fn punctuation_around_a_tag_is_not_part_of_it() {
        assert_eq!(issue_tags("see (#DRA-53), then stop"), vec!["DRA-53"]);
        assert_eq!(issue_tags("[#dra-7]"), vec!["DRA-7"]);
    }

    #[test]
    fn tags_keep_their_order_and_appear_once() {
        assert_eq!(
            issue_tags("#DRA-2 then #dra-1 and #DRA-2 again"),
            vec!["DRA-2", "DRA-1"]
        );
    }

    #[test]
    fn a_number_alone_is_not_an_identifier() {
        assert!(issue_tags("#53").is_empty());
        assert!(issue_tags("#1-2").is_empty());
        assert!(issue_tags("#DRA-").is_empty());
    }

    /// A tag is an address and a title, and that is the whole of what the model
    /// is handed. Pinned so nobody "improves" it into a context dump — the agent
    /// has the tracker's own MCP server for the rest.
    ///
    /// The frontend writes this exact string when a row is picked
    /// ([applyIssue](../../../src/lib/issue.ts)), so the two are pinned on both
    /// sides: a tag picked from the menu and one appended by `--issue` have to
    /// be the same thing, or the transcript draws two shapes for one idea.
    #[test]
    fn a_tag_is_an_identifier_and_a_title() {
        let text = tag_text(&issue_ref("DRA-53", "Issue tracker integration"));

        assert_eq!(text, "#DRA-53 Issue tracker integration");
        assert!(
            !text.contains("http"),
            "no urls: the identifier is the address"
        );
    }

    #[test]
    fn a_settled_state_is_the_two_that_end_the_work() {
        assert!(IssueStateKind::Completed.settled());
        assert!(IssueStateKind::Canceled.settled());
        assert!(!IssueStateKind::Started.settled());
        assert!(!IssueStateKind::Backlog.settled());
    }

    /// Linear's `0` is "no priority", so ordering by the wire integer puts the
    /// least urgent issues at the top of the page.
    #[test]
    fn priority_ranks_urgent_first_and_unset_last() {
        let mut levels = vec![
            IssuePriority::from_wire(0),
            IssuePriority::from_wire(4),
            IssuePriority::from_wire(1),
            IssuePriority::from_wire(9),
        ];
        levels.sort_by_key(|p| p.rank());

        assert_eq!(
            levels,
            vec![
                IssuePriority::Urgent,
                IssuePriority::Low,
                IssuePriority::None,
                IssuePriority::None
            ]
        );
    }
}
