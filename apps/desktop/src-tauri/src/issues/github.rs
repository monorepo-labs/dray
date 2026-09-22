//! GitHub issues, over the `gh` CLI.
//!
//! The mirror image of [`linear`](super::linear) and the difference is the
//! credential. Linear ships no CLI, so the key is ours to hold and the wire is
//! ours to parse; GitHub ships one the reader has almost certainly already
//! signed in to, and the PR panel next door has been shelling out to it since
//! before this file existed. So there is no key, no connect form and nothing in
//! `credentials.json`: **connected means `gh` resolves and `gh api user`
//! answers**, and the cure for a disconnected one is `gh auth login` in the
//! reader's own terminal.
//!
//! Everything it answers is turned into the vocabulary next door before it
//! leaves; nothing above this file knows a `gh` invocation exists.
//!
//! **An identifier here is `owner/repo#123`**, GitHub's own cross-repo
//! spelling, and never a bare `#123`. A number alone is only meaningful
//! relative to a repository, and a prompt is full of them — so the slug is what
//! makes a tag an address, and it is what [`IssueTracker::of`] reads to tell
//! this tracker from Linear.

use std::sync::RwLock;

use serde_json::Value;

use super::{
    Issue, IssueComment, IssueDetail, IssueFilters, IssueGroup, IssueLabel, IssuePerson,
    IssuePriority, IssueQuery, IssueScope, IssueState, IssueStateKind, IssueTracker,
    IssueUnavailable, TrackerAccount,
};
use crate::{git, github, projects, store::get_home_app_dir};

/// The fields a list row is read from. One string, since it is what `gh` takes
/// and what the two callers below must not disagree about.
const LIST_FIELDS: &str =
    "number,title,url,state,stateReason,assignees,author,labels,closedByPullRequestsReferences,createdAt,updatedAt,id";

/// The list's fields plus what only an opened issue needs.
const VIEW_FIELDS: &str =
    "number,title,body,url,state,stateReason,assignees,author,labels,closedByPullRequestsReferences,createdAt,updatedAt,id,comments";

/// Whose `gh` this is, cached for the process.
///
/// `Some(None)` is "asked, and nobody is signed in" — the same shape
/// [`binpath::gh`](crate::binpath::gh) caches an absence in, and for the same
/// reason: the *failing* answer is the expensive one, and it is the one a
/// settings read makes on every open. An `RwLock` rather than a `OnceLock`
/// because this caches an absence the reader is being asked to fix, and
/// [`forget_account`] is what a sign-in throws it away with.
static ACCOUNT: RwLock<Option<Option<TrackerAccount>>> = RwLock::new(None);

/// Forgets who `gh` answered as. Called by `recheck_gh`, which is the button a
/// reader presses after installing the CLI or signing in.
pub fn forget_account() {
    if let Ok(mut held) = ACCOUNT.write() {
        *held = None;
    }
}

/// Where `gh` is run from for a question about no repository in particular.
///
/// `gh api user` does not read the working directory, but [`github::gh`]
/// refuses to spawn into one that is gone — the trap a removed worktree leaves
/// — so this needs a directory that always exists. `~/.dray` is made at launch.
async fn neutral_dir() -> Result<String, IssueUnavailable> {
    get_home_app_dir()
        .await
        .map(|dir| dir.to_string_lossy().into_owned())
        .map_err(IssueUnavailable::other)
}

/// Runs `gh`, with the two failures worth telling apart already read.
///
/// A missing CLI and a logged-out one are both `NotConnected`: the empty state
/// says what to do about either, and neither is an error the reader caused.
/// Everything else keeps `gh`'s own sentence, which is what they would see in
/// their own terminal.
async fn run(cwd: &str, args: &[&str]) -> Result<String, IssueUnavailable> {
    github::gh(cwd, args).await.map_err(|message| {
        let lower = message.to_lowercase();
        if message.starts_with(github::NO_CLI)
            || lower.contains("gh auth login")
            || lower.contains("authentication token")
        {
            IssueUnavailable::NotConnected
        } else {
            IssueUnavailable::Other(message)
        }
    })
}

