//! "Waiting on you": which of a bot's tasks wait on the reader, judged on the
//! bot's server so every client draws the same card (#1259).
//!
//! The rules are the desktop's `stalledTasks`, moved here whole: a task idle on
//! the reader for [`STALL_MS`], or whose PR has been able to land for as long,
//! is a card row; a PR the task can mend is the bot's alone, nudged at once on
//! a fresh read. Everything the judge reads lives on this server — the index,
//! the live map clients get in `live_state`, and PR marks this server asks `gh`
//! for itself — so no client has to be open for the bot to hear of a stall.
//!
//! A task on another machine is judged here too. That machine answers its own
//! tasks' [`TaskFacts`] on the reports poll it already serves
//! (`parent_reports`), so no new connection is made for it; a poll that fails
//! keeps the last facts, marked offline, and their PR is read by its GitHub
//! repo through this server's `gh`.
//!
//! The card goes out as `bot_stalls_changed`, one bot per event, held in
//! `serve.rs`'s `Live`, which `live_state` and `bot_stalls` answer from.
//! Dismissing a row stays per device.

use crate::{
    bots::Bot,
    github::{PrChecksState, PrMark, PrMarkState},
    sink::Sink,
    store::{self, SessionIndexItem, SessionStatus},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
    time::Duration,
};
use ts_rs::TS;

/// How long a task sits untouched before the reader hears of it. What the
/// task can mend itself waits for none of it.
pub const STALL_MS: i64 = 2 * 60_000;

/// How often the judge runs with nothing poking it: rows ripen with time alone.
const TICK: Duration = Duration::from_secs(15);
/// How long a repo's PR marks stand before they are asked for again.
const MARKS_FRESH: i64 = 30_000;
/// The wait after a read `gh` can never mend (no CLI, no GitHub remote).
const MARKS_GAVE_UP: i64 = 10 * 60_000;
/// The wait after any other failed read: a spent rate limit is not hammered.
const MARKS_RETRY: i64 = 60_000;
/// How long an unsent nudge waits before it is tried again.
const NUDGE_RETRY: i64 = 60_000;
/// Nudges remembered, so a restart never sends one twice.
const NUDGED_CAP: usize = 400;

/// What a card row waits on the reader for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub enum StallKind {
    /// Idle on the reader: a question, or work to look at.
    Waiting,
    /// Its PR can land, and the reader merges it from the card.
    Ready,
}

/// One row of a bot's "Waiting on you" card.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct StallRow {
    /// Names this one stall: dismissed by it, nudged once by it, and new again
    /// only once the task moves. The desktop's own format, so dismissals made
    /// before this moved here still hold.
    pub key: String,
    pub kind: StallKind,
    /// A ready row whose PR GitHub is working out again, as it does for every
    /// open PR after a merge: kept so the card holds still, and not mergeable.
    pub checking: bool,
    /// When it stalled, in unix ms; the card is ordered by it.
    pub since: i64,
    /// What the bot wrote the reader needs to do, since the task last moved.
    #[ts(optional)]
    pub need: Option<String>,
    #[ts(optional)]
    pub pr: Option<PrMark>,
    /// The task as its own server indexes it. A task on another machine
    /// carries that machine's paths.
    pub item: SessionIndexItem,
    /// The machine a task started with `--machine` runs on, by name; none for
    /// a task on this server.
    #[ts(optional)]
    pub machine: Option<String>,
    /// Its machine did not answer the last poll: drawn from what was last
    /// known, with nothing to open, merged through GitHub by `repo`.
    pub offline: bool,
    /// The PR's repo as `gh --repo` takes it, for a client that cannot reach
    /// the task's machine to merge through the bot's server.
    #[ts(optional)]
    pub repo: Option<String>,
}

/// A task asked to mend its PR: which PR, the status it was asked about, and
/// when, in unix ms. What the Tasks row's "Fixing merge conflicts · 3m" reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct FixAsk {
    pub session_id: String,
    pub pr: u64,
    pub status: String,
    pub at: i64,
}

/// One bot's card, as `bot_stalls` answers and `bot_stalls_changed` carries it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct BotStalls {
    pub bot_id: String,
    /// The bot's current chat session.
    pub chat_id: String,
    /// Oldest stall first. Not yet filtered by any device's dismissals.
    pub rows: Vec<StallRow>,
    /// The bot's tasks, set-aside ones left out: the Tasks tab's count.
    pub tasks: u32,
    pub fixes: Vec<FixAsk>,
    /// Every task of the bot's this server judged. One it could not — on a
    /// machine too old to send its facts — is left to the client to judge.
    pub judged: Vec<String>,
}

/// What a task's server knows about it: what the judge reads. A machine
/// answers these for its tasks whose bot is elsewhere.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFacts {
    pub item: SessionIndexItem,
    pub busy: bool,
    pub asking: bool,
    /// A background shell or subagent still running, bar one left only serving.
    pub background: bool,
    #[serde(default)]
    pub pr: Option<PrMark>,
    /// The PR was read after the task last moved, so a fix may be called at once.
    #[serde(default)]
    pub pr_fresh: bool,
    /// Its repo's PRs were asked for at least once, so no PR means none.
    #[serde(default)]
    pub pr_known: bool,
    /// Set on a task the answering server does not hold but collects from a
    /// machine further on: a sub-task its task started there. Its name, and
    /// whether that machine missed its last poll. Reached through the server
    /// that answered, which forwards a nudge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default)]
    pub offline: bool,
}

// ── the PR verdict, `pr.ts`'s `mergeVerdict` and `prStatus` ───────────────────

fn merge_verdict(pr: &PrMark) -> &'static str {
    if pr.state == PrMarkState::Merged {
        return "merged";
    }
    let mergeable = pr.mergeable.as_deref();
    let status = pr.merge_state_status.as_deref();
    if mergeable == Some("CONFLICTING") || status == Some("DIRTY") {
        return "conflict";
    }
    if pr.is_draft {
        return "draft";
    }
    if mergeable == Some("UNKNOWN") || mergeable.is_none() || status.is_none() {
        return "unknown";
    }
    match status {
        Some("BEHIND") => "behind",
        Some("BLOCKED") => "blocked",
        Some("UNSTABLE") => "unstable",
        Some("UNKNOWN") => "unknown",
        _ => "ready",
    }
}

