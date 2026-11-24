// Renders demo/harness-switch-video.html to a 1920×1080 60fps H.264 MP4, one
// frame at a time on a fake clock, so every render is the same.
//
//   node scripts/render-harness-video.mjs <page url> <out.mp4> [copy] [--stills t1,t2,…] [--only]
//
// `--stills` also saves those moments as PNGs beside the MP4; `--only` saves
// just them, which is the quick way to check a change.
//
// Wants the dev server up (`pnpm dev`), ffmpeg on PATH and Playwright's
// Chromium (`pnpm exec playwright-core install chromium`).

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const [base, out = "harness-switch.mp4", copy = "a", ...rest] = process.argv.slice(2);
const stills = (rest[rest.indexOf("--stills") + 1] ?? "").split(",").filter(Boolean).map(Number);
const only = rest.includes("--only");
const FPS = 60;

const browser = await chromium.launch();
// 1440×810 at 4/3 is 1920×1080: the app draws a third larger than on a laptop.
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "dark" });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.clock.install({ time: new Date("2026-11-24T14:05:00") });
await page.goto(`${base}?render&copy=${copy}`);
await page.waitForFunction(() => window.__video?.ready, null, { timeout: 60_000 });
await page.clock.pauseAt(new Date("2026-11-24T14:06:00"));
const duration = await page.evaluate(() => window.__video.duration);

const ffmpeg = only ? null : spawn(
  "ffmpeg",
  ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
   "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-profile:v", "high",
   "-movflags", "+faststart", "-an", out],
  { stdio: ["pipe", "inherit", "inherit"] },
);

const frames = Math.round(duration * FPS);
let clock = 0;
for (let i = 0; i < frames; i++) {
  const t = i / FPS;
  const ms = Math.round(t * 1000);
  await page.evaluate((t) => window.__video.seek(t), t);
  if (ms > clock) await page.clock.runFor(ms - clock);
  clock = ms;
  // React commits on a MessageChannel, which the fake clock leaves alone.
  await page.evaluate(async (t) => {
    for (let n = 0; n < 4; n++) await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
    window.__video.pin(t);
  }, t);
  const still = stills.some((s) => Math.round(s * FPS) === i);
  if (only && !still) continue;
  const png = await page.screenshot({ type: "png" });
  if (still) await writeFile(out.replace(/\.mp4$/, `-${t.toFixed(2)}s.png`), png);
  if (ffmpeg && !ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  if (i % 60 === 0) process.stdout.write(`\r${i}/${frames}`);
}
if (ffmpeg) {
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on("close", r));
}
await browser.close();
console.log(`\n${out}`);
