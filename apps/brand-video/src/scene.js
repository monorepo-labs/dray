import { CLAUDE_PATH, MARK, OPENAI_PATH, WORDMARK_PATHS } from "./marks.js";
import { CLOSING, FIELD, NODES } from "./tiles.js";

export const W = 1920;
export const H = 1080;
export const FPS = 60;
export const DUR = 15;

/// The headline takes Yogesh picks from: an opening hook and the end card.
export const VARIANTS = {
  a: { hook: "Claude Code hit its limit.", lead: "Switch to Codex mid-task.", rest: "It picks up where Claude left off." },
  b: { hook: "Out of usage mid-task?", lead: "Switch agents mid-task.", rest: "Nothing starts over." },
  c: { hook: "One task, two agents.", lead: "Out of Claude?", rest: "Keep going in Codex." },
};

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
  panelIn: 2.15,
  limit: 5.75,
  cursorIn: 6.4,
  chipClick: 7.3,
  pickerOpen: 7.36,
  codexClick: 8.4,
  wipe: 8.52,
  end: 12.45,
};
T.cut = T.wipe + 0.54;

const RED = "#FF6467";
const GREEN = "#2EC58F";
const BLUES = ["#1612F8", "#0C0C9E", "#4A46FF", "#7F8CFF"];

const ROWS = [
  { id: "r1", agent: "claude", kind: "Read", text: "checkout.test.ts", meta: "48 lines", at: 2.85 },
  { id: "r2", agent: "claude", kind: "Run", text: "pnpm test checkout", meta: "2 failed", tone: RED, at: 3.3 },
  { id: "r3", agent: "claude", kind: "say", text: "The total is rounded before tax is added. Fixing it in cart.ts.", at: 3.85, type: 0.9 },
  { id: "r4", agent: "claude", kind: "Edit", text: "cart.ts", meta: "Working", at: 4.95, live: true },
  { id: "div", kind: "divider", text: "Switched to Codex · same task", at: T.cut + 0.24 },
  { id: "c1", agent: "codex", kind: "Edit", text: "cart.ts", meta: `<span style="color:${GREEN}">+4</span> <span style="color:${RED}">−2</span>`, at: 9.65 },
  { id: "c2", agent: "codex", kind: "Run", text: "pnpm test checkout", meta: "12 passed", tone: GREEN, at: 10.4 },
  { id: "c3", agent: "codex", kind: "say", text: "Fixed: tax is added before rounding. All 12 tests pass.", meta: "Done", tone: GREEN, at: 11.0, type: 0.85 },
];
{
  let y = 248;
  for (const r of ROWS) {
    r.h = r.kind === "divider" ? 56 : 84;
    r.y = y;
    y += r.h + 2;
  }
}