/// `prStatus(pr).key`: checks speak before the merge state, since `BLOCKED`
/// is usually them.
pub fn pr_status(pr: &PrMark) -> &'static str {
    let verdict = merge_verdict(pr);
    if matches!(verdict, "merged" | "closed" | "conflict") {
        return verdict;
    }
    match pr.checks_state {
        PrChecksState::Failing => return "checksFailing",
        PrChecksState::Running => return "checksRunning",
        PrChecksState::Clear => {}
    }
    if verdict == "draft" {
        return verdict;
    }
    match pr.review_decision.as_deref() {
        Some("CHANGES_REQUESTED") => return "changesRequested",
        Some("REVIEW_REQUIRED") => return "needsReview",
        _ => {}
    }
    if verdict == "unstable" { "checksFailing" } else { verdict }
}

/// A PR's status as a stall reads it: a draft's failing checks read as a
/// draft, since it waits on the reader's look with feedback unpushed and its
/// red check is stale by design.
fn stall_status(pr: &PrMark) -> &'static str {
    match pr_status(pr) {
        "checksFailing" if pr.is_draft => "draft",
        key => key,
    }
}

/// What a task can mend itself, as its bot is told it.
fn fixable(status: &str, n: u64) -> Option<String> {
    Some(match status {
        "conflict" => format!("PR #{n} has merge conflicts."),
        "checksFailing" => format!("PR #{n} has failing checks."),
        "behind" => format!("PR #{n} is behind its base branch."),
        "changesRequested" => format!("A review on PR #{n} asked for changes."),
        _ => return None,
    })
}

/// Whether `pr` has moved off what `ask` was about. `unknown` holds: it is
/// GitHub's recompute after a push, not an answer.
fn fix_done(ask: &FixAsk, pr: &PrMark) -> bool {
    let key = stall_status(pr);
    pr.number != ask.pr || (key != ask.status && key != "unknown")
}

/// The branch a task's work lands on, `sessionBranch` with nothing observed:
/// the worktree's while it has one, else the recorded branch.
fn task_branch(item: &SessionIndexItem) -> Option<String> {
    if item.worktree_removed {
        return item.branch.clone();
    }
    item.worktree_name.as_ref().map(|n| format!("worktree-{n}")).or_else(|| item.branch.clone())
}

/// `pickPrMark`: open beats draft beats merged; ties go to the first.
fn pick_mark<'a>(prs: impl Iterator<Item = &'a PrMark>) -> Option<&'a PrMark> {
    let rank = |pr: &PrMark| match (pr.state, pr.is_draft) {
        (PrMarkState::Open, false) => 0,
        (PrMarkState::Open, true) => 1,
        _ => 2,
    };
    prs.fold(None, |best: Option<&PrMark>, pr| match best {
        Some(b) if rank(b) <= rank(pr) => Some(b),
        _ => Some(pr),
    })
}

fn ms(rfc3339: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(rfc3339).ok().map(|t| t.timestamp_millis())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── the tree, `crewRows` ──────────────────────────────────────────────────────

/// The session `item` hangs under: its parent while that is live, else the
/// one that adopted it. The client's `treeParent`, not the store's, which
/// keeps a settled parent and would hide its children from the walk.
fn tree_parent<'a>(item: &'a SessionIndexItem, live: &HashSet<&str>) -> Option<&'a str> {
    let parent = item.parent_session_id.as_deref()?;
    if live.contains(parent) { Some(parent) } else { item.adopted_by.as_deref().or(Some(parent)) }
}

/// Every unsettled session under `roots`, at any depth: depth-first, each level
/// newest started first. A cycle in the index costs a short list.
fn crew<'a>(items: &'a [SessionIndexItem], roots: &[&'a str]) -> Vec<&'a SessionIndexItem> {
    let live: HashSet<&str> = items.iter().filter(|i| !i.archived).map(|i| i.session_id.as_str()).collect();
    let mut by_parent: HashMap<&str, Vec<&SessionIndexItem>> = HashMap::new();
    for item in items {
        let Some(parent) = tree_parent(item, &live) else { continue };
        if item.archived || parent == item.session_id {
            continue;
        }
        by_parent.entry(parent).or_default().push(item);
    }
    let mut seen: HashSet<&str> = roots.iter().copied().collect();
    let mut out = Vec::new();
    fn walk<'a>(
        ids: Vec<&str>,
        by_parent: &HashMap<&str, Vec<&'a SessionIndexItem>>,
        seen: &mut HashSet<&'a str>,
        out: &mut Vec<&'a SessionIndexItem>,
    ) {
        let mut kids: Vec<&SessionIndexItem> = ids.iter().flat_map(|id| by_parent.get(id).into_iter().flatten().copied()).collect();
        kids.sort_by_key(|k| std::cmp::Reverse(ms(&k.created).unwrap_or(0)));
        for kid in kids {
            if !seen.insert(&kid.session_id) {
                continue;
            }
            out.push(kid);
            walk(vec![&kid.session_id], by_parent, seen, out);
        }
    }
    walk(roots.to_vec(), &by_parent, &mut seen, &mut out);
    out
}

// ── the judge, `stalledTasks` ─────────────────────────────────────────────────

/// A stall before it is split into card rows and the bot's own nudges.
#[derive(Debug, Clone)]
struct Stall {
    row: StallRow,
    /// Set on a fix: the PR status the bot is told to mend.
    fix: Option<(&'static str, String)>,
}

/// One task as the judge reads it: its facts, and where they came from.
struct Judged<'a> {
    facts: &'a TaskFacts,
    machine: Option<&'a Remote>,
}

