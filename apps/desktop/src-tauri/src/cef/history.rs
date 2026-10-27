//! Each session's browser history: the pages its tabs landed on, newest
//! first, for the empty state's recent list and the URL bar's suggestions.
//!
//! **Kept in the session's own profile directory**, so settling or deleting
//! the session takes it along with the cookies. **Dray's record, not
//! Chromium's**: Chromium keeps one in the profile's `History`, but that is
//! SQLite held under an exclusive lock while the profile is open, so reading
//! it would cost a new dependency and a file copy per read.
//!
//! **The session's tab strip lives beside it** (`dray-tabs.json`), written by
//! the same thread, so a quit — an update's relaunch included — reopens on
//! the tabs it left rather than on an empty pane.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FILE: &str = "dray-history.json";
const CAP: usize = 200;
const STRIP_FILE: &str = "dray-tabs.json";

/// A session's tabs as they stood, in strip order.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Strip {
    pub tabs: Vec<SavedTab>,
    /// Index into `tabs`.
    #[serde(default)]
    pub active: Option<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedTab {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub favicon: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Visit {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub favicon: String,
    pub visits: u32,
    /// Unix milliseconds.
    pub last: u64,
}

static HISTORY: Mutex<Option<HashMap<String, Vec<Visit>>>> = Mutex::new(None);
/// Sessions whose list changed since the writer last ran.
static DIRTY: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static WRITER: OnceLock<mpsc::Sender<()>> = OnceLock::new();
/// Strips waiting for the writer, the newest per session.
static STRIPS: Mutex<BTreeMap<String, Strip>> = Mutex::new(BTreeMap::new());
/// How long the writer gathers changes before it writes, so a page cycling
/// its title costs one write a second rather than one per title.
const WRITE_AFTER: Duration = Duration::from_secs(1);

fn path(session: &str) -> PathBuf {
    super::browser_dir().join(session).join(FILE)
}

fn read(session: &str) -> Vec<Visit> {
    std::fs::read(path(session)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn with<R>(session: &str, f: impl FnOnce(&mut Vec<Visit>) -> R) -> R {
    let mut guard = HISTORY.lock().unwrap();
    let list = guard.get_or_insert_with(HashMap::new).entry(session.to_string()).or_insert_with(|| read(session));
    f(list)
}

/// Marks the list for the writer, which is a thread of its own: these are
/// called from CEF's display handlers on the main thread, where a disk
/// write is a pause in the whole window. The quit writes whatever is still
/// waiting (`flush`).
fn save(session: &str) {
    DIRTY.lock().unwrap().insert(session.to_string());
    ping();
}

fn ping() {
    let tx = WRITER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<()>();
        let _ = std::thread::Builder::new().name("browser-history".into()).spawn(move || {
            while rx.recv().is_ok() {
                std::thread::sleep(WRITE_AFTER);
                while rx.try_recv().is_ok() {}
                flush();
            }
        });
        tx
    });
    let _ = tx.send(());
}

/// No `create_dir_all`: Chromium makes the profile before any page commits,
/// so a missing directory is a profile settle just removed, and writing
/// would bring it back. A forgotten session has no list here to write.
/// Also run at quit, or a tab opened in the last second would not come back.
pub fn flush() {
    let strips = std::mem::take(&mut *STRIPS.lock().unwrap());
    for (session, strip) in strips {
        if let Ok(bytes) = serde_json::to_vec(&strip) {
            let _ = std::fs::write(super::browser_dir().join(&session).join(STRIP_FILE), bytes);
        }
    }
    let dirty = std::mem::take(&mut *DIRTY.lock().unwrap());
    for session in dirty {
        let list = HISTORY.lock().unwrap().as_ref().and_then(|m| m.get(&session).cloned());
        if let Some(bytes) = list.and_then(|l| serde_json::to_vec(&l).ok()) {
            let _ = std::fs::write(path(&session), bytes);
        }
    }
}

/// A main frame committed `url`. Only web pages count: `about:blank`, a
/// `data:` page or DevTools is nowhere the reader would go back to.
pub fn visit(session: &str, url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let last = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    with(session, |list| {
        record(list, url, last);
        save(session);
    });
}

fn record(list: &mut Vec<Visit>, url: &str, last: u64) {
    let entry = match list.iter().position(|v| v.url == url) {
        Some(i) => {
            let mut v = list.remove(i);
            v.visits += 1;
            v.last = last;
            v
        }
        None => Visit { url: url.into(), title: String::new(), favicon: String::new(), visits: 1, last },
    };
    list.insert(0, entry);
    list.truncate(CAP);
}

/// The page at `url` reported its title or icon. Written only where it moved,
/// since a page animating its title would otherwise rewrite the file per frame.
pub fn describe(session: &str, url: &str, title: Option<&str>, favicon: Option<&str>) {
    with(session, |list| {
        let Some(v) = list.iter_mut().find(|v| v.url == url) else { return };
        let mut moved = false;
        if let Some(t) = title.filter(|t| !t.is_empty() && *t != v.title) {
            v.title = t.into();
            moved = true;
        }
        if let Some(f) = favicon.filter(|f| !f.is_empty() && *f != v.favicon) {
            v.favicon = f.into();
            moved = true;
        }
        if moved {
            save(session);
        }
    });
}

/// Read from memory where the session has a list there, else from disk
/// without keeping it: a read landing between `forget` and the profile's
/// removal would otherwise hold the old list for the session's next life.
pub fn list(session: &str) -> Vec<Visit> {
    let cached = HISTORY.lock().unwrap().as_ref().and_then(|m| m.get(session).cloned());
    cached.unwrap_or_else(|| read(session))
}

/// Drops the in-memory copy and any write pending for it, for a session
/// whose profile is being removed, or an unsettled session would be handed
/// the history it was settled with.
pub fn forget(session: &str) {
    DIRTY.lock().unwrap().remove(session);
    STRIPS.lock().unwrap().remove(session);
    if let Some(map) = HISTORY.lock().unwrap().as_mut() {
        map.remove(session);
    }
}

/// Queues a session's strip for the writer.
pub fn save_strip(session: &str, strip: Strip) {
    STRIPS.lock().unwrap().insert(session.to_string(), strip);
    ping();
}

/// The strip a session had when it was last written.
pub fn read_strip(session: &str) -> Option<Strip> {
    let bytes = std::fs::read(super::browser_dir().join(session).join(STRIP_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_revisit_moves_to_the_front_and_counts() {
        let mut list = Vec::new();
        record(&mut list, "https://a.test/", 1);
        record(&mut list, "https://b.test/", 2);
        record(&mut list, "https://a.test/", 3);
        assert_eq!(list.iter().map(|v| v.url.as_str()).collect::<Vec<_>>(), ["https://a.test/", "https://b.test/"]);
        assert_eq!((list[0].visits, list[0].last), (2, 3));
    }

    #[test]
    fn the_list_is_capped() {
        let mut list = Vec::new();
        for i in 0..CAP + 5 {
            record(&mut list, &format!("https://{i}.test/"), i as u64);
        }
        assert_eq!(list.len(), CAP);
        assert_eq!(list[0].url, format!("https://{}.test/", CAP + 4));
    }
}
