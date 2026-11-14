//! How a bot learns from its mistakes (#973): the lessons a turn left in its
//! folder, drawn as "Learned" rows the reader can view and undo, and the hidden
//! review Dray asks for after a correction or a failed task.
//!
//! Lessons live where they fire: standing rules in `INSTRUCTIONS.md`, which is
//! in every prompt; how-tos as skills, which the agent loads by description;
//! facts in `memory/`, which it greps. A lesson filed in memory alone never
//! fires, which is the failure this exists for.

use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use ts_rs::TS;

use super::{commit_paths, git, Bot, HISTORY_LOCK, INSTRUCTIONS, MEMORY};
use crate::events::{AgentEventPayload, LearnedFile, MessageSender};

/// Where a bot's skills live: Claude Code reads them there since the bot runs
/// in its folder, and `.agents/skills` links to it for Codex and pi.
pub const SKILLS: &str = ".claude/skills";
/// Codex and pi read `.agents/skills`, never `.claude/skills`; a symlink is
/// followed by both, verified against `skills/list` and pi's docs.
pub const AGENT_SKILLS: &str = ".agents/skills";

/// A skill's `SKILL.md` is read whole whenever it fires, so a long one costs
/// every task it helps. Hermes lints past ~24k; a bot's are narrower.
const SKILL_CAP: usize = 8_000;
/// A memory is one fact.
const MEMORY_CAP: usize = 4_000;

/// How every review opens, which is how a turn is known to be one.
pub const REVIEW: &str = "Review:";
const REVIEW_PROMPT: &str = include_str!("review_prompt.md");
/// One review per bot chat in this long, so a run of corrections or failed
/// tasks costs one extra turn, not one each.
const REVIEW_GAP: Duration = Duration::from_secs(5 * 60);

/// What the prompts opening a turn said, gathered as each is logged and read
/// when the turn ends. In memory: a review lost to a restart costs nothing.
#[derive(Debug, Default)]
pub struct TurnNotes {
    /// The reader's message reads as a correction.
    corrected: bool,
    /// Tasks whose report says they failed, as (id, title).
    failed: Vec<(String, String)>,
    /// A review is among the turn's prompts.
    review: bool,
    /// Anything not Dray's is too: the reader, a task or another bot. Kept
    /// apart from `review` so arrival order cannot hide it: a review queued
    /// behind the reader's message joins that same turn.
    joined: bool,
}

impl TurnNotes {
    /// Opened by a review alone: nothing from the reader or a task joined it,
    /// so the add-only rule for instructions applies.
    pub fn reviewing(&self) -> bool {
        self.review && !self.joined
    }
}

static NOTES: LazyLock<Mutex<HashMap<String, TurnNotes>>> = LazyLock::new(Default::default);
static LAST_REVIEW: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Default::default);

/// Notes a prompt as it is logged. `dray` marks Dray's own — a kickoff or a
/// review — which nobody wrote and so corrects nothing.
pub fn note_prompt(session_id: &str, prompt: &str, from: Option<&MessageSender>, dray: bool) {
    let mut notes = NOTES.lock().unwrap();
    let notes = notes.entry(session_id.to_string()).or_default();
    if dray {
        notes.review |= prompt.starts_with(REVIEW);
        return;
    }
    notes.joined = true;
    match from {
        None => notes.corrected |= is_correction(prompt),
        // Another bot's message is a colleague's, not a report.
        Some(f) if f.bot_id.is_none() => {
            // The relayed text opens with the sender line `attribute` adds.
            let text = prompt.split_once("\n\n").map_or(prompt, |(_, rest)| rest);
            if is_failure(text) {
                notes.failed.push((f.session_id.clone(), f.title.clone()));
            }
        }
        Some(_) => {}
    }
}

/// Takes what the turn now ending was opened with. Every session's turn takes
/// its own, bot or not, so nothing piles up.
pub fn take_notes(session_id: &str) -> TurnNotes {
    NOTES.lock().unwrap().remove(session_id).unwrap_or_default()
}

