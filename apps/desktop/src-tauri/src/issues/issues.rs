//! The issue a session is working on, whoever tracks it.
//!
//! Two trackers now, and neither is a word a reader sees: everything on screen
//! is an *issue*, and everything below this file's vocabulary lives in
//! `linear.rs` and `github.rs`. That was the promise this file's header made
//! while there was one — a second tracker is a module and a variant, not a
//! rename of every surface — and it is why [`IssueRef`] has always carried its
//! own [`IssueTracker`].
//!
//! **Which tracker an identifier belongs to is read off its shape**, by
//! [`IssueTracker::of`]: `owner/repo#123` is GitHub's own cross-repo spelling
//! and a `#` cannot appear in a Linear one, so no caller has to be told. A bare
//! `#123` is deliberately refused — a number alone means nothing without a
//! repository beside it, and a prompt is full of them.
//!
//! Two halves, and they answer different questions. The **connection** is the
//! account: Linear's is one personal API key per workspace in
//! `credentials.json`, GitHub's is `gh`'s own token and nothing of ours. A
//! project — or the Space it is filed in — may pin one Linear workspace, and
//! everything else reads the default; no project is bound to a *team*. The
//! GitHub half reads one *repository* at a time, since a number is only
//! addressable within one. The **link** is per session, recorded on its index
//! entry, and it is what draws the panel's tab and what a tag resolves to.

#[path = "github.rs"]
pub mod github;
#[path = "linear.rs"]
pub mod linear;

use std::{collections::HashMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::{settings, store, store::get_home_app_dir};

/// Who tracks the issue. On the wire and on disk, which is what kept a session
/// linked to a Linear issue readable when the second variant landed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum IssueTracker {
    /// The default, and it has to stay so: an [`IssueQuery`] written before the
    /// field existed carries no tracker, and every one of those meant Linear.
    #[default]
    Linear,
    Github,
}

impl IssueTracker {
    /// Which tracker an identifier belongs to, read off its shape alone.
    ///
    /// `owner/repo#123` is GitHub's own cross-repo spelling and a Linear
    /// identifier is a team key and a number, so the `#` tells them apart with
    /// nothing to look up and nothing for a caller to pass. Stated twice — the
    /// frontend's `trackerOf` decides what a *tag* opens, this decides what is
    /// *read* — and pinned on both sides, since neither can call the other.
    ///
    /// Anything that is neither reads as Linear: `parse_identifier` has already
    /// refused what is not an identifier at all, and a spelling this build does
    /// not know is better tried against the tracker it might belong to than
    /// refused outright.
    pub fn of(identifier: &str) -> Self {
        if identifier.contains('#') {
            Self::Github
        } else {
            Self::Linear
        }
    }
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
    /// The Linear workspace (`organization.id`) it was read from. A hint, not
    /// the address: a link written before there could be two has none, and an
    /// older build rewriting the index drops it, so a read without one falls
    /// back through [`key_order`]. Left off the wire when absent, so an index
    /// written before the field reads back byte for byte.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace: Option<String>,
}

/// Where an issue has got to, folded from the tracker's own vocabulary.
///
/// Linear reports a workflow state's `type`, which is this set exactly — the
/// state's *name* is per-team prose ("In Review", "Shipping") and belongs on
/// screen, not in a match arm.
///
/// Declaration order is the sort order: the workflow's, so a status menu reads
/// the way work moves. Linear orders states by type first and by `position`
/// only *within* one, so position alone puts "Done" above "Todo".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
    /// The tracker's own id. What a status write names — a state is addressed
    /// by id and never by name, since two teams can both call one "In Review".
    pub id: String,
    pub name: String,
    pub kind: IssueStateKind,
    /// The tracker's own colour, so a status reads the same here as it does in
    /// the app the reader also has open.
    pub color: String,
}

/// Linear's five levels, by name rather than by its `0..4` integer — where `0`
/// is *no* priority and therefore sorts nothing like a number.
///
/// Declaration order is the sort order, urgent first and unprioritized last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
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

    /// Level back to wire integer. The inverse of [`from_wire`], and the only
    /// place a priority write spells a number.
    ///
    /// [`from_wire`]: Self::from_wire
    pub fn to_wire(self) -> i64 {
        match self {
            Self::Urgent => 1,
            Self::High => 2,
            Self::Medium => 3,
            Self::Low => 4,
            Self::None => 0,
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
    /// Who filed it. A different question from who is *doing* it, and the one
    /// that more often has an answer: an issue is always opened by somebody and
    /// is frequently assigned to nobody — which on GitHub is the ordinary case
    /// rather than a gap.
    #[serde(default)]
    pub author: Option<IssuePerson>,
    pub labels: Vec<IssueLabel>,
    /// Team key (`DRA`) — what the identifier is built from, so a row filtered
    /// across teams still says which one it belongs to.
    pub team: Option<String>,
    pub project: Option<String>,
    pub updated_at: String,
    /// When it was filed. Beside `updated_at` rather than replacing it: the
    /// list row says when the work appeared, the opened issue's own header says
    /// when it last moved, and those are two questions.
    #[serde(default)]
    pub created_at: String,
    /// Pull requests linked to it, by number.
    ///
    /// The one fact both trackers hold about work already under way, told two
    /// ways: GitHub's own `closedByPullRequestsReferences` and the GitHub
    /// attachments Linear's integration writes onto an issue. Numbers alone,
    /// since that is what the chip says — a row that has to be opened to learn
    /// whether anybody has started is the row asking to be clicked through.
    #[serde(default)]
    pub pull_requests: Vec<u32>,
    /// The Linear workspace this row was read from, stamped by the command that
    /// read it — `linear.rs` is handed a key and never learns whose. `None`
    /// under GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace: Option<String>,
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
            workspace: self.workspace.clone(),
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
    /// Every status this issue's own team offers, in workflow order — what the
    /// header's status menu draws.
    ///
    /// On the detail rather than read by a command of its own, because it rides
    /// the read the panel already makes: a menu that has to fetch before it can
    /// open is a menu that opens empty. Per *team*, so an issue moved between
    /// teams offers the states of wherever it now lives.
    pub states: Vec<IssueState>,
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
    /// Which tracker is being asked. `#[serde(default)]` on the struct makes an
    /// absent one Linear, which is what every caller meant before there were
    /// two.
    pub tracker: IssueTracker,
    /// Free text. Matched against title and identifier; an empty query is the
    /// resting state and lists rather than searches.
    pub text: Option<String>,
    pub scope: IssueScope,
    /// Linear team id — and under GitHub the **repository slug**, since a
    /// repository is what an issue there belongs to and what the page reads one
    /// at a time. One field rather than two, because it is one question: which
    /// bucket of the tracker to read.
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    /// One label's name, or `None` for no label filter. The name rather than an
    /// id, since that is what `gh issue list --label` takes and what a label is
    /// addressed by on GitHub.
    pub label: Option<String>,
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
    /// Which Linear workspace to read, by `organization.id`. `None` is the
    /// default workspace; ignored under GitHub.
    pub workspace: Option<String>,
}

/// The filter row's options, read once per connection rather than per keystroke.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IssueFilters {
    pub teams: Vec<IssueGroup>,
    pub projects: Vec<IssueGroup>,
    /// The labels the filter row offers, with the colours they are drawn in.
    ///
    /// **Per repository, not per workspace**, which is why `list_issue_filters`
    /// takes the repository it is being asked about: a label is one repo's own
    /// vocabulary, and a list gathered across several would offer rows that
    /// match nothing in the one on screen. Empty for Linear, where the section
    /// is simply not drawn.
    #[serde(default)]
    pub labels: Vec<IssueLabel>,
    /// Every team's workflow states, keyed by team **key** (`DRA`) — what a
    /// row carries, where `teams` above is keyed by UUID.
    ///
    /// Here rather than on each issue because a workflow belongs to a team: one
    /// answer serves every row that team owns, so the issues page's status menus
    /// cost one read per connection instead of a copy per row.
    pub team_states: HashMap<String, Vec<IssueState>>,
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
    /// Linear's `organization.id`, which is what tells one connected workspace
    /// from another. `None` under GitHub, and on an account cached before there
    /// could be two — which is what sends [`linear_workspaces`] to ask again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    /// The workspace's slug in its URLs, `linear.app/<url_key>/…`. For matching
    /// a link back to its workspace and nothing else: an admin can rename it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url_key: Option<String>,
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
    /// The tracker answered, and has no such issue. Apart from `Other` because
    /// it is the one failure that lets a lookup go on to another workspace:
    /// anything else might hide the right issue behind a refusal.
    NotFound(String),
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
                "Dray is not connected to an issue tracker. Connect Linear in Dray's settings, \
                 or sign in to GitHub with `gh auth login`."
            ),
            Self::Unauthorized => write!(
                f,
                "Linear rejected the key stored for this workspace. Reconnect it in Dray's settings."
            ),
            Self::Offline(detail) => write!(f, "Could not reach Linear: {detail}"),
            Self::NotFound(detail) | Self::Other(detail) => write!(f, "{detail}"),
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

