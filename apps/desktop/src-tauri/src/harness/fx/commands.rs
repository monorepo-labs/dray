//! The slash commands fx offers, which are its skills and nothing else — the
//! same reading [`codex::commands`](super::super::codex::commands) takes, for
//! the same reason. fx's own `/` menu (`/model`, `/clear`, `/login`,
//! `/settings`, …) is TUI actions that never reach the server, every one of
//! which Dray already owns in its own chrome.
//!
//! **Read off disk, because nothing on the wire answers.** `fx acp` publishes
//! `available_commands_update` with an empty list at `session/new`, still empty
//! after a full turn, and still empty in a workspace holding a skill (verified
//! against fx 0.0.10). There is no `skills/list` to ask the way Codex has one,
//! no `fx skills` subcommand, and a promptless `session/new` is persisted — so a
//! probe through ACP would litter `~/.fx/sessions` and answer nothing anyway.
//! Walking the roots is a reimplementation of fx's own discovery and is
//! deliberately chosen over that; [`ROOTS`] is fx's list verbatim, not a guess.
//!
//! **The send path needs nothing, which is the difference from Codex.** fx
//! expands a leading `/name` itself: `/hello then also print DONE-8899` sent as
//! ordinary prompt text ran the workspace's `hello` skill *and* honoured the
//! words after it, verified live. So a pick travels as text like Claude Code's
//! does, and there is no companion to [`super::super::codex::turn_input`] here.
//!
//! Cost, stated: this list can only ever be fx's *approximately*. Over-listing
//! is the unsafe direction — a row fx did not load sends `/name` to a model with
//! no such skill — so the walk requires a readable `SKILL.md` and a name that
//! could be typed, which is what a broken symlink and a spaced directory fail.
//! A skill fx skipped for its own reasons (`FX_SKILL_SYMLINK_AUTHORITIES`) is
//! the one shape that still gets through.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use crate::harness::claude_code::commands::{first_sentence, SlashCommand};

/// Where fx looks, in its own order and its own words — the strings are lifted
/// from its `/skills` usage output, which labels each one `workspace` or
/// `global`. Two asymmetries are fx's rather than typos: the workspace side
/// carries a bare `skills/` and `.opencode/skills`, and the global side carries
/// `.config/opencode/skills` instead of the latter.
const WORKSPACE_ROOTS: [&str; 7] = [
    ".fx/skills",
    "skills",
    ".opencode/skills",
    ".codex/skills",
    ".claude/skills",
    ".agents/skills",
    ".claw/skills",
];

const GLOBAL_ROOTS: [&str; 6] = [
    ".fx/skills",
    ".config/opencode/skills",
    ".codex/skills",
    ".claude/skills",
    ".agents/skills",
    ".claw/skills",
];

/// Only the frontmatter is wanted, and a `SKILL.md` runs to tens of kilobytes of
/// instructions after it. Bounded rather than read whole, since this opens every
/// skill on the machine to draw one line each.
const FRONTMATTER_BYTES: u64 = 4096;

/// The picker's rows for a session running in `cwd`.
///
/// Uncached, unlike every other harness's list: those each spawn a child and pay
/// seconds for it, where this is a dozen `read_dir`s. A cache here would buy a
/// few milliseconds and cost what Claude Code's and Codex's already cost — a
/// skill installed while Dray is open needing a restart to show up.
///
/// Infallible by construction: an unreadable root is a root with no skills in
/// it, which is also what an absent one is.
pub async fn list_commands(cwd: &str) -> Vec<SlashCommand> {
    let cwd = PathBuf::from(cwd);

    // `read_dir` and the `SKILL.md` reads are blocking, and this runs on the
    // async command path the composer is waiting on.
    tokio::task::spawn_blocking(move || walk(&cwd))
        .await
        .unwrap_or_default()
}

