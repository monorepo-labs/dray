import { describe, expect, test } from "vitest";

import { accountReady, setupSteps, type CloudAccount } from "./cloudAccount";

const user = { id: "u1", name: "Sam", username: "sam", image: null };
const plan = {
  id: "pro",
  name: "Pro",
  dollars: 100,
  hours: 600,
  status: "active",
  renewsAt: "2026-12-01T00:00:00Z",
  overage: { on: false, capCents: null, centsPerHour: 20 },
};
const CLAUDE_NOTE = "Not open yet. Anthropic's terms don't let Dray run your Claude Pro or Max login on its machines.";
const CODEX_NOTE = "Codex on Cloud isn't built yet.";
const closedAgents = {
  claude: { available: false, connected: false, connectUrl: null, note: CLAUDE_NOTE },
  codex: { available: false, connected: false, connectUrl: null, note: CODEX_NOTE },
};
const ready: CloudAccount = {
  user,
  plan,
  usage: { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", hours: 181.5 },
  github: { connected: true, login: "acme", connectUrl: "https://site/api/github/install" },
  agents: { ...closedAgents, claude: { available: true, connected: true, connectUrl: "https://site/app/account", note: null } },
  links: { plans: "https://site/cloud", billing: "https://site/app/account/billing", dashboard: "https://site/app/cloud" },
};

const step = (account: CloudAccount | null, id: string, slug = "acme/widgets") =>
  setupSteps(account, slug).find((s) => s.id === id)!;

describe("setupSteps", () => {
  test("signed out: only sign-in can be pressed, later steps wait on it", () => {
    const steps = setupSteps({ user: null }, "acme/widgets");
    expect(steps.map((s) => s.done)).toEqual([false, false, false, false]);
    expect(steps.slice(1).map((s) => [s.detail, s.url])).toEqual([
      ["Sign in first.", null],
      ["Sign in first.", null],
      ["Sign in first.", null],
    ]);
  });

  test("no read yet reads as signed out", () => {
    expect(accountReady(null, "acme/widgets")).toBe(false);
    expect(step(null, "signIn").done).toBe(false);
  });

  test("everything set up is ready, with hours left said", () => {
    expect(accountReady(ready, "acme/widgets")).toBe(true);
    expect(step(ready, "plan").detail).toBe("Pro, 418.5 of 600 hours left this period.");
    expect(step(ready, "agent").detail).toBe("Claude is connected.");
  });

  test("no plan sends to billing, where plans are chosen", () => {
    const s = step({ ...ready, plan: null, usage: null }, "plan");
    expect([s.done, s.url, s.verb]).toEqual([false, "https://site/app/account/billing", "Choose a plan"]);
  });

  test("a past-due plan still runs but says so", () => {
    const due = step({ ...ready, plan: { ...plan, status: "past_due" } }, "plan");
    expect(due.done).toBe(true);
    expect(due.detail).toContain("didn't go through");
  });

  test("hours used up with overage off says machines are stopped; on, how far past", () => {
    const spent = { ...ready, usage: { ...ready.usage!, hours: 600 } };
    expect(step(spent, "plan").detail).toBe(
      "Pro. This period's hours are used up, so machines stay stopped until Dec 1 unless you turn on overage.",
    );
    const over = { ...spent, plan: { ...plan, overage: { ...plan.overage, on: true } }, usage: { ...ready.usage!, hours: 613.2 } };
    expect(step(over, "plan").detail).toBe("Pro, 13.2 hours past your plan this period, on overage.");
  });

  test("GitHub is done once linked; repo reach is the machine start's to check", () => {
    expect(step(ready, "github").detail).toBe("Linked as acme. acme/widgets must be one the Dray GitHub App is installed on.");
    const unlinked = step({ ...ready, github: { connected: false, login: null, connectUrl: "https://site/api/github/install" } }, "github");
    expect([unlinked.done, unlinked.url, unlinked.verb]).toEqual([false, "https://site/api/github/install", "Install"]);
  });

  test("no agent login open says why, with nothing to press", () => {
    const closed = { ...ready, agents: closedAgents };
    const s = step(closed, "agent");
    expect([s.done, s.url]).toEqual([false, null]);
    expect(s.detail).toBe(`${CLAUDE_NOTE} ${CODEX_NOTE}`);
    expect(accountReady(closed, "acme/widgets")).toBe(false);
  });

  test("an open login not yet connected links to where it connects", () => {
    const open = {
      ...ready,
      agents: { ...closedAgents, claude: { available: true, connected: false, connectUrl: "https://site/app/account", note: null } },
    };
    const s = step(open, "agent");
    expect([s.done, s.url]).toEqual([false, "https://site/app/account"]);
    expect(s.detail).toBe("Connect your Claude login. Model usage stays on your Claude plan.");
  });

  test("a page that hasn't shipped is said, never linked", () => {
    const early = {
      ...ready,
      plan: null,
      usage: null,
      github: { connected: false, login: null, connectUrl: null },
      links: { ...ready.links!, billing: null },
    };
    expect([step(early, "plan").detail, step(early, "plan").url]).toEqual(["Choosing a plan opens soon.", null]);
    expect([step(early, "github").detail, step(early, "github").url]).toEqual(["Linking GitHub opens soon.", null]);
  });

  test("a sparse answer costs steps, never a throw", () => {
    expect(setupSteps({ user } as CloudAccount, null).map((s) => s.done)).toEqual([true, false, false, false]);
  });
});
