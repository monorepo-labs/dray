import { beforeEach, describe, expect, it } from "vitest";

import { dropHeld, heldFor, holdEarlyEvent } from "@/lib/earlyEvents";
import type { AgentEvent } from "@/types/events";

/// Only the two fields the hold keys on are filled. The payload has no bearing
/// on any of it — which is the point: the hold carries whatever arrives.
const event = (id: string, sessionId: string, seq = 0): AgentEvent =>
  ({
    id,
    sessionId,
    harness: "claude_code",
    seq,
    ts: "2026-09-01T00:00:00Z",
    turnId: null,
    subagent: null,
    payload: { type: "user_message", text: "hi" },
    raw: null,
  }) as AgentEvent;

// Module state, so every test starts by clearing what the last one left —
// including the forty the session-cap test fills it with, or the order of the
// tests below is what keeps them passing.
beforeEach(() => {
  ["s", "other", ...Array.from({ length: 40 }, (_, i) => `s${i}`)].forEach(dropHeld);
});

describe("earlyEvents", () => {
  it("holds what arrives for a session that is not here yet", () => {
    holdEarlyEvent(event("e1", "s"));
    holdEarlyEvent(event("e2", "s"));
    expect(heldFor("s").map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(heldFor("other")).toEqual([]);
  });

  // StrictMode invokes every `setSessions` updater twice, and the hold happens
  // inside one. Keyed by event id, the second call is a no-op; an array would
  // have drawn two cards under one React key.
  it("takes one event once", () => {
    holdEarlyEvent(event("e1", "s"));
    holdEarlyEvent(event("e1", "s"));
    expect(heldFor("s")).toHaveLength(1);
  });

  // **The regression.** Reading used to take, at each of the five load sites —
  // a frame before that load reached state. An event arriving in the gap was
  // held under a session the listener still could not see, and nothing was
  // coming back for it: a permission request is never written to the log, so
  // the hold was the only copy and the crew row expanded over a card that had
  // been thrown away. Only the drain drops, and it runs on the commit that put
  // the session in state.
  it("does not drop what a read has seen", () => {
    holdEarlyEvent(event("e1", "s"));
    expect(heldFor("s")).toHaveLength(1);
    expect(heldFor("s")).toHaveLength(1);

    holdEarlyEvent(event("e2", "s"));
    expect(heldFor("s").map((e) => e.id)).toEqual(["e1", "e2"]);

    dropHeld("s");
    expect(heldFor("s")).toEqual([]);
  });

  // A session whose snapshot never arrives keeps whatever it held, so the per
  // session cap is what bounds it. Oldest out first.
  it("caps one session's hold, dropping the oldest", () => {
    for (let i = 0; i < 205; i++) holdEarlyEvent(event(`e${i}`, "s", i));
    const held = heldFor("s");
    expect(held).toHaveLength(200);
    expect(held[0].id).toBe("e5");
    expect(held[199].id).toBe("e204");
  });

  // A failed send leaves an entry under an id nothing will ever claim, and
  // every retry mints a fresh one.
  it("caps how many sessions are held at once", () => {
    for (let i = 0; i < 40; i++) holdEarlyEvent(event("e", `s${i}`));
    expect(heldFor("s0")).toEqual([]);
    expect(heldFor("s39")).toHaveLength(1);
  });
});
