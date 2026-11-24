import { CLAUDE_PATH, MARK, OPENAI_PATH, WORDMARK_PATHS } from "./marks.js";
import { CLOSING, FIELD, NODES } from "./tiles.js";

export const W = 1920;
export const H = 1080;
export const FPS = 60;
export const DUR = 15;

const OUTRO = "Switch to any agent harness mid-task.";

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const bump = (p) => Math.sin(Math.PI * clamp(p));
const ease = {
  linear: (p) => p,
  outCubic: (p) => 1 - (1 - p) ** 3,
  outQuint: (p) => 1 - (1 - p) ** 5,
  outExpo: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  inCubic: (p) => p ** 3,
  inOutCubic: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  inOutQuint: (p) => (p < 0.5 ? 16 * p ** 5 : 1 - (-2 * p + 2) ** 5 / 2),
  outBack: (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2,
};

// Every beat, in seconds. The wipe fully covers the frame between +0.52 and
// +0.56, so the cut (camera jump, picker closing, chip swap) lands inside it.
const T = {
  limit: 5.4,
  cursorIn: 6.1,
  chipClick: 6.95,
  pickerOpen: 7.0,
  codexClick: 8.0,
  wipe: 8.12,
  end: 12.6,
};
T.cut = T.wipe + 0.54;

const RED = "#FF6467";
const GREEN = "#2EC58F";
const BLUES = ["#1612F8", "#0C0C9E", "#4A46FF", "#7F8CFF"];

// What the reader types into the composer, and when it goes out as a bubble.
const SENDS = [
  { text: "The checkout test fails on CI about half the time. Can you fix it?", type: [0.55, 1.25], send: 1.4 },
  { text: "Keep going.", type: [9.0, 9.4], send: 9.6 },
];

// The conversation, top to bottom. Each item grows in at `at`.
const FEED = [
  { kind: "user", text: SENDS[0].text, at: SENDS[0].send + 0.04 },
  { kind: "head", agent: "claude", at: 2.0 },
  { kind: "tool", tool: "Read", target: "checkout.test.ts", meta: "48 lines", at: 2.35 },
  { kind: "tool", tool: "Run", target: "pnpm test checkout", meta: "2 failed", tone: RED, at: 2.8 },
  { kind: "text", text: "The total is rounded before tax is added, so some carts land a cent off. Fixing it in cart.ts.", at: 3.25, type: 1.0 },
  { kind: "tool", tool: "Edit", target: "cart.ts", live: true, at: 4.55 },
  { kind: "limit", at: T.limit },
  { kind: "divider", at: T.cut + 0.2 },
  { kind: "user", text: SENDS[1].text, at: SENDS[1].send + 0.04 },
  { kind: "head", agent: "codex", at: 10.0 },
  { kind: "tool", tool: "Edit", target: "cart.ts", meta: `<span style="color:${GREEN}">+4</span> <span style="color:${RED}">−2</span>`, at: 10.3 },
  { kind: "tool", tool: "Run", target: "pnpm test checkout", meta: "12 passed", tone: GREEN, at: 10.7 },
  { kind: "text", text: "Fixed: tax is added before rounding. All 12 tests pass.", at: 11.05, type: 0.7 },
];

// The window: header strip, feed, composer, 2px apart like the site's cards.
const PANEL = { x: 300, w: 1320, head: [70, 100], feed: [172, 708], composer: [882, 108] };
const CHIP = { x: 1262, y: 904, w: 250, h: 64 };

// [t, x, y, scale, ease into this key]. The pair at the cut is a hard jump.
const CAMERA = [
  [0, 960, 560, 1.12],
  [1.3, 960, 535, 1.0, "outQuint"],
  [5.3, 960, 545, 1.02, "inOutCubic"],
  [5.8, 1000, 610, 1.1, "outCubic"],
  [6.15, 1010, 620, 1.11, "inOutCubic"],
  [7.0, 1240, 760, 1.75, "inOutQuint"],
  [T.cut, 1255, 765, 1.8, "inOutCubic"],
  [T.cut + 0.001, 1020, 700, 1.3, "linear"],
  [11.4, 960, 535, 1.0, "inOutCubic"],
  [13.3, 960, 535, 0.95, "inOutCubic"],
];

function camera(t) {
  let i = CAMERA.findIndex((k) => k[0] > t);
  if (i === -1) i = CAMERA.length;
  if (i === 0) return { x: CAMERA[0][1], y: CAMERA[0][2], s: CAMERA[0][3] };
  const a = CAMERA[i - 1];
  const b = CAMERA[i];
  if (!b) return { x: a[1], y: a[2], s: a[3] };
  const p = ease[b[4]](prog(t, a[0], b[0]));
  return { x: lerp(a[1], b[1], p), y: lerp(a[2], b[2], p), s: lerp(a[3], b[3], p) };
}

// World point → screen point under a camera.
const toScreen = (cam, x, y) => [(x - cam.x) * cam.s + W / 2, (y - cam.y) * cam.s + H / 2];

/// The cursor's world position: in from the lower right to the composer's chip, then up to Codex.
function cursorAt(t) {
  const legs = [
    [T.cursorIn, 6.9, [1720, 1060], [CHIP.x + 132, CHIP.y + 28]],
    [7.25, 7.9, [CHIP.x + 132, CHIP.y + 28], [1368, 770]],
  ];
  let p = legs[0][2];
  for (const [a, b, from, to] of legs) {
    if (t < a) break;
    const k = ease.inOutCubic(prog(t, a, b));
    p = [lerp(from[0], to[0], k), lerp(from[1], to[1], k)];
  }
  return p;
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, p) => {
  const [x, y] = [hex(a), hex(b)];
  return `rgb(${x.map((v, i) => Math.round(lerp(v, y[i], p))).join(",")})`;
};

/// The site's integer tile hash, so the field's sides match HeroBackdrop.
function hash(x, y, salt) {
  let n = Math.imul((x * 73856093) ^ (y * 19349663) ^ (salt * 83492791), 2654435761);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

const rects = (d) => [...d.matchAll(/M(-?\d+) (-?\d+)h(\d+)v(\d+)/g)].map((m) => m.slice(1).map(Number));

// The sign-in gate's black-on-black tones, one per field blue.
const DARK = { "#0C0C9E": "#0C0C0C", "#1612F8": "#121212", "#2D29FF": "#181818", "#4A46FF": "#181818", "#7F8CFF": "#1F1F1F" };

/// The hero's pixel field as 60px cells in the gate's dark tones, filling the
/// lower half of the frame; the sides past 1440 grown the way HeroBackdrop does.
function fieldCells() {
  const cells = [];
  const add = (d, colour) => {
    for (const [x, y, w, h] of rects(d))
      for (let cx = x; cx < x + w; cx += 60) for (let cy = y; cy < y + h; cy += 60) cells.push([cx, cy, colour]);
  };
  for (const [d, c] of [...FIELD, ...NODES]) add(d, c);
  for (const from of [-1200, 1440])
    for (let x = from; x < from + 1200; x += 60)
      for (let y = 0; y < 900; y += 60) {
        const below = y + 30 - ((x + 30) / 2 - 210) + (hash(x, y, 1) - 0.5) * 160;
        if (below < 0) continue;
        const low = y + 30 - (540 + 0.45 * (x + 30)) + (hash(x, y, 2) - 0.5) * 160 > 0;
        cells.push([x, y, below < 70 || low ? "#0C0C9E" : hash(x, y, 3) < 0.04 ? "#2D29FF" : "#1612F8"]);
      }
  return cells
    .map(([x, y, c]) => ({ x: x + 240, y: y + 180, fill: DARK[c] }))
    .filter((c) => c.y >= 540 && c.x > -120 && c.x < W + 60);
}

const svg = (path, size, fill = "currentColor") =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="${fill}" d="${path}"/></svg>`;
const mark = (h) => `<svg viewBox="0 0 159 200" width="${(h * 159) / 200}" height="${h}" aria-hidden="true"><path fill="currentColor" d="${MARK}"/></svg>`;
const CLAUDE = (s) => svg(CLAUDE_PATH, s, "#D97757");
const OPENAI = (s) => svg(OPENAI_PATH, s);
const ARROW = `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M7 17 17 7M7 7h10v10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SEND = `<svg width="26" height="26" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/></svg>`;
const CURSOR = `<svg width="38" height="38" viewBox="0 0 24 24"><path d="M3.9 3.05 20.1 9.45Q21.5 10 20.07 10.46L14.23 12.34Q12.8 12.8 12.34 14.23L10.46 20.07Q10 21.5 9.45 20.1L3.05 3.9Q2.5 2.5 3.9 3.05Z" fill="#1612f8" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const words = (text) =>
  text
    .split(" ")
    .map((w) => `<span class="w"><span class="wi">${w}</span></span>`)
    .join(" ");

function itemHtml(it) {
  switch (it.kind) {
    case "user":
      return `<div class="bubble">${it.text}</div>`;
    case "head":
      return it.agent === "claude" ? `${CLAUDE(30)}<span class="mono">Claude Code</span>` : `${OPENAI(30)}<span class="mono">Codex</span>`;
    case "tool":
      return `<span class="k mono">${it.tool}</span><span class="x">${it.target}</span><span class="m mono"${it.tone ? ` style="color:${it.tone}"` : ""}>${it.meta ?? ""}</span>`;
    case "text":
      return `<p></p>`;
    case "limit":
      return `<div class="alert"><span class="mono">${mark(14)}Usage limit reached</span><p>Claude Code is out of usage until 6:40 PM.</p></div>`;
    case "divider":
      return `<div class="switched">${OPENAI(22)}<span class="mono">Switched to Codex</span></div>`;
  }
}

/// Builds the scene into `stage` and returns its frame function. Everything on
/// screen is a pure function of t, so any frame can be drawn in any order.
export function mount(stage) {
  const [hy, hh] = PANEL.head;
  const [fy, fh] = PANEL.feed;
  const [cy, ch] = PANEL.composer;
  stage.innerHTML = `
    <canvas id="bg" width="${W}" height="${H}"></canvas>
    <div id="world"><div id="panel">
      <div class="backing" style="top:${hy}px;height:${cy + ch - hy}px"></div>
      <div class="strip head" style="top:${hy}px;height:${hh}px">
        <div class="label mono">${mark(15)}Task</div>
        <div class="title">Fix the flaky checkout test</div>
      </div>
      <div class="strip feed" style="top:${fy}px;height:${fh}px"><div class="feed-in" id="feed">
        ${FEED.map((it) => `<div class="item ${it.kind}"><div class="in">${itemHtml(it)}</div></div>`).join("")}
      </div></div>
      <div class="strip composer" style="top:${cy}px;height:${ch}px">
        <div class="field" id="field"></div>
        <div class="send" id="send">${SEND}</div>
      </div>
      <div class="chip" id="chip" style="left:${CHIP.x}px;top:${CHIP.y}px;width:${CHIP.w}px;height:${CHIP.h}px">
        <div class="chip-in" id="chip-claude">${CLAUDE(26)}<span>Claude Code</span></div>
        <div class="chip-in" id="chip-codex">${OPENAI(26)}<span>Codex</span></div>
        <svg class="chev" width="16" height="16" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="dot" id="dot"><i></i></span>
      </div>
      <div class="picker" id="picker" style="left:${CHIP.x + CHIP.w - 606}px;top:${CHIP.y - 12 - 284}px">
        <div class="phead mono">${mark(13)}Switch agent</div>
        <div class="card" id="card-claude">
          <div class="top">${CLAUDE(52)}<span class="tag mono">Limit reached</span></div>
          <div class="bot"><span class="name">Claude Code</span></div>
        </div>
        <div class="card" id="card-codex">
          <div class="top">${OPENAI(52)}${ARROW}</div>
          <div class="bot"><span class="name">Codex</span></div>
        </div>
      </div>
      <div class="ripple" id="ripple"></div>
      <div class="cursor" id="cursor">${CURSOR}</div>
    </div></div>
    <canvas id="fx" width="${W}" height="${H}"></canvas>
    <div id="end" class="overlay"><h1>${words(OUTRO)}</h1></div>
    <div id="wm" class="overlay"><svg viewBox="0 0 466 96" width="250" height="52">${WORDMARK_PATHS.map((d) => `<path fill="currentColor" d="${d}"/>`).join("")}</svg></div>`;

  const $ = (s) => stage.querySelector(s);
  const bg = $("#bg").getContext("2d");
  const fx = $("#fx").getContext("2d");
  const world = $("#world");
  const feed = $("#feed");
  const items = [...feed.children].map((el, i) => ({ it: FEED[i], el, inner: el.firstElementChild, h: 0 }));
  const endWords = [...stage.querySelectorAll("#end .wi")];
  const cells = fieldCells();
  let measured = false;

  // Heights are read once, after fonts load, with every item at full text.
  function measure() {
    for (const m of items) {
      if (m.it.kind === "text") m.inner.firstChild.textContent = m.it.text;
      m.el.style.height = "auto";
      m.h = m.el.offsetHeight;
    }
    measured = true;
  }

  function drawBg(cam) {
    bg.setTransform(1, 0, 0, 1, 0, 0);
    bg.fillStyle = "#000";
    bg.fillRect(0, 0, W, H);
    // The field drifts at a fifth of the camera's move, for depth.
    const k = 0.2;
    const s = 1 + (cam.s - 1) * k;
    const cx = W / 2 + (cam.x - W / 2) * k;
    const cy = H / 2 + (cam.y - H / 2) * k;
    bg.setTransform(s, 0, 0, s, W / 2 - cx * s, H / 2 - cy * s);
    for (const c of cells) {
      bg.fillStyle = c.fill;
      bg.fillRect(c.x, c.y, 60, 60);
    }
    bg.fillStyle = "rgba(0,0,0,0.5)";
    for (let x = -600; x < W + 600; x += 6) bg.fillRect(x, 400, 2, H + 400);
  }

  function stripes(ctx) {
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    for (let x = 0; x < W; x += 6) ctx.fillRect(x, 0, 2, H);
    ctx.globalCompositeOperation = "source-over";
  }

  /// One 60px grid of brand-blue tiles; `size(i, j, x, y)` says how big each is now.
  function tiles(size, salt, settle = () => 0) {
    for (let i = 0; i < W / 60; i++)
      for (let j = 0; j < H / 60; j++) {
        const x = i * 60;
        const y = j * 60;
        const s = size(i, j, x, y);
        if (s <= 0) continue;
        const u = hash(i, j, salt);
        fx.fillStyle = mix(BLUES[u < 0.62 ? 0 : u < 0.8 ? 1 : u < 0.94 ? 2 : 3], "#1612F8", settle(i, j, x, y));
        fx.fillRect(x + (60 - s) / 2, y + (60 - s) / 2, s, s);
      }
    stripes(fx);
  }

  function drawFx(t, origin) {
    fx.clearRect(0, 0, W, H);
    const far = (ox, oy) => Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - ox, y - oy)));
    if (t < 1.2) {
      // Opens on the closing band's blue, which breaks into tiles from the middle.
      const maxD = far(W / 2, H / 2);
      tiles((i, j, x, y) => {
        const start = 0.12 + (Math.hypot(x + 30 - W / 2, y + 30 - H / 2) / maxD) * 0.45 + hash(i, j, 3) * 0.1;
        return 60 * (1 - ease.inCubic(prog(t, start, start + 0.3)));
      }, 17, (i, j, x, y) => 1 - prog(t, 0, 0.12 + (Math.hypot(x - W / 2, y - H / 2) / maxD) * 0.4));
    }
    if (t >= T.wipe && t < T.wipe + 1.2) {
      const [ox, oy] = origin;
      const maxD = far(ox, oy);
      tiles((i, j, x, y) => {
        const start = T.wipe + (Math.hypot(x + 30 - ox, y + 30 - oy) / maxD) * 0.32 + hash(i, j, 7) * 0.06;
        return 60 * ease.outCubic(prog(t, start, start + 0.14)) * (1 - ease.inCubic(prog(t, start + 0.56, start + 0.72)));
      }, 11);
    }
    if (t >= T.end) {
      // The closing band rises from the foot, its lit tiles settling to blue.
      const start = (i, j, y) => T.end + ((H - y) / H) * 0.5 + hash(i, j, 5) * 0.12;
      tiles(
        (i, j, x, y) => 60 * ease.outCubic(prog(t, start(i, j, y), start(i, j, y) + 0.22)),
        13,
        (i, j, x, y) => ease.inOutCubic(prog(t, start(i, j, y) + 0.15, start(i, j, y) + 0.6)),
      );
      const a = ease.outCubic(prog(t, 13.2, 13.8));
      if (a > 0) {
        fx.globalAlpha = a;
        for (const [d, fill] of CLOSING) {
          const [r, g, b] = hex(fill.slice(0, 7));
          fx.fillStyle = `rgba(${r},${g},${b},${parseInt(fill.slice(7, 9), 16) / 255})`;
          for (const [x, y, w, h] of rects(d)) fx.fillRect(x + 240, y + 120, w, h);
        }
        fx.globalAlpha = 1;
      }
    }
  }

  function renderFeed(t) {
    let total = 0;
    for (const { it, el, inner, h } of items) {
      const p = prog(t, it.at, it.at + 0.45);
      const grow = h * ease.outCubic(p);
      el.style.height = `${grow}px`;
      total += grow;
      inner.style.opacity = String(ease.outCubic(prog(t, it.at + 0.05, it.at + 0.4)));
      inner.style.transform = `translateY(${(1 - ease.outQuint(p)) * 16}px)`;
      if (it.kind === "text") {
        const tp = prog(t, it.at + 0.1, it.at + 0.1 + it.type);
        inner.firstChild.innerHTML = it.text.slice(0, Math.floor(it.text.length * tp)) + (tp > 0 && tp < 1 ? '<span class="caret"></span>' : "");
      }
      if (it.live) {
        const m = inner.querySelector(".m");
        if (t < T.limit) {
          m.textContent = "Working";
          m.className = "m mono shimmer";
          m.style.backgroundPosition = `${-((t * 1.4) % 1) * 200 + 100}% 0`;
        } else {
          m.textContent = "Stopped";
          m.className = "m mono";
          m.style.backgroundPosition = "";
        }
        el.classList.toggle("stopped", t >= T.limit);
      }
      if (it.kind === "limit") {
        const k = prog(t, it.at, it.at + 0.3);
        inner.style.transform += ` translateX(${Math.sin(k * Math.PI * 5) * (1 - k) * 7}px)`;
      }
    }
    // The feed keeps its newest line in view, the way a chat follows on.
    const view = PANEL.feed[1] - 36 - 28;
    feed.style.transform = `translateY(${-Math.max(0, total - view)}px)`;
  }

  function renderComposer(t) {
    const field = $("#field");
    const after = t >= T.cut;
    const send = SENDS.find((s) => t >= s.type[0] && t < s.send);
    if (send) {
      const n = Math.floor(send.text.length * prog(t, send.type[0], send.type[1]));
      field.className = "field typed";
      field.innerHTML = `${send.text.slice(0, n)}<span class="caret"></span>`;
    } else {
      field.className = "field";
      field.textContent = after ? "Message Codex" : "Message Claude Code";
    }
    const press = Math.max(...SENDS.map((s) => bump(prog(t, s.send - 0.08, s.send + 0.12))));
    const ready = send ? prog(t, send.type[0], send.type[0] + 0.15) : 0;
    $("#send").style.background = mix("#3A3A3A", "#FFFFFF", ready);
    $("#send").style.color = mix("#8A8A8A", "#0A0A0A", ready);
    $("#send").style.transform = `scale(${1 - press * 0.1})`;
  }

  function renderSwitch(t, cam) {
    const after = t >= T.cut;
    $("#chip-claude").style.opacity = after ? "0" : "1";
    $("#chip-codex").style.opacity = after ? "1" : "0";
    const press = bump(prog(t, T.chipClick - 0.04, T.chipClick + 0.16));
    const open = !after && t >= T.chipClick;
    const chip = $("#chip");
    chip.style.background = mix("#2A2A2A", "#383838", Math.max(press, open ? 0.6 : 0));
    chip.style.transform = `scale(${1 - press * 0.04})`;

    const dot = $("#dot");
    dot.style.transform = `scale(${after ? 0 : ease.outBack(prog(t, T.limit, T.limit + 0.35))})`;
    const pulse = t > T.limit ? ((t - T.limit) % 1.1) / 1.1 : 0;
    dot.firstChild.style.transform = `scale(${1 + pulse * 2.2})`;
    dot.firstChild.style.opacity = String((1 - pulse) * 0.6);

    const picker = $("#picker");
    const p = ease.outExpo(prog(t, T.pickerOpen, T.pickerOpen + 0.5));
    picker.style.visibility = after || p <= 0 ? "hidden" : "visible";
    picker.style.clipPath = `inset(${(1 - p) * 100}% 0 0 0)`;
    picker.style.transform = `translateY(${(1 - p) * 14}px)`;
    ["#card-claude", "#card-codex"].forEach((s, i) => {
      const c = ease.outCubic(prog(t, T.pickerOpen + 0.1 + i * 0.07, T.pickerOpen + 0.5 + i * 0.07));
      $(s).firstElementChild.style.opacity = String(c);
      $(s).lastElementChild.style.opacity = String(c);
      $(s).style.setProperty("--rise", `${(1 - c) * 12}px`);
    });
    const codex = $("#card-codex");
    const hov = prog(t, T.codexClick - 0.25, T.codexClick - 0.12);
    const flip = ease.outCubic(prog(t, T.codexClick + 0.02, T.codexClick + 0.16));
    codex.style.background = mix(mix("#262626", "#313131", hov), "#FFFFFF", flip);
    codex.style.color = mix("#FFFFFF", "#0A0A0A", flip);
    codex.style.transform = `scale(${1 - bump(prog(t, T.codexClick - 0.05, T.codexClick + 0.18)) * 0.035})`;

    const cursor = $("#cursor");
    const [x, y] = cursorAt(t);
    const click = Math.max(bump(prog(t, T.chipClick - 0.06, T.chipClick + 0.12)), bump(prog(t, T.codexClick - 0.06, T.codexClick + 0.12)));
    cursor.style.opacity = after ? "0" : String(ease.outCubic(prog(t, T.cursorIn, T.cursorIn + 0.25)));
    cursor.style.transform = `translate(${x - 5}px, ${y - 5}px) scale(${1 - click * 0.14})`;
    const ripple = $("#ripple");
    const rp = [T.chipClick, T.codexClick].map((c) => prog(t, c, c + 0.5)).find((q) => q > 0 && q < 1) ?? 0;
    ripple.style.opacity = after || !rp ? "0" : String((1 - rp) * 0.8);
    ripple.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${ease.outCubic(rp)})`;
    return toScreen(cam, x, y);
  }

  function render(t) {
    if (!measured) measure();
    const cam = camera(t);
    world.style.transform = `translate(${W / 2}px, ${H / 2}px) scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)`;
    drawBg(cam);
    renderFeed(t);
    renderComposer(t);
    drawFx(t, renderSwitch(t, cam));

    $("#end").style.visibility = t >= 13.3 ? "visible" : "hidden";
    endWords.forEach((el, i) => {
      const p = ease.outQuint(prog(t, 13.35 + i * 0.05, 13.35 + i * 0.05 + 0.7));
      el.style.transform = `translateY(${(1 - p) * 110}%)`;
    });
    const wm = ease.outQuint(prog(t, 13.85, 14.4));
    $("#wm").style.opacity = String(wm);
    $("#wm").style.transform = `translateY(${(1 - wm) * 24}px)`;
  }

  return { render };
}
