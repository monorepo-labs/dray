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
                last_selected: "2026-08-01T00:00:00Z".into(),
            },
            Project {
                path: "/b".into(),
                name: "b".into(),
                last_selected: "2026-08-08T00:00:00Z".into(),
            },
        ];

        projects.sort_by(|a, b| b.last_selected.cmp(&a.last_selected));

        // The picker takes its default from the front, so this ordering is the
        // whole of "reopen the project I was last in".
        assert_eq!(projects[0].path, "/b");
    }

    #[test]
    fn basename_handles_trailing_slash_and_root() {
        assert_eq!(basename("/Users/y/proj"), "proj");
        assert_eq!(basename("/Users/y/proj/"), "proj");
        assert_eq!(basename("/"), "/");
    }
}
