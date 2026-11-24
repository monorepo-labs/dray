// Renders each headline variant to out/harness-switch-<v>.mp4, frame by frame:
// seek the page to t, screenshot, pipe the PNG to ffmpeg. Usage: node render.mjs [a b c]
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const FPS = 60;
const DUR = 15;
const STILLS = [1.0, 4.5, 6.0, 7.9, 8.5, 8.8, 10.8, 14.5];
const root = new URL(".", import.meta.url).pathname;
const out = `${root}out`;
mkdirSync(`${out}/stills`, { recursive: true });

const variants = process.argv.slice(2).length ? process.argv.slice(2) : ["a", "b", "c"];
const server = await createServer({ root, logLevel: "error", server: { port: 0, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

for (const v of variants) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`${url}?render&v=${v}`);
  await page.waitForFunction(() => window.__ready === true);
  const cdp = await page.context().newCDPSession(page);
  const file = `${out}/harness-switch-${v}.mp4`;
  const ff = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-profile:v", "high",
      "-movflags", "+faststart", "-an", file],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const frames = DUR * FPS;
  const stillFrames = new Set(STILLS.map((s) => Math.round(s * FPS)));
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.__seek(t), f / FPS);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
    const png = Buffer.from(data, "base64");
    if (stillFrames.has(f)) writeFileSync(`${out}/stills/${v}-${(f / FPS).toFixed(1)}s.png`, png);
    if (!ff.stdin.write(png)) await once(ff.stdin, "drain");
    if (f % 120 === 0) process.stdout.write(`${v}: ${f}/${frames}\n`);
  }
  ff.stdin.end();
  const [code] = await once(ff, "close");
  if (code !== 0) throw new Error(`ffmpeg exited ${code} on ${v}`);
  console.log(`wrote ${file}`);
  await page.close();
}

await browser.close();
await server.close();
