//! The `dray` CLI the bundle carries as `dray-cli` beside the app's binary
//! (tauri.cli.conf.json) — `Contents/MacOS` on a Mac, the AppImage's `usr/bin`
//! on Linux, the install folder on Windows — put where agents and shells find
//! it.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Copies the bundled CLI to `~/.local/bin/dray` (`dray.exe` on Windows) where
/// the bytes there differ, then has it write its skill. Every launch of a release build, off the main
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
    let suffix = std::env::consts::EXE_SUFFIX;
    let Ok(bundled) = std::fs::read(exe.with_file_name(format!("dray-cli{suffix}"))) else {
        return Ok(());
    };
    let home = std::env::home_dir().ok_or("no home directory")?;
    let bin = home.join(".local").join("bin");
    let dest = bin.join(format!("dray{suffix}"));
    copy_if_changed(&bundled, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    #[cfg(any(target_os = "linux", windows))]
    if let Err(e) = record_appimage(&home) {
        eprintln!("[cli install] {APPIMAGE_RECORD}: {e}");
    }
    // A Mac or Linux shell has ~/.local/bin on PATH already, or the reader put
    // it there for Claude Code; a Windows one has it only where Claude Code's
    // own installer ran.
    #[cfg(windows)]
    if let Err(e) = user_path::ensure(&bin) {
        eprintln!("[cli install] user PATH: {e}");
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

/// Where the Linux app writes down the AppImage it runs from, or its binary
/// where a `.deb` installed it, under home; the Windows app, its own `.exe`.
/// `app_ships_this_cli` in apps/cli/src/setup.rs and install.sh read it.
#[cfg(any(target_os = "linux", windows))]
const APPIMAGE_RECORD: &str = ".local/share/dray/appimage";

/// Records which AppImage or package installed the CLI, so `dray update` and
/// install.sh leave alone a `dray` the app would put back on its next launch —
/// a Mac's app is found at fixed paths, an AppImage can live anywhere. The
/// path, not a flag: one deleted or uninstalled since frees the CLI to update
/// itself, and one moved is written again by its next launch.
#[cfg(any(target_os = "linux", windows))]
fn record_appimage(home: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    let installed = {
        use tauri::utils::{config::BundleType, platform::bundle_type};
        crate::serve::appimage().or_else(|| {
            (bundle_type() == Some(BundleType::Deb)).then(std::env::current_exe).and_then(Result::ok)
        })
    };
    // Read back as UTF-8 by the CLI, the one form both sides can spell.
    #[cfg(windows)]
    let installed = std::env::current_exe().ok().filter(|p| p.to_str().is_some());
    let Some(image) = installed else {
        return Ok(());
    };
    let record = home.join(APPIMAGE_RECORD);
    #[cfg(target_os = "linux")]
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(image.as_os_str());
    #[cfg(windows)]
    let bytes = image.to_str().expect("filtered to UTF-8 above").as_bytes();
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
        .and_then(|()| make_executable(&tmp))
        .and_then(|()| replace(&tmp, dest));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map(|()| true)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(windows)]
fn make_executable(_: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

/// Windows refuses to rename over an `.exe` that is running — a `dray` an
/// agent is in the middle of — but will rename the running one itself. So it
/// moves aside first, and is deleted once nothing runs it: now, or by a later
/// launch's sweep.
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    let dir = to.parent().expect("names a file in a directory");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".dray.old.") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let aside = dir.join(format!(".dray.old.{}", std::process::id()));
    let moved = to.exists() && std::fs::rename(to, &aside).is_ok();
    if let Err(e) = std::fs::rename(from, to) {
        if moved {
            let _ = std::fs::rename(&aside, to);
        }
        return Err(e);
    }
    if moved {
        let _ = std::fs::remove_file(&aside);
    }
    Ok(())
}

/// The reader's own `PATH`, which Windows keeps in the registry under
/// `HKCU\Environment` rather than in any shell's rc file.
#[cfg(windows)]
mod user_path {
    use std::path::Path;
    use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, REG_SZ, RegCloseKey,
        RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    };
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };

    /// Appends `dir` to the user `PATH` unless an entry already names it, and
    /// tells running programs so: Explorer then hands the new `PATH` to every
    /// terminal opened after, where an already-open one keeps its own.
    pub fn ensure(dir: &Path) -> Result<(), String> {
        ensure_in("Environment", dir).map(|changed| {
            if changed {
                broadcast();
            }
        })
    }

    /// [`ensure`] against any subkey of `HKCU`, answering whether it wrote.
    pub(super) fn ensure_in(subkey: &str, dir: &Path) -> Result<bool, String> {
        let dir = dir.to_str().ok_or("the folder's path is not UTF-16 clean")?;
        let key = Key::open(subkey)?;
        let (current, kind) = key.read("Path")?;
        let Some(next) = with_entry(&current, dir, expand) else {
            return Ok(false);
        };
        key.write("Path", &next, kind)?;
        Ok(true)
    }

    /// `path` with `dir` appended, or `None` where an entry names it already,
    /// compared as Windows would: case aside, `%VARS%` expanded, a trailing
    /// separator ignored.
    pub(super) fn with_entry(path: &str, dir: &str, expand: impl Fn(&str) -> String) -> Option<String> {
        let norm = |s: &str| expand(s.trim()).trim_end_matches(['\\', '/']).to_lowercase();
        let want = norm(dir);
        if path.split(';').any(|entry| norm(entry) == want) {
            return None;
        }
        let kept = path.trim_end_matches(';');
        Some(if kept.is_empty() { dir.to_string() } else { format!("{kept};{dir}") })
    }

    fn expand(s: &str) -> String {
        let src = wide(s);
        let mut buf = vec![0u16; 32_768];
        // SAFETY: both buffers live across the call and `buf`'s length is passed.
        let n = unsafe { ExpandEnvironmentStringsW(src.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
        if n == 0 || n as usize > buf.len() {
            return s.to_string();
        }
        String::from_utf16_lossy(&buf[..n as usize - 1])
    }

    fn broadcast() {
        let what = wide("Environment");
        let mut result = 0usize;
        // SAFETY: `what` outlives the call, which copies it across processes.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                what.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Key(HKEY);

    impl Key {
        fn open(subkey: &str) -> Result<Self, String> {
            let name = wide(subkey);
            let mut key: HKEY = std::ptr::null_mut();
            // SAFETY: `name` is NUL-terminated and `key` is written on success.
            let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, name.as_ptr(), 0, KEY_READ | KEY_WRITE, &mut key) };
            if rc != 0 {
                return Err(format!("could not open HKCU\\{subkey} ({rc})"));
            }
            Ok(Self(key))
        }

        /// The value as stored, `%VARS%` unexpanded, and its type. An absent
        /// value reads as empty, to be written as `REG_EXPAND_SZ` like the
        /// one Windows makes.
        fn read(&self, value: &str) -> Result<(String, u32), String> {
            let name = wide(value);
            let (mut kind, mut size) = (0u32, 0u32);
            // SAFETY: a null data pointer asks for the size alone.
            let rc = unsafe {
                RegQueryValueExW(self.0, name.as_ptr(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size)
            };
            if rc == ERROR_FILE_NOT_FOUND {
                return Ok((String::new(), REG_EXPAND_SZ));
            }
            if rc != 0 {
                return Err(format!("could not read {value} ({rc})"));
            }
            if kind != REG_SZ && kind != REG_EXPAND_SZ {
                return Err(format!("{value} is not a string (type {kind})"));
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2)];
            // SAFETY: `buf` holds `size` bytes, the length just reported.
            let rc = unsafe {
                RegQueryValueExW(
                    self.0,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    buf.as_mut_ptr().cast(),
                    &mut size,
                )
            };
            if rc != 0 {
                return Err(format!("could not read {value} ({rc})"));
            }
            buf.truncate((size as usize) / 2);
            while buf.last() == Some(&0) {
                buf.pop();
            }
            Ok((String::from_utf16_lossy(&buf), kind))
        }

        fn write(&self, value: &str, data: &str, kind: u32) -> Result<(), String> {
            let name = wide(value);
            let data = wide(data);
            // SAFETY: `data` is NUL-terminated and its byte length is passed.
            let rc = unsafe {
                RegSetValueExW(self.0, name.as_ptr(), 0, kind, data.as_ptr().cast(), (data.len() * 2) as u32)
            };
            if rc != 0 {
                return Err(format!("could not write {value} ({rc})"));
            }
            Ok(())
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: opened by `Key::open`, closed once here.
            unsafe { RegCloseKey(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::copy_if_changed;

    #[test]
    fn copies_only_what_differs() {
        let dir = std::env::temp_dir().join(format!("dray-cli-test-{}", std::process::id()));
        let dest = dir.join("bin").join("dray");

        assert!(copy_if_changed(b"one", &dest).unwrap(), "absent: written");
        assert!(!copy_if_changed(b"one", &dest).unwrap(), "same bytes: left alone");
        assert!(copy_if_changed(b"two", &dest).unwrap(), "different bytes: replaced");

        assert_eq!(std::fs::read(&dest).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        // Nothing left behind beside it.
        assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A `dray` an agent is running holds its file open, which is what the
    /// move-aside in `replace` gets past.
    #[cfg(windows)]
    #[test]
    fn replaces_a_running_exe() {
        let dir = std::env::temp_dir().join(format!("dray-cli-run-{}", std::process::id()));
        let dest = dir.join("dray.exe");
        let ping = std::env::var("SystemRoot").unwrap() + r"\System32\PING.EXE";
        copy_if_changed(&std::fs::read(&ping).unwrap(), &dest).unwrap();
        let mut running = std::process::Command::new(&dest)
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();

        let outcome = copy_if_changed(b"new", &dest);
        running.kill().unwrap();
        running.wait().unwrap();

        assert!(outcome.unwrap());
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        // The old file, freed now, goes on the next replace.
        copy_if_changed(b"newer", &dest).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    mod user_path {
        use super::super::user_path::{ensure_in, with_entry};
        use std::path::Path;

        fn no_vars(s: &str) -> String {
            s.replace("%USERPROFILE%", r"C:\Users\me")
        }

        #[test]
        fn appends_a_missing_folder() {
            let next = with_entry(r"C:\a;C:\b", r"C:\Users\me\.local\bin", no_vars);
            assert_eq!(next.as_deref(), Some(r"C:\a;C:\b;C:\Users\me\.local\bin"));
            assert_eq!(with_entry("", r"C:\x", no_vars).as_deref(), Some(r"C:\x"));
            assert_eq!(with_entry(r"C:\a;", r"C:\x", no_vars).as_deref(), Some(r"C:\a;C:\x"));
        }

        #[test]
        fn leaves_a_folder_named_any_way() {
            let dir = r"C:\Users\me\.local\bin";
            for path in [
                r"C:\a;c:\users\ME\.local\bin",
                r"C:\Users\me\.local\bin\;C:\a",
                r"%USERPROFILE%\.local\bin",
                r" C:\Users\me\.local\bin ",
            ] {
                assert_eq!(with_entry(path, dir, no_vars), None, "{path}");
            }
        }

        /// The registry half, against a scratch key rather than the reader's
        /// own `PATH`.
        #[test]
        fn writes_the_registry_once() {
            let sub = format!("Software\\DrayTest\\cli-{}", std::process::id());
            let status = std::process::Command::new("reg")
                .args(["add", &format!("HKCU\\{sub}"), "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", r"%SystemRoot%;C:\a", "/f"])
                .output()
                .unwrap()
                .status;
            assert!(status.success());

            let dir = Path::new(r"C:\dray-test\bin");
            assert!(ensure_in(&sub, dir).unwrap(), "missing: written");
            assert!(!ensure_in(&sub, dir).unwrap(), "present: left alone");

            let out = std::process::Command::new("reg")
                .args(["query", &format!("HKCU\\{sub}"), "/v", "Path"])
                .output()
                .unwrap();
            let out = String::from_utf8_lossy(&out.stdout).into_owned();
            let _ = std::process::Command::new("reg").args(["delete", r"HKCU\Software\DrayTest", "/f"]).output();
            assert!(out.contains("REG_EXPAND_SZ"), "{out}");
            assert!(out.contains(r"%SystemRoot%;C:\a;C:\dray-test\bin"), "{out}");
        }
    }
}
