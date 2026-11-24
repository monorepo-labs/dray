//! Finding the `claude` binary when the app wasn't launched from a shell.
//!
//! A bundled `.app` started from Finder or the Dock inherits `launchd`'s
//! environment, not the user's. On macOS that means a `PATH` of roughly
//! `/usr/bin:/bin:/usr/sbin:/sbin` — none of which holds `claude`, which
//! installs to `~/.local/bin` or a node version manager's bin directory. So
//! `Command::new("claude")` resolves under `pnpm tauri dev` and fails from the
//! bundle, which is the same binary behaving differently by how it was started.
//!
//! Resolved once and reused: the login-shell probe below costs real time (a
//! shell reading the user's whole rc chain). Only Dray's own installs and the
//! `gh` recheck throw an answer away.

use crate::harness::Harness;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};
use tokio::process::Command;
use tokio::sync::Mutex;

/// One agent's resolved path. Not a `OnceCell`, so [`forget_agent`] can empty it
/// once Dray has installed that agent itself. The answer sits behind a std lock
/// that never waits on a resolve, so [`resolved_bin_dirs`] always sees it; the
/// async mutex only keeps two resolves of one agent from running at once.
struct Slot {
    path: RwLock<Option<PathBuf>>,
    resolving: Mutex<()>,
}

impl Slot {
    const fn new() -> Self {
        Slot { path: RwLock::new(None), resolving: Mutex::const_new(()) }
    }

    fn get(&self) -> Option<PathBuf> {
        self.path.read().unwrap().clone()
    }
}

static CLAUDE_PATH: Slot = Slot::new();
/// Not a [`Slot`] like the agents', because this one caches an
/// *absence* and that absence is what the reader is being asked to fix — see
/// [`forget_gh`].
static GH_PATH: RwLock<Option<Option<PathBuf>>> = RwLock::new(None);
/// Bumped by every [`forget_gh`], so a probe already running when the reader
/// installed `gh` cannot put its own miss back over the answer.
static GH_GENERATION: AtomicU64 = AtomicU64::new(0);
static CODEX_PATH: Slot = Slot::new();

/// The `codex` shipped inside the ChatGPT desktop app.
///
/// Tried after every ordinary location, never before: it is an implementation
/// detail of somebody else's bundle and Apple may move or drop it. But on a
/// machine with that app and no separate install it is the only `codex` there
/// is, and telling a reader who plainly has Codex that we cannot find it is the
/// worse answer of the two.
pub(crate) const CHATGPT_APP_CODEX: &str = "/Applications/ChatGPT.app/Contents/Resources/codex";

/// The absolute path to `claude`, or the bare name as a last resort.
///
/// Falling back to `"claude"` rather than erroring keeps the failure where it
/// already was — a spawn error naming the binary — instead of turning a
/// resolvable-by-PATH case we didn't predict into a hard stop.
pub async fn claude() -> PathBuf {
    cached(&CLAUDE_PATH, or_bare("claude")).await
}

/// The slot's answer, or `resolve`'s, kept for the life of the process.
///
/// A caller arriving mid-resolve waits on it rather than starting its own:
/// launch asks for every agent from several places at once, and a miss ends in
/// a login shell.
async fn cached(slot: &'static Slot, resolve: impl Future<Output = PathBuf>) -> PathBuf {
    if let Some(hit) = slot.get() {
        return hit;
    }
    let _resolving = slot.resolving.lock().await;
    if let Some(hit) = slot.get() {
        return hit;
    }
    let found = resolve.await;
    *slot.path.write().unwrap() = Some(found.clone());
    found
}

/// Forgets where `harness` is, so the next ask resolves it again. Called after
/// Dray installed it, or the miss cached before the install would stand until
/// the server restarts.
pub async fn forget_agent(harness: Harness) {
    let slot = match harness {
        Harness::ClaudeCode => &CLAUDE_PATH,
        Harness::Codex => &CODEX_PATH,
        Harness::Pi => &PI_PATH,
        Harness::Fx => &FX_PATH,
        Harness::Grok => &GROK_PATH,
        Harness::OpenCode => &OPENCODE_PATH,
        Harness::Other(_) => return,
    };
    // Waits out a resolve already running, or its pre-install miss lands after this.
    let _resolving = slot.resolving.lock().await;
    *slot.path.write().unwrap() = None;
    LOGIN_PATH_STALE.store(true, Ordering::Release);
}

/// Resolves `name`, or the bare name for [`claude`]'s reason.
async fn or_bare(name: &str) -> PathBuf {
    resolve(name).await.unwrap_or_else(|| PathBuf::from(name))
}

