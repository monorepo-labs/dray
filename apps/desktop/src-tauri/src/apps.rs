//! Which apps on this machine can open a path — a session's working directory
//! from the right panel's split button, or one file from a transcript row.
//!
//! macOS reads `.app` bundles and hands paths over with `open(1)`; Linux reads
//! `.desktop` files and runs their `Exec` ([`linux`]). Both draw from one
//! [`KNOWN`] table. Any other platform answers an empty list.

#[cfg(target_os = "linux")]
mod linux;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{LazyLock, Mutex},
};

use serde::Serialize;
use ts_rs::TS;

use crate::harness::Harness;

/// Which run of the menu an app belongs to. Not cosmetic: "open in Cursor" and
/// "open in Ghostty" are different asks, and a flat list of both reads as one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum ExternalAppKind {
    Editor,
    Terminal,
    /// Finder. Its own kind rather than an editor, because it is the entry
    /// every machine has and the one the reader falls back to.
    Files,
}

/// An installed app a path can be handed to.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ExternalApp {
    /// The bundle's absolute path, and the app's address everywhere else here.
    ///
    /// Deliberately not a bundle identifier. `open -b` hands the id to Launch
    /// Services, which picks whichever copy it has indexed — so a second
    /// install of an editor, or a stale index, silently opens the wrong one.
    /// The scan found this bundle by path; the path is what it knows.
    pub path: String,
    pub name: String,
    pub kind: ExternalAppKind,
    /// The app's own icon as a `data:` PNG, or `None` where none could be read.
    /// Absent is ordinary — a bundle can keep its icon in an asset catalog with
    /// no `.icns` beside it — so the button falls back to a glyph rather than
    /// treating this as a failure.
    pub icon: Option<String>,
    /// Takes a directory as well as a file. False for the editors that open
    /// files alone — GNOME Text Editor and gedit answer a folder with "Could
    /// not open file" — so the directory button leaves them out.
    pub folders: bool,
}

/// One row of the curated table: where the app is found on each platform, what
/// to call it, and which run it sits in.
struct Known {
    /// The macOS bundle's file name, matched **exactly**, never as a substring.
    /// `Cloudflare WARP.app` is not `Warp.app`, and a contains-check lists it
    /// as a terminal that then ignores the directory. `None` for an app Dray
    /// only knows on Linux.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    bundle: Option<&'static str>,
    /// Linux `.desktop` file ids, tried before [`Known::bins`]: distro, Flatpak
    /// and Snap packages each name the same app differently.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    desktop: &'static [&'static str],
    /// Linux executables, for a `.desktop` file whose `Exec` names one and for
    /// an install with no `.desktop` at all.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    bins: &'static [&'static str],
    name: &'static str,
    kind: ExternalAppKind,
    /// How a Linux terminal takes a directory and a command, which no
    /// `.desktop` file says.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    term: Term,
    /// See [`ExternalApp::folders`].
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    files_only: bool,
}

/// A Linux terminal's argv for "start in this directory" and "run this".
#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct Term {
    /// Flag before the directory, joined to it where it ends in `=`. `None`
    /// leaves the directory to the process's own cwd, which xterm reads.
    pub dir: Option<&'static str>,
    /// Flag before the command. `Some("")` is a terminal taking the command
    /// as its positional arguments; `None` is one Dray cannot ask to run one.
    pub exec: Option<&'static str>,
}

const NO_TERM: Term = Term { dir: None, exec: None };

const fn editor(bundle: &'static str, name: &'static str) -> Known {
    Known { bundle: Some(bundle), desktop: &[], bins: &[], name, kind: ExternalAppKind::Editor, term: NO_TERM, files_only: false }
}

const fn terminal(bundle: &'static str, name: &'static str) -> Known {
    Known { bundle: Some(bundle), desktop: &[], bins: &[], name, kind: ExternalAppKind::Terminal, term: NO_TERM, files_only: false }
}

const fn linux(kind: ExternalAppKind, name: &'static str) -> Known {
    Known { bundle: None, desktop: &[], bins: &[], name, kind, term: NO_TERM, files_only: false }
}

impl Known {
    const fn on_linux(mut self, desktop: &'static [&'static str], bins: &'static [&'static str]) -> Self {
        self.desktop = desktop;
        self.bins = bins;
        self
    }

    const fn files_only(mut self) -> Self {
        self.files_only = true;
        self
    }

    const fn args(mut self, dir: Option<&'static str>, exec: Option<&'static str>) -> Self {
        self.term = Term { dir, exec };
        self
    }
}

use ExternalAppKind::{Editor as E, Files as F, Terminal as T};

