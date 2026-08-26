use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::SystemTime,
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::{fs, io::AsyncWriteExt, process::Command};
use ts_rs::TS;
use uuid::Uuid;

/// What the composer's branch picker needs to render and guard itself.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    /// `None` on a detached HEAD, and for a directory that isn't a repo.
    pub current: Option<String>,
    pub branches: Vec<String>,
    /// What a `-w` worktree forks from, resolved the way the CLI resolves it.
    /// Shown in place of the branch picker in worktree mode, where the picked
    /// branch has no effect. `None` when the repo has no remote.
    pub default_base: Option<String>,
    /// Uncommitted changes, counted for the switch dialog's "you have N
    /// changes". Zero switches without asking.
    pub dirty: u32,
}

/// Runs git in `cwd` and returns stdout, or `None` on any non-zero exit.
/// A missing binary or a non-repo directory is a normal outcome here, not an
/// error worth propagating — see [`list_branches`].
async fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        // A branch poll shouldn't contend with a background index refresh.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .await
        .ok()?;

    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Local branches, the current one, and whether the tree is dirty.
///
/// A directory that isn't a repo reads as an empty list rather than an error:
/// the user is allowed to attach any folder, and the picker hides itself when
/// there are no branches.
pub async fn list_branches(cwd: &str) -> Result<BranchList> {
    // `for-each-ref` is plumbing; `git branch` decorates the current entry with
    // `* ` and can paginate or colorize depending on the user's config.
    let Some(raw) = git(
        cwd,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .await
    else {
        return Ok(BranchList::default());
    };

    let current = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        // Detached HEAD reports the literal string rather than a branch name.
        .filter(|s| !s.is_empty() && s != "HEAD");

    let dirty = git(cwd, &["status", "--porcelain"])
        .await
        .map_or(0, |s| count_changes(&s));

    Ok(BranchList {
        current,
        branches: parse_branches(&raw),
        default_base: default_base(cwd).await,
        dirty,
    })
}

/// The ref a `-w` worktree forks from. Mirrors the CLI's own resolution, which
/// reads `origin/HEAD` and falls back through `origin/main` then `origin/master`
/// — so the composer names the same commit the CLI will actually use.
///
/// A repo with no remote returns `None`: the CLI's last resort is the literal
/// string `main`, which it then fails to `rev-parse`, and claiming a base that
/// can't resolve would be worse than saying nothing.
async fn default_base(cwd: &str) -> Option<String> {
    if let Some(head) = git(cwd, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Some(head);
    }

    for candidate in ["origin/main", "origin/master"] {
        if git(cwd, &["rev-parse", "--verify", "-q", candidate])
            .await
            .is_some()
        {
            return Some(candidate.to_string());
        }
    }

    None
}

/// Checks out an existing branch. No `-b`, no `-f`: this only moves between
/// branches that already exist, and never discards work to do it.
///
/// `stash` shelves uncommitted changes first and does **not** pop them on the
/// far side — the entry stays in `git stash list` for the user to apply when
/// they choose. Popping automatically would surprise whoever switches back.
///
/// Called from the composer's branch picker, never with a child running: only
/// a new session can pick a branch, so nothing is reading the tree as it moves.
pub async fn checkout_branch(cwd: &str, branch: &str, stash: bool) -> Result<()> {
    let list = list_branches(cwd).await?;

    // Membership is also the injection guard: no shell is involved, but a name
    // beginning with `-` would be read as a flag. Checking against the branches
    // git just reported is simpler than escaping rules and closes the same hole.
    if !list.branches.iter().any(|b| b == branch) {
        bail!("no such branch: {branch}");
    }

    if list.current.as_deref() == Some(branch) {
        return Ok(());
    }

    if stash {
        // Named so the entry is recognizable in `git stash list` weeks later,
        // next to whatever the user stashed by hand.
        let msg = format!("dray: switching to {branch}");
        run(cwd, &["stash", "push", "--include-untracked", "-m", &msg]).await?;
    }

    // Bare `checkout` carries uncommitted changes across when the file is
    // identical on both branches, and refuses when it isn't. That refusal is
    // the whole safety story here, so it must not be forced away.
    run(cwd, &["checkout", branch]).await
}

/// Runs git and turns a non-zero exit into an error carrying git's own stderr,
/// which names the conflicting files — the part the user needs to act on.
async fn run(cwd: &str, args: &[&str]) -> Result<()> {
    run_with(cwd, &[], args).await
}

/// [`run`] with environment overrides. Split out for `GIT_LITERAL_PATHSPECS`,
/// which the commit path sets and nothing else wants.
async fn run_with(cwd: &str, envs: &[(&str, &str)], args: &[&str]) -> Result<()> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    for (key, value) in envs {
        cmd.env(key, value);
    }

    let out = cmd.output().await?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!(if err.is_empty() {
            format!("git {} failed", args[0])
        } else {
            err
        });
    }

    Ok(())
}

/// Porcelain prints one line per changed path, so the count is the line count.
fn count_changes(raw: &str) -> u32 {
    raw.lines().filter(|l| !l.trim().is_empty()).count() as u32
}

fn parse_branches(raw: &str) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// Snapshots the working tree — tracked edits and untracked files alike — as a
/// git tree object, and returns its id.
///
/// This is the "before" side of the changes panel, taken when a prompt is sent
/// and diffed against a second snapshot later. Whatever was already dirty at
/// send time sits *inside* the baseline and so drops out of that diff, which is
/// the entire point: the panel answers "what did this turn do", not "what does
/// the tree look like".
///
/// Nothing the user can see moves. The `add` runs against a **copy** of the
/// index under `GIT_INDEX_FILE`, so the real index, the working tree, and the
/// stash are all untouched. Copying rather than starting from an empty index is
/// also what makes it cheap — the copy carries git's stat cache, so unchanged
/// files are not re-hashed (~18ms on this repo).
///
/// `None` for a directory that isn't a repo, which is how the panel stays
/// hidden there rather than reporting an error the user can't act on.
///
/// The blobs `add` writes are unreachable and a routine `git gc` collects them;
/// a session's worth is a few dozen small loose objects.
pub async fn snapshot_tree(cwd: &str) -> Option<String> {
    let index = std::env::temp_dir().join(format!("dray-index-{}", Uuid::now_v7()));
    let tree = write_snapshot(cwd, &index).await;
    let _ = fs::remove_file(&index).await;
    tree
}

async fn write_snapshot(cwd: &str, index: &Path) -> Option<String> {
    // A repo that has never been staged has no index file yet; `add` builds one
    // from nothing, so a failed copy is not fatal.
    if let Some(real) = real_index_path(cwd).await {
        let _ = fs::copy(&real, index).await;
    }

    let index = index.to_str()?;
    git_with_index(cwd, index, &["add", "-A"]).await?;
    let tree = git_with_index(cwd, index, &["write-tree"]).await?;

    let tree = tree.trim().to_string();
    (!tree.is_empty()).then_some(tree)
}

/// Where this repo keeps its index. Not hardcoded to `.git/index`: a `-w`
/// worktree has its own under `.git/worktrees/<name>/`, and that is the one
/// holding the stat cache for the files the session is actually editing.
async fn real_index_path(cwd: &str) -> Option<PathBuf> {
    let raw = git(cwd, &["rev-parse", "--git-path", "index"]).await?;

    // `--git-path` answers relative to where git ran, which is `cwd` — not the
    // process's own working directory, which is somewhere else entirely.
    let path = Path::new(raw.trim());
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };

    fs::try_exists(&path).await.ok()?.then_some(path)
}

/// Runs git against an index other than the repo's own. `GIT_OPTIONAL_LOCKS` is
/// deliberately not set here the way [`git`] sets it: this path *writes* an
/// index, so the lock it takes is not the optional kind.
///
/// Logs git's stderr on failure, unlike [`git`], which treats a non-zero exit as
/// an ordinary answer. Here it is not: a snapshot that fails on a real repo —
/// an LFS `filter` attribute with `git-lfs` absent is the realistic case, since
/// the clean filter runs during `add` — persists as a `None` baseline and shows
/// up only as a permanently empty panel, with nothing anywhere saying why.
async fn git_with_index(cwd: &str, index: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_INDEX_FILE", index)
        .output()
        .await
        .ok()?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        eprintln!("[snapshot err] git {}: {}", args.join(" "), err.trim());
        return None;
    }

    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The tree a fresh `-w` worktree starts out holding, resolved through the same
/// base ref [`default_base`] reports.
///
/// Stands in for a snapshot on a worktree session's first prompt, where there
/// is no directory to snapshot yet. Correct because a worktree git has just
/// created is clean — its working tree *is* the base ref's tree. Falls back to
/// local `HEAD`, which is also what the CLI falls back to when its fetch fails.
pub async fn base_ref_tree(cwd: &str) -> Option<String> {
    let base = default_base(cwd).await;
    let base = base.as_deref().unwrap_or("HEAD");

    let tree = git(cwd, &["rev-parse", "--verify", "-q", &format!("{base}^{{tree}}")]).await?;

    let tree = tree.trim().to_string();
    (!tree.is_empty()).then_some(tree)
}

/// Git's empty tree, which every repository can resolve whether or not
/// anything was ever written into it. Hardcoded rather than looked up: git
/// knows this id built in, so it needs no object in the database to answer for.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// The tree HEAD points at — the committed side of "what have I changed but
/// not committed".
///
/// Paired with a `None` head in [`changes_since`], which snapshots the working
/// tree at read time, so the two together are the repo view's uncommitted list.
///
/// A repository whose branch is **unborn** — `git init` with nothing committed
/// yet — answers with the empty tree rather than `None`. It is the honest
/// baseline there: with no commit behind it, every file in the tree is an
/// addition, which is exactly what a diff against the empty tree says. Folding
/// it into `None` instead would have made a real repository indistinguishable
/// from a plain directory, and hidden its files until the first commit.
///
/// So `None` means one thing only: this is not a repository.
pub async fn head_tree(cwd: &str) -> Option<String> {
    if let Some(tree) = git(cwd, &["rev-parse", "--verify", "-q", "HEAD^{tree}"])
        .await
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
    {
        return Some(tree);
    }

    is_repo(cwd).await.then(|| EMPTY_TREE.to_string())
}

/// Whether git recognises this directory at all, which is the question `HEAD`
/// cannot answer on its own — a fresh `git init` has no HEAD to resolve.
async fn is_repo(cwd: &str) -> bool {
    git(cwd, &["rev-parse", "--git-dir"]).await.is_some()
}

/// How one path differs between two snapshots. `added`/`removed` are git's own
/// numstat figures, so the row and the diff it opens cannot disagree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// The path as of the *new* side — where a renamed file ended up.
    pub path: String,
    /// Only a rename sets this: the name the file had in the baseline, which is
    /// also the name its old side has to be read under.
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    pub added: u32,
    pub removed: u32,
    /// Git reports `-` for both counts here rather than a number. Listed like
    /// any other change, but with no diff to open.
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl ChangeStatus {
    /// Git's letter, which on a rename or copy carries a similarity score after
    /// it (`R100`) — so only the first byte is the status.
    fn from_code(code: &str) -> Self {
        match code.as_bytes().first() {
            Some(b'A') => Self::Added,
            Some(b'D') => Self::Deleted,
            Some(b'R' | b'C') => Self::Renamed,
            _ => Self::Modified,
        }
    }
}

/// Everything that changed between two snapshots.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub base: String,
    /// The snapshot taken to answer *this* request. Handed back so a follow-up
    /// read of one file's contents resolves against the same tree the list was
    /// built from — the working tree moves under a running agent, and a file
    /// list and a diff taken a second apart would otherwise disagree.
    pub head: String,
    pub files: Vec<ChangedFile>,
    pub added: u32,
    pub removed: u32,
}