// [t, x, y, scale, ease into this key]. The pair at the cut is a hard jump.
const CAMERA = [
  [0, 960, 560, 1.1],
  [2.1, 960, 560, 1.1, "linear"],
  [3.1, 960, 470, 1.0, "outQuint"],
  [5.65, 960, 455, 1.03, "inOutCubic"],
  [6.1, 1070, 400, 1.12, "outCubic"],
  [6.5, 1090, 390, 1.14, "inOutCubic"],
  [7.35, 1300, 330, 1.72, "inOutQuint"],
  [T.cut, 1310, 350, 1.78, "inOutCubic"],
  [T.cut + 0.001, 1000, 640, 1.32, "linear"],
  [11.7, 960, 505, 1.0, "inOutCubic"],
  [13.2, 960, 505, 0.95, "inOutCubic"],
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

/// The cursor's world position: in from the lower right to the chip, then down to Codex.
function cursorAt(t) {
  const legs = [
    [T.cursorIn, 7.25, [1760, 800], [1468, 176]],
    [7.6, 8.3, [1468, 176], [1452, 396]],
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

// The gate's black-on-black tones, one per field blue, for the task scene.
const DARK = { "#0C0C9E": "#0C0C0C", "#1612F8": "#121212", "#2D29FF": "#181818", "#4A46FF": "#181818", "#7F8CFF": "#1F1F1F" };

/// The hero's pixel field as 60px cells, placed so its visible band fills the
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
    .map(([x, y, blue]) => ({ x: x + 240, y: y + 180, blue, dark: DARK[blue], h: hash(x, y, 9) }))
    .filter((c) => c.y >= 540 && c.x > -120 && c.x < W + 60);
}

const svg = (path, size, fill = "currentColor", box = "0 0 24 24") =>
  `<svg viewBox="${box}" width="${size}" height="${size}" aria-hidden="true"><path fill="${fill}" d="${path}"/></svg>`;
const mark = (h) => `<svg viewBox="0 0 159 200" width="${(h * 159) / 200}" height="${h}" aria-hidden="true"><path fill="currentColor" d="${MARK}"/></svg>`;
const CLAUDE = (s) => svg(CLAUDE_PATH, s, "#D97757");
const OPENAI = (s) => svg(OPENAI_PATH, s);
const ARROW = `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M7 17 17 7M7 7h10v10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CURSOR = `<svg width="38" height="38" viewBox="0 0 24 24"><path d="M3.9 3.05 20.1 9.45Q21.5 10 20.07 10.46L14.23 12.34Q12.8 12.8 12.34 14.23L10.46 20.07Q10 21.5 9.45 20.1L3.05 3.9Q2.5 2.5 3.9 3.05Z" fill="#1612f8" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const words = (text) =>
  text
    .split(" ")
    .map((w) => `<span class="w"><span class="wi">${w}</span></span>`)
    .join(" ");

function rowHtml(r) {
  if (r.kind === "divider")
    return `<div class="strip divider" id="${r.id}" style="top:${r.y}px;height:${r.h}px">${OPENAI(22)}<span class="mono">${r.text}</span></div>`;
  const say = r.kind === "say";
  return `<div class="strip row${say ? " say" : ""}" id="${r.id}" style="top:${r.y}px;height:${r.h}px">
    <span class="g">${r.agent === "claude" ? CLAUDE(28) : OPENAI(28)}</span>
    <span class="k mono">${say ? "" : r.kind}</span>
    <span class="x">${say ? "" : r.text}</span>
    <span class="m mono"${r.tone ? ` style="color:${r.tone}"` : ""}>${r.meta ?? ""}</span>
    ${r.live ? '<span class="bar"></span>' : ""}
  </div>`;
}

/// Builds the scene into `stage` and returns its frame function. Everything on
/// screen is a pure function of t, so any frame can be drawn in any order.
export function mount(stage, variant) {
  const v = VARIANTS[variant] ?? VARIANTS.a;
  stage.innerHTML = `
    <canvas id="bg" width="${W}" height="${H}"></canvas>
    <div id="world"><div id="panel">
      <div id="backing"></div>
      <div class="strip head" style="top:96px;height:150px">
        <div class="label mono">${mark(16)}Task</div>
        <div class="title">Fix the flaky checkout test</div>
      </div>
      ${ROWS.map(rowHtml).join("")}
      <div class="chip" id="chip">
        <div class="chip-in" id="chip-claude">${CLAUDE(30)}<span>Claude Code</span></div>
        <div class="chip-in" id="chip-codex">${OPENAI(30)}<span>Codex</span></div>
        <svg class="chev" width="18" height="18" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="dot" id="dot"><i></i></span>
      </div>
      <div class="picker" id="picker">
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
    <div id="intro" class="overlay"><div class="label mono">${mark(18)}New in Dray</div><h1>${words(v.hook)}</h1></div>
    <canvas id="fx" width="${W}" height="${H}"></canvas>
    <div id="end" class="overlay">
      <div class="label mono">${mark(18)}New in Dray</div>
      <h1><span class="lead">${words(v.lead)}</span><br><span class="rest">${words(v.rest)}</span></h1>
    </div>
    <div id="wm" class="overlay"><svg viewBox="0 0 466 96" width="250" height="52">${WORDMARK_PATHS.map((d) => `<path fill="currentColor" d="${d}"/>`).join("")}</svg></div>`;

  const $ = (s) => stage.querySelector(s);
  const bg = $("#bg").getContext("2d");
  const fx = $("#fx").getContext("2d");
  const world = $("#world");
  const panel = $("#panel");
  const rows = ROWS.map((r) => ({ r, el: $(`#${r.id}`) }));
  const introWords = [...stage.querySelectorAll("#intro .wi")];
  const endWords = [...stage.querySelectorAll("#end .wi")];
  const cells = fieldCells();

  function drawBg(t, cam) {
    bg.setTransform(1, 0, 0, 1, 0, 0);
    bg.fillStyle = "#000";
    bg.fillRect(0, 0, W, H);
    // The field drifts at a quarter of the camera's move, for depth.
    const k = 0.22;
    const s = 1 + (cam.s - 1) * k;
    const cx = W / 2 + (cam.x - W / 2) * k;
    const cy = H / 2 + (cam.y - H / 2) * k;
    bg.setTransform(s, 0, 0, s, W / 2 - cx * s, H / 2 - cy * s);
    for (const c of cells) {
      const delay = ((H - c.y) / 540) * 0.45 + (c.x / W) * 0.1 + c.h * 0.15;
      const a = ease.outCubic(prog(t, delay, delay + 0.35));
      if (a <= 0) continue;
      const dark = ease.inOutCubic(prog(t, 1.85 + c.h * 0.35 + ((H - c.y) / 540) * 0.2, 2.35 + c.h * 0.35 + ((H - c.y) / 540) * 0.2));
      const size = 60 * (0.55 + 0.45 * a);
      bg.globalAlpha = a;
      bg.fillStyle = mix(c.blue, c.dark, dark);
      bg.fillRect(c.x + (60 - size) / 2, c.y + (60 - size) / 2, size, size);
    }
    bg.globalAlpha = 1;
    // The site's 2px stripes every 6px; black, so they only show over tiles.
    bg.fillStyle = `rgba(0,0,0,${lerp(0.12, 0.5, prog(t, 1.9, 2.8))})`;
    for (let x = -600; x < W + 600; x += 6) bg.fillRect(x, 400, 2, H + 400);
  }

  function stripes(ctx, alpha) {
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    for (let x = 0; x < W; x += 6) ctx.fillRect(x, 0, 2, H);
    ctx.globalCompositeOperation = "source-over";
  }

  function drawFx(t, origin) {
    fx.clearRect(0, 0, W, H);
    if (t >= T.wipe && t < T.wipe + 1.2) {
      const [ox, oy] = origin;
      const maxD = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - ox, y - oy)));
      for (let i = 0; i < W / 60; i++)
        for (let j = 0; j < H / 60; j++) {
          const x = i * 60;
          const y = j * 60;
          const d = Math.hypot(x + 30 - ox, y + 30 - oy) / maxD;
          const h = hash(i, j, 7);
          const start = T.wipe + d * 0.32 + h * 0.06;
          const size = 60 * ease.outCubic(prog(t, start, start + 0.14)) * (1 - ease.inCubic(prog(t, start + 0.56, start + 0.72)));
          if (size <= 0) continue;
          const u = hash(i, j, 11);
          fx.fillStyle = BLUES[u < 0.62 ? 0 : u < 0.8 ? 1 : u < 0.94 ? 2 : 3];
          fx.fillRect(x + (60 - size) / 2, y + (60 - size) / 2, size, size);
        }
      stripes(fx, 0.12);
    }
    if (t >= T.end) {
      // The closing band rises from the foot, its lit tiles settling to blue.
      for (let i = 0; i < W / 60; i++)
        for (let j = 0; j < H / 60; j++) {
          const x = i * 60;
          const y = j * 60;
          const h = hash(i, j, 5);
          const start = T.end + ((H - y) / H) * 0.5 + h * 0.12;
          const size = 60 * ease.outCubic(prog(t, start, start + 0.22));
          if (size <= 0) continue;
          const u = hash(i, j, 13);
          const lit = BLUES[u < 0.55 ? 0 : u < 0.75 ? 1 : u < 0.92 ? 2 : 3];
          fx.fillStyle = mix(lit, "#1612F8", ease.inOutCubic(prog(t, start + 0.15, start + 0.6)));
          fx.fillRect(x + (60 - size) / 2, y + (60 - size) / 2, size, size);
        }
      stripes(fx, 0.12);
      const a = ease.outCubic(prog(t, 13.0, 13.6));
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

  function revealWords(els, t, inAt, gap, outAt = 1e9) {
    els.forEach((el, i) => {
      const p = ease.outQuint(prog(t, inAt + i * gap, inAt + i * gap + 0.7));
      const q = ease.inOutCubic(prog(t, outAt + i * 0.03, outAt + i * 0.03 + 0.32));
      el.style.transform = `translateY(${(1 - p) * 110 - q * 110}%)`;
    });
  }

  function renderRows(t) {
    // Black behind the strips that are up, so their 2px gaps read as the
    // site's gaps rather than letting the striped field through.
    const shown = rows.filter(({ r }) => t >= r.at).at(-1);
    $("#backing").style.height = `${(shown ? shown.r.y + shown.r.h : 246) - 96}px`;
    for (const { r, el } of rows) {
      if (t < r.at) {
        el.style.opacity = "0";
        continue;
      }
      const p = prog(t, r.at, r.at + 0.55);
      el.style.opacity = String(ease.outCubic(p));
      el.style.transform = `translateY(${(1 - ease.outQuint(p)) * 18}px)`;
      el.style.clipPath = `inset(0 ${(1 - ease.outExpo(p)) * 100}% 0 0)`;
      if (r.kind === "say") {
        const tp = prog(t, r.at + 0.12, r.at + 0.12 + r.type);
        const n = Math.floor(r.text.length * tp);
        el.querySelector(".x").innerHTML = r.text.slice(0, n) + (tp < 1 ? '<span class="caret"></span>' : "");
        if (r.meta) el.querySelector(".m").style.opacity = String(ease.outCubic(prog(t, r.at + r.type + 0.15, r.at + r.type + 0.45)));
      }
      if (r.live) {
        const m = el.querySelector(".m");
        const bar = el.querySelector(".bar");
        const stopped = t >= T.limit;
        el.classList.toggle("stopped", stopped);
        if (!stopped) {
          m.textContent = "Working";
          m.className = "m mono shimmer";
          m.style.backgroundPosition = `${-((t * 1.4) % 1) * 200 + 100}% 0`;
          const x = ((t - r.at) * 0.9) % 1;
          bar.style.background = `linear-gradient(90deg, transparent ${x * 120 - 25}%, rgba(255,255,255,.55) ${x * 120 - 10}%, transparent ${x * 120}%)`;
        } else {
          const k = prog(t, T.limit, T.limit + 0.25);
          m.textContent = "Usage limit reached";
          m.className = "m mono";
          m.style.color = RED;
          m.style.backgroundPosition = "";
          m.style.transform = `translateX(${Math.sin(k * Math.PI * 5) * (1 - k) * 6}px)`;
          bar.style.background = RED;
          bar.style.opacity = String(lerp(1, 0.7, k));
        }
      }
    }
  }

  function renderSwitch(t, cam) {
    const after = t >= T.cut;
    $("#chip-claude").style.opacity = after ? "0" : "1";
    $("#chip-codex").style.opacity = after ? "1" : "0";
    const press = bump(prog(t, T.chipClick - 0.04, T.chipClick + 0.16));
    const open = !after && t >= T.chipClick;
    const chip = $("#chip");
    chip.style.background = mix("#262626", "#343434", Math.max(press, open ? 0.6 : 0));
    chip.style.transform = `scale(${1 - press * 0.04})`;

    const dot = $("#dot");
    const d = ease.outBack(prog(t, T.limit, T.limit + 0.35));
    dot.style.transform = `scale(${after ? 0 : d})`;
    const pulse = t > T.limit ? ((t - T.limit) % 1.1) / 1.1 : 0;
    dot.firstChild.style.transform = `scale(${1 + pulse * 2.2})`;
    dot.firstChild.style.opacity = String((1 - pulse) * 0.6);

    const picker = $("#picker");
    const p = ease.outExpo(prog(t, T.pickerOpen, T.pickerOpen + 0.5));
    picker.style.visibility = after || p <= 0 ? "hidden" : "visible";
    picker.style.clipPath = `inset(0 0 ${(1 - p) * 100}% 0)`;
    picker.style.transform = `translateY(${(1 - p) * -14}px)`;
    ["#card-claude", "#card-codex"].forEach((s, i) => {
      const c = ease.outCubic(prog(t, T.pickerOpen + 0.1 + i * 0.07, T.pickerOpen + 0.5 + i * 0.07));
      $(s).firstElementChild.style.opacity = String(c);
      $(s).lastElementChild.style.opacity = String(c);
      $(s).style.setProperty("--rise", `${(1 - c) * 12}px`);
    });
    const codex = $("#card-codex");
    const hov = prog(t, 8.12, 8.26);
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
    const cam = camera(t);
    world.style.transform = `translate(${W / 2}px, ${H / 2}px) scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)`;
    drawBg(t, cam);

    $("#intro .label").style.opacity = String(ease.outCubic(prog(t, 0.05, 0.4)) * (1 - prog(t, 1.7, 1.9)));
    revealWords(introWords, t, 0.15, 0.06, 1.72);

    const pin = ease.outQuint(prog(t, T.panelIn, T.panelIn + 0.85));
    panel.style.opacity = String(pin);
    panel.style.transform = `translateY(${(1 - pin) * 90}px)`;
    renderRows(t);
    const origin = renderSwitch(t, cam);
    drawFx(t, origin);

    $("#end").style.visibility = t >= 13.15 ? "visible" : "hidden";
    $("#end .label").style.opacity = String(ease.outCubic(prog(t, 13.2, 13.5)));
    revealWords(endWords, t, 13.25, 0.04);
    const wm = ease.outQuint(prog(t, 13.7, 14.3));
    $("#wm").style.opacity = String(wm);
    $("#wm").style.transform = `translateY(${(1 - wm) * 24}px)`;
  }

  return { render };
}
