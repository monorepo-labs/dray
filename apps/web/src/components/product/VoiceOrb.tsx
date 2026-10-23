"use client";

import { useEffect, useRef } from "react";

export type OrbState = "idle" | "recording" | "transcribing";

/// Island's voice orb: the `prism` shader from apps/island/Island/VoiceOrb.metal,
/// ported line for line and run per pixel on a canvas. Clear glass (`milk` 0)
/// split into the true rainbow (`prismatic` 1), which is what ships. At 24px
/// that is ~2300 pixels a frame, so a shader port is cheaper than faking it.
///
/// The voice is simulated: while recording, a noise-driven level swells the
/// band the way speech does. `running` false freezes the last frame.
export function VoiceOrb({
  size = 24,
  state = "idle",
  running = true,
  className,
}: {
  size?: number;
  state?: OrbState;
  running?: boolean;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const px = Math.round(size * Math.min(2, window.devicePixelRatio || 1));
    el.width = px;
    el.height = px;
    const img = ctx.createImageData(px, px);
    const clock = { phase: 1.3, spin: 0, curl: 0, level: 0, energy: 0, rec: 0, work: 0, last: 0 };

    let raf = 0;
    let live = running;
    const frame = (now: number) => {
      const dt = clock.last ? Math.min((now - clock.last) / 1000, 0.1) : 0;
      clock.last = now;
      const s = stateRef.current;
      const recording = s === "recording";
      const working = s === "transcribing";
      // Speech, roughly: syllables on a fast noise, phrases on a slow one.
      const voice = recording
        ? Math.max(0, noise(now / 140, 3.1) * 0.9 * (0.4 + 0.8 * noise(now / 900, 7.7)) - 0.08)
        : 0;
      clock.level += (voice - clock.level) * (1 - Math.exp(-dt / 0.06));
      clock.energy += (voice - clock.energy) * (1 - Math.exp(-dt / 0.5));
      clock.rec += ((recording ? 1 : 0) - clock.rec) * (1 - Math.exp(-dt / 0.2));
      clock.work += ((working ? 1 : 0) - clock.work) * (1 - Math.exp(-dt / 0.2));
      clock.phase += dt * (0.35 + 0.8 * clock.rec + 0.6 * clock.work + 0.3 * clock.energy);
      // OrbClock.advance: curl in while working, finish the lap, then uncurl.
      const winding = !working && clock.spin > 0;
      clock.curl += ((working || winding ? 1 : 0) - clock.curl) * (1 - Math.exp(-dt / 0.15));
      if (working) clock.spin += dt * 2.6 * clock.curl;
      else if (winding) {
        const home = Math.ceil(clock.spin / (2 * Math.PI)) * 2 * Math.PI;
        clock.spin = Math.min(home, clock.spin + dt * Math.max(4, 8 * (home - clock.spin)));
        if (clock.spin >= home - 0.002) clock.spin = 0;
      }
      draw(img.data, px, size, clock.phase, clock.level, clock.energy, clock.rec, clock.spin % (2 * Math.PI), clock.curl);
      ctx.putImageData(img, 0, 0);
      if (live) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [size, running]);

  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={className}
      style={{ width: size, height: size, display: "block" }}
    />
  );
}

