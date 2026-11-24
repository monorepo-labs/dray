//! Issue cards: GitHub issues an agent shows the reader with `dray session
//! issue-card`, one or several. A row opens its issue in the issues view, and
//! its Work on it hands the issue back to the agent, the way a reader's
//! reaction reaches it, so it can start.

use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use dray_proto::Response;

use super::github;
use crate::events::{AgentEvent, AgentEventPayload, IssueCardRow};
use crate::{session::manager, sink::Sink, store, Fail};

/// More rows than this is a list to triage on the issues page, not a card.
const MAX_ROWS: usize = 20;

/// How much of a description a row keeps: enough for two lines on the card.
const EXCERPT_CAP: usize = 240;

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
        let (issue, body) = read.map_err(|e| anyhow::anyhow!("could not read {repo}#{number}: {e}"))?;
        issues.push(IssueCardRow {
            number: *number,
            title: issue.title,
            url: issue.url,
            closed: issue.state.kind == super::IssueStateKind::Completed,
            labels: issue.labels,
            excerpt: body.as_deref().and_then(excerpt),
            author: issue.author,
        });
    }
    let said = issues.iter().map(|i| format!("#{} {}", i.number, i.title)).collect();
    let title = card.title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let payload = AgentEventPayload::IssueCard { title, repo: repo.to_string(), issues };
    manager().post_event(&chat.session_id, chat.harness, payload, app).await?;
    Ok(Response::IssueCard { issues: said })
}

/// A description's opening as one paragraph of prose: markdown headings,
/// images, HTML comments, fences and emphasis dropped, links kept as their
/// text, whitespace folded, capped.
fn excerpt(body: &str) -> Option<String> {
    let mut words = Vec::new();
    let mut fenced = false;
    for line in body.lines() {
        let line = line.trim();
        if line.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced || line.starts_with("<!--") || line.starts_with("![") || line.starts_with('|') {
            continue;
        }
        let line = line.trim_start_matches(['#', '>', '-', '*', ' ']);
        words.extend(line.split_whitespace());
    }
    let flat = unlink(&words.join(" ")).replace("**", "").replace("__", "").replace('`', "");
    match flat.char_indices().nth(EXCERPT_CAP) {
        _ if flat.is_empty() => None,
        Some((at, _)) => Some(format!("{}…", flat[..at].trim_end())),
        None => Some(flat),
    }
}

/// `[text](url)` → `text`.
fn unlink(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find("](").map(|i| open + i) else { break };
        let Some(end) = rest[close..].find(')').map(|i| close + i) else { break };
        out.push_str(&rest[..open]);
        out.push_str(&rest[open + 1..close]);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Held over a hand-off's check and its log, so a double click cannot tell
/// the agent twice.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The reader pressed Work on it on issue `number` of card `card_id` in
/// `session_id`: hands the issue to the agent in a hidden prompt, then logs it
/// on the card. Refused where the row was already handed over or the chat is
/// settled. Named for the first cut, which added a label; nothing on GitHub
/// changes now.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn approve_issue(session_id: String, card_id: String, number: u64, sink: Sink) -> Result<(), Fail> {
    let _held = STARTING.lock().await;
    let item = store::get_session_index_item(&session_id).await?.context("no such session")?;
    // `send_review` answers Ok without sending to a settled chat, which would
    // leave the row Started with nobody told and every retry refused.
    if crate::bots::current_chat(item.clone()).await.archived {
        return Err(anyhow::anyhow!("this chat is settled").into());
    }
    let (repo, row, started) = find_card(&session_id, &card_id).await?;
    let row = row(number).with_context(|| format!("#{number} is not on this card"))?;
    if started.contains(&number) {
        return Err(anyhow::anyhow!("#{number} is already handed over").into());
    }
    // Sent before it is logged, so a send that fails leaves the row open to retry.
    crate::orchestration::send_review(session_id.clone(), work_prompt(&repo, row.number, &row.title), sink.clone()).await?;
    let payload = AgentEventPayload::IssueApproved { card_id, number };
    manager().log_event(&session_id, item.harness, payload, &sink).await?;
    Ok(())
}

