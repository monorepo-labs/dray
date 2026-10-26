//! Preferences Rust has to know before the frontend exists.
//!
//! Timing is the whole reason: the install id, the transcription picks and
//! remote access are all read by Rust, some before any webview exists.
//! **Anything the frontend can read for itself belongs in its local storage,
//! not here**, or this file becomes a second settings store free to disagree
//! with the first.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    issues::TrackerAccount,
    store::{config_dir, read_json, write_atomic},
};

/// Serializes writers. The file is rewritten whole, so a concurrent writer
/// would drop the other's field — same bargain `projects.json` makes.
static SETTINGS_LOCK: Mutex<()> = Mutex::const_new(());

/// What is on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// The old in-app analytics switch, **read by nothing**: Settings offers no
    /// opt-out any more, so a stored `false` is ignored and `DRAY_NO_ANALYTICS`
    /// is the only way off. Kept so an older build sharing `~/.dray` still finds
    /// the field it reads, and so a rewrite here carries its value through.
    #[serde(default = "enabled_by_default")]
    pub analytics_enabled: bool,
    /// A random id for this install, or `None` where nothing has ever been
    /// reported from it. Minted lazily by [`ensure_install_id`] on the first
    /// event.
    #[serde(default)]
    pub install_id: Option<String>,
    /// Who the stored issue-tracker key belongs to.
    ///
    /// The account, never the key — that lives in `credentials.json` beside
    /// this, and never rides the struct handed to the frontend. This is only
    /// what saves a round trip to draw a name in the settings row. It is
    /// therefore not the connection: an account here with no key behind it
    /// reads as disconnected. See [`crate::issues::get_integrations`].
    #[serde(default)]
    pub linear_account: Option<TrackerAccount>,
    /// Which speech-to-text model and microphone to use.
    ///
    /// Here rather than in the webview's local storage, unlike every other
    /// composer pick, because Rust is what reads it: the recording commands
    /// resolve the model and device themselves, and a value the backend has to
    /// ask the frontend for is a value that can be missing when a keypress
    /// needs it.
    #[serde(default)]
    pub transcription: TranscriptionSettings,
    /// Whether this Mac serves itself through a quick tunnel. Here because
    /// Rust starts it at launch, before any webview exists to ask.
    #[serde(default)]
    pub remote_access: bool,
}

/// The transcription picks. Model and device mean "not chosen" when absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSettings {
    /// A catalog id. `None` until a model is downloaded and picked, which is
    /// also what makes the mic button open settings instead of recording.
    #[serde(default)]
    pub model: Option<String>,
    /// An input device *name*, `None` meaning the system default.
    ///
    /// The name and not cpal's enumeration index: the index shifts when a USB
    /// mic is unplugged, so a stored one silently starts naming a different
    /// device. See [`crate::transcription::audio::InputDevice`].
    #[serde(default)]
    pub device: Option<String>,
    /// Whether the speakers are silenced while the microphone is open. On by
    /// default: the mic hears them, so whatever is playing otherwise lands in
    /// the transcript as words nobody said.
    #[serde(default = "enabled_by_default")]
    pub mute_while_recording: bool,
}

impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self {
            model: None,
            device: None,
            mute_while_recording: enabled_by_default(),
        }
    }
}

fn enabled_by_default() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            analytics_enabled: enabled_by_default(),
            install_id: None,
            linear_account: None,
            transcription: TranscriptionSettings::default(),
            remote_access: false,
        }
    }
}

/// Reads `settings.json`, any failure reading as the defaults.
///
/// Never an error: this sits on the launch path, and a hand-edited file must
/// not be able to stop the app starting.
pub async fn read() -> AppSettings {
    let read = match config_dir().await {
        Ok(dir) => read_from(&dir).await,
        Err(e) => Err(e),
    };
    read.unwrap_or_else(|e| {
        eprintln!("[settings read err] {e:#}");
        AppSettings::default()
    })
}

/// Takes the directory so a test can round-trip against a tempdir rather than
/// the real `~/.dray`.
async fn read_from(dir: &Path) -> Result<AppSettings> {
    read_json(&path_in(dir)).await
}

/// Read, edit and write back under one hold of the lock. **The only way to
/// change a setting**, and private visibility on everything that writes is what
/// makes that true rather than aspirational.
///
/// The file is rewritten whole and [`read`] takes no lock, so a read-modify-
/// write in two steps can be interleaved by another and lose its field. There
/// was a `pub write` beside `read` and seven callers pairing them, which is
/// exactly the shape that fails — and it fails *across* features, not within
/// one: a Linear account read before the install id was minted and written back
/// after takes the id with it. A comment saying "use `update`" would have been
/// true and unenforced; taking the write away is what stops the next one.
pub async fn update(edit: impl FnOnce(&mut AppSettings)) -> Result<AppSettings> {
    let _guard = SETTINGS_LOCK.lock().await;
    let _across = crate::store::lock_across_processes("settings.json").await;
    let dir = config_dir().await?;

    // **Only a malformed file recovers**, and the distinction is the whole of
    // this branch. A file that cannot be *parsed* can never be preserved, and
    // erroring on it would block every settings write in the app — the install
    // id, Linear, transcription — until somebody deleted it by hand, which
    // nothing on screen says to do. A file that cannot be *read* is the opposite
    // case: it may be perfectly good and merely unreachable for a moment, so
    // writing defaults over it would erase the Linear account, the install id
    // and every transcription pick in order to change one unrelated setting.
    let mut settings = match read_from(&dir).await {
        Ok(settings) => settings,
        Err(e) if is_malformed(&e) => {
            eprintln!("[settings read err] {e:#}");
            AppSettings::default()
        }
        Err(e) => return Err(e),
    };

    edit(&mut settings);
    write_to(&dir, &settings).await?;

    Ok(settings)
}

