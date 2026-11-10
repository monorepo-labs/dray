//! Linux's half of [`super`]: apps found through `.desktop` files under the XDG
//! data dirs, falling back to binaries on `PATH`; icons resolved through the
//! icon theme; launches through the entry's own `Exec`.
//!
//! Every spawn here takes back what an AppImage's AppRun added to the
//! environment ([`crate::serve::appimage_env_undo`]): an editor inheriting the
//! bundle's `LD_LIBRARY_PATH` loads Dray's libraries, and one holding the
//! mount keeps a replaced AppImage alive for as long as it runs.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::Duration,
};

use super::{ExternalApp, ExternalAppKind, Known, Term, ICONS, KNOWN};

/// How one listed app is started.
#[derive(Debug, Clone)]
struct Launch {
    name: String,
    kind: ExternalAppKind,
    /// `Exec` split into words with its field codes still in, the program
    /// already resolved to an absolute path. A bare binary is one word.
    exec: Vec<String>,
    /// `Icon=`, for `%i`; also what the menu's icon is looked up by.
    icon: Option<String>,
    desktop: Option<PathBuf>,
    term: Term,
    /// `exec`'s program is one of the table's own binaries, so a terminal's
    /// argv is ours to compose. A Flatpak's `flatpak run …` is not, and keeps
    /// every word.
    own_binary: bool,
}

/// What the last scan listed, keyed by [`ExternalApp::path`]. `open_in_app`
/// launches only what is here, so the frontend names an app and never a
/// program: the address is a `.desktop` path, and running an arbitrary one
/// would run whatever its `Exec` says.
static LISTED: LazyLock<Mutex<HashMap<String, Launch>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whether `path` lies inside an AppImage's mount — Dray's own bundle, which
/// AppRun puts first on `PATH` and `XDG_DATA_DIRS`.
fn in_appimage(path: &str) -> bool {
    path.starts_with(&*std::env::temp_dir().join(".mount_").to_string_lossy())
}

/// The XDG data dirs in precedence order, user's first, with Flatpak's and
/// Snap's exports added where the session did not list them.
fn data_dirs() -> Vec<PathBuf> {
    let home = std::env::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let var = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
    let mut dirs = vec![var("XDG_DATA_HOME").map_or_else(|| home.join(".local/share"), PathBuf::from)];
    let system = var("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    dirs.extend(system.split(':').filter(|d| !d.is_empty()).map(PathBuf::from));
    dirs.push(home.join(".local/share/flatpak/exports/share"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop"));

    let mut seen = HashSet::new();
    dirs.retain(|d| !in_appimage(&d.to_string_lossy()) && seen.insert(d.clone()));
    dirs
}

/// `name` resolved on `PATH`, or checked in place where it names a path.
fn which(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let runnable = |p: &Path| p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    if name.contains('/') {
        let path = PathBuf::from(name);
        return runnable(&path).then_some(path);
    }
    let path = std::env::var("PATH").unwrap_or_default();
    path.split(':')
        .filter(|d| !d.is_empty() && !in_appimage(d))
        .map(|d| Path::new(d).join(name))
        .find(|p| runnable(p))
}

/// The `[Desktop Entry]` keys this reads.
#[derive(Debug, Default, PartialEq)]
struct Entry {
    application: bool,
    exec: Option<String>,
    try_exec: Option<String>,
    icon: Option<String>,
    hidden: bool,
    no_display: bool,
    terminal: bool,
}

/// The string escapes every value takes (`\s`, `\n`, `\t`, `\r`, `\\`). Any
/// other backslash is left for `Exec`'s own quoting to read.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn parse_entry(text: &str) -> Entry {
    let mut entry = Entry::default();
    let mut in_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // Actions sit in groups of their own and carry their own `Exec`.
            in_group = line == "[Desktop Entry]";
            continue;
        }
        let Some((key, value)) = line.split_once('=').filter(|_| in_group && !line.starts_with('#')) else {
            continue;
        };
        let value = unescape(value.trim());
        let yes = value == "true";
        match key.trim() {
            "Type" => entry.application = value == "Application",
            "Exec" => entry.exec = Some(value),
            "TryExec" => entry.try_exec = Some(value),
            "Icon" => entry.icon = Some(value).filter(|v| !v.is_empty()),
            "Hidden" => entry.hidden = yes,
            "NoDisplay" => entry.no_display = yes,
            "Terminal" => entry.terminal = yes,
            _ => {}
        }
    }
    entry
}

