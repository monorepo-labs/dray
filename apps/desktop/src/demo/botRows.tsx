// The whole app with three bots and a few tasks, to look at the sidebar's bot
// rows beside the task rows. Ops works for 4s, then finishes with one more
// unread reply, then works again with the count still on its face, so the
// typing dots and the glimpse that replaces them both get seen. Tauri's IPC is mocked as in the new-task demo.

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import type { Bot, BotPreview, Project, SessionIndexItem, SessionStatus } from "@/types/events";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const PROJECTS: Project[] = [
  { path: "/Users/you/code/site", name: "site", space: null, lastSelected: "2026-11-06T00:00:00Z" },
];

const BOTS: Bot[] = [
  { id: "dray", name: "Dray Bot", path: "/Users/you/.dray/bots/dray", created: ago(9000) },
  { id: "ops", name: "Ops", path: "/Users/you/.dray/bots/ops", created: ago(9000), avatar: { shape: "blob", hue: 200 } },
  { id: "writer", name: "Writer", path: "/Users/you/.dray/bots/writer", created: ago(9000), avatar: { shape: "blob", hue: 30 } },
];

const item = (id: string, title: string, cwd: string, modified: string, status: SessionStatus = "idle"): SessionIndexItem => ({
  sessionId: `01a1d000-0000-7000-8000-00000000000${id}`,
  harness: "claude_code",
  cwd,
  projectPath: cwd,
  branch: null,
  worktreeName: null,
  worktreeRemoved: false,
  title,
  titleLocked: false,
  model: "opus",
  effort: null,
  permissionMode: "auto",
  fast: false,
  status,
  forkFrom: null,
  threadId: null,
  issues: [],
  parentSessionId: null,
  created: modified,
  modified,
  archived: false,
  pinned: false,
  hidden: false,
  aside: false,
  continueOff: false,
});

const ITEMS: SessionIndexItem[] = [
  item("1", "Dray Bot", BOTS[0].path, ago(180)),
  item("2", "Ops", BOTS[1].path, ago(2), "in_progress"),
  item("3", "Writer", BOTS[2].path, ago(26), "completed"),
  item("4", "Fix the pricing page copy", "/Users/you/code/site", ago(5)),
  item("5", "Audit the landing page", "/Users/you/code/site", ago(40), "in_progress"),
  item("6", "Add dark mode to docs", "/Users/you/code/site", ago(300)),
];
const [, OPS, WRITER] = ITEMS;

const previews: Record<string, BotPreview> = {
  [ITEMS[0].sessionId]: { text: "Morning! Ask me to **start a task**, check a PR, or [plan the week](https://x).", replies: 0 },
  [OPS.sessionId]: { text: "Deploy is green. `site` is on 0.30.0 and the error rate is flat.", replies: 0 },
  [WRITER.sessionId]: { text: "## Draft ready\nThe changelog post for 0.30 is in `posts/0-30.md` — want a shorter intro?", replies: 2 },
};

function answer(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case "list_projects":
      return PROJECTS;
    case "list_bots":
      return BOTS;
    case "bot_previews":
      return Object.fromEntries((args.sessionIds as string[]).flatMap((id) => (previews[id] ? [[id, previews[id]]] : [])));
    case "list_session_index_items":
      return ITEMS;
    case "list_models":
    case "list_servers":
    case "list_drafts":
    case "list_slash_commands":
    case "check_agent_updates":
    case "agent_availability":
      return [];
    case "list_branches":
      return { current: "main", branches: ["main"], defaultBase: "main", dirty: 0 };
    case "set_app_selection":
    case "reconnect_servers":
    case "warm_file_index":
      return null;
    default:
      console.info("[demo] nothing stubbed for", cmd);
      throw `demo: nothing stubbed for ${cmd}`;
  }
}

mockConvertFileSrc("macos");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as { cmd?: string; args?: Record<string, unknown> };
    return cmd === "server_invoke" ? answer(a.cmd!, a.args ?? {}) : answer(cmd, a as Record<string, unknown>);
  },
  { shouldMockEvents: true },
);

const { default: App } = await import("@/App");

const replies = ["Done: rotated the API keys and restarted the workers.", "Backups ran clean. Nothing needs you."];
let turn = 0;
const status = (sessionId: string, s: SessionStatus) =>
  emit("session_status", { sessionId, status: s, modified: s === "in_progress" ? null : new Date().toISOString() });
setInterval(() => {
  if (turn % 2 === 0) {
    previews[OPS.sessionId] = { text: replies[(turn / 2) % replies.length], replies: turn / 2 + 1 };
    void status(OPS.sessionId, "completed");
  } else void status(OPS.sessionId, "in_progress");
  turn++;
}, 4000);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