/// This install's id, minted and persisted on first use.
///
/// Every install gets one, a stored `analytics_enabled: false` included: the
/// only opt-out is `DRAY_NO_ANALYTICS`, which [`crate::analytics`] checks before
/// asking. Minting goes through [`update`], so a malformed file is recovered
/// rather than silencing analytics for good, and an unreadable one is left
/// untouched.
///
/// **A failed write answers `None`**: nothing caches this, so an id that did not
/// reach disk would be re-minted on the very next event and every event would
/// arrive as a different person. No events beats a fabricated population.
pub async fn ensure_install_id() -> Option<String> {
    // The common case, without the lock. Ids are never cleared, so a read that
    // finds one is right however stale; one that finds none re-checks under it.
    if let Some(id) = read().await.install_id {
        return Some(id);
    }

    let minted = update(|settings| {
        settings
            .install_id
            .get_or_insert_with(|| Uuid::new_v4().to_string());
    })
    .await;

    match minted {
        Ok(settings) => settings.install_id,
        Err(e) => {
            eprintln!("[settings write err] install id not persisted: {e:#}");
            None
        }
    }
}

/// Rewrites the file whole, landing via write-temp + `rename` like the session
/// index does — a torn settings file would fail to parse on the next launch and
/// read as defaults, silently undoing whatever was just set.
async fn write_to(dir: &Path, settings: &AppSettings) -> Result<()> {
    write_atomic(&path_in(dir), serde_json::to_string_pretty(settings)?).await
}

fn path_in(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

/// Whether a [`read_from`] failure is the file being **malformed** rather than
/// unreachable — the one case it is safe to write over.
///
/// `read_json` adds context around the real cause, and anyhow downcasts through
/// that, so the presence of a `serde_json::Error` in the chain is what says the
/// bytes were read and could not be understood. An I/O error has none.
fn is_malformed(e: &anyhow::Error) -> bool {
    e.downcast_ref::<serde_json::Error>().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dray-settings-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn missing_file_reads_as_defaults() {
        let dir = tempdir();

        assert_eq!(read_from(&dir).await.unwrap(), AppSettings::default());
    }

    #[tokio::test]
    async fn empty_file_reads_as_defaults() {
        let dir = tempdir();
        std::fs::write(path_in(&dir), "   \n").unwrap();

        assert_eq!(read_from(&dir).await.unwrap(), AppSettings::default());
    }

    /// `read_from` reports it so `update` can tell it from an unreadable file.
    #[tokio::test]
    async fn unparseable_file_is_an_error() {
        let dir = tempdir();
        std::fs::write(path_in(&dir), "{ not json").unwrap();

        assert!(read_from(&dir).await.is_err());
    }

    #[tokio::test]
    async fn round_trips() {
        let dir = tempdir();
        let off = AppSettings {
            analytics_enabled: false,
            install_id: Some("2f1c…".into()),
            linear_account: None,
            transcription: TranscriptionSettings::default(),
            remote_access: true,
        };

        write_to(&dir, &off).await.unwrap();

        assert_eq!(read_from(&dir).await.unwrap(), off);
    }

    /// The two failures `update` must tell apart. Recovering from a malformed
    /// file replaces it; doing the same for one that is merely unreadable right
    /// now — a permission, a full disk, a network home directory — would erase
    /// the Linear account, the install id and every transcription pick to
    /// change one unrelated switch.
    #[tokio::test]
    async fn a_malformed_file_is_told_from_an_unreadable_one() {
        let dir = tempdir();
        std::fs::write(path_in(&dir), "{ not json").unwrap();

        assert!(is_malformed(&read_from(&dir).await.unwrap_err()));

        let unreadable = anyhow::Error::new(std::io::Error::other("disk on fire"))
            .context("could not open settings.json");

        assert!(!is_malformed(&unreadable));
    }

    /// A file nobody can parse must not brick the settings dialog. `update` is
    /// now the only way to change anything, so an error here would leave every
    /// switch in the app dead until the file was deleted by hand — and nothing
    /// on screen says to do that.
    #[tokio::test]
    async fn an_unparseable_file_does_not_block_writes() {
        let dir = tempdir();
        std::fs::write(path_in(&dir), "{ not json").unwrap();

        let mut settings = read_from(&dir).await.unwrap_or_default();
        settings.transcription.mute_while_recording = false;
        write_to(&dir, &settings).await.unwrap();

        let after = read_from(&dir).await.unwrap();
        assert!(!after.transcription.mute_while_recording);
    }

    /// A file written before the id existed must read as an install that has
    /// simply never reported, not fail the parse and take the whole file's
    /// other settings down with it.
    #[tokio::test]
    async fn a_file_predating_the_install_id_reads_without_one() {
        let dir = tempdir();
        std::fs::write(path_in(&dir), r#"{"analyticsEnabled": true}"#).unwrap();

        let settings = read_from(&dir).await.unwrap();

        assert!(settings.analytics_enabled);
        assert_eq!(settings.install_id, None);
    }

    /// An unknown field must not fail the read, or a file written by a newer
    /// build reads as defaults on every older one.
    #[tokio::test]
    async fn unknown_fields_are_ignored() {
        let dir = tempdir();
        std::fs::write(
            path_in(&dir),
            r#"{"analyticsEnabled": false, "somethingNewer": 3}"#,
        )
        .unwrap();

        assert!(!read_from(&dir).await.unwrap().analytics_enabled);
    }

    #[tokio::test]
    async fn write_leaves_no_temp_file_behind() {
        let dir = tempdir();

        write_to(&dir, &AppSettings::default()).await.unwrap();

        assert!(!dir.join("settings.json.tmp").exists());
    }
}
