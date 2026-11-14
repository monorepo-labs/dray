import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

import { open, seal } from "./vault";

/// A user's own agent logins for their Dray Cloud machines (#1013).
///
/// Off unless `DRAY_CLOUD_AGENT_LOGINS=1`. Anthropic's terms bar third parties
/// from routing requests through a user's Pro or Max credentials on their
/// behalf, and storing a user's token to run Claude Code on Dray's machines
/// is close to that. Turning this on is a decision, not a deploy step.
///
/// Claude alone: a `claude setup-token` token is a year-long bearer token with
/// no refresh, so one copy per machine is safe. Codex is absent on purpose:
/// its `auth.json` refresh token rotates, and two machines holding one copy
/// log the user out everywhere.

export const enabled = () => process.env.DRAY_CLOUD_AGENT_LOGINS === "1";

const AGENTS = {
  claude: { pattern: /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/, shape: "a token from `claude setup-token`" },
} as const;
type Agent = keyof typeof AGENTS;
const isAgent = (a: string): a is Agent => Object.hasOwn(AGENTS, a);

const bound = (userId: string, agent: string) => `agent:${agent}:${userId}`;

/// What each agent's login becomes on a machine: `agent-logins.json`, which
/// `dray-serve` turns into the child's environment.
export async function machineLogins(userId: string): Promise<Record<string, { oauthToken: string }> | null> {
  if (!enabled()) return null;
  const { rows } = await pool.query<{ agent: string; secret: string }>(
    `select agent, secret from agent_login where "userId" = $1`,
    [userId],
  );
  if (rows.length === 0) return null;
  return Object.fromEntries(rows.map((r) => [r.agent, { oauthToken: open(r.secret, bound(userId, r.agent)) }]));
}

const signedIn = (req: Request) => auth.api.getSession({ headers: req.headers });
const fail = (status: number, error: string, message?: string) =>
  Response.json(message ? { error, message } : { error }, { status });

/// `GET /api/agents`: which agents the user has connected, by hint alone.
export async function list(req: Request): Promise<Response> {
  if (!enabled()) return new Response(null, { status: 404 });
  const session = await signedIn(req);
  if (!session) return fail(401, "unauthorized");
  const { rows } = await pool.query<{ agent: string; hint: string; connectedAt: Date }>(
    `select agent, hint, "connectedAt" from agent_login where "userId" = $1 order by agent`,
    [session.user.id],
  );
  return Response.json({ logins: rows });
}

/// `PUT /api/agents/:agent` with `{ token }` saves it; `DELETE` forgets it.
/// Machines already made keep the copy written at their create.
export async function change(req: Request, agent: string): Promise<Response> {
  if (!enabled()) return new Response(null, { status: 404 });
  if (!isAgent(agent)) return fail(404, "unknown_agent");
  const session = await signedIn(req);
  if (!session) return fail(401, "unauthorized");
  const userId = session.user.id;
  if (req.method === "DELETE") {
    await pool.query(`delete from agent_login where "userId" = $1 and agent = $2`, [userId, agent]);
    return new Response(null, { status: 204 });
  }
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!AGENTS[agent].pattern.test(token)) return fail(400, "invalid_token", `That isn't ${AGENTS[agent].shape}.`);
  await pool.query(
    `insert into agent_login (id, "userId", agent, secret, hint, "connectedAt") values ($1, $2, $3, $4, $5, now())
     on conflict ("userId", agent) do update set secret = $4, hint = $5, "connectedAt" = now()`,
    [crypto.randomUUID(), userId, agent, seal(token, bound(userId, agent)), token.slice(-4)],
  );
  return new Response(null, { status: 204 });
}
