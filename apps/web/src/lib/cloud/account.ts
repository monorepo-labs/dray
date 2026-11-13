import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { bearer, hashSecret } from "@/lib/link";

import type { State } from "./cloud";
import {
  billingUrl,
  claudeConnected,
  claudeLoginsOpen,
  githubConnection,
  githubInstallUrl,
  hoursUsed,
  subscription,
  userMachines,
} from "./lanes";
import { OVERAGE_CENTS_PER_HOUR, PLANS, type PlanId } from "./plans";

/// One customer's Dray Cloud, as `GET /api/cloud/account` answers it and the
/// dashboard draws it. The app's setup sheet reads the same JSON through
/// `cloud_account`, with hand-written types in `cloudAccount.ts`, so a field
/// renamed here is a field renamed there.
export type CloudAccount = {
  user: { id: string; name: string; username: string | null; image: string | null };
  plan: {
    id: PlanId;
    name: string;
    dollars: number;
    hours: number;
    status: "active" | "trialing" | "past_due";
    renewsAt: string;
    /// Hours past the plan run only with overage on, billed per hour up to the cap.
    overage: { on: boolean; capCents: number | null; centsPerHour: number };
  } | null;
  /// This billing period; null without a plan.
  usage: { from: string; to: string; hours: number } | null;
  machines: { id: string; state: State; repo: string | null; since: string }[];
  /// Linked or not. Which repos the link reaches is checked when a machine
  /// starts, which refuses one it can't clone with a sentence saying so.
  /// A null URL is a step that can't be taken yet, drawn as "opens soon".
  github: { connected: boolean; login: string | null; connectUrl: string | null };
  /// `available` false is a login Dray can't take today, said in `note`.
  agents: Record<"claude" | "codex", { available: boolean; connected: boolean; connectUrl: string | null; note: string | null }>;
  links: { plans: string; billing: string | null; dashboard: string };
};

type User = CloudAccount["user"];

/// Why an agent can't be connected, said plainly rather than promised.
export const AGENT_NOTES = {
  claude: "Not open yet. Anthropic's terms don't let Dray run your Claude Pro or Max login on its machines.",
  codex: "Codex on Cloud isn't built yet.",
};

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
  const [sub, machines, github, claude] = await Promise.all([
    subscription(user.id),
    userMachines(user.id),
    githubConnection(user.id),
    claudeConnected(user.id),
  ]);
  const hours = sub ? await hoursUsed(user.id, sub.periodStart) : 0;
  const open = claudeLoginsOpen();
  return {
    user,
    plan: sub
      ? {
          id: sub.plan,
          name: PLANS[sub.plan].name,
          dollars: PLANS[sub.plan].dollars,
          hours: PLANS[sub.plan].hours,
          status: sub.status,
          renewsAt: sub.periodEnd.toISOString(),
          overage: { on: sub.overage, capCents: sub.overageCapCents, centsPerHour: OVERAGE_CENTS_PER_HOUR },
        }
      : null,
    usage: sub ? { from: sub.periodStart.toISOString(), to: sub.periodEnd.toISOString(), hours } : null,
    machines: machines.map((m) => ({ ...m, since: m.since.toISOString() })),
    github: { connected: !!github, login: github?.login ?? null, connectUrl: githubInstallUrl(origin) },
    agents: {
      claude: {
        available: open,
        connected: open && claude,
        connectUrl: open ? `${origin}/app/account` : null,
        note: open ? null : AGENT_NOTES.claude,
      },
      codex: { available: false, connected: false, connectUrl: null, note: AGENT_NOTES.codex },
    },
    links: { plans: `${origin}/cloud`, billing: billingUrl(origin), dashboard: `${origin}/app/cloud` },
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