/// Tree ids reach here from the session log and go straight into git's argv. No
/// shell is involved, so injection isn't the risk — but a value starting with
/// `-` parses as a flag, and one naming a branch rather than a tree would
/// quietly diff something the panel never promised. Hex-only closes both.
fn is_tree_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The files that changed between `base` and `head` — or, when `head` is
/// `None`, the working tree as it stands now.
///
/// A caller passes a frozen `head` for a finished turn: the diff of two fixed
/// trees is immutable, so the answer can be cached forever and — the real point
/// — stops moving when the turn does, instead of absorbing whatever later
/// touches the same checkout.
///
/// Renames are detected (`-M`) rather than reported as a delete plus an add,
/// since the panel names a file per row and two rows for one move reads as
/// twice the work.
pub async fn changes_since(cwd: &str, base: &str, head: Option<&str>) -> Result<ChangeSet> {
    if !is_tree_id(base) {
        bail!("invalid baseline id");
    }

    // Whether the far side is the working tree as it stands, which is the only
    // case where the listed paths name files still on disk — and so the only
    // one that can be ordered by when they were touched.
    let live = head.is_none();

    let head = match head {
        Some(h) => {
            if !is_tree_id(h) {
                bail!("invalid head id");
            }
            h.to_string()
        }
        None => snapshot_tree(cwd)
            .await
            .context("could not snapshot the working tree")?,
    };

    let mut files = match diff_trees(cwd, base, &head).await {
        Ok(files) => files,
        Err(e) => {
            // A snapshot is persisted forever but its tree object is not: the
            // blobs and trees it writes are unreachable, so a `git gc` past the
            // prune window collects them. Either side can be the casualty — a
            // frozen head is as collectable as the baseline. Checked only on
            // the failure path, so the ordinary read pays nothing for it.
            if !object_exists(cwd, base).await || !object_exists(cwd, &head).await {
                bail!("this turn's snapshot is no longer in the repository — git has since collected it");
            }
            return Err(e);
        }
    };

    if live {
        sort_by_recency(cwd, &mut files).await;
    }

    let added = files.iter().map(|f| f.added).sum();
    let removed = files.iter().map(|f| f.removed).sum();

    Ok(ChangeSet {
        base: base.to_string(),
        head,
        files,
        added,
        removed,
    })
}

/// Newest edit first, which is the order the working tree is actually read in:
/// git lists paths alphabetically, so the file just written sits wherever its
/// name happens to fall and the reader has to hunt for it.
///
/// Only ever applied to a live diff — a frozen range names trees, and what a
/// path's file says on disk today has nothing to do with what it said then.
/// A deletion has no file left to stamp and sorts to the bottom; ties break on
/// path so the order is stable between reads rather than shuffling on refresh.
async fn sort_by_recency(cwd: &str, files: &mut [ChangedFile]) {
    let mut stamps: HashMap<String, SystemTime> = HashMap::new();
    for file in files.iter() {
        let at = fs::metadata(Path::new(cwd).join(&file.path))
            .await
            .ok()
            .and_then(|meta| meta.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        stamps.insert(file.path.clone(), at);
    }

    let at = |file: &ChangedFile| {
        stamps
            .get(&file.path)
            .copied()
            .unwrap_or(SystemTime::UNIX_EPOCH)
    };

    files.sort_by(|a, b| at(b).cmp(&at(a)).then_with(|| a.path.cmp(&b.path)));
}

/// Whether the object database still holds this id.
async fn object_exists(cwd: &str, id: &str) -> bool {
    git(cwd, &["cat-file", "-e", id]).await.is_some()
}

/// Status and counts come from two invocations because git prints them from
/// two different formats and will not combine them. Both run against the same
/// pair of trees, so the two file sets are identical and the merge is total.
async fn diff_trees(cwd: &str, base: &str, head: &str) -> Result<Vec<ChangedFile>> {
    // The trailing `--` is load-bearing, not decoration. Both ids are validated
    // hex, but git resolves a bare argument as *either* a rev or a path — so a
    // working-tree file whose name happens to be a hex sha (build caches do
    // this) makes the whole command die with "ambiguous argument". Verified
    // reproducible; one token closes it.
    let status = git(cwd, &["diff", "-M", "-z", "--name-status", base, head, "--"])
        .await
        .context("git diff --name-status failed")?;
    let numstat = git(cwd, &["diff", "-M", "-z", "--numstat", base, head, "--"])
        .await
        .context("git diff --numstat failed")?;

    Ok(merge_changes(
        parse_name_status(&status),
        &parse_numstat(&numstat),
    ))
}

/// One `--name-status -z` record: the status code, the new path, and the old
/// path when the change was a rename.
type StatusRecord = (String, String, Option<String>);

/// `<code>\0<path>\0`, except a rename which is `R100\0<old>\0<new>\0`.
fn parse_name_status(raw: &str) -> Vec<StatusRecord> {
    let mut out = Vec::new();
    let mut fields = raw.split('\0').filter(|f| !f.is_empty());

    while let Some(code) = fields.next() {
        let Some(first) = fields.next() else { break };
        if matches!(code.as_bytes().first(), Some(b'R' | b'C')) {
            let Some(new) = fields.next() else { break };
            out.push((code.to_string(), new.to_string(), Some(first.to_string())));
        } else {
            out.push((code.to_string(), first.to_string(), None));
        }
    }

    out
}

struct Counts {
    added: u32,
    removed: u32,
    binary: bool,
}

/// `<added>\t<removed>\t<path>\0`, except a rename which leaves the path slot
/// empty and follows with `<old>\0<new>\0`. A binary file reports `-` for both
/// counts instead of a number.
fn parse_numstat(raw: &str) -> HashMap<String, Counts> {
    let mut out = HashMap::new();
    let mut fields = raw.split('\0').filter(|f| !f.is_empty());

    while let Some(record) = fields.next() {
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };

        let path = if path.is_empty() {
            let _old = fields.next();
            match fields.next() {
                Some(new) => new,
                None => break,
            }
        } else {
            path
        };

        out.insert(
            path.to_string(),
            Counts {
                added: added.parse().unwrap_or(0),
                removed: removed.parse().unwrap_or(0),
                binary: added == "-",
            },
        );
    }

    out
}

fn merge_changes(status: Vec<StatusRecord>, counts: &HashMap<String, Counts>) -> Vec<ChangedFile> {
    status
        .into_iter()
        .map(|(code, path, old_path)| {
            let counts = counts.get(&path);
            ChangedFile {
                status: ChangeStatus::from_code(&code),
                added: counts.map_or(0, |c| c.added),
                removed: counts.map_or(0, |c| c.removed),
                binary: counts.is_some_and(|c| c.binary),
                path,
                old_path,
            }
        })
        .collect()
}

/// Both sides of one file's change, as the text a diff viewer compares.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    /// `None` for a file the baseline didn't have — the viewer draws an
    /// addition rather than a diff against the empty string.
    pub old_text: Option<String>,
    /// `None` for a file the turn deleted.
    pub new_text: Option<String>,
    /// Set when a side exists but is being withheld, so the panel can name the
    /// reason instead of drawing an empty diff and looking broken.
    pub unreadable: Option<Unreadable>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum Unreadable {
    Binary,
    TooLarge,
}

/// Past this, a side is reported as `TooLarge` rather than sent. Both sides
/// cross the IPC boundary as one JSON string, and a diff of a file this big is
/// not something anyone reads.
const MAX_BLOB: u64 = 1 << 20;

/// Reads both sides of one file out of the two snapshots.
///
/// `head` must be the id [`changes_since`] returned, not a fresh snapshot: the
/// agent may have written the file again since, and re-snapshotting here would
/// show a diff the file list never counted.
pub async fn file_versions(
    cwd: &str,
    base: &str,
    head: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileVersions> {
    if !is_tree_id(base) || !is_tree_id(head) {
        bail!("invalid tree id");
    }

    // A rename's old side lives under the old name; every other status has the
    // same path in both trees.
    let revs = [
        format!("{base}:{}", old_path.unwrap_or(path)),
        format!("{head}:{path}"),
    ];

    let mut sides = read_batch(cwd, &revs).await.into_iter();
    let old = sides.next().unwrap_or(Side::Missing);
    let new = sides.next().unwrap_or(Side::Missing);

    let unreadable = [&old, &new].into_iter().find_map(|side| match side {
        Side::Binary => Some(Unreadable::Binary),
        Side::TooLarge => Some(Unreadable::TooLarge),
        _ => None,
    });

    Ok(FileVersions {
        old_text: old.into_text(),
        new_text: new.into_text(),
        unreadable,
    })
}

enum Side {
    /// The tree has no such path — the normal state of an addition's old side
    /// and a deletion's new side.
    Missing,
    Binary,
    TooLarge,
    Text(String),
}

impl Side {
    fn into_text(self) -> Option<String> {
        match self {
            Side::Text(text) => Some(text),
            _ => None,
        }
    }
}

/// Reads several revs out of the object database, in two bounded passes.
///
/// **Sizes first, then only the content worth showing.** A single `--batch`
/// would be one spawn instead of two, but its stdout is drained whole — so a
/// 2GB file the agent happened to drop in the tree would be read entirely into
/// memory before `MAX_BLOB` could reject it. `--batch-check` returns headers
/// only, so the first pass is bounded however large the blobs are and the
/// second never asks for anything over the cap.
///
/// Still well ahead of where this started: two spawns for a whole file, against
/// the four (a size probe and a read, per side) that measured ~15ms each in
/// process overhead alone.
///
/// Input is NUL-delimited (`-z`) because a rev embeds a path, and a path is
/// allowed to contain a newline — which would otherwise be read as the start of
/// the next request.
async fn read_batch(cwd: &str, revs: &[String]) -> Vec<Side> {
    let missing = || revs.iter().map(|_| Side::Missing).collect::<Vec<_>>();

    let Some(raw) = batch(cwd, "--batch-check", revs).await else {
        return missing();
    };
    let sizes = parse_batch_check(&raw, revs.len());

    // Only the sides that exist and are small enough to render.
    let wanted: Vec<String> = revs
        .iter()
        .zip(&sizes)
        .filter(|(_, size)| matches!(size, Some(size) if *size <= MAX_BLOB))
        .map(|(rev, _)| rev.clone())
        .collect();

    let mut contents = if wanted.is_empty() {
        Vec::new()
    } else {
        match batch(cwd, "--batch", &wanted).await {
            Some(raw) => parse_batch(&raw, wanted.len()),
            None => return missing(),
        }
    }
    .into_iter();

    // Re-aligned against the *original* request: `wanted` dropped the misses and
    // the oversized, so the two lists are different lengths and only the sizes
    // know which slot each content belongs to.
    sizes
        .into_iter()
        .map(|size| match size {
            None => Side::Missing,
            Some(size) if size > MAX_BLOB => Side::TooLarge,
            Some(_) => contents.next().unwrap_or(Side::Missing),
        })
        .collect()
}

/// Feeds NUL-delimited revs to one `git cat-file` and returns its raw stdout.
async fn batch(cwd: &str, mode: &str, revs: &[String]) -> Option<Vec<u8>> {
    let mut child = Command::new("git")
        .args(["cat-file", mode, "-z"])
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;

    let mut request = Vec::new();
    for rev in revs {
        request.extend_from_slice(rev.as_bytes());
        request.push(0);
    }

    // Dropped before the read: `cat-file` keeps serving until stdin closes, so
    // holding it open here would deadlock against `wait_with_output`.
    let written = stdin.write_all(&request).await;
    drop(stdin);
    written.ok()?;

    // A miss is reported in-band and still exits 0, so a non-zero status here
    // means the whole invocation failed rather than one rev being absent.
    let out = child.wait_with_output().await.ok()?;
    out.status.success().then_some(out.stdout)
}

/// `<oid> <type> <size>` per hit and `<rev> missing` per miss, one per line —
/// the same framing as [`parse_batch`] minus the bodies.
///
/// Answers exactly `count` entries for the same reason: a short reply must not
/// shift a later side onto an earlier one's slot.
fn parse_batch_check(bytes: &[u8], count: usize) -> Vec<Option<u64>> {
    let mut out = Vec::with_capacity(count);

    for line in bytes.split(|b| *b == b'\n') {
        if out.len() == count {
            break;
        }
        if line.is_empty() {
            continue;
        }
        if line.ends_with(b" missing") {
            out.push(None);
            continue;
        }

        out.push(
            line.rsplit(|b| *b == b' ')
                .next()
                .and_then(|field| std::str::from_utf8(field).ok())
                .and_then(|field| field.trim().parse::<u64>().ok()),
        );
    }

    while out.len() < count {
        out.push(None);
    }
    out
}

/// `<oid> <type> <size>\n<contents>\n` per hit, `<rev> missing\n` per miss.
///
/// Answers exactly `count` sides whatever the reply looked like: a short or
/// unparseable stream must not shift a later side onto an earlier one's slot,
/// which would show one file's contents under another's name.
fn parse_batch(mut bytes: &[u8], count: usize) -> Vec<Side> {
    let mut out = Vec::with_capacity(count);

    while out.len() < count {
        let Some(end) = bytes.iter().position(|b| *b == b'\n') else {
            break;
        };
        let header = &bytes[..end];
        bytes = &bytes[end + 1..];

        // The ordinary reply for an addition's old side and a deletion's new one.
        if header.ends_with(b" missing") {
            out.push(Side::Missing);
            continue;
        }

        let Some(size) = header
            .rsplit(|b| *b == b' ')
            .next()
            .and_then(|field| std::str::from_utf8(field).ok())
            .and_then(|field| field.trim().parse::<usize>().ok())
        else {
            break;
        };
        if bytes.len() < size {
            break;
        }

        let body = &bytes[..size];
        // The trailing LF is git's, not the file's, and is absent if the stream
        // was truncated — hence the clamp rather than a bare `size + 1`.
        bytes = &bytes[(size + 1).min(bytes.len())..];

        out.push(if size as u64 > MAX_BLOB {
            Side::TooLarge
        } else {
            // Withheld rather than mangled: `from_utf8_lossy` would swap every
            // invalid byte for U+FFFD and render a confident diff of a file
            // that never existed.
            match std::str::from_utf8(body) {
                Ok(text) => Side::Text(text.to_string()),
                Err(_) => Side::Binary,
            }
        });
    }

    while out.len() < count {
        out.push(Side::Missing);
    }
    out
}

/// One commit, as the history list draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    /// First parent — the side this commit's own diff is taken against. `None`
    /// on the root commit, where the caller substitutes git's empty tree. A
    /// merge keeps only its first parent, so it reads as what the merge brought
    /// onto this branch rather than as everything both sides ever did.
    pub parent: Option<String>,
    pub subject: String,
    pub body: String,
    pub author: String,
    /// What the history list draws a face from. Git has no account behind a
    /// commit — only whatever the author configured — so this is the only
    /// identity here, and the frontend resolves it to a picture or to a letter.
    pub author_email: String,
    /// RFC 3339, matching every other timestamp that reaches the frontend.
    pub authored_at: String,
}

