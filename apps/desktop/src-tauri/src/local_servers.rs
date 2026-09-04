//! Local web servers worth offering in the browser's empty state: the ones
//! belonging to *this* session's checkout.
//!
//! Two signals, since neither alone is right: anything listening under the
//! session's agent process is that session's server whoever asked for it,
//! and anything listening from a process whose working directory is inside
//! the session's tree is one the reader started by hand in that checkout.
//! Everything else on the machine — another worktree's server, databases,
//! daemons — is left out, so a list of one is the usual answer.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::session::SessionManager;
use crate::store::get_session_index_item;

#[derive(Clone, Serialize, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub port: u16,
    pub process: String,
    /// Started under this session's agent, as against by hand in its tree.
    pub mine: bool,
}

#[tauri::command]
pub async fn list_local_servers(
    session_id: String,
    manager: State<'_, SessionManager>,
) -> Result<Vec<LocalServer>, String> {
    let root = manager.child_pid(&session_id).await;
    let cwd = get_session_index_item(&session_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|item| PathBuf::from(item.cwd));
    tokio::task::spawn_blocking(move || Ok(discover(root, cwd.as_deref())))
        .await
        .map_err(|e| e.to_string())?
}

fn discover(root: Option<u32>, tree: Option<&Path>) -> Vec<LocalServer> {
    let mine = root.map(descendants).unwrap_or_default();
    let listeners = listening();
    let cwds = cwd_of(listeners.iter().map(|(pid, _, _)| *pid).collect());
    // lsof reports resolved paths, so a checkout reached through a symlink
    // never matched its own servers until the tree was resolved too.
    let tree = tree.map(|t| std::fs::canonicalize(t).unwrap_or_else(|_| t.to_path_buf()));
    let in_tree = |pid: u32| {
        tree.as_deref()
            .zip(cwds.get(&pid))
            .map(|(tree, cwd)| std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.clone()).starts_with(tree))
            .unwrap_or(false)
    };
    // Dray's own DevTools port lists otherwise: a dev build runs from the tree.
    let me = std::process::id();
    let mut seen = HashSet::new();
    let mut out: Vec<LocalServer> = listeners
        .into_iter()
        .filter(|(pid, _, _)| *pid != me)
        .filter_map(|(pid, name, port)| {
            let is_mine = mine.contains(&pid);
            (is_mine || in_tree(pid)).then_some(LocalServer { port, process: name, mine: is_mine })
        })
        .filter(|s| seen.insert(s.port))
        .collect();
    out.sort_by_key(|s| (!s.mine, s.port));
    out
}

/// Every pid under `root`, `root` included.
fn descendants(root: u32) -> HashSet<u32> {
    let Ok(out) = Command::new("ps").args(["-axo", "pid=,ppid="]).output() else {
        return HashSet::new();
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        if let (Some(pid), Some(ppid)) = (it.next(), it.next()) {
            if let (Ok(pid), Ok(ppid)) = (pid.parse(), ppid.parse()) {
                children.entry(ppid).or_default().push(pid);
            }
        }
    }
    let mut set = HashSet::from([root]);
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        for &c in children.get(&pid).into_iter().flatten() {
            if set.insert(c) {
                stack.push(c);
            }
        }
    }
    set
}

/// `(pid, process name, port)` for every TCP listener, via lsof's machine
/// format: one field per line, `p` opening a process and `n` naming a socket.
fn listening() -> Vec<(u32, String, u16)> {
    let Ok(out) = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        .output()
    else {
        return Vec::new();
    };
    parse_lsof(&String::from_utf8_lossy(&out.stdout))
}

/// Working directory per pid, for the listeners only. One lsof for the lot:
/// `-a` ands the pid list with the `cwd` descriptor.
fn cwd_of(pids: Vec<u32>) -> HashMap<u32, PathBuf> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let Ok(out) = Command::new("lsof").args(["-a", "-p", &list, "-d", "cwd", "-Fpn"]).output() else {
        return HashMap::new();
    };
    parse_cwds(&String::from_utf8_lossy(&out.stdout))
}

fn parse_cwds(text: &str) -> HashMap<u32, PathBuf> {
    let mut map = HashMap::new();
    let mut pid = 0u32;
    for line in text.lines() {
        match line.split_at(1) {
            ("p", rest) => pid = rest.parse().unwrap_or(0),
            ("n", rest) if pid != 0 => {
                map.insert(pid, PathBuf::from(rest));
            }
            _ => {}
        }
    }
    map
}

fn parse_lsof(text: &str) -> Vec<(u32, String, u16)> {
    let mut rows = Vec::new();
    let (mut pid, mut name) = (0u32, String::new());
    for line in text.lines() {
        match line.split_at(1) {
            ("p", rest) => pid = rest.parse().unwrap_or(0),
            ("c", rest) => name = rest.to_string(),
            ("n", rest) => {
                // `127.0.0.1:3000`, `[::1]:3000`, `*:3000`; loopback and
                // wildcard both answer on localhost.
                let Some((host, port)) = rest.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let local = matches!(host, "127.0.0.1" | "[::1]" | "*" | "localhost" | "0.0.0.0" | "[::]");
                if local && pid != 0 {
                    rows.push((pid, name.clone(), port));
                }
            }
            _ => {}
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_machine_format() {
        let text = "p123\ncnode\nn[::1]:1420\np456\ncpostgres\nn127.0.0.1:5432\nn[::1]:5432\np789\ncsshd\nn10.0.0.5:22\n";
        let rows = parse_lsof(text);
        assert_eq!(rows[0], (123, "node".into(), 1420));
        assert_eq!(rows[1], (456, "postgres".into(), 5432));
        assert_eq!(rows.len(), 3, "a non-loopback bind is left out");
    }

    #[test]
    fn parses_cwds() {
        let map = parse_cwds("p123\nfcwd\nn/Users/me/proj\np456\nfcwd\nn/tmp\n");
        assert_eq!(map[&123], PathBuf::from("/Users/me/proj"));
        assert_eq!(map[&456], PathBuf::from("/tmp"));
    }
}
