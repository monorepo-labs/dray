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

/// Whether the island this app started is still up, so a waiting card goes
/// to it rather than to a banner. Reaps one that exited, which also lets the
/// next launch start a fresh one.
pub fn running() -> bool {
    let mut island = ISLAND.lock().unwrap_or_else(|e| e.into_inner());
    match island.as_mut().map(Child::try_wait) {
        Some(Ok(None)) => true,
        Some(_) => {
            *island = None;
            false
        }
        None => false,
    }
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

fn write_key(key: &str) -> std::io::Result<()> {
    write_field("key", key)
}

/// Rewrites one field alone, keeping the rest the island wrote. The island
/// rewrites the same file, so both hold `island.json.lock` from the read to
/// the rename, or one could save over the other's field.
fn write_field(name: &str, value: &str) -> std::io::Result<()> {
    let path = prefs_path().ok_or_else(|| std::io::Error::other("no home directory"))?;
    std::fs::create_dir_all(path.parent().expect("a file under a dir"))?;
    let lock = std::fs::File::create(path.with_extension("json.lock"))?;
    lock.lock()?;
    let mut prefs = read_prefs(&path);
    if prefs.get(name).and_then(|v| v.as_str()) == Some(value) {
        return Ok(());
    }
    prefs.insert(name.into(), value.into());
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(&prefs)?)?;
    std::fs::rename(tmp, path)
}

fn read_prefs(path: &std::path::Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// Settings' island picks that apply here, in the Mac's names, which is what
/// Settings reads: the Mac's `notch` is the top of the screen. An absent one
/// is the island's default.
pub fn prefs() -> std::collections::HashMap<String, String> {
    prefs_path().map(|path| settings_view(&read_prefs(&path))).unwrap_or_default()
}

fn settings_view(file: &serde_json::Map<String, serde_json::Value>) -> std::collections::HashMap<String, String> {
    let field = |name: &str| file.get(name).and_then(|v| v.as_str()).map(str::to_string);
    let mut out = std::collections::HashMap::new();
    if let Some(p) = field("placement") {
        out.insert("island.placement".into(), if p == "bottom" { "bottom" } else { "notch" }.into());
    }
    if let Some(m) = field("mode") {
        out.insert("island.mode".into(), m);
    }
    out
}

/// Writes a Settings pick the Linux island reads, and has a running one show
/// it, as the Mac's does: placement and layout are only judged on screen.
pub fn set_pref(name: &str, value: &str) -> Result<(), String> {
    let Some((field, value)) = file_field(name, value) else {
        return Err(format!("not an island setting here: {name} = {value}"));
    };
    write_field(field, value).map_err(|err| format!("could not save the island setting: {err}"))?;
    send("prefs");
    Ok(())
}

/// A Settings pick as the field `island.json` holds, where the Linux island
/// reads one; `None` for the Mac's alone.
fn file_field<'a>(name: &str, value: &'a str) -> Option<(&'static str, &'a str)> {
    match (name, value) {
        ("island.placement", "notch") => Some(("placement", "top")),
        ("island.placement", "bottom") => Some(("placement", "bottom")),
        ("island.mode", "expanded" | "compact") => Some(("mode", value)),
        _ => None,
    }
}

/// A finished session, for the island's done pill.
pub fn done(session_id: &str) -> Result<(), String> {
    if send(&format!("done {session_id}")) { Ok(()) } else { Err("Dray Island isn't running".into()) }
}

/// One line down the pipe the island holds as its stdin, which it reads
/// for these besides waiting on its end. Answers whether it was written.
fn send(line: &str) -> bool {
    use std::io::Write;
    let mut island = ISLAND.lock().unwrap_or_else(|e| e.into_inner());
    let Some(stdin) = island.as_mut().and_then(|child| child.stdin.as_mut()) else { return false };
    stdin.write_all(format!("{line}\n").as_bytes()).and_then(|()| stdin.flush()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{file_field, settings_view};

    #[test]
    fn settings_names_map_onto_the_islands_file_and_back() {
        assert_eq!(file_field("island.placement", "notch"), Some(("placement", "top")));
        assert_eq!(file_field("island.mode", "compact"), Some(("mode", "compact")));
        // The Mac's alone: the Linux island has no such pick.
        assert_eq!(file_field("island.tap", "double"), None);
        assert_eq!(file_field("island.transcript", "hidden"), None);
        let file = serde_json::json!({ "placement": "top", "mode": "compact", "key": "option" });
        let view = settings_view(file.as_object().unwrap());
        assert_eq!(view.get("island.placement").map(String::as_str), Some("notch"));
        assert_eq!(view.get("island.mode").map(String::as_str), Some("compact"));
        assert_eq!(view.len(), 2);
    }
}
