import { useEffect, useRef } from "react";

import type { RecorderState } from "@/hooks/useTranscription";
import { cn } from "@/lib/utils";

/// The Island's `prism` shader (apps/island/Island/VoiceOrb.metal), ported to
/// WebGL as it ships there: clear glass, the true rainbow. Coordinates are the
/// Metal ones — points, y down — so the small-orb tuning reads `size` the same.
/// `pow(q, 2.0)` became `q * q`, since GLSL leaves `pow` of a negative base undefined.
const FRAG = `
precision highp float;
uniform vec2 size;
uniform float dpr, t, level, energy, rec, spin, curl;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
float bump(float x, float c, float w) { float d = (x - c) / w; return clamp(1.0 - d * d, 0.0, 1.0); }
vec3 spectral(float x) {
  vec3 c = vec3(bump(x, 0.15, 0.32) + 0.35 * bump(x, 0.95, 0.12), bump(x, 0.42, 0.22), bump(x, 0.78, 0.25));
  return c * 0.85 + 0.12;
}

void main() {
  vec2 pos = vec2(gl_FragCoord.x, size.y * dpr - gl_FragCoord.y) / dpr;
  vec2 uv = (pos - size * 0.5) / (size.x * 0.5);
  float r = length(uv);
  float aa = 2.0 / size.x;
  float R = 0.95;
  float mask = 1.0 - smoothstep(R - aa * 2.0, R, r);
  if (mask <= 0.0) { gl_FragColor = vec4(0.0); return; }
  vec2 dir = r > 1e-4 ? uv / r : vec2(1, 0);

  float small = 1.0 - smoothstep(30.0, 46.0, size.x);
  vec3 body = vec3(0.03 + 0.07 * small * (1.0 - 0.4 * (uv.y + 1.0))) * (1.0 + 0.2 * rec);
  float rim = smoothstep(0.7 - 0.12 * small, R, r);
  body += rim * (0.06 + 0.28 * small) * mix(0.5 + clamp(dot(dir, normalize(vec2(0.6, 0.7))), 0.0, 1.0), 1.0, small);
  body += spectral(clamp((r - 0.8) / 0.14, 0.0, 1.0)) * rim * clamp(-dir.x * 1.2, 0.0, 1.0) * 0.45 * (1.0 - small);
  vec2 glint = uv - vec2(-0.42, -0.48);
  body += exp(-dot(glint, glint) / 0.018) * 0.7 * small;

  float bend = smoothstep(0.0, 1.0, curl);
  float ring = 0.78;
  vec2 p = rot(uv, -spin);
  float mid = mix(0.06, ring, bend);
  float x = p.x, d = p.y - mid;
  if (bend > 1e-3) {
    float rho = ring / bend;
    vec2 v = p - vec2(0.0, mid - rho);
    x = rho * atan(v.x, v.y);
    d = length(v) - rho;
  }
  float wave = ((0.06 + 0.1 * energy + 0.03 * level) * sin(x * 2.4 - t * 2.1)
             + (0.015 + 0.05 * energy) * sin(x * 4.1 - t * 3.0 + 1.0)) * (1.0 - 0.75 * bend);
  d -= wave;
  float width = (0.17 + 0.05 * energy + 0.02 * level) * (1.0 - 0.35 * bend) * (1.0 + 0.35 * small);
  float s = d / width;
  float q = (x + 0.08) / (0.42 + 0.12 * energy);
  float along = exp(-q * q);
  float shimmer = 0.8 + 0.4 * noise(vec2(x * 4.0 + t * 0.6, t * 0.3));
  float comet = mix(1.0, 0.35 + 1.1 * smoothstep(0.7, -0.5, x), bend);
  float power = (0.6 + 0.25 * rec + 0.4 * energy + 0.25 * level + 0.3 * bend) * shimmer * comet * (1.0 + 0.15 * small);

  vec3 hues = spectral(clamp(0.45 + s * 0.42, 0.0, 1.0));
  hues = mix(hues, clamp(hues * 1.35 - 0.18, 0.0, 1.0), small);
  vec3 light = hues * exp(-s * s * 1.3) * along * 1.3;
  vec2 warm = vec2(x + 0.06, d + 0.15);
  light += vec3(1.0, 0.7, 0.3) * exp(-dot(warm, warm) / 0.08) * (1.0 - 0.8 * bend) * (1.0 - 0.5 * small);
  float fw = max(0.022, aa * 0.9);
  float fy = d - 0.05 - 0.04 * sin(x * 3.2 + 0.8 - t * 2.1) * (1.0 - 0.75 * bend);
  float reach = smoothstep(-0.6, -0.25, x) * smoothstep(0.75, 0.35, x);
  light += vec3(1.0, 0.98, 0.95) * exp(-fy * fy / (fw * fw)) * reach * 1.4 * (1.0 - 0.45 * small);
  float b = (d - 0.2) / 0.12;
  light += vec3(0.35, 0.4, 1.0) * exp(-b * b) * along * 0.35;

  gl_FragColor = vec4(clamp(body + light * power, 0.0, 1.0) * mask, mask);
}`;