/// `Exec` split into words by the spec's quoting: a double-quoted word takes
/// `\"`, `` \` ``, `\$` and `\\` as escapes. `None` for an unclosed quote,
/// which is a broken entry rather than one to guess at.
fn split_exec(exec: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let (mut in_word, mut quoted) = (false, false);
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' => quoted = false,
                '\\' => match chars.next()? {
                    n @ ('"' | '`' | '$' | '\\') => word.push(n),
                    n => {
                        word.push('\\');
                        word.push(n);
                    }
                },
                _ => word.push(c),
            }
            continue;
        }
        match c {
            '"' => (quoted, in_word) = (true, true),
            ' ' | '\t' => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            _ => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if quoted {
        return None;
    }
    if in_word {
        words.push(word);
    }
    Some(words)
}

/// Expands `Exec`'s field codes. `%f %F %u %U` take `target` (a plain path is
/// a valid `%u`), or nothing where there is none; `%i`, `%c` and `%k` are the
/// entry's icon, name and file; the deprecated ones go. Returns whether any
/// code took the target, since an `Exec` naming none is handed it at the end.
fn expand(launch: &Launch, target: Option<&str>) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut took = false;
    for word in &launch.exec {
        match word.as_str() {
            "%f" | "%F" | "%u" | "%U" => {
                if let Some(target) = target {
                    out.push(target.to_string());
                    took = true;
                }
            }
            "%i" => {
                if let Some(icon) = &launch.icon {
                    out.extend(["--icon".to_string(), icon.clone()]);
                }
            }
            _ => {
                let mut expanded = String::new();
                let mut chars = word.chars();
                while let Some(c) = chars.next() {
                    if c != '%' {
                        expanded.push(c);
                        continue;
                    }
                    match chars.next() {
                        Some('%') => expanded.push('%'),
                        Some('f' | 'F' | 'u' | 'U') => {
                            if let Some(target) = target {
                                expanded.push_str(target);
                                took = true;
                            }
                        }
                        Some('c') => expanded.push_str(&launch.name),
                        Some('k') => {
                            if let Some(desktop) = &launch.desktop {
                                expanded.push_str(&desktop.to_string_lossy());
                            }
                        }
                        _ => {}
                    }
                }
                if !expanded.is_empty() || word.is_empty() {
                    out.push(expanded);
                }
            }
        }
    }
    (out, took)
}

/// A terminal flag and its value as argv words. A flag holding a space is
/// several words (`start --cwd`); one ending in `=` is joined to the value;
/// an empty one is the value alone.
fn flag(flag: &str, value: &str) -> Vec<String> {
    let mut words: Vec<String> = flag.split(' ').filter(|w| !w.is_empty()).map(String::from).collect();
    match words.pop() {
        Some(last) if last.ends_with('=') => words.push(format!("{last}{value}")),
        Some(last) => words.extend([last, value.to_string()]),
        None => words.push(value.to_string()),
    }
    words
}

/// A terminal's program, without the target its `Exec` might name: our own
/// flags follow, so its own (`--gtk-single-instance=true`, WezTerm's
/// `start --cwd .`) would fight them. A wrapper keeps every word, since what
/// follows `flatpak run <id>` is passed through to the app.
fn terminal_base(launch: &Launch) -> Vec<String> {
    if launch.own_binary {
        return launch.exec[..1].to_vec();
    }
    expand(launch, None).0
}

/// The argv that opens `target` in `launch`. A terminal is started *at* a
/// directory, never handed one as a file to open.
fn argv(launch: &Launch, target: &Path, dir: &Path) -> Vec<String> {
    if launch.kind == ExternalAppKind::Terminal {
        let mut argv = terminal_base(launch);
        if let Some(dir_flag) = launch.term.dir {
            argv.extend(flag(dir_flag, &dir.to_string_lossy()));
        }
        return argv;
    }
    let target = target.to_string_lossy();
    let (mut argv, took) = expand(launch, Some(&target));
    if !took {
        argv.push(target.into_owned());
    }
    argv
}

/// Takes back what an AppImage's AppRun put in `cmd`'s environment.
fn clean_env(cmd: &mut std::process::Command) {
    #[cfg(feature = "desktop")]
    for (key, value) in crate::serve::appimage_env_undo() {
        match value {
            Some(value) => cmd.env(key, value),
            None => cmd.env_remove(key),
        };
    }
    #[cfg(not(feature = "desktop"))]
    let _ = cmd;
}

/// Starts `argv` detached: its own process group, so a signal to Dray's never
/// reaches it, and no inherited stdio. Waits briefly, so a program refusing
/// its arguments outright is an error the button can show; anything still
/// running then is reaped in the background.
async fn spawn(argv: Vec<String>, cwd: &Path, name: &str) -> Result<(), String> {
    use std::process::Stdio;
    let (program, args) = argv.split_first().ok_or_else(|| format!("{name} has nothing to run"))?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    clean_env(cmd.as_std_mut());
    let mut child = cmd.spawn().map_err(|err| format!("could not start {name}: {err}"))?;
    match tokio::time::timeout(Duration::from_millis(1500), child.wait()).await {
        Ok(Ok(status)) if !status.success() => Err(format!("{name} failed ({status})")),
        Ok(_) => Ok(()),
        Err(_) => {
            tokio::spawn(async move { child.wait().await });
            Ok(())
        }
    }
}

