import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { invoke, LOCAL } from "@/lib/transport";

/// The reader's Dray Cloud account (#1021), as drayhq.com's
/// `GET /api/cloud/account` answers it through `cloud_account`. Hand-written to
/// match `apps/web/src/lib/cloud/account.ts`. Read leniently: a field missing
/// reads as that step not done, never as an error.
export type CloudAccount = {
  user: { id: string; name: string; username: string | null; image: string | null } | null;
  plan?: {
    id: string;
    name: string;
    dollars: number;
    hours: number;
    status: string;
    renewsAt: string;
    overage?: { on: boolean; capCents: number | null; centsPerHour: number };
  } | null;
  usage?: { from: string; to: string; hours: number } | null;
  /// Which repos the link reaches is GitHub's answer when a machine starts,
  /// which refuses one it can't clone with a sentence saying how to fix it.
  github?: { connected: boolean; login: string | null; connectUrl: string };
  agents?: Partial<Record<CloudAgent, CloudAgentState>>;
  links?: { plans: string; billing: string; dashboard: string };
};

export type CloudAgent = "claude" | "codex";

/// `available` false is a login Dray can't take today, said in `note`.
export type CloudAgentState = { available: boolean; connected: boolean; connectUrl: string | null; note: string | null };

export type StepId = "signIn" | "plan" | "github" | "agent";

export type Step = {
  id: StepId;
  title: string;
  done: boolean;
  /// What stands, or what is missing and why it matters.
  detail: string;
  /// Where the step's button goes, or null where there is nothing to press.
  url: string | null;
  /// The button's label.
  verb: string;
};

const SITE = "https://www.drayhq.com";

const AGENT_NAMES: Record<CloudAgent, string> = { claude: "Claude", codex: "Codex" };

const hours = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1));

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/// What the plan step says once a plan exists: hours left, or why machines
/// are stopped. Overage is off unless the reader turned it on (#1023).
function planDetail(plan: NonNullable<CloudAccount["plan"]>, used: number): string {
  if (plan.status === "past_due") return `${plan.name}. Your last payment didn't go through; update your card in billing.`;
  const left = plan.hours - used;
  if (left > 0) return `${plan.name}, ${hours(left)} of ${hours(plan.hours)} hours left this period.`;
  if (!plan.overage?.on) {
    return `${plan.name}. This period's hours are used up, so machines stay stopped until ${day(plan.renewsAt)} unless you turn on overage.`;
  }
  return `${plan.name}, ${hours(-left)} hours past your plan this period, on overage.`;
}

/// The four things Cloud needs, in the order they can be done, for a task in
/// the repo `slug`. A step after a missing sign-in can't be read, so it says so.
export function setupSteps(account: CloudAccount | null, slug: string | null): Step[] {
  const user = account?.user ?? null;
  const links = account?.links ?? { plans: `${SITE}/cloud`, billing: `${SITE}/app/account/billing`, dashboard: `${SITE}/app/cloud` };
  const unknown = "Sign in first.";
  const plan = account?.plan ?? null;
  const github = account?.github;
  const agents = (["claude", "codex"] as const).map((id) => ({ id, ...(account?.agents?.[id] ?? null) }));
  const connected = agents.filter((a) => a.connected);
  const open = agents.filter((a) => a.available && !a.connected && a.connectUrl);
  // Nothing to connect today: each agent's own reason, said together.
  const closed = agents.map((a) => a.note).filter(Boolean).join(" ");

  return [
    {
      id: "signIn",
      title: "Sign in",
      done: !!user,
      detail: user ? `Signed in as ${user.name}.` : "Cloud runs under your Dray account.",
      url: null,
      verb: "Sign in",
    },
    {
      id: "plan",
      title: "Choose a plan",
      done: !!plan,
      detail: !user
        ? unknown
        : plan
          ? planDetail(plan, account?.usage?.hours ?? 0)
          : "Plans include awake machine-hours. A machine sleeps when its agent goes quiet.",
      url: user ? links.billing : null,
      verb: plan ? "Billing" : "Choose a plan",
    },
    {
      id: "github",
      title: "Connect GitHub",
      done: !!github?.connected,
      detail: !user
        ? unknown
        : github?.connected
          ? `Linked as ${github.login}. ${slug ?? "The repo"} must be one the Dray GitHub App is installed on.`
          : `Install the Dray GitHub App so Cloud can clone and push ${slug ?? "your repos"}.`,
      url: user && !github?.connected ? (github?.connectUrl ?? null) : null,
      verb: "Install",
    },
    {
      id: "agent",
      title: "Connect an agent",
      done: connected.length > 0,
      detail: !user
        ? unknown
        : connected.length > 0
          ? `${connected.map((a) => AGENT_NAMES[a.id]).join(" and ")} ${connected.length > 1 ? "are" : "is"} connected.`
          : open.length > 0
            ? `Connect your ${AGENT_NAMES[open[0].id]} login. Model usage stays on your ${AGENT_NAMES[open[0].id]} plan.`
            : closed || "No agent can be connected yet.",
      url: user && connected.length === 0 ? (open[0]?.connectUrl ?? null) : null,
      verb: "Connect",
    },
  ];
}

/// Every step done: the only state in which a task can start on Cloud.
export const accountReady = (account: CloudAccount | null, slug: string | null): boolean =>
  setupSteps(account, slug).every((s) => s.done);

let account: CloudAccount | null = null;
let error: string | null = null;
let loaded = false;
const changed = channel<void>();

let readAt = 0;

/// Reads the account again, unless it was read within `gap` ms. A failed read
/// keeps what was known, so a blip never undoes a finished step on screen.
export async function refreshCloudAccount(gap = 0): Promise<void> {
  if (Date.now() - readAt < gap) return;
  readAt = Date.now();
  try {
    account = await invoke<CloudAccount>("cloud_account", {}, LOCAL);
    error = null;
  } catch (e) {
    error = String(e);
  }
  loaded = true;
  changed.emit();
}

export type CloudAccountState = { account: CloudAccount | null; error: string | null; loaded: boolean };
let snapshot: CloudAccountState = { account, error, loaded };
changed.subscribe(() => {
  snapshot = { account, error, loaded };
});

export function useCloudAccount(): CloudAccountState {
  return useSyncExternalStore(changed.subscribe, () => snapshot);
}

export const cloudAccountNow = (): CloudAccount | null => account;

export const subscribeCloudAccount = changed.subscribe;
