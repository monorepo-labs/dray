//! Which apps on this machine can open a session's working directory.
//!
//! Everything here is macOS-only and says so by returning an empty list
//! elsewhere: `open(1)`, `.app` bundles and `.icns` are all one platform's,
//! and no other build has a window to draw the button in yet.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

use serde::Serialize;
use ts_rs::TS;

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

/// An installed app the working directory can be handed to.
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
}

/// One row of the curated table: the bundle's file name, what to call it, and
/// which run it sits in.
struct Known {
    /// Matched on the bundle's file name **exactly**, never as a substring.
    /// `Cloudflare WARP.app` is not `Warp.app`, and a contains-check lists it
    /// as a terminal that then ignores the directory.
    bundle: &'static str,
    name: &'static str,
    kind: ExternalAppKind,
}

const fn editor(bundle: &'static str, name: &'static str) -> Known {
    Known { bundle, name, kind: ExternalAppKind::Editor }
}

const fn terminal(bundle: &'static str, name: &'static str) -> Known {
    Known { bundle, name, kind: ExternalAppKind::Terminal }
}

/// The apps this menu knows how to hand a directory to, in the order drawn.
///
/// Curated rather than discovered, and the curation *is* the guarantee: every
/// entry here takes a directory as `open -a <bundle> <dir>`. Reading each found
/// bundle's `CFBundleDocumentTypes` for `public.folder` was the alternative and
/// it is the wrong gate — `open -a` names the app outright rather than asking
/// Launch Services to rank handlers, so it reaches apps that declare nothing
/// (MacVim declares no folder type and opens one fine). Gating on the
/// declaration would hide apps that work.
///
/// An app absent from this table costs one entry, never the list.
const KNOWN: &[Known] = &[
    editor("Visual Studio Code.app", "VS Code"),
    editor("Visual Studio Code - Insiders.app", "VS Code Insiders"),
    editor("Cursor.app", "Cursor"),
    editor("Windsurf.app", "Windsurf"),
    editor("Zed.app", "Zed"),
    editor("Zed Preview.app", "Zed Preview"),
    editor("Sublime Text.app", "Sublime Text"),
    editor("Nova.app", "Nova"),
    editor("BBEdit.app", "BBEdit"),
    editor("Xcode.app", "Xcode"),
    editor("IntelliJ IDEA.app", "IntelliJ IDEA"),
    editor("IntelliJ IDEA CE.app", "IntelliJ IDEA CE"),
    editor("WebStorm.app", "WebStorm"),
    editor("PyCharm.app", "PyCharm"),
    editor("PyCharm CE.app", "PyCharm CE"),
    editor("GoLand.app", "GoLand"),
    editor("RustRover.app", "RustRover"),
    editor("CLion.app", "CLion"),
    editor("PhpStorm.app", "PhpStorm"),
    editor("RubyMine.app", "RubyMine"),
    editor("DataGrip.app", "DataGrip"),
    editor("Android Studio.app", "Android Studio"),
    editor("VimR.app", "VimR"),
    editor("MacVim.app", "MacVim"),
    terminal("Ghostty.app", "Ghostty"),
    terminal("iTerm.app", "iTerm"),
    terminal("Warp.app", "Warp"),
    terminal("WezTerm.app", "WezTerm"),
    terminal("Terminal.app", "Terminal"),
];

/// Finder, which is in none of the scanned directories and on every mac.
const FINDER: &str = "/System/Library/CoreServices/Finder.app";

/// Where a `.app` bundle lives. One `read_dir` each and no `mdfind`: Spotlight
/// can be off or still indexing, and the common case is an app that is not
/// installed at all — where a per-app query is a spawn that answers nothing.
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
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Applications"));
    }
    dirs
}

/// Bundle file name to its path, for every `.app` in `dirs`.
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
fn icon_cache() -> &'static Mutex<HashMap<PathBuf, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The `.icns` a bundle names as its icon.
///
/// `CFBundleIconFile` may or may not carry the extension, so both spellings are
/// tried; `AppIcon` is the fallback for a bundle that names none.
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
fn read_icon(bundle: &Path) -> Option<String> {
    if let Ok(cache) = icon_cache().lock() {
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

    if let Ok(mut cache) = icon_cache().lock() {
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
fn resolve(installed: &HashMap<String, PathBuf>, finder: &Path) -> Vec<ExternalApp> {
    let mut apps: Vec<ExternalApp> = KNOWN
        .iter()
        .filter_map(|known| {
            let path = installed.get(known.bundle)?;
            Some(ExternalApp {
                path: path.to_string_lossy().into_owned(),
                name: known.name.to_string(),
                kind: known.kind,
                icon: None,
            })
        })
        .collect();

    if finder.is_dir() {
        apps.push(ExternalApp {
            path: finder.to_string_lossy().into_owned(),
            name: "Finder".to_string(),
            kind: ExternalAppKind::Files,
            icon: None,
        });
    }

    apps
}

fn detect() -> Vec<ExternalApp> {
    let mut apps = resolve(&installed(&search_dirs()), Path::new(FINDER));
    for app in &mut apps {
        app.icon = read_icon(Path::new(&app.path));
    }
    apps
}

/// The apps that can open a working directory on this machine.
///
/// Re-scanned on every call rather than held for the process: the walk is a
/// handful of `read_dir`s, and only the icons are dear enough to cache — so an
/// editor installed while Dray is running shows up the next time the panel
/// asks, instead of needing a restart the way the slash-command cache does.
#[tauri::command]
pub async fn list_open_apps() -> Vec<ExternalApp> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .unwrap_or_default()
}

/// Hands `path` to the app at `app_path`.
///
/// `open -a <bundle> <dir>` and not `open -b <id>`, for [`ExternalApp::path`]'s
/// reason. Nothing here reaches a shell, so injection is not the risk — but a
/// directory whose name opens with `-` parses as a flag, which `--` ends.
#[tauri::command]
pub async fn open_in_app(app_path: String, path: String) -> Result<(), String> {
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
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("could not open {path}")
    } else {
        stderr
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is matched on exact file names, so an extension-less entry is
    /// one that can never be found and nothing else would say so.
    #[test]
    fn every_known_bundle_names_an_app() {
        for known in KNOWN {
            assert!(
                known.bundle.ends_with(".app"),
                "{} is not a bundle name",
                known.bundle
            );
            assert!(!known.name.is_empty());
        }
    }

    /// Two entries resolving to one bundle would draw the same app twice.
    #[test]
    fn known_bundles_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for known in KNOWN {
            assert!(seen.insert(known.bundle), "{} listed twice", known.bundle);
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
