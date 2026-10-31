"use client";

import { useEffect, useRef, useState } from "react";

// Room around the orb for its drop shadow.
const M = 24;

const VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

// apps/island/Island/VoiceOrb.h with LensOrb.metal's `lens`, line for line, except
// the backdrop: every card behind an orb is one flat fill, so the refracted sample
// is that colour and no texture is needed. `spin` and `curl` belong to the
// transcribing orbit, which the site never shows; they stay at GL's default 0.
const FS = `precision highp float;
uniform vec2 res; uniform float dpr, M, size, t, level, energy, rec, spin, curl, has;
uniform vec3 bg;
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y); }
vec2 rot(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
float bump(float x, float c, float w){ float d = (x - c) / w; return clamp(1. - d * d, 0., 1.); }
vec3 spectral(float x){ vec3 c = vec3(bump(x, .15, .32) + .35 * bump(x, .95, .12), bump(x, .42, .22), bump(x, .78, .25)); return c * .85 + .12; }
void main(){
  vec2 pos = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) / dpr - M;
  vec2 uv = (pos - size * .5) / (size * .5);
  float r = length(uv); float aa = 2. / size;
  float R = .95;
  float mask = 1. - smoothstep(R - aa * 2., R, r);
  if (mask <= 0.) { gl_FragColor = vec4(0); return; }
  vec2 dir = r > 1e-4 ? uv / r : vec2(1, 0);
  vec2 sp = uv / R;
  float z = sqrt(clamp(1. - dot(sp, sp), 0., 1.));
  vec3 seen = bg;
  float fresnel = .04 + .96 * pow(1. - z, 5.);
  float bend = smoothstep(0., 1., curl);
  float ring = .78;
  vec2 p = rot(uv, -spin);
  float mid = mix(.06, ring, bend);
  float x = p.x, d = p.y - mid;
  if (bend > 1e-3) { float rho = ring / bend; vec2 v = p - vec2(0., mid - rho); x = rho * atan(v.x, v.y); d = length(v) - rho; }
  float wave = ((.06 + .1 * energy + .03 * level) * sin(x * 2.4 - t * 2.1) + (.015 + .05 * energy) * sin(x * 4.1 - t * 3. + 1.)) * (1. - .75 * bend);
  d -= wave;
  float shade = mix(.42, .78, smoothstep(0., .75, d)) * (1. - .3 * smoothstep(.55, .9, r / R));
  vec3 glass = mix(seen * shade, vec3(.92, .95, 1.), fresnel * .4);
  float lens = has * smoothstep(-.02, .06, d);
  vec3 body = mix(vec3(.03), glass, lens) * (1. + .2 * rec);
  float rim = smoothstep(.7, R, r);
  body += rim * .06 * (.5 + clamp(dot(dir, normalize(vec2(.6, .7))), 0., 1.));
  body += spectral(clamp((r - .8) / .14, 0., 1.)) * rim * clamp(-dir.x * 1.2, 0., 1.) * .45;
  float width = (.17 + .05 * energy + .02 * level) * (1. - .35 * bend);
  float s = d / width;
  float a = (x + .08) / (.42 + .12 * energy);
  float along = exp(-a * a);
  float shimmer = .8 + .4 * noise(vec2(x * 4. + t * .6, t * .3));
  float comet = mix(1., .35 + 1.1 * (1. - smoothstep(-.5, .7, x)), bend);
  float power = (.6 + .25 * rec + .4 * energy + .25 * level + .3 * bend) * shimmer * comet;
  vec3 hues = spectral(clamp(.45 + s * .42, 0., 1.));
  vec3 light = hues * exp(-s * s * 1.3) * along * 1.3;
  vec2 warm = vec2(x + .06, d + .15);
  light += vec3(1., .7, .3) * exp(-dot(warm, warm) / .08) * (1. - .8 * bend);
  float fw = max(.022, aa * .9);
  float fy = d - .05 - .04 * sin(x * 3.2 + .8 - t * 2.1) * (1. - .75 * bend);
  float reach = smoothstep(-.6, -.25, x) * (1. - smoothstep(.35, .75, x));
  light += vec3(1., .98, .95) * exp(-fy * fy / (fw * fw)) * reach * 1.4;
  float b = (d - .2) / .12;
  light += vec3(.35, .4, 1.) * exp(-b * b) * along * .35;
  gl_FragColor = vec4(clamp(body + light * power, 0., 1.) * mask, mask);
}`;

