//! Asking the reader to star Dray on GitHub, after a merge made in the app.
//!
//! Asked after the first merge and, where that did not end in a star, once
//! more after the tenth; never after that. The count lives in the app's
//! `star-prompt.json` rather than the webview's storage, whose origin moves
//! with the dev port.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{github, store};

const REPO: &str = "monorepo-labs/dray";

/// The merge counts each ask waits for, in order.
const ASK_AT: [u32; 2] = [1, 10];

/// `gh` waits on the network with no deadline of its own, and the check runs
/// under the file lock, so a stalled one would hold every later merge's count.
const GH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct State {
    merges: u32,
    asked: u32,
    starred: bool,
}

/// Whether the next ask's merge count is reached.
fn due(state: &State) -> bool {
    !state.starred && ASK_AT.get(state.asked as usize).is_some_and(|&at| state.merges >= at)
}

async fn path() -> Option<std::path::PathBuf> {
    store::config_dir().await.ok().map(|dir| dir.join("star-prompt.json"))
}

async fn load() -> State {
    let Some(path) = path().await else { return State::default() };
    tokio::fs::read(path).await.ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default()
}

async fn save(state: &State) {
    let (Some(path), Ok(json)) = (path().await, serde_json::to_vec(state)) else { return };
    if let Err(e) = store::write_atomic(&path, json).await {
        eprintln!("[star] could not save {}: {e}", path.display());
    }
}

fn home() -> Option<String> {
    std::env::home_dir()?.to_str().map(str::to_string)
}

/// `gh api` on Dray's star, against github.com whatever `GH_HOST` says, since
/// that is where the card sends the reader.
async fn star_api(method: &str) -> Result<String, String> {
    let home = home().ok_or("no home directory")?;
    let path = format!("user/starred/{REPO}");
    let args = ["api", "--hostname", "github.com", "-X", method, &path];
    tokio::time::timeout(GH_TIMEOUT, github::gh(&home, &args))
        .await
        .unwrap_or_else(|_| Err("gh timed out".into()))
}

/// Whether the reader's `gh` login has starred Dray, or `None` where it could
/// not say — no `gh`, logged out, offline. The API answers 204 or 404.
async fn has_starred() -> Option<bool> {
    match star_api("GET").await {
        Ok(_) => Some(true),
        Err(e) if e.contains("HTTP 404") => Some(false),
        Err(_) => None,
    }
}

/// Counts a merge made in the app and answers whether to ask for a star now.
/// An ask is spent the moment it is answered `true`, so dismissing the card
/// and quitting with it open both count as asked.
#[tauri::command]
pub async fn note_merge_for_star() -> bool {
    // Across processes: every worktree's dev build shares this file.
    let _guard = store::lock_across_processes("star-prompt").await;
    let mut state = load().await;
    state.merges = state.merges.saturating_add(1);
    let ask = due(&state)
        && match has_starred().await {
            Some(true) => {
                state.starred = true;
                false
            }
            // Unknown still asks: Star falls back to opening the repo page.
            _ => true,
        };
    if ask {
        state.asked += 1;
    }
    save(&state).await;
    ask
}

/// Stars Dray as the reader's `gh` login. An error tells the card to open the
/// repo page instead.
#[tauri::command]
pub async fn star_dray() -> Result<(), String> {
    star_api("PUT").await?;
    crate::analytics::feature_used("github_starred");
    let _guard = store::lock_across_processes("star-prompt").await;
    let mut state = load().await;
    state.starred = true;
    save(&state).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(merges: u32, asked: u32) -> State {
        State { merges, asked, starred: false }
    }

    #[test]
    fn asks_on_the_first_merge_then_the_tenth_then_never() {
        assert!(!due(&at(0, 0)));
        assert!(due(&at(1, 0)));
        assert!(!due(&at(2, 1)));
        assert!(!due(&at(9, 1)));
        assert!(due(&at(10, 1)));
        assert!(!due(&at(11, 2)));
        assert!(!due(&at(500, 2)));
    }

    #[test]
    fn a_star_ends_the_asking() {
        assert!(!due(&State { merges: 1, asked: 0, starred: true }));
        assert!(!due(&State { merges: 10, asked: 1, starred: true }));
    }

    #[test]
    fn an_old_or_partial_file_reads_as_defaults() {
        let state: State = serde_json::from_str(r#"{"merges":3}"#).unwrap();
        assert_eq!(state, at(3, 0));
    }
}
