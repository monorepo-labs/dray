import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { fakeBoat } from "./fake-boat.mjs";
import { fakeGitHub } from "./fake-github.mjs";
import { nextDev } from "./next-dev.mjs";

/// Dray Cloud's per-user logins (#1013) — repo access through the Dray GitHub
/// App, and agent logins — under a real `next dev` against a faked boat and GitHub. Needs a scratch Postgres it may
/// migrate and write to: `TEST_DATABASE_URL=postgres://… pnpm test`.

const DB = process.env.TEST_DATABASE_URL;
const KEY = "client-key";
const BOAT_KEY = "boat_test";
const ORG = "dray-cloud-org";
const AUTH_SECRET = "auth-secret-auth-secret-auth-secret";
const CLIENT_ID = "Iv1.test";
const CLIENT_SECRET = "client-secret";
const USER = `test-${randomBytes(4).toString("hex")}`;
const SESSION = randomBytes(16).toString("hex");
const OCTO = 42;

describe("Dray Cloud logins", { skip: !DB && "set TEST_DATABASE_URL to a scratch Postgres" }, () => {
  let app, boat, gh, db, cookie;

  before(async () => {
    const env = { DATABASE_URL: DB, BETTER_AUTH_SECRET: AUTH_SECRET };
    const migrate = spawnSync("node_modules/.bin/auth", ["migrate", "--config", "src/lib/auth.ts", "-y"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);

    db = new pg.Client({ connectionString: DB });
    await db.connect();
    await db.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, 'Test', $2, true, now(), now())`,
      [USER, `${USER}@example.com`],
    );
    await db.query(
      `insert into session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
       values ($1, $2, $3, now() + interval '1 day', now(), now())`,
      [randomBytes(8).toString("hex"), SESSION, USER],
    );
    const sig = createHmac("sha256", AUTH_SECRET).update(SESSION).digest("base64");
    cookie = `better-auth.session_token=${encodeURIComponent(`${SESSION}.${sig}`)}`;

    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    gh = await fakeGitHub({
      appId: "123",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
    });
    gh.users.set(OCTO, { login: "octo", push: new Set(["acme/app"]) });
    gh.installations.set(7, { account: "acme", repos: new Set(["acme/app", "acme/readonly"]) });

    boat = await fakeBoat({ key: BOAT_KEY, org: ORG });
    app = await nextDev({
      ...env,
      DRAY_CLOUD_KEY: KEY,
      DRAY_CLOUD_SECRET: "cloud-secret",
      DRAY_CLOUD_OWNER: USER,
      DRAY_CLOUD_AGENT_LOGINS: "1",
      DRAY_VAULT_KEY: randomBytes(32).toString("base64"),
      BOAT_API_KEY: BOAT_KEY,
      BOAT_ORG: ORG,
      BOAT_API_URL: boat.url,
      GITHUB_API_URL: gh.url,
      GITHUB_WEB_URL: gh.url,
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "dray-test",
      GITHUB_APP_CLIENT_ID: CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
      // Flattened newlines, the way an env store keeps a PEM.
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n"),
    });
  });

  after(async () => {
    await app?.stop();
    await boat?.close();
    await gh?.close();
    if (db) {
      await db.query(`delete from "user" where id = $1`, [USER]);
      await db.end();
    }
  });

  const go = (path, opts = {}) => fetch(app.base + path, { redirect: "manual", ...opts });
  const call = async (method, path, { key = KEY, body } = {}) => {
    const res = await fetch(app.base + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const creates = () => boat.calls.filter((c) => c.method === "POST" && c.path === "/sandboxes");
  const cloudJson = (create) => JSON.parse(create.body.files.find((f) => f.path === ".dray/cloud.json").content);
  const row = async () => (await db.query(`select * from github_account where "userId" = $1`, [USER])).rows[0];

  let state;
  test("install sends a signed-in user to GitHub, anyone else to sign in", async () => {
    const anon = await go("/api/github/install");
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get("location"), /\/login\?next=%2Fapi%2Fgithub%2Finstall$/);

    const res = await go("/api/github/install", { headers: { cookie } });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("location"));
    assert.equal(`${to.origin}${to.pathname}`, `${gh.url}/apps/dray-test/installations/new`);
    state = to.searchParams.get("state");
    assert.match(state, /^dgs1\./);
  });

  test("a callback with a state not made for this user links nothing", async () => {
    const forged = `dgs1.${Buffer.from(JSON.stringify({ u: USER, exp: Date.now() + 1e6 })).toString("base64url")}.AAAA`;
    for (const s of [forged, ""]) {
      const res = await go(`/api/github/callback?code=${gh.code(OCTO)}&installation_id=7&state=${s}`, { headers: { cookie } });
      assert.match(res.headers.get("location"), /\/app\/account\?github=retry$/);
    }
    assert.equal(await row(), undefined);
  });

  test("the callback links the GitHub user, with the tokens sealed", async () => {
    const res = await go(`/api/github/callback?code=${gh.code(OCTO)}&installation_id=7&setup_action=install&state=${state}`, {
      headers: { cookie },
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /\/app\/account\?github=connected$/);
    const r = await row();
    assert.equal(r.login, "octo");
    assert.equal(r.githubId, OCTO);
    assert.match(r.accessToken, /^v1\./);
    assert.ok(!r.accessToken.includes("ghu_") && !r.refreshToken.includes("ghr_"));
  });

  test("create refuses a repo the user can't push to or the app isn't on, before boat", async () => {
    for (const repo of ["acme/readonly", "acme/elsewhere"]) {
      const { status, json } = await call("POST", "/api/cloud/machines", { body: { repo } });
      assert.equal(status, 409, repo);
      assert.equal(json.error, "github");
      assert.match(json.message, /octo can't push to/);
    }
    assert.equal((await call("POST", "/api/cloud/machines", { body: { repo: "../x" } })).status, 400);
    assert.equal(creates().length, 0);
  });

  let machine, key;
  test("create binds the machine to its repo and its user", async () => {
    const { status, json } = await call("POST", "/api/cloud/machines", { body: { repo: "acme/app" } });
    assert.equal(status, 200);
    machine = json.machine.id;
    const [create] = creates();
    const nonce = create.body.labels["dray-key"];
    assert.match(nonce, /^[0-9a-f]{24}$/);
    assert.equal(create.body.labels.dray, "cloud");
    const cloud = cloudJson(create);
    key = cloud.key;
    assert.match(key, /^dmk1\./);
    assert.deepEqual(cloud.github, {
      repo: "acme/app",
      author: { name: "octo", email: "42+octo@users.noreply.github.com" },
    });
  });

  test("the machine trades its key for a token on its one repo", async () => {
    const { status, json } = await call("POST", "/api/cloud/github/token", { key });
    assert.equal(status, 200);
    assert.match(json.token, /^ghs_/);
    assert.equal(json.repo, "acme/app");
    assert.ok(Date.parse(json.expiresAt) > Date.now());
    const mint = gh.calls.filter((c) => c.path === "/app/installations/7/access_tokens").at(-1);
    assert.deepEqual(mint.body.repository_ids, [gh.idOf("acme/app")]);
    assert.equal(mint.body.permissions.contents, "write");
    assert.equal(mint.body.permissions.workflows, undefined);
  });

  test("an expired user token is refreshed once, however many machines ask", async () => {
    const second = await call("POST", "/api/cloud/machines", { body: { repo: "acme/app" } });
    const otherKey = cloudJson(creates().at(-1)).key;
    assert.equal(second.status, 200);
    await db.query(`update github_account set "accessExpiresAt" = now() - interval '1 minute' where "userId" = $1`, [USER]);
    gh.expireUserTokens();
    const refreshes = () => gh.calls.filter((c) => c.path === "/login/oauth/access_token" && c.body.grant_type).length;
    const before = refreshes();
    const answers = await Promise.all([key, otherKey, key].map((k) => call("POST", "/api/cloud/github/token", { key: k })));
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200]);
    assert.equal(refreshes() - before, 1);
  });

  test("a forged key, the shared secrets and a deleted machine's key get nothing", async () => {
    const [p, body] = key.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const other = Buffer.from(JSON.stringify({ ...claims, r: "acme/readonly" })).toString("base64url");
    for (const k of [`${p}.${other}.${key.split(".")[2]}`, KEY, "", "dmk1.x.y"]) {
      assert.equal((await call("POST", "/api/cloud/github/token", { key: k })).status, 401, k);
    }
    assert.equal((await call("DELETE", `/api/cloud/machines/${machine}`)).status, 204);
    assert.equal((await call("POST", "/api/cloud/github/token", { key })).status, 401);
  });

  test("losing push access on GitHub stops the mint", async () => {
    const live = cloudJson(creates().at(-1)).key;
    gh.users.get(OCTO).push.delete("acme/app");
    const { status, json } = await call("POST", "/api/cloud/github/token", { key: live });
    assert.equal(status, 409);
    assert.match(json.message, /can no longer push to acme\/app/);
    gh.users.get(OCTO).push.add("acme/app");
  });

  test("a renamed repo's name, taken by a new repo, is never reached", async () => {
    await call("POST", "/api/cloud/machines", { body: { repo: "acme/app" } });
    const bound = cloudJson(creates().at(-1)).key;
    const original = gh.idOf("acme/app");
    gh.rename("acme/app", "other/app");
    gh.installations.get(7).repos.add("acme/app");
    const newcomer = gh.idOf("acme/app");
    assert.notEqual(newcomer, original);

    const { status } = await call("POST", "/api/cloud/github/token", { key: bound });
    assert.equal(status, 200);
    const mint = gh.calls.filter((c) => c.path === "/app/installations/7/access_tokens").at(-1);
    assert.deepEqual(mint.body.repository_ids, [original]);

    gh.installations.get(7).repos.delete("acme/app");
    gh.rename("other/app", "acme/app");
    assert.equal(gh.idOf("acme/app"), original);
  });

  test("the app leaving the repo stops the mint, said plainly", async () => {
    const live = cloudJson(creates().at(-1)).key;
    gh.installations.get(7).repos.delete("acme/app");
    gh.installations.set(8, { account: "acme", repos: new Set(["acme/app"]) });
    const { status, json } = await call("POST", "/api/cloud/github/token", { key: live });
    assert.equal(status, 409);
    assert.match(json.message, /no longer reaches acme\/app/);
    gh.installations.delete(8);
    gh.installations.get(7).repos.add("acme/app");
  });

  test("disconnecting ends the grant and every machine's mint", async () => {
    const live = cloudJson(creates().at(-1)).key;
    assert.equal((await go("/api/github/disconnect", { method: "POST" })).status, 401);
    assert.equal((await go("/api/github/disconnect", { method: "POST", headers: { cookie } })).status, 204);
    assert.equal(await row(), undefined);
    assert.ok(gh.calls.some((c) => c.method === "DELETE" && c.path === `/applications/${CLIENT_ID}/grant` && c.status === 204));
    const { status, json } = await call("POST", "/api/cloud/github/token", { key: live });
    assert.equal(status, 409);
    assert.match(json.message, /Connect GitHub/);
  });

  const CLAUDE = `sk-ant-oat01-${"a1B2_c3-".repeat(6)}wxyz`;
  const agents = (method, path, body, headers = { cookie }) =>
    fetch(app.base + path, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("a Claude login is kept sealed and shown by its last four alone", async () => {
    assert.equal((await agents("PUT", "/api/agents/claude", { token: CLAUDE }, {})).status, 401);
    const bad = await agents("PUT", "/api/agents/claude", { token: "sk-ant-api03-not-a-setup-token" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).message, /claude setup-token/);
    assert.equal((await agents("PUT", "/api/agents/codex", { token: CLAUDE })).status, 404);
    assert.equal((await agents("PUT", "/api/agents/claude", { token: ` ${CLAUDE}\n` })).status, 204);

    const { rows } = await db.query(`select * from agent_login where "userId" = $1`, [USER]);
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].secret.includes("sk-ant"));
    const listed = await (await agents("GET", "/api/agents")).json();
    assert.deepEqual(listed.logins.map(({ agent, hint }) => ({ agent, hint })), [{ agent: "claude", hint: "wxyz" }]);
    assert.ok(!JSON.stringify(listed).includes("sk-ant"));
  });

  test("each new machine gets the owner's agent logins, until they disconnect", async () => {
    const { status } = await call("POST", "/api/cloud/machines");
    assert.equal(status, 200);
    const file = creates().at(-1).body.files.find((f) => f.path === ".dray/agent-logins.json");
    assert.deepEqual(JSON.parse(file.content), { claude: { oauthToken: CLAUDE } });

    assert.equal((await agents("DELETE", "/api/agents/claude")).status, 204);
    await call("POST", "/api/cloud/machines");
    assert.ok(!creates().at(-1).body.files.some((f) => f.path === ".dray/agent-logins.json"));
  });
});
