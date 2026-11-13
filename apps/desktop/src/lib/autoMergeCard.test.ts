import { describe, expect, it } from "vitest";

import { readyForCard } from "@/lib/autoMergeCard";
import type { PrMark } from "@/types/events";

const mark = (over: Partial<PrMark>): PrMark => ({
  number: 7,
  url: "u",
  headRefName: "b",
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  ...over,
});

describe("readyForCard", () => {
  it("takes GitHub's own CLEAN verdict", () => {
    expect(readyForCard(mark({}))).toBe(true);
    expect(readyForCard(mark({ reviewDecision: "APPROVED" }))).toBe(true);
  });

  it("waits on anything else GitHub says, and on checks still running", () => {
    for (const mergeStateStatus of ["BLOCKED", "BEHIND", "UNSTABLE", "DIRTY", "UNKNOWN", "HAS_HOOKS"]) {
      expect(readyForCard(mark({ mergeStateStatus }))).toBe(false);
    }
    expect(readyForCard(mark({ checksState: "RUNNING" }))).toBe(false);
    expect(readyForCard(mark({ isDraft: true }))).toBe(false);
    expect(readyForCard(mark({ state: "MERGED" }))).toBe(false);
  });
});