fn parse(out: &str) -> Result<Value, IssueUnavailable> {
    serde_json::from_str(out).map_err(IssueUnavailable::other)
}

/// Who `gh` is signed in as.
///
/// Also what "connected" means, and there is no cheaper call: the token is
/// `gh`'s, so the only question left is whether it still works.
pub async fn account() -> Result<TrackerAccount, IssueUnavailable> {
    if let Ok(held) = ACCOUNT.read() {
        if let Some(cached) = held.as_ref() {
            return cached.clone().ok_or(IssueUnavailable::NotConnected);
        }
    }

    let answer = read_account().await;

    // A transient failure is not cached: `gh` answering badly once says nothing
    // about the machine, where "nobody is signed in" is a state the reader has
    // to go and change and is worth not asking about on every settings open.
    match &answer {
        Ok(account) => store_account(Some(account.clone())),
        Err(IssueUnavailable::NotConnected) => store_account(None),
        Err(_) => {}
    }

    answer
}

fn store_account(account: Option<TrackerAccount>) {
    if let Ok(mut held) = ACCOUNT.write() {
        *held = Some(account);
    }
}

async fn read_account() -> Result<TrackerAccount, IssueUnavailable> {
    let dir = neutral_dir().await?;
    let out = run(&dir, &["api", "user", "--jq", "{login,name}"]).await?;
    let user = parse(&out)?;

    let login = optional(&user, "login").ok_or(IssueUnavailable::NotConnected)?;

    Ok(TrackerAccount {
        tracker: IssueTracker::Github,
        user_id: login.clone(),
        // An account with no display name set is ordinary, and the login is
        // what that reader is called everywhere else on GitHub anyway.
        user_name: optional(&user, "name").unwrap_or_else(|| login.clone()),
        // No workspace to name: a `gh` token reaches every org the account is
        // in. The host is the honest answer, and it is what the settings row
        // draws where Linear draws an organisation.
        org_name: "github.com".to_string(),
    })
}

/// `owner/repo` for the checkout at `cwd`, or `None` where there is no GitHub
/// remote. No network: a remote is read out of the repository's own config.
pub async fn repo_of(cwd: &str) -> Option<String> {
    git::github_slug(cwd).await
}

/// Every repository the reader has attached a project for, in project order.
///
/// The issues page reads one repository at a time and this is the list it
/// offers. Deliberately **not** `gh repo list`: that answers what the account
/// can see, which for anybody in an organisation is hundreds of repositories
/// they have never opened, where a project attached in Dray is one they are
/// working in.
pub async fn repos_of_projects() -> Vec<String> {
    let Ok(projects) = projects::list_projects().await else {
        return Vec::new();
    };

    let mut repos: Vec<String> = Vec::new();
    for project in projects {
        if let Some(repo) = repo_of(&project.path).await {
            if !repos.contains(&repo) {
                repos.push(repo);
            }
        }
    }

    repos
}

/// Issues in one repository, newest **filed** first.
///
/// `gh issue list` has no sort flag, so the order is asked for as a search
/// qualifier — which quietly moves the read onto the search API, still
/// honouring `--assignee`, `--label` and `--state` and still carrying every
/// field above (measured, not assumed). Its own default is `updatedAt`, which
/// is a fact about the conversation rather than about the work and is the wrong
/// ranking beside a column drawing the filed date.
///
/// Nothing is re-sorted afterwards, where Linear's answers are grouped by
/// priority: GitHub issues carry no priority at all.
pub async fn list_issues(
    repo: &str,
    query: &IssueQuery,
    limit: usize,
) -> Result<Vec<Issue>, IssueUnavailable> {
    let dir = neutral_dir().await?;
    let limit = limit.clamp(1, 250).to_string();

    // A reader who wrote their own `sort:` keeps it. Two of them in one query is
    // GitHub's to resolve however it likes, and losing the order somebody asked
    // for outright is worse than the default order they can see.
    let text = query.text.as_deref().map(str::trim).unwrap_or_default();

    let search = if names_own_sort(text) {
        text.to_string()
    } else {
        format!("{text} sort:created-desc").trim().to_string()
    };

    let mut args = vec![
        "issue",
        "list",
        "-R",
        repo,
        "--json",
        LIST_FIELDS,
        "--limit",
        &limit,
        "--state",
        // One side or the other, never both — the same split Linear's filter
        // makes, so the page's settled groups cost a read only when opened.
        if query.settled { "closed" } else { "open" },
    ];

    match query.scope {
        IssueScope::Assigned => args.extend(["--assignee", "@me"]),
        IssueScope::Created => args.extend(["--author", "@me"]),
        IssueScope::All => {}
    }

    if let Some(label) = query.label.as_deref().filter(|label| !label.is_empty()) {
        args.extend(["--label", label]);
    }

    args.extend(["--search", &search]);

    let out = run(&dir, &args).await?;
    let rows = parse(&out)?;

    Ok(rows
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|node| map_issue(node, repo))
        .collect())
}

