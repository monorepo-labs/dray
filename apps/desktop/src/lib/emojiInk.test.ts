import { describe, expect, it } from "vitest";

import { centring, inkBox } from "@/lib/emojiInk";

/// An RGBA buffer `width` wide with the given pixels inked at `alpha`.
function buffer(width: number, height: number, inked: [number, number][], alpha = 255) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of inked) rgba[(y * width + x) * 4 + 3] = alpha;
  return rgba;
}

describe("inkBox", () => {
  it("bounds the ink, edges exclusive", () => {
    expect(inkBox(buffer(10, 10, [[2, 3], [6, 7], [4, 5]]), 10, 10)).toEqual({ left: 2, top: 3, right: 7, bottom: 8 });
  });

  it("takes anti-aliasing haze for nothing", () => {
    expect(inkBox(buffer(10, 10, [[2, 3]], 20), 10, 10)).toBeNull();
    expect(inkBox(buffer(4, 4, []), 4, 4)).toBeNull();
  });
});

describe("centring", () => {
  it("moves ink sitting low and right back to the box's centre", () => {
    // An 18px box, baseline 14px down; ink from 2px left of centre's right, low.
    const ink = { left: 2, right: 18, top: -12, bottom: 4 };
    // Ink centre (10, 14 - 4 = 10) against the box centre (9, 9).
    expect(centring(ink, 18, 18, 14)).toEqual({ x: -1, y: -1 });
  });

  it("drops the ink further where it reads high centred", () => {
    const ink = { left: 0, right: 18, top: -14, bottom: 4 };
    expect(centring(ink, 18, 18, 14, 2.52)).toEqual({ x: 0, y: 2.5 });
  });

  it("rounds to half a pixel", () => {
    expect(centring({ left: 0, right: 17, top: -14, bottom: 3 }, 18, 18, 14)).toEqual({ x: 0.5, y: 0.5 });
  });
});
