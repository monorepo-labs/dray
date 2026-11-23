//! Which apps can open a path on Windows, and handing it to them.
//!
//! **Found at the paths their installers write**, from the [`KNOWN`] table's
//! `windows` column: `%LOCALAPPDATA%\Programs` for per-user installs, then
//! `%ProgramFiles%`. A `*` stands for one directory level and the newest name
//! wins, which is how a versioned JetBrains folder is found. The registry's
//! uninstall entries were the alternative and name an icon, not a program,
//! for half of these.
//!
//! **The address is the `.exe`**, and `open_in_app` launches only what the
//! last scan listed, keyed on it, as Linux does. The frontend names an app,
//! never a program.
//!
//! Every launch waits 1.5s, so a program refusing its arguments is an error
//! the button can show. A GUI program starts detached with no stdio. **A
//! console program (`cmd`, PowerShell, the login's Git Bash) starts through
//! `ShellExecuteExW` with `SW_SHOWNORMAL`**: it needs a console of its own,
//! the app's being hidden (`platform::hidden_console`), and one made by
//! `CreateProcess` with a blank show state came up minimized in Windows
//! Terminal, the default console host — measured with `cmd`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use super::{ExternalApp, ExternalAppKind, ICONS, KNOWN};

/// `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`: no console, and Ctrl-C in
/// Dray's never reaches it.
const DETACHED: u32 = 0x0000_0008 | 0x0000_0200;

/// What the last scan listed, by `.exe` path.
static LISTED: LazyLock<Mutex<HashMap<String, ExternalAppKind>>> = LazyLock::new(Default::default);

/// One environment variable a table path may open with.
fn expand(pattern: &str) -> Option<PathBuf> {
    let Some(rest) = pattern.strip_prefix('%') else { return Some(PathBuf::from(pattern)) };
    let (var, tail) = rest.split_once('%')?;
    let root = std::env::var_os(var).filter(|v| !v.is_empty())?;
    Some(PathBuf::from(root).join(tail.trim_start_matches('\\')))
}

/// The file a table path names, `*` matching one directory level with the
/// newest name taken. `None` where nothing is there.
fn find(pattern: &str) -> Option<PathBuf> {
    let path = expand(pattern)?;
    let mut found = vec![PathBuf::new()];
    for part in path.components() {
        let part = part.as_os_str().to_string_lossy();
        if let Some((head, tail)) = part.split_once('*') {
            found = found
                .into_iter()
                .flat_map(|dir| {
                    let entries = std::fs::read_dir(&dir).into_iter().flatten().flatten();
                    entries
                        .filter(|e| {
                            let name = e.file_name().to_string_lossy().to_lowercase();
                            name.starts_with(&head.to_lowercase()) && name.ends_with(&tail.to_lowercase())
                        })
                        .map(|e| e.path())
                        .collect::<Vec<_>>()
                })
                .collect();
            // Newest last by name, which versioned folders sort as.
            found.sort();
            found.reverse();
        } else {
            for dir in &mut found {
                dir.push(part.as_ref());
            }
        }
    }
    found.into_iter().find(|p| p.is_file())
}

/// Every [`KNOWN`] row found here, in the table's order, with no icons yet.
/// Split from [`detect`] so the order can be pinned by a test.
fn resolve(found: impl Fn(&str) -> Option<PathBuf>) -> Vec<ExternalApp> {
    let mut apps: Vec<ExternalApp> = Vec::new();
    for known in KNOWN {
        let Some(exe) = known.windows.iter().find_map(|p| found(p)) else { continue };
        let path = exe.to_string_lossy().into_owned();
        if apps.iter().any(|a| a.path == path) {
            continue;
        }
        apps.push(ExternalApp {
            path,
            name: known.name.to_string(),
            kind: known.kind,
            icon: None,
            folders: !known.files_only,
        });
    }
    apps
}

pub(super) fn detect() -> Vec<ExternalApp> {
    let mut apps = resolve(find);
    for app in &mut apps {
        app.icon = read_icon(Path::new(&app.path));
    }
    *LISTED.lock().unwrap_or_else(|e| e.into_inner()) = apps.iter().map(|a| (a.path.clone(), a.kind)).collect();
    apps
}

