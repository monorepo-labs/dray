import { createServer } from "node:http";

/// A stand-in for boat's API (https://docs.boat.dev/api/v1), enough for the
/// Dray Cloud control plane. It refuses what boat's OpenAPI file refuses —
/// an unknown body key, a missing bearer, a bad file entry — so a call drifting
/// from the spec fails here rather than in production.

const CREATE_KEYS = new Set([
  "type", "ttlSeconds", "labels", "env", "environment", "noEnv", "snapshots", "monitoring",
  "failFast", "count", "setupScript", "name", "visibility", "hostedPorts", "files", "org", "teamId", "from",
]);
const FORK_KEYS = new Set(["labels", "failFast", "monitoring", "env", "environment", "noEnv", "type", "ttlSeconds"]);
const RESUME_KEYS = new Set(["failFast", "type", "env", "environment", "noEnv", "ttlSeconds"]);
const HOST_KEYS = new Set(["port", "public", "localhost", "title"]);
const PATCH_KEYS = new Set(["name", "ttlSeconds", "subdomain"]);
const STOP_KEYS = new Set(["force"]);
const RUNNING = new Set(["ready", "idle", "running"]);

const words = ["frazil", "pneuma", "rallye", "otter", "swift", "harbor", "lumen", "quill"];
const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";

