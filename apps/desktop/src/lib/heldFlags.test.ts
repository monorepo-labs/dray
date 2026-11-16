import { describe, expect, it } from "vitest";

import { overlayHeld, type HeldFlag } from "@/lib/heldFlags";
import type { SessionIndexItem } from "@/types/events";

const row = (sessionId: string, over: Partial<SessionIndexItem> = {}) =>
  ({ sessionId, aside: false, pinned: false, modified: "2026-11-10T00:00:00Z", ...over }) as SessionIndexItem;

const held = (sessionId: string, over: Partial<HeldFlag> = {}): HeldFlag => ({
  machine: "boat",
  sessionId,
  aside: true,
  at: "2026-11-14T00:00:00Z",
  ...over,
});

describe("overlayHeld", () => {
  it("sinks a held row and leaves the rest alone", () => {
    const items = [row("a"), row("b", { pinned: true })];
    const out = overlayHeld(items, [held("b", { pinned: false })]);
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toMatchObject({ aside: true, pinned: false, modified: "2026-11-10T00:00:00Z" });
  });

  it("brings one back on the held time, so the three-day clock restarts", () => {
    const out = overlayHeld([row("a", { aside: true })], [held("a", { aside: false })]);
    expect(out[0]).toMatchObject({ aside: false, pinned: false, modified: "2026-11-14T00:00:00Z" });
  });

  it("never moves a newer row's time back", () => {
    const out = overlayHeld([row("a", { modified: "2026-11-15T00:00:00Z" })], [held("a", { aside: false })]);
    expect(out[0].modified).toBe("2026-11-15T00:00:00Z");
  });

  it("is the same list with nothing held", () => {
    const items = [row("a")];
    expect(overlayHeld(items, [])).toBe(items);
  });
});
