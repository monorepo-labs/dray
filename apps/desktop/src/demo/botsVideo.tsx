// The whole app on three bots, for a video of what a bot does: Dray, Ops and
// Docs in the sidebar and nothing else, Dray's chat open with its tasks
// beside it, most of them on a sandbox server. Tauri's IPC is mocked and
// holds the whole story in the page, so it needs no server and plays the
// same every time.
//
//   /demo/bots-video.html            Press Play (or P) and the story plays
//   /demo/bots-video.html?pace=1.5   the same, every pause half as long again
//   /demo/bots-video.html?still      the end state, for a screenshot
//
// Record it in a visible window: a hidden tab clamps timers to a second.
//
// The story, quick on purpose: Yogesh asks for the changelog, Dray starts a
// task and says nothing, the PR turns ready and its merge card lands with the
// task's proof video, the card is merged, which settles the task. Then a rule
// Dray answers with 👍 and learns, and the iOS task joins "Waiting on you".

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
  ServerInfo,
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

const LOCAL = "local";
/// The machine most tasks run on, drawn as the server glyph on their rows.
const SANDBOX = "sandbox";
const REPO = "/Users/yogesh/code/dray";
/// The same repository's checkout on the sandbox, as that server spells it.
const SANDBOX_REPO = "/home/dray/dray";
const BOTS_DIR = "/Users/yogesh/.dray/bots";
/// Where `dray browser record` and `screenshot` write, so the chat draws a
/// player and a picture. Served from `demo/bots-video/` by `fileSrc` below.
const MEDIA = "/Users/yogesh/.dray/browser/recordings/019a7c00-0000-7000-8000-00000000c0de";

