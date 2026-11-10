//! The message being built and where it goes: a session to reply to or a
//! new task, the rows typed so far, and the switcher over the sessions. The
//! Mac island's `Composer` draft, its rules kept and its dictation, captures
//! and drafts left for later stages.

use crate::input::TextInput;
use crate::newtask::Picks;
use crate::orb::Dictation;
use crate::server::Session;
use gpui::{App, AppContext, Entity, ScrollHandle};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Session(String),
    New,
}

/// One line of the message, in the order it was said or typed. Editable in place.
pub struct Row {
    pub id: u64,
    pub input: Entity<TextInput>,
    /// Dictated rather than typed, which its mark says.
    pub said: bool,
    /// A screenshot or a dropped file, riding the prompt as an attachment.
    pub file: Option<String>,
    /// A screenshot's place, held from the press so speech said meanwhile
    /// lands around it rather than ahead of it. Drawn as nothing.
    pub pending: bool,
    /// An image file's size, read once from its header, so its thumbnail has
    /// its height before the picture loads and the rows scroll to the true end.
    pub size: Option<(u32, u32)>,
    /// Travels as an image block, so it is numbered; decided once, as the
    /// rule reads the file's size.
    pub image: bool,
}

/// A row as it is sent or restored: its words, or its file.
#[derive(Clone, Debug, PartialEq)]
pub struct RowData {
    pub text: String,
    pub file: Option<String>,
    pub said: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Menu {
    Model,
    Project,
    Stance,
}

/// Which box the panel should put the keyboard in once it next draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Typing,
    Search,
    /// The panel itself, where a card's keys are read.
    Panel,
}

pub struct Draft {
    pub target: Option<Target>,
    pub rows: Vec<Row>,
    next_row: u64,
    pub typing: Entity<TextInput>,
    pub search: Entity<TextInput>,
    /// The switcher, hidden until asked for — the title, Ctrl+F or ↑/↓ — and
    /// again once the reader picks.
    pub list_shown: bool,
    /// The switcher's scroll, so ↑/↓ keep the highlighted row in view.
    pub list_scroll: ScrollHandle,
    /// The rows' scroll, held at the newest as each lands, as the Mac's is.
    pub rows_scroll: ScrollHandle,
    pub sending: bool,
    pub menu: Option<Menu>,
    /// The model row the pointer is on, whose effort levels fly out beside it.
    pub hovered_model: Option<String>,
    pub picks: Picks,
    pub want_focus: Option<Field>,
    pub dictation: Dictation,
    /// The microphone's latest peak, polled while recording.
    pub peak: f32,
    /// When the microphone opened, for the clock.
    pub recording_since: Option<std::time::Instant>,
    /// A failed transcription's recording, which Retry runs again.
    pub retry_path: Option<String>,
    /// Counts dictation runs; a reply for any run but the current one —
    /// cancelled, or replaced — is ignored whole.
    pub run: u64,
    /// A start is still unanswered. The recorder is shared, so no second
    /// start goes out until the first has been answered and, if cancelled,
    /// closed again — or that close could stop the new recording.
    pub start_pending: bool,
    /// The send the reader asked for that still waits: on the words being
    /// transcribed, or on a screenshot or moment still landing.
    pub pinned: Option<Pinned>,
    /// Counts recordings thrown away, which void a cut still transcribing;
    /// `run` would not do, as starting again moves it too.
    pub thrown: u64,
}

/// A send that waits on the words still being said: where it goes and the
/// rows it holds, both as they stood at ⏎. The box's text became one of those
/// rows at ⏎, so the box is left for whatever is written meanwhile, which
/// the send never takes.
#[derive(Clone, Debug)]
pub struct Pinned {
    pub target: Option<Target>,
    pub rows: Vec<u64>,
    /// The stop's words are still being transcribed, and belong to it.
    pub awaiting_words: bool,
}

impl Draft {
    pub fn new(cx: &mut App) -> Self {
        Self {
            target: None,
            rows: Vec::new(),
            next_row: 0,
            typing: cx.new(|cx| TextInput::new(placeholder(), cx)),
            search: cx.new(|cx| TextInput::new("Search tasks  Ctrl+F", cx).max_lines(1)),
            list_shown: false,
            list_scroll: ScrollHandle::new(),
            rows_scroll: ScrollHandle::new(),
            sending: false,
            menu: None,
            hovered_model: None,
            picks: Picks::load(),
            want_focus: None,
            dictation: Dictation::Idle,
            peak: 0.0,
            recording_since: None,
            retry_path: None,
            run: 0,
            start_pending: false,
            pinned: None,
            thrown: 0,
        }
    }

    pub fn session(&self) -> Option<&str> {
        match &self.target {
            Some(Target::Session(id)) => Some(id),
            _ => None,
        }
    }

    pub fn add_row(&mut self, text: &str, cx: &mut App) {
        self.push_row(text, false, cx);
    }