/// The apps this menu knows how to hand a path to, in the order drawn.
///
/// Curated rather than discovered, and the curation *is* the guarantee: every
/// entry here takes a directory as `open -a <bundle> <dir>`, and every
/// [`ExternalAppKind::Editor`] takes a single file the same way — which is what
/// a filename in the transcript is handed to. Reading each found
/// bundle's `CFBundleDocumentTypes` for `public.folder` was the alternative and
/// it is the wrong gate — `open -a` names the app outright rather than asking
/// Launch Services to rank handlers, so it reaches apps that declare nothing
/// (MacVim declares no folder type and opens one fine). Gating on the
/// declaration would hide apps that work. Linux reads the same way: a
/// `.desktop` file's `MimeType=` is not the gate, the table is.
///
/// An app absent from this table costs one entry, never the list.
const KNOWN: &[Known] = &[
    editor("Visual Studio Code.app", "VS Code")
        .on_linux(&["code.desktop", "com.visualstudio.code.desktop", "code_code.desktop"], &["code"]),
    editor("Visual Studio Code - Insiders.app", "VS Code Insiders")
        .on_linux(&["code-insiders.desktop", "com.visualstudio.code.insiders.desktop"], &["code-insiders"]),
    editor("Cursor.app", "Cursor").on_linux(&["cursor.desktop", "cursor_cursor.desktop"], &["cursor"]),
    editor("Windsurf.app", "Windsurf").on_linux(&["windsurf.desktop"], &["windsurf"]),
    editor("Zed.app", "Zed").on_linux(&["dev.zed.Zed.desktop", "zed.desktop"], &["zed", "zeditor"]),
    editor("Zed Preview.app", "Zed Preview").on_linux(&["dev.zed.Zed-Preview.desktop"], &[]),
    editor("Sublime Text.app", "Sublime Text")
        .on_linux(&["sublime_text.desktop", "com.sublimetext.three.desktop"], &["subl"]),
    editor("Nova.app", "Nova"),
    editor("BBEdit.app", "BBEdit"),
    editor("Xcode.app", "Xcode"),
    editor("IntelliJ IDEA.app", "IntelliJ IDEA")
        .on_linux(&["jetbrains-idea.desktop", "com.jetbrains.IntelliJ-IDEA-Ultimate.desktop"], &[]),
    editor("IntelliJ IDEA CE.app", "IntelliJ IDEA CE")
        .on_linux(&["jetbrains-idea-ce.desktop", "com.jetbrains.IntelliJ-IDEA-Community.desktop"], &[]),
    editor("WebStorm.app", "WebStorm").on_linux(&["jetbrains-webstorm.desktop"], &[]),
    editor("PyCharm.app", "PyCharm").on_linux(&["jetbrains-pycharm.desktop"], &[]),
    editor("PyCharm CE.app", "PyCharm CE")
        .on_linux(&["jetbrains-pycharm-ce.desktop", "com.jetbrains.PyCharm-Community.desktop"], &[]),
    editor("GoLand.app", "GoLand").on_linux(&["jetbrains-goland.desktop"], &[]),
    editor("RustRover.app", "RustRover").on_linux(&["jetbrains-rustrover.desktop"], &[]),
    editor("CLion.app", "CLion").on_linux(&["jetbrains-clion.desktop"], &[]),
    editor("PhpStorm.app", "PhpStorm").on_linux(&["jetbrains-phpstorm.desktop"], &[]),
    editor("RubyMine.app", "RubyMine").on_linux(&["jetbrains-rubymine.desktop"], &[]),
    editor("DataGrip.app", "DataGrip").on_linux(&["jetbrains-datagrip.desktop"], &[]),
    editor("Android Studio.app", "Android Studio")
        .on_linux(&["android-studio.desktop", "jetbrains-studio.desktop"], &["android-studio"]),
    editor("VimR.app", "VimR"),
    editor("MacVim.app", "MacVim"),
    linux(E, "Kate").on_linux(&["org.kde.kate.desktop"], &["kate"]),
    linux(E, "Text Editor").on_linux(&["org.gnome.TextEditor.desktop"], &["gnome-text-editor"]).files_only(),
    linux(E, "gedit").on_linux(&["org.gnome.gedit.desktop"], &["gedit"]).files_only(),
    linux(E, "GVim").on_linux(&["gvim.desktop", "org.vim.Vim.desktop"], &["gvim"]),
    linux(E, "Emacs").on_linux(&["emacs.desktop", "org.gnu.emacs.desktop"], &["emacs"]),
    terminal("Ghostty.app", "Ghostty")
        .on_linux(&["com.mitchellh.ghostty.desktop"], &["ghostty"])
        .args(Some("--working-directory="), Some("-e")),
    terminal("iTerm.app", "iTerm"),
    terminal("Warp.app", "Warp").on_linux(&["dev.warp.Warp.desktop"], &["warp-terminal"]),
    terminal("WezTerm.app", "WezTerm")
        .on_linux(&["org.wezfurlong.wezterm.desktop"], &["wezterm"])
        .args(Some("start --cwd"), Some("--")),
    terminal("Terminal.app", "Terminal"),
    linux(T, "Kitty").on_linux(&["kitty.desktop"], &["kitty"]).args(Some("--directory"), Some("")),
    linux(T, "Alacritty")
        .on_linux(&["Alacritty.desktop", "alacritty.desktop", "org.alacritty.Alacritty.desktop"], &["alacritty"])
        .args(Some("--working-directory"), Some("-e")),
    linux(T, "Ptyxis")
        .on_linux(&["org.gnome.Ptyxis.desktop"], &["ptyxis"])
        .args(Some("--new-window --working-directory="), Some("--")),
    linux(T, "Console").on_linux(&["org.gnome.Console.desktop"], &["kgx"]).args(Some("--working-directory="), Some("-e")),
    linux(T, "GNOME Terminal")
        .on_linux(&["org.gnome.Terminal.desktop"], &["gnome-terminal"])
        .args(Some("--working-directory="), Some("--")),
    linux(T, "Konsole").on_linux(&["org.kde.konsole.desktop"], &["konsole"]).args(Some("--workdir"), Some("-e")),
    linux(T, "Xfce Terminal")
        .on_linux(&["xfce4-terminal.desktop"], &["xfce4-terminal"])
        .args(Some("--working-directory="), Some("-x")),
    linux(T, "Tilix").on_linux(&["com.gexperts.Tilix.desktop"], &["tilix"]).args(Some("--working-directory="), Some("-e")),
    linux(T, "Terminator")
        .on_linux(&["terminator.desktop"], &["terminator"])
        .args(Some("--working-directory="), Some("-x")),
    linux(T, "foot")
        .on_linux(&["org.codeberg.dnkl.foot.desktop", "foot.desktop"], &["foot"])
        .args(Some("--working-directory="), Some("")),
    linux(T, "XTerm").on_linux(&["xterm.desktop", "debian-xterm.desktop"], &["xterm"]).args(None, Some("-e")),
    // Linux's stand-ins for Finder. One is listed, the reader's default where
    // it is one of these — see `linux::detect`.
    linux(F, "Files").on_linux(&["org.gnome.Nautilus.desktop"], &["nautilus"]),
    linux(F, "Nemo").on_linux(&["nemo.desktop"], &["nemo"]),
    linux(F, "Dolphin").on_linux(&["org.kde.dolphin.desktop"], &["dolphin"]),
    linux(F, "Thunar").on_linux(&["thunar.desktop", "Thunar.desktop"], &["thunar"]),
    linux(F, "Caja").on_linux(&["caja.desktop", "caja-browser.desktop"], &["caja"]),
    linux(F, "PCManFM").on_linux(&["pcmanfm.desktop"], &["pcmanfm"]),
];