/// Every usable `.desktop` file, first data dir winning per id — the spec's
/// precedence, so a user's override shadows the system copy.
fn scan(dirs: &[PathBuf]) -> Vec<(String, PathBuf, Entry)> {
    fn walk(root: &Path, dir: &Path, depth: u8, seen: &mut HashSet<String>, out: &mut Vec<(String, PathBuf, Entry)>) {
        let Ok(items) = std::fs::read_dir(dir) else { return };
        let mut items: Vec<_> = items.flatten().map(|e| e.path()).collect();
        items.sort();
        for path in items {
            if path.is_dir() {
                if depth < 3 {
                    walk(root, &path, depth + 1, seen, out);
                }
                continue;
            }
            if path.extension().is_none_or(|e| e != "desktop") {
                continue;
            }
            // A subdirectory is part of the id: `kde4/kate.desktop` is `kde4-kate.desktop`.
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let id = rel.to_string_lossy().replace('/', "-");
            if !seen.insert(id.clone()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            out.push((id, path, parse_entry(&text)));
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        let root = dir.join("applications");
        walk(&root, &root, 0, &mut seen, &mut out);
    }
    out
}

/// The entry's `Exec` with its program resolved, where the entry is one a
/// menu should list: an application, not hidden, not run inside a terminal,
/// and installed — a `.desktop` file can outlive the package that left it.
fn runnable_exec(entry: &Entry) -> Option<Vec<String>> {
    if !entry.application || entry.hidden || entry.no_display || entry.terminal {
        return None;
    }
    if let Some(try_exec) = &entry.try_exec {
        which(try_exec)?;
    }
    let mut exec = split_exec(entry.exec.as_deref()?)?;
    let program = which(exec.first()?)?;
    exec[0] = program.to_string_lossy().into_owned();
    Some(exec)
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Where `known` is installed: by one of its desktop ids, then by a desktop
/// file whose program is one of its binaries, then by a binary `lookup` finds
/// on `PATH`.
///
/// One of its ids marked `Hidden=true` is the spec's "deleted", and ends the
/// search: the reader removed the app, and finding its binary anyway would
/// list it again.
fn find(
    known: &Known,
    entries: &[(String, PathBuf, Entry)],
    used: &mut HashSet<PathBuf>,
    lookup: &dyn Fn(&str) -> Option<PathBuf>,
) -> Option<(ExternalApp, Launch)> {
    let hidden = known
        .desktop
        .iter()
        .any(|id| entries.iter().any(|(eid, _, entry)| eid == id && entry.hidden));
    if hidden {
        return None;
    }

    let make = |path: &Path, exec: Vec<String>, icon: Option<String>, desktop: Option<PathBuf>| {
        let own_binary = known.bins.contains(&basename(&exec[0]));
        let launch = Launch {
            name: known.name.to_string(),
            kind: known.kind,
            exec,
            icon,
            desktop,
            term: known.term,
            own_binary,
        };
        let app = ExternalApp {
            path: path.to_string_lossy().into_owned(),
            name: known.name.to_string(),
            kind: known.kind,
            icon: None,
            folders: !known.files_only,
        };
        (app, launch)
    };

    let by_id = known.desktop.iter().find_map(|id| {
        let (_, path, entry) = entries.iter().find(|(eid, ..)| eid == id)?;
        Some((path, entry, runnable_exec(entry)?))
    });
    let by_bin = || {
        entries.iter().find_map(|(_, path, entry)| {
            let exec = runnable_exec(entry)?;
            (!used.contains(path) && known.bins.contains(&basename(&exec[0]))).then_some((path, entry, exec))
        })
    };
    if let Some((path, entry, exec)) = by_id.or_else(by_bin) {
        if used.insert(path.clone()) {
            return Some(make(path, exec, entry.icon.clone(), Some(path.clone())));
        }
    }

    let (bin, path) = known.bins.iter().find_map(|bin| Some((*bin, lookup(bin)?)))?;
    // Icon themes name most apps' icons after their binary.
    Some(make(&path, vec![path.to_string_lossy().into_owned()], Some(bin.to_string()), None))
}

/// The desktop id the session opens folders with, which picks the one file
/// manager listed when several are installed.
fn default_folder_handler() -> Option<String> {
    let mut cmd = std::process::Command::new(which("xdg-mime")?);
    cmd.args(["query", "default", "inode/directory"]);
    clean_env(&mut cmd);
    let out = cmd.output().ok().filter(|out| out.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|id| !id.is_empty())
}

/// Every known app installed here, in [`KNOWN`]'s order, with one file manager
/// last — the reader's default where it is one the table knows, `xdg-open`
/// where none is. Split from [`detect`] so it can run on fake dirs.
fn resolve(
    entries: &[(String, PathBuf, Entry)],
    default_files: Option<&str>,
    lookup: &dyn Fn(&str) -> Option<PathBuf>,
) -> Vec<(ExternalApp, Launch)> {
    let mut used = HashSet::new();
    let mut found: Vec<(ExternalApp, Launch)> = KNOWN
        .iter()
        .filter(|k| !k.desktop.is_empty() || !k.bins.is_empty())
        .filter_map(|known| find(known, entries, &mut used, lookup))
        .collect();

    let files: Vec<usize> = (0..found.len()).filter(|i| found[*i].1.kind == ExternalAppKind::Files).collect();
    let keep = files
        .iter()
        .copied()
        .find(|i| {
            let desktop = found[*i].1.desktop.as_deref();
            default_files.is_some_and(|id| desktop.and_then(|d| d.file_name()).is_some_and(|f| f == id))
        })
        .or(files.first().copied());
    let mut index = 0;
    found.retain(|_| {
        index += 1;
        files.binary_search(&(index - 1)).is_err() || Some(index - 1) == keep
    });

    if keep.is_none() {
        if let Some(xdg_open) = which("xdg-open") {
            let path = xdg_open.to_string_lossy().into_owned();
            found.push((
                ExternalApp {
                    path: path.clone(),
                    name: "Files".into(),
                    kind: ExternalAppKind::Files,
                    icon: None,
                    folders: true,
                },
                Launch {
                    name: "Files".into(),
                    kind: ExternalAppKind::Files,
                    exec: vec![path],
                    icon: Some("system-file-manager".into()),
                    desktop: None,
                    term: super::NO_TERM,
                    own_binary: true,
                },
            ));
        }
    }
    found
}

/// The apps that can open a path here, icons read, and remembered for
/// [`open_in_app`].
pub(super) fn detect() -> Vec<ExternalApp> {
    let found = resolve(&scan(&data_dirs()), default_folder_handler().as_deref(), &which);
    let mut listed = HashMap::new();
    let apps = found
        .into_iter()
        .map(|(mut app, launch)| {
            // Not every theme draws every file manager's icon — Adwaita has no
            // `system-file-manager`, which Nemo names — so a folder stands in.
            let fallback: &[&str] =
                if launch.kind == ExternalAppKind::Files { &["system-file-manager", "folder"] } else { &[] };
            let names: Vec<&str> = launch.icon.as_deref().into_iter().chain(fallback.iter().copied()).collect();
            app.icon = read_icon(&app.path, &names);
            listed.insert(app.path.clone(), launch);
            app
        })
        .collect();
    *LISTED.lock().unwrap_or_else(|e| e.into_inner()) = listed;
    apps
}

/// Hands `path` to the app the scan listed at `app_path`: a directory or a file
/// to an editor or file manager through its `Exec`, and a terminal started in
/// the directory.
pub(super) async fn open_in_app(app_path: &str, path: &str) -> Result<(), String> {
    let listed = || LISTED.lock().unwrap_or_else(|e| e.into_inner()).get(app_path).cloned();
    let launch = match listed() {
        Some(launch) => launch,
        None => {
            tokio::task::spawn_blocking(detect).await.ok();
            listed().ok_or_else(|| format!("{app_path} is no longer installed"))?
        }
    };
    let target = Path::new(path);
    let dir = if target.is_dir() { target } else { target.parent().filter(|p| p.is_dir()).ok_or_else(|| format!("{path} does not exist"))? };
    spawn(argv(&launch, target, dir), dir, &launch.name).await
}

/// How a terminal not found through the table is asked to run a command:
/// `-e`, which Debian's `x-terminal-emulator` contract and nearly every
/// terminal take.
const FALLBACK_TERM: Term = Term { dir: None, exec: Some("-e") };

/// The table's terminal whose binary `program` is, symlinks followed:
/// `x-terminal-emulator` is an alternatives link to the real one.
fn term_for(program: &Path) -> Option<Term> {
    let real = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    KNOWN
        .iter()
        .find(|k| k.kind == ExternalAppKind::Terminal && k.bins.contains(&name.as_str()))
        .map(|k| k.term)
}

/// `$TERMINAL` as a base argv and its flags. A terminal the table knows keeps
/// its program alone, since the table's flags follow — `wezterm start` would
/// otherwise reach WezTerm as `start start --cwd`. One it does not know keeps
/// every word and takes `-e`.
fn named_terminal(value: &str, lookup: &dyn Fn(&str) -> Option<PathBuf>) -> Option<(Vec<String>, Term, String)> {
    let mut words: Vec<String> = value.split_whitespace().map(String::from).collect();
    let program = lookup(words.first()?)?;
    words[0] = program.to_string_lossy().into_owned();
    let name = basename(&words[0]).to_string();
    Some(match term_for(&program) {
        Some(term) => (words[..1].to_vec(), term, name),
        None => (words, FALLBACK_TERM, name),
    })
}

/// The terminal to run a command in, as a base argv and its flags: the
/// reader's `$TERMINAL`, then `x-terminal-emulator`, then the table's own in
/// its order. One that cannot be asked to run a command is passed over.
fn pick_terminal() -> Option<(Vec<String>, Term, String)> {
    let named = std::env::var("TERMINAL").ok().and_then(|value| named_terminal(&value, &which));
    let debian = || {
        let program = which("x-terminal-emulator")?;
        let term = term_for(&program).unwrap_or(FALLBACK_TERM);
        Some((vec![program.to_string_lossy().into_owned()], term, "x-terminal-emulator".into()))
    };
    let known = || {
        let entries = scan(&data_dirs());
        let mut used = HashSet::new();
        KNOWN
            .iter()
            .filter(|k| k.kind == ExternalAppKind::Terminal && k.term.exec.is_some())
            .find_map(|k| find(k, &entries, &mut used, &which))
            .map(|(_, launch)| (terminal_base(&launch), launch.term, launch.name))
    };
    let asks = |t: &(Vec<String>, Term, String)| t.1.exec.is_some();
    named.filter(asks).or_else(|| debian().filter(asks)).or_else(known)
}

/// Runs one shell line in the reader's terminal at `cwd`; see
/// [`super::run_in_terminal`] for where that line may come from.
///
/// Through a throwaway script, so the command reaches every terminal as one
/// path rather than in each one's own quoting. The window waits for Enter
/// once the command ends: Terminal.app keeps a finished window open, and a
/// Linux terminal closes it with the login's last words still on it.
pub(super) async fn run_in_terminal(command: &str, cwd: &str) -> Result<(), String> {
    let dir = Some(PathBuf::from(cwd))
        .filter(|d| !cwd.is_empty() && d.is_dir())
        .or_else(std::env::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let (mut argv, term, name) = tokio::task::spawn_blocking(pick_terminal)
        .await
        .ok()
        .flatten()
        .ok_or("No terminal found. Set $TERMINAL, or copy the command instead.")?;

    let enter = if cwd.is_empty() { String::new() } else { format!("cd {} || exit 1\n", super::sh_quote(cwd)) };
    let script = format!(
        "#!/bin/sh\n{enter}{command}\nstatus=$?\nrm -f -- \"$0\"\nprintf '\\n%s' \"Finished (exit $status). Press Enter to close.\"\nread _\n"
    );
    let path = std::env::temp_dir().join(format!("dray-login-{}.sh", uuid::Uuid::now_v7()));
    super::write_script(&path, &script).map_err(|err| format!("could not write the login script: {err}"))?;

    // Always a directory, so a flag carrying a subcommand (WezTerm's `start`)
    // is always in the argv ahead of the command's own.
    if let Some(dir_flag) = term.dir {
        argv.extend(flag(dir_flag, &dir.to_string_lossy()));
    }
    argv.extend(flag(term.exec.unwrap_or("-e"), &path.to_string_lossy()));

    let opened = spawn(argv, &dir, &name).await;
    if opened.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    opened
}

/// The icon theme the session draws with: GTK's settings file, then GNOME's
/// setting. `None` leaves hicolor, the theme every other inherits.
static THEME: LazyLock<Option<String>> = LazyLock::new(|| {
    let config = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| Some(std::env::home_dir()?.join(".config")));
    let from_ini = config.into_iter().flat_map(|c| [c.join("gtk-3.0/settings.ini"), c.join("gtk-4.0/settings.ini")]).find_map(|ini| {
        let text = std::fs::read_to_string(ini).ok()?;
        text.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "gtk-icon-theme-name").then(|| value.trim().trim_matches('"').to_string())
        })
    });
    from_ini.or_else(|| {
        let mut cmd = std::process::Command::new(which("gsettings")?);
        cmd.args(["get", "org.gnome.desktop.interface", "icon-theme"]);
        clean_env(&mut cmd);
        let out = cmd.output().ok().filter(|o| o.status.success())?;
        Some(String::from_utf8_lossy(&out.stdout).trim().trim_matches('\'').to_string())
    })
    .filter(|t| !t.is_empty())
});

