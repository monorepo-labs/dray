//! A session's pull request, read and acted on through the `gh` CLI.
//!
//! `gh` rather than the REST API on purpose: it already holds the user's auth,
//! their enterprise host config, and the token refresh we would otherwise have
//! to own. The cost is that the feature is absent where `gh` isn't installed or
//! isn't logged in — both surface as a readable line in the panel rather than
//! an error, since this is a side view and never the reason the app is open.

use anyhow::Result;
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, process::Stdio, sync::OnceLock};
use tokio::{process::Command, sync::Mutex};
use ts_rs::TS;

use crate::binpath;

/// Where a check ended up, flattened from the two different shapes GitHub
/// reports one in. Callers branch on this and never on the wire's own strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    Skipped,
    Cancelled,
    Neutral,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub state: CheckState,
    /// Where the log lives. `None` for a check that reports no link.
    pub url: Option<String>,
    /// The Actions workflow this run belongs to, when it is one — several
    /// workflows can contribute checks of the same name.
    pub workflow: Option<String>,
    /// The mark of whoever reports this check — Vercel's logo on a Vercel
    /// check. It is what makes a list of check names scannable without reading
    /// them, and it cannot be built from the login: see [`QUERY`].
    pub avatar: Option<String>,
}

/// What kind of entry a timeline row is. A review carries a verdict where a
/// plain comment carries none, and that verdict is most of what the row says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum CommentKind {
    Comment,
    Approved,
    ChangesRequested,
    Reviewed,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub author: String,
    /// The commenter's picture. `None` for an account that has none, which the
    /// panel draws as their initial rather than as a gap.
    pub avatar: Option<String>,
    pub body: String,
    pub created_at: String,
    pub url: String,
    pub kind: CommentKind,
    /// The file an inline review comment hangs on — `path:line`, or the path
    /// alone once GitHub has forgotten which line it pointed at. `None` for
    /// everything on the conversation timeline, which hangs on nothing.
    pub path: Option<String>,
    /// Whether the thread has been settled. False for every row that is not a
    /// thread, since only a review thread can be resolved.
    pub resolved: bool,
    /// The rest of the thread, oldest first. Only an inline comment carries
    /// any: a PR's own conversation is flat, so a reply is either part of a
    /// review thread or it is a new comment.
    pub replies: Vec<PrComment>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `OPEN`, `CLOSED` or `MERGED`, carried through as GitHub's own word.
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
    /// Whether that branch is still on the remote. `headRefName` survives the
    /// branch itself — a merged PR keeps naming the branch it came from — so
    /// the name cannot answer this and `headRef` going null is what does.
    pub head_ref_exists: bool,
    /// `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while GitHub is still working
    /// the merge out — which it starts doing lazily, on being asked.
    pub mergeable: String,
    /// The finer answer: `CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`,
    /// `DRAFT`, `HAS_HOOKS`, `UNKNOWN`.
    pub merge_state_status: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`. `None` where the
    /// repo requires no review, which `gh` reports as an empty string.
    pub review_decision: Option<String>,
    pub checks: Vec<PrCheck>,
    /// Comments, reviews and inline threads in one list, oldest first — the
    /// order GitHub reads them in, and the only order in which a bot's reply to
    /// a review makes sense. A thread is one entry carrying its own replies.
    pub comments: Vec<PrComment>,
    /// Lines added and removed across the whole PR, and how many files moved.
    /// The same figures the changes panel shows for a turn, for the same
    /// reason: a row naming a PR says nothing about how much of one it is.
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub updated_at: String,
}

/// How to land it. The three GitHub offers; the flag each maps to is `gh`'s.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    fn flag(self) -> &'static str {
        match self {
            Self::Merge => "--merge",
            Self::Squash => "--squash",
            Self::Rebase => "--rebase",
        }
    }
}

// ── the wire, as GraphQL answers it ──────────────────────────────────────────

/// Everything the panel draws, in one round trip.
///
/// GraphQL rather than `gh pr list --json`, which carries the same fields and
/// was what this used first. The difference is avatars: the rollup `gh` hands
/// back has no image on it at all, and neither does its comment author — only
/// a login, and `github.com/<login>.png` 404s for exactly the accounts that
/// matter, since a GitHub App's real login ends in `[bot]` and `gh` strips it.
/// One query gets the images with the data instead of three REST calls after
/// it.
///
/// `mergeStateStatus` needs no preview header here, checked against the live
/// API rather than assumed.
const QUERY: &str = r#"
query($owner:String!,$repo:String!,$branch:String!){
 repository(owner:$owner,name:$repo){
  pullRequests(headRefName:$branch,first:20,orderBy:{field:CREATED_AT,direction:DESC}){nodes{
   number title url state isDraft baseRefName headRefName headRef{name} mergeable mergeStateStatus reviewDecision updatedAt
   additions deletions changedFiles
   author{login avatarUrl}
   comments(first:50){nodes{author{login avatarUrl} body createdAt url}}
   reviews(first:50){nodes{id author{login avatarUrl} body submittedAt state}}
   reviewThreads(first:50){nodes{isResolved path line comments(first:50){nodes{author{login avatarUrl} body createdAt url pullRequestReview{id}}}}}
   commits(last:1){nodes{commit{statusCheckRollup{contexts(first:50){nodes{
     __typename
     ... on StatusContext{context state targetUrl avatarUrl}
     ... on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}} app{name logoUrl}}}
   }}}}}}
  }}
 }}
"#;

/// Every pull request the sidebar can mark a row with, by head branch.
///
/// One query for the whole sidebar rather than one per row: `gh` costs the
/// better part of a second, so asking per session would be a spawn per visible
/// row on every refresh.
///
/// **Two aliased connections, not `states:[OPEN,MERGED]` in one.** A single
/// connection spends one `first:100` budget across both, ordered by update — so
/// a repo that merges briskly buries an open pull request nobody has touched
/// this week under a hundred recent merges, and the row loses the mark that
/// already worked. Separate budgets cost nothing extra: it is still one query
/// and one spawn.
///
/// Merged is here because a settled branch is what tells the reader the session
/// is done and can be archived. Closed-without-merging is deliberately not:
/// that is work abandoned rather than landed, and it says nothing the row's own
/// timestamp doesn't.
///
/// The open half also carries its tip commit's check rollup — one field, the
/// rollup's own verdict rather than the fifty contexts the panel's query asks
/// for. Only the tip's, for the panel's reason: a check reported against a
/// commit that has since been pushed over describes code nobody is waiting on.
/// The merged half asks for none — its checks are over, and the row says merged.
///
/// `first:100` is a real cap on both halves. A repo with more than a hundred
/// open pull requests marks the hundred most recently touched; a branch merged
/// long enough ago to fall past the hundredth loses its mark, which is the
/// right way round — those are the sessions already dealt with.
const QUERY_MARKS: &str = r#"
query($owner:String!,$repo:String!){
 repository(owner:$owner,name:$repo){
  open: pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
   number headRefName isDraft mergeable mergeStateStatus
   commits(last:1){nodes{commit{statusCheckRollup{state}}}}
  }}
  merged: pullRequests(states:MERGED,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
   number headRefName isDraft
  }}
 }}
"#;

/// A GraphQL connection. `nodes` is nullable on every one of them, so the
/// `Option` is load-bearing rather than defensive.
#[derive(Deserialize)]
struct Nodes<T> {
    #[serde(default = "Option::default")]
    nodes: Option<Vec<T>>,
}

impl<T> Nodes<T> {
    fn take(this: Option<Self>) -> Vec<T> {
        this.and_then(|n| n.nodes).unwrap_or_default()
    }
}

/// Generic over the node shape, because both queries here answer with the same
/// three envelopes around a `pullRequests` connection and only the fields
/// inside it differ.
#[derive(Deserialize)]
struct Response<T> {
    data: Option<ResponseData<T>>,
    /// GraphQL reports a failed query with a 200 and an `errors` array, so a
    /// zero exit code proves nothing on its own.
    #[serde(default)]
    errors: Vec<GraphQlError>,
}

impl<T> Response<T> {
    /// The connection's nodes, or the first error GitHub reported.
    fn prs(self) -> Result<Vec<T>, String> {
        if let Some(first) = self.errors.first() {
            return Err(first.message.clone());
        }
        Ok(self
            .data
            .and_then(|d| d.repository)
            .map(|r| Nodes::take(r.pull_requests))
            .unwrap_or_default())
    }
}

#[derive(Deserialize)]
struct GraphQlError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct ResponseData<T> {
    repository: Option<Repository<T>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository<T> {
    pull_requests: Option<Nodes<T>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuthor {
    #[serde(default)]
    login: String,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "__typename")]
enum RawCheck {
    #[serde(rename_all = "camelCase")]
    CheckRun {
        #[serde(default)]
        name: String,
        #[serde(default)]
        status: String,
        /// Null while the run is still going — GraphQL sends null where `gh`
        /// sent an empty string, and reading either as terminal draws a running
        /// check as finished.
        #[serde(default)]
        conclusion: Option<String>,
        #[serde(default)]
        details_url: Option<String>,
        #[serde(default)]
        check_suite: Option<RawCheckSuite>,
    },
    #[serde(rename_all = "camelCase")]
    StatusContext {
        #[serde(default)]
        context: String,
        #[serde(default)]
        state: String,
        #[serde(default)]
        target_url: Option<String>,
        #[serde(default)]
        avatar_url: Option<String>,
    },
    /// A rollup entry of a kind we don't model costs one row, not the whole
    /// response.
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCheckSuite {
    #[serde(default)]
    workflow_run: Option<RawWorkflowRun>,
    #[serde(default)]
    app: Option<RawApp>,
}

#[derive(Deserialize)]
struct RawWorkflowRun {
    #[serde(default)]
    workflow: Option<RawWorkflow>,
}

#[derive(Deserialize)]
struct RawWorkflow {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawApp {
    #[serde(default)]
    logo_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    #[serde(default)]
    author: Option<RawAuthor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
    /// The review this was left under. Absent on a conversation comment, which
    /// belongs to no review at all.
    #[serde(default)]
    pull_request_review: Option<RawNodeId>,
}

/// A node named only so it can be pointed at.
#[derive(Deserialize)]
struct RawNodeId {
    #[serde(default)]
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReview {
    /// What the threads left under it name it by.
    #[serde(default)]
    id: String,
    #[serde(default)]
    author: Option<RawAuthor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: String,
    #[serde(default)]
    state: String,
}

/// One inline conversation: where it hangs, whether it is settled, and every
/// comment on it — the first is what opened it and the rest are replies.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThread {
    #[serde(default)]
    is_resolved: bool,
    #[serde(default)]
    path: Option<String>,
    /// Null once the code it pointed at has been pushed over: GitHub keeps the
    /// thread and forgets the line.
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    comments: Option<Nodes<RawComment>>,
}

#[derive(Deserialize)]
struct RawCommitNode {
    #[serde(default)]
    commit: Option<RawCommit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommit {
    #[serde(default)]
    status_check_rollup: Option<RawRollup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRollup {
    #[serde(default)]
    contexts: Option<Nodes<RawCheck>>,
    /// The rollup's own verdict over every context, which is all the sidebar's
    /// mark needs. Absent from the panel's query, which reads the contexts and
    /// counts them itself; absent from the sidebar's, which asks only for this.
    /// Both fields optional so one shape serves both.
    #[serde(default)]
    state: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    author: Option<RawAuthor>,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    /// Null once the branch is deleted, and only then — the one field on the
    /// node that tells a branch still there from one already gone. Only its
    /// presence is read: GraphQL needs a selection under it, but the name it
    /// would carry is `head_ref_name`, which outlives the ref.
    #[serde(default)]
    head_ref: Option<IgnoredAny>,
    #[serde(default)]
    mergeable: String,
    #[serde(default)]
    merge_state_status: String,
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
    #[serde(default)]
    changed_files: u32,
    #[serde(default)]
    comments: Option<Nodes<RawComment>>,
    #[serde(default)]
    reviews: Option<Nodes<RawReview>>,
    /// The inline conversations. Not reachable through `reviews`: the review
    /// they were left under carries only its own body, which for a review that
    /// is nothing but file comments is empty.
    #[serde(default)]
    review_threads: Option<Nodes<RawThread>>,
    /// Only the tip commit's rollup is asked for: a check reported against an
    /// older commit is describing code that has since been pushed over.
    #[serde(default)]
    commits: Option<Nodes<RawCommitNode>>,
    #[serde(default)]
    updated_at: String,
}

impl RawComment {
    /// A timeline row with nothing hanging off it. A thread's own root fills
    /// the rest in afterwards; everything else is already complete.
    fn map(self, kind: CommentKind) -> PrComment {
        PrComment {
            author: login(&self.author),
            avatar: avatar(&self.author),
            body: self.body,
            created_at: self.created_at,
            url: self.url,
            kind,
            path: None,
            resolved: false,
            replies: Vec::new(),
        }
    }
}

impl RawThread {
    /// The thread as one row — the comment that opened it, carrying the rest —
    /// and the id of the review it was left under, which is what files it.
    ///
    /// `None` for a thread whose comments have all been deleted: there is
    /// nothing left to draw, and the file it hung on is not a comment.
    fn map(self) -> Option<(Option<String>, PrComment)> {
        let mut comments = Nodes::take(self.comments).into_iter();
        let opener = comments.next()?;

        let review = opener
            .pull_request_review
            .as_ref()
            .map(|r| r.id.clone())
            .filter(|id| !id.is_empty());

        let mut root = opener.map(CommentKind::Comment);
        root.path = self.path.map(|path| match self.line {
            Some(line) => format!("{path}:{line}"),
            None => path,
        });
        root.resolved = self.is_resolved;
        root.replies = comments.map(|c| c.map(CommentKind::Comment)).collect();

        Some((review, root))
    }
}

fn login(author: &Option<RawAuthor>) -> String {
    author.as_ref().map(|a| a.login.clone()).unwrap_or_default()
}

fn avatar(author: &Option<RawAuthor>) -> Option<String> {
    author.as_ref().and_then(|a| a.avatar_url.clone())
}

impl RawCheck {
    fn map(self) -> Option<PrCheck> {
        match self {
            Self::CheckRun {
                name,
                status,
                conclusion,
                details_url,
                check_suite,
            } => {
                let suite = check_suite.unwrap_or(RawCheckSuite {
                    workflow_run: None,
                    app: None,
                });

                Some(PrCheck {
                    name,
                    // A run that hasn't finished has no conclusion yet, so the
                    // status is the answer; once it has one, the conclusion is.
                    state: match conclusion.as_deref() {
                        Some(word) if !word.is_empty() => conclusion_state(word),
                        _ if status == "COMPLETED" => CheckState::Neutral,
                        _ => CheckState::Pending,
                    },
                    url: details_url.filter(|u| !u.is_empty()),
                    workflow: suite
                        .workflow_run
                        .and_then(|r| r.workflow)
                        .map(|w| w.name)
                        .filter(|n| !n.is_empty()),
                    // The app that owns the check suite — the Vercel mark on a
                    // Vercel check. Missing on a check no app claims.
                    avatar: suite.app.and_then(|a| a.logo_url),
                })
            }
            Self::StatusContext {
                context,
                state,
                target_url,
                avatar_url,
            } => Some(PrCheck {
                name: context,
                state: conclusion_state(&state),
                url: target_url.filter(|u| !u.is_empty()),
                workflow: None,
                avatar: avatar_url,
            }),
            Self::Unknown => None,
        }
    }
}

/// Both shapes' terminal words, in one table. `ERROR` and `TIMED_OUT` are
/// failures rather than a state of their own: the panel's question is whether
/// the check is standing in the way, and every one of these does.
fn conclusion_state(word: &str) -> CheckState {
    match word {
        "SUCCESS" => CheckState::Success,
        "FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED" => {
            CheckState::Failure
        }
        "SKIPPED" => CheckState::Skipped,
        "CANCELLED" => CheckState::Cancelled,
        "PENDING" | "EXPECTED" | "QUEUED" | "IN_PROGRESS" | "WAITING" | "REQUESTED" => {
            CheckState::Pending
        }
        _ => CheckState::Neutral,
    }
}

fn review_kind(state: &str) -> CommentKind {
    match state {
        "APPROVED" => CommentKind::Approved,
        "CHANGES_REQUESTED" => CommentKind::ChangesRequested,
        _ => CommentKind::Reviewed,
    }
}

impl RawPr {
    fn map(self) -> PullRequest {
        let url = self.url;

        let mut comments: Vec<PrComment> = Nodes::take(self.comments)
            .into_iter()
            .map(|c| c.map(CommentKind::Comment))
            .collect();

        // The inline conversations, filed under the review that left them.
        // Every review comment carries the id of its review, which is the only
        // thing joining the two: a thread standing on its own row says nothing
        // about which pass over the code produced it, and next to a
        // conversation comment it does not read as a reply to anything.
        let mut threads: HashMap<String, Vec<PrComment>> = HashMap::new();
        let mut loose: Vec<PrComment> = Vec::new();

        for raw in Nodes::take(self.review_threads) {
            let Some((review, thread)) = raw.map() else { continue };
            match review {
                Some(id) => threads.entry(id).or_default().push(thread),
                None => loose.push(thread),
            }
        }

        comments.extend(Nodes::take(self.reviews).into_iter().filter_map(|r| {
            let mut replies = threads.remove(&r.id).unwrap_or_default();
            replies.sort_by(|a, b| a.created_at.cmp(&b.created_at));

            // A review with no body is the envelope GitHub wraps inline file
            // comments in. Empty and holding nothing, it draws a card that says
            // nothing — but empty and holding threads it is the only row that
            // names who left them, so it stays and they hang off it.
            if r.body.trim().is_empty() && replies.is_empty() && r.state != "APPROVED" {
                return None;
            }

            Some(PrComment {
                kind: review_kind(&r.state),
                author: login(&r.author),
                avatar: avatar(&r.author),
                body: r.body,
                created_at: r.submitted_at,
                // Reviews carry a node id rather than a URL, so the thread
                // they belong to is the closest honest link.
                url: url.clone(),
                path: None,
                resolved: false,
                replies,
            })
        }));

        // A thread whose review is not on the list — one left beyond the fifty
        // we ask for — still belongs on the timeline. It reads as its own note,
        // which is what it is once the review it hung off is out of reach.
        comments.extend(threads.into_values().flatten());
        comments.extend(loose);

        comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));

        let checks = Nodes::take(self.commits)
            .into_iter()
            .filter_map(|node| node.commit)
            .filter_map(|commit| commit.status_check_rollup)
            .flat_map(|rollup| Nodes::take(rollup.contexts))
            .filter_map(RawCheck::map)
            .collect();

        PullRequest {
            number: self.number,
            title: self.title,
            url,
            state: self.state,
            is_draft: self.is_draft,
            author: login(&self.author),
            base_ref_name: self.base_ref_name,
            head_ref_name: self.head_ref_name,
            head_ref_exists: self.head_ref.is_some(),
            mergeable: self.mergeable,
            merge_state_status: self.merge_state_status,
            review_decision: self.review_decision.filter(|d| !d.is_empty()),
            checks,
            comments,
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            updated_at: self.updated_at,
        }
    }
}

/// Why there is nothing to show, when the reason is not "this branch has no PR".
///
/// Typed rather than a string because the frontend acts differently on each:
/// a missing `gh` hides the tab outright — the app has no business claiming a
/// GitHub feature on a machine with no GitHub CLI — while a `gh` that is merely
/// logged out keeps the tab and says so, since someone who installed it clearly
/// works with GitHub and the fix is one command.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum PrUnavailable {
    /// `gh` isn't installed.
    NoCli,
    /// `gh` is installed but has no credentials.
    NotAuthenticated,
    /// Not a git repository, or one with no GitHub remote.
    NoRemote,
    /// Anything else, carrying `gh`'s own sentence.
    Other(String),
}

impl PrUnavailable {
    /// Reads `gh`'s stderr for the two failures worth telling apart.
    ///
    /// Matched on substrings of the sentences `gh` prints, captured live:
    /// "To get started with GitHub CLI, please run:  gh auth login" and
    /// "failed to run git: fatal: not a git repository". A reworded message
    /// falls through to `Other`, which still puts the text on screen — the
    /// cost of drift is a tab that stays visible, not a wrong answer.
    fn classify(message: String) -> Self {
        let lower = message.to_lowercase();

        if lower.contains("gh auth login") || lower.contains("authentication token") {
            Self::NotAuthenticated
        } else if lower.contains("not a git repository")
            || lower.contains("no git remotes")
            || lower.contains("none of the git remotes")
        {
            Self::NoRemote
        } else {
            Self::Other(message)
        }
    }
}

// ── running it ────────────────────────────────────────────────────────────────

/// The one message that is ours rather than `gh`'s, since a binary that does
/// not exist writes no stderr. Sentinel as well as text: [`unavailable`] reads
/// it back to tell "no CLI" from a CLI that answered badly.
const NO_CLI: &str = "GitHub CLI (gh) not found.";

/// Runs `gh` in `cwd`. `Err` is the message to put on screen: `gh` writes a
/// readable sentence to stderr for every failure that matters here — not
/// logged in, no remote, no such repo — and rewording them would only make them
/// less like what the user sees in their own terminal.
async fn gh(cwd: &str, args: &[&str]) -> Result<String, String> {
    let bin = binpath::gh().await.ok_or(NO_CLI)?;

    let out = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        // `gh` prompts when it can't decide something on its own, and a prompt
        // written to a pipe nobody reads is a command that never returns.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("could not run gh: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "gh exited with an error".to_string()
        } else {
            err
        });
    }

    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `owner/name` for the repo `cwd` sits in, cached for the process.
///
/// GraphQL takes the repo as arguments where every `gh pr` subcommand works it
/// out from the directory, so this is the one extra call the switch costs. It
/// is paid once per checkout: a remote does not move while the app is running,
/// and the same bargain the command cache and `binpath` already make.
async fn repo_slug(cwd: &str) -> Result<(String, String), String> {
    static SLUGS: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
    let slugs = SLUGS.get_or_init(|| Mutex::new(HashMap::new()));

    if let Some(hit) = slugs.lock().await.get(cwd) {
        return Ok(hit.clone());
    }

    let out = gh(cwd, &["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).await?;
    let slug = out.trim();

    let (owner, name) = slug
        .split_once('/')
        .ok_or_else(|| format!("could not read the repository name from {slug:?}"))?;
    let pair = (owner.to_string(), name.to_string());

    slugs.lock().await.insert(cwd.to_string(), pair.clone());
    Ok(pair)
}

/// Every pull request opened from `branch`, newest first, open ones ahead of
/// settled ones.
///
/// A list rather than one answer, because one branch really can carry several:
/// the same fix opened against `main` and a release branch, or a stack where
/// each PR's base is the branch below it. `gh pr view <branch>` collapses that
/// to whichever one it finds first and says nothing about the rest, which is
/// the one failure here the reader could not possibly notice.
///
/// An empty list is the resting state of most branches and reads as `Ok(vec![])`
/// — a branch nobody has opened a PR from is not an error. Everything that
/// stopped us asking comes back as a typed [`PrUnavailable`], because the tab
/// hides for one of those reasons and stays for the rest.
#[tauri::command]
pub async fn prs_for_branch(
    cwd: String,
    branch: String,
) -> Result<Vec<PullRequest>, PrUnavailable> {
    prs_for_branch_inner(&cwd, &branch).await.map_err(unavailable)
}

/// Maps a raw `gh` failure onto the reason the panel branches on. Split out so
/// the classifier can be tested without spawning anything.
fn unavailable(message: String) -> PrUnavailable {
    if message.starts_with(NO_CLI) {
        PrUnavailable::NoCli
    } else {
        PrUnavailable::classify(message)
    }
}

async fn prs_for_branch_inner(cwd: &str, branch: &str) -> Result<Vec<PullRequest>, String> {
    let (owner, repo) = repo_slug(cwd).await?;

    let out = gh(
        cwd,
        &[
            "api",
            "graphql",
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("repo={repo}"),
            "-f",
            &format!("branch={branch}"),
            "-f",
            &format!("query={QUERY}"),
        ],
    )
    .await?;

    read_prs(&out)
}

/// Splits parsing off the spawn so the fixture can exercise it.
fn read_prs(out: &str) -> Result<Vec<PullRequest>, String> {
    let response: Response<RawPr> =
        serde_json::from_str(out).map_err(|e| format!("could not read GitHub's answer: {e}"))?;

    let mut prs: Vec<PullRequest> = response.prs()?.into_iter().map(RawPr::map).collect();

    // An open PR is the one being worked on whatever its age, so it outranks a
    // newer merged one — otherwise reopening an old branch shows the reader the
    // PR they already landed.
    prs.sort_by(|a, b| {
        let rank = |pr: &PullRequest| u8::from(pr.state != "OPEN");
        rank(a).cmp(&rank(b)).then(b.number.cmp(&a.number))
    });

    Ok(prs)
}

/// Which of the two connections a mark came from.
///
/// Not parsed off the wire: [`QUERY_MARKS`] asks each state in its own aliased
/// connection, so the connection *is* the answer and a `state` field would be a
/// second copy of it free to disagree. Only the two states the sidebar draws —
/// closed-without-merging is not asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "UPPERCASE")]
pub enum PrMarkState {
    Open,
    Merged,
}

/// One pull request, cut down to what a sidebar row can draw.
///
/// Deliberately not a `PullRequest`: the row says "this branch has a PR, and
/// what became of it" and nothing else, so carrying checks, comments and review
/// threads for every session in the list would be payload nobody reads.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct PrMark {
    pub number: u64,
    /// The branch it was opened from — what the caller matches a session by.
    pub head_ref_name: String,
    pub is_draft: bool,
    pub state: PrMarkState,
    pub checks_state: PrChecksState,
    /// Enough of the panel's merge fields to answer "can this land now", which
    /// the sidebar itself draws nothing from — the notice for a pull request
    /// turning ready does, and this is the only read that runs for a session
    /// nobody is looking at. The panel's query is gated on its own tab being
    /// on screen, which is precisely when there is nothing to announce.
    ///
    /// `None` on the merged half, where they are not asked for. The frontend
    /// reads that as *unknown* rather than as ready — see `mergeVerdict`.
    pub mergeable: Option<String>,
    pub merge_state_status: Option<String>,
}

/// What CI on the tip commit has to say, cut to the two things a row can show.
///
/// Passing is folded in with "no checks at all" on purpose: a row that says
/// nothing is a row with nothing to do, and marking every green branch green a
/// second time makes the mark that *does* need reading harder to find. So this
/// is a three-way, not the rollup's five-way — `SUCCESS` and an absent rollup
/// both reach the reader as [`PrChecksState::Clear`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "UPPERCASE")]
pub enum PrChecksState {
    /// Still going, and going to finish on its own — the one state here worth
    /// an indicator the reader can watch.
    Running,
    /// Settled badly. Drawn by recolouring the pull request's own glyph rather
    /// than by adding a second mark: it is a fact *about* the PR, not another
    /// thing on the row.
    Failing,
    /// Passing, or no CI configured at all. Nothing to say either way.
    Clear,
}

impl PrChecksState {
    /// Reads GitHub's `StatusState` into the three the row draws.
    ///
    /// `EXPECTED` is running, not failing: it means a required check has not
    /// reported yet, which is a wait rather than a verdict. `ERROR` sits with
    /// `FAILURE` — a check that could not run is one that has not passed, and
    /// telling them apart is the panel's job, not a row's.
    ///
    /// Anything unrecognised reads as [`PrChecksState::Clear`], which is the safe
    /// way round: a vocabulary GitHub adds later shows nothing rather than
    /// painting every row red.
    fn from_rollup(state: &str) -> Self {
        match state {
            "PENDING" | "EXPECTED" => Self::Running,
            "FAILURE" | "ERROR" => Self::Failing,
            _ => Self::Clear,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrMark {
    number: u64,
    #[serde(default)]
    head_ref_name: String,
    /// Always false on a merged one — GitHub clears the flag on merge — so this
    /// is only ever read for the open half. One node shape for both keeps the
    /// query symmetrical.
    #[serde(default)]
    is_draft: bool,
    /// Only asked for on the open half, so absent — not empty — on the merged
    /// one. Same nesting the panel's query walks, so the same structs read it.
    #[serde(default)]
    commits: Option<Nodes<RawCommitNode>>,
    /// Asked for on the open half alone, for the same reason `commits` is: a
    /// merged pull request cannot become ready to merge, and `mergeStateStatus`
    /// is the one field here GitHub computes *on being asked* — so putting it
    /// on the merged connection would spend that work a hundred times over to
    /// answer a question nobody asks.
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(default)]
    merge_state_status: Option<String>,
}

/// The tip commit's rollup, read into what the row draws.
///
/// `commits(last:1)` asks for one, so anything else — no commits, no rollup, no
/// CI — is [`PrChecksState::Clear`] rather than an error: a repo without checks is
/// the ordinary case, not a failure to read one.
fn read_checks(commits: Option<Nodes<RawCommitNode>>) -> PrChecksState {
    Nodes::take(commits)
        .into_iter()
        .filter_map(|node| node.commit)
        .filter_map(|commit| commit.status_check_rollup)
        .filter_map(|rollup| rollup.state)
        .map(|state| PrChecksState::from_rollup(&state))
        .next()
        .unwrap_or(PrChecksState::Clear)
}

/// The two-connection answer. `Response<T>` next door can't serve it: it is
/// generic over the *node* shape around one field named `pullRequests`, and
/// this asks the same field twice under two aliases.
#[derive(Deserialize)]
struct MarksResponse {
    data: Option<MarksData>,
    #[serde(default)]
    errors: Vec<GraphQlError>,
}

#[derive(Deserialize)]
struct MarksData {
    repository: Option<MarksRepository>,
}

#[derive(Deserialize)]
struct MarksRepository {
    open: Option<Nodes<RawPrMark>>,
    merged: Option<Nodes<RawPrMark>>,
}

/// Every pull request in the repo `cwd` sits in that a sidebar row can be
/// marked with — open ones and merged ones.
///
/// One call for a whole sidebar's worth of rows — see [`QUERY_MARKS`]. The
/// caller matches a session to its entry by branch, so this answers a list
/// rather than a map: which branch a session lands on is the frontend's own
/// rule (a worktree session's is rebuilt from its worktree name), and building
/// the map here would be a second copy of it. One branch can carry several, so
/// picking which one a row draws is the caller's too.
#[tauri::command]
pub async fn pr_marks(cwd: String) -> Result<Vec<PrMark>, PrUnavailable> {
    pr_marks_inner(&cwd).await.map_err(unavailable)
}

async fn pr_marks_inner(cwd: &str) -> Result<Vec<PrMark>, String> {
    let (owner, repo) = repo_slug(cwd).await?;

    let out = gh(
        cwd,
        &[
            "api",
            "graphql",
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("repo={repo}"),
            "-f",
            &format!("query={QUERY_MARKS}"),
        ],
    )
    .await?;

    read_pr_marks(&out)
}

/// Splits parsing off the spawn, like [`read_prs`].
fn read_pr_marks(out: &str) -> Result<Vec<PrMark>, String> {
    let response: MarksResponse =
        serde_json::from_str(out).map_err(|e| format!("could not read GitHub's answer: {e}"))?;

    // Checked before the data, for [`Response::prs`]'s reason: a failed query
    // answers with a 200 and a null `data`, so reading the connections first
    // turns "could not resolve repository" into "this repo has no pull
    // requests".
    if let Some(first) = response.errors.first() {
        return Err(first.message.clone());
    }

    let repository = response.data.and_then(|d| d.repository);
    let (open, merged) = match repository {
        Some(r) => (Nodes::take(r.open), Nodes::take(r.merged)),
        None => (Vec::new(), Vec::new()),
    };

    Ok(open
        .into_iter()
        .map(|pr| (PrMarkState::Open, pr))
        .chain(merged.into_iter().map(|pr| (PrMarkState::Merged, pr)))
        .map(|(state, mut pr)| PrMark {
            number: pr.number,
            checks_state: read_checks(pr.commits.take()),
            head_ref_name: pr.head_ref_name,
            is_draft: pr.is_draft,
            state,
            mergeable: pr.mergeable,
            merge_state_status: pr.merge_state_status,
        })
        .collect())
}

/// Merges the PR. Returns once `gh` has, so the caller can refetch and show
/// the landed state rather than guess at it.
///
/// The branch is deliberately left behind — no `--delete-branch`. A worktree
/// session has its own branch checked out, so `git branch -D` refuses it and
/// the cleanup fails after the merge has already landed; cleaning up worktrees
/// is its own job, not a checkbox on this one.
///
/// A failure is still checked against the PR before being reported: `gh pr
/// merge` can fail with the merge already through (a post-merge step, a lost
/// connection), and reporting the exit code alone tells the reader their merge
/// failed when it is on `main`.
#[tauri::command]
pub async fn merge_pr(cwd: String, number: u64, method: MergeMethod) -> Result<(), String> {
    let arg = number.to_string();

    let Err(e) = gh(&cwd, &["pr", "merge", &arg, method.flag()]).await else {
        return Ok(());
    };

    match merged_state(&cwd, number).await {
        Some(true) => Ok(()),
        // Either it genuinely didn't merge, or we couldn't find out — and an
        // unverifiable merge has to read as the failure it was reported as.
        _ => Err(e),
    }
}

