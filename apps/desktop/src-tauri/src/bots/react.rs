//! A bot's reaction: an emoji on the user's newest message, in place of a
//! reply when it has nothing to say. Claude Code bots react through the `react`
//! tool on Dray's in-process MCP server
//! ([no_reply](crate::harness::claude_code::no_reply)), every other harness
//! through `dray session react`; both land here.

use anyhow::{bail, Context, Result};

use crate::events::{AgentEvent, AgentEventPayload};

/// The reactions a bot has, each with the word that also names it. A short
/// fixed set, so each one keeps a single meaning the prompt can teach.
pub const EMOJI: [(&str, &str); 3] = [("👀", "seen"), ("✅", "done"), ("🎉", "celebrate")];

/// The emoji `said` names: one of [`EMOJI`], or its word. A variation selector
/// is ignored, since some keyboards add one to ✅.
pub fn emoji(said: &str) -> Option<&'static str> {
    let said = said.trim().trim_end_matches('\u{FE0F}');
    EMOJI.iter().find(|(e, word)| *e == said || word.eq_ignore_ascii_case(said)).map(|(e, _)| *e)
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
    let events = crate::store::list_session_events(session_id).await?;
    let message_id = target(&events).context("the user has sent no message in this chat to react to")?;
    Ok(AgentEventPayload::Reaction { message_id: message_id.to_string(), emoji: emoji.to_string() })
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
        assert_eq!(emoji("👍"), None);
    }

    #[test]
    fn reacts_to_the_newest_message_the_user_typed() {
        let events = [message("typed", None, false), message("report", Some("Task"), false), message("review", None, true)];
        assert_eq!(target(&events), Some("typed"));
        assert_eq!(target(&events[1..]), None);
    }
}
