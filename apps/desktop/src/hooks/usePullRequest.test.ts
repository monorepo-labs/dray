import { describe, expect, it, vi } from "vitest";

const invoked: unknown[][] = [];
let failNext = false;
vi.mock("@/lib/transport", () => ({
  invoke: async (...args: unknown[]) => {
    invoked.push(args);
    if (failNext) {
      failNext = false;
      throw new Error("gh failed");
    }
    return [];
  },
}));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

import { prefetchPullRequests, prTabVisible } from "./usePullRequest";
import type { PullRequest } from "@/types/events";

const pr = { number: 1, state: "OPEN" } as PullRequest;

describe("prTabVisible", () => {
  it("keeps the tab where the reader can set up their way out of it", () => {
    // The pane is the cure in both states, and the only place the app says
    // `gh` is what pull requests run on.
    expect(prTabVisible([], { kind: "no_cli" })).toBe(true);
    expect(prTabVisible([], { kind: "not_authenticated" })).toBe(true);
  });

  it("hides it for everything else with nothing to show", () => {
    // Including a missing `gh` in a directory with no GitHub remote, which the
    // backend answers as `no_remote` rather than `no_cli` precisely so this
    // reads false.
    expect(prTabVisible([], { kind: "no_remote" })).toBe(false);
    expect(prTabVisible([], { kind: "other", detail: "boom" })).toBe(false);
    expect(prTabVisible([], null)).toBe(false);
  });

  it("follows the rows once there are any, failed refresh or not", () => {
    // A refresh that failed must not take the tab away from pull requests the
    // reader is looking at — the panel draws that sentence under the header.
    expect(prTabVisible([pr], null)).toBe(true);
    expect(prTabVisible([pr], { kind: "other", detail: "boom" })).toBe(true);
  });
});

describe("prefetchPullRequests", () => {
  it("reads a branch once while the answer is fresh or still out", async () => {
    invoked.length = 0;
    prefetchPullRequests("/p/r", "feature");
    prefetchPullRequests("/p/r", "feature");
    expect(invoked).toEqual([["prs_for_branch", { cwd: "/p/r", branch: "feature" }]]);
    await settle();
    prefetchPullRequests("/p/r", "feature");
    expect(invoked).toHaveLength(1);
    prefetchPullRequests("/p/r", "other");
    expect(invoked).toHaveLength(2);
  });

  it("tries again after a read that failed", async () => {
    invoked.length = 0;
    failNext = true;
    prefetchPullRequests("/p/r", "broken");
    await settle();
    prefetchPullRequests("/p/r", "broken");
    expect(invoked).toHaveLength(2);
  });
});
