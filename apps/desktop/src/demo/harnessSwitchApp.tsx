// The app half of the switch-agent video ([harnessSwitchVideo](./harnessSwitchVideo.tsx)):
// the whole app on one task, Tauri's IPC mocked, and the story as cues on the
// video clock. It runs in the stage's iframe, so the camera's transform is on
// the iframe and the app lays out and places its menus untouched.

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import { BEATS } from "@/demo/harnessSwitchBeats";
import type { AgentAvailability, AgentEvent, Harness, Model, Project, SessionIndexItem } from "@/types/events";

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const REPO = "/Users/you/code/storefront";
const id = (n: number) => `019a8d00-0000-7000-8000-${String(n).padStart(12, "0")}`;
const TASK = id(1);

function item(n: number, title: string, more: Partial<SessionIndexItem> = {}): SessionIndexItem {
  return {
    sessionId: id(n),
    harness: "claude_code",
    cwd: `${REPO}/.claude/worktrees/task-${n}`,
    projectPath: REPO,
    branch: `worktree-task-${n}`,
    worktreeName: `task-${n}`,
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
    created: ago(300),
    modified: ago(300),
    archived: false,
    pinned: false,
    hidden: false,
    aside: false,
    continueOff: false,
    ...more,
  } as SessionIndexItem;
}

const index: SessionIndexItem[] = [
  item(1, "Cursor pagination for orders", { created: ago(14), modified: ago(0), status: "in_progress" }),
  item(2, "Checkout: round tax per line", { modified: ago(40) }),
  item(3, "Dark mode for receipt emails", { modified: ago(120) }),
  item(4, "Flaky cart test on CI", { modified: ago(150), harness: "codex", model: "gpt-6-astra" }),
];

const PROJECTS: Project[] = [{ path: REPO, name: "storefront", space: null, lastSelected: ago(0) }];

// ── the task's log ────────────────────────────────────────────────────────────

const log: AgentEvent[] = [];
let seq = 0;
let harness: Harness = "claude_code";

function event(payload: object, ts = new Date().toISOString()): AgentEvent {
  const e = { id: `ev-${seq}`, sessionId: TASK, harness, seq: seq++, ts, turnId: null, subagent: null, payload } as AgentEvent;
  log.push(e);
  return e;
}

const user = (text: string) =>
  ({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from: null, cwd: null }) as const;
const say = (text: string, block: object | null = null) => ({ type: "assistant_text", block, text });
const started = (callId: string, name: string, toolType: string, input: object, title: string | null = null) => ({
  type: "tool_call_started",
  callId,
  name,
  toolType,
  input,
  rawInput: null,
  title,
});
const completed = (callId: string, text: string, durationMs = 400) => ({
  type: "tool_call_completed",
  callId,
  result: { text, isError: false, structured: null, exitCode: 0, durationMs, images: [] },
});
const done = (status: "success" | "error", finalText: string | null = null) => ({
  type: "turn_completed",
  status,
  stopReason: status === "success" ? "end_turn" : null,
  finalText,
  usage: null,
  durationMs: 90_000,
  head: null,
  authFailed: false,
});

const TREE = `${REPO}/.claude/worktrees/task-1`;
const ORDERS = `${TREE}/src/api/orders.ts`;
const DB = `${TREE}/src/db/orders.ts`;
const TEST = `${TREE}/src/api/orders.test.ts`;

// Before the video: a question answered, then the work, under way.
event(user("How does the orders endpoint page today?"), ago(14));
event(started("c0", "Read", "file_read", { file_path: ORDERS }), ago(14));
event(completed("c0", "…"), ago(14));
event(
  say(
    "With `limit` and `offset`, which costs two ways:\n\n- Deep pages get slow. Postgres still walks every row it skips.\n- An order placed mid-scroll shifts every page after it, so a row shows up twice.\n\nA cursor on `(created_at, id)` fixes both.",
  ),
  ago(13),
);
event(done("success"), ago(13));
event(user("Switch it to cursor pagination. Keep offset working for old clients, and cover it with tests."), ago(4));
event(say("Cursor goes in the query layer first, then through the route."), ago(4));
event(started("c1", "Read", "file_read", { file_path: DB }), ago(4));
event(completed("c1", "…"), ago(4));
event(started("g1", "Grep", "search", { pattern: "ordersQuery\\(", path: "src" }), ago(4));
event(completed("g1", "src/api/orders.ts\nsrc/api/admin/orders.ts"), ago(4));
event(
  started("c2", "Edit", "file_edit", {
    file_path: DB,
    old_string: "export function ordersQuery(limit: number, offset: number) {",
    new_string: "export function ordersQuery(limit: number, cursor?: Cursor) {\n  const after = cursor && decodeCursor(cursor);",
  }),
  ago(3),
);
event(completed("c2", "The file has been updated."), ago(3));
event({ type: "model_request_started" }, ago(1));

