// The whole app on three bots, for a video of what a bot does: Dray, Ops and
// Docs in the sidebar and nothing else, Dray's chat open with its Tasks tab
// beside it. Tauri's IPC is mocked and holds the whole story in the page, so
// it needs no server and plays the same every time.
//
//   /demo/bots-video.html            Press Play (or P) and the story plays
//   /demo/bots-video.html?pace=1.5   the same, every pause half as long again
//   /demo/bots-video.html?still      the end state, for a screenshot
//
// Record it in a visible window: a hidden tab clamps timers to a second, and
// the typing crawls.
//
// The story: Yogesh asks for the 0.42 changelog, Dray starts a task and
// messages it, posts the merge card, the card is merged, Yogesh sets a rule
// and Dray learns it, then two tasks land on "Waiting on you". Messages are
// typed into the real composer and sent through the real send path.

import { emit } from "@tauri-apps/api/event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import type {
  AgentAvailability,
  AgentEvent,
  Bot,
  BotPreview,
  Model,
  PrMark,
  SessionIndexItem,
} from "@/types/events";

const query = new URLSearchParams(location.search);
const STILL = query.has("still");
/// Scales every pause in the story: 2 plays at half speed, 0 runs it at once.
const PACE = STILL ? 0 : Number(query.get("pace") ?? 1);

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
/// Yesterday at `h:m`, local time.
const yesterday = (h: number, m: number) => {
  const d = new Date(NOW - 86_400_000);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const REPO = "/Users/yogesh/code/dray";
const BOTS_DIR = "/Users/yogesh/.dray/bots";

const BOTS: Bot[] = [
  { id: "b0000001", name: "Dray", path: `${BOTS_DIR}/b0000001`, created: yesterday(9, 0), avatar: { shape: "cloud", hue: 80 } },
  { id: "b0000002", name: "Ops", path: `${BOTS_DIR}/b0000002`, created: yesterday(9, 5), avatar: { shape: "hexagon", hue: 200 } },
  { id: "b0000003", name: "Docs", path: `${BOTS_DIR}/b0000003`, created: yesterday(9, 8), avatar: { shape: "round", hue: 320 } },
];

const id = (n: number) => `019a7c00-0000-7000-8000-${String(n).padStart(12, "0")}`;
const CHAT = id(1);

function item(sessionId: string, title: string, more: Partial<SessionIndexItem>): SessionIndexItem {
  return {
    sessionId,
    harness: "claude_code",
    cwd: REPO,
    projectPath: REPO,
    branch: null,
    worktreeName: null,
    worktreeRemoved: false,
    title,
    titleLocked: false,
    model: "opus",
    effort: "high",
    permissionMode: "auto",
    fast: false,
    status: "idle",
    forkFrom: null,
    threadId: null,
    issues: [],
    parentSessionId: null,
    created: ago(600),
    modified: ago(600),
    archived: false,
    pinned: false,
    hidden: false,
    aside: false,
    continueOff: false,
    ...more,
  } as SessionIndexItem;
}

const botChat = (bot: Bot, sessionId: string, modified: string) =>
  item(sessionId, bot.name, { cwd: bot.path, projectPath: bot.path, modified, created: bot.created });

/// A task of Dray's: hidden, in a worktree of the repo, on its own branch.
const task = (n: number, title: string, more: Partial<SessionIndexItem> = {}) =>
  item(id(n), title, {
    cwd: `${REPO}/.claude/worktrees/task-${n}`,
    worktreeName: `task-${n}`,
    branch: `worktree-task-${n}`,
    parentSessionId: CHAT,
    hidden: true,
    ...more,
  });

// Tasks by session number, which is also what their branch is named after.
const SHIKI = 11;
const FLAKY = 12;
const ISLAND = 13;
const SHORTCUTS = 14;
const IOS = 15;
const CLOUD = 16;
const CHANGELOG = 17;

const index: SessionIndexItem[] = [
  botChat(BOTS[0], CHAT, ago(20)),
  { ...botChat(BOTS[1], id(2), ago(34)), status: "completed" },
  botChat(BOTS[2], id(3), ago(95)),
  task(SHIKI, "Bump Shiki to 3.2", { created: yesterday(18, 41), modified: yesterday(19, 20) }),
  task(FLAKY, "Fix the flaky worktree test", { created: ago(190), modified: ago(4), status: "in_progress" }),
  task(ISLAND, "Island: quieter send sound", { created: ago(190), modified: ago(25) }),
  task(SHORTCUTS, "Settings: search box for shortcuts", { created: ago(190), modified: ago(3), status: "in_progress" }),
  task(IOS, "iOS: bot chats in the session list", { created: ago(190), modified: ago(1), status: "in_progress" }),
  task(CLOUD, "Cloud: name the machine in the titlebar", { created: ago(150), modified: ago(2), status: "in_progress" }),
];

const pr = (n: number, number: number, more: Partial<PrMark> = {}): PrMark => ({
  number,
  url: `https://github.com/monorepo-labs/dray/pull/${number}`,
  headRefName: `worktree-task-${n}`,
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  ...more,
});

const marks: PrMark[] = [
  pr(SHIKI, 1009, { state: "MERGED", mergeable: null, mergeStateStatus: null }),
  pr(FLAKY, 1010, { checksState: "FAILING", mergeStateStatus: "UNSTABLE" }),
  pr(ISLAND, 1011, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }),
  pr(SHORTCUTS, 1013, { isDraft: true, mergeStateStatus: "DRAFT" }),
  pr(CLOUD, 1012),
];

