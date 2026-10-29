import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types/events";
import { mergeMissed, missedEvents } from "./resync";

const ev = (id: string, seq: number) => ({ id, seq, payload: { type: "x" } }) as unknown as AgentEvent;

describe("mergeMissed", () => {
  it("puts what the read returned ahead of what arrived live during it", () => {
    const held = [ev("a", 1)];
    const current = [ev("a", 1), ev("live", 4)];
    const fresh = [ev("b", 2), ev("c", 3)];
    expect(mergeMissed(current, held, fresh).map((e) => e.id)).toEqual(["a", "b", "c", "live"]);
  });

  it("keeps the read's order for an event that arrived live and was also read", () => {
    const current = [ev("a", 1), ev("c", 3)];
    const fresh = [ev("b", 2), ev("c", 3)];
    expect(mergeMissed(current, [ev("a", 1)], fresh).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("retires no prompt for a user message that already arrived live", () => {
    const user = (id: string, seq: number) => ({ id, seq, payload: { type: "user_message" } }) as unknown as AgentEvent;
    const pending = user("provisional:2", 9);
    const current = [ev("a", 1), pending, user("u1", 2)];
    const fresh = [user("u1", 2), ev("b", 3)];
    expect(mergeMissed(current, [ev("a", 1), pending], fresh).map((e) => e.id)).toEqual([
      "a",
      "provisional:2",
      "u1",
      "b",
    ]);
  });

  it("fills a kept copy back in log order around what arrived while it was evicted", () => {
    // Kept as [a, b]; `c` arrived live while evicted and was merged on return;
    // `e` arrived during the catch-up read, which answered what follows `b`.
    const kept = [ev("a", 1), ev("b", 2)];
    const current = [...kept, ev("c", 3), ev("e", 5)];
    const since = [ev("c", 3), ev("d", 4)];
    expect(mergeMissed(current, kept, since).map((e) => e.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("answers the same array when nothing was missed", () => {
    const current = [ev("a", 1)];
    expect(mergeMissed(current, current, [ev("a", 1)])).toBe(current);
  });
});

describe("missedEvents", () => {
  it("answers what follows the newest held event, in log order", () => {
    const held = [ev("a", 1), ev("b", 2)];
    const tail = [ev("a", 1), ev("b", 2), ev("c", 3), ev("d", 4)];
    expect(missedEvents(held, tail)!.map((e) => e.id)).toEqual(["c", "d"]);
  });

  it("follows log position, not seq, since a subagent restarts at 0", () => {
    const held = [ev("main", 40), ev("sub", 0)];
    const tail = [ev("main", 40), ev("sub", 0), ev("sub2", 1), ev("main2", 41)];
    expect(missedEvents(held, tail)!.map((e) => e.id)).toEqual(["sub2", "main2"]);
  });

  it("asks for an older page when the tail shares nothing", () => {
    expect(missedEvents([ev("a", 1)], [ev("x", 9)])).toBeNull();
  });

  it("answers nothing new when the client is current", () => {
    expect(missedEvents([ev("a", 1)], [ev("a", 1)])).toEqual([]);
  });
});