/// One issue, opened — body and comments included.
///
/// Looked up by `owner/repo#123` and never by the node id, which is on
/// [`IssueRef`](super::IssueRef) and deliberately unread. GitHub redirects a
/// transferred issue on its own side, so the identifier keeps working where
/// Linear's renumbers — which is the whole reason the id is tried first there.
///
/// ponytail: the ceiling is an issue transferred to a repository the reader
/// cannot see, which reads as gone rather than as moved. `gh api graphql` with
/// `node(id:)` is the upgrade, and it costs a second query shape.
pub async fn get_issue(identifier: &str) -> Result<IssueDetail, IssueUnavailable> {
    let (repo, number) = split_identifier(identifier)
        .ok_or_else(|| IssueUnavailable::Other(format!("{identifier} is not an issue identifier")))?;

    let dir = neutral_dir().await?;
    let number = number.to_string();

    let out = run(
        &dir,
        &["issue", "view", &number, "-R", &repo, "--json", VIEW_FIELDS],
    )
    .await?;
    let node = parse(&out)?;

    let issue = map_issue(&node, &repo)
        .ok_or_else(|| IssueUnavailable::Other(format!("Could not read {identifier}")))?;

    Ok(IssueDetail {
        issue,
        description: node
            .get("body")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|body| !body.is_empty())
            .map(str::to_string),
        comments: map_comments(&node),
        states: states(),
    })
}

/// Moves an issue's status.
///
/// The only write, and there are two places to move to — see [`states`] for why
/// a closed issue's *reason* is not a third. `gh` spells each as its own
/// subcommand.
///
/// **The current state is read first, always.** Every row in the status menu is
/// pickable, the one the issue is already on included — deliberately, since a
/// greyed row mid-list reads as a state that cannot be reached — so picking
/// Open on an open issue has to be a no-op here rather than a `gh issue reopen`
/// whose refusal the panel would draw as a failed update. **`gh` reports that
/// refusal at exit 0** (measured, v2.86.0: "! Issue owner/repo#12 … is already
/// closed"), so a no-op cannot be told from a write by its result either.
///
/// Read before written rather than acting blind, since reopening notifies
/// everybody watching the issue and the ordinary case needs no such thing.
/// `--reason completed` is named rather than left to the default, so the field
/// is always written and never carries whatever a previous close left there.
pub async fn update_issue(identifier: &str, state_id: &str) -> Result<(), IssueUnavailable> {
    let (repo, number) = split_identifier(identifier)
        .ok_or_else(|| IssueUnavailable::Other(format!("{identifier} is not an issue identifier")))?;

    if !matches!(state_id, OPEN_ID | COMPLETED_ID) {
        return Err(IssueUnavailable::Other(format!("No status {state_id}")));
    }

    let dir = neutral_dir().await?;
    let number = number.to_string();

    let now = run(
        &dir,
        &["issue", "view", &number, "-R", &repo, "--json", "state,stateReason"],
    )
    .await
    .and_then(|out| parse(&out))?;

    // Already there, whichever state that is. Nothing is spawned and nothing is
    // reported: the reader picked the row their issue is already on.
    if map_state(&now).id == state_id {
        return Ok(());
    }

    if state_id == OPEN_ID {
        return run(&dir, &["issue", "reopen", &number, "-R", &repo]).await.map(|_| ());
    }

    run(&dir, &["issue", "close", &number, "-R", &repo, "--reason", "completed"])
        .await
        .map(|_| ())
}

