"use client";

import { useEffect, useRef } from "react";

const PITCH = 6;
const GAP = 12;
const INK = "#0000001F";
const TICK = 1000 / 60;
// Wave speed², spring back to straight, and damping per tick.
const C2 = 0.3;
const K = 0.004;
const DAMP = 0.98;

/// The stripes as strings of nodes 12px apart. Crossing one plucks it where
/// the pointer crossed, and the wave runs up and down it until it settles.
function strings(w: number, h: number) {
  const xs: number[] = [];
  for (let x = 1; x < w; x += PITCH) xs.push(x);
  const n = Math.ceil(h / GAP) + 1;
  const u = xs.map(() => new Float32Array(n));
  const v = xs.map(() => new Float32Array(n));
  const live = new Set<number>();
  let last: { x: number; y: number } | null = null;

  return {
    move(x: number, y: number) {
      if (last && x !== last.x) {
        const from = last;
        const lo = Math.min(from.x, x);
        const hi = Math.max(from.x, x);
        const force = Math.sign(x - from.x) * Math.min(hi - lo, 40) * 0.35;
        for (let i = Math.max(0, Math.ceil((lo - 1) / PITCH)); i < xs.length && xs[i] <= hi; i++) {
          const at = from.y + ((y - from.y) * (xs[i] - from.x)) / (x - from.x);
          for (let j = 1; j < n - 1; j++) {
            const g = Math.exp(-((j * GAP - at) ** 2) / 1152);
            if (g > 0.01) v[i][j] += force * g;
          }
          live.add(i);
        }
      }
      last = { x, y };
    },
    leave() {
      last = null;
    },
    /** Advances one 60 Hz tick; false once every string is still. */
    step() {
      for (const i of live) {
        const ui = u[i];
        const vi = v[i];
        let energy = 0;
        for (let j = 1; j < n - 1; j++) vi[j] = (vi[j] + C2 * (ui[j - 1] + ui[j + 1] - 2 * ui[j]) - K * ui[j]) * DAMP;
        for (let j = 1; j < n - 1; j++) {
          ui[j] = Math.max(-28, Math.min(28, ui[j] + vi[j]));
          energy = Math.max(energy, Math.abs(ui[j]) + Math.abs(vi[j]));
        }
        if (energy < 0.05) {
          ui.fill(0);
          vi.fill(0);
          live.delete(i);
        }
      }
      return live.size > 0;
    },
    draw(ctx: CanvasRenderingContext2D) {
      ctx.beginPath();
      xs.forEach((x0, i) => {
        ctx.moveTo(x0, 0);
        if (!live.has(i)) return ctx.lineTo(x0, h);
        for (let j = 1; j < n; j++) ctx.lineTo(x0 + u[i][j], Math.min(j * GAP, h));
      });
      ctx.stroke();
    },
  };
}

/// The band's 2px stripes every 6px, on a canvas so the pointer can pluck them.
/// Listens on the parent, since the canvas sits under the band's content.
export function Stripes() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    const host = cv?.parentElement;
    const ctx = cv?.getContext("2d");
    if (!cv || !host || !ctx) return;

    let w = 0;
    let h = 0;
    let sim = strings(0, 0);
    let raf = 0;
    let last = 0;
    let acc = 0;

    const paint = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      sim.draw(ctx);
    };
    // Steps in fixed ticks, so the strings ring at one speed on 60 and 120 Hz.
    const loop = (now: number) => {
      acc += now - last;
      last = now;
      let moving = true;
      if (acc >= TICK) {
        moving = false;
        for (let n = 0; acc >= TICK && n < 4; n++, acc -= TICK) moving = sim.step() || moving;
        acc %= TICK;
        paint();
      }
      raf = moving ? requestAnimationFrame(loop) : 0;
    };
    const wake = () => {
      if (raf) return;
      last = performance.now();
      acc = TICK;
      raf = requestAnimationFrame(loop);
    };

    const size = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = host.clientWidth;
      h = host.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sim = strings(w, h);
      paint();
    };
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      sim.move(e.clientX - r.left, e.clientY - r.top);
      wake();
    };
    const leave = () => sim.leave();

    const ro = new ResizeObserver(size);
    ro.observe(host);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      host.addEventListener("pointermove", move);
      host.addEventListener("pointerleave", leave);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);

  return <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 size-full" />;
}