/// What the **default** Linear workspace's key is filed under, on disk. The
/// only entry an older build knows to read, which is why the default never
/// leaves it. GitHub's credential is `gh`'s own and Dray stores none.
const LINEAR_CREDENTIAL: &str = "linear";

/// Every further Linear workspace is filed as `linear/<organization id>`.
const LINEAR_EXTRA_PREFIX: &str = "linear/";

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

    // A file that exists and cannot be read or parsed reads as no key, which
    // presents as "not connected" and is curable by connecting again. Absent
    // is the ordinary case, and `read_json` says nothing about it.
    crate::store::read_json(&path).await.unwrap_or_else(|e| {
        eprintln!("[credentials read err] {e:#}");
        HashMap::new()
    })
}

/// One connected Linear workspace, key included. Never handed to the frontend:
/// [`TrackerAccount`] is the half that is.
#[derive(Debug, Clone)]
struct LinearWorkspace {
    /// `linear` for the default, `linear/<org id>` for the rest.
    entry: String,
    key: String,
    account: TrackerAccount,
    /// Other entries filing this same workspace, with their keys, from the same
    /// read — what an older build can leave beside the default.
    also: Vec<(String, String)>,
}

impl LinearWorkspace {
    fn id(&self) -> Option<&str> {
        self.account.workspace_id.as_deref()
    }
}

fn extra_entry(workspace: &str) -> String {
    format!("{LINEAR_EXTRA_PREFIX}{workspace}")
}

/// The stored Linear keys by entry: the default first, the rest in entry order
/// so every reader agrees which one is promoted next. An empty key reads as
/// absent, the same as a missing entry.
fn linear_entries(creds: &HashMap<String, String>) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = creds
        .iter()
        .filter(|(entry, _)| *entry == LINEAR_CREDENTIAL || entry.starts_with(LINEAR_EXTRA_PREFIX))
        .map(|(entry, key)| (entry.clone(), key.trim().to_string()))
        .filter(|(_, key)| !key.is_empty())
        .collect();
    entries.sort_by(|(a, _), (b, _)| {
        (a != LINEAR_CREDENTIAL, a).cmp(&(b != LINEAR_CREDENTIAL, b))
    });
    entries
}

/// Moves the next workspace into the default slot where that slot is empty and
/// others are connected. Answers whether anything moved.
///
/// Everything here leans on one invariant — if any Linear workspace is
/// connected, `linear` holds one — and two things break it: disconnecting the
/// default, and an older build disconnecting, since the default is the only
/// entry it knows to remove.
fn repair_default(creds: &mut HashMap<String, String>) -> bool {
    let Some((entry, key)) = linear_entries(creds).into_iter().next() else {
        return false;
    };
    if entry == LINEAR_CREDENTIAL {
        return false;
    }

    creds.remove(&entry);
    creds.insert(LINEAR_CREDENTIAL.to_string(), key);
    true
}

/// Replaces `account`'s cached row, matched on workspace.
fn remember(accounts: &mut Vec<TrackerAccount>, account: TrackerAccount) {
    accounts.retain(|known| known.workspace_id != account.workspace_id);
    accounts.push(account);
}

/// A key's fingerprint: enough to tell two keys apart, never enough to be one.
fn fingerprint(key: &str) -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(key.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// How long a key Linear would not verify is left alone before it is asked
/// again. Every Linear command lists the workspaces, so without this a revoked
/// key costs a `viewer` round trip on each picker keystroke and each image.
const VERIFY_RETRY: std::time::Duration = std::time::Duration::from_secs(60);

/// Keys whose verify failed, by fingerprint, and when. In memory only: a
/// restart is a fair moment to ask again.
static FAILED_VERIFY: std::sync::Mutex<Vec<(String, std::time::Instant)>> =
    std::sync::Mutex::new(Vec::new());

fn failed_recently(print: &str) -> bool {
    let failed = FAILED_VERIFY.lock().unwrap_or_else(|e| e.into_inner());
    failed
        .iter()
        .any(|(seen, at)| seen == print && at.elapsed() < VERIFY_RETRY)
}

/// [`linear::verify`], skipped for a key that failed within [`VERIFY_RETRY`].
async fn verify_unless_failed(key: &str) -> Result<TrackerAccount, IssueUnavailable> {
    if failed_recently(&fingerprint(key)) {
        return Err(IssueUnavailable::Other("failed a moment ago".into()));
    }
    linear::verify(key).await
}

fn note_failed(print: String) {
    let mut failed = FAILED_VERIFY.lock().unwrap_or_else(|e| e.into_inner());
    failed.retain(|(seen, at)| *seen != print && at.elapsed() < VERIFY_RETRY);
    failed.push((print, std::time::Instant::now()));
}

/// Whether an account came from Linear rather than standing in for a key it
/// would not answer for. Only a verified account is ever remembered as the
/// default's: a stand-in written there would never be asked about again.
fn verified(account: &TrackerAccount) -> bool {
    account.workspace_id.is_some() && !account.user_id.is_empty()
}

/// Every connected Linear workspace, the default first.
///
/// `credentials.json` says what is connected and `settings.json` only
/// remembers whose each key is. An entry with no remembered account — one
/// written before there could be two, or one an older build wiped by rewriting
/// settings without the field — is asked of Linear once and remembered, so this
/// reaches the network only the first time. The default's account is trusted
/// only for the key it was learned from (`linear_account_key`). A key Linear
/// will not answer for still lists, under whatever is known about it, rather
/// than vanishing: its settings row is where the reader disconnects it, and it
/// is not asked again for [`VERIFY_RETRY`].
///
/// Unreadable credentials read as *not connected* rather than as an error — the
/// cure is the same either way, which is to connect again.
async fn linear_workspaces() -> Vec<LinearWorkspace> {
    let mut creds = read_credentials().await;
    if repair_default(&mut creds) {
        let _guard = CREDENTIALS_LOCK.lock().await;
        // Re-read under the lock, so the repair is written only if it still
        // holds against whatever landed in between.
        creds = read_credentials().await;
        if repair_default(&mut creds) {
            if let Err(e) = write_credentials(&creds).await {
                eprintln!("[credentials repair err] {e}");
            }
        }
    }

    let cached = settings::read().await;
    let mut learned: Vec<(bool, TrackerAccount, String)> = Vec::new();
    let mut workspaces: Vec<LinearWorkspace> = Vec::new();

    for (entry, key) in linear_entries(&creds) {
        let is_default = entry == LINEAR_CREDENTIAL;
        let named = entry.strip_prefix(LINEAR_EXTRA_PREFIX).map(str::to_string);

        let remembered = if is_default {
            let same_key = cached.linear_account_key.as_deref() == Some(fingerprint(&key).as_str());
            cached.linear_account.clone().filter(|account| same_key && verified(account))
        } else {
            cached
                .linear_workspaces
                .iter()
                .find(|account| account.workspace_id == named)
                .cloned()
        };

        let account = match remembered {
            Some(account) => account,
            None => match verify_unless_failed(&key).await {
                Ok(account) => {
                    learned.push((is_default, account.clone(), fingerprint(&key)));
                    account
                }
                Err(e) => {
                    if !failed_recently(&fingerprint(&key)) {
                        eprintln!("[linear workspace {entry}] {e:?}");
                        note_failed(fingerprint(&key));
                    }
                    TrackerAccount {
                        tracker: IssueTracker::Linear,
                        user_id: String::new(),
                        user_name: String::new(),
                        org_name: cached
                            .linear_account
                            .as_ref()
                            .filter(|_| is_default)
                            .map(|account| account.org_name.clone())
                            .unwrap_or_else(|| "Linear".to_string()),
                        workspace_id: named,
                        url_key: None,
                    }
                }
            },
        };

        // One workspace connected twice — an older build reconnecting the
        // default with a key for a workspace already filed as an extra — lists
        // once, under the default.
        if let Some(seen) = workspaces
            .iter_mut()
            .find(|seen| account.workspace_id.is_some() && seen.account.workspace_id == account.workspace_id)
        {
            seen.also.push((entry, key));
            continue;
        }

        workspaces.push(LinearWorkspace { entry, key, account, also: Vec::new() });
    }

    if !learned.is_empty() {
        let written = settings::update(|next| {
            for (is_default, account, print) in learned {
                if is_default {
                    next.linear_account = Some(account.clone());
                    next.linear_account_key = Some(print);
                }
                remember(&mut next.linear_workspaces, account);
            }
        })
        .await;
        if let Err(e) = written {
            eprintln!("[settings write err] linear workspaces not remembered: {e:#}");
        }
    }

    workspaces
}

/// The named workspace, or the default where `None`. A workspace that is named
/// and not connected answers nothing, never the default instead: the reader
/// asked about one workspace and must not be answered from another.
fn pick<'a>(all: &'a [LinearWorkspace], workspace: Option<&str>) -> Option<&'a LinearWorkspace> {
    match workspace {
        None => all.first(),
        Some(id) => all.iter().find(|w| w.id() == Some(id)),
    }
}