/// Fields separated by unit separators rather than by anything a human types,
/// with the body **last**: a commit message can contain any character at all,
/// so only the final field is allowed to be ambiguous, and taking the rest of
/// the record is exactly what a limited split does with it.
const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b";

/// Far above what the list pages at. A ceiling rather than a page size: this is
/// argv, and an unbounded `-n` from the frontend is one typo from reading the
/// whole history into memory.
const MAX_LOG_PAGE: u32 = 200;

/// A page of the current branch's history, newest first.
///
/// Empty for a directory that isn't a repo and for a branch with no commits
/// yet — the same "not an error, just nothing to draw" the branch list takes.
pub async fn log_commits(cwd: &str, limit: u32, skip: u32) -> Result<Vec<Commit>> {
    let limit = limit.clamp(1, MAX_LOG_PAGE).to_string();
    let skip = format!("--skip={skip}");

    // `-z` separates whole commits with NUL, which is the one byte a message
    // cannot carry — so record framing survives any message, and the `--`
    // closes the same rev-or-path ambiguity every diff here closes.
    let Some(raw) = git(
        cwd,
        &["log", "-z", LOG_FORMAT, "-n", &limit, &skip, "HEAD", "--"],
    )
    .await
    else {
        return Ok(Vec::new());
    };

    Ok(parse_log(&raw))
}

fn parse_log(raw: &str) -> Vec<Commit> {
    raw.split('\0')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            // The previous record's body ends in a newline, which lands at the
            // front of this one.
            let mut fields = record.trim_start().splitn(7, '\x1f');
            let sha = fields.next()?.trim().to_string();
            let parents = fields.next()?;
            let author = fields.next()?.to_string();
            let author_email = fields.next()?.trim().to_string();
            let authored_at = fields.next()?.trim().to_string();
            let subject = fields.next()?.to_string();
            let body = fields.next().unwrap_or_default().trim().to_string();

            (!sha.is_empty()).then(|| Commit {
                sha,
                parent: parents.split_whitespace().next().map(str::to_string),
                subject,
                body,
                author,
                author_email,
                authored_at,
            })
        })
        .collect()
}

/// Where the current branch stands against its upstream — everything the push
/// button needs to name itself.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// `None` on a detached HEAD and for a directory that isn't a repo, which
    /// is how the row hides itself rather than offering a push it can't do.
    pub branch: Option<String>,
    /// `None` for a branch that has never been pushed — the "publish" case.
    pub upstream: Option<String>,
    /// Commits the upstream doesn't have. Zero when there is no upstream: the
    /// button reads "Publish branch" there, and a count would be answering a
    /// question nobody asked yet.
    pub ahead: u32,
}

/// What the composer's action row needs to decide which buttons it has, in one
/// read.
///
/// A superset of [`SyncStatus`] rather than three calls stitched together in
/// the frontend: every field here answers the same question — "what is there
/// left to do with this work" — and reading them separately would let the row
/// draw a Commit button from one snapshot beside a Push count from another.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct WorkStatus {
    /// Uncommitted paths. A count and not a list — the row only asks whether
    /// there is anything, and the changes view is where the files are read.
    pub dirty: u32,
    /// `None` on a detached HEAD and outside a repo, which is how the row hides
    /// itself entirely.
    pub branch: Option<String>,
    /// `None` for a branch never pushed — the "publish" case.
    pub upstream: Option<String>,
    pub ahead: u32,
    /// The branch this work would land on, short of its remote (`main`, not
    /// `origin/main`). Stripped here rather than in the row, so "am I on the
    /// default branch" is one comparison and not a parsing rule that can drift.
    /// `None` where there is no remote to ask.
    pub default_branch: Option<String>,
    /// Commits this branch holds that the default branch doesn't — what a pull
    /// request would actually contain.
    ///
    /// A different question from [`ahead`], which counts against the *upstream*:
    /// a branch pushed in full is `ahead: 0` and still the one case where a pull
    /// request is most wanted. Reading `ahead` for this hides the button exactly
    /// when it is needed.
    ///
    /// `None` is "couldn't tell", not zero — `origin/HEAD` can be a symref onto
    /// a ref that was never fetched, and `symbolic-ref` resolves it without
    /// checking. The row treats unknown as "there may be something", since
    /// over-offering costs a wasted click and under-offering hides the action.
    pub ahead_of_base: Option<u32>,
}

/// Infallible like [`sync_status`], and for the same reason: a directory that
/// isn't a repo answers with the default, and the row reads that as nothing to
/// offer rather than as an error.
pub async fn work_status(cwd: &str) -> WorkStatus {
    let sync = sync_status(cwd).await;

    let dirty = git(cwd, &["status", "--porcelain"])
        .await
        .map_or(0, |s| count_changes(&s));

    let base = default_base(cwd).await;

    // Counted against the remote-tracking ref, not the local branch of the same
    // name: a local `main` can be stale or absent entirely in a worktree, and
    // either way it is not what the pull request would be opened against.
    let ahead_of_base = match &base {
        Some(base_ref) => git(cwd, &["rev-list", "--count", &format!("{base_ref}..HEAD")])
            .await
            .and_then(|s| s.trim().parse().ok()),
        None => None,
    };

    // `default_base` answers `origin/<branch>` — the remote is hardcoded there —
    // so the prefix comes off rather than everything up to the last slash. A
    // branch name may hold slashes of its own, and `release/current` cut down to
    // `current` matches nothing, which reads to the handoff row as "you are on a
    // feature branch" and offers a pull request against the branch itself.
    let default_branch = base.map(|b| b.strip_prefix("origin/").unwrap_or(&b).to_string());

    WorkStatus {
        dirty,
        branch: sync.branch,
        upstream: sync.upstream,
        ahead: sync.ahead,
        default_branch,
        ahead_of_base,
    }
}

/// Infallible by design, like [`list_branches`]: a directory that isn't a repo
/// answers with the default rather than an error the reader can't act on.
///
/// Nothing here fetches. The count is against the *last known* upstream, so a
/// branch someone else has pushed to reads as fewer commits behind than it is —
/// the push itself is what surfaces that, as git's own rejection.
pub async fn sync_status(cwd: &str) -> SyncStatus {
    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");

    let Some(branch) = branch else {
        return SyncStatus::default();
    };

    let upstream = git(cwd, &["rev-parse", "--abbrev-ref", "@{u}"])
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let ahead = if upstream.is_some() {
        git(cwd, &["rev-list", "--count", "@{u}..HEAD"])
            .await
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    } else {
        0
    };

    SyncStatus {
        branch: Some(branch),
        upstream,
        ahead,
    }
}

/// Git resolves a pathspec as a glob and reads leading `:` as magic, so a file
/// genuinely named `a*.txt` or `:weird` would stage its neighbours or nothing
/// at all. These paths come from our own change list and name real files, so
/// literal is not a restriction — it is what the caller already meant.
const LITERAL_PATHSPECS: &[(&str, &str)] = &[("GIT_LITERAL_PATHSPECS", "1")];

/// Commits exactly `paths` — the files the reader left checked — and nothing
/// else.
///
/// Two commands rather than one. `add -A` is what makes an untracked file
/// committable at all (`commit -- <path>` refuses a path git has never heard
/// of) and what records a deletion. The pathspec on `commit` then implies
/// `--only`, so the commit is built from HEAD plus these paths: anything the
/// user had staged for an *unchecked* file stays staged and uncommitted, which
/// is the promise the checkboxes make.
///
/// Porcelain rather than the temp-index plumbing [`snapshot_tree`] uses,
/// deliberately: this is meant to move HEAD, and a `commit-tree` that left the
/// real index untouched would leave every just-committed file reading as a
/// staged revert afterwards.
pub async fn commit_files(
    cwd: &str,
    summary: &str,
    description: Option<&str>,
    paths: &[String],
) -> Result<()> {
    let summary = summary.trim();
    if summary.is_empty() {
        bail!("a commit needs a summary");
    }
    if paths.is_empty() {
        bail!("no files are selected to commit");
    }
    // A `-` leading path is already closed by the `--` both commands carry;
    // this is the empty and NUL case, which would silently widen the pathspec.
    if paths.iter().any(|p| p.is_empty() || p.contains('\0')) {
        bail!("invalid path in the selection");
    }

    let mut add = vec!["add", "-A", "--"];
    add.extend(paths.iter().map(String::as_str));
    run_with(cwd, LITERAL_PATHSPECS, &add).await?;

    let description = description.map(str::trim).filter(|d| !d.is_empty());

    let mut commit = vec!["commit", "-m", summary];
    // A second `-m` rather than a joined string: git's own blank line between
    // subject and body is the convention every tool reading this expects.
    if let Some(description) = description {
        commit.push("-m");
        commit.push(description);
    }
    commit.push("--");
    commit.extend(paths.iter().map(String::as_str));

    run_with(cwd, LITERAL_PATHSPECS, &commit).await
}

