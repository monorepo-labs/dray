//! A session's pull request, read and acted on through the `gh` CLI.
//!
//! `gh` rather than the REST API on purpose: it already holds the user's auth,
//! their enterprise host config, and the token refresh we would otherwise have
//! to own. The cost is that the feature is absent where `gh` isn't installed or
//! isn't logged in — both surface as a readable line in the panel rather than
//! an error, since this is a side view and never the reason the app is open.

use anyhow::Result;
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
    /// Comments and reviews in one list, oldest first — the order GitHub reads
    /// them in, and the only order in which a bot's reply to a review makes
    /// sense.
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
   number title url state isDraft baseRefName headRefName mergeable mergeStateStatus reviewDecision updatedAt
   additions deletions changedFiles
   author{login avatarUrl}
   comments(first:50){nodes{author{login avatarUrl} body createdAt url}}
   reviews(first:50){nodes{author{login avatarUrl} body submittedAt state}}
   commits(last:1){nodes{commit{statusCheckRollup{contexts(first:50){nodes{
     __typename
     ... on StatusContext{context state targetUrl avatarUrl}
     ... on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}} app{name logoUrl}}}
   }}}}}}
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

#[derive(Deserialize)]
struct Response {
    data: Option<ResponseData>,
    /// GraphQL reports a failed query with a 200 and an `errors` array, so a
    /// zero exit code proves nothing on its own.
    #[serde(default)]
    errors: Vec<GraphQlError>,
}

#[derive(Deserialize)]
struct GraphQlError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct ResponseData {
    repository: Option<Repository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    pull_requests: Option<Nodes<RawPr>>,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReview {
    #[serde(default)]
    author: Option<RawAuthor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: String,
    #[serde(default)]
    state: String,
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
struct RawRollup {
    #[serde(default)]
    contexts: Option<Nodes<RawCheck>>,
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
    /// Only the tip commit's rollup is asked for: a check reported against an
    /// older commit is describing code that has since been pushed over.
    #[serde(default)]
    commits: Option<Nodes<RawCommitNode>>,
    #[serde(default)]
    updated_at: String,
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
            .map(|c| PrComment {
                author: login(&c.author),
                avatar: avatar(&c.author),
                body: c.body,
                created_at: c.created_at,
                url: c.url,
                kind: CommentKind::Comment,
            })
            .collect();

        comments.extend(
            Nodes::take(self.reviews)
                .into_iter()
                // A review with no body is the envelope GitHub wraps inline
                // file comments in. It carries nothing to read, and drawing it
                // puts an empty card between two that say something.
                .filter(|r| !r.body.trim().is_empty() || r.state == "APPROVED")
                .map(|r| PrComment {
                    kind: review_kind(&r.state),
                    author: login(&r.author),
                    avatar: avatar(&r.author),
                    body: r.body,
                    created_at: r.submitted_at,
                    // Reviews carry a node id rather than a URL, so the thread
                    // they belong to is the closest honest link.
                    url: url.clone(),
                }),
        );

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
    let response: Response =
        serde_json::from_str(out).map_err(|e| format!("could not read GitHub's answer: {e}"))?;

    // A failed GraphQL query still exits zero and answers 200, so the error
    // array is the only place the failure is reported.
    if let Some(first) = response.errors.first() {
        return Err(first.message.clone());
    }

    let mut prs: Vec<PullRequest> = response
        .data
        .and_then(|d| d.repository)
        .map(|r| Nodes::take(r.pull_requests))
        .unwrap_or_default()
        .into_iter()
        .map(RawPr::map)
        .collect();

    // An open PR is the one being worked on whatever its age, so it outranks a
    // newer merged one — otherwise reopening an old branch shows the reader the
    // PR they already landed.
    prs.sort_by(|a, b| {
        let rank = |pr: &PullRequest| u8::from(pr.state != "OPEN");
        rank(a).cmp(&rank(b)).then(b.number.cmp(&a.number))
    });

    Ok(prs)
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
    /// context, a Devin status context, an app-owned check run, a bot review
    /// and a bot comment. Every avatar in it is one no `<login>.png` guess
    /// could have produced.
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
        assert_eq!(pr.comments.len(), 2);
        assert_eq!(pr.comments[0].author, "vercel");
        assert_eq!(pr.comments[0].kind, CommentKind::Comment);
        assert_eq!(pr.comments[1].author, "devin-ai-integration");
        assert_eq!(pr.comments[1].kind, CommentKind::Reviewed);
        assert!(pr.comments[0].created_at <= pr.comments[1].created_at);
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

    /// Null connections are the shape a PR with no checks and no comments
    /// arrives in, and they must not fail the response.
    #[test]
    fn null_connections_read_as_empty() {
        let out = r#"{"data":{"repository":{"pullRequests":{"nodes":[
            {"number":7,"comments":{"nodes":null},"reviews":null,"commits":{"nodes":[]}}]}}}}"#;
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
        assert_eq!((pr.additions, pr.deletions, pr.changed_files), (167, 4, 8));
    }

    #[test]
    fn merge_methods_map_to_gh_flags() {
        assert_eq!(MergeMethod::Squash.flag(), "--squash");
        assert_eq!(MergeMethod::Rebase.flag(), "--rebase");
        assert_eq!(MergeMethod::Merge.flag(), "--merge");
    }
}
