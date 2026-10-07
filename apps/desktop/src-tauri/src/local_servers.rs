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

use crate::git::resolved;
use crate::session::manager;
use crate::store::get_session_index_item;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub port: u16,
    pub process: String,
    /// Started under this session's agent, as against by hand in its tree.
    pub mine: bool,
    /// Its public link, where the reader or the agent shared it.
    pub share: Option<String>,
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_local_servers(
    session_id: String,
) -> Result<Vec<LocalServer>, String> {
    let root = manager().child_pid(&session_id).await;
    let cwd = get_session_index_item(&session_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|item| PathBuf::from(item.cwd));
    let mut servers = tokio::task::spawn_blocking(move || discover(root, cwd.as_deref()))
        .await
        .map_err(|e| e.to_string())?;
    let shares = crate::share::list(&session_id);
    for server in &mut servers {
        server.share = shares.iter().find(|s| s.port == server.port).map(|s| s.url.clone());
    }
    Ok(servers)
}

fn discover(root: Option<u32>, tree: Option<&Path>) -> Vec<LocalServer> {
    let mine = root.map(descendants).unwrap_or_default();
    let listeners = listening();
    let cwds = cwd_of(listeners.iter().map(|(pid, _, _)| *pid).collect());
    // lsof reports resolved paths, so a checkout reached through a symlink
    // never matched its own servers until the tree was resolved too.
    let tree = tree.map(resolved);
    let in_tree = |pid: u32| {
        tree.as_deref()
            .zip(cwds.get(&pid))
            .map(|(tree, cwd)| resolved(cwd).starts_with(tree))
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
            (is_mine || in_tree(pid)).then_some(LocalServer { port, process: name, mine: is_mine, share: None })
        })
        .filter(|s| seen.insert(s.port))
        .collect();
    out.sort_by_key(|s| (!s.mine, s.port));
    out
}

/// Every pid under `root`, `root` included.
pub(crate) fn descendants(root: u32) -> HashSet<u32> {
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

/// SIGKILLs everything under `root`, leaving `root` itself to its owner.
///
/// Read off the walk and signalled while the parent is still alive: a dead
/// parent's children are reparented and the walk loses them. The one statement
/// of that, so the two callers cannot drift — [`Session::kill_tree`] has a
/// `Session` to consume where a spawn that failed before one existed has only
/// a `Child`, and an agent left half-started is exactly when its MCP servers
/// are already running.
///
/// [`Session::kill_tree`]: crate::session::Session::kill_tree
pub(crate) async fn kill_descendants(root: u32) {
    let tree = tokio::task::spawn_blocking(move || descendants(root))
        .await
        .unwrap_or_default();
    for pid in tree.into_iter().filter(|&p| p != root) {
        // ponytail: a process group set at spawn would make this one signal
        // with no walk; four spawn sites to change if this bites.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }
}

/// `(pid, process name, port)` for every TCP listener, via lsof's machine
/// format: one field per line, `p` opening a process and `n` naming a socket.
#[cfg(not(target_os = "linux"))]
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
#[cfg(not(target_os = "linux"))]
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

/// The same answer off `/proc`, since a fresh Ubuntu server has no lsof.
/// A socket's inode joins the listener table to the process holding it; only
/// processes this user may read are seen, which is every one it started.
#[cfg(target_os = "linux")]
fn listening() -> Vec<(u32, String, u16)> {
    use std::fs;
    let ports: HashMap<u64, u16> = ["/proc/net/tcp", "/proc/net/tcp6"]
        .iter()
        .filter_map(|f| fs::read_to_string(f).ok())
        .flat_map(|text| parse_proc_net(&text))
        .collect();
    let mut rows = Vec::new();
    let Ok(procs) = fs::read_dir("/proc") else { return rows };
    for entry in procs.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(fds) = fs::read_dir(entry.path().join("fd")) else { continue };
        for fd in fds.flatten() {
            let Ok(link) = fs::read_link(fd.path()) else { continue };
            let inode = link.to_str().and_then(|l| l.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok());
            if let Some(&port) = inode.and_then(|i: u64| ports.get(&i)) {
                let name = fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
                rows.push((pid, name.trim().to_string(), port));
            }
        }
    }
    rows
}

#[cfg(target_os = "linux")]
fn cwd_of(pids: Vec<u32>) -> HashMap<u32, PathBuf> {
    pids.into_iter()
        .filter_map(|pid| Some((pid, std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?)))
        .collect()
}

/// `inode → port` for each loopback or wildcard listener in `/proc/net/tcp`
/// or `tcp6`. Addresses are hex in host byte order per 32-bit word, ports
/// plain hex; `0A` is LISTEN.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_net(text: &str) -> Vec<(u64, u16)> {
    const LOCAL: [&str; 3] = ["0100007F", "00000000000000000000000001000000", "0000000000000000FFFF00000100007F"];
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            let (addr, port) = f.get(1)?.split_once(':')?;
            let local = LOCAL.contains(&addr) || addr.bytes().all(|b| b == b'0');
            (*f.get(3)? == "0A" && local).then_some(())?;
            Some((f.get(9)?.parse().ok()?, u16::from_str_radix(port, 16).ok()?))
        })
        .collect()
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
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

#[cfg_attr(target_os = "linux", allow(dead_code))]
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
    fn parses_proc_net() {
        let v4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   \
            0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 111 1 0 100 0 0 10 0\n   \
            1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 222 1 0 100 0 0 10 0\n   \
            2: 0500000A:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333 1 0 100 0 0 10 0\n   \
            3: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000   501        0 444 1 0 100 0 0 10 0\n";
        assert_eq!(parse_proc_net(v4), vec![(111, 3000), (222, 8080)], "a LAN bind and an open connection are left out");
        let v6 = "  sl  local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n   \
            0: 00000000000000000000000001000000:1324 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501 0 555 1\n";
        assert_eq!(parse_proc_net(v6), vec![(555, 4900)]);
    }

    /// The real read, lsof on a Mac and `/proc` on Linux, finding a socket
    /// this process just opened, and where this process stands.
    #[test]
    fn finds_its_own_listener() {
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        let me = std::process::id();
        assert!(listening().iter().any(|(pid, _, p)| *pid == me && *p == port), "port {port} not listed");
        assert_eq!(cwd_of(vec![me]).get(&me).map(|p| resolved(p)), Some(resolved(&std::env::current_dir().unwrap())));
    }

    #[test]
    fn parses_cwds() {
        let map = parse_cwds("p123\nfcwd\nn/Users/me/proj\np456\nfcwd\nn/tmp\n");
        assert_eq!(map[&123], PathBuf::from("/Users/me/proj"));
        assert_eq!(map[&456], PathBuf::from("/tmp"));
    }
}