/// The program's file name, lowercased: what decides how it takes a path.
fn exe_name(exe: &Path) -> String {
    exe.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// How a terminal is started *at* a directory: its argv after the program,
/// and whether it needs a console of its own. The cwd is set as well, for
/// the ones that read nothing else.
///
/// **Windows Terminal and PowerShell never see the path**, only `.` or the
/// cwd: `wt` splits its whole command line on `;`, quoted or not, and NTFS
/// allows `;` in a folder name, so `-d C:\work\x;calc` opened a second tab
/// running `calc`.
fn terminal_args(exe: &Path, dir: &Path) -> (Vec<String>, bool) {
    let dir = dir.to_string_lossy().into_owned();
    match exe_name(exe).as_str() {
        "wt.exe" => (vec!["-d".into(), ".".into()], false),
        "pwsh.exe" => (vec!["-NoExit".into()], true),
        "powershell.exe" => (vec!["-NoExit".into()], true),
        "cmd.exe" => (vec!["/K".into()], true),
        "git-bash.exe" => (vec![format!("--cd={dir}")], false),
        "wezterm-gui.exe" => (vec!["start".into(), "--cwd".into(), dir], false),
        "alacritty.exe" => (vec!["--working-directory".into(), dir], false),
        _ => (Vec::new(), false),
    }
}

/// Hands `path` to the app the scan listed at `app_path`: a directory or a
/// file to an editor or Explorer, and a terminal started in the directory.
pub(super) async fn open_in_app(app_path: &str, path: &str) -> Result<(), String> {
    let listed = || LISTED.lock().unwrap_or_else(|e| e.into_inner()).get(app_path).copied();
    let kind = match listed() {
        Some(kind) => kind,
        None => {
            tokio::task::spawn_blocking(detect).await.ok();
            listed().ok_or_else(|| format!("{app_path} is no longer installed"))?
        }
    };
    let exe = Path::new(app_path);
    let target = Path::new(path);
    let dir = if target.is_dir() {
        target
    } else {
        target.parent().filter(|p| p.is_dir()).ok_or_else(|| format!("{path} does not exist"))?
    };
    let name = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let (args, console) = match kind {
        ExternalAppKind::Terminal => terminal_args(exe, dir),
        ExternalAppKind::Files => (vec![explorer_arg(target)], false),
        ExternalAppKind::Editor => (vec![path.to_string()], false),
    };
    spawn(exe, &args, dir, console, &name).await
}

/// What Explorer is handed, already quoted for its own command-line parser:
/// a folder to open, or a file to *select*. `explorer.exe <file>` opens the
/// file with its default program, which runs a `.bat` or `.ps1`.
fn explorer_arg(target: &Path) -> String {
    let quoted = quote_arg(&target.to_string_lossy());
    if target.is_dir() {
        quoted
    } else {
        format!("/select,{quoted}")
    }
}

/// Starts a program detached, waiting briefly so one refusing its arguments
/// is an error. Explorer answers 1 when it hands the window to a running
/// instance, which is every time, so its exit says nothing.
async fn spawn(exe: &Path, args: &[String], cwd: &Path, console: bool, name: &str) -> Result<(), String> {
    use std::process::Stdio;
    if console {
        let (exe, args, cwd, name) = (exe.to_path_buf(), args.to_vec(), cwd.to_path_buf(), name.to_string());
        return tokio::task::spawn_blocking(move || shell_execute(&exe, &args, &cwd, &name))
            .await
            .map_err(|e| e.to_string())?;
    }
    let explorer = exe_name(exe) == "explorer.exe";
    let mut cmd = tokio::process::Command::new(exe);
    // Explorer splits its own command line and reads `/select,"C:\a b"`
    // whole; std's quoting would wrap the switch in quotes and lose it.
    if explorer {
        for arg in args {
            cmd.raw_arg(arg);
        }
    } else {
        cmd.args(args);
    }
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED);
    let mut child = cmd.spawn().map_err(|err| format!("could not start {name}: {err}"))?;
    match tokio::time::timeout(Duration::from_millis(1500), child.wait()).await {
        Ok(Ok(status)) if !status.success() && !explorer => Err(format!("{name} failed ({status})")),
        Ok(_) => Ok(()),
        Err(_) => {
            tokio::spawn(async move { child.wait().await });
            Ok(())
        }
    }
}