/// The card `card_id`'s repo, a lookup of its rows by number, and the numbers
/// already handed over from it. Read back from the end, as those come after it.
async fn find_card(session_id: &str, card_id: &str) -> Result<(String, impl Fn(u64) -> Option<IssueCardRow>, Vec<u64>)> {
    let started = Mutex::new(Vec::new());
    let card = store::find_newest(session_id, |events: &[AgentEvent]| {
        let mut found = None;
        for e in events {
            match &e.payload {
                AgentEventPayload::IssueApproved { card_id: c, number } if c == card_id => {
                    started.lock().unwrap().push(*number);
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
    Ok((repo, row, started.into_inner().unwrap()))
}

/// What the agent is told when the reader hands it an issue. Hidden, like a
/// reaction's prompt; any surface that hands an issue over says it this way.
pub fn work_prompt(repo: &str, number: u64, title: &str) -> String {
    format!(
        "The user asked you to work on #{number} \"{title}\" ({repo}#{number}). \
         Start on it now, the way your instructions say to work an issue. Read the issue first."
    )
}

/// The reader sent `issue` to a bot from the issues page: the bot is told
/// in a hidden prompt, as an approval tells it, and nothing is written to the
/// tracker. A bot mid-turn takes it once that turn ends; a bot with no chat
/// yet opens one on it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn send_issue_to_bot(bot_id: String, issue: super::IssueRef, note: Option<String>, sink: Sink) -> Result<(), Fail> {
    let bot = crate::bots::find_bot(&bot_id).await?;
    let prompt = handoff_prompt(&issue, note.as_deref());
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

/// What a bot is told of an issue sent to it, with the reader's note last.
/// Hidden, like an approval's.
pub fn handoff_prompt(issue: &super::IssueRef, note: Option<&str>) -> String {
    let link = if issue.url.is_empty() { String::new() } else { format!(" ({})", issue.url) };
    let mut told = format!(
        "Work on {id} \"{title}\"{link}. The user sent it to you from the issues page. \
         Start on it the way your instructions say to work an issue, once you are free.",
        id = issue.identifier,
        title = issue.title,
    );
    if let Some(note) = note.map(str::trim).filter(|n| !n.is_empty()) {
        told.push_str("\n\nTheir note:\n");
        told.push_str(note);
    }
    told
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
        let told = handoff_prompt(&issue, None);
        assert!(told.starts_with("Work on acme/app#7 \"Fix login\" (https://github.com/acme/app/issues/7)."));
        assert!(!told.contains("label"));
        assert!(handoff_prompt(&issue, Some("  ship it today ")).ends_with("Their note:\nship it today"));
        assert!(!handoff_prompt(&issue, Some("   ")).contains("note"));
    }

    #[test]
    fn the_prompt_names_the_issue_and_says_go() {
        let told = work_prompt("acme/app", 7, "Fix login");
        assert!(told.starts_with("The user asked you to work on #7 \"Fix login\" (acme/app#7)."));
    }

    #[test]
    fn an_excerpt_is_the_prose_alone() {
        let body = "## Steps\n<!-- template -->\n- Open the app\n- Tap **Login**\n```\nstack\n```\n![shot](x.png)\nNothing happens.";
        assert_eq!(excerpt(body).as_deref(), Some("Steps Open the app Tap Login Nothing happens."));
        let linked = "See [the `deploy` docs](https://x.dev/d) and __this__.";
        assert_eq!(excerpt(linked).as_deref(), Some("See the deploy docs and this."));
        assert_eq!(excerpt("  \n"), None);
        let long = "word ".repeat(100);
        let cut = excerpt(&long).unwrap();
        assert!(cut.ends_with('…') && cut.chars().count() <= EXCERPT_CAP + 1);
    }
}
