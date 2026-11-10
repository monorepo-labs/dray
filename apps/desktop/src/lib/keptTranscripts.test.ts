import { describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@/types/events";
import { forgetTranscript, keepTranscript, takeTranscript } from "./keptTranscripts";

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