/// Finder, which is in none of the scanned directories and on every mac.
#[cfg_attr(target_os = "linux", allow(dead_code))]
const FINDER: &str = "/System/Library/CoreServices/Finder.app";

/// Where a `.app` bundle lives. One `read_dir` each and no `mdfind`: Spotlight
/// can be off or still indexing, and the common case is an app that is not
/// installed at all — where a per-app query is a spawn that answers nothing.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        // Setapp keeps its own subfolder under /Applications.
        PathBuf::from("/Applications/Setapp"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    // Where JetBrains Toolbox and per-user installs land.
    if let Some(home) = std::env::home_dir() {
        dirs.push(home.join("Applications"));
    }
    dirs
}

/// Bundle file name to its path, for every `.app` in `dirs`.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn installed(dirs: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut found = HashMap::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".app") {
                continue;
            }
            // First directory wins, so a machine-wide install outranks the
            // user's own copy — the order Launch Services itself prefers.
            found.entry(name).or_insert_with(|| entry.path());
        }
    }
    found
}

/// Icons cost two spawns each, so they are read once per bundle path and held
/// for the life of the process. Keyed by path, so an app that moves is read
/// again rather than drawn with the old one.
static ICONS: LazyLock<Mutex<HashMap<PathBuf, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The `.icns` a bundle names as its icon.
///
/// `CFBundleIconFile` may or may not carry the extension, so both spellings are
/// tried; `AppIcon` is the fallback for a bundle that names none.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn icns_path(bundle: &Path) -> Option<PathBuf> {
    let resources = bundle.join("Contents/Resources");

    let named = Command::new("plutil")
        .args(["-extract", "CFBundleIconFile", "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|name| !name.is_empty());

    named
        .into_iter()
        .chain(std::iter::once("AppIcon".to_string()))
        .flat_map(|name| {
            let with_ext = if name.ends_with(".icns") {
                name.clone()
            } else {
                format!("{name}.icns")
            };
            [resources.join(with_ext), resources.join(name)]
        })
        .find(|path| path.is_file())
}

/// The bundle's icon as a `data:` PNG, read through `sips` — on every mac, and
/// the only thing here that turns an `.icns` into something a webview draws.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn read_icon(bundle: &Path) -> Option<String> {
    if let Ok(cache) = ICONS.lock() {
        if let Some(hit) = cache.get(bundle) {
            return hit.clone();
        }
    }

    let icon = icns_path(bundle).and_then(|icns| {
        // A temp file rather than stdout: `sips` writes the paths it worked on
        // to stdout and only ever writes the image to a path.
        let out = std::env::temp_dir().join(format!("dray-appicon-{}.png", uuid::Uuid::now_v7()));
        let ok = Command::new("sips")
            .args(["-s", "format", "png", "-Z", "64"])
            .arg(&icns)
            .arg("--out")
            .arg(&out)
            .output()
            .is_ok_and(|done| done.status.success());

        let bytes = ok.then(|| std::fs::read(&out).ok()).flatten();
        let _ = std::fs::remove_file(&out);

        bytes.map(|bytes| {
            use base64::Engine as _;
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        })
    });

    if let Ok(mut cache) = ICONS.lock() {
        cache.insert(bundle.to_path_buf(), icon.clone());
    }
    icon
}

