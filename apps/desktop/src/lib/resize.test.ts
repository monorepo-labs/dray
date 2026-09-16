import { describe, expect, it } from "vitest";

import { snapWidth } from "@/lib/resize";

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
});
