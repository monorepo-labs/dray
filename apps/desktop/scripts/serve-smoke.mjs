// End-to-end check of a running `dray-serve`: handshake, a new Claude Code
// session in a throwaway repo, one turn streamed back. See SERVE-PLAN.md.
//
//   DRAY_HOME=/tmp/dray-serve-home dray-serve --port 7317 &
//   DRAY_HOME=/tmp/dray-serve-home node scripts/serve-smoke.mjs
//
// Exits non-zero on anything but a completed turn.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = process.env.DRAY_HOME;
if (!home) throw new Error("set DRAY_HOME to the server's data directory");
const url = process.env.DRAY_SERVER ?? "ws://127.0.0.1:7317";
const token = readFileSync(join(home, "serve-token"), "utf8").trim();

const repo = mkdtempSync(join(tmpdir(), "dray-smoke-"));
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);

const ws = new WebSocket(url);
const pending = new Map();
let next = 0;
const call = (cmd, args = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, cmd, args }));
  });

const sessionId = crypto.randomUUID();
let text = "";
let done;
const finished = new Promise((resolve) => (done = resolve));
const timer = setTimeout(() => {
  console.error("timed out waiting for the turn");
  process.exit(1);
}, 120_000);

ws.onmessage = ({ data }) => {
  const frame = JSON.parse(data);
  if ("v" in frame || ("err" in frame && !("id" in frame))) {
    if (frame.err) throw new Error(`refused: ${frame.err}`);
    return opened();
  }
  if ("id" in frame) {
    const p = pending.get(frame.id);
    pending.delete(frame.id);
    return "err" in frame ? p.reject(new Error(JSON.stringify(frame.err))) : p.resolve(frame.ok);
  }
  if (frame.event === "agent_event" && frame.payload.sessionId === sessionId) {
    const { type } = frame.payload.payload ?? {};
    if (type === "delta" && frame.payload.payload.text) text += frame.payload.payload.text;
    if (type === "turn_completed") done(frame.payload.payload);
  }
  if (frame.event === "session_status" && frame.payload.sessionId === sessionId) {
    console.log("status:", frame.payload.status);
  }
};
ws.onopen = () => ws.send(JSON.stringify({ v: 1, token }));
ws.onerror = (e) => {
  console.error("socket error", e.message ?? e);
  process.exit(1);
};

async function opened() {
  const agents = await call("agent_availability");
  console.log("agents:", agents.map((a) => `${a.harness}=${a.available}`).join(" "));
  await call("add_project", { path: repo });
  const outcome = await call("send_msg", {
    sessionId,
    prompt: "Reply with exactly the word pong and nothing else.",
    attachmentPaths: [],
    harness: "claude_code",
    model: "haiku",
    effort: null,
    permissionMode: "auto",
    fast: false,
    cwd: repo,
    branch: null,
    useWorktree: false,
    worktreeName: null,
    isNewSession: true,
  });
  console.log("send_msg:", JSON.stringify(outcome).slice(0, 160));
  const completed = await finished;
  clearTimeout(timer);
  const snapshot = await call("get_session_by_id", { sessionId });
  console.log("streamed text:", JSON.stringify(text));
  console.log("turn:", JSON.stringify(completed).slice(0, 200));
  console.log("events on disk:", snapshot.events.length);
  ws.close();
  process.exit(0);
}
