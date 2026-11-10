//! The island's own preferences, the Linux stand-in for the Mac's `defaults`
//! domain: `island.json` under the XDG config dir. Dray writes `key`, the
//! island writes `placement`; each rewrites only its own field, keeping the
//! other as read, so neither undoes the other.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    #[default]
    Top,
    Bottom,
}

/// The modifier tapped alone to open the panel. The Mac's names, since Dray's
/// Settings hands the same value to both: Option is Alt here, Command is Super.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Key {
    #[default]
    Control,
    Option,
    Command,
}

impl Key {
    /// The key's name as a Linux keyboard prints it.
    pub fn label(self) -> &'static str {
        match self {
            Key::Control => "Ctrl",
            Key::Option => "Alt",
            Key::Command => "Super",
        }
    }
}

/// Unknown or unreadable fields fall back one at a time, so a value written by
/// a newer Dray costs that field and never the file.
#[derive(Default)]
pub struct Prefs {
    pub key: Key,
    pub placement: Placement,
}

fn path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::home_dir().map(|h| h.join(".config")))?;
    Some(base.join("dray/island.json"))
}

fn raw() -> serde_json::Map<String, serde_json::Value> {
    path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Read fresh each time, so Dray's Settings lands without a restart.
pub fn read() -> Prefs {
    let raw = raw();
    fn field<T: serde::de::DeserializeOwned + Default>(raw: &serde_json::Map<String, serde_json::Value>, name: &str) -> T {
        raw.get(name).cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }
    Prefs { key: field(&raw, "key"), placement: field(&raw, "placement") }
}

/// Writes `placement` alone, through a temp file and a rename. Dray rewrites
/// the same file, so both take `island.json.lock` from the read to the
/// rename (`island.rs` in the app), or one could save over the other's field.
pub fn set_placement(placement: Placement) {
    let Some(path) = path() else { return };
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().expect("a file under a dir"))?;
        let lock = std::fs::File::create(path.with_extension("json.lock"))?;
        lock.lock()?;
        let mut raw = raw();
        raw.insert("placement".into(), serde_json::to_value(placement)?);
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&tmp, serde_json::to_vec_pretty(&raw)?)?;
        std::fs::rename(tmp, &path)
    };
    if let Err(err) = write() {
        eprintln!("island: could not save placement: {err}");
    }
}