/// The filter row's options: the repositories, the statuses each offers, and
/// the labels of the one being read.
///
/// `teams` carries the repositories because a repository is what an issue here
/// belongs to, and [`Issue::team`](super::Issue::team) is the field the page's
/// `statesFor` lookup joins a row to its workflow on. Projects are empty:
/// GitHub Projects are a workspace-wide board rather than a field on an issue,
/// and reading them is a different query against a different object.
pub async fn list_filters(repo: Option<&str>) -> Result<IssueFilters, IssueUnavailable> {
    let repos = repos_of_projects().await;

    Ok(IssueFilters {
        team_states: repos.iter().map(|repo| (repo.clone(), states())).collect(),
        teams: repos
            .into_iter()
            .map(|repo| IssueGroup {
                id: repo.clone(),
                name: repo,
            })
            .collect(),
        projects: Vec::new(),
        labels: match repo.filter(|repo| !repo.is_empty()) {
            Some(repo) => labels_of(repo).await,
            None => Vec::new(),
        },
    })
}

/// A repository's own labels, in GitHub's own order.
///
/// Best effort: a repository this account cannot list labels for still lists
/// issues, so a failure here costs one section of a menu rather than the page.
/// The cap is GitHub's own maximum for one page — a repository with more labels
/// than that has a filter menu nobody could scan anyway.
async fn labels_of(repo: &str) -> Vec<IssueLabel> {
    let Ok(dir) = neutral_dir().await else {
        return Vec::new();
    };

    let out = run(
        &dir,
        &["label", "list", "-R", repo, "--json", "name,color", "--limit", "100"],
    )
    .await;

    let rows = match out.and_then(|out| parse(&out)) {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("[github labels {repo}] {e:?}");
            return Vec::new();
        }
    };

    rows.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|label| {
            let name = optional(label, "name")?;
            Some(IssueLabel {
                name,
                color: map_label_color(label),
            })
        })
        .collect()
}

// ── the two states ───────────────────────────────────────────────────────────

/// What a status menu writes. Stable strings rather than GitHub ids, since
/// these are the *arguments* to `gh` subcommands rather than anything the API
/// addresses.
const OPEN_ID: &str = "open";
const COMPLETED_ID: &str = "completed";

/// Colours are GitHub's own, read off the glyphs it draws beside an issue: open
/// green, closed purple. Named here rather than taken from the wire because
/// GitHub sends none — a state is two enum words, where Linear's is a row
/// somebody coloured.
fn state(kind: IssueStateKind, id: &str, name: &str, color: &str) -> IssueState {
    IssueState {
        id: id.to_string(),
        name: name.to_string(),
        kind,
        color: color.to_string(),
    }
}

/// Every status a GitHub issue can be in here, in the order work moves through.
/// Fixed, unlike a Linear team's workflow, so this is a constant rather than a
/// read — which is what lets a status menu open on a row the list never asked a
/// second question about.
///
/// **Open and Closed, and `NOT_PLANNED` is deliberately not a third.** GitHub
/// files it as a *reason* under the one closed state rather than as a state of
/// its own, and drawing it as one bought a permanent third heading on the page
/// — almost always empty — plus a menu row for a distinction nothing else here
/// reads. A not-planned issue is closed, and that is what the page says.
fn states() -> Vec<IssueState> {
    vec![
        state(IssueStateKind::Unstarted, OPEN_ID, "Open", "#1a7f37"),
        state(IssueStateKind::Completed, COMPLETED_ID, "Closed", "#8250df"),
    ]
}

/// The state a row is in, from the one field that says it. `stateReason` is
/// read no longer — see [`states`] for why every closed issue reads as Closed.
fn map_state(node: &Value) -> IssueState {
    let closed = node
        .get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| state.eq_ignore_ascii_case("CLOSED"));

    if closed {
        state(IssueStateKind::Completed, COMPLETED_ID, "Closed", "#8250df")
    } else {
        state(IssueStateKind::Unstarted, OPEN_ID, "Open", "#1a7f37")
    }
}

