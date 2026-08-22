import { describe, expect, it } from "vitest";

import { attentionCount } from "./attention";
import type { SessionStatus } from "@/types/events";

function item(sessionId: string, status: SessionStatus) {
  return { sessionId, status };
}

describe("attentionCount", () => {
  it("counts nothing when every session is idle", () => {
    expect(attentionCount({ a: "idle" }, {}, [item("a", "idle")])).toBe(0);
  });

  it("counts a session that finished unread", () => {
    expect(attentionCount({ a: "completed" }, {}, [item("a", "completed")])).toBe(1);
  });

  it("counts a waiting session the backend still calls in_progress", () => {
    expect(attentionCount({ a: "in_progress" }, { a: ["req-1"] }, [item("a", "in_progress")])).toBe(1);
  });

  it("counts a session once when it is both unread and waiting", () => {
    expect(attentionCount({ a: "completed" }, { a: ["req-1"] }, [item("a", "completed")])).toBe(1);
  });

  it("ignores a session whose requests have all been answered", () => {
    expect(attentionCount({ a: "in_progress" }, { a: [] }, [item("a", "in_progress")])).toBe(0);
  });

  // The live map is empty at launch, so the count has to come off the index or
  // a completion that survived the last run would go unbadged until it moved.
  it("falls back to the persisted status when the live map is empty", () => {
    expect(attentionCount({}, {}, [item("a", "completed"), item("b", "idle")])).toBe(1);
  });

  // The other direction: reading a session clears it this run, and the index
  // item still says completed until it is rewritten.
  it("prefers the live status over the persisted one", () => {
    expect(attentionCount({ a: "idle" }, {}, [item("a", "completed")])).toBe(0);
  });

  // The sidebar shows one side of the archived split at a time, so a session
  // can leave the list while still being unread.
  it("counts a session missing from the index list", () => {
    expect(attentionCount({ a: "completed" }, {}, [])).toBe(1);
  });
});
