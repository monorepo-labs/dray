//! The file index behind the composer's `@` picker.
//!
//! An `@mention` needs no send path and no event mapping — verified against the
//! CLI, which expands `@path` out of the prompt itself and injects the file
//! before the model turn, emitting nothing on the wire. So the whole feature is
//! a picker, and a picker is only as good as the list behind it.
//!
//! That list comes from [`fff_search`], which indexes the tree once in the
//! background and answers from memory afterwards. The alternative — spawning
//! `git ls-files` or `fd` per keystroke — is the workflow it exists to beat:
//! measured on this repo, the whole index is built in 25ms and a query answers
//! in 0.4–2.2ms *unoptimized*, against ~15ms of process overhead for a single
//! spawn that then has to rank its own output.
//!
//! Three things come with it that a spawn-per-keystroke can't reproduce: typo
//! tolerance (`evnts.rs` finds `events/events.rs`), git-status and frecency
//! ranking, and a filesystem watcher — so unlike the slash-command cache next
//! door, this one keeps itself current and a file created mid-session shows up
//! without a restart.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fff_search::{
    FFFMode, FilePicker, FilePickerOptions, FileSearchConfig, FuzzySearchOptions, PaginationArgs,
    QueryParser, SharedFilePicker, SharedFrecency,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use ts_rs::TS;

use crate::attachments::{image_mime, MAX_IMAGE_BYTES};
use crate::docs::{file_len, read_file_capped, TOO_LARGE};
use crate::Fail;

/// One row in the picker. `path` is relative to the indexed directory, which is
/// also what gets typed into the prompt — the CLI resolves `@path` against the
/// same cwd the child was spawned in, so no rewriting is needed on either side.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub path: String,
    /// The last segment, split out so the row can weight the name over the
    /// directory rather than making the reader find it inside the path.
    pub name: String,
    /// Everything before `name`, without a trailing slash. Empty at the root.
    pub dir: String,
}

/// How many indexes are kept alive at once.
///
/// Each one is resident memory (tens of MB on a large repo) plus a filesystem
/// watcher, so this cannot be the unbounded per-directory map the command cache
/// is. Four covers switching between a handful of projects without rebuilding,
/// and dropping a picker cancels its background threads on its own — the crate
/// flips a `cancelled` flag on drop and the workers exit at their next
/// checkpoint, so eviction needs no teardown of ours.
const MAX_INDEXES: usize = 4;

/// How long an index outlives its last use. Each one holds a recursive FSEvents
/// watch — which on a project root covers every `.claude/worktrees` build dir
/// under it — and a debouncer thread that wakes every 25ms whether anything
/// changed or not, so a kept index is idle work for the life of the process.
/// Rebuilding costs one walk (25ms on this repo) on the next `@`.
const IDLE_DROP: Duration = Duration::from_secs(10 * 60);

/// A cold index still has to answer the first `@` typed after a project switch.
/// Short enough that a huge repo returns a partial list rather than hanging the
/// menu — the search runs against whatever has been walked so far, so waiting
/// longer only buys completeness on a list that is about to be re-queried on the
/// next keystroke anyway.
const SCAN_WAIT: Duration = Duration::from_millis(1500);

/// Each index beside when it was last asked for, keyed by directory.
static INDEXES: OnceLock<Mutex<HashMap<String, (SharedFilePicker, Instant)>>> = OnceLock::new();

