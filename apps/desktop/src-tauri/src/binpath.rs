//! Finding the `claude` binary when the app wasn't launched from a shell.
//!
//! A bundled `.app` started from Finder or the Dock inherits `launchd`'s
//! environment, not the user's. On macOS that means a `PATH` of roughly
//! `/usr/bin:/bin:/usr/sbin:/sbin` — none of which holds `claude`, which
//! installs to `~/.local/bin` or a node version manager's bin directory. So
//! `Command::new("claude")` resolves under `pnpm tauri dev` and fails from the
//! bundle, which is the same binary behaving differently by how it was started.
//!
//! Resolved once into a `OnceLock` and reused: the login-shell probe below costs
//! real time (a shell reading the user's whole rc chain), and the answer can't
//! change while the app runs.

use crate::harness::Harness;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::process::Command;

static CLAUDE_PATH: OnceLock<PathBuf> = OnceLock::new();
static GH_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static CODEX_PATH: OnceLock<PathBuf> = OnceLock::new();

/// The `codex` shipped inside the ChatGPT desktop app.
///
/// Tried after every ordinary location, never before: it is an implementation
/// detail of somebody else's bundle and Apple may move or drop it. But on a
/// machine with that app and no separate install it is the only `codex` there
/// is, and telling a reader who plainly has Codex that we cannot find it is the
/// worse answer of the two.
const CHATGPT_APP_CODEX: &str = "/Applications/ChatGPT.app/Contents/Resources/codex";

/// The absolute path to `claude`, or the bare name as a last resort.
///
/// Falling back to `"claude"` rather than erroring keeps the failure where it
/// already was — a spawn error naming the binary — instead of turning a
/// resolvable-by-PATH case we didn't predict into a hard stop.
pub async fn claude() -> PathBuf {
    if let Some(path) = CLAUDE_PATH.get() {
        return path.clone();
    }

    let resolved = resolve("claude")
        .await
        .unwrap_or_else(|| PathBuf::from("claude"));

    // A race here is harmless: both threads resolved the same binary, and the
    // loser just drops its copy.
    let _ = CLAUDE_PATH.set(resolved);
    CLAUDE_PATH.get().cloned().unwrap_or_else(|| PathBuf::from("claude"))
}

/// The absolute path to `gh`, or `None` where it isn't installed.
///
/// `None` rather than a bare-name fallback, unlike [`claude`]: `gh` is optional
/// here, and the caller turns a missing one into a line telling the reader to
/// install it. A spawn error naming the binary would be the same fact worded as
/// a crash.
///
/// The answer is cached including its absence, so installing `gh` while the app
/// runs needs a restart — the same bargain the login-shell probe already makes.
pub async fn gh() -> Option<PathBuf> {
    if let Some(path) = GH_PATH.get() {
        return path.clone();
    }

    let resolved = resolve("gh").await;
    let _ = GH_PATH.set(resolved);
    GH_PATH.get().cloned().flatten()
}

/// The absolute path to a `codex` that can actually speak app-server.
///
/// Unlike [`claude`], finding *a* binary is not enough. Verified against a real
/// machine: an old `codex-cli 0.29.0` sitting in an nvm bin directory has no
/// `app-server` subcommand at all, so `codex app-server` is forwarded to the
/// interactive CLI as a *prompt*. It then writes terminal escape sequences to
/// stdout and never answers, which reaches the reader as a handshake timeout
/// thirty seconds later — a failure that names the wrong thing entirely and
/// looks like a broken protocol rather than a stale install.
///
/// So each candidate is asked what it can do before it is chosen, and the first
/// that lists `app-server` wins. One `--help` per candidate, once per process.
///
/// Falls back to the bare name like [`claude`] rather than answering `None`
/// like [`gh`]: a Codex session is one the reader picked, so a spawn error
/// naming the binary is the honest failure.
pub async fn codex() -> PathBuf {
    if let Some(path) = CODEX_PATH.get() {
        return path.clone();
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = search_path("codex") {
        candidates.push(path);
    }
    if let Some(path) = search_known_dirs("codex") {
        candidates.push(path);
    }
    if let Some(path) = login_shell_which("codex").await {
        candidates.push(path);
    }
    // Last, because it belongs to somebody else's bundle — but present, because
    // on a machine with the ChatGPT app and no separate install it is the only
    // Codex there is.
    candidates.push(PathBuf::from(CHATGPT_APP_CODEX));

    let mut resolved = None;
    for candidate in candidates {
        if resolved.as_ref() == Some(&candidate) {
            continue;
        }
        if is_executable(&candidate) && speaks_app_server(&candidate).await {
            resolved = Some(candidate);
            break;
        }
    }

    let _ = CODEX_PATH.set(resolved.unwrap_or_else(|| PathBuf::from("codex")));
    CODEX_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("codex"))
}