// ── the chat ──────────────────────────────────────────────────────────────────

const logs = new Map<string, AgentEvent[]>([
  [CHAT, []],
  [id(2), []],
  [id(3), []],
]);
let seq = 0;

function event(sessionId: string, payload: object, ts: string): AgentEvent {
  const e = { id: `ev-${seq}`, sessionId, harness: "claude_code", seq: seq++, ts, turnId: null, subagent: null, payload } as AgentEvent;
  logs.get(sessionId)!.push(e);
  return e;
}

const user = (text: string, from: object | null = null) =>
  ({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from, cwd: null }) as const;
const say = (text: string) => ({ type: "assistant_text", block: null, text });
const done = () => ({
  type: "turn_completed",
  status: "success",
  stopReason: "end_turn",
  finalText: null,
  usage: null,
  durationMs: 9000,
  head: null,
  authFailed: false,
});

/// A `dray session new` and the id it prints, which the chat draws as a
/// "Started a new task" line.
function startTask(n: number, title: string) {
  const call = `call-new-${n}`;
  return [
    {
      type: "tool_call_started",
      callId: call,
      name: "Bash",
      toolType: "shell",
      input: { command: `dray session new --project ${REPO} --worktree --title "${title}" "$(cat <<'EOF'\n${title}.\nEOF\n)"` },
    },
    { type: "tool_call_completed", callId: call, result: { text: `${id(n)}\n`, isError: false, structured: null, exitCode: 0, durationMs: 800, images: [] } },
  ];
}

/// A `dray session send`, drawn as "Messaged".
function message(n: number, text: string) {
  const call = `call-send-${n}-${seq}`;
  return [
    { type: "tool_call_started", callId: call, name: "Bash", toolType: "shell", input: { command: `dray session send ${id(n)} "${text}"` } },
    { type: "tool_call_completed", callId: call, result: { text: "Sent.", isError: false, structured: null, exitCode: 0, durationMs: 300, images: [] } },
  ];
}

const report = (n: number, title: string, text: string) =>
  user(`[message from session "${title}" (${id(n)})]\n\n${text}`, { sessionId: id(n), title, machine: null });

// What happened before the video: yesterday's Shiki bump and this morning's
// four tasks.
function history() {
  const log = (payload: object, ts: string) => event(CHAT, payload, ts);
  let t = yesterday(18, 40);
  log(user("Shiki 3.2 is out. Bump it, and check the code views still colour right."), t);
  for (const p of startTask(SHIKI, "Bump Shiki to 3.2")) log(p, t);
  log(say("On it. The task will run the code-render demo before and after, so we can compare."), t);
  log(done(), t);
  t = yesterday(19, 21);
  log(report(SHIKI, "Bump Shiki to 3.2", "PR #1009 merged. First token on the Edit diff: 41ms → 33ms."), t);
  log(say("Shiki 3.2 is in (#1009). Code views colour the same and the Edit diff paints about 20% sooner."), t);
  log(done(), t);

  t = ago(190);
  log(
    user(
      "Next up: the flaky worktree test, a quieter send sound on the island, a search box in Settings → Shortcuts, and let's start bot chats on iOS.",
    ),
    t,
  );
  for (const p of startTask(FLAKY, "Fix the flaky worktree test")) log(p, t);
  for (const p of startTask(ISLAND, "Island: quieter send sound")) log(p, t);
  for (const p of startTask(SHORTCUTS, "Settings: search box for shortcuts")) log(p, t);
  for (const p of startTask(IOS, "iOS: bot chats in the session list")) log(p, t);
  log(
    say(
      "Four tasks going. The flaky test looks like a race in `remove_session_worktree`, so that task checks it first. iOS will need the bot types in its `Codable` models; the island compiles the same files, so I told it to keep both building.",
    ),
    t,
  );
  log(done(), t);

  t = ago(150);
  log(user("Also: Cloud tasks should name their machine in the titlebar."), t);
  for (const p of startTask(CLOUD, "Cloud: name the machine in the titlebar")) log(p, t);
  log(say("Started. It's a small one, so I'll post the PR here once checks pass."), t);
  log(done(), t);

  t = ago(34);
  event(id(2), say("0.41.2 is out on all three channels. Notarized in 4 minutes."), t);
  t = ago(95);
  event(id(3), say("Updated the Spaces page for the new project filter."), t);
}
history();