/// Every known app in `installed`, in [`KNOWN`]'s order, then Finder — with no
/// icons yet. Split from [`detect`] so the order can be pinned by a test that
/// spawns nothing.
///
/// Finder sits at the end rather than the front on purpose: it is the entry
/// every machine has, so leading with it puts the least specific answer where
/// the eye lands first.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn resolve(installed: &HashMap<String, PathBuf>, finder: &Path) -> Vec<ExternalApp> {
    let mut apps: Vec<ExternalApp> = KNOWN
        .iter()
        .filter_map(|known| {
            let path = installed.get(known.bundle?)?;
            Some(ExternalApp {
                path: path.to_string_lossy().into_owned(),
                name: known.name.to_string(),
                kind: known.kind,
                icon: None,
                folders: true,
            })
        })
        .collect();

    if finder.is_dir() {
        apps.push(ExternalApp {
            path: finder.to_string_lossy().into_owned(),
            name: "Finder".to_string(),
            kind: ExternalAppKind::Files,
            icon: None,
            folders: true,
        });
    }

    apps
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
fn detect() -> Vec<ExternalApp> {
    let mut apps = resolve(&installed(&search_dirs()), Path::new(FINDER));
    for app in &mut apps {
        app.icon = read_icon(Path::new(&app.path));
    }
    apps
}

/// The apps that can open a path on this machine.
///
/// Re-scanned on every call rather than held for the process: the walk is a
/// handful of `read_dir`s, and only the icons are dear enough to cache — so an
/// editor installed while Dray is running shows up the next time the panel
/// asks, instead of needing a restart the way the slash-command cache does.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_open_apps() -> Vec<ExternalApp> {
    #[cfg(target_os = "linux")]
    let detect = linux::detect;
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return Vec::new();
    }
    tokio::task::spawn_blocking(detect)
        .await
        .unwrap_or_default()
}

/// Hands `path` to the app at `app_path`.
///
/// `open -a <bundle> <path>` and not `open -b <id>`, for [`ExternalApp::path`]'s
/// reason. A directory or a file alike: `open -a` names the app outright, and
/// Launch Services hands it whichever the path is. Nothing here reaches a
/// shell, so injection is not the risk — but a path whose name opens with `-`
/// parses as a flag, which `--` ends.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn open_in_app(app_path: String, path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::open_in_app(&app_path, &path).await;
    #[allow(unreachable_code)]
    let out = tokio::process::Command::new("open")
        .arg("-a")
        .arg(&app_path)
        .arg("--")
        .arg(&path)
        .output()
        .await
        .map_err(|err| format!("could not run open: {err}"))?;

    if out.status.success() {
        return Ok(());
    }

    // `open`'s own sentence names the cure — a moved bundle, a directory that
    // is gone — where the exit code names nothing.
    Err(crate::git::stderr_or(&out, || format!("could not open {path}")))
}

/// Writes the modifier that opens Dray Island (`control`, `option`, `command`)
/// into the island's own preferences, which it reads at every tap, and starts it
/// to match — or quits it, for `off`.
///
/// Its own defaults domain rather than `settings.json`, since the island is the
/// one that reads it. `open` without `-n` is a no-op for an island already up,
/// and it outlives Dray on purpose: it talks to the background server, which
/// does too — so the launch also pings it, and an island left on a binary an
/// update replaced restarts onto the new one. A build with no island inside it
/// (`tauri dev`) only writes the pick. On Linux the island is the app's child
/// instead, and quits with it: see `island.rs`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn configure_island(key: String) -> Result<(), String> {
    if !matches!(key.as_str(), "control" | "option" | "command" | "off") {
        return Err(format!("unknown island key {key}"));
    }
    #[cfg(all(feature = "desktop", target_os = "linux"))]
    return crate::island::configure(&key).await;
    #[cfg(not(all(feature = "desktop", target_os = "linux")))]
    configure_mac_island(key).await
}

#[cfg(not(all(feature = "desktop", target_os = "linux")))]
async fn configure_mac_island(key: String) -> Result<(), String> {
    use tokio::process::Command;
    async fn run(cmd: &mut Command) -> Result<std::process::Output, String> {
        cmd.output().await.map_err(|err| format!("could not configure the island: {err}"))
    }
    run(Command::new("defaults").args(["write", "com.yogesh.dray.island", "island.key", "-string", &key])).await?;
    if key == "off" {
        // Exit 1 is "nothing running", which is what was asked for.
        run(Command::new("pkill").args(["-x", "Dray Island"])).await?;
        return Ok(());
    }
    let Some(app) = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("Helpers/Dray Island.app")))
        .filter(|app| app.exists())
    else {
        return Ok(());
    };
    let mut open = Command::new("open");
    open.arg("-g");
    // The island finds its server through the home, so a moved one must ride along.
    if let Some(home) = crate::store::home_override() {
        open.arg("--env").arg(format!("DRAY_HOME={}", home.display()));
    }
    let out = run(open.arg(&app)).await?;
    if out.status.success() {
        run(Command::new("notifyutil").args(["-p", "com.yogesh.dray.island.update"])).await?;
        return Ok(());
    }
    Err(crate::git::stderr_or(&out, || "could not start Dray Island".into()))
}

