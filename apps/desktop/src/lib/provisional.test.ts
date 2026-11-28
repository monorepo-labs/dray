import { describe, expect, it } from "vitest";

import {
  carriedPreview,
  carryImages,
  carryPreviews,
  isProvisional,
  nextMainSeq,
  provisionalId,
  retireOldestProvisional,
  rowId,
} from "@/lib/provisional";
import type { AgentEvent, ImageRef, Subagent } from "@/types/events";

/// Only the fields these rules read are filled — `seq`, `subagent` and the id.
/// The payload has no bearing on any of them.
function event(id: string, seq: number, subagent: Subagent | null = null): AgentEvent {
  return {
    id,
    sessionId: "s",
    harness: "claude_code",
    seq,
    ts: "2026-09-16T00:00:00Z",
    turnId: null,
    subagent,
    payload: {
      type: "user_message",
      text: "hi",
      images: [],
      issues: [],
      baseline: null,
      queued: false,
      from: null,
      cwd: null,
    },
    raw: null,
  } as AgentEvent;
}

const sub = (id: string): Subagent => ({ id, label: null });

describe("nextMainSeq", () => {
  it("starts at 0 for a session with no events", () => {
    expect(nextMainSeq([])).toBe(0);
  });

  it("lands past the newest main-thread event", () => {
    expect(nextMainSeq([event("a", 40), event("b", 41)])).toBe(42);
  });

  // The regression: a subagent's `seq` is its own counter starting at 0, so
  // reading the tail event put a prompt typed at main-thread 41 in at 1.
  it("ignores a subagent event appended last", () => {
    const events = [event("a", 41), event("t", 1, sub("task-1"))];
    expect(nextMainSeq(events)).toBe(42);
  });

  it("ignores subagent events however high their own counter has got", () => {
    const events = [event("a", 5), event("t", 900, sub("task-1"))];
    expect(nextMainSeq(events)).toBe(6);
  });
});

describe("retireOldestProvisional", () => {
  it("takes the first provisional and leaves the rest", () => {
    const events = [event("real", 1), event("provisional:a", 2), event("provisional:b", 3)];
    expect(retireOldestProvisional(events).map((e) => e.id)).toEqual([
      "real",
      "provisional:b",
    ]);
  });

  it("hands the real prompt the provisional one's row", () => {
    const real = event("real-row", 4);
    retireOldestProvisional([event("provisional:row", 4)], real);
    expect(rowId(real)).toBe("provisional:row");
    expect(rowId(event("other", 5))).toBe("other");
  });

  it("returns the list untouched where there is none", () => {
    const events = [event("real", 1)];
    expect(retireOldestProvisional(events)).toBe(events);
  });
});

describe("provisionalId", () => {
  it("mints a fresh id per send, each recognised as provisional", () => {
    const a = provisionalId();
    const b = provisionalId();
    expect(a).not.toBe(b);
    expect(isProvisional(event(a, 0))).toBe(true);
    expect(isProvisional(event("real", 0))).toBe(false);
  });
});

/// A prompt carrying these pictures.
function withImages(id: string, images: ImageRef[]): AgentEvent {
  const e = event(id, 1);
  return { ...e, payload: { ...e.payload, images } } as AgentEvent;
}

const preview = (n: number): ImageRef => ({ path: null, url: `data:image/png;base64,${n}`, mimeType: "image/png" });
const archived = (name: string): ImageRef => ({ path: `/home/u/.dray/attachments/s/${name}`, url: null, mimeType: "image/png" });

describe("carryPreviews", () => {
  it("gives each archived picture the preview drawn at the same place", () => {
    const real = withImages("real", [archived("a.png"), archived("b.png")]);
    retireOldestProvisional([withImages("provisional:x", [preview(1), preview(2)])], real);
    expect(carriedPreview("/home/u/.dray/attachments/s/a.png")).toBe("data:image/png;base64,1");
    expect(carriedPreview("/home/u/.dray/attachments/s/b.png")).toBe("data:image/png;base64,2");
  });

  it("carries nothing where the counts say the two are not one send", () => {
    carryPreviews(withImages("provisional:x", [preview(3)]), withImages("real", [archived("c.png"), archived("d.png")]));
    expect(carriedPreview("/home/u/.dray/attachments/s/c.png")).toBeUndefined();
  });

  it("carries only a `data:` preview, never another URL", () => {
    carryImages([{ path: null, url: "https://example.com/e.png", mimeType: null }], withImages("real", [archived("e.png")]));
    expect(carriedPreview("/home/u/.dray/attachments/s/e.png")).toBeUndefined();
  });

  it("keeps a dozen, dropping the oldest", () => {
    for (let n = 0; n < 13; n++) carryImages([preview(n)], withImages("real", [archived(`cap${n}.png`)]));
    expect(carriedPreview("/home/u/.dray/attachments/s/cap0.png")).toBeUndefined();
    expect(carriedPreview("/home/u/.dray/attachments/s/cap12.png")).toBe("data:image/png;base64,12");
  });
});