/// Pushes the current branch, publishing it when it has no upstream yet.
///
/// No force, ever: a rejected non-fast-forward comes back as git's own stderr
/// for the reader to deal with, which for a session's own branch usually means
/// someone else pushed to it.
pub async fn push_branch(cwd: &str) -> Result<()> {
    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD")
        .context("not on a branch, so there is nothing to push")?;

    if git(cwd, &["rev-parse", "--abbrev-ref", "@{u}"]).await.is_some() {
        return run(cwd, &["push"]).await;
    }

    // Git's own output for the name, and a branch name cannot begin with `-`.
    run(cwd, &["push", "-u", "origin", &branch]).await
}

/// What removing this worktree would cost, read once so the dialog and the
/// removal agree about what is in the way.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDisposition {
    /// `false` once the directory is gone — removed by hand, or by a `claude`
    /// run that did have an exit prompt. The caller skips the dialog and goes
    /// straight to relocating the session, so a half-dead tree tidies itself
    /// up rather than asking a question about a directory nobody can see.
    pub exists: bool,
    /// `git status --porcelain` lines: modified, staged, and untracked alike.
    pub changed_files: u32,
    /// Commits **only this branch holds** — reachable from its HEAD and from
    /// no other branch, remote or tag. That is the question the reader is
    /// actually asking, since a commit some other ref also holds survives the
    /// branch being deleted.
    ///
    /// Counting against remotes alone was the first version and was wrong in
    /// the plainest case: a repo with no remote at all reported every commit
    /// in its history as at risk, so a spotless worktree warned about the
    /// initial commit.
    ///
    /// A squash-merged PR still counts, since its commits are genuinely on no
    /// other ref whatever landed on `main`. The CLI's own exit prompt has the
    /// same blind spot; it over-warns, which is the safe direction.
    pub unpushed_commits: u32,
    /// The reason string on git's own lock, when one is held by a **live**
    /// process. `None` covers both the unlocked tree and the far commoner
    /// case of a lock left behind by a session that has since exited.
    pub locked_by: Option<String>,
}

/// The lock a `-p` session leaves behind.
///
/// Claude Code locks a worktree at creation and — verified against v2.1.239 —
/// a `-p` run does not release it on exit, so nearly every worktree Dray
/// creates is still locked by a dead process. `git worktree remove --force`
/// refuses a locked tree outright (exit 128, "use 'remove -f -f' to override
/// or unlock first"), which makes unlocking a required step here rather than a
/// defensive one.
///
/// The reason it writes is `claude session <name> (pid <N> start <date>)`, and
/// the pid is the whole point: a live one means some other session is working
/// in that directory right now, and unlocking would pull the tree out from
/// under it.
fn lock_owner_pid(reason: &str) -> Option<u32> {
    let (_, rest) = reason.split_once("(pid ")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// `kill(pid, 0)` — the signal number that checks for a process without
/// sending anything. `EPERM` counts as alive: a process owned by another user
/// is still a process holding that lock.
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: signal 0 delivers nothing; it only performs the existence and
    // permission check that gives this function its answer.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The `locked` reason git records for `worktree_path`, if any.
///
/// `git worktree list --porcelain` prints a blank-line-separated record per
/// tree; `locked` appears bare when the lock carries no reason.
///
/// Both sides are resolved before being compared, and that is not tidiness:
/// git prints the real path, so on macOS a tree under `/var/…` comes back as
/// `/private/var/…` and a plain `==` finds no record at all — which reads as
/// "not locked" and is the one wrong answer this function can give.
fn parse_lock_reason(porcelain: &str, worktree_path: &Path) -> Option<String> {
    let target = resolved(worktree_path);
    let mut matched = false;

    for line in porcelain.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            matched = resolved(Path::new(path.trim())) == target;
        } else if matched && (line == "locked" || line.starts_with("locked ")) {
            return Some(line["locked".len()..].trim().to_string());
        }
    }

    None
}

/// Symlinks resolved where the path exists, left alone where it doesn't — so
/// this is usable on a tree that has already been deleted, and in tests over
/// paths that were never on disk.
fn resolved(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether this path is a worktree **Dray created**, which is the only kind it
/// is allowed to delete.
///
/// The guard is the path shape, not the index: an index entry is a record of
/// what we did, while this answers what we are about to delete. It has to be
/// a direct child of `<project>/.claude/worktrees/`, so a `..` segment, an
/// absolute detour, or the project root itself can never resolve into a
/// removal target.
fn is_managed_worktree(project_path: &Path, worktree_path: &Path) -> bool {
    if worktree_path.components().any(|c| c.as_os_str() == "..") {
        return false;
    }

    worktree_path.parent() == Some(&project_path.join(".claude").join("worktrees"))
        && worktree_path.file_name().is_some()
}

/// Reads a worktree's state without changing anything.
///
/// Infallible like [`sync_status`]: every question here has an honest answer
/// for a directory that is missing or isn't a repo, and none of them is
/// something the reader could act on as an error.
pub async fn worktree_disposition(worktree_path: &str, project_path: &str) -> WorktreeDisposition {
    if !Path::new(worktree_path).is_dir() {
        return WorktreeDisposition::default();
    }

    let changed_files = git(worktree_path, &["status", "--porcelain"])
        .await
        .map(|raw| count_changes(&raw))
        .unwrap_or(0);

    let branch = current_branch(worktree_path).await;

    // `--exclude` applies to the *next* ref-enumerating option only, so this
    // drops the worktree's own branch from `--branches` while `--remotes` and
    // `--tags` stay whole — which is what lets a pushed branch read as safe.
    // The glob is relative to `refs/heads`, and spelling it in full silently
    // matches nothing, leaving every count at zero.
    let unpushed_commits = match &branch {
        Some(branch) => git(
            worktree_path,
            &[
                "rev-list",
                "--count",
                "HEAD",
                "--not",
                &format!("--exclude={branch}"),
                "--branches",
                "--remotes",
                "--tags",
            ],
        )
        .await
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0),
        // A detached HEAD has no branch to exclude, and nothing here can be
        // deleted along with it either.
        None => 0,
    };

    let locked_by = git(project_path, &["worktree", "list", "--porcelain"])
        .await
        .and_then(|raw| parse_lock_reason(&raw, Path::new(worktree_path)))
        .filter(|reason| lock_owner_pid(reason).is_some_and(pid_is_alive));

    WorktreeDisposition {
        exists: true,
        changed_files,
        unpushed_commits,
        locked_by,
    }
}