/// The session Dray's window has open, which the island opens on when tapped
/// over a frontmost Dray. Held here since the island asks through the server,
/// and the server can only ask the app's Rust side.
static APP_SELECTION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The frontend reports its selection on every change; `None` is no session open.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_app_selection(session_id: Option<String>) {
    *APP_SELECTION.lock().unwrap_or_else(|e| e.into_inner()) = session_id;
}

pub fn app_selection() -> Option<String> {
    APP_SELECTION.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Seconds since the last key or pointer input anywhere on this desktop. The
/// break clock reads it because the browser pane is a native view whose input
/// never reaches the webview's document. `None` where the OS cannot say:
/// Windows, or Linux without an X display or libXss.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn idle_seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        }
        // Combined session state, any input event type; needs no permission.
        return Some(unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) });
    }
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    return x11_idle::seconds();
    #[allow(unreachable_code)]
    None
}

/// The XScreenSaver extension's idle time, on a display connection of its own.
///
/// Both libraries are opened at run time rather than linked: libXss is not a
/// library every desktop has, and linked it would stop the app starting where
/// it is missing. x11-dl would do the opening but asks for `libXss.so.2`, a
/// soname no distribution ships, and `libXss.so` exists only with the dev
/// package.
#[cfg(all(target_os = "linux", feature = "desktop"))]
mod x11_idle {
    use std::ffi::{c_char, c_int, c_ulong, c_void, CStr};
    use std::sync::{Mutex, OnceLock};

    #[repr(C)]
    struct Info {
        window: c_ulong,
        state: c_int,
        kind: c_int,
        til_or_since: c_ulong,
        /// Milliseconds.
        idle: c_ulong,
        event_mask: c_ulong,
    }

    type Query = unsafe extern "C" fn(*mut c_void, c_ulong, *mut Info) -> c_int;

    struct Xss {
        display: *mut c_void,
        root: c_ulong,
        info: *mut Info,
        query: Query,
    }

    // SAFETY: the display is this module's own connection, never handed to
    // GDK, and only touched under the mutex.
    unsafe impl Send for Xss {}

    /// Opened once; a failure is remembered, since nothing makes it succeed later.
    static XSS: OnceLock<Option<Mutex<Xss>>> = OnceLock::new();

    pub fn seconds() -> Option<f64> {
        let xss = XSS.get_or_init(|| unsafe { open() }.map(Mutex::new)).as_ref()?;
        let xss = xss.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: all three came from `open`, which checked each.
        let ok = unsafe { (xss.query)(xss.display, xss.root, xss.info) } != 0;
        ok.then(|| unsafe { (*xss.info).idle } as f64 / 1000.0)
    }

    unsafe fn sym<T: Copy>(lib: *mut c_void, name: &CStr) -> Option<T> {
        let p = unsafe { libc::dlsym(lib, name.as_ptr()) };
        // SAFETY: `T` is the C signature the symbol is declared with.
        (!p.is_null()).then(|| unsafe { std::mem::transmute_copy(&p) })
    }

    unsafe fn open() -> Option<Xss> {
        let flags = libc::RTLD_NOW | libc::RTLD_LOCAL;
        let x11 = unsafe { libc::dlopen(c"libX11.so.6".as_ptr(), flags) };
        let xss = unsafe { libc::dlopen(c"libXss.so.1".as_ptr(), flags) };
        if x11.is_null() || xss.is_null() {
            return None;
        }
        unsafe {
            let open_display: unsafe extern "C" fn(*const c_char) -> *mut c_void =
                sym(x11, c"XOpenDisplay")?;
            let root_of: unsafe extern "C" fn(*mut c_void) -> c_ulong = sym(x11, c"XDefaultRootWindow")?;
            let has_ext: unsafe extern "C" fn(*mut c_void, *mut c_int, *mut c_int) -> c_int =
                sym(xss, c"XScreenSaverQueryExtension")?;
            let alloc: unsafe extern "C" fn() -> *mut Info = sym(xss, c"XScreenSaverAllocInfo")?;
            let query: Query = sym(xss, c"XScreenSaverQueryInfo")?;

            let display = open_display(std::ptr::null());
            if display.is_null() {
                return None;
            }
            let (mut event_base, mut error_base) = (0, 0);
            if has_ext(display, &mut event_base, &mut error_base) == 0 {
                return None;
            }
            let info = alloc();
            if info.is_null() {
                return None;
            }
            Some(Xss { display, root: root_of(display), info, query })
        }
    }
}