/// The size the menu draws at is 16px; 64 leaves room for a 2× screen without
/// carrying a 512px PNG through IPC.
const ICON_SIZE: i64 = 64;

/// A theme's subdirectories, each paired with the extension to look for in it,
/// best first; and the themes it inherits.
///
/// Scored on `Size` rather than the spec's `MinSize`/`MaxSize` match: hicolor
/// calls `256x256/apps` scalable down to 64, and taking it at its word sent a
/// 46KB PNG through IPC for a 16px mark. Only an SVG is size-free.
fn theme_index(text: &str) -> (Vec<(String, &'static str)>, Vec<String>) {
    let mut groups: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut group = String::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            group = name.to_string();
        } else if let Some((key, value)) = line.split_once('=') {
            groups.entry(group.clone()).or_default().insert(key.trim().into(), value.trim().into());
        }
    }
    let list = |key: &str| -> Vec<String> {
        groups
            .get("Icon Theme")
            .and_then(|g| g.get(key))
            .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default()
    };
    let mut dirs: Vec<(i64, i64, String, &'static str)> = list("Directories")
        .into_iter()
        .filter_map(|dir| {
            let keys = groups.get(&dir)?;
            if keys.get("Scale").is_some_and(|s| s != "1") {
                return None;
            }
            let size: i64 = keys.get("Size")?.parse().ok()?;
            let off = (size - ICON_SIZE).abs();
            let svg = if keys.get("Type").is_some_and(|t| t == "Scalable") { 0 } else { off };
            Some([(off, -size, dir.clone(), "png"), (svg, -size, dir, "svg")])
        })
        .flatten()
        .collect();
    // Ties go to the larger size: scaled down reads better than up.
    dirs.sort_by_key(|(off, neg_size, ..)| (*off, *neg_size));
    (dirs.into_iter().map(|(_, _, dir, ext)| (dir, ext)).collect(), list("Inherits"))
}

