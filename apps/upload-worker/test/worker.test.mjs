import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

/// The upload Worker (#1479) under a real `wrangler dev`: local R2 and Durable
/// Objects, GitHub's `/user` faked. What landed in the bucket is read back
/// through wrangler's local explorer API.

const MB = 1024 * 1024;
const PUBLIC_URL = "https://img.test";
const BUCKET = "dray-uploads";

async function freePort() {
  const server = createNetServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/// GitHub's `GET /user`: each token in `users` is that user, anything else is
/// refused. Every Authorization header it saw lands in `seen`.
async function fakeGithub(users) {
  const seen = [];
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    seen.push(auth);
    const user = req.url === "/user" && users[auth.replace(/^Bearer /, "")];
    res.writeHead(user ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(user ?? { message: "Bad credentials" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/// `wrangler dev` with `vars` over the config's, state in a fresh directory.
async function wranglerDev(vars) {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "dray-upload-worker-"));
  const flags = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const child = spawn(
    "node_modules/.bin/wrangler",
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state, "--show-interactive-dev-session=false", ...flags],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    const exited = new Promise((r) => child.once("exit", r));
    process.kill(-child.pid, "SIGTERM");
    await exited;
    rmSync(state, { recursive: true, force: true });
  };
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    if (log.includes("Ready on")) {
      try {
        await fetch(`${base}/`, { redirect: "manual" });
        return { base, log: () => log, stop };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`wrangler dev never answered:\n${log}`);
}

const png = (tail) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);
const mp4 = (size) => {
  const b = Buffer.alloc(size);
  Buffer.from([0, 0, 0, 0x20, ...Buffer.from("ftypisom")]).copy(b);
  for (let i = 12; i < size; i += 4096) b[i] = i % 251;
  return b;
};
const sha = (b) => createHash("sha256").update(b).digest("hex");

describe("the upload Worker", () => {
  const stamp = Date.now().toString(36);
  const TOKEN = `gho_good_${stamp}`;
  const FLOOD = `gho_flood_${stamp}`;
  let github, dev;

  before(async () => {
    github = await fakeGithub({ [TOKEN]: { id: 4242, login: "octo" }, [FLOOD]: { id: 4343, login: "flood" } });
    dev = await wranglerDev({ GITHUB_API_ORIGIN: github.url, PUBLIC_URL });
  });

  after(async () => {
    await dev?.stop();
    await github?.close();
  });

  const upload = async (body, token = TOKEN, init = {}) => {
    const res = await fetch(`${dev.base}/`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
      ...init,
    });
    return { status: res.status, json: await res.json() };
  };

  /// The object behind a URL the Worker answered: its bytes and its metadata.
  const stored = async (url) => {
    assert.ok(url.startsWith(`${PUBLIC_URL}/`), url);
    const at = `${dev.base}/cdn-cgi/local/explorer/api/r2/buckets/${BUCKET}/objects/${url.slice(PUBLIC_URL.length + 1)}`;
    const head = await (await fetch(at, { headers: { "cf-metadata-only": "true" } })).json();
    const body = Buffer.from(await (await fetch(at)).arrayBuffer());
    return { body, meta: head.result };
  };

  test("GET sends a person to the docs", async () => {
    const res = await fetch(`${dev.base}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://www.drayhq.com/docs/cli/upload");
  });

  test("stores a PNG under the public URL, with its type and uploader", async () => {
    const body = png("first");
    const { status, json } = await upload(body);
    assert.equal(status, 200, JSON.stringify(json));
    assert.match(json.url, /^https:\/\/img\.test\/[0-9a-f]{32}\.png$/);
    assert.deepEqual({ type: json.type, size: json.size }, { type: "image/png", size: body.length });
    const { body: saved, meta } = await stored(json.url);
    assert.deepEqual(saved, body);
    assert.equal(meta.http_metadata.contentType, "image/png");
    assert.equal(meta.http_metadata.cacheControl, "public, max-age=31536000, immutable");
    assert.deepEqual(meta.custom_metadata, { "github-id": "4242" });
    assert.equal(github.seen.at(-1), `Bearer ${TOKEN}`);
  });

  test("every upload gets a key of its own, the same bytes included", async () => {
    const a = await upload(png("same"));
    const b = await upload(png("same"));
    assert.notEqual(a.json.url, b.json.url);
  });

  test("the type comes from the bytes, never the name or header", async () => {
    const svg = await upload("<svg xmlns='http://www.w3.org/2000/svg'/>", TOKEN, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
    });
    assert.equal(svg.status, 415);
    assert.equal(svg.json.error, "not_accepted");
    const gif = await upload(Buffer.from("GIF89a\x01\x00\x01\x00"));
    assert.equal(gif.status, 200);
    assert.match(gif.json.url, /\.gif$/);
    assert.equal((await upload(new Uint8Array())).status, 415);
  });

  test("a 25 MB mp4 streams through whole, past the old 4 MB cap", async () => {
    const body = mp4(25 * MB);
    const { status, json } = await upload(body);
    assert.equal(status, 200, JSON.stringify(json));
    assert.match(json.url, /\.mp4$/);
    assert.equal(json.type, "video/mp4");
    const { body: saved, meta } = await stored(json.url);
    assert.equal(sha(saved), sha(body));
    assert.equal(meta.http_metadata.contentType, "video/mp4");
  });

  test("mov and webm are taken too", async () => {
    const mov = await upload(Buffer.from("\0\0\0\x14ftypqt  \0\0\0\0"));
    assert.equal(mov.json.type, "video/quicktime");
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x84, ...Buffer.from("webm"), 0, 0]);
    assert.equal((await upload(webm)).json.type, "video/webm");
  });

  test("no token, or one GitHub refuses, is 401", async () => {
    const none = await upload(png("x"), null);
    assert.equal(none.status, 401);
    assert.equal(none.json.error, "github_token_required");
    const bad = await upload(png("x"), "gho_not_a_real_one");
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, "github_token_invalid");
  });

  test("an image past 20 MB and anything past 100 MB is 413, saying the cap", async () => {
    const image = await upload(Buffer.concat([png(""), Buffer.alloc(20 * MB)]));
    assert.deepEqual([image.status, image.json.max_bytes], [413, 20 * MB]);
    const video = await upload(mp4(100 * MB + 1));
    assert.deepEqual([video.status, video.json.max_bytes], [413, 100 * MB]);
  });

  test("a body with no length is 411, since R2 wants it up front", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(png("streamed"));
        c.close();
      },
    });
    const res = await upload(stream, TOKEN, { duplex: "half" });
    assert.equal(res.status, 411);
  });

  test("a GitHub user gets 30 an hour, then 429", async () => {
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await upload(png(`flood ${i}`), FLOOD)).status);
    assert.deepEqual(statuses, [...Array(30).fill(200), 429]);
    assert.equal((await upload(png("still fine"))).status, 200, "another user is not slowed");
  });

  test("the token reaches no log", () => {
    assert.ok(dev.log().includes("POST /"));
    for (const t of [TOKEN, FLOOD, "gho_not_a_real_one"]) assert.ok(!dev.log().includes(t));
  });
});
