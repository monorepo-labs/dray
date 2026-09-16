import { describe, expect, it } from "vitest";

import { paneBounds, snapWidth, takenBy } from "@/lib/resize";

/// The chat column's floor, as `ResizeHandle` publishes it.
const CHAT_MIN = 360;

describe("snapWidth", () => {
  it("clamps to the pane's range", () => {
    expect(snapWidth(40, 180, 480, 240)).toBe(180);
    expect(snapWidth(900, 180, 480, 240)).toBe(480);
  });

  it("holds at the default while the drag is near it", () => {
    expect(snapWidth(236, 180, 480, 240)).toBe(240);
    expect(snapWidth(249, 180, 480, 240)).toBe(240);
  });

  it("lets the drag past the default", () => {
    expect(snapWidth(260, 180, 480, 240)).toBe(260);
    expect(snapWidth(220, 180, 480, 240)).toBe(220);
  });

  // The clamp runs first, so a default at the range's own edge still snaps
  // rather than being held one pixel off it.
  it("snaps a default sitting on the range's edge", () => {
    expect(snapWidth(174, 180, 480, 180)).toBe(180);
  });

  // A window too narrow to hold the default drops the cap below it. Snapping
  // there would put the pane past the bound the cap exists to state.
  it("never holds past a cap below the default", () => {
    expect(snapWidth(400, 180, 288, 512)).toBe(288);
    expect(snapWidth(200, 180, 288, 512)).toBe(200);
  });
});

describe("paneBounds", () => {
  // The whole rule, and the only one: whatever the window and whatever else is
  // on the row, the chat column comes away with its floor exactly.
  it("leaves the chat column exactly its floor", () => {
    for (const [viewport, taken] of [
      [1440, 0],
      [1440, 240],
      [1440, 400],
      [2560, 0],
      [2560, 240],
      [3840, 480],
    ]) {
      const { max } = paneBounds(320, viewport, taken, CHAT_MIN);
      expect(viewport - taken - max).toBe(CHAT_MIN);
    }
  });

  // What another pane holds is width this one cannot have, and it comes off
  // exactly rather than as a fraction: a sidebar 160px wider costs this pane
  // 160px, not a proportion of it.
  it("takes the other panes off exactly", () => {
    expect(paneBounds(320, 1440, 0, CHAT_MIN).max).toBe(1080);
    expect(paneBounds(320, 1440, 240, CHAT_MIN).max).toBe(840);
    expect(paneBounds(320, 1440, 400, CHAT_MIN).max).toBe(680);
  });

  // Split view holds several deliberately small panes, so the floor is lifted
  // and only the other panes bound it.
  it("lifts the floor for a split", () => {
    expect(paneBounds(320, 1440, 240, 0).max).toBe(1200);
  });

  // The floor is absolute, so it outranks the pane's own minimum: on a window
  // with no room for both, a minimum that won wrote a width wider than the pane
  // was drawn.
  it("drops the pane's minimum rather than the chat column's floor", () => {
    const { min, max } = paneBounds(320, 720, 240, CHAT_MIN);
    expect(max).toBe(120);
    expect(min).toBe(120);
  });

  it("never reports a floor above its ceiling, or a negative one", () => {
    for (const viewport of [375, 720, 800, 1440, 2560]) {
      for (const taken of [0, 240, 480, 900]) {
        const { min, max } = paneBounds(320, viewport, taken, CHAT_MIN);
        expect(max).toBeGreaterThanOrEqual(0);
        expect(min).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe("takenBy", () => {
  const ORDER = ["sidebar", "panel"] as const;

  it("takes only the panes ahead of this one", () => {
    const widths = { sidebar: 240, panel: 512 };
    expect(takenBy(widths, ORDER, "sidebar")).toBe(0);
    expect(takenBy(widths, ORDER, "panel")).toBe(240);
  });

  it("takes every pane where the caller is on another row", () => {
    expect(takenBy({ sidebar: 240, panel: 512 }, ORDER)).toBe(752);
  });

  it("counts an absent pane as nothing, which is what a collapsed one is", () => {
    expect(takenBy({ panel: 512 }, ORDER, "panel")).toBe(0);
  });

  // The whole reason for the precedence. Read symmetrically, a pair too wide
  // for the window alternates forever: each clamps against the other's old
  // width, republishes, and frees the other to grow back. Replaying the render
  // loop has to reach a fixed point on stored widths that do not fit.
  it("settles rather than oscillating on widths too wide for the window", () => {
    const stored = { sidebar: 480, panel: 600 };
    const viewport = 1200;
    const min = { sidebar: 240, panel: 320 };

    const pass = (widths: Record<string, number>) =>
      Object.fromEntries(
        ORDER.map((pane) => {
          const { max } = paneBounds(min[pane], viewport, takenBy(widths, ORDER, pane), CHAT_MIN);
          return [pane, Math.min(stored[pane], max)];
        }),
      );

    let widths: Record<string, number> = { ...stored };
    const settled = pass(widths);
    for (let i = 0; i < 10; i++) widths = pass(widths);
    expect(widths).toEqual(settled);
    expect(viewport - widths.sidebar - widths.panel).toBe(CHAT_MIN);
  });
});