/// Each chat's inbox row: its last reply.
function previews(ids: string[]): Record<string, BotPreview> {
  const out: Record<string, BotPreview> = {};
  for (const sid of ids) {
    const last = [...(logs.get(sid) ?? [])]
      .reverse()
      .find((e) => e.payload.type === "assistant_text" && e.payload.text.trim());
    out[sid] = { text: last?.payload.type === "assistant_text" ? last.payload.text : null, replies: sid === id(2) ? 1 : 0 };
  }
  return out;
}

// ── the mock ──────────────────────────────────────────────────────────────────

const MODELS: Model[] = [
  {
    id: "opus",
    label: "Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    arg: "opus",
    provider: "anthropic",
    acceptsImages: true,
    secondary: false,
    supportsFast: true,
  },
];

const AVAILABLE: AgentAvailability[] = [
  {
    harness: "claude_code",
    label: "Claude Code",
    available: true,
    reason: "",
    installCommand: null,
    docsUrl: null,
    loginCommand: "",
    loginHint: null,
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/// A pause in the story, scaled by `PACE`; none at all at 0.
const beat = (ms: number) => (PACE ? sleep(ms * PACE) : Promise.resolve());
const find = (sid: string) => index.find((i) => i.sessionId === sid);

/// Writes an index change and tells the app, as the server does.
function change(sid: string, more: Partial<SessionIndexItem>) {
  const at = index.findIndex((i) => i.sessionId === sid);
  index[at] = { ...index[at], ...more };
  void emit("session_changed", index[at]);
  return index[at];
}

function setStatus(sid: string, status: SessionIndexItem["status"], modified = new Date().toISOString()) {
  change(sid, { status, modified });
  void emit("session_status", { sessionId: sid, status, modified });
}

/// Appends to a log and sends it live.
function live(sid: string, payload: object) {
  void emit("agent_event", event(sid, payload, new Date().toISOString()));
}

/// The reader's sends, waiting on the story to take them.
const sent: ((text: string) => void)[] = [];

async function answer(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "list_bots":
      return BOTS;
    case "list_session_index_items":
      return a.archived ? index.filter((i) => i.archived) : index.filter((i) => !i.archived);
    case "session_index_item":
      return find(String(a.sessionId)) ?? null;
    case "get_session_by_id": {
      const found = find(String(a.sessionId));
      return found ? { ...found, events: logs.get(found.sessionId) ?? [], olderBefore: null } : null;
    }
    case "get_session_page":
      return { events: [], olderBefore: null };
    case "get_session_since":
      return [];
    case "bot_previews":
      return previews(a.sessionIds as string[]);
    case "pr_marks":
      return a.cwd === REPO ? marks : [];
    case "list_models":
      return MODELS;
    case "agent_availability":
      return AVAILABLE;
    case "list_branches":
      return { current: "main", branches: ["main"], defaultBase: "main", dirty: 0 };
    case "worktree_disposition":
      return { exists: false, changedFiles: 0, unpushedCommits: 0 };
    case "check_update":
    case "auto_merge_card":
      return null;
    case "nudge_bot":
      return true;
    case "merge_pr": {
      await beat(1400);
      const mark = marks.find((m) => m.number === a.number)!;
      Object.assign(mark, { state: "MERGED", mergeable: null, mergeStateStatus: null });
      return null;
    }
    case "set_session_flags": {
      const flags = Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== "sessionId" && v != null));
      return change(String(a.sessionId), flags);
    }
    case "remove_session_worktree":
      return change(String(a.sessionId), { worktreeRemoved: true, cwd: REPO });
    case "send_msg": {
      const sid = String(a.sessionId);
      // After the reply, as the server's lands: the app retires its
      // provisional row on the logged prompt, and one landing first is drawn
      // beside it.
      setTimeout(() => {
        live(sid, user(String(a.prompt)));
        setStatus(sid, "in_progress");
        sent.shift()?.(String(a.prompt));
      }, 150);
      return { snapshot: null, queued: null, issues: [] };
    }
    case "browser_tabs":
    case "list_open_apps":
    case "list_projects":
    case "list_servers":
    case "list_drafts":
    case "list_slash_commands":
    case "check_agent_updates":
    case "list_local_servers":
      return [];
    default:
      // Writes the app makes in passing — selection, read marks, analytics.
      if (/^(set_|mark_|track_|notify_|warm_|reconnect_|watch_|island_|configure_)/.test(cmd)) return null;
      console.info("[bots-video] nothing stubbed for", cmd, a);
      throw `demo: nothing stubbed for ${cmd}`;
  }
}