/// The absolute path to `gh`, or `None` where it isn't installed.
///
/// `None` rather than a bare-name fallback, unlike [`claude`]: `gh` is optional
/// here, and the caller turns a missing one into a line telling the reader to
/// install it. A spawn error naming the binary would be the same fact worded as
/// a crash.
///
/// The absence is cached too — the probe below costs a login shell and the PR
/// panel asks on every session — but unlike every other answer here it can be
/// thrown away, since [`forget_gh`] is how a reader who has just installed `gh`
/// gets an answer without restarting the app.
pub async fn gh() -> Option<PathBuf> {
    // Cloned out and the guard dropped before the probe: `resolve` awaits, and
    // a std guard must not be held across one.
    let cached = GH_PATH.read().unwrap().clone();
    if let Some(hit) = cached {
        return hit;
    }

    // Read before the probe, compared after it — the same bargain the issue
    // caches make with their own generation. A probe that started before
    // [`forget_gh`] is answering a question about the machine as it was, and
    // the reader has since installed the very binary it did not find: publish
    // it and the recheck they just made is undone by a read older than it.
    let generation = GH_GENERATION.load(Ordering::Acquire);
    let found = resolve("gh").await;

    // Resolved outside the lock: `resolve` spawns a login shell, and holding a
    // write guard across it would park every other caller behind it.
    let mut slot = GH_PATH.write().unwrap();
    if GH_GENERATION.load(Ordering::Acquire) == generation {
        *slot = Some(found.clone());
    }
    // Answered either way. The caller asked before the forget and this is the
    // honest answer to *their* question; only the cache has to refuse it.
    found
}

/// Forgets where `gh` is, so the next [`gh`] call probes again.
///
/// The PR panel's recheck button is the only caller: without it, installing the
/// CLI the panel just asked for changes nothing until the app is restarted, and
/// nothing on screen would say so.
///
/// Bumping under the same lock the value is written through is what makes the
/// refusal above stick: a probe cannot slip between the clear and the bump and
/// come back looking current.
pub fn forget_gh() {
    let mut slot = GH_PATH.write().unwrap();
    *slot = None;
    GH_GENERATION.fetch_add(1, Ordering::Release);
    LOGIN_PATH_STALE.store(true, Ordering::Release);
}

/// The absolute path to `boat`, or `None` where it isn't here. Asked again each
/// time rather than cached, and with no login shell: only a boat machine asks,
/// and a reader installing it mid-session should not need a restart.
#[cfg(feature = "desktop")]
pub fn boat() -> Option<PathBuf> {
    let installed = std::env::home_dir()?.join(".ascii/bin/boat");
    if is_executable(&installed) {
        return Some(installed);
    }
    search_path("boat").or_else(|| search_known_dirs("boat"))
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
    cached(&CODEX_PATH, resolve_codex()).await
}

async fn resolve_codex() -> PathBuf {
    for candidate in [search_path("codex"), search_known_dirs("codex")].into_iter().flatten() {
        if is_executable(&candidate) && speaks_app_server(&candidate).await {
            return candidate;
        }
    }
    // Only asked once the cheap candidates have failed, since it costs a login
    // shell where nothing else here has needed one.
    let late = login_shell_which("codex").await;
    // Last, because it belongs to somebody else's bundle — but present, because
    // on a machine with the ChatGPT app and no separate install it is the only
    // Codex there is.
    for candidate in late.into_iter().chain([PathBuf::from(CHATGPT_APP_CODEX)]) {
        if is_executable(&candidate) && speaks_app_server(&candidate).await {
            return candidate;
        }
    }

    PathBuf::from("codex")
}

static PI_PATH: Slot = Slot::new();

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
    cached(&PI_PATH, or_bare("pi")).await
}

static FX_PATH: Slot = Slot::new();

/// Where `fx` is, or the bare name as a last resort — [`claude`]'s shape.
/// Vercel's installer puts it in `~/.local/bin`, one of the known dirs.
pub async fn fx() -> PathBuf {
    cached(&FX_PATH, or_bare("fx")).await
}

static GROK_PATH: Slot = Slot::new();

/// Where `grok` is, or the bare name as a last resort — [`claude`]'s shape.
/// xAI's installer puts it in `~/.local/bin` and symlinks `~/.grok/bin/grok`
/// onto the same binary, so the known-dirs pass finds it before the login
/// shell is ever asked.
pub async fn grok() -> PathBuf {
    cached(&GROK_PATH, or_bare("grok")).await
}