/// Whether the PR is merged, or `None` where asking failed too.
async fn merged_state(cwd: &str, number: u64) -> Option<bool> {
    let out = gh(cwd, &["pr", "view", &number.to_string(), "--json", "state"])
        .await
        .ok()?;
    let value: serde_json::Value = serde_json::from_str(&out).ok()?;

    Some(value.get("state")?.as_str()? == "MERGED")
}

/// Deletes the head branch from the remote, and nothing else.
///
/// The local branch and the worktree holding it belong to the settle flow,
/// which already deletes both; the remote ref is the one thing nothing owned.
/// Keeping the halves apart also sidesteps `git branch -D` refusing a branch
/// some worktree still has checked out — the same refusal that keeps
/// [`merge_pr`] from passing `--delete-branch`.
///
/// The REST endpoint rather than `git push --delete`: this takes no working
/// tree, so it deletes the branch of a session whose checkout has already gone.
/// A ref that is already deleted answers 422 rather than success, so the button
/// is gated on `head_ref_exists` instead of this call being safe to repeat.
#[tauri::command]
pub async fn delete_branch(cwd: String, branch: String) -> Result<(), String> {
    let (owner, repo) = repo_slug(&cwd).await?;

    // `refs/heads/<branch>` is a path here, so a branch name carrying slashes
    // needs no escaping — `fix/thing` addresses the ref it names.
    let path = format!("repos/{owner}/{repo}/git/refs/heads/{branch}");

    gh(&cwd, &["api", "-X", "DELETE", &path]).await.map(|_| ())
}

