//! Issue cards: GitHub issues an agent lists for the reader with `dray session
//! issue-card`, each row opened in the issues view and approved in place.
//! Approving puts [`READY`] on the issue and tells the agent, the way a
//! reader's reaction does, so it can start.

use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use dray_proto::Response;

use super::github;
use crate::events::{AgentEvent, AgentEventPayload, IssueCardRow};
use crate::{session::manager, sink::Sink, store, Fail};

/// The label an approval adds. What a bot's own instructions can watch for.
pub const READY: &str = "ready";
/// GitHub's green, for a repository that has no `ready` label yet.
const READY_COLOR: &str = "0e8a16";

/// More rows than this is a list to triage on the issues page, not a card.
const MAX_ROWS: usize = 20;

/// Posts a card listing `card.numbers` of `card.repo` in the calling chat.
/// Each issue is read now, so a wrong number is refused rather than drawn.
pub async fn post(card: dray_proto::IssueCard, app: &Sink) -> Result<Response> {
    let chat = store::get_session_index_item(&card.session_id)
        .await?
        .with_context(|| format!("no session {}", card.session_id))?;
    let repo = card.repo.trim().trim_end_matches(".git").trim_start_matches("https://github.com/");
    if github::split_identifier(&format!("{repo}#1")).is_none() {
        bail!("name the repository as owner/name, not \"{}\"", card.repo);
    }
    let mut numbers = card.numbers.clone();
    let mut seen = std::collections::HashSet::new();
    numbers.retain(|n| seen.insert(*n));
    if numbers.is_empty() {
        bail!("name at least one issue number");
    }
    if numbers.len() > MAX_ROWS {
        bail!("a card holds {MAX_ROWS} issues at most; post the most important ones");
    }

    let reads = numbers.iter().map(|&n| github::get_row(repo, n));
    let mut issues = Vec::with_capacity(numbers.len());
    for (number, read) in numbers.iter().zip(futures_util::future::join_all(reads).await) {
        let issue = read.map_err(|e| anyhow::anyhow!("could not read {repo}#{number}: {e}"))?;
        issues.push(IssueCardRow {
            number: *number,
            title: issue.title,
            url: issue.url,
            closed: issue.state.kind == super::IssueStateKind::Completed,
            labels: issue.labels,
        });
    }
    let said = issues.iter().map(|i| format!("#{} {}", i.number, i.title)).collect();
    let title = card.title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let payload = AgentEventPayload::IssueCard { title, repo: repo.to_string(), issues };
    manager().post_event(&chat.session_id, chat.harness, payload, app).await?;
    Ok(Response::IssueCard { issues: said })
}

/// Held over an approval's check and its log, so a double click cannot add
/// two approvals and tell the agent twice.
static APPROVING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The reader approved issue `number` on card `card_id` in `session_id`: puts
/// [`READY`] on it, logs the approval on the card, and tells the agent in a
/// hidden prompt so it can start. Refused where it is already approved here.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn approve_issue(session_id: String, card_id: String, number: u64, sink: Sink) -> Result<(), Fail> {
    let _held = APPROVING.lock().await;
    let item = store::get_session_index_item(&session_id).await?.context("no such session")?;
    let (repo, row, approved) = find_card(&session_id, &card_id).await?;
    let row = row(number).with_context(|| format!("#{number} is not on this card"))?;
    if approved.contains(&number) {
        return Err(anyhow::anyhow!("#{number} is already approved").into());
    }
    let labels = github::add_label(&repo, number, READY, READY_COLOR)
        .await
        .map_err(|e| anyhow::anyhow!("could not label {repo}#{number}: {e}"))?;
    let payload = AgentEventPayload::IssueApproved { card_id, number, labels };
    manager().log_event(&session_id, item.harness, payload, &sink).await?;
    crate::orchestration::send_review(session_id, approval_prompt(&repo, &row), sink).await?;
    Ok(())
}

