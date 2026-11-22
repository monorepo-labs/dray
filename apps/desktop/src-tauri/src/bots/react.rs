//! Reactions: an emoji on a message, both ways. A bot reacts to the user's
//! newest message in place of a reply when it has nothing to say: Claude Code
//! bots through the `react` tool on Dray's in-process MCP server
//! ([no_reply](crate::harness::claude_code::no_reply)), every other harness
//! through `dray session react`. The user reacts to any agent's message, in a
//! bot's chat or a task's, through [`react_to_message`].

use anyhow::{bail, Context, Result};

use crate::events::{AgentEvent, AgentEventPayload};
use crate::{session::manager, sink::Sink, Fail};

/// The reactions there are, each with the word that also names it. A short
/// fixed set, so each one keeps a single meaning the prompt can teach. The
/// user picks from the same one.
pub const EMOJI: [(&str, &str); 7] = [
    ("👀", "seen"),
    ("✅", "done"),
    ("🎉", "celebrate"),
    ("👍", "like"),
    ("❤️", "love"),
    ("😂", "laugh"),
    ("😢", "sad"),
];

/// The emoji `said` names: one of [`EMOJI`], or its word. A variation selector
/// is ignored on both sides: some keyboards add one to ✅, and ❤ alone, without
/// it, draws as a text glyph, so the stored form keeps it.
pub fn emoji(said: &str) -> Option<&'static str> {
    let said = said.trim().trim_end_matches('\u{FE0F}');
    EMOJI
        .iter()
        .find(|(e, word)| e.trim_end_matches('\u{FE0F}') == said || word.eq_ignore_ascii_case(said))
        .map(|(e, _)| *e)
}

/// Whether `reply` says nothing but `emoji`: the bot writing its reaction out
/// again. Strict, so "Love it" or "❤️ thanks" are still replies.
pub fn echoes(reply: &str, emoji: &str) -> bool {
    let bare = |s: &str| -> String {
        s.chars().filter(|&c| c != '\u{FE0F}' && crate::events::has_text(c.encode_utf8(&mut [0; 4]))).collect()
    };
    let emoji = bare(emoji);
    !emoji.is_empty() && bare(reply) == emoji
}

/// The id of the newest message the user typed. A task's report, another
/// bot's message and Dray's own prompts are no one to react to.
pub fn target(events: &[AgentEvent]) -> Option<&str> {
    events.iter().rev().find_map(|e| match &e.payload {
        AgentEventPayload::UserMessage { from: None, kickoff: false, .. } if e.subagent.is_none() => Some(e.id.as_str()),
        _ => None,
    })
}

/// The reaction `said` names, on the newest message the user typed in
/// `session_id`. Refused outside a bot's chat, where nothing draws one.
pub async fn reaction(session_id: &str, cwd: &str, said: &str) -> Result<AgentEventPayload> {
    if super::bot_at(cwd).await.is_none() {
        bail!("only a bot's chat takes reactions");
    }
    let Some(emoji) = emoji(said) else {
        let known: Vec<_> = EMOJI.iter().map(|(e, word)| format!("{e} ({word})")).collect();
        bail!("no reaction \"{said}\": pick one of {}", known.join(", "));
    };
    let message_id = crate::store::find_newest(session_id, |events| target(events).map(str::to_string))
        .await?
        .context("the user has sent no message in this chat to react to")?;
    Ok(AgentEventPayload::Reaction { message_id, emoji: emoji.to_string(), by_user: false })
}

/// The user's emoji on the agent's message `message_id` in `session_id`, a
/// bot's chat or a task's. Logged as a badge on that message, replacing any
/// earlier one of theirs, then told to the agent as a hidden prompt, so it can
/// answer. The badge is all the reader sees of it, as a kickoff draws nothing.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn react_to_message(session_id: String, message_id: String, emoji: String, sink: Sink) -> Result<(), Fail> {
    let item = crate::store::get_session_index_item(&session_id).await?.context("no such session")?;
    let Some(picked) = self::emoji(&emoji) else {
        return Err(anyhow::anyhow!("no reaction \"{emoji}\"").into());
    };
    // An earlier session of a bot's chat still holds its own messages, but its
    // agent is gone: the bot's newest chat is who hears about it.
    let to = match super::bot_at(&item.cwd).await {
        Some(_) if item.routine_run.is_none() => super::chat_sessions(&item.cwd).await?.pop().unwrap_or_else(|| item.clone()),
        _ => item.clone(),
    };
    if to.archived {
        return Err(anyhow::anyhow!("this chat is settled").into());
    }
    let reacted = crate::store::find_newest(&session_id, |events| {
        events.iter().find(|e| e.id == message_id).map(|e| match &e.payload {
            AgentEventPayload::AssistantText { text, .. } if e.subagent.is_none() => Some(text.clone()),
            _ => None,
        })
    })
    .await?
    .context("no such message")?
    .context("only the agent's messages take a reaction")?;
    let payload = AgentEventPayload::Reaction { message_id, emoji: picked.to_string(), by_user: true };
    manager().log_event(&session_id, item.harness, payload, &sink).await?;
    crate::orchestration::send_review(to.session_id, user_reaction_prompt(picked, &reacted), sink).await?;
    Ok(())
}

