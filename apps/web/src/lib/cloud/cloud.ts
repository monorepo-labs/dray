import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { boat, BoatError, listByLabel, type Sandbox } from "./boat";
import { machineLogins } from "./agent-logins";
import { bind, isSlug, KEY_LABEL, mint, readKey, RepoRefused } from "./github";
import { GitHubError } from "./github-app";
import { NotConnected } from "./github-store";

/// Dray Cloud's control plane: one boat sandbox per task, each labelled
/// `dray=cloud` and listed by label, so no machine is kept in a table. The
/// contract is issue #857; each user's GitHub link and agent logins (#1013)
/// are the only rows, read at create and at a token mint.

const PORT = 7317;
const TTL_SECONDS = 900;
const LABEL = { dray: "cloud" };
const SNAPSHOT = "dray-cloud";
const SANDBOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export type State = "starting" | "running" | "stopping" | "stopped" | "error";
export type Machine = { id: string; state: State; url: string | null };

const STATES: Record<string, State> = {
  init: "starting",
  provisioning: "starting",
  provisioned: "starting",
  cloning: "starting",
  ready: "running",
  idle: "running",
  running: "running",
  archiving: "stopping",
  archived: "stopped",
  error: "error",
  cancelled: "error",
};

/// An unknown boat state reads as starting: the app keeps waiting on it,
/// where `error` would make it give up on a machine that may be fine.
const stateOf = (s: Sandbox): State => STATES[s.state ?? ""] ?? "starting";

/// `url` is null until boat assigns the sandbox its subdomain; a fork's first
/// answer can come before that.
function machine(s: Sandbox, subdomain = s.subdomain): Machine {
  return {
    id: s.id,
    state: stateOf(s),
    url: subdomain ? `wss://${subdomain}-${PORT}.on.boat.dev` : null,
  };
}

/// Derived, never stored. A machine holds both values from its create on, and
/// forks and resumes keep them, so changing `DRAY_CLOUD_SECRET` strands the
/// whole pool: rotating means deleting every `dray=cloud` sandbox with it.
const derive = (secret: string, what: string) =>
  createHmac("sha256", secret).update(what).digest("hex");

