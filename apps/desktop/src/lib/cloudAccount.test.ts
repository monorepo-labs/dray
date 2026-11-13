import { describe, expect, test } from "vitest";

import { accountReady, setupSteps, type CloudAccount } from "./cloudAccount";

const user = { id: "u1", name: "Sam", username: "sam", image: null };
const plan = {
  id: "pro",
  name: "Pro",
  price: 100,
  hours: 250,
  machines: 10,
  status: "active" as const,
  renewsAt: "2026-12-01T00:00:00Z",
};
const ready: CloudAccount = {
  user,
  plan,
  usage: { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", hours: 61.5 },
  github: { installed: true, account: "acme", repos: null, installUrl: "https://github.com/apps/dray-cloud/installations/new" },
  agents: { claude: { connected: true, connectUrl: null }, codex: { connected: false, connectUrl: null } },
  links: { plans: "https://site/cloud", dashboard: "https://site/app/cloud" },
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
    expect(step(ready, "plan").detail).toBe("Pro, 188.5 of 250 hours left this period.");
    expect(step(ready, "agent").detail).toBe("Claude is connected.");
  });

  test("no plan sends to the pricing page", () => {
    const s = step({ ...ready, plan: null, usage: null }, "plan");
    expect([s.done, s.url, s.verb]).toEqual([false, "https://site/cloud", "Choose a plan"]);
  });

  test("a canceled plan is no plan; a past-due one still runs but says so", () => {
    expect(step({ ...ready, plan: { ...plan, status: "canceled" } }, "plan").done).toBe(false);
    const due = step({ ...ready, plan: { ...plan, status: "past_due" } }, "plan");
    expect(due.done).toBe(true);
    expect(due.detail).toContain("didn't go through");
  });

  test("past the plan's hours says how far", () => {
    const over = { ...ready, usage: { ...ready.usage!, hours: 263.2 } };
    expect(step(over, "plan").detail).toBe("Pro, 13.2 hours past your plan this period.");
  });

  test("the App installed without this repo is a missing step naming the repo", () => {
    const some = { ...ready, github: { ...ready.github!, repos: ["acme/api"] } };
    const s = step(some, "github");
    expect(s.done).toBe(false);
    expect(s.detail).toBe("The Dray GitHub App is on acme but can't reach acme/widgets. Add it there.");
    expect([s.verb, s.url]).toEqual(["Add repo", ready.github!.installUrl]);
    expect(step({ ...some, github: { ...some.github, repos: ["acme/widgets"] } }, "github").done).toBe(true);
  });

  test("an install on every repo reaches only its own account's, in any case", () => {
    expect(step(ready, "github", "other-org/private").done).toBe(false);
    expect(step(ready, "github", "other-org/private").detail).toBe(
      "The Dray GitHub App is on acme, not other-org. Install it on other-org too.",
    );
    expect(step(ready, "github", "other-org/private").verb).toBe("Install");
    expect(step(ready, "github", "Acme/Widgets").done).toBe(true);
  });

  test("no agent connected falls back to the dashboard to connect one", () => {
    const none = { ...ready, agents: { claude: { connected: false, connectUrl: null } } };
    const s = step(none, "agent");
    expect([s.done, s.url]).toEqual([false, "https://site/app/cloud"]);
    expect(accountReady(none, "acme/widgets")).toBe(false);
  });

  test("a sparse answer costs steps, never a throw", () => {
    expect(setupSteps({ user } as CloudAccount, null).map((s) => s.done)).toEqual([true, false, false, false]);
  });
});
