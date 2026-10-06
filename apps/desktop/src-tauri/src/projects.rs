use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncReadExt, process::Command, sync::Mutex};
use ts_rs::TS;

use crate::{
    binpath,
    events::now_rfc3339,
    git,
    github::{self, PrUnavailable},
    sink::Sink,
    store::{get_home_app_dir, read_json, write_atomic},
    Fail,
};

/// A directory the user attached, and the root a session runs in. Distinct from
/// [`crate::store::SessionIndexItem::project_path`], which records where a
/// session *did* run — a project can be detached without rewriting history.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Canonicalized at attach time, so this is the only spelling of the path
    /// that ever reaches the index or the sidebar's grouping key.
    pub path: String,
    /// Folder name as of attaching. Cached so a project whose directory was
    /// since renamed or removed still has a label.
    pub name: String,
    /// Which space the project belongs to, or `None` for one nobody filed.
    /// The tag is the whole record of a space — there is no spaces file — so a
    /// space exists exactly while some project names it, and the last project
    /// leaving takes it with them.
    #[serde(default)]
    pub space: Option<String>,
    /// Which project launch reopens, and nothing else. It was the sort key too,
    /// which moved every picker's rows on each pick; order is now the file's
    /// own, set by the reader in Settings.
    pub last_selected: String,
}

static PROJECTS_LOCK: Mutex<()> = Mutex::const_new(());

/// Resolves symlinks and drops any trailing slash, so `/x/proj` and `/x/proj/`
/// can't become two projects and split the sidebar's grouping. A leading `~/`
/// is the reader's home: typing a path on a server, they rarely know its
/// absolute spelling.
async fn canonical(path: &str) -> Result<String> {
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => home()?.join(rest),
        None => PathBuf::from(path),
    };
    let resolved = fs::canonicalize(&expanded)
        .await
        .with_context(|| format!("no such directory: {path}"))?;
    if !resolved.is_dir() {
        bail!("not a directory: {path}");
    }

    Ok(resolved.to_string_lossy().into_owned())
}

fn home() -> Result<PathBuf> {
    std::env::home_dir().context("could not resolve home directory")
}

/// Reads `projects.json` in the reader's own order. A missing or empty file
/// means no projects yet, not an error — same convention as the session index.
///
/// Unsorted on purpose: files written before order was manual were saved
/// most-recent-first, so that is simply where an existing list starts.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_projects() -> Result<Vec<Project>, Fail> {
    Ok(read_json(&projects_path().await?).await?)
}

async fn projects_path() -> Result<std::path::PathBuf> {
    Ok(get_home_app_dir().await?.join("projects.json"))
}

/// Caller must hold `PROJECTS_LOCK`: this rewrites the whole file, so a
/// concurrent writer would drop the other's entry.
async fn write_projects(projects: &[Project]) -> Result<()> {
    write_atomic(&projects_path().await?, serde_json::to_string(projects)?).await
}

/// Attaches a directory at the end of the list and selects it. Re-attaching a known project is a
/// no-op apart from the selection, so the picker's "Attach" can double as
/// "switch to one I already have" without growing duplicates.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn add_project(path: &str) -> Result<Vec<Project>, Fail> {
    let path = canonical(path).await?;

    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;
    let now = now_rfc3339();

    match projects.iter_mut().find(|p| p.path == path) {
        Some(existing) => existing.last_selected = now,
        None => projects.push(Project {
            name: basename(&path),
            path,
            space: None,
            last_selected: now,
        }),
    }

    write_projects(&projects).await?;

    Ok(projects)
}

/// Detaches a project. Sessions that ran in it are untouched — they keep their
/// own recorded paths and stay in the sidebar.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn remove_project(path: &str) -> Result<Vec<Project>, Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    projects.retain(|p| p.path != path);
    write_projects(&projects).await?;

    Ok(projects)
}

/// Stamps a project as the most recently selected, which is what launch
/// reopens. Order is untouched. Unknown paths are ignored rather than inserted —
/// attaching is [`add_project`]'s job.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_last_selected_project(path: &str) -> Result<(), Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    let Some(project) = projects.iter_mut().find(|p| p.path == path) else {
        return Ok(());
    };

    project.last_selected = now_rfc3339();

    Ok(write_projects(&projects).await?)
}

