use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{fs, sync::Mutex};
use ts_rs::TS;

use crate::{
    events::now_rfc3339,
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
    /// The Linear workspace (`organization.id`) this project reads, where it
    /// pins its own. `None` reads its Space's pin, then the default — see
    /// [`crate::issues::pinned_workspace`]. A tag on the project and nothing
    /// else, the same kind of record `space` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub linear_workspace: Option<String>,
    /// Which project launch reopens, and nothing else. It was the sort key too,
    /// which moved every picker's rows on each pick; order is now the file's
    /// own, set by the reader in Settings.
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

/// Reads `projects.json` in the reader's own order. A missing or empty file
/// means no projects yet, not an error — same convention as the session index.
///
/// Unsorted on purpose: files written before order was manual were saved
/// most-recent-first, so that is simply where an existing list starts.
#[tauri::command]
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
#[tauri::command]
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
            linear_workspace: None,
            last_selected: now,
        }),
    }

    write_projects(&projects).await?;

    Ok(projects)
}

/// Detaches a project. Sessions that ran in it are untouched — they keep their
/// own recorded paths and stay in the sidebar.
#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

/// Pins a project to a Linear workspace, or clears its own pin with `None` so
/// it reads its Space's again.
#[tauri::command]
pub async fn set_project_linear_workspace(
    path: &str,
    workspace: Option<String>,
) -> Result<Vec<Project>, Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    let Some(i) = projects.iter().position(|p| p.path == path) else {
        return Ok(projects);
    };

    projects[i].linear_workspace = workspace.filter(|w| !w.is_empty());
    write_projects(&projects).await?;

    Ok(projects)
}

/// Steps a project `delta` places in the order every picker draws. Past either
/// end is a no-op rather than a wrap, matching the spaces list beside it.
#[tauri::command]
pub async fn move_project(path: &str, delta: isize) -> Result<Vec<Project>, Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    if move_by(&mut projects, path, delta) {
        write_projects(&projects).await?;
    }

    Ok(projects)
}

/// Clears every project's pin to a workspace being disconnected, so a
/// reconnect later starts from the default rather than reviving pins the reader
/// saw go.
pub async fn clear_linear_workspace(workspace: &str) -> Result<()> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    let mut cleared = false;
    for project in &mut projects {
        if project.linear_workspace.as_deref() == Some(workspace) {
            project.linear_workspace = None;
            cleared = true;
        }
    }

    if cleared {
        write_projects(&projects).await?;
    }
    Ok(())
}

/// The attached project a directory sits in: the longest project path it is
/// under, so a worktree at `<project>/.claude/worktrees/<name>` answers its
/// project. By path component, never by string prefix, or `/x/app` would claim
/// `/x/app-web`.
pub fn project_for_dir<'a>(projects: &'a [Project], dir: &str) -> Option<&'a Project> {
    let dir = std::path::Path::new(dir);

    projects
        .iter()
        .filter(|project| dir.starts_with(&project.path))
        .max_by_key(|project| project.path.len())
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
#[tauri::command]
pub async fn retag_space(from: &str, to: Option<String>) -> Result<Vec<Project>, Fail> {
    let _guard = PROJECTS_LOCK.lock().await;
    let mut projects = list_projects().await?;

    // The Space's Linear pin follows it, and is moved even where no project
    // carried the tag: a Space can be pinned before anything is filed in it.
    // **First**, so a failed move fails the rename before any tag changes —
    // the pin and the tags land together or neither does, and the caller's
    // record of spaces follows either way. A rename onto a Space that has its
    // own pin keeps that one.
    let to_name = normalize_space(to.clone());
    // What the move actually did, recorded inside the settings write itself:
    // a reading taken before it can be stale by the time a rollback needs it.
    let mut moved: Option<String> = None;
    let mut placed = false;
    if crate::settings::read().await.linear_space_pins.contains_key(from) {
        crate::settings::update(|next| {
            if let Some(pin) = next.linear_space_pins.remove(from) {
                if let Some(to) = to_name.as_ref().filter(|to| !next.linear_space_pins.contains_key(*to)) {
                    next.linear_space_pins.insert(to.clone(), pin.clone());
                    placed = true;
                }
                moved = Some(pin);
            }
        })
        .await?;
    }

    // A space nobody had filled yet carries no tag, so changing nothing is the
    // ordinary path for renaming one — and a rewrite that moves no value is one
    // every other reader of this file has to survive for no reason.
    if retag(&mut projects, from, to) {
        if let Err(e) = write_projects(&projects).await {
            // Put the pin back where the tags still are. The destination loses
            // only the pin this rename placed there, and only while it is
            // still that one: a pin set on it since is somebody's own choice.
            // Nor does the source lose a pin set on it since.
            if let Some(pin) = moved {
                let undone = crate::settings::update(|next| {
                    if let Some(to) = to_name.as_ref().filter(|_| placed) {
                        if next.linear_space_pins.get(to) == Some(&pin) {
                            next.linear_space_pins.remove(to);
                        }
                    }
                    next.linear_space_pins.entry(from.to_string()).or_insert(pin);
                })
                .await;
                if let Err(undo) = undone {
                    eprintln!("[settings write err] space pin not put back: {undo:#}");
                }
            }
            return Err(e.into());
        }
    }

    Ok(projects)
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
            linear_workspace: None,
            last_selected: "2026-08-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_worktree_belongs_to_the_project_it_sits_in() {
        let projects = vec![filed("/x/app", None), filed("/x/app-web", None)];

        let at = |dir| project_for_dir(&projects, dir).map(|p| p.path.as_str());
        assert_eq!(at("/x/app"), Some("/x/app"));
        assert_eq!(at("/x/app/.claude/worktrees/bold-fox"), Some("/x/app"));
        // A string prefix would hand this to `/x/app`.
        assert_eq!(at("/x/app-web/src"), Some("/x/app-web"));
        assert_eq!(at("/elsewhere"), None);
    }

    #[test]
    fn the_innermost_project_wins() {
        let projects = vec![filed("/x", None), filed("/x/inner", None)];

        assert_eq!(
            project_for_dir(&projects, "/x/inner/src").map(|p| p.path.as_str()),
            Some("/x/inner")
        );
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
    fn basename_handles_trailing_slash_and_root() {
        assert_eq!(basename("/Users/y/proj"), "proj");
        assert_eq!(basename("/Users/y/proj/"), "proj");
        assert_eq!(basename("/"), "/");
    }
}