function draw(
  out: Uint8ClampedArray,
  px: number,
  pt: number,
  t: number,
  level: number,
  energy: number,
  rec: number,
  spin: number,
  curl: number,
) {
  const R = 0.95;
  const aa = 2 / px;
  // Every size term in the shader reads the view's size in points.
  const small = 1 - smoothstep(30, 46, pt);
  const bend = smoothstep(0, 1, curl);
  const ring = 0.78;
  const mid = mix(0.06, ring, bend);
  const cs = Math.cos(-spin), sn = Math.sin(-spin);
  const rim0 = 0.7 - 0.12 * small;
  const ldx = 0.6 / Math.hypot(0.6, 0.7), ldy = 0.7 / Math.hypot(0.6, 0.7);
  const warmTint = [1, 0.7, 0.3];
  const fw = Math.max(0.022, aa * 0.9);
  const hue = [0, 0, 0];

  for (let j = 0; j < px; j++) {
    for (let i = 0; i < px; i++) {
      const o = (j * px + i) * 4;
      const ux = (i + 0.5 - px / 2) / (px / 2);
      const uy = (j + 0.5 - px / 2) / (px / 2);
      const r = Math.hypot(ux, uy);
      const mask = 1 - smoothstep(R - aa * 2, R, r);
      if (mask <= 0) {
        out[o + 3] = 0;
        continue;
      }
      const dx = r > 1e-4 ? ux / r : 1, dy = r > 1e-4 ? uy / r : 0;

      const lift = 0.03 + 0.07 * small * (1 - 0.4 * (uy + 1));
      let br = lift * (1 + 0.2 * rec), bg = br, bb = br;
      const rim = smoothstep(rim0, R, r);
      const rimLight = rim * (0.06 + 0.28 * small) * mix(0.5 + clamp01(dx * ldx + dy * ldy), 1, small);
      br += rimLight; bg += rimLight; bb += rimLight;
      if (small < 1) {
        spectral(clamp01((r - 0.8) / 0.14), hue);
        const k = rim * clamp01(-dx * 1.2) * 0.45 * (1 - small);
        br += hue[0] * k; bg += hue[1] * k; bb += hue[2] * k;
      }
      const gx = ux + 0.42, gy = uy + 0.48;
      const glint = Math.exp(-(gx * gx + gy * gy) / 0.018) * 0.7 * small;
      br += glint; bg += glint; bb += glint;

      // The band's own coordinates: x along it, d across it.
      const px2 = cs * ux - sn * uy, py2 = sn * ux + cs * uy;
      let x = px2, d = py2 - mid;
      if (bend > 1e-3) {
        const rho = ring / bend;
        const vx = px2, vy = py2 - (mid - rho);
        x = rho * Math.atan2(vx, vy);
        d = Math.hypot(vx, vy) - rho;
      }
      const wave =
        ((0.06 + 0.1 * energy + 0.03 * level) * Math.sin(x * 2.4 - t * 2.1) +
          (0.015 + 0.05 * energy) * Math.sin(x * 4.1 - t * 3.0 + 1.0)) *
        (1 - 0.75 * bend);
      d -= wave;
      const width = (0.17 + 0.05 * energy + 0.02 * level) * (1 - 0.35 * bend) * (1 + 0.35 * small);
      const s = d / width;
      const al = (x + 0.08) / (0.42 + 0.12 * energy);
      const along = Math.exp(-al * al);
      const shimmer = 0.8 + 0.4 * noise(x * 4 + t * 0.6, t * 0.3);
      const comet = mix(1, 0.35 + 1.1 * smoothstep(0.7, -0.5, x), bend);
      const power = (0.6 + 0.25 * rec + 0.4 * energy + 0.25 * level + 0.3 * bend) * shimmer * comet * (1 + 0.15 * small);

      spectral(clamp01(0.45 + s * 0.42), hue);
      let hr = hue[0], hg = hue[1], hb = hue[2];
      hr = mix(hr, clamp01(hr * 1.35 - 0.18), small);
      hg = mix(hg, clamp01(hg * 1.35 - 0.18), small);
      hb = mix(hb, clamp01(hb * 1.35 - 0.18), small);
      const core = Math.exp(-s * s * 1.3) * along * 1.3;
      let lr = hr * core, lg = hg * core, lb = hb * core;
      const wx = x + 0.06, wy = d + 0.15;
      const warm = Math.exp(-(wx * wx + wy * wy) / 0.08) * (1 - 0.8 * bend) * (1 - 0.5 * small);
      lr += warmTint[0] * warm; lg += warmTint[1] * warm; lb += warmTint[2] * warm;
      const fy = d - 0.05 - 0.04 * Math.sin(x * 3.2 + 0.8 - t * 2.1) * (1 - 0.75 * bend);
      const reach = smoothstep(-0.6, -0.25, x) * smoothstep(0.75, 0.35, x);
      const fil = Math.exp(-(fy * fy) / (fw * fw)) * reach * 1.4 * (1 - 0.45 * small);
      lr += fil; lg += fil * 0.98; lb += fil * 0.95;
      const lo = (d - 0.2) / 0.12;
      const low = Math.exp(-lo * lo) * along * 0.35;
      lr += 0.35 * low; lg += 0.4 * low; lb += 1.0 * low;

      out[o] = clamp01(br + lr * power) * mask * 255;
      out[o + 1] = clamp01(bg + lg * power) * mask * 255;
      out[o + 2] = clamp01(bb + lb * power) * mask * 255;
      out[o + 3] = mask * 255;
    }
  }
}

// ImageData is not premultiplied, so the colour above is written straight and
// the alpha carries the edge.
function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function mix(a: number, b: number, k: number) {
  return a + (b - a) * k;
}
function smoothstep(e0: number, e1: number, x: number) {
  const k = clamp01((x - e0) / (e1 - e0));
  return k * k * (3 - 2 * k);
}
function bump(x: number, c: number, w: number) {
  const d = (x - c) / w;
  return clamp01(1 - d * d);
}
/// Light split by a prism, red at 0 to violet at 1.
function spectral(x: number, out: number[]) {
  out[0] = (bump(x, 0.15, 0.32) + 0.35 * bump(x, 0.95, 0.12)) * 0.85 + 0.12;
  out[1] = bump(x, 0.42, 0.22) * 0.85 + 0.12;
  out[2] = bump(x, 0.78, 0.25) * 0.85 + 0.12;
}
function fract(x: number) {
  return x - Math.floor(x);
}
function hash21(x: number, y: number) {
  x = fract(x * 123.34);
  y = fract(y * 456.21);
  const k = x * (x + 45.32) + y * (y + 45.32);
  x += k;
  y += k;
  return fract(x * y);
}
function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash21(ix, iy), hash21(ix + 1, iy), ux), mix(hash21(ix, iy + 1), hash21(ix + 1, iy + 1), ux), uy);
}