static PI_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Where `pi` is, or the bare name as a last resort — [`claude`]'s shape, and
/// for its reason.
///
/// **There is no version floor here, and one is coming.** pi below 0.80.6 does
/// not send `agent_settled`, which is the only line that closes a turn — so a
/// turn opens and never ends, the session sits `in_progress` forever with the
/// transcript complete on screen, and that reads as Dray being broken.
///
/// It is deliberately not a version compare. A number is a proxy for the
/// question actually worth asking, which is whether *this* pi answers the
/// commands Dray drives it with — and the model probe already has to spawn
/// `pi --mode rpc` and ask, so the real check costs nothing extra there and a
/// constant here would be a second thing to keep true.
pub async fn pi() -> PathBuf {
    if let Some(path) = PI_PATH.get() {
        return path.clone();
    }

    let resolved = resolve("pi").await.unwrap_or_else(|| PathBuf::from("pi"));

    let _ = PI_PATH.set(resolved);
    PI_PATH.get().cloned().unwrap_or_else(|| PathBuf::from("pi"))
}

#[cfg(test)]
mod pi_resolution_tests {
    /// Prints what the resolver found rather than asserting about this machine,
    /// so a `pi` that is installed and still not detected can be told apart
    /// from one that is genuinely absent. Ignored by default: the answer is a
    /// property of whoever is running it.
    #[tokio::test]
    #[ignore]
    async fn where_pi_resolves_to() {
        println!("pi -> {}", super::pi().await.display());
        // The mise branch alone, since any earlier hit hides it above.
        let mise = dirs::home_dir().unwrap().join(".local/share/mise/installs");
        println!("mise pi -> {:?}", super::find_versioned(&mise, 2, &["bin", "", "pi"], "pi"));
    }
}

/// Whether the agent's CLI is installed and usable.
///
/// Read off the resolver's own answer rather than probing again: both cache in
/// a `OnceLock`, absence included, so this costs nothing after the first call —
/// which matters, since a failed resolution is the expensive one (it ends in a
/// login shell reading the whole rc chain).
///
/// **The test is `is_absolute`.** A successful resolution is always an absolute
/// path; the bare-name fallback both resolvers end at is the only relative
/// answer either can give. For Codex that covers the stale binary for free: one
/// with no `app-server` subcommand never satisfies `speaks_app_server`, so it
/// falls through to the bare name exactly like an absent one — and "installed
/// but cannot be driven" is the same answer to the reader as "not installed".
///
/// The cache never invalidates, so a CLI installed while the app runs still
/// reads as missing until restart. That is the same bargain `gh` already makes,
/// and it is why nothing here offers to install anything: the reader is at a
/// terminal by then anyway.
pub async fn agent_available(harness: Harness) -> bool {
    harness.names_a_cli() && agent_installed(harness).await
}

/// Whether the CLI is on this machine, whether or not this build can drive it.
///
/// Split from [`agent_available`] because the two are different questions with
/// different cures, and folding them cost the reader the useful half: a pi that
/// is genuinely missing was reported as "Dray can't run pi yet", which names no
/// cure, while an installed one was never looked for at all.
pub async fn agent_installed(harness: Harness) -> bool {
    agent_binary(harness).await.is_absolute()
}

/// The resolved binary, for the callers that need to name it rather than spawn
/// it — the login launcher writes it into a shell script, where the bare name
/// would be looked up under launchd's `PATH` and not found.
///
/// A bare name is the one relative answer any of these resolvers gives, which
/// is what [`agent_installed`] reads to tell a resolved CLI from an absent one.
pub async fn agent_binary(harness: Harness) -> PathBuf {
    match harness {
        Harness::ClaudeCode => claude().await,
        Harness::Codex => codex().await,
        Harness::Pi => pi().await,
        // A harness only some other build knows. Its own spelling, which is
        // relative and so reads as "not installed" — the refusal has to happen
        // here rather than by falling back to Claude Code, which would run the
        // wrong agent in somebody's session.
        Harness::Other(name) => PathBuf::from(name),
    }
}