/// The branch `cwd` has checked out, or `None` for a detached HEAD, a
/// directory that isn't a repo, and a repo whose branch is unborn.
///
/// `symbolic-ref` rather than `rev-parse --abbrev-ref`, which answers the
/// literal string `HEAD` on a detached one — a branch name nothing can look up
/// and everything downstream would treat as real.
pub async fn current_branch(cwd: &str) -> Option<String> {
    git(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The commit `base` names, or `None` when it names nothing in this repo.
///
/// `^{commit}` rather than a bare verify, so a tag or a tree-ish is either
/// peeled to a commit or refused — `worktree add` wants a commit, and the
/// failure it gives for anything else arrives after the tree is half made.
pub async fn resolve_commit(cwd: &str, base: &str) -> Option<String> {
    git(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "-q",
            "--end-of-options",
            &format!("{base}^{{commit}}"),
        ],
    )
    .await
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

/// Creates a worktree at `<project>/.claude/worktrees/<name>` on a new branch
/// `worktree-<name>`, starting from `base`. Returns the path.
///
/// The symmetric half of [`remove_worktree`], and it exists because the harness
/// cannot do this: `claude -w` resolves the repo's default branch, fetches
/// `origin/<it>` and passes *that* to `git worktree add`, and its flag surface
/// exposes no base ref at all. So a session that has to start from existing
/// work is one Dray makes the tree for and then spawns the child *into*, with
/// no `-w` at all.
///
/// **A branch, never a detached HEAD.** Detaching would suit a session that
/// only reads, but every surface downstream reads a worktree session's branch
/// off its name — the PR tab looks one up, the handoff row offers to push it,
/// and the removal above deletes it — so a tree with no branch breaks four
/// things to prevent a commit nobody was going to object to. Same name the CLI
/// would have minted, so `--from` changes where the branch starts and nothing
/// else about it.
///
/// `-B` rather than `-b`, matching the CLI: a branch left behind by a tree
/// deleted outside Dray would otherwise make that name fail forever, since the
/// name is what the branch is derived from. It cannot clobber live work — git
/// refuses to reset a branch another worktree holds, which is exactly the case
/// where somebody is using it.
///
/// Deliberately **not** locked. The CLI locks the trees it makes and a `-p` run
/// never releases the lock, which is the whole reason removal has to unlock
/// first; a tree made here has no such lock to leave behind.
pub async fn create_worktree(project_path: &str, name: &str, base: &str) -> Result<String> {
    let path = PathBuf::from(project_path)
        .join(".claude")
        .join("worktrees")
        .join(name);

    // Checked before the tree, not after: `worktree add` on an unresolvable
    // start point leaves the branch and directory behind on some git versions,
    // and this way the reader gets the ref they typed named back at them.
    if resolve_commit(project_path, base).await.is_none() {
        bail!("{base} is not a branch, tag or commit in this repository");
    }

    let path = path.to_string_lossy().into_owned();
    let branch = format!("worktree-{name}");

    // `--no-track` so the branch takes no upstream from the base. Without it a
    // base that is a remote-tracking ref makes every later `git push` on this
    // session's branch aim at the *base's* branch.
    run(
        project_path,
        &[
            "worktree",
            "add",
            "--no-track",
            "-B",
            &branch,
            "--end-of-options",
            &path,
            base,
        ],
    )
    .await?;

    Ok(path)
}

/// Deletes a worktree directory and the branch it was checked out on.
///
/// Order is load-bearing at both ends. The unlock has to come first because
/// the lock a `-p` session left behind makes git refuse the removal outright
/// (see [`lock_owner_pid`]); the branch delete has to come last because
/// `git branch -D` refuses a branch some worktree still has checked out, which
/// is exactly what this branch was a moment ago.
///
/// A live lock is the one thing that stops this: unlocking a tree another
/// session is working in would delete files out from under it. Everything else
/// — a missing directory, a registration git has already forgotten — is a
/// worktree that is already gone, and reports success, since the caller's next
/// step is to record that it is gone either way.
///
/// The branch delete is best-effort and reported through the return value
/// rather than as a failure: the directory is what the reader asked to be rid
/// of, and a branch left behind is tidy-up, not a failed removal.
pub async fn remove_worktree(project_path: &str, worktree_path: &str, branch: Option<&str>) -> Result<bool> {
    let project = PathBuf::from(project_path);
    let tree = PathBuf::from(worktree_path);

    if !is_managed_worktree(&project, &tree) {
        bail!("{worktree_path} is not a worktree Dray created, so it will not be removed");
    }

    if let Some(reason) = worktree_disposition(worktree_path, project_path).await.locked_by {
        bail!("that worktree is in use by another session ({reason})");
    }

    // Failure is the ordinary case — most trees are not locked at all — so the
    // result is dropped rather than checked.
    let _ = git(project_path, &["worktree", "unlock", worktree_path]).await;

    if Path::new(worktree_path).exists() {
        if let Err(e) = run(project_path, &["worktree", "remove", "--force", worktree_path]).await {
            // Git no longer recognising the tree is the outcome we wanted, not
            // a failure: prune the stale registration and carry on. Anything
            // else is a real refusal and the reader has to see it.
            if !is_stale_worktree_error(&e.to_string()) {
                return Err(e);
            }
        }
    }

    // Runs whichever way the removal above went — a directory deleted by hand
    // leaves a registration behind that nothing else clears.
    let _ = git(project_path, &["worktree", "prune"]).await;

    let Some(branch) = branch else {
        return Ok(false);
    };

    // `--end-of-options` so a branch whose name begins with `-` is a name and
    // not a flag. The name comes from our own index, but it was minted from a
    // worktree name the user could have chosen.
    Ok(run(
        project_path,
        &["branch", "-D", "--end-of-options", branch],
    )
    .await
    .is_ok())
}

/// Git's ways of saying "that isn't a worktree I know about", which is success
/// dressed as an error for a caller trying to be rid of it.
fn is_stale_worktree_error(stderr: &str) -> bool {
    let stderr = stderr.to_lowercase();
    stderr.contains("is not a working tree")
        || stderr.contains("not a valid directory")
        || stderr.contains("validation failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The verbatim reason `claude -p --worktree` leaves behind, captured from
    // v2.1.239 — a `-p` run never releases it, so this is the string almost
    // every removal has to get past.
    const LOCK_REASON: &str = "claude session locktest (pid 33393 start Sun Aug 23 07:44:13 2026)";

    const WORKTREE_LIST: &str = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/one\nHEAD def\nbranch refs/heads/worktree-one\nlocked claude session locktest (pid 33393 start Sun Aug 23 07:44:13 2026)\n\nworktree /repo/.claude/worktrees/two\nHEAD 012\nbranch refs/heads/worktree-two\n";

    #[test]
    fn reads_the_pid_out_of_a_lock_reason() {
        assert_eq!(lock_owner_pid(LOCK_REASON), Some(33393));
        // A lock someone set by hand names no pid, so it can never be read as
        // ours to clear.
        assert_eq!(lock_owner_pid("do not touch"), None);
        assert_eq!(lock_owner_pid("(pid )"), None);
    }

    #[test]
    fn finds_the_lock_for_one_worktree_only() {
        assert_eq!(
            parse_lock_reason(WORKTREE_LIST, Path::new("/repo/.claude/worktrees/one")),
            Some(LOCK_REASON.to_string())
        );
        // The unlocked record sits after the locked one, so a parser that
        // didn't reset on each `worktree` line would report its neighbour's.
        assert_eq!(
            parse_lock_reason(WORKTREE_LIST, Path::new("/repo/.claude/worktrees/two")),
            None
        );
        assert_eq!(parse_lock_reason(WORKTREE_LIST, Path::new("/repo")), None);
    }

    #[test]
    fn only_direct_children_of_the_worktrees_dir_are_removable() {
        let repo = Path::new("/repo");

        assert!(is_managed_worktree(
            repo,
            Path::new("/repo/.claude/worktrees/one")
        ));

        // Each of these once resolved into something that is not a worktree.
        for path in [
            "/repo",
            "/repo/.claude/worktrees",
            "/repo/.claude/worktrees/one/src",
            "/repo/.claude/worktrees/../../etc",
            "/elsewhere/.claude/worktrees/one",
            "/repo/src",
        ] {
            assert!(
                !is_managed_worktree(repo, Path::new(path)),
                "{path} must not be removable"
            );
        }
    }

    #[test]
    fn a_forgotten_registration_reads_as_already_gone() {
        assert!(is_stale_worktree_error(
            "fatal: '/repo/.claude/worktrees/one' is not a working tree"
        ));
        // A locked tree is a refusal to respect, not a tree to prune.
        assert!(!is_stale_worktree_error(
            "fatal: cannot remove a locked working tree"
        ));
    }

    #[test]
    fn parses_branch_lines_and_drops_blanks() {
        let raw = "main\nfeat/one\n\n  spaced  \n";

        assert_eq!(parse_branches(raw), vec!["main", "feat/one", "spaced"],);
    }

    #[test]
    fn empty_output_is_no_branches() {
        assert!(parse_branches("").is_empty());
        assert!(parse_branches("\n\n").is_empty());
    }

    // The two fixtures below are the verbatim output of
    // `git diff -M -z --name-status` and `--numstat` over a scratch repo
    // carrying one of every status: a rename, a binary edit, a delete, a
    // modify, and an add whose name contains a space.
    const NAME_STATUS: &str =
        "R100\0before.txt\0after.txt\0M\0bin.dat\0D\0gone.txt\0M\0keep.txt\0A\0spaced name.txt\0";
    const NUMSTAT: &str = "0\t0\t\0before.txt\0after.txt\0-\t-\tbin.dat\00\t2\tgone.txt\01\t0\tkeep.txt\02\t0\tspaced name.txt\0";

    #[test]
    fn parses_name_status_including_rename_pairs() {
        let parsed = parse_name_status(NAME_STATUS);

        assert_eq!(
            parsed,
            vec![
                (
                    "R100".into(),
                    "after.txt".into(),
                    Some("before.txt".into())
                ),
                ("M".into(), "bin.dat".into(), None),
                ("D".into(), "gone.txt".into(), None),
                ("M".into(), "keep.txt".into(), None),
                ("A".into(), "spaced name.txt".into(), None),
            ],
        );
    }

    #[test]
    fn parses_numstat_counts_renames_and_binaries() {
        let parsed = parse_numstat(NUMSTAT);

        // The rename is keyed by its new name, matching name-status.
        let renamed = &parsed["after.txt"];
        assert_eq!((renamed.added, renamed.removed, renamed.binary), (0, 0, false));

        // Binary reports `-` for both counts, which must not read as a change
        // of zero lines that happens to be text.
        assert!(parsed["bin.dat"].binary);

        let keep = &parsed["keep.txt"];
        assert_eq!((keep.added, keep.removed), (1, 0));
        // A path with a space survives, which is the whole reason for `-z`.
        assert_eq!(parsed["spaced name.txt"].added, 2);
    }

    #[test]
    fn merges_status_and_counts_onto_one_row_per_file() {
        let merged = merge_changes(parse_name_status(NAME_STATUS), &parse_numstat(NUMSTAT));

        // One row per file — a rename is not split into a delete plus an add.
        assert_eq!(merged.len(), 5);

        let renamed = &merged[0];
        assert_eq!(renamed.status, ChangeStatus::Renamed);
        assert_eq!(renamed.path, "after.txt");
        assert_eq!(renamed.old_path.as_deref(), Some("before.txt"));

        assert_eq!(merged[1].status, ChangeStatus::Modified);
        assert!(merged[1].binary);
        assert_eq!(merged[2].status, ChangeStatus::Deleted);
        assert_eq!(merged[2].removed, 2);
        assert_eq!(merged[4].status, ChangeStatus::Added);
    }

    #[test]
    fn empty_diff_is_no_files() {
        assert!(merge_changes(parse_name_status(""), &parse_numstat("")).is_empty());
    }

    #[test]
    fn reads_status_from_the_letter_not_the_similarity_score() {
        assert_eq!(ChangeStatus::from_code("R100"), ChangeStatus::Renamed);
        assert_eq!(ChangeStatus::from_code("C75"), ChangeStatus::Renamed);
        assert_eq!(ChangeStatus::from_code("A"), ChangeStatus::Added);
        assert_eq!(ChangeStatus::from_code("D"), ChangeStatus::Deleted);
        // An unfamiliar code degrades to a plain edit rather than vanishing:
        // git also emits T (type change), U (unmerged), and X.
        assert_eq!(ChangeStatus::from_code("T"), ChangeStatus::Modified);
        assert_eq!(ChangeStatus::from_code(""), ChangeStatus::Modified);
    }

    /// Builds a throwaway repo with one commit. The parser tests above cover
    /// the formats; this exists for the snapshot itself, where the failure
    /// modes are all environmental — a `GIT_INDEX_FILE` that didn't take, a
    /// `--git-path` resolved against the wrong directory — and none of them
    /// show up in a string fixture.
    async fn scratch_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dray-gittest-{}", Uuid::now_v7()));
        fs::create_dir_all(&dir).await.unwrap();
        let at = dir.to_str().unwrap();

        run(at, &["init", "-q", "."]).await.unwrap();
        run(at, &["config", "user.email", "t@example.com"])
            .await
            .unwrap();
        run(at, &["config", "user.name", "Test"]).await.unwrap();

        fs::write(dir.join("keep.txt"), "a\nb\nc\n").await.unwrap();
        fs::write(dir.join("gone.txt"), "x\ny\n").await.unwrap();
        run(at, &["add", "-A"]).await.unwrap();
        run(at, &["commit", "-qm", "init"]).await.unwrap();

        dir
    }

    /// Adds a worktree the way Claude Code does — under `.claude/worktrees/`,
    /// on a `worktree-<name>` branch — and locks it the way a `-p` session
    /// leaves it locked.
    async fn scratch_worktree(dir: &Path, name: &str, lock: Option<&str>) -> PathBuf {
        let at = dir.to_str().unwrap();
        let path = dir.join(".claude").join("worktrees").join(name);
        let branch = format!("worktree-{name}");

        run(
            at,
            &["worktree", "add", "-q", "-b", &branch, path.to_str().unwrap()],
        )
        .await
        .unwrap();

        if let Some(reason) = lock {
            run(
                at,
                &["worktree", "lock", "--reason", reason, path.to_str().unwrap()],
            )
            .await
            .unwrap();
        }

        path
    }

    /// The whole point of the function: the tree holds the commits of the ref
    /// it was based on, not whatever the default branch is at. That is what
    /// `claude -w` cannot be asked for.
    #[tokio::test]
    async fn creates_a_worktree_at_the_ref_it_was_given() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        // Work sitting on a branch nobody pushed — the case a reviewer spawned
        // off `origin/<default>` would find nothing of.
        run(at, &["checkout", "-q", "-b", "authors-work"]).await.unwrap();
        fs::write(dir.join("feature.txt"), "the work\n").await.unwrap();
        run(at, &["add", "-A"]).await.unwrap();
        run(at, &["commit", "-qm", "the work"]).await.unwrap();
        run(at, &["checkout", "-q", "-"]).await.unwrap();

        let path = create_worktree(at, "reviewer", "authors-work")
            .await
            .expect("a branch that exists is a base");

        assert!(
            Path::new(&path).join("feature.txt").exists(),
            "the base's own commits are missing from the tree"
        );
        // Its own branch, not the author's: git would refuse to check that one
        // out twice, and a session that shares a branch can move it.
        assert_eq!(
            current_branch(&path).await.as_deref(),
            Some("worktree-reviewer")
        );
        // `--no-track`, or every push from this session would aim at the base.
        assert_eq!(
            git(at, &["config", "--get", "branch.worktree-reviewer.merge"]).await,
            None
        );

        fs::remove_dir_all(&dir).await.ok();
    }

    /// Refused before anything is on disk, so a typo costs an error rather than
    /// a half-made tree the reader has to clean up.
    #[tokio::test]
    async fn refuses_a_base_the_repo_cannot_resolve() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        let err = create_worktree(at, "nope", "no-such-branch")
            .await
            .expect_err("an unresolvable base is not a base");
        assert!(err.to_string().contains("no-such-branch"), "unhelpful: {err}");

        assert!(!dir.join(".claude").join("worktrees").join("nope").exists());
        let branches = git(at, &["branch", "--list", "worktree-nope"]).await.unwrap();
        assert!(branches.trim().is_empty(), "branch left behind: {branches}");

        fs::remove_dir_all(&dir).await.ok();
    }

    /// A commit is as good a base as a branch, and `resolve_commit` peels a
    /// tag rather than handing `worktree add` something it will refuse late.
    #[tokio::test]
    async fn a_commit_and_a_tag_are_both_bases() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        let head = git(at, &["rev-parse", "HEAD"]).await.unwrap();
        let head = head.trim();
        run(at, &["tag", "v1"]).await.unwrap();

        assert_eq!(resolve_commit(at, "v1").await.as_deref(), Some(head));
        create_worktree(at, "at-a-commit", head)
            .await
            .expect("a commit is a base");

        fs::remove_dir_all(&dir).await.ok();
    }

    /// The name is what the branch is derived from, so a branch left behind by
    /// a tree deleted outside Dray would make that name fail forever. `-B`
    /// resets it — and cannot reach a branch some worktree still holds, which
    /// is every case where the branch is somebody's live work.
    #[tokio::test]
    async fn a_leftover_branch_does_not_block_the_name() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        run(at, &["branch", "worktree-recycled"]).await.unwrap();
        create_worktree(at, "recycled", "HEAD")
            .await
            .expect("a branch with no worktree behind it is ours to reset");

        // And the live half: the same name a second time is git's refusal, not
        // a silent second checkout.
        let err = create_worktree(at, "recycled", "HEAD")
            .await
            .expect_err("a branch another worktree holds must not be reset");
        assert!(err.to_string().contains("already used"), "unexpected: {err}");

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_detached_head_is_no_branch() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        assert!(current_branch(at).await.is_some());
        run(at, &["checkout", "-q", "--detach", "HEAD"]).await.unwrap();
        // `rev-parse --abbrev-ref` answers the literal string "HEAD" here,
        // which is the wrong answer this reads around.
        assert_eq!(current_branch(at).await, None);

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn removes_a_locked_worktree_and_its_branch() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        // A pid that cannot be running, which is what a `-p` session leaves
        // behind once its process is gone.
        let path = scratch_worktree(
            &dir,
            "one",
            Some("claude session one (pid 4294967294 start Sun Aug 23 07:44:13 2026)"),
        )
        .await;

        // Untracked work in the tree: `--force` has to carry it away, since
        // the reader was already told what would be lost.
        fs::write(path.join("scratch.txt"), "wip\n").await.unwrap();

        let deleted_branch = remove_worktree(at, path.to_str().unwrap(), Some("worktree-one"))
            .await
            .expect("a stale lock is ours to clear");

        assert!(deleted_branch, "the branch outlived its worktree");
        assert!(!path.exists(), "the directory is still on disk");

        let branches = git(at, &["branch", "--list", "worktree-one"]).await.unwrap();
        assert!(branches.trim().is_empty(), "branch left behind: {branches}");

        let list = git(at, &["worktree", "list", "--porcelain"]).await.unwrap();
        assert!(!list.contains("worktrees/one"), "registration left behind");

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn refuses_a_worktree_a_live_session_holds() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        // Our own pid: alive by definition, so the guard has to fire.
        let reason = format!("claude session two (pid {} start now)", std::process::id());
        let path = scratch_worktree(&dir, "two", Some(&reason)).await;

        let err = remove_worktree(at, path.to_str().unwrap(), Some("worktree-two"))
            .await
            .expect_err("a live lock must not be cleared");
        assert!(
            err.to_string().contains("another session"),
            "unhelpful refusal: {err}"
        );

        assert!(path.exists(), "a live session's files were deleted");

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_directory_deleted_by_hand_still_reports_success() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let path = scratch_worktree(&dir, "three", None).await;

        // What the reader does when they get tired of waiting for this button.
        fs::remove_dir_all(&path).await.unwrap();

        remove_worktree(at, path.to_str().unwrap(), Some("worktree-three"))
            .await
            .expect("an already-gone worktree is the outcome we wanted");

        // The stale registration is the part only the prune clears, and
        // leaving it makes the name unusable for the next session.
        let list = git(at, &["worktree", "list", "--porcelain"]).await.unwrap();
        assert!(
            !list.contains("worktrees/three"),
            "stale registration: {list}"
        );

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn counts_what_removal_would_cost() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let path = scratch_worktree(&dir, "four", None).await;
        let tree = path.to_str().unwrap();

        let clean = worktree_disposition(tree, at).await;
        assert!(clean.exists);
        assert_eq!(clean.changed_files, 0);
        assert_eq!(clean.unpushed_commits, 0);
        assert_eq!(clean.locked_by, None);

        fs::write(path.join("wip.txt"), "x\n").await.unwrap();
        run(tree, &["add", "-A"]).await.unwrap();
        run(tree, &["commit", "-qm", "wip"]).await.unwrap();
        fs::write(path.join("later.txt"), "y\n").await.unwrap();

        let dirty = worktree_disposition(tree, at).await;
        assert_eq!(dirty.changed_files, 1, "the untracked file wasn't counted");
        // One commit, and only this branch holds it. The clean reading above
        // is the other half: the repo has no remote at all, and a count taken
        // against remotes alone called its whole history unpushed.
        assert_eq!(dirty.unpushed_commits, 1);

        // A branch some other ref also holds is not work this removal loses.
        run(at, &["update-ref", "refs/remotes/origin/four", "worktree-four"])
            .await
            .unwrap();
        let pushed = worktree_disposition(tree, at).await;
        assert_eq!(pushed.unpushed_commits, 0, "a pushed branch still warned");

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_missing_worktree_reads_as_gone_not_as_clean() {
        let dir = scratch_repo().await;

        let state =
            worktree_disposition(dir.join("nope").to_str().unwrap(), dir.to_str().unwrap()).await;

        assert!(!state.exists, "a missing directory must not read as a tree");

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn will_not_delete_anything_outside_the_worktrees_dir() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        // The project root itself is the one that matters: `worktree_path`
        // built from an empty name would land exactly here.
        remove_worktree(at, at, None)
            .await
            .expect_err("the project root is not removable");

        assert!(dir.join("keep.txt").exists(), "the checkout was deleted");

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn snapshots_the_tree_without_touching_the_repo() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        // Dirty before the snapshot: this is the state a prompt arrives into,
        // and it must land *inside* the baseline so it drops out of the diff.
        fs::write(dir.join("keep.txt"), "a\nb\nc\nEDITED BY HAND\n")
            .await
            .unwrap();

        let base = snapshot_tree(at).await.expect("a repo snapshots");

        // The user's own index and working tree are untouched — the whole
        // safety claim of running `add` against a copy.
        let staged = git(at, &["diff", "--cached", "--name-only"]).await.unwrap();
        assert!(staged.trim().is_empty(), "the real index was written to");
        let dirty = git(at, &["status", "--porcelain"]).await.unwrap();
        assert!(dirty.contains("keep.txt"), "the edit was committed away");

        let changes = changes_since(at, &base, None).await.unwrap();
        assert!(
            changes.files.is_empty(),
            "pre-existing dirt leaked into the diff: {:?}",
            changes.files
        );

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn reports_only_what_happened_after_the_baseline() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        fs::write(dir.join("keep.txt"), "a\nb\nc\nalready here\n")
            .await
            .unwrap();
        let base = snapshot_tree(at).await.unwrap();

        // Stand-in for a turn: an edit, a delete, and an untracked new file.
        fs::write(dir.join("keep.txt"), "a\nb\nc\nalready here\nfrom the turn\n")
            .await
            .unwrap();
        fs::remove_file(dir.join("gone.txt")).await.unwrap();
        fs::write(dir.join("new.txt"), "brand new\n").await.unwrap();

        let changes = changes_since(at, &base, None).await.unwrap();

        let mut names: Vec<_> = changes.files.iter().map(|f| f.path.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["gone.txt", "keep.txt", "new.txt"]);
        assert_eq!(changes.added, 2, "one edited line plus one new file's line");
        assert_eq!(changes.removed, 2, "the deleted file's two lines");

        // Only the line this turn added shows, not the one already there.
        let keep = changes.files.iter().find(|f| f.path == "keep.txt").unwrap();
        assert_eq!((keep.added, keep.removed), (1, 0));

        let versions = file_versions(at, &base, &changes.head, "keep.txt", None)
            .await
            .unwrap();
        assert_eq!(
            versions.old_text.as_deref(),
            Some("a\nb\nc\nalready here\n"),
            "the old side must be the baseline, not the last commit"
        );
        assert!(versions.new_text.unwrap().contains("from the turn"));
        assert!(versions.unreadable.is_none());

        // A deletion has no new side, and an addition no old one.
        let deleted = file_versions(at, &base, &changes.head, "gone.txt", None)
            .await
            .unwrap();
        assert_eq!(deleted.old_text.as_deref(), Some("x\ny\n"));
        assert!(deleted.new_text.is_none());

        let added = file_versions(at, &base, &changes.head, "new.txt", None)
            .await
            .unwrap();
        assert!(added.old_text.is_none());
        assert_eq!(added.new_text.as_deref(), Some("brand new\n"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_frozen_head_excludes_what_lands_after_the_turn() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let base = snapshot_tree(at).await.unwrap();

        // The turn's own work, then the snapshot its `turn_completed` carries.
        fs::write(dir.join("keep.txt"), "a\nb\nc\nthis turn\n")
            .await
            .unwrap();
        let head = snapshot_tree(at).await.unwrap();

        // What arrives later — another session, the user's editor. The whole
        // point of freezing the head is that none of this shows.
        fs::write(dir.join("keep.txt"), "a\nb\nc\nthis turn\nsomeone else\n")
            .await
            .unwrap();
        fs::write(dir.join("other-session.txt"), "not ours\n")
            .await
            .unwrap();

        let changes = changes_since(at, &base, Some(&head)).await.unwrap();
        assert_eq!(changes.head, head, "the frozen id is the one handed back");
        let names: Vec<_> = changes.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, vec!["keep.txt"]);
        assert_eq!((changes.added, changes.removed), (1, 0));

        let versions = file_versions(at, &base, &head, "keep.txt", None)
            .await
            .unwrap();
        assert_eq!(
            versions.new_text.as_deref(),
            Some("a\nb\nc\nthis turn\n"),
            "contents come from the frozen tree, not the moved-on working tree"
        );

        assert!(
            changes_since(at, &base, Some("--not-a-tree")).await.is_err(),
            "a non-hex head must be rejected before it reaches argv"
        );

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_commit_mid_turn_still_reads_as_the_net_change() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let base = snapshot_tree(at).await.unwrap();

        // The agent edits and commits. Content is what the snapshot compares,
        // so the commit is invisible and the change still shows.
        fs::write(dir.join("keep.txt"), "a\nb\nc\nd\n").await.unwrap();
        run(at, &["add", "-A"]).await.unwrap();
        run(at, &["commit", "-qm", "agent work"]).await.unwrap();

        let changes = changes_since(at, &base, None).await.unwrap();
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].path, "keep.txt");
        assert_eq!(changes.files[0].status, ChangeStatus::Modified);

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn binary_and_oversized_sides_are_withheld_not_mangled() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let base = snapshot_tree(at).await.unwrap();

        fs::write(dir.join("bin.dat"), [0u8, 1, 2, 0xff, 0xfe])
            .await
            .unwrap();
        fs::write(dir.join("big.txt"), "x".repeat((MAX_BLOB + 1) as usize))
            .await
            .unwrap();

        let changes = changes_since(at, &base, None).await.unwrap();
        let bin = changes.files.iter().find(|f| f.path == "bin.dat").unwrap();
        assert!(bin.binary, "git reports `-` counts, which must set the flag");

        let versions = file_versions(at, &base, &changes.head, "bin.dat", None)
            .await
            .unwrap();
        assert_eq!(versions.unreadable, Some(Unreadable::Binary));
        assert!(versions.new_text.is_none(), "lossy bytes reached the UI");

        let versions = file_versions(at, &base, &changes.head, "big.txt", None)
            .await
            .unwrap();
        assert_eq!(versions.unreadable, Some(Unreadable::TooLarge));
        assert!(versions.new_text.is_none());

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_directory_that_is_not_a_repo_has_no_baseline() {
        let dir = std::env::temp_dir().join(format!("dray-plain-{}", Uuid::now_v7()));
        fs::create_dir_all(&dir).await.unwrap();

        // What keeps the panel hidden rather than erroring at the user.
        assert!(snapshot_tree(dir.to_str().unwrap()).await.is_none());

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn gitignored_paths_stay_out_of_the_diff() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        fs::write(dir.join(".gitignore"), "dist/\n").await.unwrap();
        run(at, &["add", "-A"]).await.unwrap();
        run(at, &["commit", "-qm", "ignore"]).await.unwrap();

        let base = snapshot_tree(at).await.unwrap();

        // A build the agent kicked off is not the turn's work, and burying two
        // real edits under a thousand `dist/` rows makes the panel useless.
        fs::create_dir_all(dir.join("dist")).await.unwrap();
        fs::write(dir.join("dist/bundle.js"), "compiled\n")
            .await
            .unwrap();
        fs::write(dir.join("keep.txt"), "a\nb\nc\nreal edit\n")
            .await
            .unwrap();

        let changes = changes_since(at, &base, None).await.unwrap();
        assert_eq!(
            changes.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
            vec!["keep.txt"],
        );

        fs::remove_dir_all(&dir).await.ok();
    }

    #[test]
    fn parses_a_batch_reply_of_hits_and_misses() {
        // Verbatim shapes from `git cat-file --batch -z`, which is the only
        // place the two forms are distinguished.
        let raw = b"abc123 blob 5\nhello\ndeadbeef:no/such.ts missing\nabc124 blob 0\n\n";

        let sides = parse_batch(raw, 3);

        assert!(matches!(&sides[0], Side::Text(t) if t == "hello"));
        assert!(matches!(sides[1], Side::Missing));
        // An empty file is a hit with a zero-length body, not a miss.
        assert!(matches!(&sides[2], Side::Text(t) if t.is_empty()));
    }

    #[test]
    fn a_truncated_batch_reply_still_answers_every_side() {
        // The alignment guarantee: two sides asked for, two returned, so a
        // short stream cannot slide the new side into the old one's slot and
        // render one file's contents under another's name.
        let sides = parse_batch(b"abc123 blob 99\nshort", 2);

        assert_eq!(sides.len(), 2);
        assert!(matches!(sides[0], Side::Missing));
        assert!(matches!(sides[1], Side::Missing));
        assert_eq!(parse_batch(b"", 2).len(), 2);
    }

    #[test]
    fn batch_content_is_split_on_the_declared_size_not_on_newlines() {
        // A file's own newlines are indistinguishable from the framing one, so
        // only the header's byte count can end the body. Reading to the next
        // LF would truncate every multi-line file at its first line.
        let sides = parse_batch(b"abc123 blob 12\nline1\nline2\n\nabc124 blob 2\nhi\n", 2);

        assert!(matches!(&sides[0], Side::Text(t) if t == "line1\nline2\n"));
        assert!(matches!(&sides[1], Side::Text(t) if t == "hi"));
    }

    #[test]
    fn parses_batch_check_headers() {
        // Verbatim from `git cat-file --batch-check -z`. Bodies never appear
        // here, which is the whole reason this pass exists.
        let raw = b"45b983be36b73c0788dc9cbcb76cbb80fc7bb057 blob 3\nd8a4:no/such.ts missing\n";

        assert_eq!(parse_batch_check(raw, 2), vec![Some(3), None]);
        // Short replies pad, so a slot is never filled by a later side's size.
        assert_eq!(parse_batch_check(b"", 2), vec![None, None]);
    }

    #[tokio::test]
    async fn a_rename_reads_its_old_side_under_the_old_name() {
        // The end-to-end path for `old_path`: the baseline has no file at the
        // new name, so reading both sides under it would report an addition and
        // lose the diff entirely.
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        // Big enough for git to call it a rename. Similarity is measured over
        // bytes against the larger side, so appending one line to a three-line
        // file scores ~40% and is reported as a delete plus an add — a property
        // of the fixture, not of the code under test.
        let before: String = (0..20).map(|i| format!("line {i}\n")).collect();
        fs::write(dir.join("keep.txt"), &before).await.unwrap();
        let base = snapshot_tree(at).await.unwrap();

        fs::rename(dir.join("keep.txt"), dir.join("moved.txt"))
            .await
            .unwrap();
        let after = format!("{before}plus one\n");
        fs::write(dir.join("moved.txt"), &after).await.unwrap();

        let changes = changes_since(at, &base, None).await.unwrap();
        let file = changes
            .files
            .iter()
            .find(|f| f.path == "moved.txt")
            .expect("the new name is what the row is keyed by");
        assert_eq!(file.status, ChangeStatus::Renamed);
        assert_eq!(file.old_path.as_deref(), Some("keep.txt"));

        let versions = file_versions(at, &base, &changes.head, &file.path, file.old_path.as_deref())
            .await
            .unwrap();
        // The old side must resolve under `keep.txt`. Read under the new name it
        // would be missing, and the row would draw a whole-file addition.
        assert_eq!(versions.old_text.as_deref(), Some(before.as_str()));
        assert_eq!(versions.new_text.as_deref(), Some(after.as_str()));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn concurrent_snapshots_of_one_repo_agree() {
        // Reachable in practice: the panel refreshes off the agent's own event
        // stream while the agent is itself running git. Each snapshot writes a
        // private index, so the only shared state is the object database.
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap().to_string();

        let trees = futures_join(&at).await;

        let first = trees[0].as_ref().expect("every snapshot must succeed");
        assert!(
            trees.iter().all(|t| t.as_ref() == Some(first)),
            "same tree, same content, so every id must match: {trees:?}",
        );

        fs::remove_dir_all(&dir).await.ok();
    }

    /// Eight snapshots of one repo at once.
    async fn futures_join(cwd: &str) -> Vec<Option<String>> {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let cwd = cwd.to_string();
                tokio::spawn(async move { snapshot_tree(&cwd).await })
            })
            .collect();

        let mut out = Vec::new();
        for handle in handles {
            out.push(handle.await.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn a_hex_named_file_does_not_break_the_diff() {
        // Without the `--` terminator git reads a bare argument as either a rev
        // or a path, so a working-tree file named like a sha makes the whole
        // command die with "ambiguous argument". Build caches really do name
        // files this way.
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let base = snapshot_tree(at).await.unwrap();

        fs::write(dir.join(&base), "a cache entry named like a sha\n")
            .await
            .unwrap();

        let changes = changes_since(at, &base, None).await.unwrap();
        assert!(changes.files.iter().any(|f| f.path == base));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[test]
    fn tree_ids_must_be_hex() {
        assert!(is_tree_id("e9382e7c6d157d04e8d9f2097acdee3a9e19782e"));
        // A leading dash is the real hazard: git would read it as a flag.
        assert!(!is_tree_id("--output=/tmp/x"));
        assert!(!is_tree_id("HEAD"));
        assert!(!is_tree_id("main"));
        assert!(!is_tree_id(""));
    }

    #[test]
    fn counts_one_change_per_porcelain_line() {
        // Staged, unstaged, and untracked all count — the dialog is asking
        // whether the tree is safe to move, not what kind of dirt it holds.
        let raw = " M src/a.rs\n?? src/b.rs\nA  src/c.rs\n";

        assert_eq!(count_changes(raw), 3);
        assert_eq!(count_changes(""), 0);
        assert_eq!(count_changes("\n"), 0);
    }

    /// One record in the shape [`LOG_FORMAT`] produces.
    fn log_record(sha: &str, parents: &str, subject: &str, body: &str) -> String {
        format!(
            "{sha}\x1f{parents}\x1fTest\x1ft@example.com\x1f2026-08-22T10:00:00+05:45\x1f{subject}\x1f{body}"
        )
    }

    #[test]
    fn parses_a_log_page_into_commits() {
        let raw = format!(
            "{}\0{}\0",
            log_record("aaa1", "bbb2", "second", "why it happened\n"),
            log_record("bbb2", "", "init", ""),
        );

        let commits = parse_log(&raw);

        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].sha, "aaa1");
        assert_eq!(commits[0].parent.as_deref(), Some("bbb2"));
        assert_eq!(commits[0].subject, "second");
        assert_eq!(commits[0].body, "why it happened");
        assert_eq!(commits[0].author, "Test");
        assert_eq!(commits[0].author_email, "t@example.com");
        assert_eq!(commits[0].authored_at, "2026-08-22T10:00:00+05:45");
        // The root commit has no parent to diff against — the caller stands
        // git's empty tree in for it.
        assert_eq!(commits[1].parent, None);
        assert_eq!(commits[1].body, "");
    }

    #[test]
    fn a_merge_reads_only_its_first_parent() {
        let commits = parse_log(&log_record("aaa1", "bbb2 ccc3", "merge", ""));

        assert_eq!(commits[0].parent.as_deref(), Some("bbb2"));
    }

    #[test]
    fn a_message_carrying_the_field_separator_keeps_its_body_whole() {
        // The body is the last field precisely so this cannot shift the others.
        let commits = parse_log(&log_record("aaa1", "bbb2", "subject", "a\x1fb"));

        assert_eq!(commits[0].subject, "subject");
        assert_eq!(commits[0].body, "a\x1fb");
    }

    #[tokio::test]
    async fn a_repo_with_no_commit_yet_diffs_against_the_empty_tree() {
        let dir = std::env::temp_dir().join(format!("dray-unborn-{}", Uuid::now_v7()));
        fs::create_dir_all(&dir).await.unwrap();
        let at = dir.to_str().unwrap();
        run(at, &["init", "-q", "."]).await.unwrap();
        fs::write(dir.join("first.txt"), "hello\n").await.unwrap();

        // A real repository, so it must not read as a plain directory — and its
        // one file has to be listed, which is the whole point of not folding
        // this into `None`.
        let base = head_tree(at).await.expect("an unborn branch still has a repo");
        assert_eq!(base, EMPTY_TREE);

        let changes = changes_since(at, &base, None).await.unwrap();
        assert_eq!(
            changes.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["first.txt"],
        );
        assert_eq!(changes.files[0].status, ChangeStatus::Added);

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn head_tree_names_the_committed_side_and_a_non_repo_has_none() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        let head = head_tree(at).await.expect("a repo with a commit has a tree");

        // Clean tree, so the working-tree snapshot agrees with HEAD — which is
        // what makes an empty uncommitted list empty.
        assert_eq!(snapshot_tree(at).await.as_deref(), Some(head.as_str()));

        let empty = std::env::temp_dir().join(format!("dray-nonrepo-{}", Uuid::now_v7()));
        fs::create_dir_all(&empty).await.unwrap();
        assert_eq!(head_tree(empty.to_str().unwrap()).await, None);

        fs::remove_dir_all(&dir).await.ok();
        fs::remove_dir_all(&empty).await.ok();
    }

    #[tokio::test]
    async fn logs_pages_newest_first() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        fs::write(dir.join("keep.txt"), "a\nb\nc\nd\n").await.unwrap();
        run(at, &["commit", "-aqm", "second"]).await.unwrap();
        fs::write(dir.join("keep.txt"), "a\nb\nc\nd\ne\n").await.unwrap();
        run(at, &["commit", "-aqm", "third"]).await.unwrap();

        let page = log_commits(at, 2, 0).await.unwrap();
        assert_eq!(
            page.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
            ["third", "second"],
        );
        // The page's own commits chain, which is what lets a row diff against
        // its parent without a second read.
        assert_eq!(page[0].parent.as_deref(), Some(page[1].sha.as_str()));

        let next = log_commits(at, 2, 2).await.unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].subject, "init");
        assert_eq!(next[0].parent, None);

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_directory_that_is_not_a_repo_has_no_history() {
        let dir = std::env::temp_dir().join(format!("dray-nonrepo-{}", Uuid::now_v7()));
        fs::create_dir_all(&dir).await.unwrap();

        assert!(log_commits(dir.to_str().unwrap(), 50, 0).await.unwrap().is_empty());

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn commits_only_the_checked_paths() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        fs::write(dir.join("keep.txt"), "a\nb\nc\nedited\n").await.unwrap();
        fs::write(dir.join("gone.txt"), "x\ny\nedited\n").await.unwrap();
        // Untracked, and checked — `commit -- <path>` alone refuses a path git
        // has never heard of, so this is what proves the `add` is doing work.
        fs::write(dir.join("new.txt"), "fresh\n").await.unwrap();

        commit_files(
            at,
            "commit two of three",
            None,
            &["keep.txt".into(), "new.txt".into()],
        )
        .await
        .unwrap();

        let committed = git(at, &["show", "--name-only", "--format=", "HEAD"])
            .await
            .unwrap();
        assert!(committed.contains("keep.txt"));
        assert!(committed.contains("new.txt"));
        assert!(!committed.contains("gone.txt"));

        // The unchecked file is still dirty, which is the whole promise the
        // checkboxes make.
        let dirty = git(at, &["status", "--porcelain"]).await.unwrap();
        assert!(dirty.contains("gone.txt"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn the_working_tree_lists_the_newest_edit_first() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let base = head_tree(at).await.unwrap();

        // `gone.txt` sorts first alphabetically, so a list still in git's own
        // order would put it on top whichever was edited last.
        fs::write(dir.join("gone.txt"), "x\ny\nfirst\n").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        fs::write(dir.join("keep.txt"), "a\nb\nc\nsecond\n").await.unwrap();

        let live = changes_since(at, &base, None).await.unwrap();
        assert_eq!(
            live.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["keep.txt", "gone.txt"],
        );

        // A frozen range describes trees, not the disk, so it keeps git's order
        // however the files have been touched since.
        let frozen = snapshot_tree(at).await.unwrap();
        let then = changes_since(at, &base, Some(&frozen)).await.unwrap();
        assert_eq!(
            then.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["gone.txt", "keep.txt"],
        );

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn an_unchecked_file_keeps_what_was_staged_for_it() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        // Someone staged part of `gone.txt` by hand and then left it out of the
        // commit. The pathspec form of `commit` implies `--only`, so that work
        // has to survive — otherwise unchecking a file would quietly discard
        // whatever was already staged for it.
        fs::write(dir.join("gone.txt"), "x\ny\nstaged\n").await.unwrap();
        run(at, &["add", "gone.txt"]).await.unwrap();
        fs::write(dir.join("keep.txt"), "a\nb\nc\nedited\n").await.unwrap();

        commit_files(at, "keep only", None, &["keep.txt".into()])
            .await
            .unwrap();

        let staged = git(at, &["show", ":gone.txt"]).await.unwrap();
        assert_eq!(staged, "x\ny\nstaged\n");
        // Staged, and still uncommitted — the commit took only `keep.txt`.
        let committed = git(at, &["show", "HEAD:gone.txt"]).await.unwrap();
        assert!(!committed.contains("staged"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_checked_deletion_is_committed_as_one() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        fs::remove_file(dir.join("gone.txt")).await.unwrap();

        commit_files(at, "drop it", None, &["gone.txt".into()])
            .await
            .unwrap();

        assert!(git(at, &["cat-file", "-e", "HEAD:gone.txt"]).await.is_none());

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_glob_named_file_stages_only_itself() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        // Without GIT_LITERAL_PATHSPECS this pathspec would sweep up every
        // `a…txt` in the tree — including the decoy.
        fs::write(dir.join("a*.txt"), "literal\n").await.unwrap();
        fs::write(dir.join("also.txt"), "decoy\n").await.unwrap();

        commit_files(at, "literal path", None, &["a*.txt".into()])
            .await
            .unwrap();

        let committed = git(at, &["show", "--name-only", "--format=", "HEAD"])
            .await
            .unwrap();
        assert!(committed.contains("a*.txt"));
        assert!(!committed.contains("also.txt"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_description_lands_under_a_blank_line() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        fs::write(dir.join("keep.txt"), "a\nb\nc\nedited\n").await.unwrap();

        commit_files(at, "subject line", Some("why it happened"), &["keep.txt".into()])
            .await
            .unwrap();

        let message = git(at, &["log", "-1", "--format=%B"]).await.unwrap();
        assert_eq!(message.trim_end(), "subject line\n\nwhy it happened");

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn an_empty_summary_or_selection_is_refused() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        assert!(commit_files(at, "   ", None, &["keep.txt".into()]).await.is_err());
        assert!(commit_files(at, "fine", None, &[]).await.is_err());

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn a_branch_publishes_then_pushes() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        let remote = std::env::temp_dir().join(format!("dray-remote-{}", Uuid::now_v7()));
        fs::create_dir_all(&remote).await.unwrap();
        run(remote.to_str().unwrap(), &["init", "-q", "--bare", "."])
            .await
            .unwrap();
        run(at, &["remote", "add", "origin", remote.to_str().unwrap()])
            .await
            .unwrap();

        // Unpublished: no upstream, and no count to report against one.
        let before = sync_status(at).await;
        assert!(before.branch.is_some());
        assert_eq!(before.upstream, None);
        assert_eq!(before.ahead, 0);

        push_branch(at).await.unwrap();

        let published = sync_status(at).await;
        assert!(published.upstream.is_some());
        assert_eq!(published.ahead, 0);

        fs::write(dir.join("keep.txt"), "a\nb\nc\nmore\n").await.unwrap();
        commit_files(at, "one more", None, &["keep.txt".into()])
            .await
            .unwrap();
        assert_eq!(sync_status(at).await.ahead, 1);

        push_branch(at).await.unwrap();
        assert_eq!(sync_status(at).await.ahead, 0);

        fs::remove_dir_all(&dir).await.ok();
        fs::remove_dir_all(&remote).await.ok();
    }

    /// The composer's action row draws itself off these four facts, and a dirty
    /// count that ignores untracked files would hide the Commit button for the
    /// commonest case of all — an agent that just wrote a new file.
    #[tokio::test]
    async fn work_status_answers_what_is_left_to_do() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();

        let clean = work_status(at).await;
        assert_eq!(clean.dirty, 0);
        assert!(clean.branch.is_some());
        assert_eq!(clean.upstream, None);

        fs::write(dir.join("new.txt"), "fresh\n").await.unwrap();
        assert_eq!(work_status(at).await.dirty, 1);

        fs::remove_dir_all(&dir).await.ok();
    }

    /// The default branch is compared against `branch`, so it has to arrive
    /// without its remote — `origin/main` would never equal `main` and the row
    /// would offer to open a pull request against the branch it is already on.
    #[tokio::test]
    async fn work_status_names_the_default_branch_without_its_remote() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let remote = std::env::temp_dir().join(format!("dray-remote-{}", Uuid::now_v7()));

        fs::create_dir_all(&remote).await.unwrap();
        run(remote.to_str().unwrap(), &["init", "-q", "--bare", "."])
            .await
            .unwrap();
        run(at, &["remote", "add", "origin", remote.to_str().unwrap()])
            .await
            .unwrap();
        push_branch(at).await.unwrap();

        let status = work_status(at).await;
        let default = status.default_branch.expect("a pushed branch resolves one");
        assert!(!default.starts_with("origin/"), "still carries its remote: {default}");
        assert_eq!(Some(default), status.branch);

        fs::remove_dir_all(&dir).await.ok();
        fs::remove_dir_all(&remote).await.ok();
    }

    /// What a pull request would contain, which is not what [`SyncStatus::ahead`]
    /// counts. A branch pushed in full is level with its upstream and still ahead
    /// of the base — the case where the button is most wanted, and the one
    /// reading `ahead` would hide.
    #[tokio::test]
    async fn work_status_counts_commits_against_the_base_not_the_upstream() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let remote = std::env::temp_dir().join(format!("dray-remote-{}", Uuid::now_v7()));

        fs::create_dir_all(&remote).await.unwrap();
        run(remote.to_str().unwrap(), &["init", "-q", "--bare", "."])
            .await
            .unwrap();
        run(at, &["remote", "add", "origin", remote.to_str().unwrap()])
            .await
            .unwrap();
        push_branch(at).await.unwrap();

        // On the base itself, with everything pushed: nothing to propose.
        let on_base = work_status(at).await;
        assert_eq!(on_base.ahead_of_base, Some(0));

        run(at, &["checkout", "-q", "-b", "feature"]).await.unwrap();
        fs::write(dir.join("keep.txt"), "a\nb\nc\nchanged\n").await.unwrap();
        commit_files(at, "work", None, &["keep.txt".into()]).await.unwrap();

        // Committed but unpushed: ahead of both.
        let unpushed = work_status(at).await;
        assert_eq!(unpushed.ahead_of_base, Some(1));

        push_branch(at).await.unwrap();

        // Pushed in full. `ahead` falls back to zero and `ahead_of_base` must
        // not — this is the exact state a branch is in when its PR is opened.
        let pushed = work_status(at).await;
        assert_eq!(pushed.ahead, 0);
        assert_eq!(pushed.ahead_of_base, Some(1));

        fs::remove_dir_all(&dir).await.ok();
        fs::remove_dir_all(&remote).await.ok();
    }

    /// Only the remote comes off. A default branch holding slashes of its own —
    /// `release/current` — cut down to its last segment matches no branch, which
    /// reads as "you are on a feature branch" and offers a pull request against
    /// the branch the work is already on.
    #[tokio::test]
    async fn work_status_keeps_slashes_inside_the_default_branch_name() {
        let dir = scratch_repo().await;
        let at = dir.to_str().unwrap();
        let remote = std::env::temp_dir().join(format!("dray-remote-{}", Uuid::now_v7()));

        fs::create_dir_all(&remote).await.unwrap();
        run(remote.to_str().unwrap(), &["init", "-q", "--bare", "."])
            .await
            .unwrap();
        run(at, &["remote", "add", "origin", remote.to_str().unwrap()])
            .await
            .unwrap();

        run(at, &["checkout", "-q", "-b", "release/current"]).await.unwrap();
        push_branch(at).await.unwrap();
        // `-b` on the ref git would have written for us, so `origin/HEAD`
        // resolves the way a cloned repo's does.
        run(
            at,
            &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/current"],
        )
        .await
        .unwrap();

        let status = work_status(at).await;
        assert_eq!(status.default_branch.as_deref(), Some("release/current"));
        // And so the handoff row sees it as the branch it is on, not a feature
        // branch to open a pull request from.
        assert_eq!(status.default_branch, status.branch);

        fs::remove_dir_all(&dir).await.ok();
        fs::remove_dir_all(&remote).await.ok();
    }

    /// Outside a repo every field has to answer "nothing to do" rather than
    /// error — the row hides on `branch` being `None`.
    #[tokio::test]
    async fn work_status_outside_a_repo_offers_nothing() {
        let dir = std::env::temp_dir().join(format!("dray-plain-{}", Uuid::now_v7()));
        fs::create_dir_all(&dir).await.unwrap();

        let status = work_status(dir.to_str().unwrap()).await;
        assert_eq!(status.branch, None);
        assert_eq!(status.dirty, 0);

        fs::remove_dir_all(&dir).await.ok();
    }
}
