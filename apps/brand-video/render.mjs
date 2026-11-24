// Renders out/harness-switch.mp4 frame by frame: seek the page to t,
// screenshot, pipe the PNG to ffmpeg. Stills land in out/stills/.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const FPS = 60;
const DUR = 15;
const STILLS = [3.8, 5.5, 8.2, 8.95, 11.9, 14.5];
const root = new URL(".", import.meta.url).pathname;
const out = `${root}out`;
mkdirSync(`${out}/stills`, { recursive: true });

const server = await createServer({ root, logLevel: "error", server: { port: 0, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`${server.resolvedUrls.local[0]}?render`);
await page.waitForFunction(() => window.__ready === true);
const cdp = await page.context().newCDPSession(page);

const file = `${out}/harness-switch.mp4`;
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
  if (stillFrames.has(f)) writeFileSync(`${out}/stills/${(f / FPS).toFixed(1)}s.png`, png);
  if (!ff.stdin.write(png)) await once(ff.stdin, "drain");
  if (f % 120 === 0) process.stdout.write(`${f}/${frames}\n`);
}
ff.stdin.end();
const [code] = await once(ff, "close");
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
console.log(`wrote ${file}`);

await browser.close();
await server.close();