/// Whether this `codex` has an `app-server` subcommand.
///
/// Asked of `--help` rather than parsed out of `--version`, because a version
/// number is a guess about when the subcommand landed and this is the question
/// we actually have. A binary that cannot be run at all answers `false`, which
/// puts it behind the next candidate rather than failing the resolution.
async fn speaks_app_server(bin: &Path) -> bool {
    // The candidate's own dir and a `node` go on `PATH` for the same reason
    // the child's do: an npm codex is a `node` script, and this probe runs
    // before anything is cached for `resolved_bin_dirs` to hand back.
    let extra = bin
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .chain(node_dir().cloned())
        .collect();
    let Ok(output) = Command::new(bin)
        .arg("--help")
        .env("PATH", child_path(extra))
        .output()
        .await
    else {
        return false;
    };

    String::from_utf8_lossy(&output.stdout).contains("app-server")
}

/// Looks for `bin` on the inherited `PATH`, then in the usual install
/// locations, then by asking a login shell. Ordered by cost: the first two are
/// filesystem checks, the last spawns a shell that reads the user's rc files.
async fn resolve(bin: &str) -> Option<PathBuf> {
    if let Some(path) = search_path(bin) {
        return Some(path);
    }

    if let Some(path) = search_known_dirs(bin) {
        return Some(path);
    }

    login_shell_which(bin).await
}

/// Walks the `PATH` this process actually inherited. Covers `tauri dev` and any
/// launch from a terminal, where nothing further is needed.
fn search_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|candidate| is_executable(candidate))
}

/// Where a user-installed CLI tends to land.
///
/// Public because the spawn needs them for the *other* direction: a child
/// inherits this process's `PATH`, and a bundled `.app` launched from Finder
/// inherits launchd's, which holds none of these. So a `dray` the user has
/// installed is invisible to the agent unless these are put back — the same
/// failure this module exists to solve for `claude`, one layer out.
pub fn known_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };

    vec![
        home.join(".local/bin"),
        home.join(".claude/local"),
        home.join(".bun/bin"),
        home.join(".npm-global/bin"),
        // Managers whose shims run on their own, found by absolute path. asdf's
        // and mise's do not — one is a script calling `asdf`, the other refuses
        // a tool pinned in no config — so those are globbed by install below.
        home.join(".volta/bin"),
        home.join("Library/pnpm"),
        home.join(".local/share/pnpm"),
        home.join(".yarn/bin"),
        home.join(".n/bin"),
        // Nix keeps binaries in the store; these profile links are how they
        // reach a PATH. The second is home-manager's per-user profile.
        home.join(".nix-profile/bin"),
        PathBuf::from("/etc/profiles/per-user")
            .join(home.file_name().unwrap_or_default())
            .join("bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]
}

/// The directory each resolved CLI sits in, for the child's `PATH`.
///
/// An npm-installed CLI is a `#!/usr/bin/env node` script, and under a version
/// manager `node` lives beside it in a per-version `bin` that [`known_dirs`]
/// cannot name. Resolving the script and spawning it under launchd's `PATH`
/// then fails with `env: node: No such file or directory` — so whatever
/// directory a resolver landed in goes back to the child. Only cached answers
/// are read, and every spawn site resolves its own binary before building the
/// `PATH`, so the one it needs is always there.
///
/// A `node` found by the same walk goes with them, since it is not always a
/// sibling: mise's npm backend puts the CLI under `installs/npm-<pkg>` and
/// node under `installs/node`, proto puts globals one dir over from its node.
pub fn resolved_bin_dirs() -> Vec<PathBuf> {
    [CLAUDE_PATH.get(), CODEX_PATH.get(), PI_PATH.get()]
        .into_iter()
        .flatten()
        .chain(GH_PATH.get().into_iter().flatten())
        .filter(|path| path.is_absolute())
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .chain(node_dir().cloned())
        .collect()
}

static NODE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The `bin` holding a `node`, looked for exactly as the CLIs are but with no
/// shell probe — a `node` only the shell knows about is one the child would
/// see anyway if the shell's `PATH` were inherited, and it is not.
fn node_dir() -> Option<&'static PathBuf> {
    NODE_DIR
        .get_or_init(|| {
            search_path("node")
                .or_else(|| search_known_dirs("node"))
                .and_then(|node| node.parent().map(Path::to_path_buf))
        })
        .as_ref()
}

