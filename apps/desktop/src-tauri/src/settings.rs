//! Preferences Rust has to know before the frontend exists.
//!
//! Only one lives here, and timing is the whole reason: `app_started` is sent
//! from `setup`, so a preference kept in the webview's local storage — where
//! `ade.diffStyle` and every other pick lives — could not be consulted until
//! after the one event it governs had already gone. **Anything the frontend can
//! read for itself belongs there, not here**, or this file becomes a second
//! settings store free to disagree with the first.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{fs, sync::Mutex};
use ts_rs::TS;

use crate::{issues::TrackerAccount, store::get_home_app_dir};

/// Serializes writers. The file is rewritten whole, so a concurrent writer
/// would drop the other's field — same bargain `projects.json` makes.
static SETTINGS_LOCK: Mutex<()> = Mutex::const_new(());

/// What is on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Opted in by default, and the default is what a **missing** file reads
    /// as. A file that exists and cannot be parsed reads the other way — see
    /// [`read`].
    #[serde(default = "enabled_by_default")]
    pub analytics_enabled: bool,
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
            linear_account: None,
            transcription: TranscriptionSettings::default(),
        }
    }
}

/// What the settings dialog draws, which is not what is on disk.
///
/// The environment can force reporting off for a run, and a switch drawn from
/// the file alone would then sit at `on` while nothing was being sent.
/// `analytics_locked` is what lets the row disable itself and say why, rather
/// than lie.
#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// Effective, not stored — the environment is already folded in.
    pub analytics_enabled: bool,
    pub analytics_locked: bool,
}

/// Reads `settings.json`, **failing closed**.
///
/// A missing or empty file is a fresh install and reads as the defaults. Any
/// other failure — unparseable JSON, an unreadable file, no home directory —
/// reads as opted *out*, because a file that exists and cannot be understood is
/// far likelier to belong to someone who turned this off than to someone who
/// never touched it. Never an error: this sits on the launch path, and a
/// hand-edited file must not be able to stop the app starting.
pub async fn read() -> AppSettings {
    let dir = match get_home_app_dir().await {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[settings read err] {e:#}");
            return opted_out();
        }
    };

    match read_from(&dir).await {
        Ok(settings) => settings,
        Err(e) => {
            eprintln!("[settings read err] {e:#}");
            opted_out()
        }
    }
}

/// The fail-closed answer. Spelled out rather than reusing `Default` so the two
/// can never be confused: the default is opted *in*, and this is its opposite.
fn opted_out() -> AppSettings {
    AppSettings {
        analytics_enabled: false,
        linear_account: None,
        transcription: TranscriptionSettings::default(),
    }
}

/// Takes the directory so a test can round-trip against a tempdir rather than
/// the real `~/.dray`.
async fn read_from(dir: &Path) -> Result<AppSettings> {
    let contents = match fs::read_to_string(path_in(dir)).await {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AppSettings::default()),
        Err(e) => return Err(e).context("could not open settings file"),
    };

    if contents.trim().is_empty() {
        return Ok(AppSettings::default());
    }

    serde_json::from_str(&contents).context("could not parse settings file")
}

pub async fn write(settings: &AppSettings) -> Result<()> {
    let _guard = SETTINGS_LOCK.lock().await;
    let dir = get_home_app_dir().await?;

    write_to(&dir, settings).await
}

/// Rewrites the file whole, landing via write-temp + `rename` like the session
/// index does — a torn settings file would fail to parse on the next launch and
/// read as opted out, silently undoing whatever was just set.
async fn write_to(dir: &Path, settings: &AppSettings) -> Result<()> {
    let path = path_in(dir);
    let tmp = path.with_extension("json.tmp");

    fs::write(&tmp, serde_json::to_string_pretty(settings)?)
        .await
        .context("could not write settings file")?;

    if let Err(e) = fs::rename(&tmp, &path).await {
        // Or the next write inherits a stale temp file it never wrote.
        let _ = fs::remove_file(&tmp).await;
        return Err(e).context("could not replace settings file");
    }

    Ok(())
}

fn path_in(dir: &Path) -> PathBuf {
    dir.join("settings.json")
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
    async fn missing_file_reads_as_opted_in() {
        let dir = tempdir();

        assert!(read_from(&dir).await.unwrap().analytics_enabled);
    }

    #[tokio::test]
    async fn empty_file_reads_as_opted_in() {
        let dir = tempdir();
        std::fs::write(path_in(&dir), "   \n").unwrap();

        assert!(read_from(&dir).await.unwrap().analytics_enabled);
    }

    /// The direction that matters: a file someone opted out in, then corrupted,
    /// must not come back as opted in. `read_from` reports it as an error, and
    /// [`read`] turns any error into [`opted_out`].
    #[tokio::test]
    async fn unparseable_file_is_an_error_not_a_default() {
        let dir = tempdir();
        std::fs::write(path_in(&dir), "{ not json").unwrap();

        assert!(read_from(&dir).await.is_err());
        assert!(!opted_out().analytics_enabled);
    }

    #[tokio::test]
    async fn round_trips() {
        let dir = tempdir();
        let off = AppSettings {
            analytics_enabled: false,
            linear_account: None,
            transcription: TranscriptionSettings::default(),
        };

        write_to(&dir, &off).await.unwrap();

        assert_eq!(read_from(&dir).await.unwrap(), off);
    }

    /// An unknown field must not fail the read, or a file written by a newer
    /// build reads as opted out on every older one.
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