static OPENCODE_PATH: Slot = Slot::new();

/// Where `opencode` is, or the bare name as a last resort — [`claude`]'s shape.
/// Its installer puts it in `~/.opencode/bin`, one of the known dirs.
pub async fn opencode() -> PathBuf {
    cached(&OPENCODE_PATH, or_bare("opencode")).await
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
        let mise = std::env::home_dir().unwrap().join(".local/share/mise/installs");
        println!("mise pi -> {:?}", super::find_versioned(&mise, 2, &["bin", "", "pi"], "pi"));
    }
}

/// Whether the agent's CLI is installed and usable.
///
/// Read off the resolver's own answer rather than probing again: each caches
/// in its slot, absence included, so this costs nothing after the first
/// call — which matters, since a failed resolution is the expensive one (it
/// ends in a login shell reading the whole rc chain).
///
/// **The test is `is_absolute`.** A successful resolution is always an absolute
/// path; the bare-name fallback every resolver ends at is the only relative
/// answer any of them can give. For Codex that covers the stale binary for free: one
/// with no `app-server` subcommand never satisfies `speaks_app_server`, so it
/// falls through to the bare name exactly like an absent one — and "installed
/// but cannot be driven" is the same answer to the reader as "not installed".
///
/// A CLI the reader installs by hand while the app runs still reads as missing
/// until restart; one Dray installs is forgotten by [`forget_agent`].
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
        Harness::Fx => fx().await,
        Harness::Grok => grok().await,
        Harness::OpenCode => opencode().await,
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
    let Ok(output) = command(bin)
        .arg("--help")
        .env("PATH", child_path(extra))
        .output()
        .await
    else {
        return false;
    };

    String::from_utf8_lossy(&output.stdout).contains("app-server")
}

/// The `dray` the reader's own shell runs, which a CLI installed with
/// `DRAY_INSTALL_DIR` can put ahead of the app's copy in `~/.local/bin`.
pub async fn shell_dray() -> Option<PathBuf> {
    login_shell_which("dray").await
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
        .flat_map(|dir| spellings(dir.join(bin)))
        .find(|candidate| is_executable(candidate))
}

/// The files a bare name can be: itself, or on Windows `claude.exe` and a
/// `.cmd` or `.bat` shim. Never the bare name there, since npm leaves a `sh`
/// script of that name beside the shim, which Windows cannot run.
#[cfg(unix)]
fn spellings(path: PathBuf) -> [PathBuf; 1] {
    [path]
}

#[cfg(windows)]
fn spellings(path: PathBuf) -> [PathBuf; 3] {
    [path.with_extension("exe"), path.with_extension("cmd"), path.with_extension("bat")]
}

/// A `Command` running `bin`. On Windows an npm `.cmd` shim is read and what
/// it launches is run directly — its `.exe`, or `node` on its script — since a
/// `.cmd` runs through cmd.exe, which cannot carry an argument with a newline:
/// Claude's `--append-system-prompt` failed to spawn or arrived cut.
pub fn command(bin: &Path) -> Command {
    #[cfg(windows)]
    if let Some((program, script)) = shim_target(bin) {
        let mut command = Command::new(program);
        command.args(script);
        return command;
    }
    Command::new(bin)
}

/// What an npm `.cmd` or `.bat` shim at `shim` launches: the program, and the
/// script to hand it where that is a `node` script. Both quote `%~dp0` paths
/// the same way, and neither can be spawned by `CreateProcess` directly.
#[cfg(windows)]
fn shim_target(shim: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    if !shim.extension().is_some_and(|e| {
        e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")
    }) {
        return None;
    }
    let text = std::fs::read_to_string(shim).ok()?;
    let dir = shim.parent()?;
    let target = shim_paths(&text)
        .into_iter()
        .rev()
        .map(|rel| dir.join(rel))
        .find(|p| !p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("node.exe")))?;
    let ext = target.extension()?.to_ascii_lowercase();
    if ext == "exe" {
        return Some((target, None));
    }
    if !["js", "cjs", "mjs"].contains(&ext.to_str()?) {
        return None;
    }
    // The shim's own rule: a `node.exe` beside it, else whichever is found.
    let node = Some(dir.join("node.exe"))
        .filter(|n| n.is_file())
        .or_else(|| search_path("node"))
        .or_else(|| node_dir().map(|d| d.join("node.exe")))
        .unwrap_or_else(|| PathBuf::from("node"));
    Some((node, Some(target)))
}

