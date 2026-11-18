import { describe, expect, it } from "vitest";
import type { SessionIndexItem, SessionSnapshot } from "@/types/events";
import { forgetTranscript, hasTranscript, keepTranscript, takeTranscript, warmPicks } from "./keptTranscripts";

const snap = (sessionId: string, text = "") =>
  ({ sessionId, events: [{ id: text }], olderBefore: 12 }) as unknown as SessionSnapshot;
const size = (s: SessionSnapshot) => JSON.stringify(s).length;

describe("kept transcripts", () => {
  it("hands a copy back once, whole", () => {
    keepTranscript(snap("a", "hi"));
    expect(takeTranscript("a")).toEqual(snap("a", "hi"));
    expect(takeTranscript("a")).toBeNull();
  });

  it("drops the least recently kept past the budget", () => {
    const budget = size(snap("a")) * 2;
    keepTranscript(snap("a"), budget);
    keepTranscript(snap("b"), budget);
    keepTranscript(snap("c"), budget);
    expect(takeTranscript("a")).toBeNull();
    expect(takeTranscript("b")).not.toBeNull();
    expect(takeTranscript("c")).not.toBeNull();
  });

  it("keeps nothing larger than the whole budget, and forgets on ask", () => {
    keepTranscript(snap("big", "x".repeat(100)), 50);
    expect(takeTranscript("big")).toBeNull();
    keepTranscript(snap("d"));
    forgetTranscript("d");
    expect(takeTranscript("d")).toBeNull();
  });
});

describe("warm picks", () => {
  const row = (sessionId: string, modified: string, over: Partial<SessionIndexItem> = {}) =>
    ({ sessionId, modified, status: "idle", archived: false, aside: false, hidden: false, pinned: false, ...over }) as SessionIndexItem;

  it("takes the newest, pinned first, up to the count", () => {
    const items = [row("old", "2026-01-01"), row("new", "2026-03-01"), row("mid", "2026-02-01"), row("pin", "2025-01-01", { pinned: true })];
    expect(warmPicks(items, 3)).toEqual(["pin", "new", "mid"]);
  });

  it("skips rows nobody is about to open, and one mid-turn", () => {
    const items = [
      row("a", "2026-01-05", { archived: true }),
      row("b", "2026-01-04", { aside: true }),
      row("c", "2026-01-03", { hidden: true }),
      row("d", "2026-01-02", { status: "in_progress" }),
      row("e", "2026-01-01", { status: "completed" }),
    ];
    expect(warmPicks(items)).toEqual(["e"]);
  });

  it("says whether a copy is held", () => {
    keepTranscript(snap("w"));
    expect(hasTranscript("w")).toBe(true);
    takeTranscript("w");
    expect(hasTranscript("w")).toBe(false);
  });
});
