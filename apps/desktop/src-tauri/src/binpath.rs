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

use std::path::PathBuf;
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

/// The absolute path to `codex`, or the bare name as a last resort.
///
/// Falls back to the bare name like [`claude`] rather than answering `None`
/// like [`gh`], and the difference is who asked: a Codex session is one the
/// reader picked, so a spawn error naming the binary is the honest failure,
/// where `gh` is optional and its absence is a sentence in a panel.
pub async fn codex() -> PathBuf {
    if let Some(path) = CODEX_PATH.get() {
        return path.clone();
    }

    let resolved = match resolve("codex").await {
        Some(path) => path,
        None => {
            let bundled = PathBuf::from(CHATGPT_APP_CODEX);
            if is_executable(&bundled) {
                bundled
            } else {
                PathBuf::from("codex")
            }
        }
    };

    let _ = CODEX_PATH.set(resolved);
    CODEX_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("codex"))
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
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]
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

    // nvm keeps one bin directory per installed Node version, so the path
    // depends on which version is current — glob the versions rather than
    // guessing one.
    let versions = std::fs::read_dir(home.join(".nvm/versions/node")).ok()?;
    versions
        .flatten()
        .map(|entry| entry.path().join("bin").join(bin))
        .find(|candidate| is_executable(candidate))
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

    #[test]
    fn a_directory_is_not_executable() {
        assert!(!is_executable(&PathBuf::from("/usr")));
    }
}