mockConvertFileSrc("macos");
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return cmd === "server_invoke" ? answer(String(a.cmd), (a.args ?? {}) as Record<string, unknown>) : answer(cmd, a);
  },
  { shouldMockEvents: true },
);

// Stalls already nudged and fixes already asked, from an earlier load, would
// change what the card and the Tasks tab draw. Only this page's own: the app
// on the same origin keeps its history.
const mine = (key: string) => key.startsWith(id(0).slice(0, 24));
for (const key of ["ade.nudgedStalls", "ade.dismissedStalls"]) {
  const kept = (JSON.parse(localStorage.getItem(key) ?? "[]") as string[]).filter((k) => !mine(k));
  localStorage.setItem(key, JSON.stringify(kept));
}
const asks = JSON.parse(localStorage.getItem("ade.fixAsks") ?? "{}") as Record<string, unknown>;
localStorage.setItem("ade.fixAsks", JSON.stringify(Object.fromEntries(Object.entries(asks).filter(([k]) => !mine(k)))));

// After the mock: the app's modules reach for Tauri as they load.
const { setMode, setTheme } = await import("@/hooks/useTheme");
const { recordFixAsk } = await import("@/hooks/useFixAsks");
const { default: App } = await import("@/App");
setTheme("default");
setMode("dark");
recordFixAsk(id(FLAKY), 1010, "checksFailing", NOW - 4 * 60_000);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// ── driving the page ──────────────────────────────────────────────────────────

async function until<T>(get: () => T | null | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = get();
    if (found) return found;
    if (Date.now() > end) throw new Error("demo: timed out waiting");
    await sleep(50);
  }
}

/// The element whose own text is `text`, under `root`.
const byText = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === text);

/// A pointer the viewer can follow, since a click alone reads as magic.
const pointer = document.createElement("div");
pointer.style.cssText =
  "position:fixed;z-index:9999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;pointer-events:none;" +
  "background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.4);" +
  "transition:left .7s cubic-bezier(.3,.7,.3,1),top .7s cubic-bezier(.3,.7,.3,1),transform .12s;left:70%;top:110%";

async function click(el: HTMLElement) {
  if (!PACE) return el.click();
  if (!pointer.isConnected) document.body.append(pointer);
  const r = el.getBoundingClientRect();
  pointer.style.left = `${r.left + r.width / 2}px`;
  pointer.style.top = `${r.top + r.height / 2}px`;
  await beat(850);
  pointer.style.transform = "scale(.75)";
  await beat(120);
  pointer.style.transform = "";
  el.click();
  await beat(250);
}

/// Types into the real composer and sends with Enter, so the send goes the
/// app's own way.
async function type(text: string) {
  const editor = await until(() => document.querySelector<HTMLElement>('[contenteditable="true"]'));
  editor.focus();
  if (!PACE) document.execCommand("insertText", false, text);
  else
    for (const ch of text) {
      document.execCommand("insertText", false, ch);
      await beat(ch === " " ? 45 : 28 + Math.random() * 30);
    }
  await beat(400);
  const taken = new Promise<string>((r) => sent.push(r));
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await taken;
}

/// The bot replying: works a moment, then each payload lands.
async function bot(...payloads: object[]) {
  for (const p of payloads) {
    await beat(p && (p as { type: string }).type === "assistant_text" ? 1600 : 700);
    live(CHAT, p);
  }
}