/// Every skill reachable from `cwd`, workspace before global and alphabetical
/// within each root.
///
/// The first of a repeated name wins, so a project's own skill shadows the
/// global one it shares a name with — the order fx resolves them in, and the
/// only order in which the picker can offer a name once.
fn walk(cwd: &Path) -> Vec<SlashCommand> {
    let home = std::env::home_dir();

    let roots = WORKSPACE_ROOTS
        .iter()
        .map(|root| cwd.join(root))
        .chain(GLOBAL_ROOTS.iter().filter_map(|root| {
            // A `None` home is not a reason to skip the workspace half.
            home.as_ref().map(|home| home.join(root))
        }));

    let mut found: Vec<SlashCommand> = Vec::new();
    for root in roots {
        for command in skills_in(&root) {
            if !found.iter().any(|seen| seen.name == command.name) {
                found.push(command);
            }
        }
    }

    found
}

/// The skills directly under one root. A skill is a directory holding a
/// readable `SKILL.md`, which is fx's own rule and what keeps an ordinary
/// `skills/` folder of notes out of the picker.
fn skills_in(root: &Path) -> Vec<SlashCommand> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut skills: Vec<SlashCommand> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            // A name that cannot be typed after a slash is a name the picker
            // must not offer: `/my skill` sends one word and drops the rest.
            if name.is_empty() || name.starts_with('.') || name.contains(char::is_whitespace) {
                return None;
            }

            // Not `entry.file_type()`: a skill root of symlinks into a dotfiles
            // repo is ordinary, and following them is what fx does too.
            let frontmatter = read_frontmatter(&entry.path().join("SKILL.md"))?;

            Some(SlashCommand {
                name,
                description: first_sentence(&description_of(&frontmatter)),
                // fx publishes neither. A skill takes whatever follows it as
                // ordinary prose, so there is no hint to draw and no alias.
                argument_hint: String::new(),
                aliases: Vec::new(),
            })
        })
        .collect();

    // `read_dir` answers in whatever order the filesystem holds, which is not
    // stable between machines or even reads — and the picker draws this order.
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// The head of a `SKILL.md`, or `None` where there is no readable file — which
/// is what a broken symlink and a directory of something else both answer.
fn read_frontmatter(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(FRONTMATTER_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;

    // Lossy rather than strict: a stray byte in a skill somebody else wrote
    // should cost that character, not the row.
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The `description` from a YAML frontmatter block.
///
/// Hand-read rather than parsed: the whole need is one scalar off the top of the
/// file, and a YAML dependency to reach it would be the largest thing in this
/// module. Empty is an ordinary answer — a skill with no description draws its
/// name alone.
///
/// Block scalars are read, and that is not completeness for its own sake:
/// `description: >` with the sentence indented underneath is how most skills in
/// the wild are written, so skipping it left half the picker's rows naming
/// themselves and saying nothing.
fn description_of(head: &str) -> String {
    let mut lines = head.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }

    while let Some(line) = lines.next() {
        if line.trim() == "---" {
            break;
        }
        let Some(value) = line.strip_prefix("description:") else {
            continue;
        };

        let value = value.trim();
        if value.starts_with('>') || value.starts_with('|') {
            return folded(lines);
        }

        return value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .to_string();
    }

    String::new()
}

/// The indented body of a block scalar, joined into one line.
///
/// Folded and literal blocks are read the same way, since the row is one line
/// either way. The block ends at the first line that is not indented — a blank
/// line included, which in YAML is a paragraph break and here is simply past the
/// first sentence the row will be cut to.
fn folded<'a>(lines: impl Iterator<Item = &'a str>) -> String {
    let mut out = String::new();

    for line in lines {
        if !line.starts_with(char::is_whitespace) {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line.trim());
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn skill(root: &Path, name: &str, body: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    fn tmp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dray-fx-skills-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The shape a Claude-authored skill has, which is the shape fx reads.
    #[test]
    fn a_description_is_read_off_the_frontmatter() {
        let head = "---\nname: hello\ndescription: Greets somebody. Use when asked.\n---\n\n# Body";
        assert_eq!(
            description_of(head),
            "Greets somebody. Use when asked.",
            "the value is taken whole; the picker cuts it"
        );
    }

    /// Quoting is the author's business and never the reader's.
    #[test]
    fn quotes_around_the_value_are_not_part_of_it() {
        assert_eq!(description_of("---\ndescription: \"Does a thing\"\n---"), "Does a thing");
        assert_eq!(description_of("---\ndescription: 'Does a thing'\n---"), "Does a thing");
    }

    /// How most skills in the wild are written, and what half the picker's rows
    /// said nothing without.
    #[test]
    fn a_block_scalar_is_read_as_one_line() {
        let head = "---\nname: caveman\ndescription: >\n  Ultra-compressed mode.\n  Cuts tokens.\n---\n\n# Body";
        assert_eq!(description_of(head), "Ultra-compressed mode. Cuts tokens.");

        // A literal block is the same row, since a row is one line either way.
        assert_eq!(description_of("---\ndescription: |\n  Does a thing.\n---"), "Does a thing.");

        // The block ends where the indent does, so the next key is never read
        // into it.
        assert_eq!(
            description_of("---\ndescription: >\n  Kept.\nname: not-part-of-it\n---"),
            "Kept."
        );
    }

    /// Every shape this does not read answers empty rather than dropping the
    /// skill — the name alone is still a usable row.
    #[test]
    fn an_unread_shape_costs_the_description_and_not_the_row() {
        assert_eq!(description_of("# No frontmatter\n\ndescription: nope"), "");
        assert_eq!(description_of("---\nname: x\n---\ndescription: below"), "");
        assert_eq!(description_of(""), "");
    }

    /// A directory with no `SKILL.md` is not a skill, which is what keeps an
    /// ordinary `skills/` folder of notes out of the picker.
    #[test]
    fn only_a_directory_holding_a_skill_md_is_offered() {
        let root = tmp("plain");
        skill(&root, "real", "---\ndescription: Real one\n---");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("loose.md"), "not a skill").unwrap();

        let found = skills_in(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "real");
        assert_eq!(found[0].description, "Real one");
    }

    /// A name that cannot be typed after a slash must not be offered: the
    /// composer would send `/my` and drop the rest of it.
    #[test]
    fn a_name_with_a_space_in_it_is_not_offered() {
        let root = tmp("spaced");
        skill(&root, "my skill", "---\ndescription: x\n---");
        skill(&root, "fine", "---\ndescription: x\n---");

        let names: Vec<_> = skills_in(&root).into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["fine"]);
    }

    /// Rows are ordered by name, since `read_dir` is ordered by nothing the
    /// reader can see and the picker draws whatever it is handed.
    #[test]
    fn rows_come_back_in_a_stable_order() {
        let root = tmp("order");
        for name in ["zulu", "alpha", "mike"] {
            skill(&root, name, "---\ndescription: x\n---");
        }

        let names: Vec<_> = skills_in(&root).into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["alpha", "mike", "zulu"]);
    }

    /// The workspace wins a shared name, and it wins it *once* — the picker
    /// cannot offer one name twice, since a pick has to mean one skill.
    #[test]
    fn a_project_skill_shadows_the_global_one_it_shares_a_name_with() {
        let cwd = tmp("shadow");
        skill(&cwd.join(".claude/skills"), "shared", "---\ndescription: Project copy\n---");
        skill(&cwd.join(".fx/skills"), "shared", "---\ndescription: Also project\n---");

        let found = walk(&cwd);
        let shared: Vec<_> = found.iter().filter(|c| c.name == "shared").collect();
        assert_eq!(shared.len(), 1, "one name, one row");
        assert_eq!(
            shared[0].description, "Also project",
            ".fx/skills is the first root fx names, so it resolves first"
        );
    }

    /// A directory that is not a repository, or holds no skill roots at all,
    /// answers an empty picker rather than failing.
    #[test]
    fn a_workspace_with_no_skills_answers_nothing_from_it() {
        let cwd = tmp("bare");
        let names: Vec<_> = walk(&cwd)
            .into_iter()
            .map(|c| c.name)
            .filter(|name| name == "nothing-here")
            .collect();
        assert!(names.is_empty());
    }
}