/// What a bot's turn left behind: its commit and the lessons in it.
#[derive(Debug, Default)]
pub struct Turn {
    pub commit: Option<String>,
    pub files: Vec<LearnedFile>,
    /// Lesson files now over their cap, said as the review should read it.
    pub oversize: Vec<String>,
    pub notes: TurnNotes,
}

impl Turn {
    /// The "Learned" event for the chat, where the turn changed a lesson.
    pub fn learned(&self) -> Option<AgentEventPayload> {
        let commit = self.commit.clone()?;
        (!self.files.is_empty()).then(|| AgentEventPayload::Learned { commit, files: self.files.clone() })
    }

    /// The review to ask for after this turn, if one is owed.
    ///
    /// Never after a turn a review was in, or a review would beget another. A correction or
    /// failure is owed one only where the turn learned nothing itself: the
    /// prompt asks the bot to fix the cause in the same turn, and one that did
    /// needs no second look. A file over its cap always is.
    pub fn review(&self, session_id: &str) -> Option<String> {
        if self.notes.review {
            return None;
        }
        let mut reasons = Vec::new();
        if self.files.is_empty() {
            if self.notes.corrected {
                reasons.push("The user just corrected you.".to_string());
            }
            for (id, title) in &self.notes.failed {
                reasons.push(format!("Your task \"{title}\" ({id}) reported that something failed."));
            }
        }
        reasons.extend(self.oversize.iter().cloned());
        if reasons.is_empty() {
            return None;
        }
        let mut last = LAST_REVIEW.lock().unwrap();
        if last.get(session_id).is_some_and(|at| at.elapsed() < REVIEW_GAP) {
            return None;
        }
        last.insert(session_id.to_string(), Instant::now());
        Some(super::fill(REVIEW_PROMPT, &[("reason", &reasons.join(" "))]))
    }
}

/// What the bot is told when the reader undoes a lesson. Opened like a review,
/// so it is hidden the same way, its words are dropped, and it may only add
/// to the instructions it is about.
pub fn undone_prompt(path: &str, commit: &str) -> String {
    let short = commit.get(..7).unwrap_or(commit);
    format!(
        "{REVIEW} The user undid what your commit {short} changed in `{path}` (`git show {short}` has it). \
         Stop following what that change said, even where your instructions as you started still hold it, \
         and never add it back. Change nothing else, and end your turn without writing a word."
    )
}

/// Whether each event sits in a turn a review opened, in order. Whatever the
/// bot says there is for nobody: told to write no reply, it sometimes still
/// explains itself, and that must not reach the chat, the sidebar's preview
/// or a new agent's replay.
pub fn in_review(events: &[crate::events::AgentEvent]) -> Vec<bool> {
    let mut on = false;
    events
        .iter()
        .map(|e| {
            if let AgentEventPayload::UserMessage { text, kickoff, .. } = &e.payload {
                on = *kickoff && text.starts_with(REVIEW);
            }
            on
        })
        .collect()
}

/// Whether `path`, relative to a bot's folder, is a lesson: its instructions,
/// a skill, or a memory.
pub fn is_lesson(path: &str) -> bool {
    path == INSTRUCTIONS || path.starts_with(&format!("{SKILLS}/")) || path.starts_with(&format!("{MEMORY}/"))
}

/// Makes the skills folder and the link Codex and pi read it through. A
/// `.agents/skills` the bot made itself is left alone.
pub async fn ensure_skills(dir: &Path) {
    tokio::fs::create_dir_all(dir.join(SKILLS)).await.ok();
    let link = dir.join(AGENT_SKILLS);
    if tokio::fs::symlink_metadata(&link).await.is_ok() {
        return;
    }
    tokio::fs::create_dir_all(dir.join(".agents")).await.ok();
    #[cfg(unix)]
    if let Err(e) = tokio::fs::symlink("../.claude/skills", &link).await {
        eprintln!("[bot skills] {e:#}");
    }
}