// ── the mock ──────────────────────────────────────────────────────────────────

const model = (id: string, label: string, provider: string, defaultEffort: string): Model =>
  ({
    id,
    label,
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort,
    arg: id,
    provider,
    acceptsImages: true,
    secondary: false,
    supportsFast: false,
  }) as Model;

const MODELS: Partial<Record<Harness, Model[]>> = {
  claude_code: [model("opus", "Opus 5.5", "anthropic", "high"), model("sonnet", "Sonnet 5.5", "anthropic", "high")],
  codex: [model("gpt-6-astra", "GPT-6-Astra", "openai", "medium"), model("gpt-5.5", "GPT-5.5", "openai", "medium")],
};

const AVAILABLE = (["claude_code", "codex", "grok", "pi"] as Harness[]).map(
  (h): AgentAvailability => ({
    harness: h,
    label: h,
    available: true,
    reason: "",
    installCommand: null,
    docsUrl: null,
    loginCommand: "",
    loginHint: null,
  }),
);

function change(more: Partial<SessionIndexItem>) {
  const at = index.findIndex((i) => i.sessionId === TASK);
  index[at] = { ...index[at], ...more };
  void emit("session_changed", index[at]);
}

function setStatus(status: SessionIndexItem["status"]) {
  const modified = new Date().toISOString();
  change({ status, modified });
  void emit("session_status", { sessionId: TASK, status, modified });
}

/// Appends to the log and sends it live.
function live(payload: object) {
  void emit("agent_event", event(payload));
}

let sentPrompt: string | null = null;

async function answer(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "list_session_index_items":
      return index.filter((i) => !!a.archived === i.archived);
    case "session_index_item":
      return index.find((i) => i.sessionId === a.sessionId) ?? null;
    case "get_session_by_id": {
      const found = index.find((i) => i.sessionId === a.sessionId);
      return found ? { ...found, events: found.sessionId === TASK ? log : [], olderBefore: null } : null;
    }
    case "get_session_page":
      return { events: [], olderBefore: null };
    case "get_session_since":
      return [];
    case "list_projects":
      return PROJECTS;
    case "list_models":
      return MODELS[a.harness as Harness] ?? [];
    case "agent_availability":
      return AVAILABLE;
    case "list_branches":
      return { current: "main", branches: ["main"], defaultBase: "main", dirty: 0 };
    case "worktree_disposition":
      return { exists: true, changedFiles: 2, unpushedCommits: 0 };
    case "switch_agent": {
      const from = harness;
      harness = a.harness as Harness;
      live({ type: "agent_switched", from, to: harness, resumed: false });
      change({ harness, model: String(a.model), effort: (a.effort as SessionIndexItem["effort"]) ?? null, continueAt: undefined });
      return null;
    }
    case "send_msg":
      // The story logs the prompt on a cue of its own, so it lands on a frame.
      sentPrompt = String(a.prompt);
      return { snapshot: null, queued: null, issues: [] };
    case "check_update":
    case "auto_merge_card":
    case "local_server":
    case "pr_for_branch":
      return null;
    case "pr_marks":
    case "list_bots":
    case "list_servers":
    case "browser_tabs":
    case "list_open_apps":
    case "list_drafts":
    case "list_slash_commands":
    case "check_agent_updates":
    case "list_local_servers":
      return [];
    case "server_caches":
    case "bot_previews":
      return {};
    case "get_integrations":
      return { linear: null, github: null };
    default:
      if (/^(set_|mark_|track_|notify_|warm_|reconnect_|watch_|island_|configure_|save_)/.test(cmd)) return null;
      console.info("[harness-video] nothing stubbed for", cmd, a);
      throw `demo: nothing stubbed for ${cmd}`;
  }
}

mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return cmd === "server_invoke" ? answer(String(a.cmd), (a.args ?? {}) as Record<string, unknown>) : answer(cmd, a);
  },
  { shouldMockEvents: true },
);

// A browser that never ran Dray would otherwise open on "What's new".
const realFetch = window.fetch;
window.fetch = (input, init) =>
  String(input instanceof Request ? input.url : input).endsWith("/changelog.json")
    ? Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } }))
    : realFetch(input, init);
// A tooltip is a hover's afterthought, and on camera it covers the composer.
const quiet = document.createElement("style");
quiet.textContent = '[data-slot="tooltip-content"] { display: none !important; }';
document.head.append(quiet);
// Four agents on the picker's track rather than every one the app knows.
localStorage.setItem("ade.disabledAgents", JSON.stringify(["fx", "opencode"]));

// After the mock: the app's modules reach for Tauri as they load.
const { setMode, setTheme } = await import("@/hooks/useTheme");
const { default: App } = await import("@/App");
setTheme("default");
setMode("dark");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// ── what the camera and the pointer aim at ────────────────────────────────────

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const editor = () => $('[contenteditable="true"]');
/// The composer's card: the editor's nearest ancestor taller than a line.
const composer = () => {
  let el = editor();
  while (el && el.getBoundingClientRect().height < 60) el = el.parentElement;
  return el;
};
const picker = () =>
  [...document.querySelectorAll<HTMLElement>("button")].find((b) => /^(Opus 5\.5|GPT-6-Astra)/.test(b.textContent?.trim() ?? "")) ??
  null;
const agent = (label: string) => $(`[role="radiogroup"][aria-label="Agent"] [role="radio"][aria-label*="${label}"]`);
const menuRow = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((el) => el.textContent?.includes(label)) ?? null;

const TARGETS: Record<string, () => Element | null> = {
  composer,
  picker,
  menu: () => $('[role="menu"]'),
  codex: () => agent("Codex"),
  astra: () => menuRow("GPT-6-Astra"),
};

function rect(name: string) {
  const r = TARGETS[name]?.()?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

// ── the story ─────────────────────────────────────────────────────────────────

/// A real press: Radix opens its menus on pointerdown, not click.
function press(el: HTMLElement | null) {
  if (!el) return console.warn("[harness-video] nothing to press");
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, buttons: 1 }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
  el.dispatchEvent(new PointerEvent("pointerup", at));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  el.dispatchEvent(new MouseEvent("click", at));
}

let lastHover: Element | null = null;
/// What a pointer at (x, y) would light: menus highlight rows on pointermove.
function hover(x: number, y: number) {
  const under = document.elementFromPoint(x, y);
  if (!under || under === lastHover) return;
  lastHover = under;
  const at = { bubbles: true, pointerType: "mouse", clientX: x, clientY: y, pointerId: 1 };
  under.dispatchEvent(new PointerEvent("pointerover", at));
  under.dispatchEvent(new PointerEvent("pointermove", at));
}

type Cue = { t: number; run: () => void };
const cues: Cue[] = [];
const cue = (t: number, run: () => void) => cues.push({ t, run });
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/// A reply streamed word by word over `[a, b]`, then committed.
let blocks = 0;
function stream(a: number, b: number, text: string) {
  const block = { messageId: `msg-${blocks++}`, index: 0 };
  const parts = text.split(/(?<= )/);
  cue(a, () => live({ type: "delta", delta: "block_start", block, blockType: { type: "text" } }));
  parts.forEach((part, i) =>
    cue(lerp(a, b, (i + 1) / parts.length), () => live({ type: "delta", delta: "text_delta", block, text: part })),
  );
  cue(b + 0.02, () => {
    live(say(text, block));
    live({ type: "delta", delta: "block_stop", block });
  });
}

// Fixed, so the limit's sentence and the auto-continue line agree in every render.
const RESET = new Date(NOW);
RESET.setHours(16, 0, 0, 0);
const resetLabel = "4pm";