/// The tasks among `tasks` that have stalled, oldest first. `ready_since` is
/// the desktop's `readySince`, kept across calls: when each task's PR was seen
/// turning ready, `0` where it was ready when first seen, `-1` while it is not.
fn stalled(tasks: &[Judged], ready_since: &mut HashMap<String, i64>, now: i64) -> Vec<Stall> {
    let mut stalls = Vec::new();
    for Judged { facts, machine } in tasks {
        let item = &facts.item;
        let id = &item.session_id;
        let pr = facts.pr.as_ref();
        let status = pr.map(stall_status);
        let pr_key = format!("{id}:{}", pr.map_or("undefined".into(), |p| p.number.to_string()));
        let ready = status.and_then(|s| (s != "unknown").then_some(s == "ready"));
        match ready {
            Some(false) => {
                ready_since.insert(pr_key.clone(), -1);
            }
            Some(true) => match ready_since.get(&pr_key) {
                None => {
                    ready_since.insert(pr_key.clone(), 0);
                }
                Some(-1) => {
                    ready_since.insert(pr_key.clone(), now);
                }
                _ => {}
            },
            None => {}
        }
        // Not judged until its repo has been read: unread, a ready PR looks
        // like a task idle on the reader.
        if !facts.pr_known || facts.busy || facts.background || facts.asking || item.aside || item.continue_at.is_some() {
            continue;
        }
        // A merge elsewhere drops every open PR there to unknown for a poll.
        // One last seen ready keeps its row, under the same key.
        let was = ready_since.get(&pr_key).copied();
        let checking = status.is_some() && ready.is_none() && was.is_some_and(|w| w >= 0);
        if (status.is_some() && ready.is_none() && !checking) || matches!(status, Some("checksRunning" | "merged")) {
            continue;
        }
        let touched = ms(&item.modified).unwrap_or(now);
        let offline = machine.is_some_and(|m| m.offline);
        let row = |kind, since, key: String, checking| StallRow {
            key,
            kind,
            checking,
            since,
            need: need_line(item),
            pr: pr.cloned(),
            item: item.clone(),
            machine: machine.map(|m| m.name.clone()),
            offline,
            repo: pr.and_then(|p| crate::github::slug_from_pr_url(&p.url)),
        };
        if let Some(pr) = pr.filter(|_| ready == Some(true) || checking) {
            let since = was.unwrap_or(0).max(touched);
            if now - since >= STALL_MS {
                let key = format!("{id}:ready:{}:{}", pr.number, item.modified);
                stalls.push(Stall { row: row(StallKind::Ready, since, key, checking), fix: None });
            }
            continue;
        }
        let idle = now - touched >= STALL_MS;
        let fix = pr.zip(status).and_then(|(pr, s)| fixable(s, pr.number).map(|problem| (s, problem)));
        if let Some((status, problem)) = fix {
            if idle || facts.pr_fresh {
                let key = format!("{id}:{status}:{}", item.modified);
                stalls.push(Stall { row: row(StallKind::Waiting, touched, key, false), fix: Some((status, problem)) });
            }
        } else if idle {
            let key = format!("{id}:waiting:{}", item.modified);
            stalls.push(Stall { row: row(StallKind::Waiting, touched, key, false), fix: None });
        }
    }
    stalls.sort_by_key(|s| s.row.since);
    stalls
}

/// What the bot wrote the reader needs, written since the task last moved.
fn need_line(item: &SessionIndexItem) -> Option<String> {
    let need = item.need.as_ref()?;
    (ms(&need.at)? >= ms(&item.modified)?).then(|| need.text.clone())
}

// ── nudges ────────────────────────────────────────────────────────────────────

/// What one nudge says, for knowing it was sent: a task, as it stood, told one
/// thing. Every caller of `nudge_bot` derives the same mark, so a stall the app
/// nudged is never nudged again by this server, nor the other way round.
pub fn nudge_mark(task: &SessionIndexItem, problem: Option<&str>, ready: Option<u32>) -> String {
    let said = match (problem, ready) {
        (Some(problem), _) => format!("fix:{problem}"),
        (None, Some(n)) => format!("ready:{n}"),
        (None, None) => "waiting".into(),
    };
    format!("{}:{}:{said}", task.session_id, task.modified)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kept {
    #[serde(default)]
    nudged: Vec<String>,
    #[serde(default)]
    fixes: Vec<FixAsk>,
    /// Nudges being sent now, so a second sender of the same one waits it out.
    #[serde(skip)]
    sending: HashSet<String>,
}

static KEPT: tokio::sync::Mutex<Option<Kept>> = tokio::sync::Mutex::const_new(None);

async fn kept_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(store::get_home_app_dir().await?.join("stalls.json"))
}

async fn with_kept<R>(edit: impl FnOnce(&mut Kept) -> (R, bool)) -> R {
    let mut guard = KEPT.lock().await;
    if guard.is_none() {
        let read = match kept_path().await {
            Ok(path) => store::read_json(&path).await.unwrap_or_default(),
            Err(_) => Kept::default(),
        };
        *guard = Some(read);
    }
    let kept = guard.as_mut().expect("just filled");
    let (out, changed) = edit(kept);
    if changed {
        if let Ok(path) = kept_path().await {
            let text = serde_json::to_string_pretty(&*kept).unwrap_or_default();
            if let Err(e) = store::write_atomic(&path, text).await {
                eprintln!("[stalls err] {e:#}");
            }
        }
    }
    out
}

/// Whether a nudge with this mark went out already.
pub async fn nudged(mark: &str) -> bool {
    with_kept(|k| (k.nudged.iter().any(|m| m == mark), false)).await
}

/// Takes the nudge with this mark for sending: false where it went out
/// already or another sender has it, so the app and this server never both
/// deliver one. A taker ends with [`note_nudged`] or [`release_nudge`].
pub async fn claim_nudge(mark: &str) -> bool {
    with_kept(|k| (!k.nudged.iter().any(|m| m == mark) && k.sending.insert(mark.to_string()), false)).await
}

