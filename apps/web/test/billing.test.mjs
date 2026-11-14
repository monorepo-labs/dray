import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import pg from "pg";
import Stripe from "stripe";

import { fakeBoat } from "./fake-boat.mjs";
import { next } from "./next-dev.mjs";

/// Dray Cloud billing (#1014) under a real `next dev`, against a faked boat, a
/// faked Stripe and a real Postgres. Skipped without one:
///
///   docker run -d --rm -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:17-alpine
///   TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/postgres pnpm test

const DB = process.env.TEST_DATABASE_URL;
const KEY = "client-key";
const SECRET = "cloud-secret";
const BOAT_KEY = "boat_test";
const ORG = "dray-cloud-org";
const CRON = "cron-secret";
const WEBHOOK = "whsec_test";
const MACHINE_SECRET = createHmac("sha256", SECRET).update("machine").digest("hex");
const HOUR = 3600;
const STARTER = 100 * HOUR;

/// Enough of Stripe's API for metering and the webhook: subscriptions by id,
/// cancels, and meter events, recorded and deduplicated by identifier the way
/// Stripe does. `refuseNext` refuses the next meter event; `loseAnswers(n)`
/// takes the next n events and hangs up before answering.
async function fakeStripe() {
  const subscriptions = new Map();
  const events = [];
  const cancelled = [];
  let failNext = false;
  let lose = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const sub = req.url.match(/^\/v1\/subscriptions\/([\w]+)/);
    if (req.method === "DELETE" && sub) {
      cancelled.push({ id: sub[1], prorate: new URL(req.url, "http://stripe").searchParams.get("prorate") });
      return send(200, { ...subscriptions.get(sub[1]), status: "canceled" });
    }
    if (req.method === "GET" && sub) {
      const found = subscriptions.get(sub[1]);
      return found ? send(200, found) : send(404, { error: { type: "invalid_request_error", message: "No such subscription" } });
    }
    if (req.method === "POST" && req.url === "/v1/billing/meter_events") {
      if (failNext) {
        failNext = false;
        return send(400, { error: { type: "invalid_request_error", message: "refused for the test" } });
      }
      const form = new URLSearchParams(raw);
      const event = {
        event_name: form.get("event_name"),
        customer: form.get("payload[stripe_customer_id]"),
        value: Number(form.get("payload[value]")),
        identifier: form.get("identifier"),
        timestamp: Number(form.get("timestamp")),
      };
      if (!events.some((e) => e.identifier === event.identifier)) events.push(event);
      if (lose > 0) {
        lose--;
        return req.socket.destroy();
      }
      return send(200, { object: "billing.meter_event", ...event });
    }
    send(404, { error: { type: "invalid_request_error", message: `fake has no ${req.method} ${req.url}` } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    subscriptions,
    events,
    cancelled,
    refuseNext: () => (failNext = true),
    loseAnswers: (n) => (lose = n),
    close: () => new Promise((r) => server.close(r)),
  };
}

describe("Dray Cloud billing", { skip: !DB && "set TEST_DATABASE_URL to a scratch Postgres" }, () => {
  let app, boat, stripe, db;
  const periodStart = new Date(Math.floor(Date.now() / 1000 - 10 * 86400) * 1000);
  const periodEnd = new Date(periodStart.getTime() + 30 * 86400 * 1000);

  before(async () => {
    const migrate = spawnSync("node_modules/.bin/auth", ["migrate", "--config", "src/lib/auth.ts", "-y"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DATABASE_URL: DB },
      encoding: "utf8",
    });
    assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
    db = new pg.Pool({ connectionString: DB });
    await db.query(`delete from "user" where id in ('u_a', 'u_b')`);
    await db.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values
         ('u_a', 'Ada', 'ada@billing.test', true, now(), now()), ('u_b', 'Bo', 'bo@billing.test', true, now(), now())`,
    );
    await db.query(
      `insert into cloud_billing (id, "userId", "stripeCustomerId", "stripeSubscriptionId", plan, status,
         "periodStart", "periodEnd", "cancelAtPeriodEnd", overage, "reportedMinutes")
       values ('b_a', 'u_a', 'cus_a', 'sub_a', 'starter', 'active', $1, $2, false, false, 0)`,
      [periodStart, periodEnd],
    );
    boat = await fakeBoat({ key: BOAT_KEY, org: ORG });
    stripe = await fakeStripe();
    app = await next({
      DATABASE_URL: DB,
      DRAY_CLOUD_KEY: KEY,
      DRAY_CLOUD_SECRET: SECRET,
      BOAT_API_KEY: BOAT_KEY,
      BOAT_ORG: ORG,
      BOAT_API_URL: boat.url,
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_API_URL: stripe.url,
      STRIPE_WEBHOOK_SECRET: WEBHOOK,
      CRON_SECRET: CRON,
    });
  });
  after(async () => {
    await app?.stop();
    await boat?.close();
    await stripe?.close();
    await db?.query(`delete from "user" where id in ('u_a', 'u_b')`);
    await db?.end();
  });

  const call = async (method, path, { key = KEY, body, headers = {} } = {}) => {
    const res = await fetch(app.base + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const beat = (s, busy = true) => call("POST", "/api/cloud/heartbeat", { key: MACHINE_SECRET, body: { sandbox: s.id, busy } });
  const webhook = (payload) =>
    call("POST", "/api/billing/webhook", {
      body: payload,
      headers: { "stripe-signature": new Stripe("sk_test_fake").webhooks.generateTestHeaderString({ payload, secret: WEBHOOK }) },
    });
  const callsTo = (method, path) => boat.calls.filter((c) => c.method === method && c.path === path);
  const billing = async () => (await db.query(`select * from cloud_billing where id = 'b_a'`)).rows[0];
  const usage = async (id) =>
    (await db.query(`select seconds, running from cloud_usage where "sandboxId" = $1`, [id])).rows[0];
  const machine = (user, fields) => boat.add({ labels: { dray: "cloud", ...(user && { user }) }, state: "ready", ...fields });

  let a1, a2, a3;
  test("a heartbeat reads the machine's meter into its owner's period", async () => {
    a1 = machine("u_a", { usageSeconds: HOUR });
    a1.ttlSeconds = 60;
    assert.equal((await beat(a1)).status, 204);
    const [read] = callsTo("GET", `/sandboxes/${a1.id}/usage`);
    assert.equal(new URLSearchParams(read.query).get("since"), periodStart.toISOString());
    assert.deepEqual(await usage(a1.id), { seconds: HOUR, running: true });
    assert.equal(a1.ttlSeconds, 900);
    assert.equal(stripe.events.length, 0);
  });

  test("a machine without a user label is never metered", async () => {
    const free = machine(null, { usageSeconds: 10 * STARTER });
    assert.equal((await beat(free)).status, 204);
    assert.equal(callsTo("GET", `/sandboxes/${free.id}/usage`).length, 0);
    assert.equal(free.ttlSeconds, 900);
  });

  test("past the plan's hours with overage off, every awake machine of its owner stops", async () => {
    a2 = machine("u_a", { usageSeconds: 0 });
    a3 = machine("u_a", { state: "archived", usageSeconds: 0 });
    const other = machine(null, {});
    a1.usageSeconds = STARTER + 30;
    a1.ttlSeconds = 60;
    assert.equal((await beat(a1)).status, 204);
    assert.equal(a1.ttlSeconds, 60, "a user out of hours gets no more time");
    assert.equal(callsTo("POST", `/sandboxes/${a1.id}/stop`).length, 1);
    assert.equal(callsTo("POST", `/sandboxes/${a2.id}/stop`).length, 1);
    assert.equal(callsTo("POST", `/sandboxes/${a3.id}/stop`).length, 0);
    assert.equal(callsTo("POST", `/sandboxes/${other.id}/stop`).length, 0);
    assert.equal(stripe.events.length, 0, "time past the hours with overage off is never billed");
  });

  test("resume refuses a user out of hours, and one with no plan, saying where to go", async () => {
    const out = await call("POST", `/api/cloud/machines/${a3.id}/resume`);
    assert.equal(out.status, 402);
    assert.equal(out.json.error, "out_of_hours");
    assert.match(out.json.message, /\/app\/account\/billing$/);
    const b = machine("u_b", { state: "archived" });
    const none = await call("POST", `/api/cloud/machines/${b.id}/resume`);
    assert.equal(none.status, 402);
    assert.equal(none.json.error, "no_plan");
    assert.equal(callsTo("POST", `/sandboxes/${a3.id}/resume`).length + callsTo("POST", `/sandboxes/${b.id}/resume`).length, 0);
  });

  test("with overage on, Stripe gets only the new minutes past the hours", async () => {
    await db.query(`update cloud_billing set overage = true where id = 'b_a'`);
    for (const s of [a1, a2]) s.state = "ready";
    a1.usageSeconds = STARTER + 30 * 60 + 59;
    await beat(a1);
    assert.deepEqual(
      stripe.events.map(({ event_name, customer, value, identifier }) => ({ event_name, customer, value, identifier })),
      [{ event_name: "dray_cloud_overage_minutes", customer: "cus_a", value: 30, identifier: `u_a:${periodStart.getTime() / 1000}:30` }],
    );
    a1.usageSeconds += 5 * 60;
    await beat(a1);
    await beat(a1);
    assert.deepEqual(stripe.events.map((e) => e.value), [30, 5]);
    assert.equal(stripe.events[1].identifier, `u_a:${periodStart.getTime() / 1000}:35`);
    const { reportedMinutes, reportedFor } = await billing();
    assert.equal(reportedMinutes, 35);
    assert.equal(reportedFor.getTime(), periodStart.getTime());
    assert.ok(stripe.events.every((e) => e.timestamp < periodEnd.getTime() / 1000));
    assert.equal(a1.ttlSeconds, 900);
  });

  test("a report Stripe refuses is sent again on the next beat", async () => {
    a1.usageSeconds += 2 * 60;
    stripe.refuseNext();
    await beat(a1);
    assert.equal(stripe.events.length, 2);
    assert.equal((await billing()).reportedMinutes, 35);
    await beat(a1);
    assert.deepEqual(stripe.events.map((e) => e.value), [30, 5, 2]);
  });

  test("a report whose answer is lost is sent again as is, never folded into a bigger one", async () => {
    a1.usageSeconds += 3 * 60;
    stripe.loseAnswers(Infinity);
    await beat(a1);
    stripe.loseAnswers(0);
    const pending = await billing();
    assert.equal(pending.reportedMinutes, 37);
    assert.equal(pending.pendingTotal, 40);
    a1.usageSeconds += 60;
    await beat(a1);
    // Stripe kept the lost one once; the retry carried its identifier, then 1 more.
    assert.deepEqual(stripe.events.map((e) => [e.value, e.identifier.split(":").pop()]), [
      [30, "30"], [5, "35"], [2, "37"], [3, "40"], [1, "41"],
    ]);
    const after = await billing();
    assert.equal(after.reportedMinutes, 41);
    assert.equal(after.pendingTotal, null);
  });

  test("a cap bills up to itself and then stops the machines", async () => {
    // $1 at $0.20 an hour is 300 minutes.
    await db.query(`update cloud_billing set "overageCapCents" = 100 where id = 'b_a'`);
    a1.usageSeconds = STARTER + 400 * 60;
    const stopsBefore = callsTo("POST", `/sandboxes/${a2.id}/stop`).length;
    await beat(a1);
    assert.deepEqual(stripe.events.map((e) => e.value), [30, 5, 2, 3, 1, 259]);
    assert.equal(callsTo("POST", `/sandboxes/${a2.id}/stop`).length, stopsBefore + 1);
  });

  test("delete reads a machine's meter before boat forgets it, and waits when it can't", async () => {
    a2.usageFails = true;
    const refused = await call("DELETE", `/api/cloud/machines/${a2.id}`);
    assert.equal(refused.status, 503);
    assert.equal(refused.json.error, "usage_unread");
    assert.ok(boat.sandboxes.has(a2.id));
    a2.usageFails = false;
    a2.usageSeconds = 90;
    assert.equal((await call("DELETE", `/api/cloud/machines/${a2.id}`)).status, 204);
    const order = boat.calls.filter((c) => c.path.startsWith(`/sandboxes/${a2.id}`)).map((c) => `${c.method} ${c.path}`);
    assert.ok(
      order.lastIndexOf(`GET /sandboxes/${a2.id}/usage`) < order.indexOf(`DELETE /sandboxes/${a2.id}`),
      order.join("\n"),
    );
    assert.equal((await usage(a2.id)).seconds, 90);
  });

  test("the sweep wants the cron secret, reads what beats missed and skips settled machines", async () => {
    assert.equal((await call("GET", "/api/cloud/meter", { key: "nope" })).status, 401);
    await db.query(`update cloud_billing set "overageCapCents" = null where id = 'b_a'`);
    a1.state = "archived";
    a1.usageSeconds += 60;
    const before = callsTo("GET", `/sandboxes/${a1.id}/usage`).length;
    const first = await call("GET", "/api/cloud/meter", { key: CRON });
    assert.equal(first.status, 200);
    assert.equal(callsTo("GET", `/sandboxes/${a1.id}/usage`).length, before + 1, "its last reading said running");
    assert.equal((await usage(a1.id)).running, false);
    const second = await call("GET", "/api/cloud/meter", { key: CRON });
    assert.equal(callsTo("GET", `/sandboxes/${a1.id}/usage`).length, before + 1, "read stopped, so settled");
    assert.ok(second.json.read < first.json.read);
    // A resume makes it count again, so a run with no heartbeat is still read.
    assert.equal((await call("POST", `/api/cloud/machines/${a1.id}/resume`)).status, 200);
    assert.equal((await usage(a1.id)).running, true);
    a1.state = "archived";
    await call("GET", "/api/cloud/meter", { key: CRON });
    assert.equal(callsTo("GET", `/sandboxes/${a1.id}/usage`).length, before + 2);
  });

  test("the webhook takes only signed events and mirrors the subscription fresh", async () => {
    const bad = await call("POST", "/api/billing/webhook", { body: "{}", headers: { "stripe-signature": "t=1,v1=00" } });
    assert.equal(bad.status, 400);
    const nextStart = Math.floor(periodEnd.getTime() / 1000);
    stripe.subscriptions.set("sub_a", {
      id: "sub_a",
      object: "subscription",
      customer: "cus_a",
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      items: {
        data: [
          { id: "si_o", price: { id: "price_o", lookup_key: "dray_cloud_overage" }, current_period_start: nextStart, current_period_end: nextStart + 30 * 86400 },
          { id: "si_p", price: { id: "price_p", lookup_key: "dray_cloud_pro" }, current_period_start: nextStart, current_period_end: nextStart + 30 * 86400 },
        ],
      },
    });
    // The event's own copy is stale on purpose: the route must read Stripe.
    const payload = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_a", object: "subscription", status: "incomplete" } },
    });
    // A machine still running when the period turns over is read up to the
    // old period's end before the row moves on.
    const a4 = machine("u_a", { usageSeconds: 5 });
    await beat(a4);
    const readsBefore = callsTo("GET", `/sandboxes/${a4.id}/usage`).length;
    const ok = await webhook(payload);
    assert.equal(ok.status, 200);
    const finishing = callsTo("GET", `/sandboxes/${a4.id}/usage`);
    assert.equal(finishing.length, readsBefore + 1);
    assert.equal(new URLSearchParams(finishing.at(-1).query).get("since"), periodStart.toISOString());
    const row = await billing();
    assert.equal(row.plan, "pro");
    assert.equal(row.status, "active");
    assert.equal(row.periodStart.getTime(), nextStart * 1000);
    // A new period starts from nothing used and nothing reported.
    a3.state = "archived";
    const resumed = await call("POST", `/api/cloud/machines/${a3.id}/resume`);
    assert.equal(resumed.status, 200);
  });

  test("a second paying subscription on one account is cancelled, not followed", async () => {
    const dup = structuredClone(stripe.subscriptions.get("sub_a"));
    dup.id = "sub_dup";
    stripe.subscriptions.set("sub_dup", dup);
    const payload = JSON.stringify({
      id: "evt_2",
      object: "event",
      type: "customer.subscription.created",
      data: { object: { id: "sub_dup", object: "subscription" } },
    });
    assert.equal((await webhook(payload)).status, 200);
    assert.deepEqual(stripe.cancelled, [{ id: "sub_dup", prorate: "true" }]);
    assert.equal((await billing()).stripeSubscriptionId, "sub_a");
  });

  test("webhooks racing on one customer all finish, more of them than the pool has connections", async () => {
    const payload = JSON.stringify({
      id: "evt_3",
      object: "event",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_a", object: "subscription" } },
    });
    const answers = await Promise.all(Array.from({ length: 8 }, () => webhook(payload)));
    assert.deepEqual(answers.map((a) => a.status), Array(8).fill(200));
    assert.equal((await billing()).plan, "pro");
  });
});
