//! What the `/` picker offers for an OpenCode session.
//!
//! grok's shape: the list comes off the wire as `available_commands_update`
//! once a session opens, and a picked command travels as prompt text, which
//! OpenCode expands itself. So it is cached per directory by the read loop,
//! and a directory no session has opened in answers an error — the picker's
//! "not answered yet", which keeps the menu shut rather than claiming OpenCode
//! has no commands.

use crate::harness::claude_code::commands::{first_sentence, SlashCommand};
use crate::harness::ProbeCache;
use std::sync::LazyLock;
use std::time::Duration;

use super::parser::AvailableCommand;

static CACHE: LazyLock<ProbeCache<Vec<SlashCommand>>> = LazyLock::new(|| ProbeCache::new(Duration::MAX));

/// What the picker draws for `cwd`.
pub async fn list_commands(cwd: &str) -> anyhow::Result<Vec<SlashCommand>> {
    CACHE
        .peek(cwd)
        .ok_or_else(|| anyhow::anyhow!("OpenCode has not published its commands for this directory yet"))
}

/// Records what a live session published. An empty publish is ignored, so it
/// never replaces a good answer.
pub fn remember(cwd: &str, published: Vec<AvailableCommand>) {
    let rows: Vec<SlashCommand> = published
        .into_iter()
        .map(|command| SlashCommand {
            // A skill's description is written for the model; the picker
            // draws one line.
            description: first_sentence(&command.description),
            argument_hint: String::new(),
            aliases: Vec::new(),
            name: command.name,
        })
        .collect();
    if !rows.is_empty() {
        CACHE.insert(cwd, rows);
    }
}
