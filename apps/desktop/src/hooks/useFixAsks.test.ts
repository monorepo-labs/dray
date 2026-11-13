import { describe, expect, it, vi } from "vitest";

import type { PrMark } from "@/types/events";

/// Node has no `localStorage`; stood up by hand, before the store's first read.
const held = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => held.set(k, v) },
});

const { pruneFixAsks, recordFixAsk } = await import("@/hooks/useFixAsks");
const stored = () => JSON.parse(held.get("ade.fixAsks") ?? "{}");

const pr = (over: Partial<PrMark> = {}): PrMark => ({
  number: 908,
  url: "",
  headRefName: "b",
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "CONFLICTING",
  mergeStateStatus: "DIRTY",
  reviewDecision: null,
  ...over,
});

describe("fix asks", () => {
  it("keeps the first ask's time for one problem, and clears once the PR moves", () => {
    vi.useFakeTimers({ now: 1000 });
    recordFixAsk("a", 908, "conflict");
    vi.setSystemTime(5000);
    recordFixAsk("a", 908, "conflict");
    expect(stored().a).toEqual({ pr: 908, status: "conflict", at: 1000 });

    // Not read yet, or GitHub recomputing: held.
    pruneFixAsks([["a", undefined]]);
    pruneFixAsks([["a", pr({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })]]);
    expect(stored().a).toBeDefined();
    pruneFixAsks([["a", pr()]]);
    expect(stored().a).toBeDefined();

    pruneFixAsks([["a", pr({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" })]]);
    expect(stored().a).toBeUndefined();

    recordFixAsk("a", 908, "checksFailing");
    expect(stored().a.at).toBe(5000);
    vi.useRealTimers();
  });
});