/// Whether Dray Island is running, asked at each permission or question so a
/// island the reader quit never swallows the banner that would have replaced it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn island_running() -> bool {
    #[cfg(all(feature = "desktop", target_os = "linux"))]
    return crate::island::running();
    #[cfg(not(all(feature = "desktop", target_os = "linux")))]
    tokio::process::Command::new("pgrep")
        .args(["-x", "Dray Island"])
        .output()
        .await
        .is_ok_and(|out| out.status.success())
}

/// Hands a session to Dray Island's done pill, which shows it in place of the
/// banner: a finished one, or with `note`, what it says instead of "Done" — a
/// bot's "2 tasks waiting on you". A Darwin notification carries no payload,
/// so each event is a file named for its session in `island_done_dir`, holding the
/// note: the island deletes only the files it read, where a shared list read
/// and then cleared would drop one written between the two.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn island_done(session_id: String, note: Option<String>) -> Result<(), String> {
    // The id names a file, so nothing that could step out of the directory.
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("not a session id".into());
    }
    // Linux's island is this app's child, and hears it on the pipe it holds.
    // It has no note to draw, so a noted one is refused and the banner goes.
    #[cfg(all(feature = "desktop", target_os = "linux"))]
    return match note {
        None => crate::island::done(&session_id),
        Some(_) => Err("Dray Island here shows finished sessions alone".into()),
    };
    #[cfg(not(all(feature = "desktop", target_os = "linux")))]
    island_done_mac(session_id, note.unwrap_or_default()).await
}

#[cfg(not(all(feature = "desktop", target_os = "linux")))]
async fn island_done_mac(session_id: String, note: String) -> Result<(), String> {
    let dir = island_done_dir().ok_or("no home directory")?;
    tokio::fs::create_dir_all(&dir).await.map_err(|err| format!("could not reach the island: {err}"))?;
    // Written beside the inbox and moved in whole, so the island never reads a
    // note half-written and takes it for an empty file, a finished turn.
    // One file per event, `<id>.<n>`: a finish and a notice for one chat can
    // overlap, and sharing a name, one would replace the other unread.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let name = format!("{session_id}.{stamp}-{n}");
    let tmp = dir.with_file_name(&name);
    let reach = |err: std::io::Error| format!("could not reach the island: {err}");
    tokio::fs::write(&tmp, note).await.map_err(reach)?;
    tokio::fs::rename(&tmp, dir.join(&name)).await.map_err(reach)?;
    tokio::process::Command::new("notifyutil").args(["-p", "com.yogesh.dray.island.done"]).output().await.ok();
    Ok(())
}

/// The island's inbox for finished sessions; `Delegate.doneDir` in the island names it too.
#[cfg(not(all(feature = "desktop", target_os = "linux")))]
fn island_done_dir() -> Option<std::path::PathBuf> {
    Some(std::env::home_dir()?.join("Library/Caches/com.yogesh.dray.island/done"))
}

/// The island preferences Settings draws. The island's own right-click menu
/// writes the first three as well (a pinch writes the transcript too), so they
/// are read back rather than kept here, and `captureTaken` is the island's
/// alone: the chord it could not register.
#[cfg(not(all(feature = "desktop", target_os = "linux")))]
const ISLAND_PREFS: [&str; 6] =
    ["island.placement", "island.mode", "island.transcript", "island.tap", "island.captureKey", "island.captureTaken"];

fn island_pref_valid(name: &str, value: &str) -> bool {
    match name {
        "island.placement" => matches!(value, "notch" | "bottom"),
        "island.mode" => matches!(value, "compact" | "expanded"),
        "island.transcript" => matches!(value, "shown" | "hidden"),
        "island.tap" => matches!(value, "single" | "double"),
        // A Carbon key code and modifier mask, or none.
        "island.captureKey" => {
            value == "none" || matches!(value.split_once(' '), Some((k, m)) if k.parse::<u32>().is_ok() && m.parse::<u32>().is_ok())
        }
        _ => false,
    }
}

/// The island's stored picks, by name; an absent one is the island's default.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn island_prefs() -> std::collections::HashMap<String, String> {
    #[cfg(all(feature = "desktop", target_os = "linux"))]
    return crate::island::prefs();
    #[cfg(not(all(feature = "desktop", target_os = "linux")))]
    island_prefs_mac().await
}

#[cfg(not(all(feature = "desktop", target_os = "linux")))]
async fn island_prefs_mac() -> std::collections::HashMap<String, String> {
    let reads = ISLAND_PREFS.map(|name| async move {
        let out = tokio::process::Command::new("defaults")
            .args(["read", "com.yogesh.dray.island", name])
            .output()
            .await
            .ok()
            .filter(|out| out.status.success())?;
        Some((name.to_string(), String::from_utf8_lossy(&out.stdout).trim().to_string()))
    });
    futures_util::future::join_all(reads).await.into_iter().flatten().collect()
}

/// Writes one island pick and tells a running island to read it again, through a
/// Darwin notification: it caches the picks, and holds its capture key.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_island_pref(name: String, value: String) -> Result<(), String> {
    if !island_pref_valid(&name, &value) {
        return Err(format!("not an island setting: {name} = {value}"));
    }
    #[cfg(all(feature = "desktop", target_os = "linux"))]
    return crate::island::set_pref(&name, &value);
    #[cfg(not(all(feature = "desktop", target_os = "linux")))]
    set_island_pref_mac(name, value).await
}