/// Gives a claimed nudge back after a failed send, for the next try.
pub async fn release_nudge(mark: &str) {
    with_kept(|k| (k.sending.remove(mark), false)).await;
}

/// Notes that a nudge with this mark went out.
pub async fn note_nudged(mark: String) {
    with_kept(|k| {
        k.sending.remove(&mark);
        if k.nudged.contains(&mark) {
            return ((), false);
        }
        k.nudged.push(mark);
        let over = k.nudged.len().saturating_sub(NUDGED_CAP);
        k.nudged.drain(..over);
        ((), true)
    })
    .await
}

/// Notes a task asked to mend `status` on PR `pr`. A standing ask for the same
/// problem keeps its time, so a second nudge never hides how long it has run.
async fn note_fix(session_id: &str, pr: u64, status: &str) {
    with_kept(|k| {
        if k.fixes.iter().any(|f| f.session_id == session_id && f.pr == pr && f.status == status) {
            return ((), false);
        }
        k.fixes.retain(|f| f.session_id != session_id);
        k.fixes.push(FixAsk { session_id: session_id.into(), pr, status: status.into(), at: now_ms() });
        ((), true)
    })
    .await
}

/// Drops each ask whose task's PR has moved off what it was asked about.
async fn prune_fixes(prs: &HashMap<&str, &PrMark>) -> Vec<FixAsk> {
    with_kept(|k| {
        let before = k.fixes.len();
        k.fixes.retain(|f| prs.get(f.session_id.as_str()).is_none_or(|pr| !fix_done(f, pr)));
        (k.fixes.clone(), k.fixes.len() != before)
    })
    .await
}

// ── what the judge holds between passes ───────────────────────────────────────

/// One repo's PR marks as last read here.
#[derive(Default)]
struct Marks {
    prs: Vec<PrMark>,
    /// When the read the answer came from was issued, unix ms.
    read_at: i64,
    /// When the last read was tried, answered or not.
    tried_at: i64,
    /// When the next read is due.
    due: i64,
    known: bool,
}

/// A task on another machine, as its machine last answered.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Remote {
    /// The machine's id in `servers.json`.
    id: String,
    name: String,
    offline: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFacts {
    machine: Option<Remote>,
    facts: Vec<TaskFacts>,
}

#[derive(Default)]
struct State {
    marks: HashMap<String, Marks>,
    /// When this server saw each task's `modified` change, on its own clock.
    moved_at: HashMap<String, (String, i64)>,
    ready_since: HashMap<String, i64>,
    /// By machine id: what it last answered for its tasks whose bot is here.
    remote: HashMap<String, RemoteFacts>,
    remote_loaded: bool,
    /// When each unsent nudge was last tried.
    tried: HashMap<String, i64>,
    cards: HashMap<String, BotStalls>,
}

static STATE: LazyLock<tokio::sync::Mutex<State>> = LazyLock::new(Default::default);

/// Wakes the judge early, debounced, when something a row reads moved.
static POKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Called for every event the server publishes. Only what can put a row on the
/// card or take it off wakes the judge.
pub fn poke(event: &str, payload: &Value) {
    let wakes = match event {
        "session_status" | "session_changed" | "session_created" | "session_serving" => true,
        "agent_event" => matches!(
            payload["payload"]["type"].as_str(),
            Some("permission_requested" | "questions_asked" | "permission_decided" | "background_tasks_changed")
        ),
        _ => false,
    };
    if wakes {
        POKE.notify_one();
    }
}

async fn remote_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(store::get_home_app_dir().await?.join("stall-remote.json"))
}

/// Read on first use, so a restart while a machine is down still draws its rows.
async fn load_remote(state: &mut State) {
    if state.remote_loaded {
        return;
    }
    state.remote_loaded = true;
    if let Ok(path) = remote_path().await {
        state.remote = store::read_json(&path).await.unwrap_or_default();
    }
}

async fn save_remote(state: &State) {
    let Ok(path) = remote_path().await else { return };
    let text = serde_json::to_string(&state.remote).unwrap_or_default();
    if let Err(e) = store::write_atomic(&path, text).await {
        eprintln!("[stalls err] {e:#}");
    }
}

/// A machine answered the reports poll: `facts` is what it said of the tasks
/// asked about, `None` from a machine too old to say.
pub async fn remote_answered(id: &str, name: &str, facts: Option<Vec<Value>>) {
    let mut state = STATE.lock().await;
    load_remote(&mut state).await;
    let Some(facts) = facts else {
        if state.remote.remove(id).is_some() {
            save_remote(&state).await;
        }
        return;
    };
    // One fact that fails to read costs that task, never the machine's answer.
    let facts: Vec<TaskFacts> = facts.into_iter().filter_map(|f| serde_json::from_value(f).ok()).collect();
    let machine = Remote { id: id.into(), name: name.into(), offline: false };
    state.remote.insert(id.into(), RemoteFacts { machine: Some(machine), facts });
    save_remote(&state).await;
    drop(state);
    POKE.notify_one();
}

/// A task on another machine as that machine last described it.
pub async fn last_known(id: &str) -> Option<SessionIndexItem> {
    let mut state = STATE.lock().await;
    load_remote(&mut state).await;
    state.remote.values().flat_map(|r| &r.facts).find(|f| f.item.session_id == id).map(|f| f.item.clone())
}

/// A machine failed the reports poll, or is turned off: its tasks stay, from
/// what it last said, marked offline.
pub async fn remote_down(id: &str) {
    let mut state = STATE.lock().await;
    load_remote(&mut state).await;
    let Some(machine) = state.remote.get_mut(id).and_then(|r| r.machine.as_mut()) else { return };
    if machine.offline {
        return;
    }
    machine.offline = true;
    save_remote(&state).await;
    drop(state);
    POKE.notify_one();
}

