//! The `dray` CLI the bundle carries as `Contents/MacOS/dray-cli`
//! (tauri.cli.conf.json), put where agents and shells find it.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// Copies the bundled CLI to `~/.local/bin/dray` where the bytes there differ,
/// then has it write its skill. Every launch of a release build, off the main
/// thread; dev and debug builds skip it, since the CLI on disk belongs to the
/// release app.
///
/// A copy, never a symlink into the bundle: App Translocation runs a first
/// launch from a path gone once the app quits, and a moved or deleted app
/// breaks a link too, where the CLI must keep working with the app closed.
pub fn install() {
    if tauri::is_dev() || cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn_blocking(|| {
        if let Err(e) = install_bundled() {
            eprintln!("[cli install] {e}");
        }
    });
}

fn install_bundled() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("no exe path: {e}"))?;
    // Absent from a bundle built without the CLI overlay, which is every
    // local `tauri build`.
    let Ok(bundled) = std::fs::read(exe.with_file_name("dray-cli")) else {
        return Ok(());
    };
    let home = std::env::home_dir().ok_or("no home directory")?;
    let dest = home.join(".local/bin/dray");
    if !copy_if_changed(&bundled, &dest).map_err(|e| format!("{}: {e}", dest.display()))? {
        return Ok(());
    }
    let status = Command::new(&dest)
        .args(["skill", "install"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("could not run {}: {e}", dest.display()))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("dray skill install failed ({status})"))
}

/// Writes `bytes` to `dest` unless it holds them already, answering whether it
/// wrote.
///
/// Bytes rather than `--version`: the CLI's version moves only with a `cli-v*`
/// tag, so two app releases can carry different CLIs under one number. Written
/// out rather than `fs::copy`, which on macOS carries xattrs, quarantine
/// included. Renamed into place, never rewritten in place: the kernel caches a
/// binary's signature by vnode and kills one whose pages no longer match it.
fn copy_if_changed(bytes: &[u8], dest: &Path) -> std::io::Result<bool> {
    if std::fs::read(dest).is_ok_and(|on_disk| on_disk == bytes) {
        return Ok(false);
    }
    let dir = dest.parent().expect("dest names a file in a directory");
    std::fs::create_dir_all(dir)?;
    // Per process, since an `open -n` relaunch can run two of these at once.
    let tmp = dir.join(format!(".dray.{}", std::process::id()));
    let written = std::fs::write(&tmp, bytes)
        .and_then(|()| std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)))
        .and_then(|()| std::fs::rename(&tmp, dest));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map(|()| true)
}

#[cfg(test)]
mod tests {
    use super::copy_if_changed;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn copies_only_what_differs_and_leaves_it_executable() {
        let dir = std::env::temp_dir().join(format!("dray-cli-test-{}", std::process::id()));
        let dest = dir.join("bin/dray");

        assert!(copy_if_changed(b"one", &dest).unwrap(), "absent: written");
        assert!(!copy_if_changed(b"one", &dest).unwrap(), "same bytes: left alone");
        assert!(copy_if_changed(b"two", &dest).unwrap(), "different bytes: replaced");

        assert_eq!(std::fs::read(&dest).unwrap(), b"two");
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        // Nothing left behind beside it.
        assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
