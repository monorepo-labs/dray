//! Preferences Rust has to know before the frontend exists.
//!
//! Only one lives here, and timing is the whole reason: `app_started` is sent
//! from `setup`, so a preference kept in the webview's local storage — where
//! `ade.diffStyle` and every other pick lives — could not be consulted until
//! after the one event it governs had already gone. **Anything the frontend can
//! read for itself belongs there, not here**, or this file becomes a second
//! settings store free to disagree with the first.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{fs, sync::Mutex};
use ts_rs::TS;

use crate::store::get_home_app_dir;

/// Serializes writers. The file is rewritten whole, so a concurrent writer
/// would drop the other's field — same bargain `projects.json` makes.
static SETTINGS_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Opted in by default, and the default is what a missing file reads as.
    /// The event carries no identifier and no properties, and the dialog says
    /// so — see the analytics section in CLAUDE.md.
    #[serde(default = "enabled_by_default")]
    pub analytics_enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            analytics_enabled: enabled_by_default(),
        }
    }
}

/// Reads `settings.json`. A missing, empty or unparseable file reads as the
/// defaults rather than an error: this is consulted on the launch path, and a
/// file someone hand-edited badly must not be able to stop the app starting.
pub async fn read() -> AppSettings {
    match read_inner().await {
        Ok(settings) => settings,
        Err(e) => {
            eprintln!("[settings read err] {e:#}");
            AppSettings::default()
        }
    }
}

async fn read_inner() -> Result<AppSettings> {
    let path = get_home_app_dir().await?.join("settings.json");

    let contents = match fs::read_to_string(path).await {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AppSettings::default()),
        Err(e) => return Err(e).context("could not open settings file"),
    };

    if contents.trim().is_empty() {
        return Ok(AppSettings::default());
    }

    Ok(serde_json::from_str(&contents)?)
}

/// Rewrites the file whole, landing via write-temp + `rename` like the session
/// index does — a torn settings file would be read as the defaults on the next
/// launch, silently undoing whatever was just set.
pub async fn write(settings: &AppSettings) -> Result<()> {
    let _guard = SETTINGS_LOCK.lock().await;

    let path = get_home_app_dir().await?.join("settings.json");
    let tmp = path.with_extension("json.tmp");

    fs::write(&tmp, serde_json::to_string_pretty(settings)?)
        .await
        .context("could not write settings file")?;
    fs::rename(&tmp, &path)
        .await
        .context("could not replace settings file")?;

    Ok(())
}