/// The card `card_id`'s repo, a lookup of its rows by number, and the numbers
/// already approved on it. Read back from the end, as approvals come after it.
async fn find_card(session_id: &str, card_id: &str) -> Result<(String, impl Fn(u64) -> Option<IssueCardRow>, Vec<u64>)> {
    let approved = Mutex::new(Vec::new());
    let card = store::find_newest(session_id, |events: &[AgentEvent]| {
        let mut found = None;
        for e in events {
            match &e.payload {
                AgentEventPayload::IssueApproved { card_id: c, number, .. } if c == card_id => {
                    approved.lock().unwrap().push(*number);
                }
                AgentEventPayload::IssueCard { repo, issues, .. } if e.id == card_id => {
                    found = Some((repo.clone(), issues.clone()));
                }
                _ => {}
            }
        }
        found
    })
    .await?
    .context("no such issue card")?;
    let (repo, issues) = card;
    let row = move |n: u64| issues.iter().find(|i| i.number == n).cloned();
    Ok((repo, row, approved.into_inner().unwrap()))
}

/// What the agent is told of an approval. Hidden, like a reaction's prompt.
pub fn approval_prompt(repo: &str, row: &IssueCardRow) -> String {
    format!(
        "The user approved #{n} \"{title}\" ({repo}#{n}) from your issue card, and Dray added the `{READY}` label on GitHub. \
         Approved means go ahead: start on it now, the way your instructions say to work an issue.",
        n = row.number,
        title = row.title,
    )
}

/// The reader handed `issue` to a bot from the issues page: the bot is told
/// in a hidden prompt, as an approval tells it, and nothing is written to the
/// tracker. A bot mid-turn takes it once that turn ends; a bot with no chat
/// yet opens one on it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn give_issue_to_bot(bot_id: String, issue: super::IssueRef, sink: Sink) -> Result<(), Fail> {
    let bot = crate::bots::find_bot(&bot_id).await?;
    let prompt = handoff_prompt(&issue);
    // Held until a new chat is on the index, as `dray bot send` holds it.
    let lock = crate::bots::first_chat_lock(&bot.id);
    let first = lock.lock().await;
    match crate::bots::chat_of(&bot).await {
        Some(chat) => {
            drop(first);
            crate::orchestration::send_review(chat.session_id, prompt, sink).await?;
        }
        // A bot nobody has talked to yet, as every new one is: its chat opens
        // on the hand-off.
        None => {
            crate::orchestration::open_bot_chat(&bot, &prompt, None, None, true, &sink).await?;
        }
    }
    Ok(())
}

/// What a bot is told of an issue handed to it. Hidden, like an approval's.
pub fn handoff_prompt(issue: &super::IssueRef) -> String {
    let link = if issue.url.is_empty() { String::new() } else { format!(" ({})", issue.url) };
    format!(
        "Work on {id} \"{title}\"{link}. The user handed it to you from the issues page. \
         Start on it the way your instructions say to work an issue, once you are free.",
        id = issue.identifier,
        title = issue.title,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handoff_names_the_issue_and_says_work_on_it() {
        let issue = super::super::IssueRef {
            tracker: super::super::IssueTracker::Github,
            id: String::new(),
            identifier: "acme/app#7".into(),
            title: "Fix login".into(),
            url: "https://github.com/acme/app/issues/7".into(),
        };
        let told = handoff_prompt(&issue);
        assert!(told.starts_with("Work on acme/app#7 \"Fix login\" (https://github.com/acme/app/issues/7)."));
        assert!(!told.contains("label"));
    }

    #[test]
    fn the_prompt_names_the_issue_and_says_go() {
        let row = IssueCardRow { number: 7, title: "Fix login".into(), url: String::new(), closed: false, labels: vec![] };
        let told = approval_prompt("acme/app", &row);
        assert!(told.starts_with("The user approved #7 \"Fix login\" (acme/app#7)"));
        assert!(told.contains("`ready` label"));
    }
}
