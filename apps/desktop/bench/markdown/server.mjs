import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RESULTS = fileURLToPath(new URL("./results/", import.meta.url));

/** @returns {{ pid: number, ppid: number, comm: string, cmd: string }[]} */
function processes() {
  const out = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // `comm` sits in parentheses and may hold spaces; fields resume after the last `)`.
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
      out.push({ pid: Number(name), ppid, comm, cmd });
    } catch {
      // Exited while being read.
    }
  }
  return out;
}

/// Resident bytes of the webview this dev server feeds: the WebKit web process
/// under the same `tauri dev` as this server. Linux only — a Mac's WebContent
/// process is no child of the app.
/** @returns {number | null} */
function webviewRss() {
  if (process.platform !== "linux") return null;
  const procs = processes();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let top = byPid.get(process.pid);
  while (top && !/tauri(\.mjs)? dev|tauri dev/.test(top.cmd) && top.ppid > 1) top = byPid.get(top.ppid);
  if (!top) return null;
  const under = new Set([top.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!under.has(p.pid) && under.has(p.ppid)) {
        under.add(p.pid);
        grew = true;
      }
    }
  }
  const web = procs.filter((p) => under.has(p.pid) && p.comm.startsWith("WebKitWebProces"));
  if (web.length === 0) return null;
  let total = 0;
  for (const p of web) {
    const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.pid}/status`, "utf8"))?.[1];
    total += Number(kb ?? 0) * 1024;
  }
  return total;
}

/// The markdown benchmark's two dev-server routes: the webview's memory, which
/// the page cannot read itself, and a place to write results.
/** @returns {import("vite").Plugin} */
export function markdownBench() {
  return {
    name: "dray-markdown-bench",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__md-bench/rss", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ rss: webviewRss() }));
      });
      server.middlewares.use("/__md-bench/results", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          mkdirSync(RESULTS, { recursive: true });
          const file = `${RESULTS}${new Date().toISOString().replaceAll(":", "-")}.json`;
          writeFileSync(file, body);
          writeFileSync(`${RESULTS}latest.json`, body);
          res.end("ok");
        });
      });
    },
  };
}