/// Forgets a machine's tasks once nothing here tracks any task on it.
async fn drop_untracked(state: &mut State) {
    let tracked = crate::remote_reports::tracked_machines().await;
    let before = state.remote.len();
    state.remote.retain(|id, _| tracked.contains(id));
    if state.remote.len() != before {
        save_remote(state).await;
    }
}

// ── facts ─────────────────────────────────────────────────────────────────────

/// The live flags of every session here, off the map clients get on connect.
fn facts_of(item: &SessionIndexItem, live: &crate::serve::LiveFlags, marks: &HashMap<String, Marks>, moved_at: &HashMap<String, (String, i64)>) -> TaskFacts {
    let id = item.session_id.as_str();
    let asking = live.asking.contains(id);
    let busy = !asking && item.status == SessionStatus::InProgress;
    let tasked = !asking && !busy && live.tasks.contains(id);
    let background = tasked && !live.serving.contains(id);
    let repo = marks.get(&item.project_path);
    let branch = task_branch(item);
    let pr = repo
        .and_then(|m| pick_mark(m.prs.iter().filter(|p| Some(&p.head_ref_name) == branch.as_ref())))
        .cloned();
    let moved = moved_at.get(id).map_or(i64::MAX, |(_, at)| *at);
    TaskFacts {
        item: item.clone(),
        busy,
        asking,
        background,
        pr,
        pr_fresh: repo.is_some_and(|m| m.known && m.read_at > moved),
        pr_known: repo.is_some_and(|m| m.known),
        machine: None,
        offline: false,
    }
}

/// The sessions here whose stalls matter: every bot's tasks, and the tasks
/// here whose bot is on another machine, with what they started.
struct Here {
    items: Vec<SessionIndexItem>,
    bots: Vec<(Bot, Vec<String>)>,
    owed: Vec<String>,
}

async fn here() -> Here {
    let items = store::read_index().await.unwrap_or_default();
    let bots = crate::bots::bots_here().await;
    let bots = bots
        .into_iter()
        .map(|bot| {
            let path = bot.path.trim_end_matches('/');
            let mut chat: Vec<&SessionIndexItem> =
                items.iter().filter(|i| !i.archived && i.cwd.trim_end_matches('/') == path).collect();
            chat.sort_by_key(|i| ms(&i.created).unwrap_or(0));
            let chat = chat.into_iter().map(|i| i.session_id.clone()).collect();
            (bot, chat)
        })
        .collect();
    let owed = crate::remote_reports::owed_tasks().await;
    Here { items, bots, owed }
}

/// Every task here whose stalls matter: each bot's, and each owed tree.
fn ours_of(here: &Here) -> Vec<&SessionIndexItem> {
    let mut ours: Vec<&SessionIndexItem> = Vec::new();
    for (_, chat) in &here.bots {
        let roots: Vec<&str> = chat.iter().map(String::as_str).collect();
        ours.extend(crew(&here.items, &roots));
    }
    ours.extend(owed_tree(&here.items, &here.owed));
    ours
}

/// The tasks under `owed` and the owed tasks themselves, unsettled.
fn owed_tree<'a>(items: &'a [SessionIndexItem], owed: &'a [String]) -> Vec<&'a SessionIndexItem> {
    let roots: Vec<&str> = owed.iter().map(String::as_str).collect();
    let mut out: Vec<&SessionIndexItem> =
        items.iter().filter(|i| !i.archived && owed.contains(&i.session_id)).collect();
    out.extend(crew(items, &roots));
    out
}

/// The serve command `parent_reports`' extra answer: what this server knows of
/// `children`, tasks here whose bot runs on the asking machine, and of
/// everything they started.
pub async fn facts_for(children: &[String]) -> Vec<TaskFacts> {
    let items = store::read_index().await.unwrap_or_default();
    let live = crate::serve::live_flags();
    let state = STATE.lock().await;
    let mut out: Vec<TaskFacts> = owed_tree(&items, children)
        .into_iter()
        .map(|item| facts_of(item, &live, &state.marks, &state.moved_at))
        .collect();
    // What those tasks started on machines further on, which this server
    // collects and the asking one cannot reach: passed along, named.
    let mut ids: HashSet<String> = out.iter().map(|f| f.item.session_id.clone()).collect();
    loop {
        let more: Vec<TaskFacts> = state
            .remote
            .values()
            .filter_map(|r| r.machine.as_ref().map(|m| (m, &r.facts)))
            .flat_map(|(m, facts)| facts.iter().map(move |f| (m, f)))
            .filter(|(_, f)| {
                !ids.contains(&f.item.session_id)
                    && f.item.parent_session_id.as_ref().is_some_and(|p| ids.contains(p))
            })
            .map(|(m, f)| TaskFacts {
                machine: Some(f.machine.clone().unwrap_or_else(|| m.name.clone())),
                offline: m.offline || f.offline,
                ..f.clone()
            })
            .collect();
        if more.is_empty() {
            break;
        }
        ids.extend(more.iter().map(|f| f.item.session_id.clone()));
        out.extend(more);
    }
    out
}

// ── the loop ──────────────────────────────────────────────────────────────────

/// Runs for the life of the server.
pub async fn run(sink: Sink) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(TICK) => {}
            _ = POKE.notified() => {
                // A send writes the index, flips status and opens a turn in
                // quick succession; one pass covers them all.
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
        pass(&sink).await;
    }
}