/// The workspace, and so the key, a read that names one (or means the default)
/// goes out with.
async fn linear_workspace(workspace: Option<&str>) -> Result<LinearWorkspace, IssueUnavailable> {
    pick(&linear_workspaces().await, workspace)
        .cloned()
        .ok_or(IssueUnavailable::NotConnected)
}

/// The order to try workspaces in when nothing names one for certain: each
/// preferred id as given, then the default, then the rest. An id nothing is
/// connected under is skipped, and nothing is tried twice.
fn key_order<'a>(all: &'a [LinearWorkspace], preferred: &[Option<&str>]) -> Vec<&'a LinearWorkspace> {
    let named = preferred
        .iter()
        .flatten()
        .filter_map(|id| all.iter().find(|w| w.id() == Some(*id)));

    let mut order: Vec<&LinearWorkspace> = Vec::new();
    for workspace in named.chain(all.iter()) {
        if !order.iter().any(|seen| seen.entry == workspace.entry) {
            order.push(workspace);
        }
    }
    order
}

/// The workspace slug a Linear issue URL carries: `acme` in
/// `https://linear.app/acme/issue/ENG-12/…`.
fn url_key_of(url: &str) -> Option<&str> {
    let slug = url.strip_prefix("https://linear.app/")?.split('/').next()?;
    (!slug.is_empty()).then_some(slug)
}

/// Which connected workspace a Linear URL belongs to, by its slug.
fn workspace_of_url(all: &[LinearWorkspace], url: &str) -> Option<String> {
    let slug = url_key_of(url)?;
    all.iter()
        .find(|w| w.account.url_key.as_deref() == Some(slug))
        .and_then(|w| w.id().map(str::to_string))
}

/// A project's own pin, else its Space's, else `None` for the default.
///
/// A pin naming a workspace that is no longer connected is skipped rather than
/// honoured, so it falls through to the next level instead of reading as
/// nothing at all. Stated again in the frontend's `linearWorkspace.ts`, which
/// needs the answer to open the issues page; neither side can call the other.
pub fn pinned_workspace(
    project: Option<&crate::projects::Project>,
    space_pins: &std::collections::BTreeMap<String, String>,
    connected: &[&str],
) -> Option<String> {
    let project = project?;
    let usable = |pin: &String| connected.contains(&pin.as_str());

    project
        .linear_workspace
        .as_ref()
        .filter(|pin| usable(pin))
        .or_else(|| {
            project
                .space
                .as_ref()
                .and_then(|space| space_pins.get(space))
                .filter(|pin| usable(pin))
        })
        .cloned()
}

/// [`pinned_workspace`] for the project a directory sits in. A worktree sits
/// inside its project, so a session's own `cwd` is enough.
async fn pinned_for_dir(dir: &str, all: &[LinearWorkspace]) -> Option<String> {
    if all.len() < 2 {
        return None;
    }

    let projects = crate::projects::list_projects().await.ok()?;
    let space_pins = settings::read().await.linear_space_pins;
    let connected: Vec<&str> = all.iter().filter_map(LinearWorkspace::id).collect();

    pinned_workspace(
        crate::projects::project_for_dir(&projects, dir),
        &space_pins,
        &connected,
    )
}

/// The workspace a link written without asking Linear belongs to: the one its
/// URL names, else the one its session's project reads. Recorded as an explicit
/// id, so moving the default later does not move the link with it.
pub async fn workspace_for_link(url: Option<&str>, dir: &str) -> Option<String> {
    let all = linear_workspaces().await;

    if let Some(by_url) = url.and_then(|url| workspace_of_url(&all, url)) {
        return Some(by_url);
    }

    match pinned_for_dir(dir, &all).await {
        Some(pinned) => Some(pinned),
        None => all.first().and_then(|w| w.id().map(str::to_string)),
    }
}

/// The connected workspace a Linear issue URL names by its slug, if any —
/// what narrows `dray issue unlink --url` to one workspace's link.
pub async fn workspace_named_by_url(url: &str) -> Option<String> {
    workspace_of_url(&linear_workspaces().await, url)
}

/// Stamps where an issue was read from. `linear.rs` is handed a key and never
/// learns whose, so the caller that chose the key is the one that can say.
fn stamp(mut detail: IssueDetail, workspace: &LinearWorkspace) -> IssueDetail {
    detail.issue.workspace = workspace.id().map(str::to_string);
    detail
}