/// The paths a cmd-shim names relative to itself — every quoted
/// `%dp0%\…` or `%~dp0\…` — in the order written.
#[cfg_attr(not(windows), allow(dead_code))]
fn shim_paths(text: &str) -> Vec<String> {
    text.split('"')
        .skip(1)
        .step_by(2)
        .filter_map(|quoted| quoted.strip_prefix("%dp0%").or_else(|| quoted.strip_prefix("%~dp0")))
        .map(|rest| rest.trim_start_matches(['\\', '/']).to_string())
        .filter(|rest| !rest.is_empty())
        .collect()
}

/// Where a user-installed CLI tends to land.
#[cfg(windows)]
fn known_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::home_dir() else {
        return Vec::new();
    };
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    [
        // Claude Code's native installer, and `dray`'s own.
        Some(home.join(".local").join("bin")),
        // `npm install -g` lands its shims here.
        appdata.map(|a| a.join("npm")),
        local.as_ref().map(|l| l.join("pnpm")),
        Some(home.join(".bun").join("bin")),
        local.as_ref().map(|l| l.join("Microsoft").join("WinGet").join("Links")),
        // Git for Windows installed for this user alone: agent_updates.rs runs
        // vendor installers under its bash, and only `Git\cmd` reaches PATH.
        local.map(|l| l.join("Programs").join("Git").join("bin")),
        std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("nodejs")),
        std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("Git").join("cmd")),
        // Git's `sh`, which a routine's check runs through: the installer puts
        // only `Git\cmd` on `PATH`. Beside whichever `git` is found, else
        // the default install.
        git_bin().or_else(|| std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("Git").join("bin"))),
        std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("GitHub CLI")),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// `<Git>\bin` for the `git.exe` on the inherited `PATH`, which Git for
/// Windows keeps at `<Git>\cmd`.
#[cfg(windows)]
fn git_bin() -> Option<PathBuf> {
    let git = search_path("git")?;
    let root = git.parent()?.parent()?;
    let bin = root.join("bin");
    bin.join("sh.exe").is_file().then_some(bin)
}

/// Where a user-installed CLI tends to land.
#[cfg(unix)]
fn known_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::home_dir() else {
        return Vec::new();
    };

    vec![
        home.join(".local/bin"),
        home.join(".claude/local"),
        home.join(".bun/bin"),
        home.join(".npm-global/bin"),
        // OpenCode's own installer, which adds it to `PATH` from `.zshrc` alone.
        home.join(".opencode/bin"),
        // Managers whose shims run on their own, found by absolute path. asdf's
        // and mise's do not — one is a script calling `asdf`, the other refuses
        // a tool pinned in no config — so those are globbed by install below.
        home.join(".volta/bin"),
        // pnpm 11 moved global bins into `bin` under PNPM_HOME; older ones
        // sit flat in it. `pnpm setup` exports PNPM_HOME from `.zshrc`, which
        // the login-shell fallback never reads, so both have to be here.
        home.join("Library/pnpm/bin"),
        home.join("Library/pnpm"),
        home.join(".local/share/pnpm/bin"),
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
    // Read, never probed: this runs on the spawn path, and `gh`'s slot is the
    // one here that can be empty because nothing has asked yet.
    let gh = GH_PATH.read().unwrap().clone().flatten();
    [&CLAUDE_PATH, &CODEX_PATH, &PI_PATH, &FX_PATH, &GROK_PATH]
        .into_iter()
        .filter_map(Slot::get)
        .chain(gh)
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
    let home = std::env::home_dir()?;
    let candidates = known_dirs();

    if let Some(found) = candidates
        .iter()
        .flat_map(|dir| spellings(dir.join(bin)))
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
            .flat_map(|layout| spellings(version.join(layout).join(bin)))
            .find(|candidate| is_executable(candidate))
    })
}

/// Looks for `bin` on the user's login-shell `PATH`, which is the only way to
/// see one built by rc files the app never sourced.
async fn login_shell_which(bin: &str) -> Option<PathBuf> {
    // Held across the shell, so callers arriving mid-read wait for it.
    let mut slot = LOGIN_PATH.lock().await;
    if LOGIN_PATH_STALE.swap(false, Ordering::AcqRel) {
        *slot = None;
    }
    if slot.is_none() {
        *slot = Some(login_shell_path().await);
    }
    let path = slot.as_ref()?.as_ref()?;
    std::env::split_paths(path)
        .flat_map(|dir| spellings(dir.join(bin)))
        .find(|candidate| is_executable(candidate))
}

