import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { fakeBoat } from "./fake-boat.mjs";
import { call as callAt, next } from "./next-dev.mjs";

/// Dray Cloud for signed-in accounts: each user's machines are their own, and
/// capped. Needs a Postgres to hold `app_session`: set
/// `DRAY_TEST_DATABASE_URL` to an empty database, or this file skips.
///
///   docker run -d --rm -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16-alpine
///   DRAY_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/postgres pnpm test

const DB = process.env.DRAY_TEST_DATABASE_URL;
const KEY = "client-key";
const SECRET = "cloud-secret";
const BOAT_KEY = "boat_test";
const ORG = "dray-cloud-org";
const CAP = 2;
const hmac = (what) => createHmac("sha256", SECRET).update(what).digest("hex");
const serveToken = (user) => hmac(`serve-token:user:${user}`);
const machineSecret = (user) => `${user}.${hmac(`machine:user:${user}`)}`;
const LEGACY_SERVE = hmac("serve-token");
const LEGACY_MACHINE = hmac("machine");

// A user id the way Better Auth mints one, and the app credential #889 hands out.
const ADA = { id: "AdaLovelace0000000000000000000001", token: "dra_ada" };
const BOB = { id: "BobBobBob000000000000000000000002", token: "dra_bob" };

describe("accounts", { skip: !DB && "DRAY_TEST_DATABASE_URL unset" }, () => {
  let app;
  let boat;
  let db;
  before(async () => {
    db = new pg.Client({ connectionString: DB });
    await db.connect();
    await db.query(`drop table if exists app_session`);
    await db.query(`create table app_session ("userId" text not null, "tokenHash" text not null unique)`);
    for (const u of [ADA, BOB]) {
      const hash = createHash("sha256").update(u.token).digest("hex");
      await db.query(`insert into app_session values ($1, $2)`, [u.id, hash]);
    }
    boat = await fakeBoat({ key: BOAT_KEY, org: ORG });
    app = await next({
      DATABASE_URL: DB,
      DRAY_CLOUD_ACCOUNTS: "1",
      DRAY_CLOUD_KEY: KEY,
      DRAY_CLOUD_LEGACY_USER: ADA.id,
      DRAY_CLOUD_MAX_AWAKE: String(CAP),
      DRAY_CLOUD_SECRET: SECRET,
      BOAT_API_KEY: BOAT_KEY,
      BOAT_ORG: ORG,
      BOAT_API_URL: boat.url,
    });
  });
  after(async () => {
    await app?.stop();
    await boat?.close();
    await db?.query(`drop table if exists app_session`);
    await db?.end();
  });

  const call = (method, path, { key, body } = {}) => callAt(app.base, method, path, { key, body });
  const callsTo = (method, path) => boat.calls.filter((c) => c.method === method && c.path === path);
  const sandbox = (id) => boat.sandboxes.get(id);

  test("an unknown or revoked credential answers 401", async () => {
    assert.equal((await call("GET", "/api/cloud/machines", { key: "dra_nobody" })).status, 401);
    assert.equal((await call("GET", "/api/cloud/machines", { key: serveToken(ADA.id) })).status, 401);
  });

  let legacy;
  test("the key still works as before", async () => {
    const { status, json } = await call("POST", "/api/cloud/machines", { key: KEY });
    assert.equal(status, 200);
    legacy = sandbox(json.machine.id);
    assert.deepEqual(legacy.labels, { dray: "cloud" });
    assert.equal(json.machine.token, LEGACY_SERVE);
  });

  let ada;
  test("a user's machine is labelled theirs and holds their own secrets", async () => {
    const before = callsTo("POST", "/sandboxes").length;
    const { status, json } = await call("POST", "/api/cloud/machines", { key: ADA.token });
    assert.equal(status, 200);
    ada = sandbox(json.machine.id);
    const create = callsTo("POST", "/sandboxes")[before];
    assert.deepEqual(create.body.labels, { dray: "cloud", user: ADA.id });
    assert.deepEqual(create.body.files, [
      { path: ".dray/serve-token", content: serveToken(ADA.id) },
      {
        path: ".dray/cloud.json",
        content: JSON.stringify({ url: `${app.base}/api/cloud`, secret: machineSecret(ADA.id) }),
      },
    ]);
    assert.equal(json.machine.token, serveToken(ADA.id));
    assert.notEqual(serveToken(ADA.id), serveToken(BOB.id));
  });

  test("a user lists their own machines, and the heir the key's too", async () => {
    const mine = await call("GET", "/api/cloud/machines", { key: ADA.token });
    assert.equal(mine.json.token, serveToken(ADA.id));
    const tokens = Object.fromEntries(mine.json.machines.map((m) => [m.id, m.token]));
    assert.deepEqual(tokens, { [ada.id]: serveToken(ADA.id), [legacy.id]: LEGACY_SERVE });

    const bob = await call("GET", "/api/cloud/machines", { key: BOB.token });
    assert.deepEqual(bob.json, { token: serveToken(BOB.id), machines: [] });

    const key = await call("GET", "/api/cloud/machines", { key: KEY });
    assert.deepEqual(key.json.machines.map((m) => m.id), [legacy.id]);
  });

  test("nobody touches another's machine", async () => {
    for (const id of [ada.id, legacy.id]) {
      assert.equal((await call("POST", `/api/cloud/machines/${id}/stop`, { key: BOB.token })).status, 404);
      assert.equal((await call("POST", `/api/cloud/machines/${id}/resume`, { key: BOB.token })).status, 404);
      assert.equal((await call("DELETE", `/api/cloud/machines/${id}`, { key: BOB.token })).status, 204);
      assert.ok(boat.sandboxes.has(id));
    }
    assert.equal((await call("POST", `/api/cloud/machines/${ada.id}/stop`, { key: KEY })).status, 404);
    assert.equal(callsTo("POST", `/sandboxes/${ada.id}/stop`).length, 0);
  });

  test("a heartbeat extends only a machine of the owner its secret names", async () => {
    ada.state = "ready";
    const beat = (key, id) => call("POST", "/api/cloud/heartbeat", { key, body: { sandbox: id, busy: true } });
    assert.equal((await beat(machineSecret(BOB.id), ada.id)).status, 204);
    assert.equal((await beat(LEGACY_MACHINE, ada.id)).status, 204);
    // The heir lists the key's machines but its machines hold another secret.
    assert.equal((await beat(machineSecret(ADA.id), legacy.id)).status, 204);
    assert.equal(callsTo("PATCH", `/sandboxes/${ada.id}`).length, 0);
    assert.equal(callsTo("PATCH", `/sandboxes/${legacy.id}`).length, 0);

    const forged = `${BOB.id}.${hmac(`machine:user:${ADA.id}`)}`;
    assert.equal((await beat(forged, ada.id)).status, 401);
    assert.equal((await beat(`${ADA.id}.`, ada.id)).status, 401);

    assert.equal((await beat(machineSecret(ADA.id), ada.id)).status, 204);
    assert.equal(callsTo("PATCH", `/sandboxes/${ada.id}`).length, 1);
    assert.equal((await beat(LEGACY_MACHINE, legacy.id)).status, 204);
    assert.equal(callsTo("PATCH", `/sandboxes/${legacy.id}`).length, 1);
  });

  test("awake machines are capped per user, stopped ones are not counted", async () => {
    // Ada has hers and the key's awake, which is the cap.
    const over = await call("POST", "/api/cloud/machines", { key: ADA.token });
    assert.equal(over.status, 429);
    assert.equal(over.json.error, "machine_limit");
    assert.match(over.json.message, /^2 Dray Cloud machines are already running/);

    // Bob's count is his own.
    assert.equal((await call("POST", "/api/cloud/machines", { key: BOB.token })).status, 200);

    ada.state = "archived";
    const again = await call("POST", "/api/cloud/machines", { key: ADA.token });
    assert.equal(again.status, 200);
    const resumed = await call("POST", `/api/cloud/machines/${ada.id}/resume`, { key: ADA.token });
    assert.equal(resumed.status, 429);
    assert.equal(callsTo("POST", `/sandboxes/${ada.id}/resume`).length, 0);

    // One already awake answers as it is, cap or none.
    const awake = await call("POST", `/api/cloud/machines/${again.json.machine.id}/resume`, { key: ADA.token });
    assert.equal(awake.status, 200);
  });

  test("starts at once can't pass the cap together", async () => {
    const before = [...boat.sandboxes.values()].filter((s) => s.labels.user === BOB.id).length;
    const answers = await Promise.all(
      Array.from({ length: 4 }, () => call("POST", "/api/cloud/machines", { key: BOB.token })),
    );
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 429, 429, 429]);
    const after = [...boat.sandboxes.values()].filter((s) => s.labels.user === BOB.id).length;
    assert.equal(after - before, 1);
  });

  test("a user deletes their own", async () => {
    assert.equal((await call("DELETE", `/api/cloud/machines/${ada.id}`, { key: ADA.token })).status, 204);
    assert.ok(!boat.sandboxes.has(ada.id));
    assert.equal((await call("DELETE", `/api/cloud/machines/${legacy.id}`, { key: ADA.token })).status, 204);
    assert.ok(!boat.sandboxes.has(legacy.id));
  });

  test("a start whose recheck fails deletes its machine", async () => {
    const before = new Set(boat.sandboxes.keys());
    let created = false;
    boat.dropOnce((c) => {
      if (c.method === "POST" && c.path === "/sandboxes") created = true;
      return created && c.method === "GET" && c.path === "/sandboxes";
    });
    const { status, json } = await call("POST", "/api/cloud/machines", { key: ADA.token });
    assert.equal(status, 502);
    assert.equal(json.error, "boat_unreachable");
    assert.ok(created);
    assert.deepEqual([...boat.sandboxes.keys()].filter((id) => !before.has(id)), []);
  });
});