/// The index for `cwd`, built if this is the first time it has been asked for.
///
/// Returns immediately either way — [`FilePicker::new_with_shared_state`] spawns
/// the walk on a background thread (measured at 0.17ms to hand back), so this
/// never blocks on a scan. Callers that need results wait on the handle instead.
fn index_for(cwd: &str) -> Result<SharedFilePicker> {
    let indexes = INDEXES.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("file-index-reaper".into())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_secs(60));
                if let Some(indexes) = INDEXES.get() {
                    indexes.lock().unwrap().retain(|_, (_, used)| used.elapsed() < IDLE_DROP);
                }
            });
        Mutex::new(HashMap::new())
    });

    let mut indexes = indexes.lock().unwrap();

    if let Some((hit, used)) = indexes.get_mut(cwd) {
        *used = Instant::now();
        return Ok(hit.clone());
    }

    let shared = SharedFilePicker::default();
    FilePicker::new_with_shared_state(
        shared.clone(),
        // No frecency database. The crate's own tracker is an LMDB store keyed
        // to its host editor's access log, and this app has nothing to write
        // into it — a file opened in the changes panel is not a file the user
        // reached for. Git status and path scoring do the ranking instead,
        // which is what puts the turn's own edits at the top of an empty query.
        SharedFrecency::noop(),
        FilePickerOptions {
            base_path: cwd.to_string(),
            // The picker outlives any one search, so a stale list is the failure
            // to avoid: with this on, a file the agent just wrote is mentionable
            // without a restart.
            watch: true,
            // Scoring tuned for an agent's paths rather than an editor's
            // buffers. `Neovim` is the crate's default and weights recency of
            // *editing* far higher, which this app cannot feed.
            mode: FFFMode::Ai,
            ..Default::default()
        },
    )
    .context("couldn't start indexing the project's files")?;

    indexes.insert(cwd.to_string(), (shared.clone(), Instant::now()));

    while indexes.len() > MAX_INDEXES {
        let oldest = indexes
            .iter()
            .min_by_key(|(_, (_, used))| *used)
            .map(|(path, _)| path.clone());
        if let Some(oldest) = oldest {
            indexes.remove(&oldest);
        }
    }

    Ok(shared)
}

/// Starts indexing `cwd` without waiting for it.
///
/// Called when the app learns which directory the composer is pointed at, so the
/// walk overlaps with the user typing their prompt rather than starting on the
/// keystroke that opens the picker. Purely an optimization: [`search_files`]
/// builds the index itself if this was never called.
#[tauri::command]
pub async fn warm_file_index(cwd: String) -> Result<(), Fail> {
    tokio::task::spawn_blocking(move || index_for(&cwd))
        .await
        .map_err(anyhow::Error::from)??;
    Ok(())
}

/// Fuzzy file search for the `@` picker.
///
/// On `spawn_blocking` because the index is synchronous throughout — the search
/// holds a `parking_lot` read guard across the whole scoring pass, which is not
/// something that may be held across an await point.
#[tauri::command]
pub async fn search_files(cwd: String, query: String, limit: usize) -> Result<Vec<FileMatch>, Fail> {
    Ok(tokio::task::spawn_blocking(move || search(&cwd, &query, limit))
        .await
        .map_err(anyhow::Error::from)??)
}

/// The best `limit` matches for `query` in `cwd`, best first.
///
/// An empty query is not a special case in the crate and is not one here: it
/// scores every file alike and the ranking falls through to git status and path
/// depth, which surfaces the files the current turn has been touching. That is
/// the right list to open a bare `@` on, so it is deliberately not replaced with
/// an alphabetical dump.
fn search(cwd: &str, query: &str, limit: usize) -> Result<Vec<FileMatch>> {
    let shared = index_for(cwd)?;

    // Only costs anything while the first scan is still running; afterwards the
    // flag is already clear and this returns at once. Its result is ignored on
    // purpose — a scan still in flight has a partial list, and a partial list is
    // a better answer than none.
    shared.wait_for_scan(SCAN_WAIT);

    let guard = shared.read().map_err(|e| anyhow::anyhow!("{e}"))?;
    let picker = guard
        .as_ref()
        .context("the file index was torn down mid-search")?;

    let parser = QueryParser::new(FileSearchConfig::default());
    let parsed = parser.parse(query);

    let result = picker.fuzzy_search(
        &parsed,
        None,
        FuzzySearchOptions {
            pagination: PaginationArgs { offset: 0, limit },
            ..Default::default()
        },
    );

    Ok(result
        .items
        .iter()
        .map(|item| {
            let path = item.relative_path(picker);
            // Split here rather than in the frontend: the crate already knows
            // where the last segment starts, and a path is bytes the UI should
            // not be re-parsing to draw a row.
            let (dir, name) = match path.rsplit_once('/') {
                Some((dir, name)) => (dir.to_string(), name.to_string()),
                None => (String::new(), path.clone()),
            };

            FileMatch { path, name, dir }
        })
        .collect())
}

