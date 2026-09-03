use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{fs, sync::Mutex};
use ts_rs::TS;

use crate::{events::now_rfc3339, store::get_home_app_dir};

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
    /// Doubles as the sort key and the "which project was last open" answer:
    /// selecting a project *is* what makes it most recent, so a separate
    /// `last_selected` pointer would be a second place to keep the same fact.
    pub last_selected: String,
}

static PROJECTS_LOCK: Mutex<()> = Mutex::const_new(());

/// Resolves symlinks and drops any trailing slash, so `/x/proj` and `/x/proj/`
/// can't become two projects and split the sidebar's grouping.
async fn canonical(path: &str) -> Result<String> {
    let resolved = fs::canonicalize(path)
        .await
        .with_context(|| format!("no such directory: {path}"))?;

    Ok(resolved.to_string_lossy().into_owned())
}

/// Reads `projects.json`, most recently selected first — so the picker's order
/// and its default are both just `projects[0]`. A missing or empty file means
/// no projects yet, not an error — same convention as the session index.
pub async fn read_projects() -> Result<Vec<Project>> {
    let path = get_home_app_dir().await?.join("projects.json");

    let contents = match fs::read_to_string(path).await {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).context("could not open projects file"),
    };

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut projects: Vec<Project> = serde_json::from_str(&contents)?;
    // Descending, so the newest selection sorts to the front. RFC 3339 stamps
    // compare correctly as strings at fixed width.
    projects.sort_by(|a, b| b.last_selected.cmp(&a.last_selected));

    Ok(projects)
}

/// Caller must hold `PROJECTS_LOCK`: this rewrites the whole file, so a
/// concurrent writer would drop the other's entry.
async fn write_projects(projects: &[Project]) -> Result<()> {
    let path = get_home_app_dir().await?.join("projects.json");
    let contents = serde_json::to_string(projects)?;
    let tmp = path.with_extension("json.tmp");

    fs::write(&tmp, contents)
        .await
        .context("failed to write projects")?;

    fs::rename(&tmp, &path)
        .await
        .context("failed to rename projects")?;

    Ok(())
}

/// Attaches a directory and selects it. Re-attaching a known project is a
/// no-op apart from the selection, so the picker's "Attach" can double as
/// "switch to one I already have" without growing duplicates.
pub async fn add_project(path: &str) -> Result<Vec<Project>> {
    let path = canonical(path).await?;

    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = read_projects().await?;
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

    projects.sort_by(|a, b| b.last_selected.cmp(&a.last_selected));
    write_projects(&projects).await?;

    Ok(projects)
}

/// Detaches a project. Sessions that ran in it are untouched — they keep their
/// own recorded paths and stay in the sidebar.
pub async fn remove_project(path: &str) -> Result<Vec<Project>> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = read_projects().await?;

    projects.retain(|p| p.path != path);
    write_projects(&projects).await?;

    Ok(projects)
}

/// Stamps a project as the most recently selected, which also moves it to the
/// front of the next read. Unknown paths are ignored rather than inserted —
/// attaching is [`add_project`]'s job.
pub async fn set_last_selected_project(path: &str) -> Result<()> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = read_projects().await?;

    let Some(project) = projects.iter_mut().find(|p| p.path == path) else {
        return Ok(());
    };

    project.last_selected = now_rfc3339();
    projects.sort_by(|a, b| b.last_selected.cmp(&a.last_selected));

    write_projects(&projects).await
}

/// Files a project under a space, or clears it with `None`. A blank name is
/// the same as clearing: an empty string would draw a nameless entry in the
/// switcher that nothing could ever be moved out of.
pub async fn set_project_space(path: &str, space: Option<String>) -> Result<Vec<Project>> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = read_projects().await?;

    // By index, not `iter_mut().find()`: the borrow checker will not let the
    // not-found arm hand the list back while a mutable borrow of it is alive.
    let Some(i) = projects.iter().position(|p| p.path == path) else {
        return Ok(projects);
    };

    projects[i].space = normalize_space(space);
    write_projects(&projects).await?;

    Ok(projects)
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
pub async fn retag_space(from: &str, to: Option<String>) -> Result<Vec<Project>> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = read_projects().await?;

    // A space nobody had filled yet carries no tag, so changing nothing is the
    // ordinary path for renaming one — and a rewrite that moves no value is one
    // every other reader of this file has to survive for no reason.
    if retag(&mut projects, from, to) {
        write_projects(&projects).await?;
    }

    Ok(projects)
}

/// Trailing path segment. Mirrors the frontend's `basename` so a project's
/// cached label matches what the UI would derive from the path.
fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn most_recently_selected_sorts_first() {
        let mut projects = vec![
            Project {
                path: "/a".into(),
                name: "a".into(),
                space: None,
                last_selected: "2026-08-01T00:00:00Z".into(),
            },
            Project {
                path: "/b".into(),
                name: "b".into(),
                space: None,
                last_selected: "2026-08-08T00:00:00Z".into(),
            },
        ];

        projects.sort_by(|a, b| b.last_selected.cmp(&a.last_selected));

        // The picker takes its default from the front, so this ordering is the
        // whole of "reopen the project I was last in".
        assert_eq!(projects[0].path, "/b");
    }

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
    fn basename_handles_trailing_slash_and_root() {
        assert_eq!(basename("/Users/y/proj"), "proj");
        assert_eq!(basename("/Users/y/proj/"), "proj");
        assert_eq!(basename("/"), "/");
    }
}
