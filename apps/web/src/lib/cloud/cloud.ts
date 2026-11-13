import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { pool } from "@/lib/db";
import { hashSecret } from "@/lib/link";
import { boat, BoatError, listByLabel, type Sandbox } from "./boat";

/// Dray Cloud's control plane: one boat sandbox per task, each labelled
/// `dray=cloud` and listed by label, so nothing here keeps state. The contract
/// is issue #857.
///
/// A machine belongs to the account that started it, named by its `dray-user`
/// label. One without that label belongs to the shared `DRAY_CLOUD_KEY`,
/// which predates accounts and goes once its machines are gone.

const PORT = 7317;
const TTL_SECONDS = 900;
const LABEL = { dray: "cloud" };
const USER_LABEL = "dray-user";
const SNAPSHOT = "dray-cloud";
const SANDBOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export type State = "starting" | "running" | "stopping" | "stopped" | "error";
/// `token` is the serve token this machine holds: the caller's own, but for
/// a key machine an account took over (`DRAY_CLOUD_LEGACY_USER`).
export type Machine = { id: string; state: State; url: string | null; token: string };

/// Who a call acts for: an account's user id, or `null` for `DRAY_CLOUD_KEY`.
type Owner = string | null;

type Secrets = { serveToken: string; machineSecret: string };
type Who = "client" | "machine";
/// The owner a route acts for, its secrets, and the one they derive from.
export type Caller = { owner: Owner; secret: string } & Secrets;

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

const awake = (s: Sandbox) => ["starting", "running"].includes(stateOf(s));

const ownerOf = (s: Sandbox): Owner => s.labels?.[USER_LABEL] ?? null;

/// `url` is null until boat assigns the sandbox its subdomain; a fork's first
/// answer can come before that.
function machine(s: Sandbox, secret: string, subdomain = s.subdomain): Machine {
  return {
    id: s.id,
    state: stateOf(s),
    url: subdomain ? `wss://${subdomain}-${PORT}.on.boat.dev` : null,
    token: secretsFor(secret, ownerOf(s)).serveToken,
  };
}

/// Derived, never stored. A machine holds both values from its create on, and
/// forks and resumes keep them, so changing `DRAY_CLOUD_SECRET` strands the
/// whole pool: rotating means deleting every `dray=cloud` sandbox with it.
const derive = (secret: string, what: string) =>
  createHmac("sha256", secret).update(what).digest("hex");

/// Each owner's own pair, so a token read off one user's disk opens none of
/// another's machines. A heartbeat names only its sandbox, so a user's machine
/// secret carries the user ahead of a dot for the route to read and check.
/// The key's pair is what machines held before accounts, unchanged.
function secretsFor(secret: string, owner: Owner): Secrets {
  if (owner === null) return { serveToken: derive(secret, "serve-token"), machineSecret: derive(secret, "machine") };
  return {
    serveToken: derive(secret, `serve-token:user:${owner}`),
    machineSecret: `${owner}.${derive(secret, `machine:user:${owner}`)}`,
  };
}

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

/// Accounts may use Dray Cloud. Off until access and billing decide who may;
/// their check replaces this one.
const accountsOpen = () => process.env.DRAY_CLOUD_ACCOUNTS === "1";

/// The user who takes the key's machines over at the switch: signed in, they
/// list, resume and delete those beside their own. Unset once none are left.
const heir = () => process.env.DRAY_CLOUD_LEGACY_USER || null;

/// The most machines one owner may have awake at once, starting or running. A
/// stopped one costs disk alone and does not count. Billing replaces this
/// with each plan's own number.
const awakeCap = () => Number(process.env.DRAY_CLOUD_MAX_AWAKE) || 8;

/// The user a Dray app credential (#889's `app_session`) belongs to. Only a
/// `dra_` bearer reaches the database.
async function accountUser(token: string): Promise<string | null> {
  if (!token.startsWith("dra_")) return null;
  const { rows } = await pool.query<{ userId: string }>(`select "userId" from app_session where "tokenHash" = $1`, [
    hashSecret(token),
  ]);
  return rows[0]?.userId ?? null;
}

/// Who a client is: the key, or a signed-in account. A `Response` refuses.
async function client(token: string): Promise<Owner | Response> {
  const key = process.env.DRAY_CLOUD_KEY;
  if (key && same(token, key)) return null;
  if (!accountsOpen()) return error(401, "unauthorized");
  const user = await accountUser(token);
  if (!user) return error(401, "unauthorized");
  // It becomes a label value and part of the machine secret.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(user)) return error(500, "misconfigured");
  return user;
}

