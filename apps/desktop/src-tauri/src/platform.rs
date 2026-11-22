//! What Unix and Windows spell differently: whether a pid lives, killing one,
//! owner-only modes, the host name and the effective user; and on Windows the
//! user `PATH` and replacing a running `.exe`.

use std::path::Path;

/// Whether `pid` names a live process. On Unix `EPERM` counts as alive: a
/// process owned by another user is still a process.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    imp::pid_alive(pid)
}

/// Kills `pid` outright: `SIGKILL`, or `TerminateProcess` on Windows. A pid
/// already gone is not an error.
pub fn kill(pid: u32) {
    imp::kill(pid)
}

/// Keeps a console child from opening a console window of its own, which every
/// one does under a GUI app with no console to inherit.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Kills `pid` and every process under it, which Unix gets from a process
/// group and Windows has to ask `taskkill` for.
#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// `tokio::fs::canonicalize`, minus the `\\?\` prefix Windows puts on every
/// answer. Left on, a project read `\\?\C:\work\demo` and matched no path
/// git or a reader writes. `dunce::canonicalize` is the same for sync code.
pub async fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<std::path::PathBuf> {
    tokio::fs::canonicalize(path).await.map(|real| dunce::simplified(&real).to_path_buf())
}

/// Sets Unix permission bits. A no-op on Windows, where a file under the
/// user's profile is already readable by that user and administrators alone.
pub fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    imp::set_mode(path, mode)
}

/// The permission bits, or `0o700` on Windows, which has none to read and
/// whose profile directories are private by default.
pub fn mode(meta: &std::fs::Metadata) -> u32 {
    imp::mode(meta)
}

/// Whether this process runs as root. Never on Windows, where the question
/// Chromium's sandbox asks has no equivalent.
pub fn is_root() -> bool {
    imp::is_root()
}

/// The machine's host name, empty where it cannot be read.
pub fn hostname() -> String {
    imp::hostname()
}

/// Gives a process with no console a hidden one, for its console children to
/// share. The release app is a GUI binary, so it and its `--serve` start with
/// none, and every `git`, `gh` or agent they ran then opened a console window
/// of its own. Keeps the stdout and stderr it was started with, the server's
/// log. A dev build is a console binary and already has one.
#[cfg(windows)]
pub fn hidden_console() {
    use windows_sys::Win32::System::Console::{
        AllocConsole, GetConsoleWindow, GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    /// `ALLOC_CONSOLE_OPTIONS`, which windows-sys does not spell yet.
    #[repr(C)]
    struct Options {
        mode: i32,
        use_show_window: i32,
        show_window: u16,
    }
    const ALLOC_CONSOLE_MODE_NO_WINDOW: i32 = 2;
    type AllocWithOptions = unsafe extern "system" fn(*const Options, *mut i32) -> i32;

    // SAFETY: plain Win32 calls; the looked-up symbol is called with the
    // signature Microsoft documents for it.
    unsafe {
        if !GetConsoleWindow().is_null() {
            return;
        }
        let (out, err) = (GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE));
        // Windows 11 24H2 and Server 2025 make one with no window at all.
        // Looked up, since naming it would stop the app loading on older ones.
        let kernel32 = GetModuleHandleA(c"kernel32.dll".as_ptr().cast());
        let made = match GetProcAddress(kernel32, c"AllocConsoleWithOptions".as_ptr().cast()) {
            Some(found) => {
                let alloc: AllocWithOptions = std::mem::transmute(found);
                let options = Options { mode: ALLOC_CONSOLE_MODE_NO_WINDOW, use_show_window: 0, show_window: 0 };
                let mut result = 0;
                alloc(&options, &mut result) >= 0
            }
            None => false,
        };
        // Older Windows: an ordinary console, hidden as soon as it exists.
        if !made && AllocConsole() != 0 {
            let window = GetConsoleWindow();
            if !window.is_null() {
                ShowWindow(window, SW_HIDE);
            }
        }
        SetStdHandle(STD_OUTPUT_HANDLE, out);
        SetStdHandle(STD_ERROR_HANDLE, err);
    }
}

/// Windows refuses to rename over an `.exe` that is running — a `dray` an
/// agent is in the middle of — but will rename the running one itself. So it
/// moves aside first, and is deleted once nothing runs it: now, or by
/// [`sweep_aside`] at a later launch.
#[cfg(windows)]
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub fn replace_running(from: &Path, to: &Path) -> std::io::Result<()> {
    let dir = to.parent().expect("names a file in a directory");
    // Unique past pid reuse: an aside a reused pid left running would
    // otherwise block this rename.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let aside = dir.join(format!("{ASIDE}{}.{stamp}", std::process::id()));
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

/// What [`replace_running`] names a file it moved aside.
#[cfg(windows)]
const ASIDE: &str = ".dray.old.";

/// Deletes what [`replace_running`] moved aside in `dir` and nothing runs any
/// more. One still running stays for the next sweep.
#[cfg(windows)]
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub fn sweep_aside(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(ASIDE) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The reader's own `PATH`, which Windows keeps in the registry under
/// `HKCU\Environment` rather than in any shell's rc file.
#[cfg(windows)]
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub mod user_path {
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

#[cfg(unix)]
mod imp {
    use std::path::Path;

    pub fn pid_alive(pid: u32) -> bool {
        // SAFETY: signal 0 delivers nothing; it only checks the pid.
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    pub fn kill(pid: u32) {
        // SAFETY: plain signal delivery.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }

    pub fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }

    pub fn mode(meta: &std::fs::Metadata) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    }

    pub fn is_root() -> bool {
        // SAFETY: no arguments, no failure mode.
        unsafe { libc::geteuid() == 0 }
    }

    pub fn hostname() -> String {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is writable for its whole length.
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
            return String::new();
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    }
}

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    pub fn pid_alive(pid: u32) -> bool {
        // SAFETY: the handle is checked and closed; the out pointer is a local.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                // Access denied still means a process holds the pid.
                return std::io::Error::last_os_error().raw_os_error() == Some(5);
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            ok && code == STILL_ACTIVE as u32
        }
    }

    pub fn kill(pid: u32) {
        // SAFETY: the handle is checked and closed.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }

    pub fn set_mode(_: &Path, _: u32) -> std::io::Result<()> {
        Ok(())
    }

    pub fn mode(_: &std::fs::Metadata) -> u32 {
        0o700
    }

    pub fn is_root() -> bool {
        false
    }

    pub fn hostname() -> String {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    /// What cli.rs does: a temp file beside, renamed over the target.
    fn put(dir: &std::path::Path, dest: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
        let tmp = dir.join(".dray.tmp");
        std::fs::write(&tmp, bytes)?;
        super::replace_running(&tmp, dest)
    }

    /// A `dray` an agent is running holds its file open, which is what the
    /// move-aside in `replace_running` gets past.
    #[test]
    fn replaces_a_running_exe() {
        let dir = std::env::temp_dir().join(format!("dray-cli-run-{}", std::process::id()));
        let dest = dir.join("dray.exe");
        let ping = std::env::var("SystemRoot").unwrap() + r"\System32\PING.EXE";
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(&ping, &dest).unwrap();
        let mut running = std::process::Command::new(&dest)
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();

        let outcome = put(&dir, &dest, b"new");
        running.kill().unwrap();
        running.wait().unwrap();

        outcome.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        // The old file, freed now, goes at the next sweep.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "moved aside while running");
        super::sweep_aside(&dir);
        put(&dir, &dest, b"newer").unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    mod user_path {
        use crate::platform::user_path::{ensure_in, with_entry};
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