/// Files a project under a space, or clears it with `None`. A blank name is
/// the same as clearing: an empty string would draw a nameless entry in the
/// switcher that nothing could ever be moved out of.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_project_space(path: &str, space: Option<String>) -> Result<Vec<Project>, Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    // By index, not `iter_mut().find()`: the borrow checker will not let the
    // not-found arm hand the list back while a mutable borrow of it is alive.
    let Some(i) = projects.iter().position(|p| p.path == path) else {
        return Ok(projects);
    };

    projects[i].space = normalize_space(space);
    write_projects(&projects).await?;

    Ok(projects)
}

/// Steps a project `delta` places in the order every picker draws. Past either
/// end is a no-op rather than a wrap, matching the spaces list beside it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn move_project(path: &str, delta: isize) -> Result<Vec<Project>, Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    if move_by(&mut projects, path, delta) {
        write_projects(&projects).await?;
    }

    Ok(projects)
}

/// The edit [`move_project`] makes, split from the file so it can be tested.
/// Answers whether anything moved.
fn move_by(projects: &mut Vec<Project>, path: &str, delta: isize) -> bool {
    let Some(from) = projects.iter().position(|p| p.path == path) else {
        return false;
    };
    let to = from as isize + delta;
    if delta == 0 || to < 0 || to >= projects.len() as isize {
        return false;
    }
    let project = projects.remove(from);
    projects.insert(to as usize, project);
    true
}

/// A blank name is the same as no space: an empty string would draw a nameless
/// entry in the switcher that nothing could ever be moved out of.
fn normalize_space(space: Option<String>) -> Option<String> {
    space.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The edit [`retag_space`] makes, split from the file so it can be tested
/// without a `~/.dray` to write into. Answers whether anything moved.
fn retag(projects: &mut [Project], from: &str, to: Option<String>) -> bool {
    let to = normalize_space(to);
    let mut moved = false;

    for project in projects.iter_mut() {
        if project.space.as_deref() != Some(from) {
            continue;
        }
        project.space = to.clone();
        moved = true;
    }

    moved
}

/// Moves every project filed under one space to another, or out of any space
/// with `None` — a rename and a removal being the same operation.
///
/// One call rather than one per project, and that is the whole point: the
/// caller's own record of which spaces exist is updated beside this, so a run
/// of writes half of which failed would leave tags and that record describing
/// different worlds. Here it is one read, one edit and one write under the
/// lock, so it either all lands or none of it does.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn retag_space(from: &str, to: Option<String>) -> Result<Vec<Project>, Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    // A space nobody had filled yet carries no tag, so changing nothing is the
    // ordinary path for renaming one — and a rewrite that moves no value is one
    // every other reader of this file has to survive for no reason.
    if retag(&mut projects, from, to) {
        write_projects(&projects).await?;
    }

    Ok(projects)
}

// ── attaching from GitHub ─────────────────────────────────────────────────────

/// Where a picked repo is cloned, under the reader's real home — never
/// `DRAY_HOME`, which moves Dray's data, where a clone is the reader's work.
const CLONE_DIR: &str = "dray";

/// A repository the signed-in `gh` user can reach.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    /// `owner/name`.
    pub slug: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Where it already lives on this machine: an attached project, or a
    /// directory in `~/dray` whose GitHub remote names it. Picking one of these
    /// attaches it rather than cloning again.
    #[serde(default)]
    pub path: Option<String>,
}

/// One line of git's progress while a repo clones.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
pub struct CloneProgress {
    pub slug: String,
    pub line: String,
}

/// Every repository the signed-in `gh` user can reach — own, collaborator,
/// organisation member — newest push first, with the ones already on this
/// machine moved to the front.
///
/// Fails the way the PR panel's read does, so a missing or logged-out `gh`
/// arrives typed and the dialog draws the same setup reading.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn github_repos() -> Result<Vec<GithubRepo>, PrUnavailable> {
    let home = home().map_err(|e| PrUnavailable::Other(e.to_string()))?;
    let out = github::gh(
        &home.to_string_lossy(),
        &[
            "api",
            "--paginate",
            "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
            "--jq",
            ".[] | {slug: .full_name, description}",
        ],
    )
    .await
    .map_err(github::unavailable)?;

    let mut repos = out
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str::<GithubRepo>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| PrUnavailable::Other(format!("could not read gh's answer: {e}")))?;

    let here = local_copies(&home).await;
    for repo in &mut repos {
        repo.path = here.get(&repo.slug.to_lowercase()).cloned();
    }
    // Stable, so each half keeps gh's newest-first order.
    repos.sort_by_key(|repo| repo.path.is_none());

    Ok(repos)
}

