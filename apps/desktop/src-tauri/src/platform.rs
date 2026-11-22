//! What Unix and Windows spell differently: whether a pid lives, killing one,
//! owner-only modes, the host name and the effective user.

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
