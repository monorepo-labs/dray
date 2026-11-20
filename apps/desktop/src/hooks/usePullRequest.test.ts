import { describe, expect, it } from "vitest";

import { prTabVisible } from "./usePullRequest";
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
