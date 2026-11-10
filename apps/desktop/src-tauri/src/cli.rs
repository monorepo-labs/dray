//! The `dray` CLI the bundle carries as `dray-cli` beside the app's binary
//! (tauri.cli.conf.json) — `Contents/MacOS` on a Mac, the AppImage's `usr/bin`
//! on Linux — put where agents and shells find it.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
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
    tauri::async_runtime::spawn(async {
        let shell = crate::binpath::shell_dray().await;
        let done = tauri::async_runtime::spawn_blocking(move || install_bundled(shell)).await;
        if let Ok(Err(e)) = done {
            eprintln!("[cli install] {e}");
        }
    });
}

fn install_bundled(shell: Option<PathBuf>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("no exe path: {e}"))?;
    // Absent from a bundle built without the CLI overlay, which is every
    // local `tauri build`.
    let Ok(bundled) = std::fs::read(exe.with_file_name("dray-cli")) else {
        return Ok(());
    };
    let home = std::env::home_dir().ok_or("no home directory")?;
    let dest = home.join(".local/bin/dray");
    copy_if_changed(&bundled, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    #[cfg(target_os = "linux")]
    if let Err(e) = record_appimage(&home) {
        eprintln!("[cli install] {APPIMAGE_RECORD}: {e}");
    }

    // A CLI installed elsewhere with `DRAY_INSTALL_DIR` sits ahead of this copy
    // on the reader's PATH, and would keep answering stale. A symlink is left
    // alone: somebody pointed it at a build of their own on purpose.
    if let Some(shell) = shell.filter(|p| *p != dest && is_plain_dray(p)) {
        if let Err(e) = copy_if_changed(&bundled, &shell) {
            eprintln!("[cli install] {}: {e}", shell.display());
        }
    }

    // Every launch, not only after a copy: a failed write would otherwise
    // never be retried, the bytes matching from then on.
    let status = command(&dest)
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

/// A regular file answering `--version` the way Dray's CLI does — the name is
/// generic enough for something else on PATH to carry it.
fn is_plain_dray(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
        && command(path)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|out| out.status.success() && out.stdout.starts_with(b"dray "))
}

/// A command for a CLI binary, without what an AppImage's AppRun added to
/// this process's environment for its own libraries.
fn command(path: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(path);
    #[cfg(target_os = "linux")]
    for (key, value) in crate::serve::appimage_env_undo() {
        match value {
            Some(value) => cmd.env(key, value),
            None => cmd.env_remove(key),
        };
    }
    cmd
}

/// Where the Linux app writes down the AppImage it runs from, under home.
/// `app_on_this_machine` in apps/cli/src/setup.rs and install.sh read it.
#[cfg(target_os = "linux")]
const APPIMAGE_RECORD: &str = ".local/share/dray/appimage";

/// Records which AppImage installed the CLI, so `dray update` and install.sh
/// leave alone a `dray` the app would put back on its next launch — a Mac's
/// app is found at fixed paths, an AppImage can live anywhere. The path, not
/// a flag: one deleted since frees the CLI to update itself, and one moved is
/// written again by its next launch.
#[cfg(target_os = "linux")]
fn record_appimage(home: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let Some(image) = crate::serve::appimage() else {
        return Ok(());
    };
    let record = home.join(APPIMAGE_RECORD);
    let bytes = image.as_os_str().as_bytes();
    if std::fs::read(&record).is_ok_and(|on_disk| on_disk == bytes) {
        return Ok(());
    }
    std::fs::create_dir_all(record.parent().expect("record names a file in a directory"))?;
    std::fs::write(&record, bytes)
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
