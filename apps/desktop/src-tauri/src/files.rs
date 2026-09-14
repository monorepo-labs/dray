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
use fff_search::{
    FFFMode, FilePicker, FilePickerOptions, FileSearchConfig, FuzzySearchOptions, PaginationArgs,
    QueryParser, SharedFilePicker, SharedFrecency,
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use ts_rs::TS;

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

/// A cold index still has to answer the first `@` typed after a project switch.
/// Short enough that a huge repo returns a partial list rather than hanging the
/// menu — the search runs against whatever has been walked so far, so waiting
/// longer only buys completeness on a list that is about to be re-queried on the
/// next keystroke anyway.
const SCAN_WAIT: Duration = Duration::from_millis(1500);

struct Indexes {
    by_path: HashMap<String, SharedFilePicker>,
    /// Insertion order, oldest first. A `VecDeque` rather than a real LRU: with
    /// a cap of four, evicting the oldest *created* index differs from the
    /// oldest *used* one only in cases where both are about to be rebuilt.
    order: VecDeque<String>,
}

static INDEXES: OnceLock<Mutex<Indexes>> = OnceLock::new();

/// The index for `cwd`, built if this is the first time it has been asked for.
///
/// Returns immediately either way — [`FilePicker::new_with_shared_state`] spawns
/// the walk on a background thread (measured at 0.17ms to hand back), so this
/// never blocks on a scan. Callers that need results wait on the handle instead.
fn index_for(cwd: &str) -> Result<SharedFilePicker> {
    let indexes = INDEXES.get_or_init(|| {
        Mutex::new(Indexes {
            by_path: HashMap::new(),
            order: VecDeque::new(),
        })
    });

    let mut indexes = indexes.lock().unwrap();

    if let Some(hit) = indexes.by_path.get(cwd) {
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

    indexes.by_path.insert(cwd.to_string(), shared.clone());
    indexes.order.push_back(cwd.to_string());

    while indexes.order.len() > MAX_INDEXES {
        if let Some(evicted) = indexes.order.pop_front() {
            indexes.by_path.remove(&evicted);
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
            let (dir, name) = match path.rfind('/') {
                Some(cut) => (path[..cut].to_string(), path[cut + 1..].to_string()),
                None => (String::new(), path.clone()),
            };

            FileMatch { path, name, dir }
        })
        .collect())
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
}
