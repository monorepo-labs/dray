use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
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
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await?;

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

    let files = match diff_trees(cwd, base, &head).await {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
