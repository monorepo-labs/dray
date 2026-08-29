//! Per-harness integrations. Each CLI gets a directory with two stages:
//! `parser.rs` (wire format → its own typed events) and `mapper.rs` (those →
//! [`AgentEvent`](crate::events::AgentEvent)). A wire-format change then touches
//! only the parser, a vocabulary change only the mapper.

#[path = "claude_code/claude_code.rs"]
pub mod claude_code;

#[path = "codex/codex.rs"]
pub mod codex;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The child's `PATH`: the inherited one with the user-bin directories put
/// back.
///
/// Load-bearing rather than defensive. A bundled `.app` launched from Finder
/// inherits launchd's `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` — so a `dray`
/// installed to `~/.local/bin` is simply not there for the agent, and the
/// failure reads as "the CLI is broken" rather than "the CLI is unreachable".
/// Appended, not prepended: the user's own `PATH` should still win where the
/// two name the same binary.
///
/// Shared by both harnesses because the trap is the bundle's, not the CLI's.
pub fn agent_path() -> String {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&inherited).collect();

    for dir in crate::binpath::known_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }

    std::env::join_paths(dirs)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| inherited.to_string_lossy().into_owned())
}

#[cfg(test)]
mod install_tests {
    use super::Harness;

    /// The cure has to be nameable for every agent, or the notice degrades to
    /// the errno it was written to replace. A harness added later fails here
    /// rather than shipping a card with an empty command in it.
    #[test]
    fn every_agent_names_its_own_cure() {
        for harness in [Harness::ClaudeCode, Harness::Codex] {
            assert!(!harness.label().is_empty());
            assert!(
                harness.install_command().starts_with("curl -fsSL "),
                "{:?} has no copyable install command",
                harness
            );
            assert!(
                harness.docs_url().starts_with("https://"),
                "{:?} has no install guide to link",
                harness
            );
        }

        // And they are not each other's. One `match` arm copied and left
        // unedited is the way this goes wrong, and it reads as correct.
        assert_ne!(
            Harness::ClaudeCode.install_command(),
            Harness::Codex.install_command()
        );
        assert_ne!(Harness::ClaudeCode.docs_url(), Harness::Codex.docs_url());
    }
}

use ts_rs::TS;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum Harness {
    ClaudeCode,
    Codex,
}

impl Harness {
    /// What to call it in a sentence somebody reads.
    pub fn label(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "Claude Code",
            Harness::Codex => "Codex",
        }
    }

    /// The command that installs it, for a reader to copy into a terminal.
    ///
    /// Each vendor's own installer, not npm: it is the one route that needs
    /// nothing already on the machine (no Node, no package manager) and it is
    /// the one every other install surface — the vendor's own docs, `dray
    /// update`'s pattern for itself — already points at. Both verified live
    /// (`curl -fsSL … | sh -n`, a dry parse, not a run) before landing here.
    ///
    /// Dray never runs this. Choosing the method for somebody installs a
    /// second copy beside one they may already have, and a failure inside our
    /// installer is ours to debug where a failure on the vendor's page is
    /// theirs to follow.
    pub fn install_command(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "curl -fsSL https://claude.ai/install.sh | bash",
            Harness::Codex => "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        }
    }

    /// Where the vendor documents installing it, for the reader without `curl`
    /// or wary of piping one into a shell — the escape hatch
    /// [`install_command`](Self::install_command) exists beside rather than
    /// behind.
    pub fn docs_url(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "https://code.claude.com/docs/en/quickstart",
            Harness::Codex => "https://learn.chatgpt.com/docs/codex/cli",
        }
    }
}