// ── wire → vocabulary ────────────────────────────────────────────────────────

/// `owner/repo#123` → `("owner/repo", 123)`. `None` for anything that is not
/// one, which is what keeps a half-typed query out of a lookup.
pub fn split_identifier(text: &str) -> Option<(String, u64)> {
    let (repo, number) = text.trim().rsplit_once('#')?;
    let (owner, name) = repo.split_once('/')?;

    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }

    Some((repo.to_string(), number.parse().ok()?))
}

fn optional(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn text(value: &Value, field: &str) -> String {
    optional(value, field).unwrap_or_default()
}

fn array<'a>(parent: &'a Value, field: &str) -> &'a [Value] {
    parent
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// `None` only for a row with no number — one that cannot be addressed is one
/// no tag could ever reach, so it is dropped rather than drawn. Everything else
/// degrades to a default, which costs a field on screen and not the read.
fn map_issue(node: &Value, repo: &str) -> Option<Issue> {
    let number = node.get("number").and_then(Value::as_u64)?;

    Some(Issue {
        tracker: IssueTracker::Github,
        id: text(node, "id"),
        identifier: format!("{repo}#{number}"),
        title: text(node, "title"),
        url: text(node, "url"),
        state: map_state(node),
        // GitHub has no priority field. `None` is the level, not a failure to
        // read one — and the menu that would change it is not drawn here.
        priority: IssuePriority::None,
        // First only: GitHub allows several and the row draws one face, which
        // is the same reading the PR panel takes of a review.
        assignee: array(node, "assignees").first().and_then(map_person),
        author: node.get("author").and_then(map_person),
        labels: array(node, "labels")
            .iter()
            .map(|label| IssueLabel {
                name: text(label, "name"),
                color: map_label_color(label),
            })
            .collect(),
        // The repository, which is what the identifier is built from and what
        // the page joins a row to its status menu on.
        team: Some(repo.to_string()),
        project: None,
        updated_at: text(node, "updatedAt"),
        created_at: text(node, "createdAt"),
        pull_requests: pull_requests(node),
    })
}