/// Reopens a PR closed elsewhere. There is no `close_pr` beside it on purpose:
/// this panel exists to get work landed, and abandoning a PR is a decision with
/// a discussion attached to it, which happens on GitHub.
#[tauri::command]
pub async fn reopen_pr(cwd: String, number: u64) -> Result<(), String> {
    gh(&cwd, &["pr", "reopen", &number.to_string()]).await.map(|_| ())
}

/// Takes a draft out of draft. The other direction (`--undo`) isn't offered:
/// the panel's job is getting work landed, and a PR reopened as a draft is a
/// state the reader can set on GitHub in the rare case they want it.
#[tauri::command]
pub async fn mark_pr_ready(cwd: String, number: u64) -> Result<(), String> {
    gh(&cwd, &["pr", "ready", &number.to_string()]).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real capture: `gh api graphql` against a PR carrying a Vercel status
    /// context, two app-owned check runs, two bot comments, a review with a
    /// body, two bodyless review envelopes, and four inline threads — one of
    /// them resolved, two hanging on a line GitHub has since forgotten. Every
    /// avatar in it is one no `<login>.png` guess could have produced.
    const FIXTURE: &str = include_str!("fixtures/pr_graphql.json");

    fn parse() -> PullRequest {
        read_prs(FIXTURE).expect("fixture parses").pop().expect("one PR")
    }

    #[test]
    fn reads_both_check_shapes() {
        let pr = parse();
        assert_eq!(pr.checks.len(), 3);
        // `StatusContext` carries its name on `context`, `CheckRun` on `name`.
        assert!(pr.checks.iter().any(|c| c.name == "Vercel"));
        assert!(pr.checks.iter().any(|c| c.name == "Vercel Preview Comments"));
        assert!(pr.checks.iter().all(|c| c.state == CheckState::Success));
    }

    /// Both shapes hide the image in a different place — `avatarUrl` on a
    /// status context, `checkSuite.app.logoUrl` on a run — and a check with
    /// neither is what the panel falls back to a glyph for.
    #[test]
    fn every_check_carries_its_reporter_image() {
        let pr = parse();
        assert!(
            pr.checks.iter().all(|c| c.avatar.is_some()),
            "missing avatars: {:?}",
            pr.checks
        );
    }

    #[test]
    fn comment_and_review_authors_carry_images() {
        let pr = parse();
        assert!(pr.comments.iter().all(|c| c.avatar.is_some()));
    }

    #[test]
    fn merges_comments_and_reviews_oldest_first() {
        let pr = parse();
        // Two conversation comments and three reviews. The four inline threads
        // are on none of those rows — they hang off the review that left them.
        assert_eq!(pr.comments.len(), 5);
        assert_eq!(pr.comments[0].author, "vercel");
        assert_eq!(pr.comments[0].kind, CommentKind::Comment);
        assert!(pr.comments.iter().any(|c| c.kind == CommentKind::Reviewed));
        assert!(pr.comments.windows(2).all(|w| w[0].created_at <= w[1].created_at));
        // Nothing on the timeline itself is a file comment.
        assert!(pr.comments.iter().all(|c| c.path.is_none()));
    }

    /// Every inline thread sits under its own review, joined by the id its
    /// first comment carries. Standing on the timeline they read as ordinary
    /// comments and say nothing about which pass over the code produced them.
    #[test]
    fn inline_threads_hang_off_the_review_that_left_them() {
        let pr = parse();
        let threads: Vec<_> = pr.comments.iter().flat_map(|c| &c.replies).collect();

        assert_eq!(threads.len(), 4);
        assert!(threads.iter().all(|t| t.path.is_some()));
        assert_eq!(threads.iter().filter(|t| t.resolved).count(), 1);
        // Devin left two file comments in one pass, so both are on one row.
        let devin = pr
            .comments
            .iter()
            .find(|c| c.author == "devin-ai-integration")
            .expect("devin's review");
        assert_eq!(devin.replies.len(), 2);
        // A line GitHub still knows is appended; one it has forgotten leaves
        // the path standing alone.
        assert!(threads
            .iter()
            .any(|t| t.path.as_deref() == Some("apps/desktop/src/hooks/useRepo.ts:80")));
        assert!(threads.iter().any(|t| {
            t.path.as_deref() == Some("apps/desktop/src/components/changes/ChangesView.tsx")
        }));
    }

    /// A review that is nothing but file comments has an empty body, and it is
    /// the only row that names who left them.
    #[test]
    fn a_bodyless_review_holding_threads_is_kept() {
        let pr = parse();
        let envelopes: Vec<_> = pr
            .comments
            .iter()
            .filter(|c| c.body.trim().is_empty() && !c.replies.is_empty())
            .collect();

        assert_eq!(envelopes.len(), 2);
        assert!(envelopes.iter().all(|e| e.author == "greptile-apps"));
    }

    /// A thread's later comments are replies inside it, not rows of their own.
    /// No capture holds one yet, so this pins the shape.
    #[test]
    fn a_threads_later_comments_are_replies() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,
            "reviews":{"nodes":[{"id":"R1","author":{"login":"bot"},"body":"",
              "state":"COMMENTED","submittedAt":"2026-01-01T00:00:00Z"}]},
            "reviewThreads":{"nodes":[
            {"isResolved":false,"path":"src/main.rs","line":12,"comments":{"nodes":[
              {"author":{"login":"bot"},"body":"this leaks","createdAt":"2026-01-01T00:00:00Z",
               "pullRequestReview":{"id":"R1"}},
              {"author":{"login":"me"},"body":"fixed","createdAt":"2026-01-01T00:05:00Z",
               "pullRequestReview":{"id":"R1"}}]}}]}}]}}}}"#;
        let prs = read_prs(out).expect("thread parses");

        assert_eq!(prs[0].comments.len(), 1);
        let thread = &prs[0].comments[0].replies[0];
        assert_eq!(thread.author, "bot");
        assert_eq!(thread.path.as_deref(), Some("src/main.rs:12"));
        assert_eq!(thread.replies.len(), 1);
        assert_eq!(thread.replies[0].author, "me");
        // The row sorts by what opened the thread, not by its last reply.
        assert_eq!(thread.created_at, "2026-01-01T00:00:00Z");
    }

    /// A thread whose review is out of reach still belongs on the timeline —
    /// it reads as its own note, which is what it is with nothing to hang off.
    #[test]
    fn a_thread_with_no_review_of_its_own_stands_alone() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,"reviewThreads":{"nodes":[
            {"path":"src/main.rs","line":3,"comments":{"nodes":[
              {"author":{"login":"bot"},"body":"look here","createdAt":"2026-01-01T00:00:00Z"}]}}]}}]}}}}"#;
        let prs = read_prs(out).expect("orphan thread parses");

        assert_eq!(prs[0].comments.len(), 1);
        assert_eq!(prs[0].comments[0].path.as_deref(), Some("src/main.rs:3"));
    }

    /// Every comment on a thread can be deleted, and what is left is a file
    /// path rather than anything to draw.
    #[test]
    fn an_empty_thread_draws_no_row() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,"reviewThreads":{"nodes":[
            {"path":"src/main.rs","comments":{"nodes":[]}}]}}]}}}}"#;
        assert!(read_prs(out).expect("empty thread parses")[0].comments.is_empty());
    }

    /// GraphQL sends `null` where the repo requires no review, and an empty
    /// badge is worse than none.
    #[test]
    fn an_absent_review_decision_is_none() {
        assert!(parse().review_decision.is_none());
    }

    /// GraphQL reports a failed query with a 200 and an `errors` array, so a
    /// zero exit proves nothing — read as success this returns no PRs and the
    /// panel says the branch has none.
    #[test]
    fn a_graphql_error_is_an_error() {
        let out = r#"{"data":null,"errors":[{"message":"Could not resolve to a Repository."}]}"#;
        assert_eq!(
            read_prs(out).unwrap_err(),
            "Could not resolve to a Repository."
        );
    }

    /// Null connections are the shape a PR with no checks, no comments and no
    /// threads arrives in, and they must not fail the response.
    #[test]
    fn null_connections_read_as_empty() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[
            {"number":7,"comments":{"nodes":null},"reviews":null,"reviewThreads":{"nodes":null},
             "commits":{"nodes":[]}}]}}}}"#;
        let prs = read_prs(out).expect("nulls parse");
        assert!(prs[0].checks.is_empty() && prs[0].comments.is_empty());
    }

    /// An unmodelled rollup entry costs its own row and nothing else.
    #[test]
    fn an_unknown_check_shape_is_dropped() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,
            "commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
              {"__typename":"SomethingNew","name":"x"},
              {"__typename":"StatusContext","context":"CI","state":"PENDING"}]}}}}]}}]}}}}"#;
        let prs = read_prs(out).expect("unknown shape parses");
        assert_eq!(prs[0].checks.len(), 1);
        assert_eq!(prs[0].checks[0].state, CheckState::Pending);
    }

    /// A running check has a null conclusion, and reading that as terminal
    /// would draw it as finished.
    #[test]
    fn a_running_check_is_pending() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,
            "commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
              {"__typename":"CheckRun","name":"build","status":"IN_PROGRESS",
               "conclusion":null}]}}}}]}}]}}}}"#;
        let prs = read_prs(out).expect("running check parses");
        assert_eq!(prs[0].checks[0].state, CheckState::Pending);
    }

    /// The envelope GitHub wraps inline file comments in carries no body.
    #[test]
    fn a_bodyless_review_is_dropped_unless_it_approves() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,"reviews":{"nodes":[
            {"author":{"login":"a"},"body":"","state":"COMMENTED"},
            {"author":{"login":"b"},"body":"","state":"APPROVED"}]}}]}}}}"#;
        let prs = read_prs(out).expect("reviews parse");
        assert_eq!(prs[0].comments.len(), 1);
        assert_eq!(prs[0].comments[0].kind, CommentKind::Approved);
    }

    /// An open PR outranks a newer settled one: reopening an old branch must
    /// not show the reader the PR they already landed.
    #[test]
    fn open_prs_sort_ahead_of_settled_ones() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[
            {"number":9,"state":"MERGED"},{"number":3,"state":"OPEN"},
            {"number":7,"state":"CLOSED"},{"number":5,"state":"OPEN"}]}}}}"#;
        let prs = read_prs(out).expect("list parses");
        assert_eq!(
            prs.iter().map(|p| p.number).collect::<Vec<_>>(),
            vec![5, 3, 9, 7]
        );
    }

    /// `gh`'s own sentences, captured live. A missing CLI is our message, not
    /// `gh`'s, since a binary that does not exist writes no stderr.
    #[test]
    fn gh_failures_classify_by_what_the_reader_has_to_do() {
        assert!(matches!(
            unavailable(format!("{NO_CLI} Install it to see pull requests here.")),
            PrUnavailable::NoCli
        ));
        assert!(matches!(
            unavailable(
                "To get started with GitHub CLI, please run:  gh auth login".to_string()
            ),
            PrUnavailable::NotAuthenticated
        ));
        assert!(matches!(
            unavailable(
                "failed to run git: fatal: not a git repository (or any of the parent \
                 directories): .git"
                    .to_string()
            ),
            PrUnavailable::NoRemote
        ));
    }

    /// A reworded message must still reach the reader rather than being
    /// swallowed as one of the known cases.
    #[test]
    fn an_unrecognised_failure_keeps_its_text() {
        match unavailable("GraphQL: API rate limit exceeded".to_string()) {
            PrUnavailable::Other(m) => assert!(m.contains("rate limit")),
            other => panic!("classified as {other:?}"),
        }
    }

    #[test]
    fn diff_counts_come_through() {
        let pr = parse();
        assert_eq!((pr.additions, pr.deletions, pr.changed_files), (2155, 66, 22));
    }

    /// `headRefName` outlives the branch — a merged PR goes on naming the one
    /// it came from — so only `headRef` going null says the ref is gone.
    /// Verified against the live API: deleting the branch flipped `headRef` to
    /// null and left `headRefName` exactly as it was.
    #[test]
    fn head_ref_says_whether_the_branch_is_still_there() {
        let out = |head_ref: &str| {
            format!(
                r#"{{"data":{{"repository":{{"pullRequests":{{"nodes":[
                  {{"number":1,"headRefName":"fix/thing","headRef":{head_ref}}}]}}}}}}}}"#
            )
        };

        let live = read_prs(&out(r#"{"name":"fix/thing"}"#)).expect("parses");
        assert!(live[0].head_ref_exists);
        assert_eq!(live[0].head_ref_name, "fix/thing");

        let deleted = read_prs(&out("null")).expect("parses");
        assert!(!deleted[0].head_ref_exists);
        // The name survives, which is what lets the row go on naming it.
        assert_eq!(deleted[0].head_ref_name, "fix/thing");
    }

    /// Absence has to read as *gone*, not as there. The button is the one
    /// destructive thing on this pane, and a shape we failed to get back would
    /// otherwise draw it over a branch that may not exist — a click answered
    /// with a 422. Under-offering costs a trip to GitHub; over-offering costs
    /// an error on work already landed.
    #[test]
    fn a_missing_head_ref_field_reads_as_gone() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[
            {"number":1,"headRefName":"fix/thing"}]}}}}"#;
        let prs = read_prs(out).expect("parses");
        assert!(!prs[0].head_ref_exists);
    }

    /// The sidebar's query carries the branch and the draft flag, and a draft
    /// is an open PR — reading it as anything else leaves the row unmarked for
    /// exactly the PR that has just been opened.
    #[test]
    fn pr_marks_carry_their_branch_and_draft_flag() {
        let out = r#"{"data":{"repository":{
            "open":{"nodes":[
              {"number":9,"headRefName":"worktree-calm-navy-beacon","isDraft":true},
              {"number":8,"headRefName":"fix/thing","isDraft":false}]},
            "merged":{"nodes":[]}}}}"#;
        let prs = read_pr_marks(out).expect("pr marks parse");
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].head_ref_name, "worktree-calm-navy-beacon");
        assert!(prs[0].is_draft);
        assert!(!prs[1].is_draft);
    }

    /// The merge fields ride the open half alone, so the merged half answers
    /// `None` for them. The frontend has to read that as *not knowing* rather
    /// than as nothing standing in the way — a merged mark reporting itself
    /// ready to merge would raise a card for work that already landed.
    #[test]
    fn pr_marks_carry_merge_state_on_the_open_half_only() {
        let out = r#"{"data":{"repository":{
            "open":{"nodes":[
              {"number":9,"headRefName":"fix/live","isDraft":false,
               "mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}]},
            "merged":{"nodes":[{"number":4,"headRefName":"fix/landed","isDraft":false}]}}}}"#;
        let prs = read_pr_marks(out).expect("pr marks parse");
        assert_eq!(prs[0].mergeable.as_deref(), Some("MERGEABLE"));
        assert_eq!(prs[0].merge_state_status.as_deref(), Some("CLEAN"));
        assert_eq!(prs[1].mergeable, None);
        assert_eq!(prs[1].merge_state_status, None);
    }

    /// State comes from which connection answered, not from a field — see
    /// [`PrMarkState`]. Both halves reach the caller in one list.
    #[test]
    fn pr_marks_state_comes_from_the_connection() {
        let out = r#"{"data":{"repository":{
            "open":{"nodes":[{"number":9,"headRefName":"fix/live","isDraft":false}]},
            "merged":{"nodes":[{"number":4,"headRefName":"fix/landed","isDraft":false}]}}}}"#;
        let prs = read_pr_marks(out).expect("pr marks parse");
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].state, PrMarkState::Open);
        assert_eq!(prs[1].state, PrMarkState::Merged);
        assert_eq!(prs[1].head_ref_name, "fix/landed");
    }

    /// The row draws three things off five wire values, and each fold is one
    /// somebody could reasonably get backwards: a settled rollup read as
    /// running leaves the row spinning forever, and a running one read as
    /// failing paints it red before CI has said anything.
    #[test]
    fn the_rollup_folds_into_the_three_states_a_row_draws() {
        let mark = |rollup: &str| {
            let out = format!(
                r#"{{"data":{{"repository":{{"open":{{"nodes":[
                  {{"number":9,"headRefName":"b","isDraft":false,
                    "commits":{{"nodes":[{{"commit":{{"statusCheckRollup":{rollup}}}}}]}}}}]}},
                  "merged":{{"nodes":[]}}}}}}}}"#
            );
            read_pr_marks(&out).expect("pr marks parse").remove(0).checks_state
        };

        assert_eq!(mark(r#"{"state":"PENDING"}"#), PrChecksState::Running);
        // A required check that has not reported yet is a wait, not a verdict.
        assert_eq!(mark(r#"{"state":"EXPECTED"}"#), PrChecksState::Running);
        assert_eq!(mark(r#"{"state":"FAILURE"}"#), PrChecksState::Failing);
        // A check that could not run is one that has not passed.
        assert_eq!(mark(r#"{"state":"ERROR"}"#), PrChecksState::Failing);
        // Passing says nothing, and neither does no CI at all — most repos.
        assert_eq!(mark(r#"{"state":"SUCCESS"}"#), PrChecksState::Clear);
        assert_eq!(mark("null"), PrChecksState::Clear);
        // A word GitHub adds later must show nothing, not paint the row red.
        assert_eq!(mark(r#"{"state":"SOMETHING_NEW"}"#), PrChecksState::Clear);
    }

    /// The merged half is asked for no commits, so the field is absent rather
    /// than empty — and absent must not fail the line the open half rode in on.
    #[test]
    fn a_mark_with_no_commits_asked_for_still_parses() {
        let out = r#"{"data":{"repository":{
            "open":{"nodes":[]},
            "merged":{"nodes":[{"number":4,"headRefName":"b","isDraft":false}]}}}}"#;
        let prs = read_pr_marks(out).expect("pr marks parse");
        assert_eq!(prs[0].checks_state, PrChecksState::Clear);
    }

    /// Same 200-with-errors trap the branch query has: a zero exit code proves
    /// nothing, and reading it as success marks every row as PR-less.
    #[test]
    fn a_pr_mark_query_error_is_an_error() {
        let out = r#"{"data":null,"errors":[{"message":"Could not resolve to a Repository"}]}"#;
        assert!(read_pr_marks(out).is_err());
    }

    /// A repo with nothing on one side answers a null connection, not an empty
    /// one — on each half independently.
    #[test]
    fn no_pr_marks_reads_as_empty() {
        let out = r#"{"data":{"repository":{"open":{"nodes":null},"merged":{"nodes":null}}}}"#;
        assert!(read_pr_marks(out).expect("null connections parse").is_empty());
    }

    #[test]
    fn merge_methods_map_to_gh_flags() {
        assert_eq!(MergeMethod::Squash.flag(), "--squash");
        assert_eq!(MergeMethod::Rebase.flag(), "--rebase");
        assert_eq!(MergeMethod::Merge.flag(), "--merge");
    }
}
