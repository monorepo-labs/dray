//! Each session's browser history: the pages its tabs landed on, newest
//! first, for the empty state's recent list and the URL bar's suggestions.
//!
//! **Kept in the session's own profile directory**, so settling or deleting
//! the session takes it along with the cookies. **Dray's record, not
//! Chromium's**: Chromium keeps one in the profile's `History`, but that is
//! SQLite held under an exclusive lock while the profile is open, so reading
//! it would cost a new dependency and a file copy per read.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const FILE: &str = "dray-history.json";
const CAP: usize = 200;

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

fn path(session: &str) -> PathBuf {
    super::browser_dir().join(session).join(FILE)
}

fn with<R>(session: &str, f: impl FnOnce(&mut Vec<Visit>) -> R) -> R {
    let mut guard = HISTORY.lock().unwrap();
    let list = guard.get_or_insert_with(HashMap::new).entry(session.to_string()).or_insert_with(|| {
        std::fs::read(path(session)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    });
    f(list)
}

/// No `create_dir_all`: Chromium makes the profile before any page commits,
/// so a missing directory is a profile settle just removed, and writing
/// would bring it back.
fn save(session: &str, list: &[Visit]) {
    if let Ok(bytes) = serde_json::to_vec(list) {
        let _ = std::fs::write(path(session), bytes);
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
        save(session, list);
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
            save(session, list);
        }
    });
}

pub fn list(session: &str) -> Vec<Visit> {
    with(session, |list| list.clone())
}

/// Drops the in-memory copy, for a session whose profile is being removed,
/// or an unsettled session would be handed the history it was settled with.
pub fn forget(session: &str) {
    if let Some(map) = HISTORY.lock().unwrap().as_mut() {
        map.remove(session);
    }
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
