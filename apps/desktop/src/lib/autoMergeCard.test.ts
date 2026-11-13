import { describe, expect, it } from "vitest";

import { greptileClears } from "@/lib/autoMergeCard";
import type { GreptileReview } from "@/types/events";

const review = (over: Partial<GreptileReview>): GreptileReview => ({
  present: true,
  score: 5,
  stale: false,
  unresolved: 0,
  ...over,
});

describe("greptileClears", () => {
  it("passes a repo without Greptile on GitHub's verdict alone", () => {
    expect(greptileClears(review({ present: false, score: null }), 5)).toBe(true);
  });

  it("waits for a score, and for a review of the head", () => {
    expect(greptileClears(review({ score: null }), 5)).toBe(false);
    expect(greptileClears(review({ stale: true }), 5)).toBe(false);
  });

  it("takes the minimum, or one below with every thread resolved", () => {
    expect(greptileClears(review({ score: 5, unresolved: 2 }), 5)).toBe(true);
    expect(greptileClears(review({ score: 4, unresolved: 0 }), 5)).toBe(true);
    expect(greptileClears(review({ score: 4, unresolved: 1 }), 5)).toBe(false);
    expect(greptileClears(review({ score: 3, unresolved: 0 }), 5)).toBe(false);
    expect(greptileClears(review({ score: 3, unresolved: 0 }), 4)).toBe(true);
  });
});