/// A console program shown normally in a console of its own; see the module
/// note. Blocking: waits up to 1.5s for an early exit, as `spawn` does.
fn shell_execute(exe: &Path, args: &[String], cwd: &Path, name: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &OsStr| -> Vec<u16> { s.encode_wide().chain(Some(0)).collect() };
    let (file, dir) = (wide(exe.as_os_str()), wide(cwd.as_os_str()));
    let params = wide(OsStr::new(&args.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ")));
    let verb = wide(OsStr::new("open"));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.lpDirectory = dir.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(format!("could not start {name}: {}", std::io::Error::last_os_error()));
    }
    if info.hProcess.is_null() {
        return Ok(());
    }
    let mut code = 0u32;
    let exited = unsafe { WaitForSingleObject(info.hProcess, 1500) } == WAIT_OBJECT_0
        && unsafe { GetExitCodeProcess(info.hProcess, &mut code) } != 0;
    unsafe { CloseHandle(info.hProcess) };
    if exited && code != 0 {
        return Err(format!("{name} failed (exit code: {code})"));
    }
    Ok(())
}

/// One argument as `CommandLineToArgvW` reads it back: quoted where it holds
/// a space, a tab or a quote, with a quote and the backslashes before one
/// (or before the closing quote) escaped.
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from('"');
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// Git for Windows' `bash.exe`, which every agent here already runs under.
fn git_bash() -> Option<PathBuf> {
    // The first `git.exe` on `PATH` may be `mingw64\bin`'s, two levels down,
    // so every one is asked until one has a `bash.exe` beside its install.
    let beside_git = || {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path).find_map(|dir| {
            if !dir.join("git.exe").is_file() {
                return None;
            }
            dir.ancestors().skip(1).take(2).map(|git| git.join("bin").join("bash.exe")).find(|p| p.is_file())
        })
    };
    ["%ProgramFiles%\\Git\\bin\\bash.exe", "%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe"]
        .iter()
        .filter_map(|p| expand(p))
        .find(|p| p.is_file())
        .or_else(beside_git)
}

/// Runs one shell line in a console window of its own, through Git Bash: the
/// lines `run_in_terminal`'s callers compose are `/bin/sh`, and Git Bash is
/// what Claude Code needs on Windows anyway. The window waits for Enter, so
/// the login's last words stay readable.
pub(super) async fn run_in_terminal(command: &str, cwd: &str) -> Result<(), String> {
    let bash = git_bash().ok_or("Git Bash is not installed. Copy the command instead.")?;
    let dir = Some(PathBuf::from(cwd))
        .filter(|d| !cwd.is_empty() && d.is_dir())
        .or_else(std::env::home_dir)
        .unwrap_or_else(|| PathBuf::from("C:\\"));
    let enter = if cwd.is_empty() { String::new() } else { format!("cd {} || exit 1\n", super::sh_quote(cwd)) };
    let script = format!(
        "{enter}{command}\nstatus=$?\nrm -f -- \"$0\"\nprintf '\\n%s' \"Finished (exit $status). Press Enter to close.\"\nread _\n"
    );
    let path = std::env::temp_dir().join(format!("dray-login-{}.sh", uuid::Uuid::now_v7()));
    super::write_script(&path, &script).map_err(|err| format!("could not write the login script: {err}"))?;
    let args = vec!["-l".to_string(), path.to_string_lossy().into_owned()];
    let opened = spawn(&bash, &args, &dir, true, "Git Bash").await;
    if opened.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    opened
}

/// The program's own icon at 64px as a `data:` PNG, cached by path. `None`
/// for one with no icon to give, `wt.exe`'s alias among them, which the
/// button draws a glyph for.
fn read_icon(exe: &Path) -> Option<String> {
    if let Some(hit) = ICONS.lock().ok().and_then(|cache| cache.get(exe).cloned()) {
        return hit;
    }
    let icon = icon_png(exe).map(|bytes| {
        use base64::Engine as _;
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    });
    if let Ok(mut cache) = ICONS.lock() {
        cache.insert(exe.to_path_buf(), icon.clone());
    }
    icon
}

const ICON_SIZE: i32 = 64;

