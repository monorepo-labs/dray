// A 15-second video of switching a task's agent mid-task (#1414, #1528):
// Claude Code hits its usage limit, the task moves to Codex in the composer's
// own picker, and Codex picks up where it stopped. The app is the real one,
// Dray dark, in an iframe ([harnessSwitchApp](./harnessSwitchApp.tsx)); this
// page is the stage around it: the camera, the headline and the pointer, all
// a function of the video clock.
//
//   /demo/harness-switch-video.html           plays in real time, then loops
//   /demo/harness-switch-video.html?copy=b    headline b (a, b or c)
//   /demo/harness-switch-video.html?render    holds still for scripts/render-harness-video.mjs
//
// The camera moves the iframe, not anything inside it: a transform on the
// app's own `body` threw off where its menus open, which they place by their
// trigger's on-screen box.

import { BEATS } from "@/demo/harnessSwitchBeats";

const query = new URLSearchParams(location.search);

if (query.has("app")) await import("@/demo/harnessSwitchApp");
else await stage();

async function stage() {
  const RENDER = query.has("render");
  const COPY: Record<string, { head: string; sub: string }> = {
    a: { head: "Out of Claude? Keep going in Codex.", sub: "Switch a task's agent mid-task." },
    b: { head: "Switch agents mid-task.", sub: "Same task, same branch, same conversation." },
    c: { head: "Hit a limit. Switch agents. Keep going.", sub: "The next agent picks up where the last one stopped." },
  };
  const key = query.get("copy") ?? "a";
  const copy = COPY[key] ?? COPY.a;
  const W = 1440;
  const H = 810;
  const DURATION = BEATS.duration;

  const css = document.createElement("style");
  css.textContent = `
    html, body { margin: 0; height: 100%; overflow: hidden; background: #050506; }
    #stage {
      position: absolute; left: 50%; top: 50%; width: ${W}px; height: ${H}px; overflow: hidden; transform-origin: 0 0;
      background: radial-gradient(110% 85% at 50% 18%, #1c1c21 0%, #0b0b0d 58%, #050506 100%);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
    }
    #app {
      position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; border: 0; transform-origin: 0 0;
      border-radius: 14px; background: #111;
      box-shadow: 0 0 0 1px rgba(255,255,255,.09), 0 40px 120px rgba(0,0,0,.65), 0 12px 40px rgba(0,0,0,.45);
    }
    #headline {
      position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; pointer-events: none; color: #f5f5f7; text-align: center;
    }
    #headline h1 { margin: 0; font-size: 62px; font-weight: 650; letter-spacing: -0.035em; line-height: 1.05; }
    #headline p { margin: 0; font-size: 25px; font-weight: 450; letter-spacing: -0.01em; color: rgba(245,245,247,.58); }
    #headline .w { display: inline-block; white-space: pre; }
    #cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; pointer-events: none; transform-origin: 3px 2px; }
  `;
  document.head.append(css);

  const root = document.createElement("div");
  root.id = "stage";
  const frame = document.createElement("iframe");
  frame.id = "app";
  frame.src = `${location.pathname}?app`;
  const headline = document.createElement("div");
  headline.id = "headline";
  const words = (text: string) =>
    text
      .split(/(?<= )/)
      .map((w) => `<span class="w">${w}</span>`)
      .join("");
  headline.innerHTML = `<h1>${words(copy.head)}</h1><p>${copy.sub}</p>`;
  const cursor = document.createElement("div");
  cursor.id = "cursor";
  cursor.innerHTML = `<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L14.6 22.6 L11.2 15.3 L18 15.3 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  root.append(frame, headline, cursor);
  document.body.append(root);

  // Fills the window in a preview; the render's viewport is the stage's size.
  const fitWindow = () => {
    const k = Math.min(innerWidth / W, innerHeight / H);
    root.style.transform = `scale(${k}) translate(-50%, -50%)`;
  };
  fitWindow();
  addEventListener("resize", fitWindow);

  type Rect = { x: number; y: number; w: number; h: number };
  type Api = { seek: (t: number) => void; pin: (t: number) => void; rect: (name: string) => Rect | null; hover: (x: number, y: number) => void };
  const app = await new Promise<Api>((resolve) => {
    const poll = () => {
      const api = (frame.contentWindow as unknown as { __app?: Api } | null)?.__app;
      if (api) resolve(api);
      else setTimeout(poll, 50);
    };
    poll();
  });

  // ── time ────────────────────────────────────────────────────────────────────

  const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
  const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOut = (p: number) => 1 - Math.pow(1 - p, 4);
  /// 0 before `a`, 1 after `b`, eased between.
  const span = (t: number, a: number, b: number, ease = easeInOut) => ease(clamp((t - a) / (b - a)));

  type Point = { x: number; y: number };
  type View = Point & { z: number };

  /// The window at rest fills 90% of the frame; `z` zooms from there onto a
  /// focus point in the app's coordinates, never past the window's edge.
  const FIT = 0.9;
  function place(v: View) {
    const s = FIT * v.z;
    // Zoomed in, a little backdrop may show past the window's edge, so a
    // target near the bottom can still sit nearer the middle.
    const slack = s > 1 ? 70 : 0;
    const fitted = (focus: number, size: number) =>
      clamp(size / 2 - s * focus, Math.min(0, size - s * size) - slack, Math.max(0, size - s * size) + slack);
    return { s, tx: fitted(v.x, W), ty: fitted(v.y, H) };
  }

  const centre = (name: string, dy = 0) => (): Point | null => {
    const r = app.rect(name);
    return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 + dy };
  };
  /// The transcript's newest rows, just above the composer.
  const tail = (): Point | null => {
    const r = app.rect("composer");
    return r && { x: r.x + r.w / 2, y: r.y - 170 };
  };

  // Camera keys: a view, or one read off the app when its move starts, so a
  // target is read while it is on screen.
  type Key = { t: number; to: View | (() => View) };
  const fit: View = { x: W / 2, y: H / 2, z: 1 };
  const on = (p: () => Point | null, z: number) => () => ({ ...(p() ?? fit), z });
  const { limit, open, codex, model, send } = BEATS;
  const CAMERA: Key[] = [
    { t: 0, to: fit },
    { t: 2.0, to: fit },
    { t: limit - 0.2, to: on(tail, 1.3) },
    { t: limit + 0.5, to: on(tail, 1.36) },
    { t: open - 0.45, to: on(centre("composer", -40), 1.8) },
    { t: open + 0.12, to: on(centre("composer", -40), 1.8) },
    { t: codex - 0.35, to: on(centre("picker", -110), 2.3) },
    { t: codex, to: on(centre("picker", -110), 2.3) },
    // A small push as the agent flips, the beat the video is about.
    { t: codex + 0.18, to: on(centre("picker", -110), 2.38) },
    { t: codex + 0.6, to: on(centre("picker", -110), 2.3) },
    { t: model + 0.05, to: on(centre("picker", -110), 2.3) },
    { t: model + 0.7, to: on(centre("composer", -30), 1.95) },
    { t: send + 0.05, to: on(centre("composer", -30), 1.95) },
    { t: send + 0.9, to: on(tail, 1.3) },
    { t: 12.9, to: on(tail, 1.3) },
    { t: 13.75, to: { x: W / 2, y: H / 2 + 20, z: 0.93 } },
    { t: DURATION, to: { x: W / 2, y: H / 2 + 20, z: 0.93 } },
  ];
  const resolved = new Map<Key, View>();
  const view = (k: Key) => {
    let v = resolved.get(k);
    if (!v) resolved.set(k, (v = typeof k.to === "function" ? k.to() : k.to));
    return v;
  };
  function camera(t: number): View {
    const i = CAMERA.findIndex((k) => k.t > t);
    if (i === -1) return view(CAMERA[CAMERA.length - 1]);
    const a = CAMERA[Math.max(0, i - 1)];
    const b = CAMERA[i];
    const p = easeInOut(clamp((t - a.t) / (b.t - a.t)));
    const va = view(a);
    if (p === 0) return va;
    const vb = view(b);
    return { x: lerp(va.x, vb.x, p), y: lerp(va.y, vb.y, p), z: lerp(va.z, vb.z, p) };
  }

  // The pointer: where it is at each key, eased between, pressing on the beats.
  type Aim = { t: number; to: () => Point | null };
  const AIM: Aim[] = [
    { t: open - 0.75, to: () => ({ x: W * 0.72, y: H + 40 }) },
    { t: open - 0.05, to: centre("picker") },
    { t: codex - 0.55, to: centre("picker") },
    { t: codex - 0.05, to: centre("codex") },
    { t: model - 0.5, to: centre("codex") },
    { t: model - 0.05, to: centre("astra") },
    { t: model + 0.25, to: centre("astra") },
    { t: model + 1.1, to: () => ({ x: W * 0.78, y: H + 60 }) },
  ];
  const PRESSES = [open, codex, model];
  const aimed = new Map<Aim, Point>();
  const aim = (k: Aim) => {
    let p = aimed.get(k);
    if (!p) aimed.set(k, (p = k.to() ?? { x: W / 2, y: H / 2 }));
    return p;
  };
  function pointer(t: number): Point | null {
    const i = AIM.findIndex((k) => k.t > t);
    if (i <= 0) return null;
    const pa = aim(AIM[i - 1]);
    const p = easeInOut(clamp((t - AIM[i - 1].t) / (AIM[i].t - AIM[i - 1].t)));
    if (p === 0) return pa;
    const pb = aim(AIM[i]);
    // A slight arc, as a hand moves.
    const arc = Math.sin(p * Math.PI) * Math.min(30, Math.hypot(pb.x - pa.x, pb.y - pa.y) * 0.12);
    return { x: lerp(pa.x, pb.x, p), y: lerp(pa.y, pb.y, p) - arc };
  }

  // ── a frame ─────────────────────────────────────────────────────────────────

  const ws = [...headline.querySelectorAll<HTMLElement>(".w")];
  const sub = headline.querySelector("p")!;

  /// Draws time `t`: the app's cues, then the camera, headline and pointer.
  function seek(t: number) {
    app.seek(t);

    // The window rises in as the headline leaves, and sinks back at the end.
    const enter = span(t, 1.2, 2.1, easeOut);
    const end = span(t, 13.2, 14.0);
    const v = camera(t);
    const cam = place({ ...v, z: v.z * lerp(0.84, 1, enter) });
    cam.ty += (1 - enter) * 80;
    frame.style.transform = `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.s})`;
    frame.style.opacity = String(enter * lerp(1, 0.3, end));
    frame.style.filter = end > 0 ? `blur(${end * 7}px)` : "";

    // Words rise in one after another; the opening set leaves upward.
    const late = t > 5;
    const out = span(t, 1.0, 1.45);
    ws.forEach((w, i) => {
      const from = (late ? 13.4 : 0.1) + i * 0.07;
      const p = span(t, from, from + 0.55, easeOut) * (late ? 1 : 1 - out);
      w.style.opacity = String(p);
      w.style.transform = `translateY(${(1 - p) * 22}px)`;
      w.style.filter = p < 1 ? `blur(${(1 - p) * 10}px)` : "";
    });
    const subIn = late ? span(t, 13.75, 14.3, easeOut) : span(t, 0.45, 0.95, easeOut) * (1 - out);
    sub.style.opacity = String(subIn);
    sub.style.transform = `translateY(${(1 - subIn) * 12}px)`;
    headline.style.transform = `translateY(${-out * 36}px)`;

    const p = pointer(t);
    cursor.style.display = p ? "" : "none";
    if (p) {
      const down = PRESSES.some((at) => t >= at - 0.06 && t < at + 0.08);
      const fade = Math.min(span(t, AIM[0].t, AIM[0].t + 0.2), 1 - span(t, model + 0.75, model + 1.1));
      cursor.style.opacity = String(fade);
      cursor.style.transform = `translate(${cam.tx + p.x * cam.s - 3}px, ${cam.ty + p.y * cam.s - 2}px) scale(${(down ? 0.8 : 1) * Math.sqrt(cam.s)})`;
      app.hover(p.x, p.y);
    }
  }

  (window as unknown as { __video: object }).__video = { ready: true, duration: DURATION, seek, pin: app.pin };
  seek(0);

  if (RENDER) return;
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;right:14px;bottom:12px;z-index:2;display:flex;gap:6px;font:600 12px system-ui";
  for (const k of Object.keys(COPY)) {
    const a = document.createElement("a");
    a.textContent = k.toUpperCase();
    a.title = COPY[k].head;
    a.href = `?copy=${k}`;
    const lit = k === key;
    a.style.cssText = `padding:5px 10px;border-radius:999px;text-decoration:none;color:${lit ? "#111" : "#fff"};background:${lit ? "#f5c518" : "rgba(255,255,255,.12)"}`;
    bar.append(a);
  }
  document.body.append(bar);
  // A slow frame plays slower rather than skipping ahead: cues fired in one
  // burst land before the app has drawn what the next one presses.
  let t = -0.3;
  let last = performance.now();
  const tick = (now: number) => {
    t += Math.min((now - last) / 1000, 1 / 30);
    last = now;
    if (t > DURATION + 1.2) return location.reload();
    seek(Math.max(0, t));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