/// One row in the Files view's tree.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Relative to the session's directory, `/`-joined. The key the tree caches
    /// its listings under and the one it expands on, so it is the whole of what
    /// a row has to carry back.
    pub path: String,
    pub is_dir: bool,
    /// Dimmed rather than hidden, the way VS Code draws one.
    pub ignored: bool,
}

/// Dropped from every listing: VS Code's `files.exclude` defaults, and nothing
/// else. `node_modules` and `target` list like any other directory — the ignore
/// flag is what says they are not the reader's own work, and hiding them
/// outright would make the view lie about what is on disk.
const HIDDEN: &[&str] = &[".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"];

/// Past this a file is refused rather than read. Four times the doc panel's cap
/// and for a different reason: a lockfile is the file most likely opened here,
/// and the renderer already falls back to plain text past 100KB, so the cost of
/// a big one is scrolling rather than freezing.
const MAX_FILE: u64 = 4 << 20;

/// One directory's entries, directories first and then case-insensitive by
/// name — which is VS Code's order, and the one anybody arriving from an editor
/// reads without being told.
///
/// `dir` is relative to `cwd`, empty for the root. A directory that cannot be
/// read answers with the reason, since the tree has a row to draw it in.
#[tauri::command]
pub async fn list_dir(cwd: String, dir: String) -> Result<Vec<DirEntry>, String> {
    let target = if dir.is_empty() {
        Path::new(&cwd).to_path_buf()
    } else {
        Path::new(&cwd).join(&dir)
    };

    let mut reader = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if HIDDEN.contains(&name.as_str()) {
            continue;
        }

        // Read off the link's *target*, so a symlinked directory expands like
        // any other and a broken link lists as a file rather than as a folder
        // that answers nothing when opened.
        let is_dir = tokio::fs::metadata(entry.path())
            .await
            .map(|meta| meta.is_dir())
            .unwrap_or(false);

        let path = if dir.is_empty() {
            name.clone()
        } else {
            format!("{dir}/{name}")
        };

        entries.push(DirEntry {
            name,
            path,
            is_dir,
            ignored: false,
        });
    }

    sort_entries(&mut entries);
    mark_ignored(&cwd, &mut entries).await;
    Ok(entries)
}

/// Directories first, then case-insensitive by name, with the raw name as the
/// tie-break so two entries differing only in case keep a stable order.
fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// Flags the entries git ignores, in one spawn for the whole listing.
///
/// `check-ignore` answers nested `.gitignore`s, `.git/info/exclude` and the
/// user's global ignore together, which is why this is a process rather than
/// the single-file matcher the `ignore` crate already in the lock file offers.
/// Exit 1 means "none of them", which is an answer; only a directory that is no
/// repository, or a git that will not run, leaves every flag as it was — and
/// nothing dimmed is the right picture there.
async fn mark_ignored(cwd: &str, entries: &mut [DirEntry]) {
    if entries.is_empty() {
        return;
    }

    let mut input = String::new();
    for entry in entries.iter() {
        input.push_str(&entry.path);
        input.push('\0');
    }

    let Ok(mut child) = Command::new("git")
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(cwd)
        // A listing shouldn't contend with a background index refresh.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };

    // Written from its own task, since git streams its answer as it reads: on a
    // directory big enough to fill both pipes, writing the whole input first
    // and only then draining stdout is a deadlock. The pipe is dropped at the
    // end of the task, which is what lets git see EOF and exit.
    let mut pipe = child.stdin.take();
    let writing = tokio::spawn(async move {
        if let Some(mut pipe) = pipe.take() {
            let _ = pipe.write_all(input.as_bytes()).await;
        }
    });

    let out = child.wait_with_output().await;
    let _ = writing.await;

    let Ok(out) = out else { return };
    let ignored: HashSet<&str> = std::str::from_utf8(&out.stdout)
        .unwrap_or_default()
        .split('\0')
        .filter(|line| !line.is_empty())
        .collect();

    for entry in entries.iter_mut() {
        entry.ignored = ignored.contains(entry.path.as_str());
    }
}