/// A review may only add to the instructions: the rules there are the user's,
/// and an automated pass that rewrote one would change what the user asked
/// for with nobody asking. Where the turn took any line away, its edit to the
/// file is put back whole before the commit.
pub async fn keep_rules(dir: &Path) -> Result<bool> {
    let diff = git(dir, &["diff", "-U0", "HEAD", "--", INSTRUCTIONS]).await?;
    if !diff.lines().any(|l| l.starts_with('-') && !l.starts_with("---")) {
        return Ok(false);
    }
    git(dir, &["checkout", "HEAD", "--", INSTRUCTIONS]).await?;
    Ok(true)
}

/// The lessons `commit` changed, and which of them are now over their cap.
pub async fn read_commit(dir: &Path, commit: &str) -> Result<(Vec<LearnedFile>, Vec<String>)> {
    let status = git(dir, &["show", "--format=", "--no-renames", "--name-status", "-z", commit]).await?;
    let mut parts = status.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    let mut oversize = Vec::new();
    while let (Some(code), Some(path)) = (parts.next(), parts.next()) {
        if !is_lesson(path) {
            continue;
        }
        let change = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "removed",
            _ => "changed",
        };
        let now = match change {
            "removed" => String::new(),
            _ => show(dir, commit, path).await,
        };
        let before = match change {
            "added" => String::new(),
            _ => show(dir, &format!("{commit}^"), path).await,
        };
        let (kind, summary) = describe(dir, commit, path, change, &before, &now).await;
        if let Some(cap) = cap(path).filter(|cap| now.chars().count() > *cap) {
            oversize.push(format!("`{path}` is {} characters, over its {cap} cap: trim it.", now.chars().count()));
        }
        files.push(LearnedFile { path: path.to_string(), kind: kind.into(), change: change.into(), summary });
    }
    Ok((files, oversize))
}

/// The cap a review is asked to trim a file to. None for the instructions: a
/// review may only add there, and trimming rules is the user's call, so the
/// cut notice in the prompt (`capped`) asks the user instead.
fn cap(path: &str) -> Option<usize> {
    if path.starts_with(MEMORY) {
        Some(MEMORY_CAP)
    } else if path.ends_with("/SKILL.md") {
        Some(SKILL_CAP)
    } else {
        None
    }
}

/// The row's kind and its one line.
async fn describe(dir: &Path, commit: &str, path: &str, change: &str, before: &str, now: &str) -> (&'static str, String) {
    let text = if change == "removed" { before } else { now };
    if path == INSTRUCTIONS {
        let diff = git(dir, &["show", "--format=", "--no-renames", "-U0", commit, "--", path]).await.unwrap_or_default();
        let added: Vec<&str> =
            diff.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).map(|l| l[1..].trim()).collect();
        // A rule over the heading it was filed under, which names no lesson.
        let rule = added.iter().find(|l| !l.is_empty() && !l.starts_with('#')).or(added.iter().find(|l| !l.is_empty()));
        let summary = rule.map_or_else(|| "Removed a rule from its instructions".into(), |l| clean(l));
        return ("instructions", one_line(&summary));
    }
    if let Some(rest) = path.strip_prefix(&format!("{SKILLS}/")) {
        let (name, file) = rest.split_once('/').unwrap_or((rest, ""));
        let summary = match file {
            "SKILL.md" => description(text).unwrap_or_else(|| format!("The {name} skill")),
            _ => format!("{file} in the {name} skill"),
        };
        return ("skill", one_line(&summary));
    }
    let stem = Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    ("memory", one_line(&description(text).unwrap_or(stem)))
}

/// The `description` in a file's frontmatter, where it is one line.
fn description(text: &str) -> Option<String> {
    let rest = text.trim_start().strip_prefix("---")?;
    let head = &rest[..rest.find("\n---")?];
    let value = head.lines().find_map(|l| l.trim().strip_prefix("description:"))?;
    let value = value.trim().trim_matches(['"', '\'']).trim();
    // A folded or literal block (`>`, `|`) says nothing on this line.
    (!value.is_empty() && !value.starts_with(['>', '|'])).then(|| value.to_string())
}

/// A markdown line without its bullet, heading or emphasis marks.
fn clean(line: &str) -> String {
    line.trim().trim_start_matches(['-', '*', '#', '>', ' ']).replace("**", "").trim().to_string()
}