/// One pass: read what is due, judge every bot here, nudge, publish.
async fn pass(sink: &Sink) {
    let here = here().await;
    let live = crate::serve::live_flags();
    let now = now_ms();
    let mut state = STATE.lock().await;
    load_remote(&mut state).await;
    drop_untracked(&mut state).await;

    let ours = ours_of(&here);

    // Only repos where a task could stall are read: a busy task waits on work.
    // Every task's repo keeps what it last read, so a pause is not a forgetting.
    let mut kept: HashSet<String> = ours.iter().map(|i| i.project_path.clone()).collect();
    let mut repos: HashSet<String> = HashSet::new();
    for item in &ours {
        let f = facts_of(item, &live, &state.marks, &state.moved_at);
        if !(f.busy || f.background || f.asking || item.aside || item.continue_at.is_some()) {
            repos.insert(item.project_path.clone());
        }
    }
    // A machine that is down has its tasks' PRs read by their GitHub repo.
    // A task further on may be down while the machine that passed it along is not.
    for remote in state.remote.values() {
        let down = remote.machine.as_ref().is_some_and(|m| m.offline);
        for f in remote.facts.iter().filter(|f| down || f.offline) {
            if let Some(slug) = f.pr.as_ref().and_then(|p| crate::github::slug_from_pr_url(&p.url)) {
                repos.insert(format!("{}{slug}", crate::github::SLUG_PREFIX));
            }
        }
        for f in &remote.facts {
            if let Some(slug) = f.pr.as_ref().and_then(|p| crate::github::slug_from_pr_url(&p.url)) {
                kept.insert(format!("{}{slug}", crate::github::SLUG_PREFIX));
            }
        }
    }
    state.marks.retain(|repo, _| kept.contains(repo));
    let due: Vec<String> =
        repos.into_iter().filter(|r| state.marks.get(r).is_none_or(|m| now >= m.due)).collect();
    drop(state);
    let reads = due.into_iter().map(|repo| async move {
        let issued = now_ms();
        let answer = tokio::time::timeout(Duration::from_secs(20), crate::github::pr_marks(repo.clone())).await;
        (repo, issued, answer)
    });
    let answers = futures_util::future::join_all(reads).await;
    // Judged on what holds once GitHub has answered, not before: a task may
    // have moved or gone back to work while the reads ran.
    let here = self::here().await;
    let live = crate::serve::live_flags();
    let now = now_ms();
    let ours = ours_of(&here);
    let mut state = STATE.lock().await;
    for item in &ours {
        let moved = state.moved_at.get(&item.session_id).is_none_or(|(m, _)| m != &item.modified);
        if moved {
            state.moved_at.insert(item.session_id.clone(), (item.modified.clone(), now));
        }
    }
    let ids: HashSet<&str> = ours.iter().map(|i| i.session_id.as_str()).collect();
    state.moved_at.retain(|id, _| ids.contains(id.as_str()));
    for (repo, issued, answer) in answers {
        let marks = state.marks.entry(repo).or_default();
        marks.tried_at = issued;
        match answer {
            Ok(Ok(prs)) => {
                marks.prs = prs;
                marks.read_at = issued;
                marks.due = issued + MARKS_FRESH;
                marks.known = true;
            }
            // A failed read changes nothing, so the last good answer stands.
            // Only one no retry can mend answers "no PR" outright; any other
            // leaves an unread repo unread, its tasks unjudged until one lands.
            Ok(Err(e)) => {
                let gave_up = matches!(e, crate::github::PrUnavailable::NoCli | crate::github::PrUnavailable::NoRemote);
                marks.due = issued + if gave_up { MARKS_GAVE_UP } else { MARKS_RETRY };
                marks.known |= gave_up;
            }
            Err(_) => marks.due = issued + MARKS_RETRY,
        }
    }

    let local: Vec<TaskFacts> = ours.iter().map(|i| facts_of(i, &live, &state.marks, &state.moved_at)).collect();
    let mut remote: Vec<(Remote, TaskFacts)> = Vec::new();
    for r in state.remote.values() {
        let Some(machine) = &r.machine else { continue };
        for f in &r.facts {
            let mut f = f.clone();
            if machine.offline || f.offline {
                // Liveness is as last known; the PR is read afresh by its repo.
                let slug = f.pr.as_ref().and_then(|p| crate::github::slug_from_pr_url(&p.url));
                if let (Some(slug), Some(old)) = (slug, f.pr.clone()) {
                    if let Some(m) = state.marks.get(&format!("{}{slug}", crate::github::SLUG_PREFIX)).filter(|m| m.read_at > 0) {
                        f.pr = pick_mark(m.prs.iter().filter(|p| p.head_ref_name == old.head_ref_name)).cloned().or(Some(old));
                    }
                }
                f.pr_fresh = false;
            }
            // A task further on keeps its own name and state, and is reached
            // through the machine that passed it along.
            let route = match &f.machine {
                Some(name) => Remote { id: machine.id.clone(), name: name.clone(), offline: machine.offline || f.offline },
                None => machine.clone(),
            };
            remote.push((route, f));
        }
    }

    // Every task anywhere, for walking a bot's tree across machines.
    let mut items = here.items.clone();
    let known: HashSet<String> = items.iter().map(|i| i.session_id.clone()).collect();
    items.extend(remote.iter().filter(|(_, f)| !known.contains(&f.item.session_id)).map(|(_, f)| f.item.clone()));
    let by_id: HashMap<&str, Judged> = local
        .iter()
        .map(|f| (f.item.session_id.as_str(), Judged { facts: f, machine: None }))
        .chain(remote.iter().map(|(m, f)| (f.item.session_id.as_str(), Judged { facts: f, machine: Some(m) })))
        .collect();

    let mut cards = Vec::new();
    let mut due_nudges = Vec::new();
    let mut prs: HashMap<&str, &PrMark> = HashMap::new();
    for (bot, chat) in &here.bots {
        let Some(chat_id) = chat.last() else { continue };
        let roots: Vec<&str> = chat.iter().map(String::as_str).collect();
        let tasks: Vec<&SessionIndexItem> = crew(&items, &roots);
        let judged: Vec<Judged> = tasks
            .iter()
            .filter_map(|i| by_id.get(i.session_id.as_str()))
            .map(|j| Judged { facts: j.facts, machine: j.machine })
            .collect();
        for j in &judged {
            if let Some(pr) = &j.facts.pr {
                prs.insert(&j.facts.item.session_id, pr);
            }
        }
        let stalls = stalled(&judged, &mut state.ready_since, now);
        for s in &stalls {
            // A ready stall is nudged even under a need, which a waiting stall
            // wrote and `nudge_bot` clears; only GitHub can say whether a
            // checking PR is still ready; a task whose machine is down cannot act.
            let worth = s.row.kind == StallKind::Ready || s.row.need.is_none();
            if worth && !s.row.checking && !s.row.offline {
                let machine = judged.iter().find(|j| j.facts.item.session_id == s.row.item.session_id).and_then(|j| j.machine.cloned());
                due_nudges.push((s.clone(), machine));
            }
        }
        let rows: Vec<StallRow> = stalls.into_iter().filter(|s| s.fix.is_none()).map(|s| s.row).collect();
        let count = tasks.iter().filter(|t| !t.aside).count() as u32;
        let judged = judged.iter().map(|j| j.facts.item.session_id.clone()).collect();
        cards.push(BotStalls { bot_id: bot.id.clone(), chat_id: chat_id.clone(), rows, tasks: count, fixes: Vec::new(), judged });
    }
    let live_keys: HashSet<String> = state.ready_since.keys().filter(|k| by_id.contains_key(k.split(':').next().unwrap_or_default())).cloned().collect();
    state.ready_since.retain(|k, _| live_keys.contains(k));
    let fixes = prune_fixes(&prs).await;
    drop(prs);

    for card in &mut cards {
        card.fixes = fixes.iter().filter(|f| by_id.contains_key(f.session_id.as_str())).cloned().collect();
    }
    let gone: Vec<String> =
        state.cards.keys().filter(|id| !cards.iter().any(|c| &c.bot_id == *id)).cloned().collect();
    let mut changed = Vec::new();
    for id in gone {
        if let Some(mut card) = state.cards.remove(&id) {
            card.rows.clear();
            card.fixes.clear();
            card.tasks = 0;
            changed.push(card);
        }
    }
    for card in cards {
        let same = state.cards.get(&card.bot_id).is_some_and(|c| serde_json::to_value(c).ok() == serde_json::to_value(&card).ok());
        if !same {
            state.cards.insert(card.bot_id.clone(), card.clone());
            changed.push(card);
        }
    }
    let tried_before = state.tried.clone();
    drop(state);
    for card in changed {
        if let Err(e) = sink.emit("bot_stalls_changed", &card) {
            eprintln!("[stalls emit err] {e}");
        }
    }
    nudge(due_nudges, tried_before, now, sink).await;
}