function same(a: string, b: string) {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function bearer(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

const error = (status: number, error: string, message?: string) =>
  Response.json(message ? { error, message } : { error }, { status });

type Secrets = { serveToken: string; machineSecret: string; keySecret: string };
/// `key` routes take a machine's own credential and check it themselves.
type Who = "client" | "machine" | "key";

/// Wraps a route: 404 while `DRAY_CLOUD_KEY` is unset, 401 for the wrong
/// bearer, and boat's failures turned into an answer. Env is read per request
/// so a route never caches a value from build time.
export function route<C>(
  who: Who,
  handler: (req: Request, secrets: Secrets, ctx: C) => Promise<Response>,
) {
  return async (req: Request, ctx: C) => {
    const key = process.env.DRAY_CLOUD_KEY;
    if (!key) return new Response(null, { status: 404 });
    const secret = process.env.DRAY_CLOUD_SECRET;
    if (!secret || !process.env.BOAT_API_KEY) return error(500, "misconfigured");
    const secrets = {
      serveToken: derive(secret, "serve-token"),
      machineSecret: derive(secret, "machine"),
      keySecret: derive(secret, "machine-key"),
    };
    if (who !== "key" && !same(bearer(req), who === "client" ? key : secrets.machineSecret)) {
      return error(401, "unauthorized");
    }
    try {
      return await handler(req, secrets, ctx);
    } catch (e) {
      // Something the user can fix on GitHub's side, said in full on the task.
      if (e instanceof NotConnected || e instanceof RepoRefused) return error(409, "github", e.message);
      if (e instanceof GitHubError) {
        console.error(`github ${e.status}: ${e.message}`);
        return error(502, "github_failed", e.message);
      }
      if (!(e instanceof BoatError)) throw e;
      console.error(`boat ${e.status} ${e.code}: ${e.message}`);
      // A missing sandbox, a state conflict and a start limit mean something
      // to the client; anything else is boat or this key failing.
      const status = [404, 409, 429].includes(e.status) ? e.status : 502;
      return error(status, e.code, e.message);
    }
  };
}

/// Boat reports a cancelled create once and then forgets it, so it is no machine.
const listMachines = async () =>
  (await listByLabel("dray=cloud")).filter((s) => s.state !== "cancelled");

/// A labelled sandbox by id, or null. Read off the label list rather than
/// `GET /sandboxes/{id}`, so a sandbox this key made for anything else is
/// never touched.
async function find(id: string) {
  if (!SANDBOX_ID.test(id)) return null;
  return (await listMachines()).find((s) => s.id === id) ?? null;
}

export async function machines(serveToken: string) {
  const all = await listMachines();
  return { token: serveToken, machines: all.map((s) => machine(s)) };
}

/// Who a create is for. Per-user access replaces this with the caller's own
/// account; until then the one shared key acts for `DRAY_CLOUD_OWNER`, a user
/// id, and with none set a machine gets no GitHub access of its own.
const owner = () => process.env.DRAY_CLOUD_OWNER || null;

/// A new machine for one task, created from the saved snapshot. Never shared,
/// so a task's checkout, agents and memory are its own. With `repo`, the
/// machine is bound to it and to the owner's GitHub link before boat is asked.
export async function startMachine(req: Request, origin: string, secrets: Secrets): Promise<Response> {
  const body = await req.json().catch(() => null);
  const repo = body?.repo;
  if (repo !== undefined && !isSlug(repo)) return error(400, "invalid_repo");
  const user = owner();
  const github = repo && user ? { ...(await bind(user, repo, secrets.keySecret)), repo } : null;
  const logins = user ? await machineLogins(user) : null;
  return Response.json({ machine: await create(origin, secrets, github, logins) });
}

type Bound = Awaited<ReturnType<typeof bind>> & { repo: string };

async function create(
  origin: string,
  { serveToken, machineSecret }: Secrets,
  github: Bound | null,
  logins: Record<string, unknown> | null,
) {
  const cloud: Record<string, unknown> = { url: `${origin}/api/cloud`, secret: machineSecret };
  if (github) {
    cloud.key = github.key;
    cloud.github = { repo: github.repo, author: github.author };
  }
  const res = await boat<{ sandbox: Sandbox; hostedPorts?: { url?: string; error?: string }[] }>(
    "POST",
    "/sandboxes",
    {
      from: SNAPSHOT,
      noEnv: true,
      labels: github ? { ...LABEL, [KEY_LABEL]: github.nonce } : LABEL,
      ttlSeconds: TTL_SECONDS,
      hostedPorts: [{ port: PORT, public: true, localhost: true }],
      files: [
        { path: ".dray/serve-token", content: serveToken },
        {
          path: ".dray/cloud.json",
          content: JSON.stringify(cloud),
        },
        // The user's own agent logins, on their own machine alone.
        ...(logins ? [{ path: ".dray/agent-logins.json", content: JSON.stringify(logins) }] : []),
      ],
    },
    true,
  );
  const hosted = res.hostedPorts?.[0];
  // Always, not only where hosting failed: a create's `localhost` relay never
  // starts (the sandbox's relay list stays `[]`), so the URL answers 502 until
  // the port is hosted again on the running machine (#1003).
  hostWhenUp(res.sandbox.id);
  const fromUrl = hosted?.url?.match(/^https:\/\/([a-z0-9-]+)-\d+\.on\.boat\.dev/)?.[1];
  return machine(res.sandbox, res.sandbox.subdomain ?? fromUrl);
}

async function resume(s: Sandbox) {
  const res = await boat<{ sandbox?: Sandbox | null }>("POST", `/sandboxes/${s.id}/resume`, {
    ttlSeconds: TTL_SECONDS,
  });
  // Boat keeps a hosted port across a resume, so this is only a repair: a
  // create whose hosting failed gets a second chance on its next start.
  hostWhenUp(s.id);
  return machine({ ...s, state: res.sandbox?.state ?? "provisioning" });
}

/// Hosts the serve port once the sandbox has a machine, after the answer has
/// gone: boat refuses to host a port on a sandbox still provisioning.
function hostWhenUp(id: string) {
  after(async () => {
    try {
      for (let i = 0; i < 30; i++) {
        const { sandbox } = await boat<{ sandbox: Sandbox }>("GET", `/sandboxes/${id}`);
        const state = stateOf(sandbox);
        if (state === "running") {
          await boat("POST", `/sandboxes/${id}/host`, { port: PORT, public: true, localhost: true });
          return;
        }
        if (state !== "starting") return;
        await new Promise((r) => setTimeout(r, 2000));
      }
      console.error(`boat ${id}: still starting after 60s, port ${PORT} not hosted`);
    } catch (e) {
      console.error(`boat ${id}: hosting port ${PORT} failed`, e);
    }
  });
}

export async function resumeMachine(id: string): Promise<Response> {
  const s = await find(id);
  if (!s) return error(404, "not_found");
  const state = stateOf(s);
  if (state === "running" || state === "starting") return Response.json({ machine: machine(s) });
  return Response.json({ machine: await resume(s) });
}

export async function stopMachine(id: string): Promise<Response> {
  const s = await find(id);
  if (!s) return error(404, "not_found");
  const res = await boat<{ sandbox?: Sandbox | null }>("POST", `/sandboxes/${s.id}/stop`);
  return Response.json({ machine: machine({ ...s, state: res.sandbox?.state ?? "archiving" }) });
}

/// Deletes a settled task's machine for good. One already gone answers the
/// same, so the app can ask again after a failure without reading the list.
export async function deleteMachine(id: string): Promise<Response> {
  const s = await find(id);
  if (s) {
    // Boat refuses a delete whose confirm header does not name the sandbox.
    await boat("DELETE", `/sandboxes/${s.id}`, undefined, false, { "X-Ascii-Confirm-Delete": s.id });
  }
  return new Response(null, { status: 204 });
}

/// A busy machine pushes its auto-stop out again; an idle one lets it run.
export async function heartbeat(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (typeof body?.sandbox !== "string" || typeof body?.busy !== "boolean") {
    return error(400, "invalid_body");
  }
  if (body.busy) {
    const s = await find(body.sandbox);
    if (s && ["starting", "running"].includes(stateOf(s))) {
      await boat("PATCH", `/sandboxes/${s.id}`, { ttlSeconds: TTL_SECONDS });
    }
  }
  return new Response(null, { status: 204 });
}

/// Trades a machine's credential for an hour-long token on its one repo. The
/// credential must be signed by this control plane and its sandbox still be
/// alive, so a deleted machine's copy is dead even if read off its disk.
export async function githubToken(req: Request, { keySecret }: Secrets): Promise<Response> {
  const claims = readKey(bearer(req), keySecret);
  if (!claims) return error(401, "unauthorized");
  const alive = (await listByLabel(`${KEY_LABEL}=${claims.n}`)).some(
    (s) => s.labels?.dray === "cloud" && s.state !== "cancelled",
  );
  if (!alive) return error(401, "unauthorized");
  const { token, expiresAt } = await mint(claims);
  return Response.json({ token, expiresAt, repo: claims.r });
}
