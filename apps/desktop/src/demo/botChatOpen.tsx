// Times opening a bot's chat: the whole app against a real `dray-serve`, as
// servers.html runs it, with the bot's row clicked once the sidebar is up.
//
//   DRAY_HOME=/tmp/bot dray-serve --port 7320 &   # a home holding one bot with a long log
//   open "/demo/bot-chat-open.html?local=$(cat /tmp/bot/serve-token)&bot=Release%20Bot"
//
// The result rides the window title and a box in the corner: when the first
// reply was painted, when the page went quiet (no long task and no new reply
// for three seconds), the main thread's long tasks in between, and how many
// replies were drawn. Long tasks are Chromium's alone. `&check=1` then scrolls
// the chat up and says how far the top row drifted as pages landed;
// `&focus=<task title>` picks that task's "Waiting on you" row instead.
//
// Under `pnpm dev` React runs its development build in StrictMode, several
// times slower: for numbers, build this page for production with a config
// naming it as `build.rollupOptions.input` and serve that.

// Every call to the server, by when it went out and when its answer came
// back, so the open's wait can be told from its work.
const calls: { cmd: string; sent: number; back?: number }[] = [];
const Socket = window.WebSocket;
window.WebSocket = class extends Socket {
  send(data: string) {
    const frame = JSON.parse(data);
    // A stalled task nudges its bot after a minute, which would start a turn
    // on the bench's log.
    if (frame.cmd === "nudge_bot") return;
    if ("cmd" in frame) calls[frame.id] = { cmd: frame.cmd, sent: performance.now() };
    super.send(data);
  }
  set onmessage(handle: ((e: MessageEvent) => void) | null) {
    super.onmessage = (e: MessageEvent) => {
      const frame = JSON.parse(e.data);
      if ("id" in frame && calls[frame.id]) calls[frame.id].back = performance.now();
      handle?.(e);
    };
  }
} as typeof WebSocket;

await import("./servers");

export {};

const query = new URLSearchParams(location.search);
const name = query.get("bot") ?? "Release Bot";
const BUBBLE = "[data-bot-chat] .bg-muted\\/50";
const QUIET_MS = 3000;

const box = document.createElement("pre");
box.style.cssText =
  "position:fixed;right:8px;bottom:8px;z-index:9999;margin:0;padding:8px 10px;font:12px ui-monospace,monospace;" +
  "background:#111;color:#0f0;border-radius:6px;white-space:pre;pointer-events:none";
box.textContent = "waiting for the sidebar…";
document.body.append(box);

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function until<T>(find: () => T | null | undefined, ms = 60_000): Promise<T | null> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const found = find();
    if (found) return found;
    await frame();
  }
  return null;
}

const long: [number, number][] = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) long.push([e.startTime, e.duration]);
  }).observe({ type: "longtask" });
} catch {
  // No long tasks outside Chromium; the other numbers still hold.
}
// Which script ran in each long frame, Chromium's too.
type Script = { startTime: number; duration: number; invoker: string; sourceFunctionName: string };
const frames: { startTime: number; scripts: Script[] }[] = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) frames.push(e as unknown as (typeof frames)[number]);
  }).observe({ type: "long-animation-frame" });
} catch {
  // As above.
}

const row = await until(() =>
  [...document.querySelectorAll<HTMLElement>("aside *")].find(
    (el) => el.children.length === 0 && el.textContent?.trim() === name,
  ),
);
if (!row) {
  box.textContent = `no row named ${name}`;
} else {
  // Startup's own reads settle first, so they are not counted against the open.
  await new Promise((r) => setTimeout(r, 2000));
  box.textContent = "opening…";
  const start = performance.now();
  row.click();
  let pane = 0;
  void until(() => document.querySelector("[data-bot-chat]")).then(() => (pane = performance.now() - start));
  await until(() => document.querySelector(BUBBLE));
  await frame();
  const first = performance.now() - start;
  let count = 0;
  let changed = performance.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    const now = performance.now();
    const n = document.querySelectorAll(BUBBLE).length;
    if (n !== count) {
      count = n;
      changed = now;
    }
    const lastLong = long.reduce((m, [s, d]) => Math.max(m, s + d), 0);
    if (now - Math.max(changed, lastLong) > QUIET_MS || now - start > 120_000) break;
  }
  const mine = long.filter(([s]) => s >= start);
  const busy = Math.round(mine.reduce((t, [, d]) => t + d, 0));
  const quiet = Math.round(Math.max(changed, ...mine.map(([s, d]) => s + d)) - start);
  const result = { first: Math.round(first), quiet, busy, longTasks: mine.length, replies: count };
  const during = calls
    .filter((c) => c && c.sent >= start && c.sent - start < first)
    .map((c) => `${c.cmd.padEnd(24)}${Math.round(c.sent - start)}→${c.back ? Math.round(c.back - start) : "…"}`);
  const longs = mine.map(([s, d]) => `long ${Math.round(s - start)}+${Math.round(d)}`);
  const scripts = frames
    .filter((f) => f.startTime >= start && f.startTime - start < first)
    .flatMap((f) => f.scripts)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 8)
    .map((s) => `${Math.round(s.startTime - start)}+${Math.round(s.duration)} ${s.invoker} ${s.sourceFunctionName}`);
  box.textContent = [
    ...Object.entries(result).map(([k, v]) => `${k.padEnd(10)}${v}`),
    `pane      ${Math.round(pane)}`,
    ...during,
    ...longs.slice(0, 12),
    ...scripts,
  ].join("\n");
  document.title = JSON.stringify(result);
  if (query.has("focus")) await focus(query.get("focus")!, box.textContent);
  else if (query.has("check")) await check(box.textContent);
}