/// Hands each due stall to its bot once, as a hidden message from the task.
async fn nudge(due: Vec<(Stall, Option<Remote>)>, tried: HashMap<String, i64>, now: i64, sink: &Sink) {
    for (stall, machine) in due {
        let item = &stall.row.item;
        let problem = stall.fix.as_ref().map(|(_, p)| p.clone());
        let ready = (stall.row.kind == StallKind::Ready).then(|| stall.row.pr.as_ref().map(|p| p.number as u32)).flatten();
        let mark = nudge_mark(item, problem.as_deref(), ready);
        if nudged(&mark).await || tried.get(&mark).is_some_and(|at| now - at < NUDGE_RETRY) {
            continue;
        }
        STATE.lock().await.tried.insert(mark.clone(), now);
        let sent = match &machine {
            None => crate::orchestration::nudge_bot(
                item.session_id.clone(),
                problem.clone(),
                ready,
                Some(item.modified.clone()),
                sink.clone(),
            )
                .await
                .map(Some)
                .map_err(|e| format!("{e:?}")),
            Some(machine) => nudge_remote(machine, item, problem.as_deref(), ready).await,
        };
        match sent {
            // Nobody will read it yet: tried again after `NUDGE_RETRY`.
            Ok(Some(false)) => continue,
            Ok(sent) => {
                STATE.lock().await.tried.remove(&mark);
                note_nudged(mark).await;
                if let (Some(true), Some((status, _)), Some(pr)) = (sent, &stall.fix, &stall.row.pr) {
                    note_fix(&item.session_id, pr.number, status).await;
                }
            }
            Err(e) => eprintln!("[stalls nudge err] {}: {e}", item.session_id),
        }
    }
    // Tries of stalls long gone are forgotten.
    STATE.lock().await.tried.retain(|_, at| now - *at < 10 * NUDGE_RETRY);
}