/// Which owner's machine a heartbeat comes from, read off its secret.
function machineOwner(token: string, secret: string): Owner | Response {
  if (same(token, secretsFor(secret, null).machineSecret)) return null;
  const user = token.slice(0, Math.max(token.lastIndexOf("."), 0));
  if (user && same(token, secretsFor(secret, user).machineSecret)) return user;
  return error(401, "unauthorized");
}

/// Wraps a route: 404 while neither `DRAY_CLOUD_KEY` nor accounts are on, 401
/// for the wrong bearer, and boat's failures turned into an answer. Env is
/// read per request so a route never caches a value from build time.
export function route<C>(
  who: Who,
  handler: (req: Request, caller: Caller, ctx: C) => Promise<Response>,
) {
  return async (req: Request, ctx: C) => {
    if (!process.env.DRAY_CLOUD_KEY && !accountsOpen()) return new Response(null, { status: 404 });
    const secret = process.env.DRAY_CLOUD_SECRET;
    if (!secret || !process.env.BOAT_API_KEY) return error(500, "misconfigured");
    const token = bearer(req);
    const owner = who === "client" ? await client(token) : machineOwner(token, secret);
    if (owner instanceof Response) return owner;
    try {
      return await handler(req, { owner, secret, ...secretsFor(secret, owner) }, ctx);
    } catch (e) {
      if (!(e instanceof BoatError)) throw e;
      console.error(`boat ${e.status} ${e.code}: ${e.message}`);
      // A missing sandbox, a state conflict and a start limit mean something
      // to the client; anything else is boat or this key failing.
      const status = [404, 409, 429].includes(e.status) ? e.status : 502;
      return error(status, e.code, e.message);
    }
  };
}

/// An owner's machines. `strict` leaves out the key's machines an heir lists,
/// for a heartbeat, which comes from a machine holding one owner's secret.
/// Boat reports a cancelled create once and then forgets it, so it is no machine.
async function listMachines(owner: Owner, strict = false) {
  const keys = async () => (await listByLabel("dray=cloud")).filter((s) => ownerOf(s) === null);
  const own = owner === null ? await keys() : await listByLabel("dray=cloud", `${USER_LABEL}=${owner}`);
  const inherited = !strict && owner !== null && owner === heir() ? await keys() : [];
  return [...own, ...inherited].filter((s) => s.state !== "cancelled");
}

/// One of the owner's sandboxes by id, or null. Read off the label list rather
/// than `GET /sandboxes/{id}`, so a sandbox anyone else owns, or one this boat
/// key made for anything else, is never touched.
async function find(id: string, owner: Owner, strict = false) {
  if (!SANDBOX_ID.test(id)) return null;
  return (await listMachines(owner, strict)).find((s) => s.id === id) ?? null;
}

export async function machines(caller: Caller) {
  const all = await listMachines(caller.owner);
  return { token: caller.serveToken, machines: all.map((s) => machine(s, caller.secret)) };
}

function capped(cap: number) {
  return error(
    429,
    "machine_limit",
    `${cap} Dray Cloud machines are already running, the most at once. Each stops 15 minutes after its task goes quiet.`,
  );
}

/// Oldest first, so of starts that raced past the cap the earliest are kept.
const byAge = (a: Sandbox, b: Sandbox) =>
  (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);

/// A new machine for one task, created from the saved snapshot. Never shared,
/// so a task's checkout, agents and memory are its own.
///
/// The cap is checked again once the machine exists, rather than under a lock:
/// a lock held across boat's calls tied up a database connection per waiting
/// start. Starts that raced past it keep the oldest and delete the rest.
export async function startMachine(origin: string, caller: Caller): Promise<Response> {
  const cap = awakeCap();
  if ((await listMachines(caller.owner)).filter(awake).length >= cap) return capped(cap);
  const made = await create(origin, caller);
  const ranked = (await listMachines(caller.owner)).filter(awake).sort(byAge);
  if (ranked.findIndex((s) => s.id === made.id) >= cap) {
    await boat("DELETE", `/sandboxes/${made.id}`, undefined, false, { "X-Ascii-Confirm-Delete": made.id });
    return capped(cap);
  }
  // Always, not only where hosting failed: a create's `localhost` relay never
  // starts (the sandbox's relay list stays `[]`), so the URL answers 502 until
  // the port is hosted again on the running machine (#1003).
  hostWhenUp(made.id);
  return Response.json({ machine: made });
}