fn one_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    match line.char_indices().nth(140) {
        Some((at, _)) => format!("{}…", line[..at].trim_end()),
        None => line.to_string(),
    }
}

/// A file as `rev` holds it, empty where it holds none.
async fn show(dir: &Path, rev: &str, path: &str) -> String {
    git(dir, &["show", &format!("{rev}:{path}")]).await.unwrap_or_default()
}

/// One file of a "Learned" row, before and after, for View diff.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct LearnedDiff {
    pub path: String,
    pub before: String,
    pub after: String,
}

/// The commit and path a row names, checked: the frontend's word is all they
/// rest on, and both reach git.
fn checked<'a>(commit: &'a str, path: &'a str) -> Result<(&'a str, &'a str)> {
    let hex = (7..=64).contains(&commit.len()) && commit.chars().all(|c| c.is_ascii_hexdigit());
    let inside = Path::new(path).components().all(|c| matches!(c, Component::Normal(_)));
    if !hex || !inside || !is_lesson(path) {
        bail!("not a lesson of this bot's");
    }
    Ok((commit, path))
}

pub async fn diff(bot: &Bot, commit: &str, path: &str) -> Result<LearnedDiff> {
    let (commit, path) = checked(commit, path)?;
    let dir = Path::new(&bot.path);
    Ok(LearnedDiff {
        path: path.to_string(),
        before: show(dir, &format!("{commit}^"), path).await,
        after: show(dir, commit, path).await,
    })
}

/// Reverts what `commit` did to `path` and commits that alone. The commit says
/// the user undid it, which the prompt tells the bot never to add back.
///
/// Reverted as a patch rather than restored from the commit's parent, so a
/// later change to the same file survives; one that overlaps refuses instead.
pub async fn undo(bot: &Bot, commit: &str, path: &str) -> Result<()> {
    let (commit, path) = checked(commit, path)?;
    let dir = Path::new(&bot.path);
    let _guard = HISTORY_LOCK.lock().await;
    // Uncommitted means a turn is writing it: an undo now would be committed
    // under the bot's half-made edit.
    if !git(dir, &["status", "--porcelain", "--", path]).await?.trim().is_empty() {
        bail!("the bot is changing this file now; try again once its turn ends");
    }
    let patch = git(dir, &["show", "--format=", "--no-renames", "--binary", commit, "--", path]).await?;
    if patch.trim().is_empty() {
        bail!("that change is not in this bot's history");
    }
    let file = dir.join(".git").join("dray-undo.patch");
    tokio::fs::write(&file, patch).await.context("could not write the undo")?;
    let applied = git(dir, &["apply", "-R", &file.to_string_lossy()]).await;
    tokio::fs::remove_file(&file).await.ok();
    if applied.is_err() {
        bail!("{path} has changed since; ask the bot to undo it");
    }
    commit_paths(bot, &format!("Undone by the user: {path} from {}", &commit[..7]), &[path]).await
}

/// Starts of a message that correct: a "no", or a rule said outright.
const CORRECTING_OPENERS: [&str; 16] = [
    "no", "nope", "wrong", "stop", "don't", "dont", "do not", "never", "always", "not like that", "that's wrong",
    "that's not", "that is not", "actually", "why did you", "why didn't you",
];
const CORRECTING: [&str; 26] = [
    "you should have", "you should've", "you shouldn't have", "you forgot", "you missed", "you didn't", "you did not",
    "why did you", "why didn't you", "i told you", "i already told", "i said", "i asked you", "next time",
    "from now on", "not what i", "didn't work", "doesn't work", "still broken", "still failing", "please don't",
    "stop doing", "remember to", "make sure you", "you broke", "should have checked",
];
const FAILING: [&str; 11] = [
    "failed", "couldn't", "could not", "can't", "cannot", "unable to", "blocked", "not logged in", "expired",
    "permission denied", "gave up",
];

/// Whether the reader's message reads as a correction or a standing rule.
/// Generous on purpose: a false one costs a review that ends silently, a
/// missed one a lesson the bot never keeps.
fn is_correction(text: &str) -> bool {
    let t = normalized(text, 400);
    CORRECTING_OPENERS.iter().any(|w| starts_with_word(&t, w)) || CORRECTING.iter().any(|w| has_word(&t, w))
}