const BOTS: Bot[] = [
  { id: "b0000001", name: "Dray", path: `${BOTS_DIR}/b0000001`, created: yesterday(9, 0), avatar: { shape: "nub", hue: 250 } },
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

/// Each session's server; absent is This Mac.
const serverOf = new Map<string, string>();

/// A task of Dray's: hidden, in a worktree of the repo, on its own branch, on
/// the sandbox where `sandbox` says so.
function task(n: number, title: string, more: Partial<SessionIndexItem> = {}, sandbox = false) {
  const repo = sandbox ? SANDBOX_REPO : REPO;
  if (sandbox) serverOf.set(id(n), SANDBOX);
  return item(id(n), title, {
    cwd: `${repo}/.claude/worktrees/task-${n}`,
    projectPath: repo,
    worktreeName: `task-${n}`,
    branch: `worktree-task-${n}`,
    parentSessionId: CHAT,
    hidden: true,
    ...more,
  });
}

// Tasks by session number, which is also what their branch is named after.
const FLAKY = 12;
const ISLAND = 13;
const SHORTCUTS = 14;
const IOS = 15;
const HOMEPAGE = 16;
const CHANGELOG = 17;

const index: SessionIndexItem[] = [
  botChat(BOTS[0], CHAT, ago(20)),
  { ...botChat(BOTS[1], id(2), ago(34)), status: "completed" },
  botChat(BOTS[2], id(3), ago(95)),
  task(FLAKY, "Fix the flaky worktree test", { created: ago(190), modified: ago(4), status: "in_progress" }, true),
  task(ISLAND, "Island: quieter send sound", { created: ago(190), modified: ago(25) }, true),
  task(SHORTCUTS, "Settings: search box for shortcuts", { created: ago(190), modified: ago(3), status: "in_progress" }),
  task(IOS, "iOS: bot chats in the session list", { created: ago(190), modified: ago(1), status: "in_progress" }, true),
  task(HOMEPAGE, "Homepage: bots hero", { created: ago(150), modified: ago(40) }, true),
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

/// The repository's PRs, the same through either checkout: the app reads one
/// GitHub repo once and shares the answer across its checkouts.
const marks: PrMark[] = [
  pr(SHORTCUTS, 1013, { isDraft: true, mergeStateStatus: "DRAFT" }),
  pr(FLAKY, 1010, { checksState: "FAILING", mergeStateStatus: "UNSTABLE" }),
  pr(ISLAND, 1011, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }),
  pr(HOMEPAGE, 1012),
];

const SANDBOX_INFO: ServerInfo = {
  id: SANDBOX,
  name: "sandbox",
  named: true,
  url: "ws://sandbox:7317",
  ssh: null,
  on: true,
  status: "connected",
  stage: null,
  error: null,
  fix: null,
  release: null,
  beta: false,
  latest: null,
  app: false,
  restarting: false,
  boat: null,
  cloud: false,
};

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
  const machine = serverOf.has(id(n)) ? ` --machine ${SANDBOX}` : "";
  return [
    {
      type: "tool_call_started",
      callId: call,
      name: "Bash",
      toolType: "shell",
      input: { command: `dray session new${machine} --project ${REPO} --title "${title}" "$(cat <<'EOF'\n${title}.\nEOF\n)"` },
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

// What happened before the video: this morning's tasks and the homepage
// hero, whose screenshot is in the chat.
function history() {
  const log = (payload: object, ts: string) => event(CHAT, payload, ts);
  let t = ago(190);
  log(
    user(
      "Next up: the flaky worktree test, a quieter send sound on the island, a search box in Settings → Shortcuts, and let's start bot chats on iOS.",
    ),
    t,
  );
  for (const n of [FLAKY, ISLAND, SHORTCUTS, IOS]) for (const p of startTask(n, find(id(n))!.title)) log(p, t);
  log(done(), t);

  t = ago(150);
  log(user("And the homepage hero should show a bot at work."), t);
  for (const p of startTask(HOMEPAGE, "Homepage: bots hero")) log(p, t);
  log(done(), t);

  t = ago(60);
  log(report(FLAKY, "Fix the flaky worktree test", "Is the race in remove_session_worktree or in git itself?"), t);
  for (const p of message(FLAKY, "Ours. Hold the slot lock across the remove.")) log(p, t);
  log(done(), t);

  t = ago(40);
  log(report(HOMEPAGE, "Homepage: bots hero", "PR #1012 is up."), t);
  log(say(`The homepage hero is ready for a look.\n\n![The homepage hero](${MEDIA}/homepage.jpg)`), t);
  log(done(), t);

  event(id(2), say("0.30.4 is out on all three channels. Notarized in 4 minutes."), ago(34));
  event(id(3), say("Updated the Spaces page for the new project filter."), ago(95));
}

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
function find(sid: string) {
  return index.find((i) => i.sessionId === sid);
}
history();

/// Sends an event from a session's own server, the way the app hears each.
function announce(sid: string, name: string, payload: unknown) {
  const server = serverOf.get(sid);
  void (server ? emit("server_event", { server, event: name, payload }) : emit(name, payload));
}

/// Writes an index change and tells the app, as the server does.
function change(sid: string, more: Partial<SessionIndexItem>) {
  const at = index.findIndex((i) => i.sessionId === sid);
  index[at] = { ...index[at], ...more };
  announce(sid, "session_changed", index[at]);
  return index[at];
}

function setStatus(sid: string, status: SessionIndexItem["status"], modified = new Date().toISOString()) {
  change(sid, { status, modified });
  announce(sid, "session_status", { sessionId: sid, status, modified });
}

/// Appends to a log and sends it live.
function live(sid: string, payload: object) {
  const e = event(sid, payload, new Date().toISOString());
  void emit("agent_event", e);
  return e;
}

/// The reader's sends, waiting on the story to take them, with the logged
/// prompt's event so a reaction can name it.
const sent: ((e: AgentEvent) => void)[] = [];

async function answer(cmd: string, a: Record<string, unknown>, server: string): Promise<unknown> {
  const mine = (i: SessionIndexItem) => (serverOf.get(i.sessionId) ?? LOCAL) === server;
  switch (cmd) {
    case "list_bots":
      return server === LOCAL ? BOTS : [];
    case "list_servers":
      return [SANDBOX_INFO];
    case "list_session_index_items":
      return index.filter((i) => mine(i) && !!a.archived === i.archived);
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
      return a.cwd === (server === LOCAL ? REPO : SANDBOX_REPO) ? marks : [];
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
    case "local_server":
      return null;
    case "nudge_bot":
      return true;
    case "merge_pr": {
      await beat(700);
      const mark = marks.find((m) => m.number === a.number);
      if (mark) Object.assign(mark, { state: "MERGED", mergeable: null, mergeStateStatus: null });
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
        const e = live(sid, user(String(a.prompt)));
        setStatus(sid, "in_progress");
        sent.shift()?.(e);
      }, 120);
      return { snapshot: null, queued: null, issues: [] };
    }
    case "browser_tabs":
    case "list_open_apps":
    case "list_projects":
    case "list_drafts":
    case "list_slash_commands":
    case "check_agent_updates":
    case "list_local_servers":
      return [];
    case "server_caches":
      return {};
    case "get_integrations":
      return { linear: null, github: null };
    default:
      // Writes the app makes in passing — selection, read marks, analytics.
      if (/^(set_|mark_|track_|notify_|warm_|reconnect_|watch_|island_|configure_|save_)/.test(cmd)) return null;
      console.info("[bots-video] nothing stubbed for", cmd, server, a);
      throw `demo: nothing stubbed for ${cmd}`;
  }
}

// Opened by LAN address, from a VM recording it, the page is no secure context
// and has no `randomUUID`, which every send mints an id with.
if (!crypto.randomUUID)
  crypto.randomUUID = () =>
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
    ) as ReturnType<Crypto["randomUUID"]>;

