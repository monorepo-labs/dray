import type { State } from "./cloud";
import type { PlanId } from "./plans";

/// What the customer surface (#1021) reads from the lanes built beside it:
/// billing, per-user machines, the GitHub App and per-user agent logins. Each
/// function is a stub answering "nothing yet" until its lane lands and fills
/// it in; the pages and `GET /api/cloud/account` only ever call these.
///
/// `DRAY_CLOUD_STUB` fills them with sample answers outside production, so
/// every state of the pages can be looked at before the lanes merge:
/// `plan` (a plan, nothing else), `ready` (everything set up, two machines
/// awake), `over` (as `ready`, past the plan's hours).

export type Subscription = {
  plan: PlanId;
  status: "active" | "past_due" | "canceled";
  periodStart: Date;
  periodEnd: Date;
};

export type UserMachine = {
  id: string;
  state: State;
  /// `owner/repo` the machine's task cloned.
  repo: string | null;
  /// When it last woke.
  since: Date;
};

export type Installation = {
  /// The GitHub user or org the App is installed on.
  account: string;
  /// Repos it can reach, or null for every repo on that account.
  repos: string[] | null;
};

export type Agent = "claude" | "codex";

function stub(): "plan" | "ready" | "over" | null {
  if (process.env.NODE_ENV === "production") return null;
  const mode = process.env.DRAY_CLOUD_STUB;
  return mode === "plan" || mode === "ready" || mode === "over" ? mode : null;
}

const DAY = 86_400_000;
const periodStart = () => new Date(Date.now() - 12 * DAY);

/// Stripe lane: the reader's subscription, or null for none.
export async function subscription(_userId: string): Promise<Subscription | null> {
  if (!stub()) return null;
  const start = periodStart();
  return { plan: "pro", status: "active", periodStart: start, periodEnd: new Date(start.getTime() + 30 * DAY) };
}

/// Stripe lane (metering): awake machine-hours since `from`.
export async function hoursUsed(_userId: string, _from: Date): Promise<number> {
  const mode = stub();
  return mode === "ready" ? 61.5 : mode === "over" ? 263.2 : 0;
}

/// Stripe lane: a Checkout session's URL for `plan`, or null while billing
/// isn't live, which the caller turns into a notice.
export async function checkoutUrl(_userId: string, _plan: PlanId, _returnTo: string): Promise<string | null> {
  return null;
}

/// Stripe lane: the customer portal's URL, or null while billing isn't live.
export async function billingPortalUrl(_userId: string, _returnTo: string): Promise<string | null> {
  return null;
}

/// Per-user machines lane: the reader's machines, every state.
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

/// GitHub App lane: where the reader installed the Dray GitHub App, or null.
export async function githubInstallation(_userId: string): Promise<Installation | null> {
  const mode = stub();
  return mode === "ready" || mode === "over" ? { account: "acme", repos: null } : null;
}

/// GitHub App lane: where installing the App starts. `GITHUB_APP_SLUG` names it.
export function githubInstallUrl(): string {
  return `https://github.com/apps/${process.env.GITHUB_APP_SLUG ?? "dray-cloud"}/installations/new`;
}

/// Per-user logins lane: which agent subscriptions the reader connected.
export async function agentLogins(_userId: string): Promise<Record<Agent, boolean>> {
  const mode = stub();
  return { claude: mode === "ready" || mode === "over", codex: false };
}

/// Per-user logins lane: where connecting an agent starts, or null until
/// that lane says how a subscription reaches a machine.
export function agentConnectUrl(_agent: Agent, _origin: string): string | null {
  return null;
}