/// Whether a task's report says something failed. Read from its opening,
/// where a task leads with the outcome. A stall nudge is Dray's, not a failure.
fn is_failure(text: &str) -> bool {
    let t = normalized(text, 600);
    !t.starts_with("stall nudge:") && (t.starts_with("(the turn failed") || FAILING.iter().any(|w| has_word(&t, w)))
}

fn normalized(text: &str, keep: usize) -> String {
    let t: String = text.chars().take(keep).collect::<String>().to_lowercase().replace(['\u{2019}', '\u{2018}'], "'");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn starts_with_word(text: &str, word: &str) -> bool {
    text.strip_prefix(word).is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric()))
}

fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let before = text[..at].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
        before && starts_with_word(&text[at..], word)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrections_are_read_and_ordinary_asks_are_not() {
        for text in [
            "No, check the login first",
            "You should have checked the Claude login before forking",
            "Why didn’t you fix the script too?",
            "From now on open PRs ready",
            "Always run the tests",
        ] {
            assert!(is_correction(text), "{text}");
        }
        for text in ["Now open a PR for the pricing page", "Nothing else for today", "Notes are in the doc"] {
            assert!(!is_correction(text), "{text}");
        }
    }

    #[test]
    fn a_failed_report_is_read_and_a_nudge_is_not() {
        assert!(is_failure("Couldn't fork: the Claude login in the sandbox has expired."));
        assert!(is_failure("(the turn failed: error_during_execution)"));
        assert!(!is_failure("Stall nudge: this task has sat untouched for 5m. Its checks failed."));
        assert!(!is_failure("Done, PR #12 is up and checks pass."));
    }

    #[test]
    fn notes_mark_a_review_turn_only_while_nothing_else_joins_it() {
        let id = "learn-notes-test";
        note_prompt(id, "Review: The user just corrected you.", None, true);
        assert!(take_notes(id).reviewing());
        note_prompt(id, "Review: x", None, true);
        note_prompt(id, "no, the other one", None, false);
        let notes = take_notes(id);
        assert!(!notes.reviewing() && notes.corrected);
        // A review queued behind the reader's message joins that turn too.
        note_prompt(id, "remove the second rule", None, false);
        note_prompt(id, "Review: x", None, true);
        assert!(!take_notes(id).reviewing());
    }

    #[test]
    fn a_task_report_is_read_past_its_sender_line() {
        let id = "learn-report-test";
        let from = MessageSender { session_id: "t1".into(), title: "Fork box".into(), machine: None, bot_id: None };
        note_prompt(id, "[message from the Dray session \"Fork box\" (t1)]\n\nCould not log in.", Some(&from), false);
        assert_eq!(take_notes(id).failed, vec![("t1".to_string(), "Fork box".to_string())]);
    }

    #[test]
    fn a_review_is_owed_once_and_never_after_a_review_or_a_lesson() {
        let corrected = || TurnNotes { corrected: true, ..Default::default() };
        let turn = Turn { notes: corrected(), ..Default::default() };
        let prompt = turn.review("learn-review-test").expect("owed");
        assert!(prompt.starts_with(REVIEW) && prompt.contains("corrected you"));
        assert!(turn.review("learn-review-test").is_none(), "held for the gap");

        let learned = LearnedFile { path: INSTRUCTIONS.into(), kind: "instructions".into(), change: "changed".into(), summary: "x".into() };
        let turn = Turn { files: vec![learned], notes: corrected(), ..Default::default() };
        assert!(turn.review("learn-review-test-2").is_none());
        let turn = Turn { notes: TurnNotes { review: true, corrected: true, ..Default::default() }, ..Default::default() };
        assert!(turn.review("learn-review-test-3").is_none());
    }

    #[test]
    fn lessons_are_the_three_homes_and_nothing_else() {
        assert!(is_lesson("INSTRUCTIONS.md"));
        assert!(is_lesson(".claude/skills/fork-box/SKILL.md"));
        assert!(is_lesson("memory/2026-11-13-who.md"));
        assert!(!is_lesson("notes.md") && !is_lesson(".claude/settings.json") && !is_lesson(".agents/skills"));
        assert!(checked("abc1234", "../INSTRUCTIONS.md").is_err());
        assert!(checked("abc1234; rm", "INSTRUCTIONS.md").is_err());
        assert!(checked("abc1234", "memory/x.md").is_ok());
    }

    #[test]
    fn a_description_is_read_off_one_line_of_frontmatter() {
        assert_eq!(description("---\nname: x\ndescription: \"Fork a Boat sandbox\"\n---\nbody").as_deref(), Some("Fork a Boat sandbox"));
        assert_eq!(description("---\ndescription: >\n  folded\n---\n"), None);
        assert_eq!(description("no frontmatter"), None);
        assert_eq!(clean("- **Check** the login first"), "Check the login first");
    }

    fn scratch_bot() -> (Bot, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dray-learn-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let bot = Bot {
            id: "b1".into(),
            name: "Ops".into(),
            path: dir.to_string_lossy().into_owned(),
            created: String::new(),
            avatar: None,
            welcome: None,
            greeting: Vec::new(),
        };
        (bot, dir)
    }

    #[tokio::test]
    async fn a_turn_is_read_back_and_one_file_undone() {
        let (bot, dir) = scratch_bot();
        super::super::start_history(&bot).await.unwrap();
        let skill = dir.as_path().join(SKILLS).join("fork-box");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\ndescription: Fork a Boat sandbox, checking its login first\n---\n1. Run check-login.\n").unwrap();
        std::fs::write(dir.as_path().join(INSTRUCTIONS), "# Ops\n\n- Check a sandbox's Claude login before forking it\n").unwrap();
        std::fs::write(dir.as_path().join("scratch.txt"), "not a lesson").unwrap();

        let turn = super::super::commit_bot_turn(&bot, TurnNotes::default()).await;
        let commit = turn.commit.clone().unwrap();
        let mut summaries: Vec<_> = turn.files.iter().map(|f| (f.kind.as_str(), f.change.as_str(), f.summary.as_str())).collect();
        summaries.sort();
        assert_eq!(
            summaries,
            vec![
                ("instructions", "added", "Check a sandbox's Claude login before forking it"),
                ("skill", "added", "Fork a Boat sandbox, checking its login first"),
            ]
        );

        let diff = diff(&bot, &commit, ".claude/skills/fork-box/SKILL.md").await.unwrap();
        assert!(diff.before.is_empty() && diff.after.contains("check-login"));

        undo(&bot, &commit, ".claude/skills/fork-box/SKILL.md").await.unwrap();
        assert!(!skill.join("SKILL.md").exists());
        assert!(dir.as_path().join(INSTRUCTIONS).exists(), "only the one file");
        let log = git(dir.as_path(), &["log", "-1", "--format=%s"]).await.unwrap();
        assert!(log.starts_with("Undone by the user"), "{log}");
        assert!(undo(&bot, &commit, ".claude/skills/fork-box/SKILL.md").await.is_err(), "twice refuses");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_review_cannot_take_a_rule_away() {
        let (bot, dir) = scratch_bot();
        std::fs::write(dir.as_path().join(INSTRUCTIONS), "- Rule the user wrote\n").unwrap();
        super::super::start_history(&bot).await.unwrap();
        std::fs::write(dir.as_path().join(INSTRUCTIONS), "- A rewritten rule\n").unwrap();
        let review = TurnNotes { review: true, ..Default::default() };
        let turn = super::super::commit_bot_turn(&bot, review).await;
        assert!(turn.files.is_empty());
        assert_eq!(std::fs::read_to_string(dir.as_path().join(INSTRUCTIONS)).unwrap(), "- Rule the user wrote\n");

        std::fs::write(dir.as_path().join(INSTRUCTIONS), "- Rule the user wrote\n- Check the login first\n").unwrap();
        let review = TurnNotes { review: true, ..Default::default() };
        let turn = super::super::commit_bot_turn(&bot, review).await;
        assert_eq!(turn.files[0].summary, "Check the login first");
        std::fs::remove_dir_all(&dir).ok();
    }
}