async function story() {
  await type("Can you write the 0.42 changelog? The release goes out today.");
  await beat(900);
  await bot(...startTask(CHANGELOG, "Write the 0.42 changelog"));
  index.push(task(CHANGELOG, "Write the 0.42 changelog", { created: new Date().toISOString(), status: "in_progress" }));
  void emit("session_created", index.at(-1));
  void emit("session_status", { sessionId: id(CHANGELOG), status: "in_progress", modified: index.at(-1)!.modified });
  await bot(say("Writing it now. It covers everything merged since 0.41: Shiki 3.2, the sidebar fixes, Cloud machines."), done());
  setStatus(CHAT, "completed");

  // The task asks, Dray answers it without bothering the reader.
  await beat(3500);
  live(CHAT, report(CHANGELOG, "Write the 0.42 changelog", "Should the iOS work go in? Two PRs touched apps/ios."));
  setStatus(CHAT, "in_progress");
  await bot(...message(CHANGELOG, "Leave iOS out. It hasn't shipped yet."));
  await bot(say("The changelog task asked about iOS. I told it to leave it out, since that hasn't shipped."), done());
  setStatus(CHAT, "completed");

  // Its PR turns ready and Dray posts the card.
  await beat(3500);
  marks.push(pr(CHANGELOG, 1015));
  setStatus(id(CHANGELOG), "completed");
  live(CHAT, report(CHANGELOG, "Write the 0.42 changelog", "PR #1015 is up and checks pass."));
  setStatus(CHAT, "in_progress");
  await bot(
    say("The 0.42 changelog is ready."),
    {
      type: "merge_card",
      taskId: id(CHANGELOG),
      title: "Write the 0.42 changelog",
      projectPath: REPO,
      // Not the task's branch, so the merge leaves the task unsettled: the app
      // names a settled task "Task" in the chat, which would read as a bug on
      // camera. Delete this to merge the way the app does.
      branch: "changelog-0.42",
      number: 1015,
      url: "https://github.com/monorepo-labs/dray/pull/1015",
    },
    done(),
  );
  setStatus(CHAT, "completed");

  // Merged from the card.
  await beat(2000);
  const card = await until(() => document.querySelector<HTMLElement>("[data-bot-chat]")?.querySelector<HTMLElement>(".rounded-r-none") ?? null);
  await click(card);
  await click(await until(() => [...document.querySelectorAll<HTMLElement>("[data-bot-chat] button")].find((b) => b.textContent?.startsWith("Confirm"))));
  await until(() => marks.find((m) => m.number === 1015)?.state === "MERGED");
  pointer.remove();
  await beat(2500);

  // A rule, learned on the spot.
  await type("Merged. From now on, end every changelog line with its PR number.");
  await bot(say("Will do. It's a rule now, so every changelog task gets it."), done());
  live(CHAT, {
    type: "learned",
    commit: "4f1c2ab",
    files: [{ path: "INSTRUCTIONS.md", kind: "instructions", change: "changed", summary: "End every changelog line with its PR number, like (#1015)." }],
  });
  setStatus(CHAT, "completed");

  // Two tasks stop on the reader, and the card at the chat's foot gathers them.
  await beat(4000);
  setStatus(id(CLOUD), "completed", ago(9));
  setStatus(id(IOS), "completed", ago(7));
  await beat(1500);
  change(id(IOS), { need: { text: "Should bot chats sit above or below projects in the iOS list?", at: new Date().toISOString() } });
}

// Opens Dray's chat with its Tasks tab, then plays or jumps to the end.
const row = await until(() => byText("Dray", document.querySelector("aside") ?? document));
row.click();
await until(() => document.querySelector("[data-bot-chat]"));
(await until(() => document.querySelector<HTMLElement>('[aria-label="Toggle panel"]'))).click();
await sleep(300);
const tasksTab = await until(() => byText("Tasks"), 5000).catch(() => null);
tasksTab?.click();

if (STILL) {
  await story();
} else {
  const play = document.createElement("button");
  play.textContent = "▶ Play";
  play.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:9999;padding:8px 14px;border-radius:999px;border:0;" +
    "font:600 13px system-ui;background:#f5c518;color:#111;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)";
  document.body.append(play);
  const start = () => {
    play.remove();
    removeEventListener("keydown", onKey, true);
    void story();
  };
  // Taken before the composer, which holds focus, unless it has text in it.
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (e.key.toLowerCase() !== "p" || e.metaKey || e.ctrlKey || target.textContent?.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    start();
  };
  play.onclick = start;
  addEventListener("keydown", onKey, true);
}

export {};