/// Picks a task's row in the "Waiting on you" card and says how long until the
/// bot's reply to it is drawn and scrolled to, reading back as far as it takes.
async function focus(title: string, report: string) {
  const chat = document.querySelector("[data-bot-chat]")!;
  const scroller = chat.parentElement!;
  const row = await until(() =>
    [...chat.querySelectorAll<HTMLElement>("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === title),
  );
  if (!row) {
    document.title = `check ${JSON.stringify({ error: `no row ${title}` })}`;
    return;
  }
  const from = document.querySelectorAll(BUBBLE).length;
  const start = performance.now();
  row.click();
  const lit = await until(() => document.querySelector<HTMLElement>("[data-bot-focus]"), 50_000);
  const found = performance.now() - start;
  const near = () => {
    const at = lit!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    return at >= -2 && at < 120;
  };
  const shown = lit && (await until(() => near() || null, 5000));
  const mine = long.filter(([s]) => s >= start && s - start < found);
  const result = {
    found: lit ? Math.round(found) : "never",
    scrolled: shown ? Math.round(performance.now() - start) : "no",
    replies: `${from}→${document.querySelectorAll(BUBBLE).length}`,
    busy: Math.round(mine.reduce((t, [, d]) => t + d, 0)),
    pages: calls.filter((c) => c?.cmd === "get_session_page" && c.sent >= start).length,
  };
  const scripts = frames
    .filter((f) => f.startTime >= start)
    .flatMap((f) => f.scripts)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 6)
    .map((s) => `${Math.round(s.startTime - start)}+${Math.round(s.duration)} ${s.invoker} ${s.sourceFunctionName}`);
  box.textContent = `${report}\n${JSON.stringify(result)}\n${mine.map(([s, d]) => `${Math.round(s - start)}+${Math.round(d)}`).join(" ")}\n${scripts.join("\n")}`;
  document.title = `check ${JSON.stringify(result)}`;
}

/// Scrolls the chat up a screen at a time, as a reader would, and says how far
/// the row at the top of the view moved while older replies landed above it —
/// it should not move at all — then presses Scroll to bottom.
async function check(report: string) {
  const scroller = document.querySelector("[data-bot-chat]")!.parentElement!;
  const content = scroller.firstElementChild!;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const topRow = () => {
    const top = scroller.getBoundingClientRect().top;
    const node = [...content.children].find((n) => n.getBoundingClientRect().bottom > top + 40)!;
    return { node, at: node.getBoundingClientRect().top - top };
  };
  let drift = 0;
  let pages = 0;
  const from = document.querySelectorAll(BUBBLE).length;
  for (let step = 0; step < 40; step++) {
    scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.8);
    await frame();
    const row = topRow();
    const height = scroller.scrollHeight;
    await sleep(300);
    if (scroller.scrollHeight > height + 1) pages++;
    const moved = row.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - row.at;
    drift = Math.max(drift, Math.abs(moved));
    box.textContent = `${report}\nstep ${step}: ${document.querySelectorAll(BUBBLE).length} replies, drift ${Math.round(drift)}px`;
  }
  const replies = document.querySelectorAll(BUBBLE).length;
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Scroll to bottom"]');
  button?.click();
  await sleep(3000);
  const left = Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
  const result = { replies: `${from}→${replies}`, pages, drift: Math.round(drift), button: !!button, left };
  box.textContent = `${report}\n${JSON.stringify(result)}`;
  document.title = `check ${JSON.stringify(result)}`;
}