/// `Icon=` resolved to a file: a path as given, else the theme chain searched
/// in order (the session's theme, what it inherits, hicolor), else pixmaps.
fn find_icon(name: &str) -> Option<PathBuf> {
    if name.starts_with('/') {
        return Some(PathBuf::from(name)).filter(|p| p.is_file());
    }
    let name = name.strip_suffix(".png").or_else(|| name.strip_suffix(".svg")).unwrap_or(name);
    let data = data_dirs();
    let mut bases: Vec<PathBuf> = std::env::home_dir().map(|h| h.join(".icons")).into_iter().collect();
    bases.extend(data.iter().map(|d| d.join("icons")));

    let mut queue: VecDeque<String> = THEME.iter().cloned().collect();
    queue.push_back("hicolor".into());
    let mut seen = HashSet::new();
    while let Some(theme) = queue.pop_front() {
        if !seen.insert(theme.clone()) {
            continue;
        }
        let Some(index) = bases.iter().find_map(|b| std::fs::read_to_string(b.join(&theme).join("index.theme")).ok()) else {
            continue;
        };
        let (dirs, inherits) = theme_index(&index);
        // Inherited themes ahead of the hicolor queued at the start.
        for parent in inherits.into_iter().rev() {
            queue.push_front(parent);
        }
        for (dir, ext) in &dirs {
            for base in &bases {
                let path = base.join(&theme).join(dir).join(format!("{name}.{ext}"));
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    data.iter()
        .map(|d| d.join("pixmaps"))
        .chain([PathBuf::from("/usr/share/pixmaps")])
        .flat_map(|d| ["png", "svg"].map(|ext| d.join(format!("{name}.{ext}"))))
        .find(|p| p.is_file())
}

/// The app's icon as a `data:` URL — PNG or SVG as found, since a webview
/// draws either — cached per app like the Mac's.
fn read_icon(app_path: &str, names: &[&str]) -> Option<String> {
    let key = PathBuf::from(app_path);
    if let Some(hit) = ICONS.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return hit;
    }
    let read = || {
        let file = names.iter().find_map(|name| find_icon(name))?;
        let mime = match file.extension()?.to_str()? {
            "png" => "image/png",
            "svg" => "image/svg+xml",
            _ => return None,
        };
        // A theme's icon is a few KB; anything far past that is not one.
        let bytes = std::fs::read(&file).ok().filter(|b| b.len() < 1 << 20)?;
        use base64::Engine as _;
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    };
    let found = read();
    if let Ok(mut cache) = ICONS.lock() {
        cache.insert(key, found.clone());
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(exec: &[&str], kind: ExternalAppKind) -> Launch {
        Launch {
            name: "Thing".into(),
            kind,
            exec: exec.iter().map(|s| s.to_string()).collect(),
            icon: Some("thing".into()),
            desktop: Some("/usr/share/applications/thing.desktop".into()),
            term: super::super::NO_TERM,
            own_binary: true,
        }
    }

    /// The spec's two layers: string escapes first, then `Exec`'s quoting.
    #[test]
    fn splits_exec_by_the_spec() {
        assert_eq!(split_exec("/usr/bin/code --new %F").unwrap(), ["/usr/bin/code", "--new", "%F"]);
        assert_eq!(split_exec(r#""/opt/My App/run" --x "a \"b\" \$c""#).unwrap(), ["/opt/My App/run", "--x", r#"a "b" $c"#]);
        assert_eq!(split_exec(&unescape(r#""a\\\\b" c\sd"#)).unwrap(), [r"a\b", "c", "d"]);
        assert!(split_exec(r#""unclosed"#).is_none());
    }

    #[test]
    fn reads_only_the_desktop_entry_group() {
        let entry = parse_entry(
            "[Desktop Entry]\nType=Application\nName=Zed\nExec=zed %U\nIcon=zed\n\n[Desktop Action NewWorkspace]\nExec=zed --new\nNoDisplay=true\n",
        );
        assert_eq!(entry.exec.as_deref(), Some("zed %U"));
        assert_eq!(entry.icon.as_deref(), Some("zed"));
        assert!(entry.application && !entry.no_display);
    }

    /// A field code takes the target where it names one; an `Exec` with none
    /// is handed it at the end; the deprecated codes vanish.
    #[test]
    fn expands_field_codes() {
        let dir = Path::new("/tmp/my proj");
        let code = launch(&["/usr/bin/code", "%F"], ExternalAppKind::Editor);
        assert_eq!(argv(&code, dir, dir), ["/usr/bin/code", "/tmp/my proj"]);
        let plain = launch(&["/usr/bin/gvim", "%d", "-f"], ExternalAppKind::Editor);
        assert_eq!(argv(&plain, dir, dir), ["/usr/bin/gvim", "-f", "/tmp/my proj"]);
        let iconic = launch(&["/usr/bin/x", "%i", "--name=%c", "%%u"], ExternalAppKind::Editor);
        assert_eq!(argv(&iconic, dir, dir), ["/usr/bin/x", "--icon", "thing", "--name=Thing", "%u", "/tmp/my proj"]);
    }

    /// A terminal drops its desktop file's own flags for the table's, and a
    /// wrapper keeps every word but the target.
    #[test]
    fn terminals_start_in_the_directory() {
        let dir = Path::new("/tmp/p");
        let mut wez = launch(&["/usr/bin/wezterm", "start", "--cwd", "."], ExternalAppKind::Terminal);
        wez.term = Term { dir: Some("start --cwd"), exec: Some("--") };
        assert_eq!(argv(&wez, dir, dir), ["/usr/bin/wezterm", "start", "--cwd", "/tmp/p"]);

        let mut ghostty = launch(&["/usr/bin/ghostty", "--gtk-single-instance=true"], ExternalAppKind::Terminal);
        ghostty.term = Term { dir: Some("--working-directory="), exec: Some("-e") };
        assert_eq!(argv(&ghostty, dir, dir), ["/usr/bin/ghostty", "--working-directory=/tmp/p"]);

        let mut flatpak = launch(&["/usr/bin/flatpak", "run", "org.wezfurlong.wezterm", "%U"], ExternalAppKind::Terminal);
        flatpak.own_binary = false;
        flatpak.term = wez.term;
        assert_eq!(argv(&flatpak, dir, dir), ["/usr/bin/flatpak", "run", "org.wezfurlong.wezterm", "start", "--cwd", "/tmp/p"]);

        assert_eq!(flag("", "/s.sh"), ["/s.sh"]);
        assert_eq!(flag("-e", "/s.sh"), ["-e", "/s.sh"]);
    }

    #[test]
    fn picks_the_nearest_icon_size() {
        let index = "[Icon Theme]\nInherits=gnome,hicolor\nDirectories=16x16/apps,256x256/apps,48x48/apps,64x64@2/apps,scalable/apps\n\n\
            [16x16/apps]\nSize=16\n[256x256/apps]\nSize=256\n[48x48/apps]\nSize=48\n[64x64@2/apps]\nSize=64\nScale=2\n[scalable/apps]\nSize=128\nType=Scalable\n";
        let (dirs, inherits) = theme_index(index);
        let order: Vec<String> = dirs.iter().map(|(dir, ext)| format!("{dir}.{ext}")).collect();
        assert_eq!(
            order,
            [
                "scalable/apps.svg",
                "48x48/apps.png",
                "48x48/apps.svg",
                "16x16/apps.png",
                "16x16/apps.svg",
                "scalable/apps.png",
                "256x256/apps.png",
                "256x256/apps.svg",
            ]
        );
        assert_eq!(inherits, ["gnome", "hicolor"]);
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// One scan over fake data dirs pins precedence (the user's copy shadows
    /// the system's), the gates (hidden, terminal-only, uninstalled), the
    /// table's order, and one file manager — the default — last.
    #[test]
    fn resolves_desktop_files_in_table_order() {
        let tmp = std::env::temp_dir().join(format!("dray-xdg-{}", uuid::Uuid::now_v7()));
        let (user, system) = (tmp.join("user"), tmp.join("system"));
        let sh = which("sh").unwrap();
        let sh = sh.to_string_lossy();
        let app = |exec: &str, extra: &str| format!("[Desktop Entry]\nType=Application\nExec={exec}\n{extra}");
        write(&system.join("applications/org.gnome.Terminal.desktop"), &app(&format!("{sh} gnome-terminal"), ""));
        write(&user.join("applications/org.gnome.Terminal.desktop"), &app(&format!("{sh} --user"), ""));
        write(&system.join("applications/code.desktop"), &app(&format!("{sh} %F"), "Icon=vscode\n"));
        write(&system.join("applications/kitty.desktop"), &app(&format!("{sh}"), "Hidden=true\n"));
        write(&system.join("applications/xterm.desktop"), &app(&format!("{sh}"), "Terminal=true\n"));
        write(&system.join("applications/cursor.desktop"), &app("/nonexistent/cursor %F", ""));
        write(&system.join("applications/org.gnome.Nautilus.desktop"), &app(&format!("{sh} %U"), ""));
        write(&system.join("applications/nemo.desktop"), &app(&format!("{sh} %U"), ""));

        let found = resolve(&scan(&[user.clone(), system.clone()]), Some("nemo.desktop"), &|_| None);
        let names: Vec<&str> = found.iter().map(|(a, _)| a.name.as_str()).collect();
        let known: Vec<&str> = names.iter().copied().filter(|n| ["VS Code", "GNOME Terminal", "Nemo", "Files", "Kitty", "XTerm", "Cursor"].contains(n)).collect();
        assert_eq!(&known[..2], ["VS Code", "GNOME Terminal"]);
        assert_eq!(*names.last().unwrap(), "Nemo");
        assert!(!names.contains(&"Files"), "only the default file manager is listed");

        let terminal = &found.iter().find(|(a, _)| a.name == "GNOME Terminal").unwrap().1;
        assert_eq!(terminal.exec[1], "--user", "the user's copy shadows the system's");
        let code = &found.iter().find(|(a, _)| a.name == "VS Code").unwrap();
        assert!(code.0.path.ends_with("system/applications/code.desktop"));
        assert_eq!(code.1.icon.as_deref(), Some("vscode"));

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    /// A user's `Hidden=true` override is the spec's "deleted": the system copy
    /// it shadows stays gone, and so does the binary on `PATH` behind both.
    #[test]
    fn a_hidden_entry_keeps_the_app_off_the_list() {
        let tmp = std::env::temp_dir().join(format!("dray-xdg-{}", uuid::Uuid::now_v7()));
        let (user, system) = (tmp.join("user"), tmp.join("system"));
        let sh = which("sh").unwrap();
        write(
            &system.join("applications/code.desktop"),
            &format!("[Desktop Entry]\nType=Application\nExec={} %F\n", sh.display()),
        );
        let on_path = |bin: &str| (bin == "code").then(|| PathBuf::from("/usr/bin/code"));
        let listed = |dirs: &[PathBuf]| {
            resolve(&scan(dirs), None, &on_path).iter().any(|(app, _)| app.name == "VS Code")
        };
        assert!(listed(&[user.clone(), system.clone()]));

        write(&user.join("applications/code.desktop"), "[Desktop Entry]\nType=Application\nHidden=true\n");
        assert!(!listed(&[user.clone(), system.clone()]));

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    /// `$TERMINAL` naming a known terminal keeps the program alone, so the
    /// table's own subcommand is not doubled; an unknown one keeps its words.
    #[test]
    fn terminal_from_the_environment() {
        let lookup = |bin: &str| Some(PathBuf::from(format!("/nonexistent/{bin}")));
        let (argv, term, name) = named_terminal("wezterm start", &lookup).unwrap();
        assert_eq!(argv, ["/nonexistent/wezterm"]);
        assert_eq!(term.dir, Some("start --cwd"));
        assert_eq!(name, "wezterm");

        let (argv, term, _) = named_terminal("myterm --hold", &lookup).unwrap();
        assert_eq!(argv, ["/nonexistent/myterm", "--hold"]);
        assert_eq!(term.exec, Some("-e"));
    }
}
