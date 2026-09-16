import { describe, expect, it } from "vitest";

import { paneBounds, paneCap, snapWidth } from "@/lib/resize";

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

describe("paneCap", () => {
  it("takes the px maximum on a wide window", () => {
    expect(paneCap(480, 2560)).toBe(480);
  });

  // The two panes' px maxima sum past the default window and nearly twice the
  // minimum one, which is the whole reason the share exists.
  it("takes the window's share on a narrow one", () => {
    expect(paneCap(900, 1200)).toBe(480);
    expect(paneCap(480, 720)).toBe(288);
  });

  // The bound that matters: both panes at their widest must still leave the
  // transcript between them something to draw in, at the narrowest window the
  // app allows.
  it("leaves the transcript room with both panes at their cap", () => {
    const narrowest = 720;
    const left = narrowest - paneCap(480, narrowest) - paneCap(900, narrowest);
    expect(left).toBe(144);
  });
});

describe("paneBounds", () => {
  it("keeps the pane's own floor where the window has room", () => {
    expect(paneBounds(320, 900, 2560)).toEqual({ min: 320, max: 900 });
  });

  // Below ~800px the right panel's share falls under its own minimum. The
  // floor has to give way, or the range describes a panel wider than the one
  // being drawn.
  it("drops the floor to the cap on a window too narrow for it", () => {
    expect(paneBounds(320, 900, 720)).toEqual({ min: 288, max: 288 });
  });

  it("never reports a floor above its ceiling", () => {
    for (const viewport of [400, 720, 800, 1200, 2560]) {
      const { min, max } = paneBounds(320, 900, viewport);
      expect(min).toBeLessThanOrEqual(max);
    }
  });
});
