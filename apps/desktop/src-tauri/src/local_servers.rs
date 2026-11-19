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
    let shares = crate::share::list(Some(&session_id));
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
    subtree(&processes().children, root)
}

/// The machine's processes: who started whom, and each one's command line.
#[derive(Default)]
struct Processes {
    children: HashMap<u32, Vec<u32>>,
    args: HashMap<u32, String>,
}

impl Processes {
    /// The bare program name: `bash` for `/bin/bash -c …`, `zsh` for a login
    /// shell's `-zsh`.
    fn name(&self, pid: u32) -> &str {
        let first = self.args.get(&pid).and_then(|a| a.split_whitespace().next()).unwrap_or_default();
        first.rsplit('/').next().unwrap_or_default().trim_start_matches('-')
    }
}

fn processes() -> Processes {
    // `ww`, or a long command line is cut to the terminal's width.
    let Ok(out) = Command::new("ps").args(["-axwwo", "pid=,ppid=,args="]).output() else {
        return Processes::default();
    };
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

/// `ps -o pid=,ppid=,args=`.
fn parse_ps(text: &str) -> Processes {
    let mut p = Processes::default();
    for line in text.lines() {
        let Some((pid, rest)) = line.trim_start().split_once(char::is_whitespace) else { continue };
        let rest = rest.trim_start();
        let (ppid, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else { continue };
        p.children.entry(ppid).or_default().push(pid);
        p.args.insert(pid, args.trim().to_string());
    }
    p
}

/// Whether a command line is a test run: `npm test`, `pnpm test:e2e`,
/// `npx playwright test`, `cargo test`, `go test`, `python -m pytest`, `jest`,
/// `cypress run`, `node --test`.
///
/// Read off two places only, so a server named or configured like a test
/// (`node test_server.js`, `vite --config e2e.config.ts`) is still a server:
/// the program — a runner's own name, or the script or module a `node`,
/// `python` or `npx` runs, cut to its stem so `.bin/jest` and `jest.js` both
/// say `jest` — and the bare words after it, a subcommand like `test` or a
/// script name like `test:e2e`. Paths, options and an option's value are
/// passed over.
fn is_test_run(args: &str) -> bool {
    const RUNNERS: &[&str] = &["jest", "vitest", "mocha", "ava", "pytest", "nextest", "rspec", "phpunit", "karma", "cypress", "wdio"];
    const HOSTS: &[&str] = &["node", "python", "python3", "bun", "deno", "ruby", "npx", "bunx", "uvx"];
    let stem = |w: &str| w.rsplit('/').next().unwrap_or(w).split('.').next().unwrap_or_default().to_ascii_lowercase();
    let words: Vec<&str> = args.split_whitespace().collect();
    let mut at = 0;
    while words.get(at).is_some_and(|w| HOSTS.contains(&stem(w).as_str())) {
        at += 1;
        while let Some(w) = words.get(at).filter(|w| w.starts_with('-')) {
            at += 1;
            match *w {
                "--test" => return true,
                "-m" => break,
                _ => {}
            }
        }
    }
    let test_word = |w: &str| {
        let w = w.to_ascii_lowercase();
        !w.contains('/')
            && !w.contains('.')
            && (matches!(w.as_str(), "test" | "tests" | "e2e")
                || RUNNERS.contains(&w.as_str())
                || ["test:", "e2e:"].iter().any(|p| w.starts_with(p))
                || [":test", ":e2e"].iter().any(|s| w.ends_with(s)))
    };
    let Some(program) = words.get(at) else { return false };
    // `bun test` and `deno test`: past the host, the program is the subcommand.
    if RUNNERS.contains(&stem(program).as_str()) || test_word(program) {
        return true;
    }
    let mut option_value = false;
    words[at + 1..].iter().any(|w| {
        if w.starts_with('-') {
            option_value = !w.contains('=');
            return false;
        }
        !std::mem::take(&mut option_value) && test_word(w)
    })
}

/// What the session manager's serving sweep asks, per `(agent pid, background
/// shells)`: the ports those shells listen on where every one of them is a
/// server, else nothing.
///
/// Read off the OS rather than any harness's wire, since none says whether a
/// backgrounded command is a server, and a command's text is a poor guess at
/// it (`pnpm dev`, `cargo run`, `make serve`, a script). A server is what
/// listens on a port; a build or a test run, which the agent waits on, is not.
/// Each background shell is its own child of the agent — Claude Code runs every
/// Bash call as one — so a shell is serving when anything under it holds a
/// localhost listener. Counted rather than matched to tasks, since the wire
/// names no pid: a build beside a dev server is two tasks and one listening
/// shell, and stays working. Only shells count, so an MCP server the agent
/// spawned and that listens does not pass for one.
///
/// A test run can host a server of its own — Playwright's `webServer`, an
/// integration test binding a port — and it ends on its own, so the agent waits
/// on it. A shell counts only while nothing live under it is a test runner
/// ([`is_test_run`]), whose process lasts exactly as long as the run. The
/// shell's own command line is skipped: it holds the agent's whole script, so
/// a `cargo test && pnpm dev` already past its tests would still read as one.
/// CPU was the rejected signal: a dev server the reader is clicking through
/// burns it, and an e2e run waiting on a page sits idle. So was "the listener
/// is the shell's own command": `npm run dev` and `pnpm tauri dev` put wrappers
/// and a compiler around theirs, and Playwright puts its server under itself,
/// so the shape is per tool, not per intent.
pub(crate) fn serving(roots: &[(u32, usize)]) -> Vec<Vec<u16>> {
    let procs = processes();
    let mut ports_of: HashMap<u32, Vec<u16>> = HashMap::new();
    for (pid, _, port) in listening() {
        ports_of.entry(pid).or_default().push(port);
    }
    roots.iter().map(|&(root, shells)| serving_ports(&procs, &ports_of, root, shells)).collect()
}

fn serving_ports(procs: &Processes, ports_of: &HashMap<u32, Vec<u16>>, root: u32, shells: usize) -> Vec<u16> {
    const SHELLS: &[&str] = &["bash", "zsh", "sh", "dash", "fish"];
    let mut ports = Vec::new();
    let mut listening = 0;
    for &child in procs.children.get(&root).into_iter().flatten() {
        if !SHELLS.contains(&procs.name(child)) {
            continue;
        }
        let tree = subtree(&procs.children, child);
        let testing = tree.iter().any(|&pid| pid != child && procs.args.get(&pid).is_some_and(|a| is_test_run(a)));
        let mut found: Vec<u16> = tree.iter().flat_map(|pid| ports_of.get(pid)).flatten().copied().collect();
        if !found.is_empty() && !testing {
            listening += 1;
            ports.append(&mut found);
        }
    }
    if listening < shells {
        return Vec::new();
    }
    ports.sort_unstable();
    ports.dedup();
    ports
}

fn subtree(children: &HashMap<u32, Vec<u32>>, root: u32) -> HashSet<u32> {
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
    fn parses_ps_names() {
        let p = parse_ps("  10     1 /bin/zsh -c eval 'pnpm dev'\n  11    10 -zsh\n  12    10 node /x/node_modules/.bin/vite --port 5173\n");
        assert_eq!(p.name(10), "zsh");
        assert_eq!(p.name(11), "zsh");
        assert_eq!(p.name(12), "node");
        assert_eq!(p.args[&12], "node /x/node_modules/.bin/vite --port 5173");
        assert_eq!(p.children[&10], vec![11, 12]);
    }

    #[test]
    fn tells_a_test_run_from_a_server() {
        for run in [
            "npm test",
            "pnpm run test:e2e",
            "node /app/node_modules/.bin/playwright test",
            "cargo test --workspace",
            "go test ./...",
            "python -m pytest -x",
            "node /app/node_modules/jest/bin/jest.js",
            "npx cypress run",
            "node --test",
            "npm exec playwright test --reporter=line",
            "pnpm --filter web test",
            "sh -c playwright test",
            "cargo nextest run",
            "bun test",
            "deno test --allow-net",
            "bun run test:e2e",
        ] {
            assert!(is_test_run(run), "{run}");
        }
        for server in [
            "npm run dev",
            "node /app/node_modules/.bin/vite --port 5173",
            "node /repo/apps/desktop/scripts/tauri.mjs dev",
            "cargo run --bin api",
            "python -m http.server 8000",
            "next dev",
            "node /repo/test_server.js",
            "node_modules/.bin/vite --config e2e.config.ts",
            "npm run dev -- --mode test",
            "vite --root tests",
        ] {
            assert!(!is_test_run(server), "{server}");
        }
    }

    /// Playwright's `webServer` listens under the runner, so the shell holding
    /// it is a test run, not a server, until the runner exits.
    #[test]
    fn a_test_run_hosting_a_server_is_not_serving() {
        let procs = parse_ps(
            "10 1 bash -c eval 'npx playwright test'\n11 10 node /a/.bin/playwright test\n12 11 sh -c npm run dev\n13 12 node /a/.bin/vite\n\
             20 1 bash -c eval 'npx playwright test && npm run dev'\n21 20 node /a/.bin/vite\n",
        );
        let ports = HashMap::from([(13, vec![5180]), (21, vec![5173])]);
        assert_eq!(serving_ports(&procs, &ports, 1, 1), vec![5173], "the shell past its tests serves");
        assert!(serving_ports(&procs, &ports, 1, 2).is_empty(), "the one mid-run does not");
    }

    /// Agent 1 runs a dev server (bash 10 → node 11 on :5173), a build
    /// (bash 20 → cargo 21) and an MCP server listening on its own (node 30).
    #[test]
    fn serving_counts_listening_shells() {
        let procs = parse_ps("10 1 bash\n11 10 node\n20 1 bash\n21 20 cargo\n30 1 node\n");
        let ports = HashMap::from([(11, vec![5173, 24678]), (30, vec![9000])]);
        assert_eq!(serving_ports(&procs, &ports, 1, 1), vec![5173, 24678], "the server alone");
        assert!(serving_ports(&procs, &ports, 1, 2).is_empty(), "a build beside it keeps the agent working");
        let build_only = HashMap::from([(30, vec![9000])]);
        assert!(serving_ports(&procs, &build_only, 1, 1).is_empty(), "an MCP server's port is no shell's");
    }

    /// The real read: a shell under this process listening through a child.
    #[test]
    fn finds_a_real_shell_serving() {
        let mut shell = Command::new("sh")
            // `; true`, or the shell execs python and there is no shell to find.
            .args(["-c", "python3 -m http.server 0 --bind 127.0.0.1 >/dev/null 2>&1; true"])
            .spawn()
            .unwrap();
        let me = std::process::id();
        let mut found = Vec::new();
        for _ in 0..50 {
            found = serving(&[(me, 1)]).remove(0);
            if !found.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = Command::new("pkill").args(["-P", &shell.id().to_string()]).status();
        let _ = shell.kill();
        let _ = shell.wait();
        assert!(!found.is_empty(), "the shell's server was not seen");
    }

    #[test]
    fn parses_cwds() {
        let map = parse_cwds("p123\nfcwd\nn/Users/me/proj\np456\nfcwd\nn/tmp\n");
        assert_eq!(map[&123], PathBuf::from("/Users/me/proj"));
        assert_eq!(map[&456], PathBuf::from("/tmp"));
    }
}