/// The first icon resource of `exe` drawn at [`ICON_SIZE`], read back as
/// BGRA and encoded as PNG. An icon with no alpha anywhere is an old one
/// that keeps its shape in the mask, which then decides what is opaque.
fn icon_png(exe: &Path) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO};

    let wide: Vec<u16> = OsStr::new(exe).encode_wide().chain(Some(0)).collect();
    let mut icon: HICON = std::ptr::null_mut();
    let got = unsafe {
        PrivateExtractIconsW(wide.as_ptr(), 0, ICON_SIZE, ICON_SIZE, &mut icon, std::ptr::null_mut(), 1, 0)
    };
    if got == 0 || got == u32::MAX || icon.is_null() {
        return None;
    }
    let mut info: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(icon, &mut info) } == 0 {
        unsafe { DestroyIcon(icon) };
        return None;
    }
    let side = ICON_SIZE as usize;
    let read = |bitmap| -> Option<Vec<u8>> {
        let mut header: BITMAPINFO = unsafe { std::mem::zeroed() };
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: ICON_SIZE,
            // Negative: rows top-down, as PNG wants them.
            biHeight: -ICON_SIZE,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..unsafe { std::mem::zeroed() }
        };
        let mut pixels = vec![0u8; side * side * 4];
        let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        let rows = unsafe {
            GetDIBits(dc, bitmap, 0, ICON_SIZE as u32, pixels.as_mut_ptr().cast(), &mut header, DIB_RGB_COLORS)
        };
        unsafe { DeleteDC(dc) };
        (rows == ICON_SIZE).then_some(pixels)
    };
    let color = (!info.hbmColor.is_null()).then(|| read(info.hbmColor)).flatten();
    let mask = (!info.hbmMask.is_null()).then(|| read(info.hbmMask)).flatten();
    unsafe {
        DeleteObject(info.hbmColor);
        DeleteObject(info.hbmMask);
        DestroyIcon(icon);
    }
    let mut pixels = color?;
    if pixels.chunks_exact(4).all(|p| p[3] == 0) {
        let mask = mask?;
        for (p, m) in pixels.chunks_exact_mut(4).zip(mask.chunks_exact(4)) {
            p[3] = if m[0] == 0 { 255 } else { 0 };
        }
    }
    for p in pixels.chunks_exact_mut(4) {
        p.swap(0, 2);
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, ICON_SIZE as u32, ICON_SIZE as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().ok()?.write_image_data(&pixels).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_star_takes_the_newest_folder() {
        let root = std::env::temp_dir().join(format!("dray-apps-{}", uuid::Uuid::now_v7()));
        for version in ["IntelliJ IDEA 2024.3", "IntelliJ IDEA 2025.2", "IntelliJ IDEA Community Edition 2025.2"] {
            let bin = root.join(version).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("idea64.exe"), b"").unwrap();
        }
        let pattern = format!("{}\\IntelliJ IDEA 2*\\bin\\idea64.exe", root.display());
        assert_eq!(find(&pattern), Some(root.join("IntelliJ IDEA 2025.2").join("bin").join("idea64.exe")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rows_come_in_table_order_and_once() {
        let found = |p: &str| {
            let hit = p.ends_with("Code.exe") || p.ends_with("explorer.exe") || p.ends_with("cmd.exe");
            hit.then(|| PathBuf::from(p))
        };
        let names: Vec<String> = resolve(found).into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["VS Code", "Command Prompt", "File Explorer"]);
    }

    #[test]
    fn arguments_quote_the_way_windows_splits_them() {
        assert_eq!(quote_arg("-NoExit"), "-NoExit");
        assert_eq!(quote_arg(r"C:\work\my repo"), r#""C:\work\my repo""#);
        assert_eq!(quote_arg(r"C:\work\my repo\"), r#""C:\work\my repo\\""#);
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_arg(""), r#""""#);
    }

    #[test]
    fn explorer_selects_a_file_and_opens_a_folder() {
        let dir = std::env::temp_dir().join(format!("dray apps {}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("run me.bat");
        std::fs::write(&file, b"").unwrap();
        assert_eq!(explorer_arg(&dir), format!("\"{}\"", dir.display()));
        assert_eq!(explorer_arg(&file), format!("/select,\"{}\"", file.display()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn terminals_start_in_the_directory() {
        let dir = Path::new("C:\\work\\repo");
        assert_eq!(terminal_args(Path::new("C:\\x\\wt.exe"), dir).0, ["-d", "."]);
        assert_eq!(terminal_args(Path::new("C:\\Git\\git-bash.exe"), dir).0, ["--cd=C:\\work\\repo"]);
        assert!(terminal_args(Path::new("C:\\Windows\\System32\\cmd.exe"), dir).1);
    }

    /// `wt` reads `;` as a command separator anywhere on its command line.
    #[test]
    fn a_folder_name_never_reaches_windows_terminal_or_powershell() {
        let dir = Path::new("C:\\work\\x;calc");
        for exe in ["C:\\x\\wt.exe", "C:\\x\\pwsh.exe", "C:\\x\\powershell.exe", "C:\\x\\cmd.exe"] {
            let (args, _) = terminal_args(Path::new(exe), dir);
            assert!(args.iter().all(|a| !a.contains(';')), "{exe}: {args:?}");
        }
    }
}
