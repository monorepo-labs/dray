import { createVerify } from "node:crypto";
import { createServer } from "node:http";

/// A stand-in for GitHub's REST API and OAuth token endpoint, enough for the
/// Dray GitHub App (#1013). It checks the app JWT against `publicKey`, refuses
/// a token request for a repo outside the installation, and rotates refresh
/// tokens single-use the way GitHub does, so a refresh race fails here too.

export async function fakeGitHub({ appId, clientId, clientSecret, publicKey }) {
  const calls = [];
  // installation id -> { account, repos: Set<"owner/name"> }
  const installations = new Map();
  // GitHub user id -> { login, push: Set<"owner/name"> }
  const users = new Map();
  const codes = new Map(); // code -> user id
  const access = new Map(); // access token -> { user, expiresAt }
  const refresh = new Map(); // refresh token -> user id, deleted on use
  // "owner/name" -> repo id. A rename keeps the id; a new repo at a freed
  // name gets a fresh one, as on GitHub.
  const ids = new Map();
  let nextRepo = 1000;
  const idOf = (slug) => {
    if (!ids.has(slug)) ids.set(slug, nextRepo++);
    return ids.get(slug);
  };
  const slugOf = (id) => [...ids].find(([, v]) => v === id)?.[0];
  let n = 0;

  function issue(user, accessLife = 28800) {
    n++;
    const a = `ghu_${n}`;
    const r = `ghr_${n}`;
    access.set(a, { user, expiresAt: Date.now() + accessLife * 1000 });
    refresh.set(r, user);
    return { access_token: a, expires_in: accessLife, refresh_token: r, refresh_token_expires_in: 15897600, token_type: "bearer" };
  }

  function appJwtOk(auth) {
    const jwt = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const [head, body, sig] = jwt.split(".");
    if (!sig) return false;
    const ok = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(sig, "base64url"));
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const now = Date.now() / 1000;
    return ok && claims.iss === appId && claims.exp > now && claims.exp - claims.iat <= 600;
  }

  const userOf = (auth) => {
    const t = access.get(auth?.startsWith("Bearer ") ? auth.slice(7) : "");
    return t && t.expiresAt > Date.now() ? t.user : null;
  };

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://github");
    const body = raw ? JSON.parse(raw) : undefined;
    const call = { method: req.method, path: url.pathname, body };
    calls.push(call);
    const ok = (status, json) => {
      call.status = status;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const auth = req.headers.authorization;

    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      if (body.client_id !== clientId || body.client_secret !== clientSecret) return ok(200, { error: "incorrect_client_credentials" });
      if (body.grant_type === "refresh_token") {
        // Slow, like a real round trip, so callers racing a refresh overlap.
        await new Promise((r) => setTimeout(r, 300));
        const user = refresh.get(body.refresh_token);
        if (user === undefined) return ok(200, { error: "bad_refresh_token" });
        refresh.delete(body.refresh_token);
        return ok(200, issue(user));
      }
      const user = codes.get(body.code);
      if (user === undefined) return ok(200, { error: "bad_verification_code" });
      codes.delete(body.code);
      return ok(200, issue(user));
    }

    if (url.pathname === "/user" && req.method === "GET") {
      const user = userOf(auth);
      if (user === null) return ok(401, { message: "Bad credentials" });
      return ok(200, { id: user, login: users.get(user).login });
    }

    let m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
    if (m && req.method === "GET") {
      if (!appJwtOk(auth)) return ok(401, { message: "A JSON web token could not be decoded" });
      for (const [id, i] of installations) if (i.repos.has(m[1])) return ok(200, { id, account: { login: i.account } });
      return ok(404, { message: "Not Found" });
    }

    m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/) ?? url.pathname.match(/^\/repositories\/(\d+)$/);
    if (m && req.method === "GET") {
      const user = userOf(auth);
      if (user === null) return ok(401, { message: "Bad credentials" });
      const slug = /^\d+$/.test(m[1]) ? slugOf(Number(m[1])) : m[1];
      // A user-to-server token sees only repos the app is installed on.
      const installed = slug && [...installations.values()].some((i) => i.repos.has(slug));
      if (!installed) return ok(404, { message: "Not Found" });
      return ok(200, { id: idOf(slug), full_name: slug, permissions: { pull: true, push: users.get(user).push.has(slug) } });
    }

    m = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (m && req.method === "POST") {
      if (!appJwtOk(auth)) return ok(401, { message: "A JSON web token could not be decoded" });
      const i = installations.get(Number(m[1]));
      if (!i) return ok(404, { message: "Not Found" });
      const held = new Set([...i.repos].map(idOf));
      if (body.repositories || !body.repository_ids?.every((r) => held.has(r))) {
        return ok(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      }
      n++;
      const repositories = body.repository_ids.map((id) => ({ id, full_name: slugOf(id) }));
      return ok(201, { token: `ghs_${n}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions, repositories });
    }

    m = url.pathname.match(/^\/applications\/([^/]+)\/grant$/);
    if (m && req.method === "DELETE") {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      if (auth !== `Basic ${basic}` || m[1] !== clientId) return ok(401, { message: "Bad credentials" });
      for (const [t, v] of access) if (t === body.access_token) access.delete(t), void v;
      return ok(204);
    }

    return ok(404, { message: "Not Found" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    installations,
    users,
    /// A code GitHub would hand the browser after `user` authorizes the app.
    code(user) {
      const c = `code_${++n}`;
      codes.set(c, user);
      return c;
    },
    idOf,
    /// Renames a repo: same id, new name, its installation and push access move
    /// with it, and the old name is free for a new repo.
    rename(from, to) {
      const id = idOf(from);
      ids.delete(from);
      ids.set(to, id);
      for (const i of installations.values()) if (i.repos.delete(from)) i.repos.add(to);
      for (const u of users.values()) if (u.push.delete(from)) u.push.add(to);
    },
    /// Ages every user token past expiry, so the next use must refresh.
    expireUserTokens() {
      for (const t of access.values()) t.expiresAt = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