mockConvertFileSrc("macos");
// The proof video and screenshot are files in this page's folder.
const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string } }).__TAURI_INTERNALS__;
const assetSrc = internals.convertFileSrc;
internals.convertFileSrc = (path: string) =>
  path.startsWith(`${MEDIA}/`) ? `/demo/bots-video/${path.slice(MEDIA.length + 1)}` : assetSrc(path);
mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return cmd === "server_invoke"
      ? answer(String(a.cmd), (a.args ?? {}) as Record<string, unknown>, String(a.server ?? LOCAL))
      : answer(cmd, a, LOCAL);
  },
  { shouldMockEvents: true },
);

// Stalls already nudged and fixes already asked, from an earlier load, would
// change what the card and the task list draw. Only this page's own: the app
// on the same origin keeps its history.
const ours = (key: string) => key.startsWith(id(0).slice(0, 24));
// A browser that never ran Dray would otherwise open on "What's new". The feed
// is answered empty rather than the seen mark moved, which the app on this
// origin would keep.
const realFetch = window.fetch;
window.fetch = (input, init) =>
  String(input instanceof Request ? input.url : input).endsWith("/changelog.json")
    ? Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } }))
    : realFetch(input, init);
for (const key of ["ade.nudgedStalls", "ade.dismissedStalls"]) {
  const kept = (JSON.parse(localStorage.getItem(key) ?? "[]") as string[]).filter((k) => !ours(k));
  localStorage.setItem(key, JSON.stringify(kept));
}
const asks = JSON.parse(localStorage.getItem("ade.fixAsks") ?? "{}") as Record<string, unknown>;
localStorage.setItem("ade.fixAsks", JSON.stringify(Object.fromEntries(Object.entries(asks).filter(([k]) => !ours(k)))));

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
  "transition:left .45s cubic-bezier(.3,.7,.3,1),top .45s cubic-bezier(.3,.7,.3,1),transform .1s;left:70%;top:110%";

async function click(el: HTMLElement) {
  if (!PACE) return el.click();
  if (!pointer.isConnected) document.body.append(pointer);
  const r = el.getBoundingClientRect();
  pointer.style.left = `${r.left + r.width / 2}px`;
  pointer.style.top = `${r.top + r.height / 2}px`;
  await beat(500);
  pointer.style.transform = "scale(.75)";
  await beat(100);
  pointer.style.transform = "";
  el.click();
  await beat(150);
}

/// Puts the whole message in the real composer at once and sends it with
/// Enter, so the send goes the app's own way. No typing: the video is short.
async function send(text: string): Promise<AgentEvent> {
  const editor = await until(() => document.querySelector<HTMLElement>('[contenteditable="true"]'));
  // A spelling squiggle reads as a bug on camera.
  editor.spellcheck = false;
  editor.focus();
  document.execCommand("insertText", false, text);
  await beat(250);
  const taken = new Promise<AgentEvent>((r) => sent.push(r));
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return taken;
}

/// The bot at work: each payload lands after a short beat.
async function bot(...payloads: object[]) {
  for (const p of payloads) {
    await beat(p && (p as { type: string }).type === "assistant_text" ? 700 : 350);
    live(CHAT, p);
  }
}

function story() {
  return tell().catch((e) => console.info("[bots-video] story stopped:", String(e)));
}