/// The `PATH` for a child this app spawns: the inherited one, then `extra`,
/// then [`known_dirs`] — each once. `extra` ahead of the fixed list, since a
/// CLI resolved out of a version manager wants *its* sibling `node`, not
/// whichever shim `~/.volta/bin` or `~/.n/bin` happens to hold.
pub fn child_path(extra: Vec<PathBuf>) -> String {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs = extra;
    dirs.extend(known_dirs());
    with_dirs(&inherited, dirs)
}

/// `inherited` with each of `extra` appended once, in order.
fn with_dirs(inherited: &std::ffi::OsStr, extra: Vec<PathBuf>) -> String {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(inherited).collect();

    for dir in extra {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }

    std::env::join_paths(dirs)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| inherited.to_string_lossy().into_owned())
}

/// The directories `claude` actually installs to, checked directly so the
/// common bundle launch never pays for a shell spawn. Not exhaustive by design
/// — [`login_shell_which`] is the general answer, this is the fast path.
fn search_known_dirs(bin: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = known_dirs();

    if let Some(found) = candidates
        .iter()
        .map(|dir| dir.join(bin))
        .find(|candidate| is_executable(candidate))
    {
        return Some(found);
    }

    // Version managers keep one directory per installed version, so the path
    // depends on which is current — glob the versions rather than guess one.
    // Each row: the root, how many directory levels sit between it and a
    // version, and where the binary lives relative to that version.
    let versioned: [(PathBuf, usize, &[&str]); 7] = [
        (home.join(".nvm/versions/node"), 1, &["bin"]),
        (home.join(".nodenv/versions"), 1, &["bin"]),
        (
            home.join("Library/Application Support/fnm/node-versions"),
            1,
            &["installation/bin"],
        ),
        (home.join(".local/share/fnm/node-versions"), 1, &["installation/bin"]),
        // installs/<tool>/<version>/bin — `<tool>` is `nodejs` for an `npm -g`
        // under an asdf node, or the plugin's own name.
        (home.join(".asdf/installs"), 2, &["bin"]),
        // tools/<tool>/<version>/bin; an `npm -g` under a proto node lands in
        // tools/node/globals/bin, which the same walk reaches.
        (home.join(".proto/tools"), 2, &["bin"]),
        // Same shape, but mise unpacks a release as it ships, so the binary
        // sits wherever the archive put it: `bin`, the version root, or one
        // level in under the tool's name (`installs/pi/latest/pi/pi`). Globbed
        // across every tool rather than `installs/<bin>`, since a CLI lands
        // under `node` (npm -g), its registry name (`claude`, `claude-code`,
        // `codex`) or `npm-<package>` depending on how it was asked for.
        (home.join(".local/share/mise/installs"), 2, &["bin", "", bin]),
    ];
    versioned
        .iter()
        .find_map(|(root, depth, layouts)| find_versioned(root, *depth, layouts, bin))
}

/// Looks for `bin` under every directory `depth` levels below `root`, trying
/// each layout as a path relative to it. A missing `root` is ordinary rather
/// than an error — most machines have at most one of these managers.
///
/// Walked in reverse lexical order so `latest` (mise's symlink) outranks any
/// numbered directory.
// ponytail: lexical, so 0.9 beats 0.10 — a semver sort if that ever bites.
fn find_versioned(root: &Path, depth: usize, layouts: &[&str], bin: &str) -> Option<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    for _ in 0..depth {
        dirs = dirs
            .iter()
            .filter_map(|dir| std::fs::read_dir(dir).ok())
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect();
    }
    dirs.sort();
    dirs.into_iter().rev().find_map(|version| {
        layouts
            .iter()
            .map(|layout| version.join(layout).join(bin))
            .find(|candidate| is_executable(candidate))
    })
}

