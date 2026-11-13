import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { fakeBoat } from "./fake-boat.mjs";

/// The Dray Cloud routes (#857) under a real `next dev`, against a faked boat.
/// Run with `pnpm test` from apps/web.

const KEY = "client-key";
const SECRET = "cloud-secret";
const BOAT_KEY = "boat_test";
const ORG = "dray-cloud-org";
const hmac = (what) => createHmac("sha256", SECRET).update(what).digest("hex");
const SERVE_TOKEN = hmac("serve-token");
const MACHINE_SECRET = hmac("machine");

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/// Starts `next dev` with `env` and waits until it answers.
async function next(env) {
  const port = await freePort();
  const child = spawn("node_modules/.bin/next", ["dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`next dev exited:\n${log}`);
    try {
      await fetch(`${base}/api/cloud/machines`);
      const stop = () => {
        const exited = new Promise((r) => child.once("exit", r));
        process.kill(-child.pid, "SIGTERM");
        return exited;
      };
      return { base, log: () => log, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill();
  throw new Error(`next dev never answered:\n${log}`);
}

const ROUTES = [
  ["GET", "/api/cloud/machines"],
  ["POST", "/api/cloud/machines"],
  ["POST", "/api/cloud/machines/bx_23456789/resume"],
  ["POST", "/api/cloud/machines/bx_23456789/stop"],
  ["DELETE", "/api/cloud/machines/bx_23456789"],
  ["POST", "/api/cloud/heartbeat"],
];

describe("without DRAY_CLOUD_KEY", () => {
  let app;
  before(async () => {
    app = await next({ DRAY_CLOUD_KEY: "", DRAY_CLOUD_SECRET: SECRET, BOAT_API_KEY: BOAT_KEY });
  });
  after(() => app?.stop());

  test("every route answers 404", async () => {
    for (const [method, path] of ROUTES) {
      const res = await fetch(app.base + path, { method, headers: { Authorization: `Bearer ${KEY}` } });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });
});

describe("with DRAY_CLOUD_KEY", () => {
  let app;
  let boat;
  before(async () => {
    boat = await fakeBoat({ key: BOAT_KEY, org: ORG });
    app = await next({
      DRAY_CLOUD_KEY: KEY,
      DRAY_CLOUD_SECRET: SECRET,
      BOAT_API_KEY: BOAT_KEY,
      BOAT_ORG: ORG,
      BOAT_API_URL: boat.url,
    });
  });
  after(async () => {
    await app?.stop();
    await boat?.close();
  });

  const call = async (method, path, { key = KEY, body } = {}) => {
    const res = await fetch(app.base + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const callsTo = (method, path) => boat.calls.filter((c) => c.method === method && c.path === path);
  const waitFor = async (what, check) => {
    for (let i = 0; i < 100; i++) {
      const hit = check();
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  test("wrong keys answer 401", async () => {
    assert.equal((await call("GET", "/api/cloud/machines", { key: "nope" })).status, 401);
    assert.equal((await call("GET", "/api/cloud/machines", { key: MACHINE_SECRET })).status, 401);
    const beat = await call("POST", "/api/cloud/heartbeat", { key: KEY, body: { sandbox: "bx_23456789", busy: true } });
    assert.equal(beat.status, 401);
  });

  test("no machines yet lists none, and the derived token", async () => {
    const { status, json } = await call("GET", "/api/cloud/machines");
    assert.equal(status, 200);
    assert.deepEqual(json, { token: SERVE_TOKEN, machines: [] });
    assert.match(json.token, /^[0-9a-f]{64}$/);
  });

  let first;
  test("a task's machine is created from the saved snapshot", async () => {
    const { status, json } = await call("POST", "/api/cloud/machines");
    assert.equal(status, 200);
    const [create] = callsTo("POST", "/sandboxes");
    assert.equal(create.org, ORG);
    assert.deepEqual(create.body, {
      from: "dray-cloud",
      noEnv: true,
      labels: { dray: "cloud" },
      ttlSeconds: 900,
      hostedPorts: [{ port: 7317, public: true, localhost: true }],
      files: [
        { path: ".dray/serve-token", content: SERVE_TOKEN },
        { path: ".dray/cloud.json", content: JSON.stringify({ url: `${app.base}/api/cloud`, secret: MACHINE_SECRET }) },
      ],
    });
    first = boat.sandboxes.get(json.machine.id);
    assert.deepEqual(json.machine, { id: first.id, state: "starting", url: `wss://${first.subdomain}-7317.on.boat.dev` });
    assert.notEqual(MACHINE_SECRET, KEY);
  });

  let second;
  test("every task gets a new machine, never a running or stopped one", async () => {
    first.state = "archived";
    const { status, json } = await call("POST", "/api/cloud/machines");
    assert.equal(status, 200);
    assert.notEqual(json.machine.id, first.id);
    second = boat.sandboxes.get(json.machine.id);
    assert.equal(callsTo("POST", "/sandboxes").length, 2);
    assert.ok(!boat.calls.some((c) => c.path.endsWith("/fork") || c.path.endsWith("/resume")));
  });

  test("lists every machine across pages", async () => {
    await call("POST", "/api/cloud/machines");
    await call("POST", "/api/cloud/machines");
    const other = boat.add({ labels: { other: "x" }, state: "ready" });
    const { json } = await call("GET", "/api/cloud/machines");
    assert.equal(json.machines.length, 4);
    assert.ok(!json.machines.some((m) => m.id === other.id));
    for (const m of json.machines) {
      const s = boat.sandboxes.get(m.id);
      assert.equal(m.url, `wss://${s.subdomain}-7317.on.boat.dev`);
    }
    assert.ok(boat.calls.some((c) => c.path === "/sandboxes" && c.query.includes("cursor=")));
  });

  test("stop stops a machine", async () => {
    second.state = "ready";
    const { status, json } = await call("POST", `/api/cloud/machines/${second.id}/stop`);
    assert.equal(status, 200);
    assert.equal(json.machine.state, "stopping");
    assert.equal(second.state, "archiving");
  });

  test("resume resumes a stopped machine and leaves a running one", async () => {
    second.state = "archived";
    const stopped = await call("POST", `/api/cloud/machines/${second.id}/resume`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.machine.id, second.id);
    assert.deepEqual(callsTo("POST", `/sandboxes/${second.id}/resume`).map((c) => c.body), [{ ttlSeconds: 900 }]);
    second.state = "running";
    const running = await call("POST", `/api/cloud/machines/${second.id}/resume`);
    assert.equal(running.json.machine.state, "running");
    assert.equal(callsTo("POST", `/sandboxes/${second.id}/resume`).length, 1);
  });

  test("boat's own refusal reaches the client", async () => {
    Object.assign(first, { state: "archived", stoppedAt: boat.now(), dataExpiredAt: boat.now() });
    const { status, json } = await call("POST", `/api/cloud/machines/${first.id}/resume`);
    assert.equal(status, 409);
    assert.equal(json.error, "snapshot_data_expired");
  });

  test("delete deletes a settled task's machine, and again is no error", async () => {
    const third = [...boat.sandboxes.values()].find((s) => s.labels.dray && s !== first && s !== second);
    const { status } = await call("DELETE", `/api/cloud/machines/${third.id}`);
    assert.equal(status, 204);
    const [del] = callsTo("DELETE", `/sandboxes/${third.id}`);
    assert.equal(del.status, 202);
    assert.ok(!boat.sandboxes.has(third.id));
    assert.equal((await call("DELETE", `/api/cloud/machines/${third.id}`)).status, 204);
    assert.equal(callsTo("DELETE", `/sandboxes/${third.id}`).length, 1);
  });

  test("a sandbox outside Dray Cloud is not found", async () => {
    const other = [...boat.sandboxes.values()].find((s) => s.labels.other);
    assert.equal((await call("POST", `/api/cloud/machines/${other.id}/stop`)).status, 404);
    assert.equal((await call("POST", "/api/cloud/machines/not-an-id/resume")).status, 404);
    assert.equal((await call("DELETE", `/api/cloud/machines/${other.id}`)).status, 204);
    assert.equal(callsTo("POST", `/sandboxes/${other.id}/stop`).length, 0);
    assert.equal(callsTo("DELETE", `/sandboxes/${other.id}`).length, 0);
  });

  test("a busy heartbeat pushes auto-stop out, an idle one does not", async () => {
    const s = second;
    s.ttlSeconds = 60;
    const idle = await call("POST", "/api/cloud/heartbeat", { key: MACHINE_SECRET, body: { sandbox: s.id, busy: false } });
    assert.equal(idle.status, 204);
    assert.equal(callsTo("PATCH", `/sandboxes/${s.id}`).length, 0);
    const busy = await call("POST", "/api/cloud/heartbeat", { key: MACHINE_SECRET, body: { sandbox: s.id, busy: true } });
    assert.equal(busy.status, 204);
    assert.deepEqual(callsTo("PATCH", `/sandboxes/${s.id}`).map((c) => c.body), [{ ttlSeconds: 900 }]);
    assert.equal(s.ttlSeconds, 900);
  });

  test("a heartbeat touches only labelled sandboxes", async () => {
    const other = [...boat.sandboxes.values()].find((s) => s.labels.other);
    const res = await call("POST", "/api/cloud/heartbeat", { key: MACHINE_SECRET, body: { sandbox: other.id, busy: true } });
    assert.equal(res.status, 204);
    assert.equal(callsTo("PATCH", `/sandboxes/${other.id}`).length, 0);
    const bad = await call("POST", "/api/cloud/heartbeat", { key: MACHINE_SECRET, body: { sandbox: other.id } });
    assert.equal(bad.status, 400);
  });

  test("boat out of reach answers a JSON 502", async () => {
    boat.dropNext();
    const { status, json } = await call("GET", "/api/cloud/machines");
    assert.equal(status, 502);
    assert.equal(json.error, "boat_unreachable");
  });

  test("boat refused nothing but the expired resume", () => {
    const refused = boat.calls.filter((c) => c.status >= 400).map((c) => `${c.method} ${c.path} ${c.status}`);
    assert.deepEqual(refused, [`POST /sandboxes/${first.id}/resume 409`]);
  });
});