#[cfg(not(all(feature = "desktop", target_os = "linux")))]
async fn set_island_pref_mac(name: String, value: String) -> Result<(), String> {
    use tokio::process::Command;
    let out = Command::new("defaults")
        .args(["write", "com.yogesh.dray.island", &name, "-string", &value])
        .output()
        .await
        .map_err(|err| format!("could not save the island setting: {err}"))?;
    if !out.status.success() {
        return Err(crate::git::stderr_or(&out, || "could not save the island setting".into()));
    }
    // An island that is not running reads the file when it starts. Position and
    // layout, and the transcript, are only judged on screen, so those open the panel to show them.
    let ping = match name.as_str() {
        "island.placement" | "island.mode" | "island.transcript" => "com.yogesh.dray.island.show",
        _ => "com.yogesh.dray.island.prefs",
    };
    Command::new("notifyutil").args(["-p", ping]).output().await.ok();
    Ok(())
}

#[cfg(test)]
mod island_pref_tests {
    use super::island_pref_valid;

    #[test]
    fn takes_only_what_the_island_can_read() {
        assert!(island_pref_valid("island.placement", "bottom"));
        assert!(island_pref_valid("island.captureKey", "19 768"));
        assert!(island_pref_valid("island.captureKey", "none"));
        assert!(!island_pref_valid("island.captureKey", "19"));
        assert!(!island_pref_valid("island.mode", "voice"));
        assert!(!island_pref_valid("island.tap", "triple"));
        assert!(!island_pref_valid("island.key", "control"));
    }
}

/// Terminal.app, and never the terminal the reader picked in the panel beside
/// this.
///
/// Measured, because `open` reports nothing either way: handed a `.command`
/// file, Terminal.app runs it, while Ghostty and Warp accept the open, exit 0
/// and run nothing at all. Ghostty wants `open -na <bundle> --args -e <cmd>`
/// and every other terminal its own argv, so honouring the pick means a second
/// table — and the [`KNOWN`] one above promises only `open -a <bundle> <dir>`,
/// which is a different shape from this. A button that silently does nothing
/// on two of the five terminals that table lists is worse than one that always
/// works, the same reading `pick_file_opener` takes with Finder.
///
/// Every mac has it, so there is no case where this resolves to nothing.
const TERMINAL: &str = "/System/Applications/Utilities/Terminal.app";

/// Opens a terminal at `cwd` running the harness's login command.
///
/// No shell string crosses the bridge: the caller names a [`Harness`] and the
/// command is composed here, from the resolved binary and
/// [`Harness::login_args`]. Same reading `permissions.rs` takes — the rule
/// never leaves Rust, so nothing the frontend holds can widen it.
///
/// The mechanism is a throwaway `.command` script rather than
/// `osascript -e 'tell application "Terminal" to do script …'`, which needs
/// macOS Automation permission: that prompts, can be denied, and a denial is
/// silent. A `.command` file needs no permission at all.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn open_login_terminal(harness: Harness, cwd: String) -> Result<(), String> {
    let binary = crate::binpath::agent_binary(harness).await;
    let mut command = sh_quote(&binary.to_string_lossy());
    for arg in harness.login_args() {
        command.push(' ');
        command.push_str(arg);
    }

    run_in_terminal(&command, &cwd).await
}

/// Runs one shell line in a terminal at `cwd`: Terminal.app on a Mac, the
/// reader's own on Linux.
///
/// **The caller owns what is in that line**, and every one of them composes it
/// from a closed set — this harness's [`Harness::login_args`], or an
/// [`crate::accounts::AuthOption`] whose command is a literal in that table,
/// or an agent's own updater from `agent_updates::update_args`.
/// Nothing a frontend typed may reach here: the string is written into a shell
/// script, so the safety is in where it came from and not in any escaping this
/// could do to it.
pub(crate) async fn run_in_terminal(command: &str, cwd: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::run_in_terminal(command, cwd).await;
    #[allow(unreachable_code)]
    if !cfg!(target_os = "macos") {
        return Err("Opening a terminal needs macOS or Linux. Copy the command instead.".to_string());
    }

    // Terminal runs a `.command` from the reader's home, not from the script's
    // own directory, so the `cd` is what puts the login in the session's tree.
    // Omitted where there is no directory to name — the Accounts tab is reached
    // with no session selected — since `cd ''` fails and would take the command
    // with it. Self-delete last: a reader who closes the window mid-login leaks
    // one file into a temp dir macOS reaps on its own.
    let enter = if cwd.is_empty() {
        String::new()
    } else {
        format!("cd {} || exit 1\n", sh_quote(cwd))
    };
    let script = format!("#!/bin/sh\n{enter}{command}\nrm -f -- \"$0\"\n");

    let path = std::env::temp_dir().join(format!("dray-login-{}.command", uuid::Uuid::now_v7()));
    write_script(&path, &script)
        .map_err(|err| format!("could not write the login script: {err}"))?;

    let opened = open_in_app(TERMINAL.to_string(), path.to_string_lossy().into_owned()).await;
    if opened.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    opened
}