    /// Dictated words, as a row of their own; answers its id.
    pub fn add_said(&mut self, text: &str, cx: &mut App) -> u64 {
        self.push_row(text, true, cx)
    }

    fn push_row(&mut self, text: &str, said: bool, cx: &mut App) -> u64 {
        let text = text.to_string();
        let input = cx.new(|cx| {
            let mut input = TextInput::new("", cx).max_lines(4);
            input.set_text(&text, cx);
            input
        });
        self.next_row += 1;
        self.rows.push(Row { id: self.next_row, input, said, file: None, pending: false, size: None, image: false });
        self.rows_scroll.scroll_to_bottom();
        self.next_row
    }

    /// A file row: a screenshot taken, or a file dropped on the panel.
    pub fn add_file(&mut self, path: &str, cx: &mut App) -> u64 {
        let id = self.push_row("", false, cx);
        if let Some(row) = self.rows.last_mut() {
            row.file = Some(path.to_string());
            row.image = crate::capture::is_image(path);
            row.size = image_size(path);
        }
        id
    }

    /// Holds the next screenshot's place at the end of the draft.
    pub fn reserve_shot(&mut self, cx: &mut App) -> u64 {
        let id = self.push_row("", false, cx);
        if let Some(row) = self.rows.last_mut() {
            row.pending = true;
        }
        id
    }

    /// The shot taken into the place held for it, or the place let go.
    pub fn fill_shot(&mut self, id: u64, path: Option<&str>) {
        match path {
            Some(path) => {
                if let Some(row) = self.rows.iter_mut().find(|r| r.id == id) {
                    row.file = Some(path.to_string());
                    row.image = crate::capture::is_image(path);
                    row.size = image_size(path);
                    row.pending = false;
                }
                self.rows_scroll.scroll_to_bottom();
            }
            None => self.rows.retain(|r| r.id != id),
        }
    }

    /// Inserts dictated words just before the row `before`, or at the end.
    pub fn add_said_before(&mut self, text: &str, before: u64, cx: &mut App) -> u64 {
        let id = self.push_row(text, true, cx);
        let row = self.rows.pop().expect("just pushed");
        let at = self.rows.iter().position(|r| r.id == before).unwrap_or(self.rows.len());
        self.rows.insert(at, row);
        // Words cut ahead of a shot in a waiting send are that send's.
        if let Some(p) = self.pinned.as_mut().filter(|p| p.rows.contains(&before)) {
            p.rows.push(id);
        }
        id
    }

    /// Rows as they would be sent, `only` those ids where given; held places
    /// are left out.
    pub fn snapshot(&self, only: Option<&[u64]>, cx: &App) -> Vec<RowData> {
        self.rows
            .iter()
            .filter(|r| !r.pending && only.is_none_or(|ids| ids.contains(&r.id)))
            .map(|r| RowData { text: r.input.read(cx).text().to_string(), file: r.file.clone(), said: r.said })
            .collect()
    }

    /// Puts rows back, as a failed send restores them.
    pub fn restore_rows(&mut self, rows: &[RowData], cx: &mut App) {
        for r in rows {
            match &r.file {
                Some(path) => {
                    self.add_file(path, cx);
                }
                None => {
                    self.push_row(&r.text, r.said, cx);
                }
            }
        }
    }

    /// A screenshot's place is still being filled.
    pub fn holding(&self) -> bool {
        self.rows.iter().any(|r| r.pending)
    }

    /// An image row's label: its place among the draft's images, the order
    /// its block reaches the model in.
    pub fn label(&self, id: u64) -> String {
        let Some(row) = self.rows.iter().find(|r| r.id == id) else { return String::new() };
        let Some(path) = &row.file else { return String::new() };
        if !row.image {
            return std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string();
        }
        let before = self.rows.iter().take_while(|r| r.id != id).filter(|r| r.image).count();
        format!("Image {}", before + 1)
    }

    /// Every row's text and then the box's, in order.
    pub fn parts(&self, cx: &App) -> (Vec<String>, String) {
        (self.rows.iter().map(|r| r.input.read(cx).text().to_string()).collect(), self.typing.read(cx).text().to_string())
    }

    /// Something under way that a new card must not push aside.
    pub fn busy(&self, cx: &App) -> bool {
        !self.rows.is_empty()
            || !self.typing.read(cx).text().is_empty()
            || self.list_shown
            || self.menu.is_some()
            || self.dictation != Dictation::Idle
    }

    /// The microphone is open or opening: what the orb and layout draw as recording.
    pub fn listening(&self) -> bool {
        matches!(self.dictation, Dictation::Starting | Dictation::Recording)
    }
}

/// The box's prompt, naming the reader's key, which Dray's Settings can move.
pub fn placeholder() -> String {
    format!("{} to speak, Ctrl+⏎ Queue, ⏎ Send", crate::prefs::read().key.label())
}