/// The issue a link or a tag names, looked for across `order`.
///
/// **Linear's own id first, in every workspace**, before any identifier: a UUID
/// names one issue everywhere, so it cannot be answered by the wrong one, where
/// `ENG-12` can exist in two workspaces. Only then the identifier, in order —
/// and past a workspace only when it answers **not found**. A refusal, a rate
/// limit or an outage there says nothing about where the issue lives, and
/// moving on would link another workspace's `ENG-12` in its place.
async fn find_linear(
    order: &[&LinearWorkspace],
    identifier: &str,
    id: Option<&str>,
) -> Result<IssueDetail, IssueUnavailable> {
    let mut first_err = None;

    if let Some(id) = id.filter(|id| linear::is_stable_id(id)) {
        for workspace in order {
            match linear::get_issue_by_id(&workspace.key, id, identifier).await {
                Ok(Some(detail)) => return Ok(stamp(detail, workspace)),
                Ok(None) => {}
                Err(e @ IssueUnavailable::Offline(_)) => return Err(e),
                // Safe to go on: no other workspace can answer for this id.
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
    }

    for workspace in order {
        match linear::get_issue_by_identifier(&workspace.key, identifier).await {
            Ok(detail) => return Ok(stamp(detail, workspace)),
            Err(e @ IssueUnavailable::NotFound(_)) => {
                first_err.get_or_insert(e);
            }
            Err(e) => return Err(e),
        }
    }

    Err(first_err.unwrap_or(IssueUnavailable::NotConnected))
}

/// Writes the file whole at `0600`, the mode riding the temp file's create —
/// see [`store::write_private_atomic`] for why no other order will do.
async fn write_credentials(next: &HashMap<String, String>) -> Result<(), String> {
    write_credentials_at(&credentials_path().await?, next)
}

/// Takes the path so a test can round-trip against a tempdir and read the mode
/// back, rather than writing into the real `~/.dray`.
fn write_credentials_at(
    path: &std::path::Path,
    next: &HashMap<String, String>,
) -> Result<(), String> {
    let body = serde_json::to_string_pretty(next).map_err(|e| e.to_string())?;

    store::write_private_atomic(path, body.as_bytes())
        .map_err(|e| format!("could not write the credentials file: {e}"))
}

/// Files `key` under `entry`, replacing whatever was there.
async fn write_key(entry: &str, key: &str) -> Result<(), String> {
    let _guard = CREDENTIALS_LOCK.lock().await;

    let mut next = read_credentials().await;
    next.insert(entry.to_string(), key.to_string());

    write_credentials(&next).await
}

/// What Disconnect asks of the credentials file. Every key here was read
/// before the lock was taken, which is the whole difficulty: a Make default or
/// a reconnect can land in between.
struct Removal<'a> {
    /// Every entry filed for the workspace, the listed one first, each with
    /// the key it held then. One holding anything else now is left alone.
    entries: Vec<(String, &'a str)>,
    /// `linear/<id>`, where the workspace has an id.
    own_entry: Option<String>,
    /// Every other listed workspace's key.
    others: Vec<&'a str>,
}

/// Removes every entry filed for one workspace, promoting the next into the
/// default slot where the default was among them. Answers the key now in the
/// default slot, so the caller can say whose it is.
///
/// Every entry, not the one listed: an older build reconnecting the default can
/// leave the same workspace under `linear` and `linear/<id>` both, and removing
/// one would promote the other straight back.
async fn delete_keys(removal: &Removal<'_>) -> Result<Option<String>, String> {
    let _guard = CREDENTIALS_LOCK.lock().await;

    let mut next = read_credentials().await;
    let removed = remove_checked(&mut next, removal)?;
    repair_default(&mut next);
    let default = next.get(LINEAR_CREDENTIAL).map(|key| key.trim().to_string());

    // Already gone is what the caller asked for, and rewriting the file to say
    // the same thing is work with no reader.
    if removed {
        write_credentials(&next).await?;
    }
    Ok(default)
}

/// [`delete_keys`]'s removal, apart from the file. Answers whether anything
/// was removed.
///
/// The caller clears the workspace's pins next, so what matters is whether it
/// is gone afterwards, and that is judged on the result rather than entry by
/// entry. It is still connected if its key is still anywhere (a Make default
/// moved it), if its listed entry holds a key no other workspace had (it was
/// reconnected there), or if its own `linear/<id>` holds anything (it was
/// reconnected as an extra). Any of those is refused and nothing is written.
/// Another workspace's key in its listed entry is not: that is a promotion
/// after another Disconnect already removed it.
fn remove_checked(creds: &mut HashMap<String, String>, removal: &Removal) -> Result<bool, String> {
    let mut next = creds.clone();
    let mut removed = false;
    for (entry, key) in &removal.entries {
        if next.get(entry).map(|held| held.trim()) == Some(*key) {
            removed |= next.remove(entry).is_some();
        }
    }

    let held = |entry: &str| next.get(entry).map(|held| held.trim()).filter(|held| !held.is_empty());
    let (entry, key) = &removal.entries[0];
    let moved = linear_entries(&next).iter().any(|(_, held)| held == key);
    let replaced = held(entry).is_some_and(|held| !removal.others.contains(&held));
    let reconnected = removal.own_entry.as_deref().and_then(held).is_some();
    if moved || replaced || reconnected {
        return Err("The Linear workspaces changed while that was saving. Try again.".into());
    }

    *creds = next;
    Ok(removed)
}

/// Makes `to` the default by swapping it with the current one's entry, so an
/// older build — which reads the default slot alone — follows the change.
///
/// Both keys are checked against the file under the lock first: they were read
/// before it was taken, and a disconnect landing in between would otherwise
/// have this write a key the reader just asked to forget back into the file.
async fn swap_default(from: &LinearWorkspace, from_id: &str, to: &LinearWorkspace) -> Result<(), String> {
    let _guard = CREDENTIALS_LOCK.lock().await;

    let mut next = read_credentials().await;
    let holds = |entry: &str, key: &str| next.get(entry).map(|held| held.trim()) == Some(key);
    if !holds(LINEAR_CREDENTIAL, &from.key) || !holds(&to.entry, &to.key) {
        return Err("The Linear workspaces changed while that was saving. Try again.".into());
    }
    next.remove(&to.entry);
    next.insert(LINEAR_CREDENTIAL.to_string(), to.key.clone());
    next.insert(extra_entry(from_id), from.key.clone());

    write_credentials(&next).await
}

// ── wire helpers both trackers read with ─────────────────────────────────────

/// A string field, with an empty one read as absent.
fn optional(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn text(value: &serde_json::Value, field: &str) -> String {
    optional(value, field).unwrap_or_default()
}

/// Linked PR numbers, sorted and deduplicated so a row reads the same twice
/// running whatever order the tracker listed them in.
fn pr_numbers(numbers: impl Iterator<Item = u32>) -> Vec<u32> {
    let mut numbers: Vec<u32> = numbers.collect();
    numbers.sort_unstable();
    numbers.dedup();
    numbers
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

/// `DRA-53` out of `DRA-53),`, or `owner/repo#12` out of `owner/repo#12).` —
/// and `None` when what follows the `#` is not an identifier at all.
///
/// **The GitHub shape is tried first**, because it is the narrower one: it
/// needs a slash and a `#`, neither of which a Linear identifier holds, so
/// there is nothing for the two rules to argue over. The other order would
/// reach the same answer today and would stop doing so the day either rule
/// widens.
///
/// A bare `#123` is refused, deliberately. A number alone is meaningful only
/// relative to a repository and a prompt is full of them — `#1` in prose would
/// file a session under whichever repo happened to be nearest.
pub fn parse_identifier(text: &str) -> Option<String> {
    if let Some(id) = parse_github_identifier(text) {
        return Some(id);
    }

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

/// Characters GitHub allows in an owner or a repository name. Deliberately
/// narrow: what this must not do is match a *path* somebody wrote, which is why
/// two segments and a `#` are all required.
fn is_slug_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// `owner/repo#12` out of `owner/repo#12).`, or `None` for anything else.
///
/// **Case is kept as written.** GitHub is case-insensitive on a slug, so
/// uppercasing one would reach the same issue and make the tag in the reader's
/// own sentence disagree with the repository they typed.
fn parse_github_identifier(text: &str) -> Option<String> {
    let (repo, number) = text.split_once('#')?;
    let (owner, name) = repo.split_once('/')?;

    // The owner has to open with something nameable, which is what keeps a
    // leading `/` or a lone `-` out.
    if !owner.chars().next()?.is_ascii_alphanumeric() {
        return None;
    }
    if !owner.chars().all(is_slug_char) || name.is_empty() || !name.chars().all(is_slug_char) {
        return None;
    }

    let digits: String = number.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }

    Some(format!("{repo}#{digits}"))
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

/// A link with the identifier and nothing else — what is written down when the
/// tracker could not be asked, and what `dray issue link` writes when its caller
/// passes no `--title`. `tag_text` drops the trailing space for one of these and
/// `openIssue` reads the empty address as none, so a ⌘-click on its tag opens
/// no page rather than one that is not there.
fn bare_ref(identifier: String, workspace: Option<&str>) -> IssueRef {
    // By shape, like everything else that has to name a tracker without being
    // told one: a bare link is written down exactly when the tracker could not
    // be asked, so the spelling is all there is to go on.
    let tracker = IssueTracker::of(&identifier);

    IssueRef {
        tracker,
        id: identifier.clone(),
        identifier,
        title: String::new(),
        url: String::new(),
        workspace: match tracker {
            IssueTracker::Linear => workspace.map(str::to_string),
            IssueTracker::Github => None,
        },
    }
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
///
/// **A Linear tag is looked for in the workspace `dir`'s project reads
/// first**, then the default, then the rest. `ENG-12` can exist in two
/// workspaces, so the order is the whole of which one a tag means: the picker
/// only ever offers the project's own, and a tag typed by hand is taken to mean
/// the same.
pub async fn expand_tags(prompt: &str, named: &[String], dir: &str) -> ExpandedTags {
    let wanted = wanted_tags(prompt, named);

    if wanted.is_empty() {
        return ExpandedTags {
            prompt: prompt.to_string(),
            mentioned: Vec::new(),
            linked: Vec::new(),
        };
    }

    // Empty is ordinary: nobody has connected Linear. The named issues below
    // still have to reach the prompt, so this is not a return — and a GitHub
    // tag in the same prompt does not need it at all.
    // A prompt tagging GitHub alone needs none of this, and the list can cost
    // a Linear round trip.
    let wants_linear = wanted
        .iter()
        .any(|tag| IssueTracker::of(&tag.id) == IssueTracker::Linear);
    let all = if wants_linear { linear_workspaces().await } else { Vec::new() };
    let pinned = pinned_for_dir(dir, &all).await;
    let order = key_order(&all, &[pinned.as_deref()]);
    // What a named issue nobody could resolve is filed under: the workspace it
    // would have been looked for in first.
    let fallback = order.first().and_then(|w| w.id());

    let mut resolved = Vec::with_capacity(wanted.len());
    for WantedTag { id: tag, .. } in &wanted {
        // Per tag, by shape: one prompt can name issues on both trackers, and
        // nothing above here has been told which.
        let found = match IssueTracker::of(tag) {
            // No id to try: a tag is a spelling, and the whole point of this
            // call is to find out what it names.
            IssueTracker::Linear => find_linear(&order, tag, None).await,
            IssueTracker::Github => github::get_issue(tag).await,
        };

        resolved.push(match found {
            Ok(detail) => Some(detail.issue.to_ref()),
            // Best effort, always: a send must never fail because a tracker is
            // unreachable, so the tag stays as text and nothing is said.
            Err(IssueUnavailable::NotConnected) => None,
            Err(e) => {
                eprintln!("[issue tag {tag}] {e:?}");
                None
            }
        });
    }

    apply_tags(prompt, &wanted, resolved, fallback)
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
    workspace: Option<&str>,
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
            None => bare_ref(tag.id.clone(), workspace),
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

/// What the settings dialog draws.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsView {
    /// Every connected Linear workspace, **the default first**. Empty is
    /// Linear not connected.
    pub linear: Vec<TrackerAccount>,
    /// Space name → the Linear workspace its projects read, where one is
    /// pinned. Here rather than on a Space because a Space has no record of its
    /// own to put it on.
    pub linear_space_pins: std::collections::BTreeMap<String, String>,
    pub github: Option<TrackerAccount>,
}

/// The connected accounts.
///
/// **Two connections that mean different things.** Linear's is read from two
/// files at once: `credentials.json` says which keys there are and
/// `settings.json` remembers whose each is, so a cached account with no key
/// behind it reads as disconnected — the key *is* the connection, and the cache
/// only saves a round trip to draw a name. GitHub's is `gh`'s own token, which
/// Dray neither holds nor can invalidate, so the only honest question is
/// whether the CLI still answers.
///
/// Asked only where `gh` resolves, so a machine that has never had the CLI
/// spawns nothing to find out it has not.
#[tauri::command]
pub async fn get_integrations() -> IntegrationsView {
    let linear = linear_workspaces()
        .await
        .into_iter()
        .map(|workspace| workspace.account)
        .collect();

    let github = match crate::binpath::gh().await {
        Some(_) => github::account().await.ok(),
        None => None,
    };

    IntegrationsView {
        linear,
        linear_space_pins: settings::read().await.linear_space_pins,
        github,
    }
}

/// `owner/repo` for the session's own checkout, or `None`.
///
/// What the composer's `#` picker asks before it reads: under GitHub the useful
/// list is *this repository's* issues, and nothing else in the frontend knows
/// which repository a session sits in. No network — a remote is read out of the
/// repository's own config — so the frontend caches it per directory.
#[tauri::command]
pub async fn github_repo(cwd: String) -> Option<String> {
    crate::git::github_slug(&cwd).await
}

/// Validates a personal API key, then saves it as a workspace.
///
/// Validated first, always: a key stored without being tried is one the reader
/// finds out about the next time they open the picker, by which point they have
/// left settings and the failure looks like the feature being broken. The
/// identity comes back from the same call, which is what the row draws — and
/// which workspace it is, since a Linear key belongs to exactly one.
///
/// A key for a workspace already connected **replaces** that workspace's key
/// rather than adding a second row: it is the same workspace, reauthorized.
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
        IssueUnavailable::NotFound(detail) | IssueUnavailable::Other(detail) => detail,
        IssueUnavailable::NotConnected => "No key.".to_string(),
    })?;

    let Some(id) = account.workspace_id.clone() else {
        return Err("Linear did not say which workspace that key belongs to.".into());
    };

    let connected = linear_workspaces().await;
    let is_default = match connected.first() {
        None => true,
        Some(default) => default.id() == Some(id.as_str()),
    };
    let entry = if is_default {
        LINEAR_CREDENTIAL.to_string()
    } else {
        extra_entry(&id)
    };

    write_key(&entry, &key).await?;

    settings::update(|next| {
        if is_default {
            next.linear_account = Some(account.clone());
            next.linear_account_key = Some(fingerprint(&key));
        }
        remember(&mut next.linear_workspaces, account);
    })
    .await
    .map_err(|e| e.to_string())?;

    // After the key and the account are both down, so this reports a connection
    // that exists rather than an attempt. The account itself is never sent —
    // only that a tracker is now connected, or that another workspace is.
    crate::analytics::feature_used(if connected.is_empty() {
        "linear_connected"
    } else {
        "linear_workspace_added"
    });

    Ok(get_integrations().await)
}

/// Forgets one workspace's key and account, and every pin naming it. Removing
/// the default promotes the next workspace in its place.
///
/// `None` names the default, which is how a default Linear has never answered
/// for — and so has no id to be named by — is disconnected at all.
///
/// Sessions keep their linked issues: a link records what the work was about,
/// and it stays readable — identifier and title are already on it — whether or
/// not anyone can still reach the tracker.
#[tauri::command]
pub async fn disconnect_linear(workspace: Option<String>) -> Result<IntegrationsView, String> {
    let connected = linear_workspaces().await;
    let Some(target) = pick(&connected, workspace.as_deref()) else {
        // Already gone is what the caller asked for.
        return Ok(get_integrations().await);
    };
    let target_id = target.id().map(str::to_string);
    let was_default = target.entry == LINEAR_CREDENTIAL;

    let mut entries = vec![(target.entry.clone(), target.key.as_str())];
    entries.extend(target.also.iter().map(|(entry, key)| (entry.clone(), key.as_str())));
    let removal = Removal {
        entries,
        own_entry: target_id.as_deref().map(extra_entry),
        others: connected
            .iter()
            .filter(|w| w.entry != target.entry)
            .map(|w| w.key.as_str())
            .collect(),
    };
    let new_default = delete_keys(&removal).await?;

    // Whose the promoted key is, where this listing knows it for certain;
    // otherwise nothing, and the next read asks Linear.
    let promoted = new_default.as_deref().and_then(|key| {
        connected
            .iter()
            .find(|w| w.key == key && verified(&w.account))
            .map(|w| (w.account.clone(), fingerprint(key)))
    });

    settings::update(|next| {
        if let Some(id) = target_id.as_deref() {
            next.linear_workspaces
                .retain(|account| account.workspace_id.as_deref() != Some(id));
            next.linear_space_pins.retain(|_, pin| pin != id);
        }
        if was_default {
            next.linear_account = promoted.as_ref().map(|(account, _)| account.clone());
            next.linear_account_key = promoted.map(|(_, print)| print);
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(id) = target_id.as_deref() {
        crate::projects::clear_linear_workspace(id)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(get_integrations().await)
}

/// Makes a connected workspace the default: what an unpinned project reads.
#[tauri::command]
pub async fn set_default_linear_workspace(workspace: String) -> Result<IntegrationsView, String> {
    let connected = linear_workspaces().await;
    let Some(target) = pick(&connected, Some(&workspace)) else {
        return Err("That Linear workspace is not connected.".into());
    };
    let current = &connected[0];
    if target.entry == current.entry {
        return Ok(get_integrations().await);
    }
    // The current default has to move to an entry named by its own id, and a
    // key Linear has never answered for has none to move to.
    let Some(current_id) = current.id() else {
        return Err(format!(
            "Linear has not said which workspace {}'s key belongs to. Disconnect it first.",
            current.account.org_name
        ));
    };

    swap_default(current, current_id, target).await?;

    // Only an account Linear answered for is remembered as the default's; a
    // stand-in there would never be asked about again.
    let account = verified(&target.account).then(|| target.account.clone());
    let print = account.as_ref().map(|_| fingerprint(&target.key));
    settings::update(|next| {
        next.linear_account = account;
        next.linear_account_key = print;
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(get_integrations().await)
}

/// Pins a Space to a Linear workspace, or clears its pin with `None`. Every
/// project filed in the Space reads it, unless the project pins its own.
#[tauri::command]
pub async fn set_space_linear_workspace(
    space: String,
    workspace: Option<String>,
) -> Result<IntegrationsView, String> {
    settings::update(|next| match workspace {
        Some(workspace) => {
            next.linear_space_pins.insert(space, workspace);
        }
        None => {
            next.linear_space_pins.remove(&space);
        }
    })
    .await
    .map_err(|e| e.to_string())?;

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
    match query.tracker {
        IssueTracker::Linear => {
            let workspace = linear_workspace(query.workspace.as_deref()).await?;

            let mut issues = linear::list_issues(&workspace.key, &query, limit).await?;
            for issue in &mut issues {
                issue.workspace = workspace.id().map(str::to_string);
            }
            Ok(issues)
        }
        // A number is only addressable within a repository, so there is no
        // workspace-wide read to fall back to — and reading every attached
        // project would be one `gh` spawn per repo for a list nobody asked for.
        IssueTracker::Github => match query.team_id.as_deref().filter(|id| !id.is_empty()) {
            Some(repo) => github::list_issues(repo, &query, limit).await,
            None => Err(IssueUnavailable::Other("Pick a repository".into())),
        },
    }
}

/// One issue, opened — description and comments included.
///
/// `id` is optional because the caller does not always have one: the panel is
/// drawing a link that already carries the tracker's own id, while the page is
/// opening a row it just read. Passing it is what keeps an issue readable after
/// it moves team and its identifier renumbers.
///
/// **A named `workspace` is the only one asked, for a link Linear resolved** —
/// one carrying Linear's own id, which is where it was read. A blind link's
/// workspace was a guess made without asking (`dray issue link`, a tag that did
/// not resolve), so it only goes first, through [`key_order`]: then the
/// workspace its `url` names, then the default, then the rest. So does a link
/// naming none — written before there could be two, or stripped by an older
/// build.
#[tauri::command]
pub async fn get_issue(
    identifier: String,
    id: Option<String>,
    workspace: Option<String>,
    url: Option<String>,
) -> Result<IssueDetail, IssueUnavailable> {
    match IssueTracker::of(&identifier) {
        IssueTracker::Linear => {
            let all = linear_workspaces().await;
            let resolved = id.as_deref().is_some_and(linear::is_stable_id);

            if let Some(named) = pick(&all, workspace.as_deref()).filter(|_| resolved && workspace.is_some()) {
                let detail = linear::get_issue(&named.key, &identifier, id.as_deref()).await?;
                return Ok(stamp(detail, named));
            }

            let by_url = url.as_deref().and_then(|url| workspace_of_url(&all, url));
            let order = key_order(&all, &[workspace.as_deref(), by_url.as_deref()]);

            find_linear(&order, &identifier, id.as_deref()).await
        }
        // `id` goes unread: GitHub redirects a transferred issue on its own
        // side, so the identifier keeps working where a Linear one renumbers.
        IssueTracker::Github => github::get_issue(&identifier).await,
    }
}

/// Moves an issue's status or priority, and answers with the issue as it now
/// stands.
///
/// **The only write this app makes to a tracker.** Everything else here reads:
/// a link is a fact about the session, and status and priority are the two
/// things a reader otherwise leaves the app to change. Assignee, labels and
/// comments stay out — the agent has the tracker's own MCP server for those,
/// and each is a picker over a workspace-wide list this panel has no room for.
///
/// Both fields are optional and `None` means *leave it*, which is why priority
/// arrives as an `Option<IssuePriority>` rather than as a number: "no priority"
/// is a level a reader can choose ([`IssuePriority::None`], wire `0`), so a
/// bare integer could not tell clearing one from not touching it.
///
/// Re-read afterwards rather than trusting the mutation's own echo: the panel
/// draws a whole [`IssueDetail`], and one read is what keeps description,
/// comments and the new status arriving as one answer.
#[tauri::command]
pub async fn update_issue(
    identifier: String,
    id: String,
    state_id: Option<String>,
    priority: Option<IssuePriority>,
    workspace: Option<String>,
) -> Result<IssueDetail, IssueUnavailable> {
    if let IssueTracker::Github = IssueTracker::of(&identifier) {
        // **GitHub has no priority field at all**, so this is a refusal rather
        // than a write that quietly does nothing. The menu is not drawn for a
        // GitHub row either — this is the second statement of that, for a
        // caller the frontend does not own.
        if priority.is_some() {
            return Err(IssueUnavailable::Other(
                "GitHub issues have no priority".into(),
            ));
        }

        if let Some(state_id) = state_id.as_deref() {
            github::update_issue(&identifier, state_id).await?;
        }

        return github::get_issue(&identifier).await;
    }

    let workspace = linear_workspace(workspace.as_deref()).await?;

    linear::update_issue(&workspace.key, &id, state_id.as_deref(), priority).await?;

    let detail = linear::get_issue(&workspace.key, &identifier, Some(&id)).await?;
    Ok(stamp(detail, &workspace))
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

/// An upload is fetched with the key of the issue it came from: `workspace`,
/// passed by the panel drawing that issue. Then the workspace the URL's first
/// segment names, then the default, then the rest — but only past a refusal,
/// since a key from the wrong workspace is refused and any other failure would
/// be the same under every key.
#[tauri::command]
pub async fn fetch_issue_asset(
    url: String,
    workspace: Option<String>,
) -> Result<IssueAsset, IssueUnavailable> {
    let all = linear_workspaces().await;
    let owner = linear::upload_org(&url);
    let order = key_order(&all, &[workspace.as_deref(), owner.as_deref()]);

    let mut first_err = None;
    for workspace in order {
        match linear::fetch_asset(&workspace.key, &url, MAX_ASSET).await {
            Ok(asset) => return Ok(asset),
            Err(e @ IssueUnavailable::Unauthorized) => {
                first_err.get_or_insert(e);
            }
            Err(e) => return Err(e),
        }
    }

    Err(first_err.unwrap_or(IssueUnavailable::NotConnected))
}

/// The teams and projects the filter row offers — or, under GitHub, the
/// repositories, which is the same question about a different bucket.
#[tauri::command]
pub async fn list_issue_filters(
    tracker: IssueTracker,
    repo: Option<String>,
    workspace: Option<String>,
) -> Result<IssueFilters, IssueUnavailable> {
    match tracker {
        IssueTracker::Linear => {
            let workspace = linear_workspace(workspace.as_deref()).await?;

            linear::list_filters(&workspace.key).await
        }
        // The repository decides the labels, so this read moves with the pick
        // rather than being made once per connection the way Linear's is.
        IssueTracker::Github => github::list_filters(repo.as_deref()).await,
    }
}

/// Untags a session. The issue itself is untouched: a link is a fact about the
/// session, and the only write this app makes to a tracker is [`update_issue`],
/// which a reader has to ask for by name.
///
/// **Exactly the row the panel drew** — its id and its workspace, `None`
/// included — since the panel holds the whole link. A row written before
/// workspaces names none, and read as "any workspace" it took a same-identifier
/// link from another workspace with it.
#[tauri::command]
pub async fn unlink_issue(
    session_id: String,
    key: String,
    workspace: Option<String>,
) -> Result<Vec<IssueRef>, IssueUnavailable> {
    store::unlink_exact_session_issue(&session_id, &key, workspace.as_deref())
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
            workspace: None,
        }
    }

    #[test]
    fn a_named_issue_reaches_the_prompt_even_when_nothing_resolves() {
        let wanted = wanted_tags("do the thing", &["DRA-53".into()]);
        // No tracker connected, a revoked key, an unreachable Linear — every
        // one of them arrives here as `None`, and this is the case that used to
        // drop the issue and answer identically to success.
        let out = apply_tags("do the thing", &wanted, vec![None], None);

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
        let out = apply_tags(prompt, &wanted, vec![None], None);

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
        let out = apply_tags(prompt, &wanted, vec![Some(issue_ref("DRA-53", "Tracker"))], None);

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

        let out = apply_tags(prompt, &wanted, vec![None], None);
        assert_eq!(out.prompt, prompt);
        // And the link survives the merge. Deduplicating onto the in-text entry
        // dropped it, so `--issue DRA-53` on a prompt that also wrote `#DRA-53`
        // silently started a session against nothing.
        assert_eq!(out.linked.len(), 1);
        assert_eq!(out.linked[0].identifier, "DRA-53");
    }

    /// The whole of what this file buys over the keychain it replaced: nobody
    /// but the owner can read it. Worth a test because the failure is silent —
    /// a key written at the process umask sits there world-readable and behaves
    /// identically in every other respect.
    #[cfg(unix)]
    #[test]
    fn the_credentials_file_is_owner_only() {
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
        write_credentials_at(&path, &creds).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "credentials must be owner-only");

        // And the temp file it landed through is gone, not left beside it
        // holding the same key.
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(left.len(), 1, "only the credentials file should remain");
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

    /// GitHub's own cross-repo spelling, and the whole of what makes a tag an
    /// address there. Case is kept: GitHub is case-insensitive on a slug, so
    /// uppercasing one would reach the same issue and leave the reader's own
    /// sentence disagreeing with the repository they typed.
    #[test]
    fn a_github_tag_is_a_repository_and_a_number() {
        assert_eq!(
            issue_tags("see #monorepo-labs/dray#121 please"),
            vec!["monorepo-labs/dray#121"]
        );
        assert_eq!(issue_tags("#Owner/Repo.js#7"), vec!["Owner/Repo.js#7"]);
        // The same punctuation rules the Linear shape takes.
        assert_eq!(issue_tags("(#a/b#1),"), vec!["a/b#1"]);
        // One prompt, both trackers: nothing above `expand_tags` is told which
        // one a tag belongs to, so this is the case that has to work.
        assert_eq!(issue_tags("#DRA-53 and #a/b#2"), vec!["DRA-53", "a/b#2"]);
    }

    /// **A bare `#123` is refused on purpose.** A number alone is meaningful
    /// only relative to a repository, and prose is full of them — a tag that
    /// linked one would file a session under whichever repo happened to be
    /// nearest, which is a wrong link that reads exactly like a right one.
    #[test]
    fn a_github_tag_without_a_repository_is_prose() {
        assert!(issue_tags("closes #123").is_empty());
        assert!(issue_tags("#/repo#1").is_empty());
        assert!(issue_tags("#owner/#1").is_empty());
        assert!(issue_tags("#owner/repo#").is_empty());
        // A path is not an identifier, whatever it holds.
        assert!(issue_tags("#src/lib/issue.ts").is_empty());
    }

    /// The shape is what says which tracker to ask, and it is read in two
    /// places that cannot call each other — here and the frontend's
    /// `trackerOf`. Pinned on both sides.
    #[test]
    fn the_tracker_is_read_off_the_spelling() {
        assert_eq!(IssueTracker::of("owner/repo#12"), IssueTracker::Github);
        assert_eq!(IssueTracker::of("DRA-53"), IssueTracker::Linear);
        // A bare link records the identifier in both fields, so this is the
        // path that decides which tracker an unresolved tag is filed under.
        assert_eq!(bare_ref("a/b#1".into(), None).tracker, IssueTracker::Github);
        assert_eq!(bare_ref("DRA-53".into(), None).tracker, IssueTracker::Linear);
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
        levels.sort();

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

    fn creds(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(entry, key)| (entry.to_string(), key.to_string()))
            .collect()
    }

    fn workspace(entry: &str, id: &str, url_key: &str) -> LinearWorkspace {
        LinearWorkspace {
            entry: entry.into(),
            key: format!("key-{id}"),
            account: TrackerAccount {
                tracker: IssueTracker::Linear,
                user_id: "u".into(),
                user_name: "U".into(),
                org_name: id.to_uppercase(),
                workspace_id: Some(id.into()),
                url_key: Some(url_key.into()),
            },
            also: Vec::new(),
        }
    }

    #[test]
    fn the_default_lists_first_and_the_rest_in_entry_order() {
        let entries = linear_entries(&creds(&[
            ("linear/zeta", "k3"),
            ("linear", "k1"),
            ("linear/alpha", "k2"),
            ("openai", "not ours"),
            ("linear/empty", "  "),
        ]));

        let names: Vec<&str> = entries.iter().map(|(entry, _)| entry.as_str()).collect();
        assert_eq!(names, ["linear", "linear/alpha", "linear/zeta"]);
    }

    /// An older build disconnecting removes `linear` and leaves the extras it
    /// cannot see, which would otherwise read as connected with no default.
    #[test]
    fn an_empty_default_slot_is_filled_from_the_next_workspace() {
        let mut map = creds(&[("linear/beta", "kb"), ("linear/alpha", "ka")]);

        assert!(repair_default(&mut map));
        assert_eq!(map.get("linear").map(String::as_str), Some("ka"));
        assert!(!map.contains_key("linear/alpha"));
        assert!(map.contains_key("linear/beta"));

        assert!(!repair_default(&mut map), "a filled slot moves nothing");
        assert!(!repair_default(&mut HashMap::new()));
    }

    fn removal<'a>(entries: &[(&str, &'a str)], own: Option<&str>, others: &[&'a str]) -> Removal<'a> {
        Removal {
            entries: entries.iter().map(|(entry, key)| (entry.to_string(), *key)).collect(),
            own_entry: own.map(str::to_string),
            others: others.to_vec(),
        }
    }

    /// Between Disconnect reading the list and deleting, a Make default can
    /// move the key it chose into `linear`, or a reconnect can put a new key in
    /// its entry. Either way the workspace is still connected, and clearing its
    /// pins on the way out would lose them.
    #[test]
    fn a_disconnect_whose_key_moved_or_was_replaced_is_refused() {
        let extra = removal(&[("linear/a", "ka")], Some("linear/a"), &["kb"]);

        let mut moved = creds(&[("linear", "ka"), ("linear/b", "kb")]);
        let before = moved.clone();
        assert!(remove_checked(&mut moved, &extra).is_err());
        assert_eq!(moved, before, "nothing is removed");

        let mut replaced = creds(&[("linear", "kb"), ("linear/a", "ka2")]);
        assert!(remove_checked(&mut replaced, &extra).is_err());
        assert_eq!(replaced.get("linear/a").map(String::as_str), Some("ka2"));

        // Gone from everywhere is what was asked for.
        let mut gone = creds(&[("linear", "kb")]);
        assert_eq!(remove_checked(&mut gone, &extra), Ok(false));

        let mut held = creds(&[("linear", "kb"), ("linear/a", "ka")]);
        assert_eq!(remove_checked(&mut held, &extra), Ok(true));
        assert!(!held.contains_key("linear/a"));
    }

    /// Two Disconnects of the default: the first removes it and promotes the
    /// next workspace into `linear`. The second finds another workspace's key
    /// there, which is that promotion, not this workspace reconnected.
    #[test]
    fn a_disconnect_another_one_beat_to_it_succeeds() {
        let default = removal(&[("linear", "ka")], Some("linear/a"), &["kb"]);

        let mut promoted = creds(&[("linear", "kb")]);
        assert_eq!(remove_checked(&mut promoted, &default), Ok(false));
        assert_eq!(promoted.get("linear").map(String::as_str), Some("kb"));

        // A key nobody listed is this workspace reauthorized.
        let mut reauthorized = creds(&[("linear", "ka2")]);
        assert!(remove_checked(&mut reauthorized, &default).is_err());
    }

    /// Disconnecting default A while a Make default moves B in and A is then
    /// reconnected as an extra: `linear` holds B's key, which reads as a
    /// promotion, but A's own entry holds a key again, so A is connected.
    #[test]
    fn a_default_reconnected_as_an_extra_is_not_disconnected() {
        let default = removal(&[("linear", "ka")], Some("linear/a"), &["kb"]);
        let mut reconnected = creds(&[("linear", "kb"), ("linear/a", "ka2")]);
        let before = reconnected.clone();
        assert!(remove_checked(&mut reconnected, &default).is_err());
        assert_eq!(reconnected, before);
    }

    /// An older build's duplicate is swept with the default, but only while it
    /// holds the key it was listed with.
    #[test]
    fn a_duplicate_is_swept_only_while_it_holds_its_listed_key() {
        let default = removal(&[("linear", "ka"), ("linear/a", "kold")], Some("linear/a"), &[]);

        let mut both = creds(&[("linear", "ka"), ("linear/a", "kold")]);
        assert_eq!(remove_checked(&mut both, &default), Ok(true));
        assert!(both.is_empty());

        let mut changed = creds(&[("linear", "ka"), ("linear/a", "knew")]);
        assert!(remove_checked(&mut changed, &default).is_err());
        assert_eq!(changed.len(), 2, "nothing is removed");
    }

    #[test]
    fn reconnecting_a_workspace_replaces_its_cached_account() {
        let mut accounts = vec![workspace("linear", "a", "acme").account];
        let mut again = workspace("linear", "a", "acme").account;
        again.user_name = "Renamed".into();

        remember(&mut accounts, again);
        remember(&mut accounts, workspace("linear/b", "b", "jango").account);

        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].user_name, "Renamed");
    }

    #[test]
    fn a_named_workspace_is_the_only_one_picked() {
        let all = [workspace("linear", "a", "acme"), workspace("linear/b", "b", "jango")];

        assert_eq!(pick(&all, None).map(|w| w.entry.as_str()), Some("linear"));
        assert_eq!(pick(&all, Some("b")).map(|w| w.entry.as_str()), Some("linear/b"));
        assert!(pick(&all, Some("gone")).is_none(), "never the default instead");
    }

    #[test]
    fn keys_are_tried_preferred_first_then_default_then_the_rest() {
        let all = [
            workspace("linear", "a", "acme"),
            workspace("linear/b", "b", "jango"),
            workspace("linear/c", "c", "side"),
        ];
        let order = |preferred: &[Option<&str>]| -> Vec<String> {
            key_order(&all, preferred).iter().map(|w| w.entry.clone()).collect()
        };

        assert_eq!(order(&[]), ["linear", "linear/b", "linear/c"]);
        assert_eq!(order(&[Some("c")]), ["linear/c", "linear", "linear/b"]);
        assert_eq!(
            order(&[None, Some("gone"), Some("b"), Some("b")]),
            ["linear/b", "linear", "linear/c"]
        );
    }

    #[test]
    fn a_linear_url_names_its_workspace_by_slug() {
        let all = [workspace("linear", "a", "acme"), workspace("linear/b", "b", "jango")];

        assert_eq!(url_key_of("https://linear.app/jango/issue/JAN-4/fix-it"), Some("jango"));
        assert_eq!(url_key_of("https://linear.app//issue/JAN-4"), None);
        assert_eq!(url_key_of("https://github.com/a/b/issues/4"), None);

        assert_eq!(
            workspace_of_url(&all, "https://linear.app/jango/issue/JAN-4/x").as_deref(),
            Some("b")
        );
        assert_eq!(workspace_of_url(&all, "https://linear.app/other/issue/X-1"), None);
    }

    fn project(space: Option<&str>, pin: Option<&str>) -> crate::projects::Project {
        crate::projects::Project {
            path: "/p".into(),
            name: "p".into(),
            space: space.map(Into::into),
            linear_workspace: pin.map(Into::into),
            last_selected: "2026-09-24T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_project_pin_beats_its_space_pin_which_beats_the_default() {
        let pins: std::collections::BTreeMap<String, String> =
            [("JangoAI".to_string(), "jango".to_string())].into();
        let connected = ["acme", "jango", "side"];
        let read = |p: &crate::projects::Project| pinned_workspace(Some(p), &pins, &connected);

        assert_eq!(read(&project(Some("JangoAI"), Some("side"))).as_deref(), Some("side"));
        assert_eq!(read(&project(Some("JangoAI"), None)).as_deref(), Some("jango"));
        assert_eq!(read(&project(Some("Personal"), None)), None);
        assert_eq!(read(&project(None, None)), None);
        assert_eq!(pinned_workspace(None, &pins, &connected), None);
    }

    /// A pin outliving its workspace falls through a level rather than naming
    /// a workspace no key can read.
    #[test]
    fn a_pin_to_a_disconnected_workspace_is_skipped() {
        let pins: std::collections::BTreeMap<String, String> =
            [("JangoAI".to_string(), "jango".to_string())].into();

        assert_eq!(
            pinned_workspace(Some(&project(Some("JangoAI"), Some("gone"))), &pins, &["acme", "jango"])
                .as_deref(),
            Some("jango")
        );
        assert_eq!(
            pinned_workspace(Some(&project(Some("JangoAI"), None)), &pins, &["acme"]),
            None
        );
    }

    /// The default's remembered account is trusted only for the key it was
    /// learned from, so a fingerprint has to tell keys apart and repeat.
    #[test]
    fn a_fingerprint_tells_keys_apart_without_being_one() {
        assert_eq!(fingerprint("lin_api_one"), fingerprint("lin_api_one"));
        assert_ne!(fingerprint("lin_api_one"), fingerprint("lin_api_two"));
        assert_eq!(fingerprint("lin_api_one").len(), 16);
        assert!(!fingerprint("lin_api_one").contains("lin_api"));
    }

    /// A stand-in for a key Linear would not answer for must never be
    /// remembered as the default's account.
    #[test]
    fn a_stand_in_account_is_not_verified() {
        let mut stand_in = workspace("linear/b", "b", "jango").account;
        stand_in.user_id.clear();

        assert!(verified(&workspace("linear", "a", "acme").account));
        assert!(!verified(&stand_in));
    }

    #[test]
    fn a_bare_github_link_names_no_workspace() {
        assert_eq!(bare_ref("DRA-53".into(), Some("a")).workspace.as_deref(), Some("a"));
        assert_eq!(bare_ref("a/b#1".into(), Some("a")).workspace, None);
    }

    /// Files written before there could be two workspaces carry none of the new
    /// fields, and a field that fails to parse loses the whole file.
    #[test]
    fn links_and_accounts_written_before_workspaces_still_read() {
        let link: IssueRef = serde_json::from_str(
            r#"{"tracker":"linear","id":"u","identifier":"DRA-1","title":"t","url":""}"#,
        )
        .unwrap();
        assert_eq!(link.workspace, None);

        let account: TrackerAccount = serde_json::from_str(
            r#"{"tracker":"linear","userId":"u","userName":"U","orgName":"Acme"}"#,
        )
        .unwrap();
        assert_eq!(account.workspace_id, None);
        assert_eq!(account.url_key, None);
    }
}
