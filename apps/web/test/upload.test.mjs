import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { signV4 } from "../src/lib/upload.ts";
import { nextDev } from "./next-dev.mjs";

/// `POST /api/upload` (#1477) under a real `next dev`, storing into
/// SeaweedFS's S3 gateway and counting into Postgres, both in Docker, with
/// GitHub's `/user` faked. SeaweedFS stands in for R2 because it checks SigV4
/// against the keys it was given; MinIO no longer publishes an image. Skipped
/// where Docker is not running. Run with `pnpm test` from apps/web.

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const hasDocker = (() => {
  try {
    docker("info", "--format", "{{.ServerVersion}}");
    return true;
  } catch {
    return false;
  }
})();

const BUCKET = "shots";
const S3_KEY = "dray-test";
const S3_SECRET = "dray-test-secret";

/// A container on a random local port, removed on exit; answers its id and port.
function run(image, port, flags, ...cmd) {
  const id = docker("run", "-d", "--rm", "-p", `127.0.0.1::${port}`, ...flags, image, ...cmd);
  return { id, port: Number(docker("port", id, String(port)).split("\n")[0].split(":").pop()) };
}

/// SeaweedFS's S3 gateway: one key that may write, and anonymous reads, the
/// way R2 serves a bucket publicly through its own domain.
function seaweed() {
  const dir = mkdtempSync(join(tmpdir(), "dray-upload-test-"));
  const identities = [
    { name: "dray", credentials: [{ accessKey: S3_KEY, secretKey: S3_SECRET }], actions: ["Admin", "Read", "Write", "List"] },
    { name: "anonymous", actions: ["Read"] },
  ];
  writeFileSync(join(dir, "s3.json"), JSON.stringify({ identities }));
  const c = run("chrislusf/seaweedfs:latest", 8333, ["-v", `${dir}:/cfg:ro`], "server", "-s3", "-s3.config=/cfg/s3.json");
  return { ...c, endpoint: `http://127.0.0.1:${c.port}`, dir };
}

/// A signed `CreateBucket`, through the same signer the route uses.
async function createBucket(endpoint, bucket = BUCKET, secret = S3_SECRET) {
  const url = new URL(`${endpoint}/${bucket}`);
  const headers = {
    "x-amz-content-sha256": createHash("sha256").update("").digest("hex"),
    "x-amz-date": new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
  };
  const authorization = signV4({ method: "PUT", url, headers, region: "auto", accessKey: S3_KEY, secret });
  const res = await fetch(url, { method: "PUT", headers: { ...headers, authorization } });
  return res.ok;
}

async function until(what, check) {
  for (let i = 0; i < 120; i++) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
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

const png = (tail) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);

describe("POST /api/upload", { skip: !hasDocker && "Docker is not running" }, () => {
  const stamp = Date.now().toString(36);
  const TOKEN = `gho_good_${stamp}`;
  const FLOOD = `gho_flood_${stamp}`;
  let s3, pg, github, app;

  before(async () => {
    s3 = seaweed();
    pg = run("postgres:17-alpine", 5432, ["-e", "POSTGRES_PASSWORD=pw"]);
    await until("the bucket", () => createBucket(s3.endpoint));
    await until("the rate table", () => {
      docker(
        "exec", pg.id, "psql", "-U", "postgres", "-c",
        `create table push_rate (id text primary key, "windowStart" integer not null, count integer not null)`,
      );
      return true;
    });
    github = await fakeGithub({ [TOKEN]: { id: 4242, login: "octo" }, [FLOOD]: { id: 4343, login: "flood" } });
    app = await nextDev("/", {
      DATABASE_URL: `postgres://postgres:pw@127.0.0.1:${pg.port}/postgres`,
      GITHUB_API_ORIGIN: github.url,
      R2_ACCOUNT_ID: "test-account",
      R2_ENDPOINT: s3.endpoint,
      R2_ACCESS_KEY_ID: S3_KEY,
      R2_SECRET_ACCESS_KEY: S3_SECRET,
      R2_BUCKET: BUCKET,
      R2_PUBLIC_URL: `${s3.endpoint}/${BUCKET}`,
    });
  });

  after(async () => {
    await app?.stop();
    await github?.close();
    for (const c of [s3, pg]) if (c) docker("rm", "-f", c.id);
    if (s3) rmSync(s3.dir, { recursive: true, force: true });
  });

  const upload = async (body, token = TOKEN, init = {}) => {
    const res = await fetch(`${app.base}/api/upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
      ...init,
    });
    return { status: res.status, json: await res.json() };
  };

  test("the stand-in refuses a bad signature, so a pass below means the signer is right", async () => {
    assert.equal(await createBucket(s3.endpoint, "other", "wrong-secret"), false);
  });

  test("stores a PNG and answers a public URL serving the same bytes", async () => {
    const body = png("first");
    const { status, json } = await upload(body);
    assert.equal(status, 200, JSON.stringify(json));
    assert.match(json.url, new RegExp(`^${s3.endpoint}/${BUCKET}/[0-9a-f]{64}\\.png$`));
    assert.deepEqual({ type: json.type, size: json.size }, { type: "image/png", size: body.length });
    const served = await fetch(json.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-amz-meta-github-id"), "4242");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), body);
    assert.equal(github.seen.at(-1), `Bearer ${TOKEN}`);
  });

  test("the same bytes land at the same key, different bytes at another", async () => {
    const a = await upload(png("same"));
    const b = await upload(png("same"));
    const c = await upload(png("other"));
    assert.equal(a.json.url, b.json.url);
    assert.notEqual(a.json.url, c.json.url);
  });

  test("the type comes from the bytes, never the name or header", async () => {
    const svg = await upload("<svg xmlns='http://www.w3.org/2000/svg'/>", TOKEN, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
    });
    assert.equal(svg.status, 415);
    assert.equal(svg.json.error, "not_an_image");
    const gif = await upload(Buffer.from("GIF89a\x01\x00\x01\x00"));
    assert.equal(gif.status, 200);
    assert.match(gif.json.url, /\.gif$/);
    assert.equal((await upload(new Uint8Array())).status, 415);
  });

  test("no token, or one GitHub refuses, is 401 and stores nothing", async () => {
    const none = await upload(png("x"), null);
    assert.equal(none.status, 401);
    assert.equal(none.json.error, "github_token_required");
    const bad = await upload(png("x"), "gho_not_a_real_one");
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, "github_token_invalid");
  });

  test("past 4 MB is 413, with a Content-Length and without one", async () => {
    const big = Buffer.concat([png(""), Buffer.alloc(4 * 1024 * 1024)]);
    const sized = await upload(big);
    assert.equal(sized.status, 413);
    assert.equal(sized.json.max_bytes, 4 * 1024 * 1024);
    // Streamed in chunks, so no Content-Length: the read itself has to stop it.
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < big.length; i += 1 << 20) c.enqueue(big.subarray(i, i + (1 << 20)));
        c.close();
      },
    });
    const streamed = await upload(stream, TOKEN, { duplex: "half" });
    assert.equal(streamed.status, 413);
  });

  test("a GitHub user gets 30 an hour, then 429", async () => {
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await upload(png(`flood ${i}`), FLOOD)).status);
    assert.deepEqual(statuses, [...Array(30).fill(200), 429]);
    assert.equal((await upload(png("still fine"))).status, 200, "another user is not slowed");
  });

  test("the token reaches no log", () => {
    assert.ok(app.log().length > 0);
    for (const t of [TOKEN, FLOOD, "gho_not_a_real_one"]) assert.ok(!app.log().includes(t));
  });
});
