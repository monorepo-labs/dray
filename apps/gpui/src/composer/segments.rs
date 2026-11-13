//! The composer's text rules, ported from mention.ts and ChatInput.tsx: which
//! picker the caret opens, how a pick lands back in the text, the placeholder.
//!
//! Offsets are UTF-8 bytes, which is what gpui-base's input speaks.

/// The four pickers, by the character that opens each.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Sigil {
    /// `/skills`: a slash command, only ever the prompt's first word.
    Command,
    /// `@files`.
    File,
    /// `&tasks`: another session.
    Task,
    /// `#issues`.
    Issue,
}

impl Sigil {
    pub fn char(self) -> char {
        match self {
            Sigil::Command => '/',
            Sigil::File => '@',
            Sigil::Task => '&',
            Sigil::Issue => '#',
        }
    }

    fn of(c: char) -> Option<Sigil> {
        match c {
            '/' => Some(Sigil::Command),
            '@' => Some(Sigil::File),
            '&' => Some(Sigil::Task),
            '#' => Some(Sigil::Issue),
            _ => None,
        }
    }
}

/// The token the caret sits in and the picker it opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trigger {
    pub sigil: Sigil,
    pub start: usize,
    pub end: usize,
    /// Everything after the sigil to the token's end, not to the caret, so
    /// backing up to fix a typo filters on the corrected whole (mention.ts).
    pub query: String,
}

/// The picker the caret opens, or `None`.
///
/// The walk back stops at whitespace, so landing on a sigil proves it opens a
/// word — the whole email guard, since `me@x.com` walks past its `@`. A command
/// is the prompt's first word or nothing: a slash mid-sentence is a path.
pub fn trigger_at(text: &str, caret: usize) -> Option<Trigger> {
    if caret == 0 || caret > text.len() || !text.is_char_boundary(caret) {
        return None;
    }
    let start = text[..caret].rfind(char::is_whitespace).map_or(0, |i| i + next_len(text, i));
    let sigil = Sigil::of(text[start..].chars().next()?)?;
    if sigil == Sigil::Command && start != 0 {
        return None;
    }
    let end = text[caret..].find(char::is_whitespace).map_or(text.len(), |i| caret + i);
    let query = &text[start + 1..end];
    // `/usr/bin` is a path being typed, not a command.
    if sigil == Sigil::Command && query.contains('/') {
        return None;
    }
    Some(Trigger { sigil, start, end, query: query.to_string() })
}

/// The picker to show for `found`, the token the caret is in, after Escape
/// dismissed the one at `dismissed`. The dismissal holds while the caret stays
/// in that token and lapses once it leaves, so it is checked against `found`
/// before hiding it: checked after, every keystroke in the token lapsed it.
pub fn visible_trigger(found: Option<Trigger>, dismissed: &mut Option<usize>) -> Option<Trigger> {
    if dismissed.is_some_and(|start| found.as_ref().is_none_or(|t| t.start != start)) {
        *dismissed = None;
    }
    found.filter(|t| *dismissed != Some(t.start))
}

fn next_len(text: &str, at: usize) -> usize {
    text[at..].chars().next().map_or(1, char::len_utf8)
}

/// `text` with the trigger's token replaced by `run`, and where the caret goes.
///
/// Always exactly one space after, reusing one already there: two runs touching
/// parse as one token, so the separator is load-bearing (`applyMention`).
pub fn apply_pick(text: &str, trigger: &Trigger, run: &str) -> (String, usize) {
    let head = format!("{}{run}", &text[..trigger.start]);
    let tail = &text[trigger.end..];
    let caret = head.len() + 1;
    let out = if tail.starts_with(' ') { format!("{head}{tail}") } else { format!("{head} {tail}") };
    (out, caret)
}

/// The composer's placeholder: what always works leads, what comes and goes
/// trails, so the line changes at its end. `&` and `#` are named only where they
/// would do something.
pub fn placeholder(new_task: bool, can_mention_task: bool, issues_connected: bool) -> String {
    [
        Some(if new_task { "Describe a task." } else { "Follow-up." }),
        Some("@files."),
        Some("/skills."),
        can_mention_task.then_some("&tasks."),
        issues_connected.then_some("#issues."),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
}

/// How well `query` matches `candidate`, higher better, `None` for no match.
/// A stand-in for the server's fff ranking, used only for lists the owner hands
/// over whole (commands, tasks, issues); files arrive ranked already.
pub fn score(query: &str, candidate: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(1);
    }
    let q = query.to_lowercase();
    let c = candidate.to_lowercase();
    if c.starts_with(&q) {
        return Some(4);
    }
    if c.split(|ch: char| !ch.is_alphanumeric()).any(|w| w.starts_with(&q)) {
        return Some(3);
    }
    if c.contains(&q) {
        return Some(2);
    }
    let mut chars = c.chars();
    q.chars().all(|qc| chars.any(|cc| cc == qc)).then_some(1)
}