async function tell() {
  // Asked, and the task starts with no word from the bot.
  await send("Write the 0.30.5 changelog for today's release.");
  index.push(task(CHANGELOG, "Write the 0.30.5 changelog", { created: new Date().toISOString(), status: "in_progress" }));
  void emit("session_created", index.at(-1));
  void emit("session_status", { sessionId: id(CHANGELOG), status: "in_progress", modified: index.at(-1)!.modified });
  await bot(...startTask(CHANGELOG, "Write the 0.30.5 changelog"), done());
  setStatus(CHAT, "completed");

  // Its PR turns ready: Dray posts the card, the bot passes on the proof.
  await beat(1400);
  marks.push(pr(CHANGELOG, 1015));
  setStatus(id(CHANGELOG), "completed");
  live(CHAT, report(CHANGELOG, "Write the 0.30.5 changelog", `PR #1015 is up. Checked it on the site: ${MEDIA}/changelog.mp4`));
  setStatus(CHAT, "in_progress");
  await bot(
    {
      type: "merge_card",
      taskId: id(CHANGELOG),
      title: "Write the 0.30.5 changelog",
      projectPath: REPO,
      branch: `worktree-task-${CHANGELOG}`,
      number: 1015,
      url: "https://github.com/monorepo-labs/dray/pull/1015",
    },
    say(`Checked it on the site. 0.30.5 reads right.\n\n${MEDIA}/changelog.mp4`),
    done(),
  );
  setStatus(CHAT, "completed");

  // The proof plays, then Merge from the card, which settles the task.
  await beat(600);
  const video = document.querySelector<HTMLVideoElement>("[data-bot-chat] video");
  if (video && PACE) {
    video.muted = true;
    void video.play().catch(() => {});
    await beat(3200);
  }
  const merge = await until(() =>
    [...document.querySelectorAll<HTMLElement>("[data-bot-chat] button")].find((b) => {
      // The nearest ancestor naming a PR is the button's own card.
      let row: HTMLElement | null = b;
      while (row && !/#\d{4}/.test(row.textContent ?? "")) row = row.parentElement;
      return row?.textContent?.includes("#1015") && /merge/i.test(b.textContent ?? "");
    }),
  );
  await click(merge);
  const confirm = await until(
    () => [...document.querySelectorAll<HTMLElement>("[data-bot-chat] button")].find((b) => b.textContent?.startsWith("Confirm")),
    1500,
  ).catch(() => null);
  if (confirm) await click(confirm);
  await until(() => marks.find((m) => m.number === 1015)?.state === "MERGED");
  pointer.remove();
  await beat(1200);

  // A rule: 👍 in place of a reply, and the lesson as its own line.
  const asked = await send("From now on, write the changelog for every release without being asked.");
  await bot({ type: "reaction", messageId: asked.id, emoji: "👍" });
  await beat(500);
  live(CHAT, done());
  live(CHAT, {
    type: "learned",
    commit: "4f1c2ab",
    files: [{ path: "INSTRUCTIONS.md", kind: "instructions", change: "changed", summary: "Write the changelog for every release, unasked." }],
  });
  setStatus(CHAT, "completed");

  // The iOS task stops on a question and joins the homepage PR, which has
  // sat on "Waiting on you" since the start.
  await beat(1400);
  setStatus(id(IOS), "completed", ago(3));
  change(id(IOS), { need: { text: "Should bot chats sit above or below projects in the iOS list?", at: new Date().toISOString() } });
}

// Opens Dray's chat with its tasks beside it, then plays or jumps to the end.
const row = await until(() => byText("Dray", document.querySelector("aside") ?? document));
// A server's sessions are read when it says it is up, as on connect.
void emit("server_event", { server: SANDBOX, event: "live_state", payload: { asks: [], tasks: [] } });
row.click();
// The dev build's branch label has no place in a video.
const badge = [...document.querySelectorAll<HTMLElement>("aside div")].find((el) => /^Dev( · |$)/.test(el.textContent ?? ""));
if (badge) badge.style.visibility = "hidden";
await until(() => document.querySelector("[data-bot-chat]"));
await sleep(300);
// The pane may already be open on a bot; open it only where the task list is
// not on screen.
if (!byText("Homepage: bots hero", document.querySelector("aside:last-of-type") ?? document))
  (await until(() => document.querySelector<HTMLElement>('[aria-label="Toggle panel"]'))).click();

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
    // WebKit's empty editor can hold a zero-width character.
    const typed = target.textContent?.replace(/[\s​-‍﻿]/g, "");
    if (e.key.toLowerCase() !== "p" || e.metaKey || e.ctrlKey || typed) return;
    e.preventDefault();
    e.stopPropagation();
    start();
  };
  play.onclick = start;
  addEventListener("keydown", onKey, true);
}

export {};
