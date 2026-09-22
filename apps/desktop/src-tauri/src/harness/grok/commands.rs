//! What the `/` picker offers for a grok session.
//!
//! **The list comes off the wire and nowhere else.** grok publishes
//! `available_commands_update` on `session/update` carrying its own built-ins
//! plus every skill it discovered — including the reader's `~/.claude/skills`,
//! which grok reads — and a command picked there travels as **prompt text**,
//! which grok expands itself. So the send path needs nothing: Claude Code's own
//! shape, where Codex has to send a typed input item.
//!
//! What it costs is that the list arrives **after** `session/new`, so a session
//! that has never run has no answer yet. The handshake carries an
//! `availableCommands` of its own and it is exactly grok's seven TUI built-ins,
//! every one of them on [`WITHHELD`] — so probing for it would spend a child to
//! learn nothing. Hence a per-directory cache the read loop fills, and an
//! `Err` until it does: [`crate::lib`]'s picker leaves a failed read **pending
//! forever** rather than answering empty, which is the honest state here. A
//! harness with no commands says so out loud, and grok is not one.

use crate::harness::claude_code::commands::SlashCommand;
use crate::harness::ProbeCache;
use std::sync::LazyLock;
use std::time::Duration;

use super::parser::AvailableCommand;

/// Filled by a live session rather than by a probe, so nothing here expires:
/// the entry is replaced whenever a grok session in that directory publishes a
/// new list, which it does on every `session/new`.
static CACHE: LazyLock<ProbeCache<Vec<SlashCommand>>> =
    LazyLock::new(|| ProbeCache::new(Duration::MAX));

/// The commands Dray owns or cannot reconcile, which are dropped before the
/// list is stored.
///
/// The same reading Claude Code's `clear`/`model`/`rename` take: each of these
/// is either a control the app already draws in its own chrome, or an action
/// whose effect never comes back on the wire in a form the app could follow.
/// `always-approve` moves the session's stance behind the composer's back;
/// `compact`, `context` and `session-info` report things Dray's own ring and
/// header already say; `plugins`, `hooks-*` and `feedback` are TUI screens; and
/// `loop`, `goal`, `workflow` and `deep-research` each start work that outlives
/// the turn with no lifecycle Dray can draw.
///
/// Prefix-matched on `hooks-`, since that one is a family of five.
const WITHHELD: &[&str] = &[
    "always-approve",
    "compact",
    "context",
    "session-info",
    "feedback",
    "plugins",
    "loop",
    "goal",
    "workflow",
    "deep-research",
];

fn is_withheld(name: &str) -> bool {
    name.starts_with("hooks-") || WITHHELD.contains(&name)
}

/// What the picker draws for `cwd`, or an error where no grok session has run
/// there yet.
///
/// The error is the point: it reaches the picker as a probe that has not
/// answered, which leaves the menu closed rather than drawing "Grok publishes no
/// slash commands" over a list that is about to exist.
pub async fn list_commands(cwd: &str) -> anyhow::Result<Vec<SlashCommand>> {
    CACHE
        .peek(cwd)
        .ok_or_else(|| anyhow::anyhow!("grok has not published its commands for this directory yet"))
}

/// Records what a live session published.
pub fn remember(cwd: &str, published: Vec<AvailableCommand>) {
    let rows: Vec<SlashCommand> = published
        .into_iter()
        .filter(|command| !is_withheld(&command.name))
        .map(|command| SlashCommand {
            // A skill's description is written for the *model* — several
            // hundred words of trigger phrases — where the picker draws one
            // line, so it is cut at the first full stop the way Codex's and
            // fx's are.
            description: crate::harness::claude_code::commands::first_sentence(&command.description),
            argument_hint: command
                .input
                .and_then(|input| input.hint)
                .unwrap_or_default(),
            aliases: Vec::new(),
            name: command.name,
        })
        .collect();

    // An empty publish is grok saying nothing rather than grok saying "none":
    // the list arrives once per session and an empty one would replace a good
    // answer with a picker that opens on a sentence claiming grok has no
    // commands at all.
    if rows.is_empty() {
        return;
    }

    CACHE.insert(cwd, rows);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn commands(names: &[&str]) -> Vec<AvailableCommand> {
        names
            .iter()
            .map(|name| {
                serde_json::from_value(json!({
                    "name": name,
                    "description": "Does a thing. And then several more things.",
                    "input": {"hint": "optional"},
                }))
                .unwrap()
            })
            .collect()
    }

    /// grok's own TUI built-ins are dropped and its skills are kept. The
    /// built-ins are exactly what a handshake answers with, which is why the
    /// handshake is not the source.
    #[tokio::test]
    async fn the_tui_builtins_are_withheld_and_the_skills_are_not() {
        remember(
            "/tmp/grok-commands-test",
            commands(&[
                "compact",
                "always-approve",
                "hooks-trust",
                "context",
                "caveman",
                "code-review",
            ]),
        );

        let rows = list_commands("/tmp/grok-commands-test").await.unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["caveman", "code-review"]);
        // A skill's description is cut to its first sentence, since the rest is
        // written for the model.
        assert_eq!(rows[0].description, "Does a thing.");
        assert_eq!(rows[0].argument_hint, "optional");
    }

    /// A directory no grok session has run in answers an *error*, not an empty
    /// list — the picker reads the second as "this agent has no commands", which
    /// is a claim about grok made out of not having asked it yet.
    #[tokio::test]
    async fn a_directory_with_no_session_yet_answers_an_error() {
        assert!(list_commands("/tmp/grok-never-run").await.is_err());
    }

    /// A publish holding nothing but withheld rows must not replace a good
    /// answer with an empty one.
    #[tokio::test]
    async fn an_all_withheld_publish_changes_nothing() {
        let dir = "/tmp/grok-commands-empty";
        remember(dir, commands(&["caveman"]));
        remember(dir, commands(&["compact", "context"]));

        let rows = list_commands(dir).await.unwrap();
        assert_eq!(rows.len(), 1, "the skill list survives a built-ins-only publish");
    }
}