const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";

/// A raw sample peak as 0…1 on a decibel scale, as the Island reads it: a quiet
/// room (−50 dBFS) is nothing and ordinary speech fills most of the range.
const loudness = (peak: number) =>
  Math.min(1, Math.max(0, (20 * Math.log10(Math.max(peak, 1e-6)) + 50) / 32));

/// The dictation orb the Island and the iPhone draw: a band of split light in
/// dark glass that swells with the voice, and curls into an orbiting arc while
/// transcribing. Idle, it drifts for a few seconds and then holds still, so a
/// resting composer draws nothing per frame.
export default function VoiceOrb({
  size,
  level,
  state,
  className,
}: {
  size: number;
  /// The recorder's raw peak, 0–1.
  level: number;
  state: RecorderState;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const input = useRef({ level, state });
  input.current = { level, state };
  // Kept across state changes, so a new state eases from where the orb is.
  const orb = useRef({ t: 0, spin: 0, curl: 0, level: 0, energy: 0, rec: 0, work: 0 });
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    const el = canvas.current;
    const gl = el?.getContext("webgl", { premultipliedAlpha: true, antialias: false });
    if (!el || !gl) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = el.height = Math.round(size * dpr);
    gl.viewport(0, 0, el.width, el.height);

    const program = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    // WebKit numbers attributes its own way, so location 0 is asked for, not assumed.
    gl.bindAttribLocation(program, 0, "a");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.warn("voice orb:", gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform2f(u("size"), size, size);
    gl.uniform1f(u("dpr"), dpr);
    const names = ["t", "level", "energy", "rec", "spin", "curl"] as const;
    const loc = Object.fromEntries(names.map((n) => [n, u(n)]));

    let raf = 0;
    let last = 0;
    let idleSince = 0;
    const frame = (now: number) => {
      const o = orb.current;
      const { state, level } = input.current;
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      const ease = (from: number, to: number, tau: number) => from + (to - from) * (1 - Math.exp(-dt / tau));
      const voice = state === "recording" ? loudness(level) : 0;
      const working = state === "transcribing";
      // The Island's springs, as time constants: the voice now, how much it has said lately, and the two states.
      o.level = ease(o.level, voice, 0.05);
      o.energy = ease(o.energy, voice, 0.3);
      o.rec = ease(o.rec, state === "recording" ? 1 : 0, 0.15);
      o.work = ease(o.work, working ? 1 : 0, 0.15);
      o.t = (o.t + dt * (0.35 + 0.8 * o.rec + 0.6 * o.work + 0.3 * o.energy)) % 3600;
      // OrbClock: the orbit finishes its lap home before the band uncurls.
      const winding = !working && o.spin > 0;
      o.curl = ease(o.curl, working || winding ? 1 : 0, 0.15);
      if (working) o.spin += dt * 2.6 * o.curl;
      else if (winding) {
        const home = Math.ceil(o.spin / (2 * Math.PI)) * 2 * Math.PI;
        o.spin = Math.min(home, o.spin + dt * Math.max(4, 8 * (home - o.spin)));
        if (o.spin >= home - 0.002) o.spin = 0;
      }

      gl.uniform1f(loc.t, o.t);
      gl.uniform1f(loc.level, o.level);
      gl.uniform1f(loc.energy, o.energy);
      gl.uniform1f(loc.rec, o.rec);
      gl.uniform1f(loc.spin, o.spin % (2 * Math.PI));
      gl.uniform1f(loc.curl, o.curl);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (state !== "idle") idleSince = now;
      else if (!idleSince) idleSince = now;
      // Idle long enough that the orbit is home and every value settled: stop drawing.
      if (state === "idle" && now - idleSince > 3000 && o.spin === 0) {
        raf = 0;
        last = 0;
        idleSince = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    // The first frame drawn at once, so the orb is never a blank circle while a frame is awaited.
    wake.current = () => {
      if (!raf) frame(performance.now());
    };
    wake.current();
    // No `loseContext()` here: a canvas has one context for life, and a remount
    // on the same element (StrictMode's, or a resize) would get it back lost.
    return () => {
      cancelAnimationFrame(raf);
      wake.current = () => {};
      gl.deleteProgram(program);
    };
  }, [size]);

  useEffect(() => wake.current(), [state]);

  return (
    <canvas
      ref={canvas}
      aria-hidden
      style={{ width: size, height: size }}
      className={cn("shrink-0 rounded-full", className)}
    />
  );
}