/// Linked pull requests, by number.
///
/// `closedByPullRequestsReferences` is GitHub's own answer to what the issue
/// sidebar calls Development — the PRs that would close this issue — which is
/// narrower than every PR that happens to mention it, and is the set worth a
/// chip. Sorted and deduplicated, so the row reads the same twice running.
fn pull_requests(node: &Value) -> Vec<u32> {
    let mut numbers: Vec<u32> = array(node, "closedByPullRequestsReferences")
        .iter()
        .filter_map(|pr| pr.get("number").and_then(Value::as_u64))
        .map(|number| number as u32)
        .collect();

    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

/// Whether the reader's own query already names a sort order.
///
/// **A whole word, not the letters anywhere in the string.** A `contains` check
/// read `resort:x` as a sort qualifier and read a quoted `"sort: by size"` as
/// one too — both of which are ordinary prose to the search API — and each of
/// those silently took the created-order guarantee away. A token *opening* with
/// `sort:` is the only thing GitHub itself reads as the qualifier, and a quoted
/// one keeps its quote, so it fails this test exactly as it should.
fn names_own_sort(text: &str) -> bool {
    text.split_whitespace().any(|word| word.starts_with("sort:"))
}

/// A label's colour with the `#` `gh` leaves off.
///
/// Six hex digits and no hash is what both the issue and the label endpoints
/// send, where every other colour reaching the frontend carries one — so
/// without this a label draws in the inherited colour and nothing says why.
fn map_label_color(label: &Value) -> String {
    optional(label, "color")
        .map(|hex| format!("#{hex}"))
        .unwrap_or_default()
}

fn map_person(value: &Value) -> Option<IssuePerson> {
    let login = optional(value, "login")?;

    Some(IssuePerson {
        // The display name where the account has one; the login is what that
        // reader is called everywhere else on GitHub.
        name: optional(value, "name").unwrap_or_else(|| login.clone()),
        avatar: (!is_bot(value, &login)).then(|| format!("https://github.com/{login}.png")),
    })
}

/// Whether an account is an app rather than a person.
///
/// `github.com/<login>.png` 404s for exactly these — a GitHub App's real login
/// ends in `[bot]`, which `gh` strips from some fields and not others — so a
/// bot draws its initial rather than a broken image. Read off `is_bot` where
/// `gh` sends it, and off the suffix where it does not.
fn is_bot(value: &Value, login: &str) -> bool {
    value.get("is_bot").and_then(Value::as_bool).unwrap_or(false) || login.ends_with("[bot]")
}

/// Oldest first, which is reading order — the same order the PR panel puts a
/// review thread in, and the order `gh` already answers in.
fn map_comments(node: &Value) -> Vec<IssueComment> {
    array(node, "comments")
        .iter()
        .map(|comment| IssueComment {
            author: comment
                .get("author")
                .and_then(map_person)
                // A comment whose author has been deleted has no login on it,
                // and "Unknown" beside the text beats a blank byline.
                .unwrap_or(IssuePerson {
                    name: "Unknown".into(),
                    avatar: None,
                }),
            body: text(comment, "body"),
            created_at: text(comment, "createdAt"),
            url: optional(comment, "url"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard standing between the reader's own words and the created-order
    /// the list promises, and it reads text somebody typed — so what is *not* a
    /// qualifier matters as much as what is.
    #[test]
    fn only_a_real_sort_qualifier_holds_the_default_back() {
        assert!(names_own_sort("sort:created-asc"));
        assert!(names_own_sort("crash on launch sort:comments"));

        // Prose. Neither of these is a qualifier to GitHub either.
        assert!(!names_own_sort(""));
        assert!(!names_own_sort("resort:foo"));
        assert!(!names_own_sort("how do I resort: the list"));
        assert!(!names_own_sort("\"sort: by size\" in the picker"));
    }

    /// A real `gh issue list -R monorepo-labs/dray --state all --json …`
    /// capture, **with one row added by hand**: that repository has no
    /// not-planned issue and none assigned or labelled, so the third row
    /// carries all three. Its fields are copied verbatim off real captures of
    /// `cli/cli#14490` and `cli/cli#14449` rather than invented.
    const LIST: &str = include_str!("../fixtures/gh_issue_list.json");

    /// A real `gh issue view 14449 -R cli/cli --json …` capture: open, two
    /// labels, an assignee, and two comments.
    const VIEW: &str = include_str!("../fixtures/gh_issue_view.json");

    fn rows() -> Vec<Issue> {
        serde_json::from_str::<Value>(LIST)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|node| map_issue(node, "monorepo-labs/dray"))
            .collect()
    }

    #[test]
    fn a_row_maps_onto_the_vocabulary() {
        let issues = rows();
        assert_eq!(issues.len(), 3);

        let open = issues.iter().find(|i| i.identifier.ends_with("#108")).unwrap();
        assert_eq!(open.identifier, "monorepo-labs/dray#108");
        assert_eq!(open.state.kind, IssueStateKind::Unstarted);
        assert_eq!(open.state.name, "Open");
        // The repository, which is what the page joins a row to its status menu
        // on — the same slot a Linear row puts its team key in.
        assert_eq!(open.team.as_deref(), Some("monorepo-labs/dray"));
        // GitHub has no priority, and this is the level rather than a failure.
        assert_eq!(open.priority, IssuePriority::None);
    }

    /// The two ways a GitHub issue is closed, and they mean opposite things:
    /// one is work that landed, the other work nobody is going to do. Collapsed
    /// into "closed" the page would file a rejected issue under Done.
    #[test]
    fn closing_is_two_states_and_the_reason_is_what_splits_them() {
        let issues = rows();

        let done = issues.iter().find(|i| i.identifier.ends_with("#121")).unwrap();
        assert_eq!(done.state.kind, IssueStateKind::Completed);
        assert_eq!(done.state.name, "Closed");

        let dropped = issues.iter().find(|i| i.identifier.ends_with("#99")).unwrap();
        assert_eq!(dropped.state.kind, IssueStateKind::Completed);
        assert_eq!(dropped.state.name, "Closed");
    }

    /// `gh` sends a label colour as six hex digits with no `#`, where every
    /// other colour reaching the frontend carries one — so without the prefix a
    /// label draws in the inherited colour and nothing says why.
    #[test]
    fn a_label_colour_gains_the_hash_gh_leaves_off() {
        let labelled = rows().into_iter().find(|i| !i.labels.is_empty()).unwrap();

        assert_eq!(labelled.labels[0].name, "suspected-spam");
        assert_eq!(labelled.labels[0].color, "#c62946");
    }

    #[test]
    fn an_assignee_is_a_person_with_a_face() {
        let assigned = rows().into_iter().find(|i| i.assignee.is_some()).unwrap();
        let person = assigned.assignee.unwrap();

        assert_eq!(person.name, "Babak K. Shandiz");
        assert_eq!(
            person.avatar.as_deref(),
            Some("https://github.com/babakks.png")
        );
    }

    /// A GitHub App's avatar 404s at that URL, so it draws its initial instead.
    #[test]
    fn a_bot_has_no_face() {
        let bot = map_person(&serde_json::json!({ "login": "dependabot[bot]" })).unwrap();
        assert!(bot.avatar.is_none());

        let flagged = map_person(&serde_json::json!({ "login": "copilot", "is_bot": true })).unwrap();
        assert!(flagged.avatar.is_none());
    }

    #[test]
    fn an_opened_issue_carries_its_body_and_its_conversation() {
        let node: Value = serde_json::from_str(VIEW).unwrap();
        let issue = map_issue(&node, "cli/cli").unwrap();

        assert_eq!(issue.identifier, "cli/cli#14449");
        assert_eq!(issue.labels.len(), 2);
        assert_eq!(issue.assignee.unwrap().name, "Babak K. Shandiz");

        let comments = map_comments(&node);
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].author.name, "github-actions");
        assert!(!comments[0].body.is_empty());
        // Oldest first, which is reading order.
        assert!(comments[0].created_at <= comments[1].created_at);
    }

    /// The whole of what separates this tracker from Linear, read off the
    /// spelling alone. A bare `#123` is deliberately not one of these.
    #[test]
    fn an_identifier_is_a_repository_and_a_number() {
        assert_eq!(
            split_identifier("monorepo-labs/dray#121"),
            Some(("monorepo-labs/dray".to_string(), 121))
        );
        // Case is kept: GitHub is case-insensitive on a slug, and uppercasing
        // one would make the tag in the prompt disagree with the repository.
        assert_eq!(
            split_identifier("Monorepo-Labs/Dray#1"),
            Some(("Monorepo-Labs/Dray".to_string(), 1))
        );

        for text in ["#121", "dray#121", "owner/repo", "owner/repo#", "/repo#1", "owner/#1"] {
            assert_eq!(split_identifier(text), None, "{text}");
        }
    }

    /// The three ids a status menu writes are the arguments to three `gh`
    /// subcommands, so they are pinned rather than left to a refactor.
    #[test]
    fn every_status_names_a_command_update_can_run() {
        let ids: Vec<String> = states().into_iter().map(|state| state.id).collect();

        assert_eq!(ids, vec![OPEN_ID, COMPLETED_ID]);
    }

    /// What `update_issue` reads before it writes, so picking the state an
    /// issue is already on spawns nothing — `gh issue close` reports that
    /// refusal at exit 0, so a no-op cannot be told from a write by its result.
    /// Every closed reason reads as Closed; see `states` for why.
    #[test]
    fn state_is_read_off_the_one_field_that_says_it() {
        for reason in ["COMPLETED", "NOT_PLANNED", "DUPLICATE", ""] {
            let closed = serde_json::json!({ "state": "CLOSED", "stateReason": reason });
            assert_eq!(map_state(&closed).id, COMPLETED_ID, "{reason}");
        }

        let open = serde_json::json!({ "state": "OPEN", "stateReason": "" });
        assert_eq!(map_state(&open).id, OPEN_ID);
    }
}