/// What the viewer draws, or the sentence saying why it draws nothing.
///
/// No `unknown` catch-all, unlike the persisted types: this never reaches disk,
/// so an older build can never be asked to read a shape it has not heard of.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileBody {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        /// A `data:` URL rather than a path: the asset protocol is scoped to
        /// the attachments directory and must stay scoped, so a file anywhere
        /// else has no URL the webview can fetch.
        data_url: String,
    },
    /// The path itself, for `convertFileSrc`. A video is far too big for a
    /// `data:` URL and needs Range requests to seek, which the asset protocol
    /// serves — so `read_file` allows this one file on that protocol instead.
    Video {
        path: String,
    },
}

const NOT_TEXT: &str = "Not text — nothing to show.";

/// Reads one file for the viewer, or names why it can't.
///
/// A video is allowed on the asset protocol by its exact, canonical path. The
/// scope grows by the files the reader opens and nothing else, for the life of
/// the process — Tauri has no way to take a grant back — and this command
/// already hands the webview any file under the cap, so streaming one the
/// reader asked for widens nothing a page could not already read.
#[tauri::command]
pub async fn read_file(app: tauri::AppHandle, path: String) -> Result<FileBody, String> {
    let body = read_body(&path).await?;
    if let FileBody::Video { path } = &body {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| e.to_string())?;
    }
    Ok(body)
}

/// `read_doc`'s three checks — metadata first, a capped read, UTF-8 refused
/// rather than mangled — against a larger cap. Media is answered before the
/// size check, since its bytes are never text and its cap is its own.
async fn read_body(path: &str) -> Result<FileBody, String> {
    // Judged on the link's target, or `secret.mp4` pointing at a database
    // would stream it whole past the cap. Canonical is also what the protocol
    // matches against, since it resolves links before it checks.
    if let Ok(real) = tokio::fs::canonicalize(path).await {
        if is_video(&real) {
            let real = real.to_string_lossy().into_owned();
            file_len(&real).await?;
            return Ok(FileBody::Video { path: real });
        }
    }

    let image = viewable_image(Path::new(path));
    let cap = if image.is_some() { MAX_IMAGE_BYTES } else { MAX_FILE };
    let bytes = match read_file_capped(path, cap).await {
        // Too large and not text: the second is the reason worth naming, since
        // no cap would ever make a zip readable here.
        Err(e) if e == TOO_LARGE && image.is_none() && looks_binary(path).await => {
            return Err(NOT_TEXT.to_string())
        }
        other => other?,
    };

    if let Some(mime) = image {
        return Ok(FileBody::Image {
            data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        });
    }

    String::from_utf8(bytes)
        .map(|text| FileBody::Text { text })
        .map_err(|_| NOT_TEXT.to_string())
}

/// Git's own test: a NUL in the first 8000 bytes means binary.
async fn looks_binary(path: &str) -> bool {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return false;
    };
    let mut head = Vec::new();
    file.take(8000).read_to_end(&mut head).await.is_ok() && head.contains(&0)
}

/// The containers WKWebView plays. By extension, as images are.
fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "m4v" | "mov" | "webm"))
}