/// A task tag as `sessionTag` writes it: `&Title (uuid)`. Any ` (uuid)` already
/// inside the title is dropped, since the backend takes the first id it finds
/// and that one would address some other task.
pub fn task_run(title: &str, id: &str) -> String {
    format!("&{} ({id})", strip_inner_ids(title))
}

fn strip_inner_ids(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut rest = title;
    while let Some(at) = rest.find(" (") {
        let after = &rest[at + 2..];
        let is_id = after.len() > 36 && after.as_bytes()[36] == b')' && is_uuid(&after[..36]);
        out.push_str(&rest[..at]);
        if is_id {
            rest = &after[37..];
        } else {
            out.push_str(" (");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// A mention's face: the filename alone (`splitMention`'s `name`).
pub fn file_face(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// An issue chip's face: `#` and the title, elided to `max` characters.
pub fn issue_face(title: &str, max: usize) -> String {
    if title.chars().count() <= max {
        return format!("#{title}");
    }
    let cut: String = title.chars().take(max.saturating_sub(1)).collect();
    format!("#{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Option<Trigger> {
        let caret = text.find('|').unwrap();
        trigger_at(&text.replace('|', ""), caret)
    }

    #[test]
    fn mention_opens_on_a_word() {
        let t = at("look at @src/ma|in.rs please").unwrap();
        assert_eq!((t.sigil, t.query.as_str()), (Sigil::File, "src/main.rs"));
        assert_eq!(at("mail me@exa|mple.com"), None);
        assert_eq!(at("@|").map(|t| t.query), Some(String::new()));
        assert_eq!(at("|@x"), None);
    }

    #[test]
    fn a_dismissed_picker_stays_shut_inside_its_token() {
        let mut dismissed = Some(8);
        // Typing on in the dismissed token: still shut, still dismissed.
        assert_eq!(visible_trigger(at("look at @src/m|"), &mut dismissed), None);
        assert_eq!(visible_trigger(at("look at @src/mai|"), &mut dismissed), None);
        assert_eq!(dismissed, Some(8));
        // Leaving it lapses the dismissal; a new token opens.
        assert_eq!(visible_trigger(at("look at @src/main |"), &mut dismissed), None);
        assert_eq!(dismissed, None);
        let mut dismissed = Some(8);
        assert_eq!(visible_trigger(at("look at @src/main @l|"), &mut dismissed).map(|t| t.start), Some(18));
        assert_eq!(dismissed, None);
    }

    #[test]
    fn command_is_the_first_word_only() {
        assert_eq!(at("/rev|").map(|t| t.sigil), Some(Sigil::Command));
        assert_eq!(at("run /rev|"), None);
        assert_eq!(at("/usr/b|in"), None);
    }

    #[test]
    fn tags_and_issues() {
        assert_eq!(at("see &fix|").map(|t| t.sigil), Some(Sigil::Task));
        assert_eq!(at("closes #DRA|").map(|t| (t.sigil, t.query)), Some((Sigil::Issue, "DRA".into())));
        assert_eq!(at("colour #fff and| more"), None);
    }

    #[test]
    fn multibyte_before_the_caret() {
        let t = at("日本 @fi|").unwrap();
        assert_eq!(t.query, "fi");
        assert_eq!(&"日本 @fi"[t.start..t.end], "@fi");
    }

    #[test]
    fn pick_leaves_one_space() {
        let t = at("a @ma|in b").unwrap();
        assert_eq!(apply_pick("a @main b", &t, "@src/main.rs"), ("a @src/main.rs b".into(), 15));
        let t = at("a @ma|").unwrap();
        assert_eq!(apply_pick("a @ma", &t, "@src/main.rs"), ("a @src/main.rs ".into(), 15));
    }

    #[test]
    fn placeholder_grows_at_its_end() {
        assert_eq!(placeholder(true, false, false), "Describe a task. @files. /skills.");
        assert_eq!(placeholder(false, true, true), "Follow-up. @files. /skills. &tasks. #issues.");
    }

    #[test]
    fn task_run_drops_ids_inside_the_title() {
        let other = "11111111-2222-3333-4444-555555555555";
        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        assert_eq!(task_run(&format!("Investigate ({other}) failure"), id), format!("&Investigate failure ({id})"));
        assert_eq!(task_run("Fix (the) bug", id), format!("&Fix (the) bug ({id})"));
    }

    #[test]
    fn scoring() {
        assert!(score("rev", "review") > score("rev", "pre-review"));
        assert!(score("rv", "review").is_some());
        assert_eq!(score("zz", "review"), None);
        assert_eq!(issue_face("A very long issue title", 10), "#A very lo…");
    }
}