/// Writes the script at `0700` on the *create*, never by a `chmod` after.
///
/// Same reading the tracker key's own write records (`issues.rs`): `fs::write`
/// creates at the process umask, so any other order leaves a window where the
/// file is world-readable — and this one is also world-*executable*, which is a
/// file Terminal will run. `create_new` beside it because a leftover from a
/// crashed write could be somebody else's at whatever mode they chose. `0700`
/// is what makes it executable at all, which `.command` needs.
fn write_script(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o700);

    options.open(path)?.write_all(body.as_bytes())
}

/// Quotes one word for `/bin/sh`.
///
/// The cwd is a real path from the index and can hold a space, a quote or a
/// dollar sign, and it is being written into a file that gets executed — so
/// single quotes, with the only character they cannot carry spliced in from
/// outside them.
pub(crate) fn sh_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The quoted word is written into a file that gets executed, so a cwd
    /// holding a quote must stay one argument rather than becoming a command.
    #[test]
    fn sh_quote_contains_a_quote() {
        assert_eq!(sh_quote("/tmp/plain"), "'/tmp/plain'");
        assert_eq!(sh_quote("/tmp/my project"), "'/tmp/my project'");
        assert_eq!(sh_quote("/tmp/$HOME"), "'/tmp/$HOME'");
        assert_eq!(sh_quote("/tmp/it's"), r"'/tmp/it'\''s'");
        assert_eq!(
            sh_quote("/tmp/a'; rm -rf /; echo '"),
            r"'/tmp/a'\''; rm -rf /; echo '\'''"
        );
    }

    /// The table is matched on exact file names, so an extension-less entry is
    /// one that can never be found and nothing else would say so.
    #[test]
    fn every_known_bundle_names_an_app() {
        for known in KNOWN {
            if let Some(bundle) = known.bundle {
                assert!(bundle.ends_with(".app"), "{bundle} is not a bundle name");
            }
            for id in known.desktop {
                assert!(id.ends_with(".desktop"), "{id} is not a desktop file id");
            }
            assert!(known.bundle.is_some() || !known.desktop.is_empty() || !known.bins.is_empty());
            assert!(!known.name.is_empty());
        }
    }

    /// Two entries resolving to one bundle would draw the same app twice.
    #[test]
    fn known_bundles_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for known in KNOWN {
            for name in known.bundle.iter().chain(known.desktop).chain(known.bins) {
                assert!(seen.insert(*name), "{name} listed twice");
            }
        }
    }

    fn bundle(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// One scan over a directory of fake bundles pins the three things worth
    /// pinning: the match is exact (`Cloudflare WARP.app` is not `Warp.app`,
    /// and a substring match would list it as a terminal that ignores the
    /// directory it is handed), the order is the table's, and Finder comes
    /// last. Icons are not read, so nothing spawns.
    #[test]
    fn resolves_in_table_order_with_finder_last() {
        let tmp = std::env::temp_dir().join(format!("dray-apps-{}", uuid::Uuid::now_v7()));
        let apps_dir = bundle(&tmp, "Applications");
        // Deliberately created in the order that would be wrong if read_dir
        // order leaked through.
        bundle(&apps_dir, "Ghostty.app");
        bundle(&apps_dir, "Cloudflare WARP.app");
        bundle(&apps_dir, "Cursor.app");
        bundle(&apps_dir, "Not An App");
        let finder = bundle(&tmp, "Finder.app");

        let found = resolve(&installed(&[apps_dir]), &finder);
        let names: Vec<&str> = found.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Cursor", "Ghostty", "Finder"]);
        assert_eq!(found[2].kind, ExternalAppKind::Files);

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    /// A bundle present in two searched directories resolves to the first —
    /// the machine-wide install over the user's own copy, matching Launch
    /// Services. A `HashMap` insert in the other order would silently flip it.
    #[test]
    fn first_directory_wins() {
        let tmp = std::env::temp_dir().join(format!("dray-apps-{}", uuid::Uuid::now_v7()));
        let system = bundle(&tmp, "Applications");
        let user = bundle(&tmp, "home/Applications");
        let expected = bundle(&system, "Zed.app");
        bundle(&user, "Zed.app");

        let found = installed(&[system, user]);
        assert_eq!(found["Zed.app"], expected);

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    /// What this machine actually resolves, printed rather than asserted:
    /// which apps are installed is a fact about the machine, so there is no
    /// count to pin. Kept because detection failing silently — an empty menu —
    /// is the one failure here that looks exactly like "nothing is installed".
    ///
    /// `cargo test -p dray --lib apps -- --ignored --nocapture`
    #[test]
    #[ignore = "reports what is installed; asserts nothing"]
    fn report_detected_apps() {
        #[cfg(target_os = "linux")]
        let detect = linux::detect;
        for app in detect() {
            println!(
                "{:?}\t{}\t{}\ticon={}",
                app.kind,
                app.name,
                app.path,
                app.icon.map_or("none".into(), |icon| format!("{}b", icon.len()))
            );
        }
    }
}