/// How long a quote of the message reacted to runs, so the agent knows which
/// one without the prompt repeating a long reply whole.
const QUOTE_CAP: usize = 280;

/// What the agent is told of the user's reaction: the emoji, its word, and the
/// start of the message it is on.
pub fn user_reaction_prompt(emoji: &str, reacted: &str) -> String {
    let word = EMOJI.iter().find(|(e, _)| *e == emoji).map_or("", |(_, w)| w);
    let flat = reacted.split_whitespace().collect::<Vec<_>>().join(" ");
    let quote = match flat.char_indices().nth(QUOTE_CAP) {
        Some((at, _)) => format!("{}…", &flat[..at]),
        None => flat,
    };
    format!(
        "The user reacted {emoji} ({word}) to your message:\n\n> {quote}\n\n\
         A reaction, not a typed message. Answer it the way you would a short message: briefly, and only with what it calls for."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::MessageSender;
    use crate::harness::Harness;

    fn message(id: &str, from: Option<&str>, kickoff: bool) -> AgentEvent {
        let mut event = AgentEvent::mint(
            "s".into(),
            Harness::ClaudeCode,
            0,
            None,
            None,
            AgentEventPayload::UserMessage {
                text: "hi".into(),
                images: vec![],
                issues: vec![],
                baseline: None,
                queued: false,
                from: from.map(|title| MessageSender {
                    session_id: "task".into(),
                    title: title.into(),
                    machine: None,
                    bot_id: None,
                    routine: None,
                    ..Default::default()
                }),
                cwd: None,
                kickoff,
            },
        );
        event.id = id.into();
        event
    }

    #[test]
    fn names_an_emoji_by_itself_or_its_word() {
        assert_eq!(emoji("👀"), Some("👀"));
        assert_eq!(emoji(" Done "), Some("✅"));
        assert_eq!(emoji("✅\u{FE0F}"), Some("✅"));
        assert_eq!(emoji("celebrate"), Some("🎉"));
        assert_eq!(emoji("👍"), Some("👍"));
        assert_eq!(emoji("❤"), Some("❤️"));
        assert_eq!(emoji("❤️"), Some("❤️"));
        assert_eq!(emoji("Laugh"), Some("😂"));
        assert_eq!(emoji("sad"), Some("😢"));
        assert_eq!(emoji("🔥"), None);
    }

    #[test]
    fn a_reply_echoes_only_the_bare_emoji() {
        assert!(echoes("❤️", "❤️"));
        assert!(echoes(" ❤\n", "❤️"));
        assert!(echoes("\u{200B}👍\u{200B}", "👍"));
        assert!(!echoes("❤️ thanks", "❤️"));
        assert!(!echoes("love", "❤️"));
        assert!(!echoes("👍", "❤️"));
        assert!(!echoes("", "❤️"));
    }

    #[test]
    fn reacts_to_the_newest_message_the_user_typed() {
        let events = [message("typed", None, false), message("report", Some("Task"), false), message("review", None, true)];
        assert_eq!(target(&events), Some("typed"));
        assert_eq!(target(&events[1..]), None);
    }

    #[test]
    fn tells_the_agent_which_message_and_quotes_a_long_one_short() {
        let told = user_reaction_prompt("👍", "Fixed the\n\nbug  in `parse`.");
        assert!(told.starts_with("The user reacted 👍 (like) to your message:"));
        assert!(told.contains("> Fixed the bug in `parse`.\n"));

        let long = "ä".repeat(QUOTE_CAP + 50);
        let told = user_reaction_prompt("❤️", &long);
        assert!(told.contains(&format!("> {}…\n", "ä".repeat(QUOTE_CAP))));
    }
}
