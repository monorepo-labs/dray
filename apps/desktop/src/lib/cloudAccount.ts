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
    price: number;
    hours: number;
    machines: number;
    status: "active" | "past_due" | "canceled";
    renewsAt: string;
  } | null;
  usage?: { from: string; to: string; hours: number } | null;
  github?: { installed: boolean; account: string | null; repos: string[] | null; installUrl: string };
  agents?: Partial<Record<CloudAgent, { connected: boolean; connectUrl: string | null }>>;
  links?: { plans: string; dashboard: string };
};

export type CloudAgent = "claude" | "codex";

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

const hours = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/// The four things Cloud needs, in the order they can be done, for a task in
/// the repo `slug`. A step after a missing sign-in can't be read, so it says so.
export function setupSteps(account: CloudAccount | null, slug: string | null): Step[] {
  const user = account?.user ?? null;
  const links = account?.links ?? { plans: `${SITE}/cloud`, dashboard: `${SITE}/app/cloud` };
  const unknown = "Sign in first.";
  const plan = account?.plan && account.plan.status !== "canceled" ? account.plan : null;
  const github = account?.github;
  const reaches = !!github?.installed && !!slug && reachesRepo(github, slug);
  const owner = slug?.split("/")[0] ?? null;
  // The repo's owner where the App's install sits on someone else.
  const otherOwner = github?.account && owner && owner.toLowerCase() !== github.account.toLowerCase() ? owner : null;
  const agents = (["claude", "codex"] as const).filter((a) => account?.agents?.[a]?.connected);
  const connectUrl = account?.agents?.claude?.connectUrl ?? account?.agents?.codex?.connectUrl ?? links.dashboard;
  const left = plan ? plan.hours - (account?.usage?.hours ?? 0) : 0;

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
        : !plan
          ? "Plans include awake machine-hours. A machine sleeps when its agent goes quiet."
          : plan.status === "past_due"
            ? `${plan.name}. Your last payment didn't go through; update your card in billing.`
            : left >= 0
              ? `${plan.name}, ${hours(left)} of ${plan.hours} hours left this period.`
              : `${plan.name}, ${hours(-left)} hours past your plan this period.`,
      url: user ? (plan ? links.dashboard : links.plans) : null,
      verb: plan ? "Manage" : "Choose a plan",
    },
    {
      id: "github",
      title: "Connect GitHub",
      done: reaches,
      detail: !user
        ? unknown
        : reaches
          ? `The Dray GitHub App reaches ${slug ?? "your repos"}.`
          : github?.installed && !otherOwner
            ? `The Dray GitHub App is on ${github.account ?? "GitHub"} but can't reach ${slug ?? "this repo"}. Add it there.`
            : github?.installed && otherOwner
              ? `The Dray GitHub App is on ${github.account}, not ${otherOwner}. Install it on ${otherOwner} too.`
              : `Install the Dray GitHub App so Cloud can clone and push ${slug ?? "your repos"}.`,
      url: user && !reaches ? (github?.installUrl ?? null) : null,
      verb: github?.installed && !otherOwner ? "Add repo" : "Install",
    },
    {
      id: "agent",
      title: "Connect Claude or Codex",
      done: agents.length > 0,
      detail: !user
        ? unknown
        : agents.length === 2
          ? "Claude and Codex are connected."
          : agents.length === 1
            ? `${agents[0] === "claude" ? "Claude" : "Codex"} is connected.`
            : "Agents run on your own subscription. Dray never bills you for tokens.",
      url: user && agents.length === 0 ? connectUrl : null,
      verb: "Connect",
    },
  ];
}

/// Whether the App's installation can clone `slug`. `repos: null` is every
/// repo on the installation's own account, never another owner's. GitHub
/// names are case-insensitive.
function reachesRepo(github: NonNullable<CloudAccount["github"]>, slug: string): boolean {
  const want = slug.toLowerCase();
  if (github.repos !== null) return github.repos.some((r) => r.toLowerCase() === want);
  return !!github.account && want.split("/")[0] === github.account.toLowerCase();
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