/// Asks the user's login shell where `bin` is, which is the only way to see a
/// `PATH` built by rc files the app never sourced.
///
/// `-l` matters more than it looks: without it zsh reads `.zshrc` only, and a
/// `PATH` exported from `.zprofile` — where the installers write it — stays
/// invisible.
async fn login_shell_which(bin: &str) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    let output = Command::new(shell)
        .args(["-l", "-c", &format!("command -v {bin}")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let line = String::from_utf8(output.stdout).ok()?;
    // `command -v` prints the name unchanged for a shell builtin or function,
    // which is not something we can spawn.
    let path = PathBuf::from(line.trim());
    is_executable(&path).then_some(path)
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &std::path::Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The resolver must agree with the shell about where `claude` is. Skipped
    /// rather than failed where it isn't installed, so CI without the CLI stays
    /// green.
    #[tokio::test]
    async fn finds_the_claude_binary() {
        let Some(found) = resolve("claude").await else {
            eprintln!("claude not installed; skipping");
            return;
        };

        assert!(found.is_absolute(), "got a bare name: {found:?}");
        assert!(is_executable(&found));
    }

    /// A name that exists nowhere must resolve to nothing rather than to a
    /// path that fails only at spawn time.
    #[tokio::test]
    async fn a_missing_binary_resolves_to_none() {
        assert!(resolve("dray-definitely-not-a-real-binary").await.is_none());
    }

    /// mise's nesting is the layout that went missing: `installs/<tool>/<v>/`
    /// with the binary one level further in under the tool's own name.
    #[test]
    fn finds_a_binary_nested_under_a_version_dir() {
        let root = std::env::temp_dir().join("dray-binpath-versioned-test");
        let _ = std::fs::remove_dir_all(&root);
        let place = |rel: &str| {
            let bin = root.join(rel);
            std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
            std::fs::write(&bin, "").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            bin
        };
        let _numbered = place("pi/0.84.4/pi/pi");
        let latest = place("pi/latest/pi/pi");
        let under_node = place("node/22.0.0/bin/claude");

        let layouts: &[&str] = &["bin", "", "pi"];
        assert_eq!(find_versioned(&root, 2, layouts, "pi"), Some(latest));
        assert_eq!(find_versioned(&root, 2, &["bin"], "claude"), Some(under_node));
        assert_eq!(find_versioned(&root, 2, &["bin"], "pi"), None);
        assert_eq!(find_versioned(&root.join("nope"), 2, layouts, "pi"), None);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// launchd's `PATH` plus a CLI resolved out of a version manager's bin:
    /// that bin must be on the child's `PATH` — or the script's `env node`
    /// finds nothing — and ahead of the fixed list, or a `node` shim there
    /// wins over the sibling the CLI was installed against. Each dir once.
    #[test]
    fn a_resolved_bin_dir_comes_after_inherited_and_before_known() {
        let launchd = std::ffi::OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin");
        let nvm_bin = PathBuf::from("/home/u/.nvm/versions/node/v25.2.1/bin");
        let volta = PathBuf::from("/home/u/.volta/bin");

        let path = with_dirs(
            launchd,
            vec![PathBuf::from("/bin"), nvm_bin.clone(), nvm_bin, volta],
        );

        assert_eq!(
            path,
            "/usr/bin:/bin:/usr/sbin:/sbin:/home/u/.nvm/versions/node/v25.2.1/bin:/home/u/.volta/bin"
        );
    }

    /// An npm codex is a script whose interpreter sits beside it, and the probe
    /// runs before any cache could put that dir on `PATH`. A fake interpreter
    /// stands in for `node`; the probe passes only if the candidate's own dir
    /// was handed to it.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_app_server_probe_finds_the_interpreter_beside_the_candidate() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join("dray-binpath-probe-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = |name: &str, body: &str| {
            let path = dir.join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        script("dray-fake-node", "#!/bin/sh\necho 'codex app-server'\n");
        let codex = script("codex", "#!/usr/bin/env dray-fake-node\n");

        assert!(speaks_app_server(&codex).await);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_directory_is_not_executable() {
        assert!(!is_executable(&PathBuf::from("/usr")));
    }
}
