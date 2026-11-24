import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./style.css";
import { DUR, FPS, H, mount, W } from "./scene.js";

const q = new URLSearchParams(location.search);
const stage = document.getElementById("stage");
const viewport = document.getElementById("viewport");

await Promise.all(
  ['350 100px "Inter Variable"', '400 20px "Geist Variable"', '400 20px "Geist Mono Variable"'].map((f) => document.fonts.load(f)),
);
// Mounted after the fonts, since the chat's item heights are measured off them.
const scene = mount(stage);

if (q.has("render")) {
  // render.mjs drives frames itself; nothing here moves on its own.
  document.body.classList.add("render");
  viewport.style.width = `${W}px`;
  viewport.style.height = `${H}px`;
  window.__seek = (t) => scene.render(t);
  window.__ready = true;
} else {
  const range = document.getElementById("scrub");
  const time = document.getElementById("time");
  const play = document.getElementById("play");
  range.max = String(DUR * FPS - 1);
  let t = Number(q.get("t") ?? 0);
  let playing = !q.has("t");
  let last = performance.now();

  const fit = () => {
    const s = Math.min((innerWidth - 32) / W, (innerHeight - 120) / H);
    stage.style.transform = `scale(${s})`;
    viewport.style.width = `${W * s}px`;
    viewport.style.height = `${H * s}px`;
  };
  addEventListener("resize", fit);
  fit();

  play.onclick = () => (playing = !playing);
  range.oninput = () => {
    playing = false;
    t = Number(range.value) / FPS;
  };
  addEventListener("keydown", (e) => {
    if (e.key === " ") (playing = !playing), e.preventDefault();
    if (e.key === "ArrowRight") (playing = false), (t = Math.min(DUR, t + 1 / FPS));
    if (e.key === "ArrowLeft") (playing = false), (t = Math.max(0, t - 1 / FPS));
  });

  const loop = (now) => {
    if (playing) t = (t + (now - last) / 1000) % DUR;
    last = now;
    scene.render(t);
    range.value = String(Math.round(t * FPS));
    time.textContent = `${t.toFixed(2)}s  f${Math.round(t * FPS)}`;
    play.textContent = playing ? "Pause" : "Play";
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
