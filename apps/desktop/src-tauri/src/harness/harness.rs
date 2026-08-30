//! Per-harness integrations. Each CLI gets a directory with two stages:
//! `parser.rs` (wire format → its own typed events) and `mapper.rs` (those →
//! [`AgentEvent`](crate::events::AgentEvent)). A wire-format change then touches
//! only the parser, a vocabulary change only the mapper.

#[path = "claude_code/claude_code.rs"]
pub mod claude_code;

#[path = "codex/codex.rs"]
pub mod codex;

#[path = "pi/pi.rs"]
pub mod pi;

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
mod wire_tests {
    use super::Harness;

    /// The one that matters. `index.json` is rewritten whole by whichever build
    /// writes last, so a name a newer build wrote reaches an older one — and
    /// serde's default there is to fail the *value*, which fails the line,
    /// which is the whole file. One `"pi"` from a dev build made a released app
    /// read 256 sessions as none at all.
    #[test]
    fn a_name_this_build_does_not_know_costs_nothing() {
        let harness: Harness = serde_json::from_str(r#""some_future_agent""#).expect("parses");

        assert_eq!(harness, Harness::Other("some_future_agent"));
    }

    /// And it is written back exactly as it arrived. A placeholder would parse
    /// fine and quietly destroy the harness of every session it did not
    /// recognise — the worse half of this failure, not a lesser one.
    #[test]
    fn an_unknown_name_survives_a_round_trip() {
        for name in ["some_future_agent", "claude_code", "codex", "pi"] {
            let json = format!("\"{name}\"");
            let parsed: Harness = serde_json::from_str(&json).expect("parses");

            assert_eq!(serde_json::to_string(&parsed).expect("serializes"), json);
        }
    }

    /// Interning is what lets [`Harness::Other`] stay `Copy`, and it is only
    /// safe because the same name is the same pointer — otherwise every read of
    /// a session index would leak another copy of it.
    #[test]
    fn one_name_is_interned_once() {
        let a: Harness = serde_json::from_str(r#""repeated_agent""#).unwrap();
        let b: Harness = serde_json::from_str(r#""repeated_agent""#).unwrap();

        let (Harness::Other(a), Harness::Other(b)) = (a, b) else {
            panic!("both should be unknown");
        };

        assert!(std::ptr::eq(a, b), "the same name leaked twice");
    }

    /// An unknown harness is a value read off disk, never one to offer — so no
    /// spelling resolves to one, and a picker or availability read built from
    /// [`Harness::ALL`] cannot reach it.
    #[test]
    fn an_unknown_harness_is_not_offerable() {
        assert!(Harness::from_wire_name("some_future_agent").is_none());
        assert!(!Harness::ALL.iter().any(|h| matches!(h, Harness::Other(_))));
    }

    /// Nothing this build cannot name may be handed a CLI to spawn. Every
    /// route to one goes through this, so a `false` here is what keeps the
    /// refusal ahead of the child rather than running somebody else's agent in
    /// this reader's session.
    #[test]
    fn an_unknown_harness_names_no_cli() {
        assert!(!Harness::Other("some_future_agent").names_a_cli());

        for harness in Harness::ALL {
            assert!(harness.names_a_cli(), "{harness:?} has no CLI to spawn");
        }
    }
}

#[cfg(test)]
mod capability_tests {
    use super::Harness;

    /// Claude Code is the only CLI with a worktree flag, and a harness wrongly
    /// marked here never gets a tree at all — it bails inside `Session::init`
    /// with its index row already written.
    #[test]
    fn only_claude_code_makes_its_own_worktree() {
        assert!(Harness::ClaudeCode.caps().creates_own_worktree);

        for harness in Harness::ALL {
            if harness != Harness::ClaudeCode {
                assert!(
                    !harness.caps().creates_own_worktree,
                    "{harness:?} has no `-w`, so Dray has to make the tree"
                );
            }
        }
    }

    /// No CLI here has a `set_effort`, so an effort change always replaces the
    /// child. Stated because it is the one field that is `false` for a reason
    /// nothing else in the table shares, and a `true` here would silently drop
    /// the change.
    #[test]
    fn an_effort_change_always_replaces_the_child() {
        for harness in Harness::ALL {
            assert!(
                !harness.caps().applies_effort_in_place,
                "{harness:?} claims an effort route no CLI here has"
            );
        }
    }
}

#[cfg(test)]
mod install_tests {
    use super::Harness;

    /// The cure has to be nameable for every agent, or the notice degrades to
    /// the errno it was written to replace. A harness added later fails here
    /// rather than shipping a card with an empty command in it.
    #[test]
    fn every_agent_names_its_own_cure() {
        for harness in Harness::ALL {
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
        // unedited is the way this goes wrong, and it reads as correct. Over
        // every pair rather than the one pair, or the third harness ships
        // Codex's installer and this still passes.
        for (i, a) in Harness::ALL.iter().enumerate() {
            for b in &Harness::ALL[i + 1..] {
                assert_ne!(
                    a.install_command(),
                    b.install_command(),
                    "{a:?} and {b:?} share an install command"
                );
                assert_ne!(a.docs_url(), b.docs_url(), "{a:?} and {b:?} share a docs URL");
                assert_ne!(a.label(), b.label(), "{a:?} and {b:?} share a label");
            }
        }
    }

    /// The login command is stated twice — once for the reader to copy, once
    /// as argv for the launcher — and the two must describe one command. Drift
    /// here is silent: the copied spelling still works by hand while the
    /// button quietly logs in to something else, or nothing.
    #[test]
    fn both_spellings_of_the_login_command_agree() {
        for harness in Harness::ALL {
            let words: Vec<&str> = harness.login_command().split(' ').collect();
            assert_eq!(
                words[1..],
                *harness.login_args(),
                "{:?} spells its login command two different ways",
                harness
            );
        }

        assert_ne!(
            Harness::ClaudeCode.login_command(),
            Harness::Codex.login_command()
        );
    }
}

use ts_rs::TS;
/// Which agent runs a session.
///
/// **Unknown spellings are kept, not refused.** `index.json` is a shared store
/// rewritten whole by whichever build writes last, so a value a newer build
/// wrote reaches an older one — and serde's default for an unrecognised variant
/// is to fail the *line*, which here is the whole file. One `"pi"` written by a
/// dev build made a released app read 256 sessions as none at all, with
/// `unknown variant \`pi\`` the only thing said about it.
///
/// So this is the same bargain [`SessionIndexItem.unknown`] makes one level
/// out: carry what you cannot understand through untouched. [`Harness::Other`]
/// holds the original string and serializes it back verbatim, so an old build
/// reading and rewriting the index leaves a newer build's sessions exactly as it
/// found them. Storing a placeholder instead would parse fine and quietly
/// destroy the harness of every session it did not recognise, which is the
/// worse half of this failure rather than a lesser one.
///
/// It is **not** in [`Harness::ALL`]: that is the set this build offers, and an
/// unknown one is not offerable. Nothing spawns for it either — see
/// [`Harness::names_a_cli`].
///
/// [`SessionIndexItem.unknown`]: crate::store::SessionIndexItem
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case", into = "String")]
pub enum Harness {
    ClaudeCode,
    Codex,
    Pi,
    /// A harness some other build named and this one has never heard of, with
    /// its spelling kept so a round trip does not lose it.
    ///
    /// `&'static str` rather than `String`, from the intern table below, so
    /// this type stays `Copy`. It is passed by value through most of
    /// `session.rs`, and a `String` here put a `.clone()` on 44 call sites —
    /// permanent reader load on the hot path, to carry a tag.
    #[serde(skip)]
    #[ts(skip)]
    Other(&'static str),
}

/// Spellings read off the wire that this build does not know.
///
/// Leaked on first sight and shared thereafter, which is what lets
/// [`Harness::Other`] stay `Copy`. Bounded by the number of *distinct* harness
/// names any build ever writes — one or two in practice — so this is a fixed
/// cost, not a leak that grows with use.
static UNKNOWN_NAMES: std::sync::Mutex<Option<std::collections::HashSet<&'static str>>> =
    std::sync::Mutex::new(None);

fn intern(name: &str) -> &'static str {
    let mut guard = UNKNOWN_NAMES.lock().unwrap_or_else(|e| e.into_inner());
    let names = guard.get_or_insert_with(Default::default);

    if let Some(existing) = names.get(name) {
        return existing;
    }

    let leaked: &'static str = Box::leak(name.to_string().into_boxed_str());
    names.insert(leaked);
    leaked
}

impl<'de> Deserialize<'de> for Harness {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let name = String::deserialize(d)?;

        Ok(Harness::from_wire_name(&name).unwrap_or_else(|| Harness::Other(intern(&name))))
    }
}

impl From<Harness> for String {
    fn from(harness: Harness) -> String {
        harness.wire_name()
    }
}

impl Harness {
    /// Every harness this build offers.
    ///
    /// [`Harness::Other`] is deliberately absent: it is a value read off disk,
    /// never one to pick, so a picker or an availability read built from this
    /// cannot offer it.
    pub const ALL: [Harness; 3] = [Harness::ClaudeCode, Harness::Codex, Harness::Pi];

    /// How the wire spells it — what `dray new --harness` takes and what an
    /// index entry holds.
    ///
    /// Every caller that needs the *set* of spellings builds it from
    /// [`Harness::ALL`] rather than writing a second list — that second copy is
    /// what drifts, and `--harness pi` was once refused by a hand-written match
    /// in `orchestration` for a harness the app could already run.
    ///
    /// Spelled out here rather than read back out of the serializer: the enum
    /// serializes `into = "String"` *through this function*, so asking serde
    /// would recurse.
    pub fn wire_name(self) -> String {
        match self {
            Harness::ClaudeCode => "claude_code".to_string(),
            Harness::Codex => "codex".to_string(),
            Harness::Pi => "pi".to_string(),
            Harness::Other(name) => name.to_string(),
        }
    }

    /// The harness that spelling names, if this build has one.
    pub fn from_wire_name(name: &str) -> Option<Harness> {
        Harness::ALL.into_iter().find(|h| h.wire_name() == name)
    }

    /// Whether this build has a CLI to spawn for it.
    ///
    /// The one question every path from a [`Harness`] to a running child has to
    /// ask. False for [`Harness::Other`] and nothing else: a name this build
    /// cannot resolve must be *refused*, never fall back to Claude Code —
    /// spawning the wrong agent into somebody's session is the failure the
    /// tolerant read is protecting against, not a milder version of it.
    pub fn names_a_cli(self) -> bool {
        !matches!(self, Harness::Other(_))
    }
}

/// What [`crate::session`] has to know about a harness, in one place.
///
/// Every field here was an equality test against a *named* harness scattered
/// through that file. Two of the eight branch sites are `match` arms the
/// compiler checks; the other six were `==`, and a third harness slips past
/// every one of them silently and in the wrong direction — the worktree rule
/// kept treating "make the tree myself" as Codex's alone, so a pi worktree
/// session would have bailed inside `Session::init` with its index row already
/// written.
///
/// **These describe what Dray does, not what the CLI can do.** pi answers
/// `set_model` on a live connection and this build still respawns for one,
/// because nothing here drives that connection yet. A `false` is safe in a way
/// a `true` is not: replacing a child always applies the change, where applying
/// it in place is only correct if the wire really carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// Whether this build can drive the harness at all.
    ///
    /// Answered *before* a session exists, because the index row is written
    /// ahead of the spawn: a harness that bails inside `Session::init` leaves a
    /// sidebar row pointing at an agent that can never run, and every retry
    /// fails against it identically. All three are true today; the field stays
    /// because the next harness is typed before it is driven, and that window
    /// is exactly what this closes.
    pub drivable: bool,
    /// Whether the CLI creates a worktree itself, given a name.
    ///
    /// Claude Code's `-w` does. Nothing else has such a flag, so Dray resolves
    /// a base ref and makes the tree before the spawn — and a harness wrongly
    /// marked `true` here never gets a tree at all.
    pub creates_own_worktree: bool,
    /// Whether a running child can be moved onto another model without being
    /// replaced.
    pub applies_model_in_place: bool,
    /// Whether a running child can be moved onto another effort.
    ///
    /// False for Claude Code, and that is the CLI's own fact rather than a
    /// choice here: there is no `set_effort` control request, and an `effort`
    /// field on `set_model` is accepted and ignored.
    pub applies_effort_in_place: bool,
    /// Whether a running child can be moved onto another permission mode.
    pub applies_permission_in_place: bool,
    /// Whether a session can be forked.
    pub forkable: bool,
}

impl Harness {
    /// The one table. Exhaustive, so a harness added later is asked every
    /// question the last one was asked.
    pub fn caps(self) -> Capabilities {
        match self {
            // Both switches are control requests on its own channel, verified
            // against the CLI: the reply after `set_model` comes from the new
            // model, so no respawn is needed.
            Harness::ClaudeCode => Capabilities {
                drivable: true,
                creates_own_worktree: true,
                applies_model_in_place: true,
                applies_effort_in_place: false,
                applies_permission_in_place: true,
                forkable: true,
            },
            // `turn/start` carries model, effort and approval policy on every
            // turn, so this is not for want of a per-turn override. A stance is
            // *two* settings and only one has a turn-level form: `sandbox` is
            // thread-level, so applying a change in place would move the
            // approval policy and leave the sandbox where it was — exactly the
            // half-applied setting that makes a session freer than was asked
            // for. Respawning settles both, and `thread/resume` carries the
            // conversation across it.
            Harness::Codex => Capabilities {
                drivable: true,
                creates_own_worktree: false,
                applies_model_in_place: false,
                applies_effort_in_place: false,
                applies_permission_in_place: false,
                forkable: false,
            },
            // Two of these are permanent rather than pending: pi has no
            // worktree flag, and its own `fork` cannot serve Dray's — `clone`
            // hijacks the running process, and `--fork` and `--session` are
            // refused together, so pi names the file rather than taking one.
            // The rest are settings pi takes at spawn and nowhere else, so a
            // change to any of them is a respawn.
            Harness::Pi => Capabilities {
                drivable: true,
                creates_own_worktree: false,
                applies_model_in_place: false,
                applies_effort_in_place: false,
                applies_permission_in_place: false,
                forkable: false,
            },
            // A session some other build wrote and this one cannot run. `false`
            // throughout, and `drivable` is what this variant exists for: the
            // row still draws, so the reader can see the session is there and
            // read its transcript, and nothing will try to spawn a child for a
            // CLI it cannot name.
            Harness::Other(_) => Capabilities {
                drivable: false,
                creates_own_worktree: false,
                applies_model_in_place: false,
                applies_effort_in_place: false,
                applies_permission_in_place: false,
                forkable: false,
            },
        }
    }

    /// What to call it in a sentence somebody reads.
    pub fn label(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "Claude Code",
            Harness::Codex => "Codex",
            Harness::Pi => "pi",
            // Its own spelling, the only thing known about it — and the honest
            // thing to put in a sentence, since the name a newer build wrote is
            // the one its reader will recognise.
            Harness::Other(name) => name,
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
            // pi also publishes to npm, and the page below names that route for
            // anyone who wants it. This is the one that needs nothing already
            // installed, which is the rule the other two follow.
            Harness::Pi => "curl -fsSL https://pi.dev/install.sh | sh",
            // Empty, because there is nothing to install: the CLI is not what
            // is missing, this build is. A command guessed from the name would
            // be the one thing worse than no command.
            Harness::Other(_) => "",
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
            Harness::Pi => "https://pi.dev/docs/latest",
            // Empty, so the notice draws no link rather than a wrong one: the
            // cure here is a newer Dray, not a CLI to install.
            Harness::Other(_) => "",
        }
    }

    /// The command that logs it in, spelled the way a reader would type it.
    ///
    /// Both verified against the installed CLIs rather than guessed:
    /// `claude auth --help` lists `login`, and Claude Code's own error prose
    /// names `claude auth login` outright. `codex login` is a top-level
    /// subcommand. Neither has a non-interactive form worth reaching for, so
    /// both want a real terminal — which is the whole shape of the cure.
    pub fn login_command(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "claude auth login",
            Harness::Codex => "codex login",
            // pi has no login at all. Verified against `pi auth --help`, which
            // offers `print-api-key`, `print-bearer-token` and `check` and
            // nothing that signs anyone in: credentials are per provider, and
            // they arrive from the environment or from `pi config`'s TUI. So
            // there is no one command to name, and naming the nearest thing
            // would send a reader to a subcommand that only reads back what
            // they have not got.
            Harness::Pi => "",
            // Nothing to log in to, for the same reason there is nothing to
            // install: this build cannot name the CLI, let alone drive it.
            Harness::Other(_) => "",
        }
    }

    /// The same command as arguments after the *resolved* binary.
    ///
    /// The launcher cannot use [`login_command`](Self::login_command): a
    /// `.command` script runs under launchd's `PATH`, which holds no `claude`
    /// installed to `~/.local/bin` — the trap [`binpath`](crate::binpath)
    /// exists to solve, one layer out. So the reader copies one spelling and
    /// the terminal runs another, and a test pins the two together.
    pub fn login_args(self) -> &'static [&'static str] {
        match self {
            Harness::ClaudeCode => &["auth", "login"],
            Harness::Codex => &["login"],
            Harness::Pi => &[],
            Harness::Other(_) => &[],
        }
    }
}