/// The image types this view draws.
///
/// [`image_mime`]'s table is the *model's* — what the API accepts as an image
/// block — plus SVG, which the API refuses and a webview renders perfectly
/// well. Kept as one extra arm rather than a second table, so a type added for
/// the composer arrives here too.
fn viewable_image(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext == "svg" {
        return Some("image/svg+xml");
    }
    image_mime(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The repo this crate lives in, which is guaranteed to be a git checkout
    /// with a known layout — so these assert against real paths rather than a
    /// fixture tree that would have to be built and torn down per test.
    fn repo() -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    /// Typo tolerance is the reason for the dependency, so it is the thing worth
    /// pinning: a transposed and a dropped character both still land the file.
    #[test]
    fn finds_a_file_through_a_typo() {
        let hits = search(&repo(), "evnts.rs", 10).unwrap();
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();

        assert_eq!(
            paths.first(),
            Some(&"src-tauri/src/events/events.rs"),
            "got {paths:?}"
        );
    }

    /// A query carrying a separator has to match against the whole relative
    /// path, not just the filename — that is how a reader disambiguates two
    /// files with the same name in different directories.
    ///
    /// The *shape* is asserted, not one filename. Naming a file made the test
    /// hostage to which files exist: a second `composer/Model…` landing in the
    /// tree scored the same and sorted ahead of it, failing a test about
    /// separators for a reason that had nothing to do with them.
    #[test]
    fn matches_on_a_path_segment() {
        let hits = search(&repo(), "composer/Model", 5).unwrap();
        let top = hits.first().map(|h| h.path.as_str()).unwrap_or_default();

        assert!(
            top.starts_with("src/components/composer/Model"),
            "got {hits:?}"
        );
    }

    /// The walk honours ignore rules, which is what keeps `node_modules` and
    /// `target` out of a picker that would otherwise be nothing else.
    #[test]
    fn ignored_directories_are_not_indexed() {
        let hits = search(&repo(), "node_modules", 20).unwrap();

        assert!(
            hits.iter().all(|h| !h.path.contains("node_modules/")),
            "got {hits:?}"
        );
    }

    /// `dir` is split off `path` rather than sent as a second copy of it, so a
    /// root-level file has to come back with an empty one and not a stray "/".
    #[test]
    fn splits_the_directory_off_the_name() {
        let hits = search(&repo(), "index.html", 5).unwrap();
        let root = hits.iter().find(|h| h.path == "index.html").unwrap();

        assert_eq!(root.name, "index.html");
        assert_eq!(root.dir, "");

        let nested = search(&repo(), "src/lib/slash.ts", 5)
            .unwrap()
            .into_iter()
            .find(|h| h.path == "src/lib/slash.ts")
            .unwrap();

        assert_eq!(nested.name, "slash.ts");
        assert_eq!(nested.dir, "src/lib");
    }

    /// An empty query is a real query, and its ranking is the whole reason a
    /// bare `@` opens on something useful. Asserts only that it answers with
    /// real files — *which* files depends on the working tree's git status,
    /// which a test has no business pinning.
    #[test]
    fn an_empty_query_still_lists_files() {
        let hits = search(&repo(), "", 8).unwrap();

        assert_eq!(hits.len(), 8, "got {hits:?}");
        assert!(hits.iter().all(|h| !h.name.is_empty()));
    }

    /// The second call must reuse the index rather than rebuilding it — that is
    /// the entire performance argument, and a regression would be invisible
    /// except as a slow picker.
    #[test]
    fn the_index_is_reused_across_searches() {
        let repo = repo();
        search(&repo, "slash", 5).unwrap();

        let started = std::time::Instant::now();
        search(&repo, "mention", 5).unwrap();

        assert!(
            started.elapsed() < Duration::from_millis(200),
            "second search took {:?}, so the index was rebuilt",
            started.elapsed()
        );
    }

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dray-files-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Directories first, then case-insensitively by name — the order is the
    /// whole of what a tree's rows are arranged by, and a plain byte sort puts
    /// every capital ahead of every lowercase name.
    #[tokio::test]
    async fn lists_directories_first_then_by_name_ignoring_case() {
        let dir = scratch();
        for name in ["beta.txt", "Alpha.txt", "zed.txt"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        for name in ["src", "Assets"] {
            std::fs::create_dir(dir.join(name)).unwrap();
        }

        let entries = list_dir(dir.to_str().unwrap().into(), String::new())
            .await
            .unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert_eq!(names, ["Assets", "src", "Alpha.txt", "beta.txt", "zed.txt"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The exclusion list is what keeps a repository's own plumbing out of a
    /// tree of the reader's files. Nothing else is hidden — `node_modules` is
    /// dimmed, not dropped.
    #[tokio::test]
    async fn drops_the_vcs_directory_and_the_desktop_droppings() {
        let dir = scratch();
        std::fs::create_dir(dir.join(".git")).unwrap();
        std::fs::create_dir(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join(".DS_Store"), "x").unwrap();
        std::fs::write(dir.join("Thumbs.db"), "x").unwrap();
        std::fs::write(dir.join("keep.txt"), "x").unwrap();

        let entries = list_dir(dir.to_str().unwrap().into(), String::new())
            .await
            .unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert_eq!(names, ["node_modules", "keep.txt"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The flag is read from git itself, so this asserts against a real
    /// `.gitignore` in a real repository rather than against a matcher of ours.
    #[tokio::test]
    async fn flags_what_git_ignores() {
        let dir = scratch();
        let cwd = dir.to_str().unwrap().to_string();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&cwd)
            .status()
            .is_ok_and(|s| s.success()));
        std::fs::write(dir.join(".gitignore"), "build/\n*.log\n").unwrap();
        std::fs::create_dir(dir.join("build")).unwrap();
        std::fs::write(dir.join("run.log"), "x").unwrap();
        std::fs::write(dir.join("keep.txt"), "x").unwrap();

        let entries = list_dir(cwd, String::new()).await.unwrap();
        let ignored: Vec<&str> = entries
            .iter()
            .filter(|e| e.ignored)
            .map(|e| e.name.as_str())
            .collect();

        assert_eq!(ignored, ["build", "run.log"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The cap is the whole of what stops the viewer pulling a multi-gigabyte
    /// file across the bridge, and a file one byte over it has to be refused
    /// rather than truncated into something that reads as the file.
    #[tokio::test]
    async fn refuses_a_file_over_the_cap() {
        let dir = scratch();
        let path = dir.join("huge.txt");
        std::fs::write(&path, vec![b'a'; MAX_FILE as usize + 1]).unwrap();

        assert!(read_body(path.to_str().unwrap()).await.is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// An image is bytes, so it must never reach the UTF-8 branch — and an SVG
    /// is an image here though the composer's own table calls it a file.
    #[tokio::test]
    async fn reads_an_image_as_a_data_url() {
        let dir = scratch();
        let png = dir.join("shot.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let svg = dir.join("mark.svg");
        std::fs::write(&svg, "<svg/>").unwrap();

        let body = read_body(png.to_str().unwrap()).await.unwrap();
        let FileBody::Image { data_url } = body else {
            panic!("a png read as text");
        };
        assert!(data_url.starts_with("data:image/png;base64,"), "{data_url}");

        let body = read_body(svg.to_str().unwrap()).await.unwrap();
        assert!(
            matches!(body, FileBody::Image { data_url } if data_url.starts_with("data:image/svg+xml;base64,")),
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A video past the text cap still plays, and a binary past it says it
    /// is not text rather than blaming its size — the two ways the viewer used
    /// to refuse a video with the wrong sentence.
    #[tokio::test]
    async fn answers_a_large_file_by_kind_not_size() {
        let dir = scratch();
        let big = vec![0u8; MAX_FILE as usize + 1];
        let mov = dir.join("clip.MOV");
        std::fs::write(&mov, &big).unwrap();
        let zip = dir.join("bundle.zip");
        std::fs::write(&zip, &big).unwrap();

        let real = std::fs::canonicalize(&mov).unwrap();
        let body = read_body(mov.to_str().unwrap()).await.unwrap();
        assert!(matches!(body, FileBody::Video { path } if path == real.to_str().unwrap()));
        assert_eq!(read_body(zip.to_str().unwrap()).await.unwrap_err(), NOT_TEXT);

        // A video name on a link is not a video: the target decides.
        let link = dir.join("secret.mp4");
        std::os::unix::fs::symlink(&zip, &link).unwrap();
        assert_eq!(read_body(link.to_str().unwrap()).await.unwrap_err(), NOT_TEXT);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Bytes that are not text are refused rather than mangled, the reading
    /// `read_doc` takes — `from_utf8_lossy` would draw a confident view of a
    /// file that never existed.
    #[tokio::test]
    async fn refuses_bytes_that_are_not_text() {
        let dir = scratch();
        let path = dir.join("blob.bin");
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();

        assert!(read_body(path.to_str().unwrap()).await.is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