// Claude Code: one more edit, a word, then the limit.
cue(1.9, () =>
  live(
    started("c3", "Edit", "file_edit", {
      file_path: ORDERS,
      old_string: "const offset = Number(req.query.offset ?? 0);",
      new_string: "const cursor = req.query.cursor ?? legacyCursor(req.query.offset);",
    }),
  ),
);
cue(2.3, () => live(completed("c3", "The file has been updated.")));
cue(2.45, () => live({ type: "model_request_started" }));
stream(2.6, 3.2, "Route takes the cursor now. Tests next.");
cue(BEATS.limit, () => {
  live({ type: "rate_limited", status: "rejected", resetsAt: RESET.toISOString(), limitType: "five_hour", overageStatus: "rejected", usingOverage: false, overageDisabledReason: null });
  // The CLI says it twice, as a message and as the turn's last word, and the
  // app draws it once, in red.
  const sentence = `You've hit your limit · resets ${resetLabel}`;
  live(say(sentence));
  live(done("error", sentence));
  change({ continueAt: new Date(RESET.getTime() + 60_000).toISOString() });
  setStatus("idle");
});

// The switch, in the composer's own picker.
cue(BEATS.open, () => press(picker()));
cue(BEATS.codex, () => press(agent("Codex")));
cue(BEATS.model, () => press(menuRow("GPT-6-Astra")));
// Radix hands focus back to the trigger once the menu has gone, which rings it.
for (const after of [0.25, 0.4, 0.55]) cue(BEATS.model + after, () => editor()?.focus());
const PROMPT = "Keep going.";
cue(7.85, () => {
  const ed = editor()!;
  ed.spellcheck = false;
  ed.focus();
});
[...PROMPT].forEach((ch, i) => cue(7.95 + i * 0.07, () => document.execCommand("insertText", false, ch)));
cue(BEATS.send, () =>
  editor()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })),
);

// Codex, on the same task.
cue(9.1, () => {
  live(user(sentPrompt ?? PROMPT));
  setStatus("in_progress");
});
cue(9.25, () => live({ type: "model_request_started" }));
stream(9.8, 10.6, "Picking up from the cursor edits. Writing the tests.");
cue(10.75, () => live(started("x1", "create_file", "file_edit", { file_path: TEST }, "orders.test.ts")));
cue(11.15, () => {
  live(completed("x1", ""));
  live({
    type: "file_edits",
    callId: "x1",
    edits: [{ path: TEST, change: "add", unifiedDiff: '@@ -0,0 +1,3 @@\n+import { listOrders } from "./orders";\n+\n+test("pages with a cursor", async () => {' }],
  });
});
cue(11.3, () => live(started("x2", "shell", "shell", { command: "pnpm test orders" }, "pnpm test orders")));
cue(11.95, () => live(completed("x2", "✓ src/api/orders.test.ts (14 tests)\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)", 2100)));
cue(12.05, () => live({ type: "model_request_started" }));
stream(12.2, 12.8, "Cursor pagination is in. All 14 tests pass.");
cue(12.9, () => {
  live(done("success"));
  setStatus("completed");
});

let fired = 0;
/// Fires every cue up to `t`.
function seek(t: number) {
  while (fired < cues.length && cues[fired].t <= t) cues[fired++].run();
}

/// Holds every CSS animation and transition to the video clock: each starts on
/// the frame it first appears and moves exactly one frame per frame.
const born = new WeakMap<Animation, number>();
function pin(t: number) {
  for (const a of document.getAnimations()) {
    if (!born.has(a)) born.set(a, t);
    a.pause();
    a.currentTime = (t - born.get(a)!) * 1000;
  }
}

// ── opening ───────────────────────────────────────────────────────────────────

async function until<T>(get: () => T | null | undefined, ms = 20_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const found = get();
    if (found) return found;
    if (performance.now() > end) throw new Error("demo: timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const row = await until(() =>
  [...document.querySelectorAll<HTMLElement>("aside *")].find((el) => el.textContent?.trim() === index[0].title),
);
row.click();
await until(() => editor() && picker());
// The dev build's branch label has no place in a video.
for (const el of document.querySelectorAll<HTMLElement>("aside div"))
  if (/^Dev( · |$)/.test(el.textContent ?? "")) el.style.visibility = "hidden";
await new Promise((r) => setTimeout(r, 400));

export type AppApi = { seek: typeof seek; pin: typeof pin; rect: typeof rect; hover: typeof hover };
(window as unknown as { __app: AppApi }).__app = { seek, pin, rect, hover };
