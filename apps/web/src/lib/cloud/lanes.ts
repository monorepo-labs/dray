import type { State } from "./cloud";
import type { PlanId } from "./plans";

/// What the customer surface (#1021) reads from the lanes built beside it.
/// Each function is a stub answering "nothing yet", shaped after the lane's
/// own code so swapping it in is a one-line change:
///
/// - billing (#1023): `standingOf` and `billingOf` in `billing.ts`
/// - per-user machines: the user's `dray=cloud` sandboxes
/// - GitHub App and agent logins (#1022): `connected` in `github-store.ts`,
///   `enabled` and `list` in `agent-logins.ts`
///
/// `DRAY_CLOUD_STUB` fills them with sample answers outside production, so
/// every state of the pages can be looked at before the lanes merge:
/// `plan` (a plan, nothing else), `ready` (everything set up, two machines
/// awake), `over` (as `ready`, past the plan's hours with overage on).

export type Subscription = {
  plan: PlanId;
  status: "active" | "trialing" | "past_due";
  periodStart: Date;
  periodEnd: Date;
  /// Hours past the plan are billed only with this on, up to the cap.
  overage: boolean;
  overageCapCents: number | null;
};

export type UserMachine = {
  id: string;
  state: State;
  /// `owner/repo` the machine's task cloned.
  repo: string | null;
  /// When it last woke.
  since: Date;
};

function stub(): "plan" | "ready" | "over" | null {
  if (process.env.NODE_ENV === "production") return null;
  const mode = process.env.DRAY_CLOUD_STUB;
  return mode === "plan" || mode === "ready" || mode === "over" ? mode : null;
}

const DAY = 86_400_000;

/// Billing (#1023): the reader's paying subscription, or null for none.
export async function subscription(_userId: string): Promise<Subscription | null> {
  const mode = stub();
  if (!mode) return null;
  const start = new Date(Date.now() - 12 * DAY);
  const end = new Date(start.getTime() + 30 * DAY);
  return { plan: "pro", status: "active", periodStart: start, periodEnd: end, overage: mode === "over", overageCapCents: 5000 };
}

/// Billing (#1023): awake machine-hours this period.
export async function hoursUsed(_userId: string, _from: Date): Promise<number> {
  const mode = stub();
  return mode === "ready" ? 181.5 : mode === "over" ? 613.2 : 0;
}

/// Per-user machines: the reader's machines, every state.
export async function userMachines(_userId: string): Promise<UserMachine[]> {
  const mode = stub();
  if (mode !== "ready" && mode !== "over") return [];
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  return [
    { id: "bx_k3m9q2wd", state: "running", repo: "acme/widgets", since: ago(42) },
    { id: "bx_p7r4t8ve", state: "running", repo: "acme/api", since: ago(6) },
    { id: "bx_z2x5c9nb", state: "stopped", repo: "acme/widgets", since: ago(300) },
  ];
}

/// GitHub App (#1022): the GitHub login the reader linked, or null. Which
/// repos it reaches is GitHub's answer when a machine starts, not known here.
export async function githubConnection(_userId: string): Promise<{ login: string } | null> {
  const mode = stub();
  return mode === "ready" || mode === "over" ? { login: "acme" } : null;
}

/// GitHub App (#1022): where linking starts, its own route on this site.
export const githubInstallUrl = (origin: string) => `${origin}/api/github/install`;

/// Agent logins (#1022): whether connecting a Claude login is open at all.
/// Off by default: Anthropic's terms bar routing a user's Pro or Max login
/// through Dray's machines, so turning it on is a decision, not a deploy.
export const claudeLoginsOpen = () => process.env.DRAY_CLOUD_AGENT_LOGINS === "1" || stub() !== null;

/// Agent logins (#1022): whether the reader connected a Claude login.
export async function claudeConnected(_userId: string): Promise<boolean> {
  const mode = stub();
  return mode === "ready" || mode === "over";
}