/// A made-up voice: syllables in phrases, with breaths between.
const voice = (s: number) =>
  (Math.sin(s * 0.9) * 0.5 + 0.5 > 0.25 ? 1 : 0) * Math.max(0, 0.55 + 0.35 * Math.sin(s * 9.1) * Math.sin(s * 3.7 + 1));

/// Compiles and links the orb's program, or null where the GPU refuses it.
function program(gl: WebGLRenderingContext) {
  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VS],
    [gl.FRAGMENT_SHADER, FS],
  ] as const) {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

/// The island's voice orb in live WebGL, over a flat `backdrop` the size of a card fill.
export function IslandOrb({
  size,
  mode = "recording",
  backdrop = "#1A1A1A",
  className = "relative",
}: {
  size: number;
  mode?: "recording" | "idle";
  backdrop?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // The canvas is made here rather than rendered: a context lost on cleanup
    // stays lost on that element, so Strict Mode's second run needs a new one.
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl", { alpha: true, premultipliedAlpha: true });
    const prog = gl && program(gl);
    if (!gl || !prog) {
      setFailed(true);
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = size + 2 * M;
    cv.width = Math.round(box * dpr);
    cv.height = Math.round(box * dpr);
    Object.assign(cv.style, {
      position: "absolute",
      left: `${-M}px`,
      top: `${-M}px`,
      width: `${box}px`,
      height: `${box}px`,
      filter: "drop-shadow(0 8px 12px rgba(0,0,0,.3))",
    });
    host.current?.appendChild(cv);

    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const rec = mode === "recording" ? 1 : 0;
    const hex = parseInt(backdrop.slice(1, 7), 16);
    gl.uniform2f(U("res"), cv.width, cv.height);
    gl.uniform1f(U("dpr"), cv.width / box);
    gl.uniform1f(U("M"), M);
    gl.uniform1f(U("size"), size);
    gl.uniform1f(U("rec"), rec);
    gl.uniform1f(U("has"), rec);
    gl.uniform3f(U("bg"), ((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
    const uT = U("t"), uLevel = U("level"), uEnergy = U("energy");

    let phase = 0, level = 0, energy = 0, last: number | null = null, raf = 0;
    const draw = () => {
      gl.uniform1f(uT, phase % 3600);
      gl.uniform1f(uLevel, level);
      gl.uniform1f(uEnergy, energy);
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    // VoiceOrb.swift's driver: level eases fast, energy slow, and the phase
    // runs at a rate rather than off the clock so a speed change never jumps.
    const frame = (ms: number) => {
      const now = ms / 1000;
      const dt = last == null ? 0 : Math.min(now - last, 0.1);
      last = now;
      const v = rec ? voice(now) : 0;
      level += (v - level) * (1 - Math.exp(-dt / 0.05));
      energy += (v - energy) * (1 - Math.exp(-dt / 0.35));
      phase += dt * (0.35 + 0.8 * rec + 0.3 * energy);
      draw();
      raf = requestAnimationFrame(frame);
    };

    let visible = false;
    const sync = () => {
      cancelAnimationFrame(raf);
      last = null;
      if (visible && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    const lost = () => {
      cancelAnimationFrame(raf);
      setFailed(true);
    };
    cv.addEventListener("webglcontextlost", lost);

    // The standalone page's `?t=2` still, drawn at once so the orb is there
    // before the first animation frame, and is all reduced motion ever sees.
    level = 0.7 * rec;
    energy = 0.55 * rec;
    phase = 2 * (rec ? 1.3 : 0.35);
    draw();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      io.observe(cv);
      document.addEventListener("visibilitychange", sync);
    }

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      cv.removeEventListener("webglcontextlost", lost);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      cv.remove();
    };
  }, [size, mode, backdrop]);

  return (
    <div
      ref={host}
      aria-hidden="true"
      className={`shrink-0 rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: failed
          ? "radial-gradient(circle at 45% 40%, rgba(255,190,110,.55), rgba(90,100,255,.25) 38%, #080808 62%)"
          : undefined,
      }}
    />
  );
}
