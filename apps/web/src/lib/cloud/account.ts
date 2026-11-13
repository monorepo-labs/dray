import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { bearer, hashSecret } from "@/lib/link";

import type { State } from "./cloud";
import {
  agentConnectUrl,
  agentLogins,
  githubInstallation,
  githubInstallUrl,
  hoursUsed,
  subscription,
  userMachines,
  type Agent,
} from "./lanes";
import { planById, type PlanId } from "./plans";

/// One customer's Dray Cloud, as `GET /api/cloud/account` answers it and the
/// dashboard draws it. The app's setup sheet reads the same JSON through
/// `cloud_account`, with hand-written types in `cloudAccount.ts`, so a field
/// renamed here is a field renamed there.
export type CloudAccount = {
  user: { id: string; name: string; username: string | null; image: string | null };
  plan: {
    id: PlanId;
    name: string;
    price: number;
    hours: number;
    machines: number;
    status: "active" | "past_due" | "canceled";
    renewsAt: string;
  } | null;
  /// This billing period; null without a plan.
  usage: { from: string; to: string; hours: number } | null;
  machines: { id: string; state: State; repo: string | null; since: string }[];
  github: { installed: boolean; account: string | null; repos: string[] | null; installUrl: string };
  agents: Record<Agent, { connected: boolean; connectUrl: string | null }>;
  links: { plans: string; dashboard: string };
};

type User = CloudAccount["user"];

/// Who is asking: the site's own session, else the desktop app's credential
/// (#889). Null for neither.
export async function cloudUser(req: Request): Promise<User | null> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (session) return toUser(session.user);
  const token = bearer(req);
  return token ? appUser(token) : null;
}

export const toUser = (u: { id: string; name: string; username?: string | null; image?: string | null }): User => ({
  id: u.id,
  name: u.name,
  username: u.username ?? null,
  image: u.image ?? null,
});

/// #889's `userForAppToken`, against the `app_session` table it added. Kept
/// here so this lands on its own; fold into that one once it has merged.
/// A database without the table answers as nobody.
async function appUser(token: string): Promise<User | null> {
  const { rows } = await pool
    .query<User>(
      `select u.id, u.name, u.username, u.image from app_session a join "user" u on u.id = a."userId"
        where a."tokenHash" = $1`,
      [hashSecret(token)],
    )
    .catch(() => ({ rows: [] as User[] }));
  return rows[0] ?? null;
}

/// Everything the dashboard and the setup sheet show, read from each lane at once.
export async function cloudAccount(user: User, origin: string): Promise<CloudAccount> {
  const [sub, machines, install, logins] = await Promise.all([
    subscription(user.id),
    userMachines(user.id),
    githubInstallation(user.id),
    agentLogins(user.id),
  ]);
  const plan = sub && sub.status !== "canceled" ? planById(sub.plan) : null;
  const hours = sub && plan ? await hoursUsed(user.id, sub.periodStart) : 0;
  const agent = (a: Agent) => ({ connected: logins[a], connectUrl: agentConnectUrl(a, origin) });
  return {
    user,
    plan: sub && plan ? { ...plan, status: sub.status, renewsAt: sub.periodEnd.toISOString() } : null,
    usage: sub && plan ? { from: sub.periodStart.toISOString(), to: sub.periodEnd.toISOString(), hours } : null,
    machines: machines.map((m) => ({ ...m, since: m.since.toISOString() })),
    github: {
      installed: !!install,
      account: install?.account ?? null,
      repos: install?.repos ?? null,
      installUrl: githubInstallUrl(),
    },
    agents: { claude: agent("claude"), codex: agent("codex") },
    links: { plans: `${origin}/cloud`, dashboard: `${origin}/app/cloud` },
  };
}

/// The origin a request reached. Read off the headers, since Next rewrites
/// `req.url`'s host to its own idea of it.
export function originOf(headers: Headers, fallback: string): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return fallback;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0] ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