/// Lowercased `owner/name` → where that repo already lives here. Attached
/// projects are read first and win, being the copy the reader chose.
async fn local_copies(home: &Path) -> HashMap<String, String> {
    let mut dirs: Vec<String> = list_projects()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.path)
        .collect();
    if let Ok(mut entries) = fs::read_dir(home.join(CLONE_DIR)).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            dirs.push(entry.path().to_string_lossy().into_owned());
        }
    }

    let slugs = futures_util::future::join_all(dirs.iter().map(|dir| git::github_slug(dir))).await;
    let mut found = HashMap::new();
    for (dir, slug) in dirs.into_iter().zip(slugs) {
        if let Some(slug) = slug {
            found.entry(slug.to_lowercase()).or_insert(dir);
        }
    }
    found
}

/// Clones `slug` into `~/dray/<name>` and attaches it, emitting git's progress
/// as `clone_progress` while it runs.
///
/// A folder already there is attached where it is a clone of `slug` — the
/// reader cloned it before, or picked it twice — and refused otherwise, since
/// cloning beside it is impossible and over it would destroy something.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn clone_github_repo(slug: String, sink: Sink) -> Result<Vec<Project>, Fail> {
    let name = repo_name(&slug).ok_or_else(|| anyhow!("not a GitHub repository: {slug}"))?;
    let parent = home()?.join(CLONE_DIR);
    let dir = parent.join(name);
    let path = dir.to_string_lossy().into_owned();
    let shown = format!("~/{CLONE_DIR}/{name}");

    if fs::try_exists(&dir).await.unwrap_or(false) {
        return match git::github_slug(&path).await {
            Some(found) if found.eq_ignore_ascii_case(&slug) => add_project(&path).await,
            Some(found) => {
                Err(anyhow!("{shown} already holds {found}. Move it aside, or attach it by path.").into())
            }
            None => Err(anyhow!(
                "{shown} already exists and is not a clone of {slug}. Move it aside, or attach it by path."
            )
            .into()),
        };
    }

    fs::create_dir_all(&parent).await.map_err(anyhow::Error::from)?;
    clone(&slug, &dir, &sink).await.map_err(|e| anyhow!(e))?;
    add_project(&path).await
}

/// The name half of `owner/name`, or `None` unless both halves are spelled the
/// way GitHub allows: the name becomes a directory and the slug an argument to
/// `gh`, so a `..` or a leading `-` must never reach either.
fn repo_name(slug: &str) -> Option<&str> {
    let (owner, name) = slug.split_once('/')?;
    let fits = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    (fits(owner) && fits(name)).then_some(name)
}