/// A task on another machine is nudged by its own server, which keeps the
/// nudge with its reports for the poll to bring here.
async fn nudge_remote(machine: &Remote, task: &SessionIndexItem, problem: Option<&str>, ready: Option<u32>) -> Result<Option<bool>, String> {
    let saved = crate::machines::load().await.into_iter().find(|m| m.id == machine.id).ok_or("machine removed")?;
    let args = serde_json::json!({
        "sessionId": task.session_id, "problem": problem, "ready": ready, "judged": task.modified,
    });
    let answer = tokio::time::timeout(crate::machines::SWEEP, crate::machines::call(&saved, "nudge_bot", args))
        .await
        .map_err(|_| format!("{} did not answer in time", machine.name))??;
    Ok(answer.as_bool())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, modified: &str) -> SessionIndexItem {
        serde_json::from_value(serde_json::json!({
            "sessionId": id, "harness": "claude_code", "cwd": "/r", "projectPath": "/r",
            "branch": "b", "worktreeName": null, "title": id, "status": "idle",
            "parentSessionId": "chat", "created": modified, "modified": modified,
            "archived": false, "pinned": false,
        }))
        .unwrap()
    }

    fn mark(number: u64, mergeable: &str, status: &str, checks: PrChecksState) -> PrMark {
        serde_json::from_value(serde_json::json!({
            "number": number, "url": format!("https://github.com/o/r/pull/{number}"), "headRefName": "b",
            "isDraft": false, "state": "OPEN", "checksState": checks,
            "mergeable": mergeable, "mergeStateStatus": status, "reviewDecision": null,
        }))
        .unwrap()
    }

    fn facts(item: SessionIndexItem, pr: Option<PrMark>) -> TaskFacts {
        TaskFacts {
            item,
            busy: false,
            asking: false,
            background: false,
            pr,
            pr_fresh: false,
            pr_known: true,
            machine: None,
            offline: false,
        }
    }

    const T0: &str = "2026-01-01T00:00:00Z";

    fn at(min: i64) -> i64 {
        ms(T0).unwrap() + min * 60_000
    }

    fn judge(tasks: &[TaskFacts], since: &mut HashMap<String, i64>, now: i64) -> Vec<Stall> {
        let judged: Vec<Judged> = tasks.iter().map(|f| Judged { facts: f, machine: None }).collect();
        stalled(&judged, since, now)
    }

    #[test]
    fn idle_task_waits_after_two_minutes() {
        let t = [facts(item("a", T0), None)];
        assert!(judge(&t, &mut HashMap::new(), at(1)).is_empty());
        let s = judge(&t, &mut HashMap::new(), at(2));
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].row.kind, StallKind::Waiting);
        assert_eq!(s[0].row.key, format!("a:waiting:{T0}"));
    }

    #[test]
    fn usage_limited_aside_busy_and_unread_marks_are_left_out() {
        let mut limited = item("a", T0);
        limited.continue_at = Some(T0.into());
        let mut aside = item("b", T0);
        aside.aside = true;
        let mut busy = facts(item("c", T0), None);
        busy.busy = true;
        let mut unread = facts(item("d", T0), None);
        unread.pr_known = false;
        let t = [facts(limited, None), facts(aside, None), busy, unread];
        assert!(judge(&t, &mut HashMap::new(), at(10)).is_empty());
    }

    #[test]
    fn ready_pr_is_a_ready_row_and_stays_checking_through_unknown() {
        let mut since = HashMap::new();
        let ready = [facts(item("a", T0), Some(mark(7, "MERGEABLE", "CLEAN", PrChecksState::Clear)))];
        let s = judge(&ready, &mut since, at(3));
        assert_eq!((s[0].row.kind, s[0].row.checking), (StallKind::Ready, false));
        let unknown = [facts(item("a", T0), Some(mark(7, "UNKNOWN", "UNKNOWN", PrChecksState::Clear)))];
        let s = judge(&unknown, &mut since, at(4));
        assert_eq!((s[0].row.kind, s[0].row.checking), (StallKind::Ready, true));
        assert_eq!(s[0].row.key, format!("a:ready:7:{T0}"));
        // Never seen ready: an unknown PR waits it out.
        assert!(judge(&unknown, &mut HashMap::new(), at(4)).is_empty());
    }

    #[test]
    fn ready_counts_from_when_it_turned_ready() {
        let mut since = HashMap::new();
        let blocked = [facts(item("a", T0), Some(mark(7, "MERGEABLE", "BLOCKED", PrChecksState::Clear)))];
        judge(&blocked, &mut since, at(5));
        let ready = [facts(item("a", T0), Some(mark(7, "MERGEABLE", "CLEAN", PrChecksState::Clear)))];
        assert!(judge(&ready, &mut since, at(6)).is_empty());
        let s = judge(&ready, &mut since, at(8));
        assert_eq!(s[0].row.since, at(6));
    }

    #[test]
    fn a_fix_is_the_bots_and_called_at_once_only_on_a_fresh_read() {
        let mut f = facts(item("a", T0), Some(mark(7, "CONFLICTING", "DIRTY", PrChecksState::Clear)));
        assert!(judge(std::slice::from_ref(&f), &mut HashMap::new(), at(1)).is_empty());
        f.pr_fresh = true;
        let s = judge(&[f], &mut HashMap::new(), at(1));
        assert_eq!(s[0].fix.as_ref().unwrap().0, "conflict");
        assert_eq!(s[0].row.key, format!("a:conflict:{T0}"));
    }

    #[test]
    fn a_drafts_failing_checks_wait_on_the_reader() {
        let mut pr = mark(7, "MERGEABLE", "BLOCKED", PrChecksState::Failing);
        pr.is_draft = true;
        let s = judge(&[facts(item("a", T0), Some(pr))], &mut HashMap::new(), at(3));
        assert!(s[0].fix.is_none());
        assert_eq!(s[0].row.kind, StallKind::Waiting);
    }

    #[test]
    fn running_checks_and_merged_prs_are_left_out() {
        let running = mark(7, "MERGEABLE", "BLOCKED", PrChecksState::Running);
        let mut merged = mark(8, "MERGEABLE", "CLEAN", PrChecksState::Clear);
        merged.state = PrMarkState::Merged;
        let t = [facts(item("a", T0), Some(running)), facts(item("b", T0), Some(merged))];
        assert!(judge(&t, &mut HashMap::new(), at(10)).is_empty());
    }

    #[test]
    fn need_counts_only_once_written_since_the_task_moved() {
        let mut i = item("a", T0);
        i.need = Some(store::TaskNeed { text: "Try it".into(), at: "2025-12-31T23:59:00Z".into() });
        assert_eq!(need_line(&i), None);
        i.need = Some(store::TaskNeed { text: "Try it".into(), at: "2026-01-01T00:01:00Z".into() });
        assert_eq!(need_line(&i).as_deref(), Some("Try it"));
    }

    #[test]
    fn crew_walks_through_a_settled_parent_by_adoption() {
        let mut task = item("task", T0);
        task.archived = true;
        let mut sub = item("sub", T0);
        sub.parent_session_id = Some("task".into());
        sub.adopted_by = Some("chat".into());
        let other = item("other", T0);
        let items = [task, sub, other];
        let ids: Vec<&str> = crew(&items, &["chat"]).iter().map(|i| i.session_id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"sub") && ids.contains(&"other"));
    }

    #[test]
    fn nudge_marks_match_however_the_nudge_is_sent() {
        let i = item("a", T0);
        assert_eq!(nudge_mark(&i, None, Some(7)), format!("a:{T0}:ready:7"));
        assert_eq!(nudge_mark(&i, None, None), format!("a:{T0}:waiting"));
        assert_ne!(nudge_mark(&i, Some("x"), None), nudge_mark(&i, Some("y"), None));
    }
}