/// The login shell's `PATH`, read once for every binary. A shell per binary
/// was several of them from a Dock launch, each reading the whole rc chain.
static LOGIN_PATH: tokio::sync::Mutex<Option<Option<OsString>>> =
    tokio::sync::Mutex::const_new(None);
/// Set by [`forget_gh`]: an install that also added its directory to the
/// reader's rc files is only found by reading the `PATH` again.
static LOGIN_PATH_STALE: AtomicBool = AtomicBool::new(false);

/// Windows keeps no `PATH` in rc files: the machine's and the user's live in
/// the registry, and an installer that ran after Explorer started is only
/// there, not in what this process inherited.
#[cfg(windows)]
async fn login_shell_path() -> Option<OsString> {
    // PowerShell 7 installs as `pwsh` and need not leave `powershell` on PATH.
    for shell in ["powershell", "pwsh"] {
        let output = Command::new(shell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + \
                 [Environment]::GetEnvironmentVariable('Path','User')",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::platform::CREATE_NO_WINDOW)
            .output()
            .await;
        if let Ok(output) = output {
            if output.status.success() {
                return Some(String::from_utf8_lossy(&output.stdout).trim().into());
            }
        }
    }
    None
}

/// `-l` matters more than it looks: without it zsh reads `.zshrc` only, and a
/// `PATH` exported from `.zprofile` — where the installers write it — stays
/// invisible.
#[cfg(unix)]
async fn login_shell_path() -> Option<OsString> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    let mut cmd = Command::new(shell);
    // AppRun puts the AppImage's own usr/bin first on `PATH`, and the shell
    // keeps it, so `dray` could resolve to the app's own binary.
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    for (key, value) in crate::serve::appimage_env_undo() {
        match value {
            Some(value) => cmd.env(key, value),
            None => cmd.env_remove(key),
        };
    }
    let output = cmd
        // Behind a marker, since an rc file is free to print on its own.
        // `printenv` rather than `$PATH`, which fish expands as a list, and by
        // absolute path, since the `PATH` being read need not hold it.
        .args(["-l", "-c", "echo __DRAY_PATH__; /usr/bin/printenv PATH"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let out = String::from_utf8(output.stdout).ok()?;
    let (_, path) = out.rsplit_once("__DRAY_PATH__\n")?;
    Some(path.trim_end().into())
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

    /// A child's `PATH` reaches Git's `sh`, which only `Git\cmd` on the
    /// inherited one would not: every routine check runs through it.
    #[test]
    #[cfg(windows)]
    fn a_child_path_reaches_gits_sh() {
        if search_path("git").is_none() {
            return eprintln!("git not installed; skipping");
        }
        let out = std::process::Command::new("sh")
            .args(["-c", "echo ok"])
            .env("PATH", child_path(Vec::new()))
            .output()
            .expect("sh on the child's PATH");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }

    /// npm's two shim shapes as written on Windows: a native binary run
    /// straight, and a script run under `node`.
    #[test]
    fn reads_what_an_npm_shim_launches() {
        let exe = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";
        assert_eq!(shim_paths(exe), vec![r"node_modules\@anthropic-ai\claude-code\bin\claude.exe"]);
        let js = "IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
        assert_eq!(shim_paths(js).last().map(String::as_str), Some(r"node_modules\@openai\codex\bin\codex.js"));
    }

    /// A `.bat` launcher cannot be handed to `CreateProcess` either, so it goes
    /// through the same unwrap as npm's `.cmd` shims.
    #[test]
    #[cfg(windows)]
    fn unwraps_a_bat_shim() {
        let dir = std::env::temp_dir().join(format!("dray-bat-shim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("claude.bat");
        std::fs::write(
            &shim,
            "@ECHO off\r\n\"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.js\" %*\r\n",
        )
        .unwrap();

        let (program, script) = shim_target(&shim).expect("bat shim unwrapped");
        assert_eq!(script, Some(dir.join(r"node_modules\@anthropic-ai\claude-code\bin\claude.js")));
        assert!(program.ends_with("node.exe") || program == PathBuf::from("node"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

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

    /// The marker is what separates the `PATH` from anything an rc file
    /// prints, so a parse that lost it would find nothing through this path.
    #[tokio::test]
    #[cfg(unix)]
    async fn the_login_shell_path_finds_a_binary() {
        assert!(login_shell_which("sh").await.is_some_and(|p| p.is_absolute()));
    }

    /// mise's nesting is the layout that went missing: `installs/<tool>/<v>/`
    /// with the binary one level further in under the tool's own name.
    #[test]
    #[cfg(unix)]
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
    #[cfg(unix)]
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
}