/// `gh repo clone`, on gh's own protocol and login. `Err` is the tail of what
/// gh and git said, the sentence the reader would have seen in a terminal.
async fn clone(slug: &str, dir: &Path, sink: &Sink) -> Result<(), String> {
    let bin = binpath::gh().await.ok_or(github::NO_CLI)?;
    let mut child = Command::new(bin)
        .args(["repo", "clone", slug])
        .arg(dir)
        // git writes progress to a terminal alone unless asked.
        .args(["--", "--progress"])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        // A credential prompt nobody can answer is a clone that never returns.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run gh: {e}"))?;

    let mut stderr = child.stderr.take().ok_or("gh gave no stderr")?;
    let mut buf = [0u8; 4096];
    let mut pending = String::new();
    // Lines ended by `\n` are messages; `\r` ends a progress redraw, which is
    // shown live and never kept for the error.
    let mut said: Vec<String> = Vec::new();
    loop {
        let n = stderr.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        pending.push_str(&String::from_utf8_lossy(&buf[..n]));
        while let Some(end) = pending.find(['\r', '\n']) {
            let message = pending.as_bytes()[end] == b'\n';
            let line = pending[..end].trim().to_string();
            pending.drain(..=end);
            if line.is_empty() {
                continue;
            }
            let _ = sink.emit("clone_progress", CloneProgress { slug: slug.to_string(), line: line.clone() });
            if message && !line.starts_with("Cloning into") {
                said.push(line);
            }
        }
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    let tail = said[said.len().saturating_sub(4)..].join("\n");
    Err(if tail.is_empty() { "gh repo clone failed".to_string() } else { tail })
}

/// Trailing path segment. Mirrors the frontend's `basename` so a project's
/// cached label matches what the UI would derive from the path.
fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map_or(path.to_string(), |name| name.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_written_before_spaces_existed_still_reads() {
        // The file is rewritten whole, so one entry failing to parse is the
        // whole index of projects gone.
        let project: Project = serde_json::from_str(
            r#"{"path":"/a","name":"a","lastSelected":"2026-08-01T00:00:00Z"}"#,
        )
        .unwrap();

        assert_eq!(project.space, None);
    }

    fn filed(path: &str, space: Option<&str>) -> Project {
        Project {
            path: path.into(),
            name: path.into(),
            space: space.map(Into::into),
            last_selected: "2026-08-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn move_by_steps_one_place_and_stops_at_the_ends() {
        let paths = |ps: &[Project]| ps.iter().map(|p| p.path.clone()).collect::<Vec<_>>();
        let mut projects = vec![filed("/a", None), filed("/b", None), filed("/c", None)];

        assert!(move_by(&mut projects, "/c", -1));
        assert_eq!(paths(&projects), ["/a", "/c", "/b"]);
        assert!(!move_by(&mut projects, "/a", -1));
        assert!(!move_by(&mut projects, "/b", 1));
        assert!(!move_by(&mut projects, "/missing", 1));
        assert_eq!(paths(&projects), ["/a", "/c", "/b"]);
    }

    #[test]
    fn retag_moves_one_space_and_leaves_the_rest() {
        let mut projects = vec![
            filed("/a", Some("Work")),
            filed("/b", Some("Personal")),
            filed("/c", None),
            filed("/d", Some("Work")),
        ];

        assert!(retag(&mut projects, "Work", Some("Client".into())));
        let spaces: Vec<_> = projects.iter().map(|p| p.space.as_deref()).collect();
        assert_eq!(spaces, [Some("Client"), Some("Personal"), None, Some("Client")]);
    }

    #[test]
    fn retag_to_nothing_is_how_a_space_is_removed() {
        let mut projects = vec![filed("/a", Some("Work")), filed("/b", Some("Personal"))];

        assert!(retag(&mut projects, "Work", None));
        assert_eq!(projects[0].space, None);
        assert_eq!(projects[1].space.as_deref(), Some("Personal"));
    }

    #[test]
    fn retagging_a_space_no_project_carries_writes_nothing() {
        // A space made and not yet filled is renamed in the caller's own list
        // alone, so the file must not be rewritten to change nothing.
        let mut projects = vec![filed("/a", Some("Work"))];

        assert!(!retag(&mut projects, "Empty", Some("Renamed".into())));
        assert_eq!(projects[0].space.as_deref(), Some("Work"));
    }

    #[test]
    fn a_blank_name_files_a_project_under_nothing() {
        // Otherwise the switcher draws a nameless entry nothing can leave.
        assert_eq!(normalize_space(Some("  ".into())), None);
        assert_eq!(normalize_space(Some(" Work ".into())), Some("Work".into()));
    }

    #[test]
    fn repo_name_takes_what_github_spells_and_nothing_else() {
        assert_eq!(repo_name("monorepo-labs/dray"), Some("dray"));
        assert_eq!(repo_name("acme/.github"), Some(".github"));
        assert_eq!(repo_name("a_b/c.d-e"), Some("c.d-e"));
        for bad in ["dray", "/dray", "acme/", "acme/..", "acme/.", "-x/y", "x/-y", "a/b/c", "a/b c", "a/b;rm"] {
            assert_eq!(repo_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn basename_handles_trailing_slash_and_root() {
        assert_eq!(basename("/Users/y/proj"), "proj");
        assert_eq!(basename("/Users/y/proj/"), "proj");
        assert_eq!(basename("/"), "/");
    }
}