/// The message as sent and its attachments. Each file stands in the text
/// where it sits — `[Image 1]`, or a file's name — so the model can tell which
/// words are about which image when the images arrive as blocks of their own.
pub fn compose(rows: &[RowData], typing: &str) -> (String, Vec<String>) {
    let mut images = 0;
    let parts: Vec<String> = rows
        .iter()
        .map(|r| match &r.file {
            Some(path) if crate::capture::is_image(path) => {
                images += 1;
                format!("[Image {images}]")
            }
            Some(path) => format!("[{}]", std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path)),
            None => r.text.clone(),
        })
        .collect();
    let files = rows.iter().filter_map(|r| r.file.clone()).collect();
    (prompt(&parts, typing), files)
}

/// The message as sent: each row, then what is still in the box, trimmed and
/// joined by spaces, empty ones left out.
pub fn prompt(rows: &[String], typing: &str) -> String {
    rows.iter()
        .map(String::as_str)
        .chain([typing])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The switcher's rows: newest first, narrowed by the search, set-aside
/// sessions left out by the sidebar's rule — flagged, or untouched for three
/// days. `modified` is RFC3339 UTC, so it orders as a string.
pub fn listed<'a>(sessions: &'a [Session], search: &str, stale: &str) -> Vec<&'a Session> {
    let q = search.trim().to_lowercase();
    let mut list: Vec<&Session> = sessions
        .iter()
        .filter(|s| s.hidden != Some(true) && s.archived != Some(true) && s.aside != Some(true))
        .filter(|s| s.modified.as_str() > stale)
        .filter(|s| q.is_empty() || s.title.to_lowercase().contains(&q) || s.project().to_lowercase().contains(&q))
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    list
}

/// Three days ago as RFC3339 UTC, the sidebar's line for a stale session.
pub fn stale_line() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    rfc3339(now.saturating_sub(3 * 24 * 3600))
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ`, by Howard Hinnant's
/// civil-from-days, so no date crate rides along for one comparison.
fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// A fresh session id, as the frontend's `crypto.randomUUID()` mints one: the
/// agent adopts the id the app picks.
pub fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, title: &str, modified: &str) -> Session {
        Session { session_id: id.into(), title: title.into(), modified: modified.into(), project_path: "/p/dray".into(), ..Default::default() }
    }

    #[test]
    fn files_stand_in_the_text_where_they_sit() {
        // Real files, since what counts as an image reads the size.
        let dir = std::env::temp_dir().join(format!("dray-island-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str, len: usize| {
            let path = dir.join(name);
            std::fs::write(&path, vec![0u8; len]).unwrap();
            path.to_string_lossy().to_string()
        };
        let (a, notes, big, b) = (file("a.png", 10), file("notes.txt", 10), file("big.png", 5 * 1024 * 1024 + 1), file("b.jpg", 10));
        let row = |text: &str, file: Option<&str>| RowData { text: text.into(), file: file.map(str::to_string), said: false };
        let rows = [row("look at", None), row("", Some(&a)), row("and", None), row("", Some(&notes)), row("", Some(&big)), row("", Some(&b))];
        let (text, files) = compose(&rows, "thanks");
        // Over 5MB the server sends a path, not a block, so it takes no number.
        assert_eq!(text, "look at [Image 1] and [notes.txt] [big.png] [Image 2] thanks");
        assert_eq!(files, [a, notes, big, b]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rows_and_the_box_join_into_one_prompt() {
        assert_eq!(prompt(&["  first ".into(), "".into(), "second".into()], " third "), "first second third");
        assert_eq!(prompt(&[], "  "), "");
    }

    #[test]
    fn the_switcher_lists_newest_first_and_drops_the_set_aside() {
        let mut aside = session("c", "Aside", "2026-11-10T09:00:00Z");
        aside.aside = Some(true);
        let sessions = vec![
            session("a", "Older", "2026-11-09T09:00:00Z"),
            session("b", "Newer", "2026-11-10T08:00:00Z"),
            aside,
            session("d", "Stale", "2026-11-01T09:00:00Z"),
        ];
        let ids = |l: Vec<&Session>| l.iter().map(|s| s.session_id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(listed(&sessions, "", "2026-11-07T00:00:00Z")), ["b", "a"]);
        assert_eq!(ids(listed(&sessions, "old", "2026-11-07T00:00:00Z")), ["a"]);
        assert_eq!(ids(listed(&sessions, "DRAY", "2026-11-07T00:00:00Z")), ["b", "a"]);
    }

    #[test]
    fn rfc3339_reads_the_calendar() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_794_318_897), "2026-11-10T13:54:57Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }
}

fn image_size(path: &str) -> Option<(u32, u32)> {
    crate::capture::is_image(path).then(|| image::image_dimensions(path).ok()).flatten()
}