async function create(origin: string, caller: Caller) {
  const { owner, serveToken, machineSecret } = caller;
  const labels = owner === null ? LABEL : { ...LABEL, [USER_LABEL]: owner };
  const res = await boat<{ sandbox: Sandbox; hostedPorts?: { url?: string; error?: string }[] }>(
    "POST",
    "/sandboxes",
    {
      from: SNAPSHOT,
      noEnv: true,
      labels,
      ttlSeconds: TTL_SECONDS,
      hostedPorts: [{ port: PORT, public: true, localhost: true }],
      files: [
        { path: ".dray/serve-token", content: serveToken },
        {
          path: ".dray/cloud.json",
          content: JSON.stringify({ url: `${origin}/api/cloud`, secret: machineSecret }),
        },
      ],
    },
    true,
  );
  const hosted = res.hostedPorts?.[0];
  const fromUrl = hosted?.url?.match(/^https:\/\/([a-z0-9-]+)-\d+\.on\.boat\.dev/)?.[1];
  // Labels as asked, so the token answered never rests on boat echoing them.
  return machine({ ...res.sandbox, labels }, caller.secret, res.sandbox.subdomain ?? fromUrl);
}

async function resume(s: Sandbox, secret: string) {
  const res = await boat<{ sandbox?: Sandbox | null }>("POST", `/sandboxes/${s.id}/resume`, {
    ttlSeconds: TTL_SECONDS,
  });
  return machine({ ...s, state: res.sandbox?.state ?? "provisioning" }, secret);
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

/// Resumes one of the caller's machines. One already awake answers as it is
/// and never counts against the cap. Checked again after, as a start is:
/// resumes that raced past the cap stop again, every one of them, since a
/// resume leaves no time to rank them by.
export async function resumeMachine(id: string, caller: Caller): Promise<Response> {
  const all = SANDBOX_ID.test(id) ? await listMachines(caller.owner) : [];
  const s = all.find((s) => s.id === id);
  if (!s) return error(404, "not_found");
  if (awake(s)) return Response.json({ machine: machine(s, caller.secret) });
  const cap = awakeCap();
  if (all.filter(awake).length >= cap) return capped(cap);
  const resumed = await resume(s, caller.secret);
  // Counted as awake whether or not boat's list has caught up with it yet.
  const others = (await listMachines(caller.owner)).filter((m) => m.id !== s.id && awake(m));
  if (others.length + 1 > cap) {
    await boat("POST", `/sandboxes/${s.id}/stop`);
    return capped(cap);
  }
  // Boat keeps a hosted port across a resume, so this is only a repair: a
  // create whose hosting failed gets a second chance on its next start.
  hostWhenUp(s.id);
  return Response.json({ machine: resumed });
}

export async function stopMachine(id: string, caller: Caller): Promise<Response> {
  const s = await find(id, caller.owner);
  if (!s) return error(404, "not_found");
  const res = await boat<{ sandbox?: Sandbox | null }>("POST", `/sandboxes/${s.id}/stop`);
  return Response.json({ machine: machine({ ...s, state: res.sandbox?.state ?? "archiving" }, caller.secret) });
}

/// Deletes a settled task's machine for good. One already gone answers the
/// same, so the app can ask again after a failure without reading the list,
/// and so does someone else's, which is not this caller's to know about.
export async function deleteMachine(id: string, caller: Caller): Promise<Response> {
  const s = await find(id, caller.owner);
  if (s) {
    // Boat refuses a delete whose confirm header does not name the sandbox.
    await boat("DELETE", `/sandboxes/${s.id}`, undefined, false, { "X-Ascii-Confirm-Delete": s.id });
  }
  return new Response(null, { status: 204 });
}

/// A busy machine pushes its auto-stop out again; an idle one lets it run.
/// Only a machine of the owner its secret names.
export async function heartbeat(req: Request, caller: Caller): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (typeof body?.sandbox !== "string" || typeof body?.busy !== "boolean") {
    return error(400, "invalid_body");
  }
  if (body.busy) {
    const s = await find(body.sandbox, caller.owner, true);
    if (s && awake(s)) {
      await boat("PATCH", `/sandboxes/${s.id}`, { ttlSeconds: TTL_SECONDS });
    }
  }
  return new Response(null, { status: 204 });
}
