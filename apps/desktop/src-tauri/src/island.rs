//! Dray Island on Linux: `apps/island-linux`'s binary, run as this app's
//! child (#833). Unlike the Mac's, it does not outlive the app: it holds the
//! read end of a pipe on its stdin and quits at EOF, which the kernel delivers
//! however the app goes — quit, crash or kill — with nothing to clean up.
//!
//! The key rides `island.json` under the XDG config dir, the Mac's `defaults`
//! domain's stand-in, which the island reads at every tap.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// The running island. Holding the `Child` holds its stdin open.
static ISLAND: Mutex<Option<Child>> = Mutex::new(None);

/// Writes the key and starts the island, or stops it for `off`. A build with
/// no island binary beside it only writes the key.
pub async fn configure(key: &str) -> Result<(), String> {
    if key != "off" {
        write_key(key).map_err(|err| format!("could not save the island key: {err}"))?;
    }
    let home = crate::store::get_home_app_dir().await.map_err(|err| err.to_string())?;
    let mut island = ISLAND.lock().unwrap_or_else(|e| e.into_inner());
    if key == "off" {
        if let Some(mut child) = island.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Ok(());
    }
    if let Some(child) = island.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    let Some(exe) = binary() else {
        return Ok(());
    };
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("island.log"))
        .map_err(|err| format!("could not open the island's log: {err}"))?;
    let mut command = Command::new(&exe);
    command
        .arg("--child")
        // The island finds its server through the home, so a dev build's
        // reaches the dev server.
        .env("DRAY_HOME", &home)
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|err| err.to_string())?)
        .stderr(log);
    // Off the AppImage's mount and its library paths, as the server is.
    if let Some(dir) = crate::serve::appimage_safe_cwd() {
        command.current_dir(dir);
    }
    for (key, value) in crate::serve::appimage_env_undo() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    let child = command.spawn().map_err(|err| format!("could not start Dray Island: {err}"))?;
    *island = Some(child);
    Ok(())
}

/// Beside the app's own binary, where a release will carry it; in a dev
/// build, the island crate's own target dir, since `tauri dev` builds the
/// app alone.
fn binary() -> Option<PathBuf> {
    let beside = std::env::current_exe().ok()?.parent()?.join("dray-island");
    if beside.exists() {
        return Some(beside);
    }
    if !crate::is_dev() {
        return None;
    }
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../island-linux/target");
    ["release", "debug"].into_iter().map(|profile| crate_dir.join(profile).join("dray-island")).find(|p| p.exists())
}

fn prefs_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::home_dir().map(|h| h.join(".config")))?;
    Some(base.join("dray/island.json"))
}

/// Rewrites `key` alone, keeping the placement the island wrote.
fn write_key(key: &str) -> std::io::Result<()> {
    let path = prefs_path().ok_or_else(|| std::io::Error::other("no home directory"))?;
    let mut prefs: serde_json::Map<String, serde_json::Value> = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if prefs.get("key").and_then(|v| v.as_str()) == Some(key) {
        return Ok(());
    }
    prefs.insert("key".into(), key.into());
    std::fs::create_dir_all(path.parent().expect("a file under a dir"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&prefs)?)?;
    std::fs::rename(tmp, path)
}