/// Starts the fake. `key` is the bearer it accepts, `org` the `X-Boat-Org` it
/// expects on list and create. Every call lands in `calls`.
export async function fakeBoat({ key, org, pageSize = 2 }) {
  const sandboxes = new Map();
  const calls = [];
  let n = 0;
  let drops = 0;
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const now = () => new Date((clock += 1000)).toISOString();
  const mint = () => {
    n++;
    let id = "bx_";
    for (let i = 0; i < 8; i++) id += alphabet[(n * 7 + i * 3) % alphabet.length];
    return id;
  };

  function add(fields) {
    const id = mint();
    const s = {
      id,
      name: `Sandbox ${n}`,
      state: "provisioning",
      labels: {},
      subdomain: `${words[n % words.length]}-${words[(n + 3) % words.length]}-${n}`,
      createdAt: now(),
      stoppedAt: null,
      dataExpiredAt: null,
      ttlSeconds: 3600,
      hosted: [],
      desktopAvailable: false,
      snapshotAvailable: false,
      ...fields,
    };
    sandboxes.set(id, s);
    return s;
  }

  const view = ({ hosted, files, ...s }) => s;
  const ok = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message = code) =>
    ok(res, status, { ok: false, type: "sandbox.error", status, code, message, error: { code, message, status }, requestId: "req_fake" });
  const unknown = (body, allowed) => Object.keys(body ?? {}).find((k) => !allowed.has(k));

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://boat");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return fail(res, 400, "invalid_json");
    }
    const call = { method: req.method, path, query: url.search, body, org: req.headers["x-boat-org"] };
    calls.push(call);
    res.on("finish", () => (call.status = res.statusCode));
    if (drops > 0) {
      drops--;
      return req.socket.destroy();
    }

    if (req.headers.authorization !== `Bearer ${key}`) return fail(res, 401, "unauthorized");

    if (path === "/sandboxes" && req.method === "GET") {
      if (req.headers["x-boat-org"] !== org) return fail(res, 400, "wrong_org");
      const known = new Set(["org", "limit", "cursor", "sort", "state", "name", "namePrefix", "stoppedBefore", "dataExpired", "label", "include"]);
      const bad = [...url.searchParams.keys()].find((k) => !known.has(k));
      if (bad) return fail(res, 400, "invalid_query", bad);
      const labels = url.searchParams.getAll("label").map((l) => l.split("="));
      const all = [...sandboxes.values()]
        .filter((s) => labels.every(([k, v]) => s.labels[k] === v))
        .reverse();
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = all.slice(start, start + pageSize);
      const hasMore = start + pageSize < all.length;
      return ok(res, 200, {
        ok: true,
        type: "sandbox.list",
        sandboxes: page.map(view),
        pageInfo: { nextCursor: hasMore ? String(start + pageSize) : null, hasMore, limit: pageSize },
      });
    }

    if (path === "/sandboxes" && req.method === "POST") {
      if (req.headers["x-boat-org"] !== org) return fail(res, 400, "wrong_org");
      const bad = unknown(body, CREATE_KEYS);
      if (bad) return fail(res, 400, "invalid_request", bad);
      if (body.from && body.from !== "dray-cloud") return fail(res, 404, "snapshot_not_found");
      for (const f of body.files ?? []) {
        if (typeof f.path !== "string" || typeof f.content !== "string") return fail(res, 400, "invalid_files");
      }
      for (const p of body.hostedPorts ?? []) {
        if (unknown(p, HOST_KEYS) || typeof p.port !== "number") return fail(res, 400, "invalid_hosted_ports");
      }
      const s = add({ labels: body.labels ?? {}, ttlSeconds: body.ttlSeconds, files: body.files ?? [], noEnv: body.noEnv });
      s.hosted = (body.hostedPorts ?? []).map((p) => ({ ...p }));
      return ok(res, 202, {
        ok: true,
        type: "sandbox.created",
        status: "provisioning",
        ttlSeconds: s.ttlSeconds,
        // A fresh create can answer before its subdomain is assigned.
        sandbox: { ...view(s), subdomain: null },
        hostedPorts: s.hosted.map((p) => ({
          port: p.port,
          url: `https://${s.subdomain}-${p.port}.on.boat.dev`,
          access: p.public ? "public" : "private",
          isProtected: !p.public,
          localhost: !!p.localhost,
        })),
      });
    }

    const m = path.match(/^\/sandboxes\/(bx_[a-z0-9]{8})(?:\/(fork|resume|stop|host|usage))?$/);
    const s = m && sandboxes.get(m[1]);
    if (!s) return fail(res, 404, "not_found");
    const action = m[2];

    if (action === "usage" && req.method === "GET") {
      const bad = [...url.searchParams.keys()].find((k) => k !== "since" && k !== "until");
      if (bad) return fail(res, 400, "invalid_query", bad);
      // A test sets `usageSeconds` to what boat's meter would read.
      return ok(res, 200, {
        ok: true,
        type: "sandbox.usage",
        sandboxId: s.id,
        sandboxType: "default",
        billingMultiplier: 1,
        since: url.searchParams.get("since") ?? s.createdAt,
        until: url.searchParams.get("until") ?? new Date(clock).toISOString(),
        seconds: s.usageSeconds ?? 0,
        dollars: (s.usageSeconds ?? 0) / 100000,
        secondsPerDollar: 100000,
        running: RUNNING.has(s.state) || s.state === "provisioning",
      });
    }

    if (!action && req.method === "GET") {
      // Each read moves a starting sandbox on, so a poll ends.
      if (s.state === "provisioning") s.state = "ready";
      return ok(res, 200, { ok: true, type: "sandbox.info", sandbox: view(s) });
    }
    if (!action && req.method === "DELETE") {
      // Boat takes a delete only where the confirm header names the sandbox.
      if (req.headers["x-ascii-confirm-delete"] !== s.id) return fail(res, 409, "delete_confirmation_required");
      sandboxes.delete(s.id);
      return ok(res, 202, {
        ok: true,
        type: "sandbox.deleting",
        operation: { id: `bdop_${"0".repeat(32)}`, kind: "sandbox", targetId: s.id, reason: "explicit", status: "pending" },
      });
    }
    if (!action && req.method === "PATCH") {
      const bad = unknown(body, PATCH_KEYS);
      if (bad) return fail(res, 400, "invalid_request", bad);
      if (body.ttlSeconds !== undefined) s.ttlSeconds = body.ttlSeconds;
      return ok(res, 200, { ok: true, type: "sandbox.updated", sandbox: view(s) });
    }
    if (req.method !== "POST") return fail(res, 405, "method_not_allowed");

    if (action === "fork") {
      const bad = unknown(body, FORK_KEYS);
      if (bad) return fail(res, 400, "invalid_request", bad);
      // The fork takes the disk, never the source's labels or hosted ports.
      const f = add({ labels: body?.labels ?? {}, ttlSeconds: body?.ttlSeconds ?? 3600, forkOf: s.id });
      return ok(res, 202, { ok: true, type: "sandbox.forking", id: f.id, status: "forking", sandbox: { ...view(f), subdomain: null } });
    }
    if (action === "resume") {
      const bad = unknown(body, RESUME_KEYS);
      if (bad) return fail(res, 400, "invalid_request", bad);
      if (s.dataExpiredAt) return fail(res, 409, "snapshot_data_expired");
      if (body?.ttlSeconds !== undefined) s.ttlSeconds = body.ttlSeconds;
      s.state = "provisioning";
      s.stoppedAt = null;
      return ok(res, 202, { ok: true, type: "sandbox.resuming", id: s.id, status: "resuming", sandbox: view(s) });
    }
    if (action === "stop") {
      const bad = unknown(body, STOP_KEYS);
      if (bad) return fail(res, 400, "invalid_request", bad);
      if (s.state === "archived") return ok(res, 200, { ok: true, type: "sandbox.stopped", id: s.id, status: "archived", sandbox: view(s) });
      s.state = "archiving";
      return ok(res, 202, { ok: true, type: "sandbox.stopping", id: s.id, status: "archiving", sandbox: view(s) });
    }
    if (action === "host") {
      const bad = unknown(body, HOST_KEYS);
      if (bad || typeof body?.port !== "number") return fail(res, 400, "invalid_request", bad);
      if (!RUNNING.has(s.state)) return fail(res, 400, "machine_not_running");
      s.hosted = [...s.hosted.filter((p) => p.port !== body.port), { ...body }];
      return ok(res, 200, { ok: true, type: "port.hosted", success: true, port: body.port, url: `https://${s.subdomain}-${body.port}.on.boat.dev`, access: body.public ? "public" : "private", isProtected: !body.public, localhost: !!body.localhost });
    }
    return fail(res, 404, "not_found");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/v1`,
    sandboxes,
    calls,
    add,
    now,
    /// Hangs up on the next call without answering, the way a refused
    /// connection or a dropped socket looks to fetch.
    dropNext: () => drops++,
    close: () => new Promise((r) => server.close(r)),
  };
}
