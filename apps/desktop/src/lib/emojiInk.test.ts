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
    expect(inkBox(buffer(10, 10, [[2, 3], [6, 7], [4, 5]]), 10, 10)).toMatchObject({ left: 2, top: 3, right: 7, bottom: 8 });
  });

  it("puts the middle halfway between the bounds' and the mass's", () => {
    // Bounds 0–10, middle 5; three rows of ink at the bottom pull the mass to 7.5.
    const heavy: [number, number][] = [[0, 0], [0, 7], [0, 8], [0, 9], [1, 7], [1, 8], [1, 9]];
    const mass = (0.5 + 6 * 8.5) / 7;
    expect(inkBox(buffer(4, 10, heavy), 4, 10)?.middle).toBeCloseTo((5 + mass) / 2);
  });

  it("takes anti-aliasing haze for nothing", () => {
    expect(inkBox(buffer(10, 10, [[2, 3]], 20), 10, 10)).toBeNull();
    expect(inkBox(buffer(4, 4, []), 4, 4)).toBeNull();
  });
});

describe("centring", () => {
  it("moves ink sitting low up to the box's middle", () => {
    // An 18px box, baseline 14px down; ink middle at 14 - 4 = 10 against 9.
    expect(centring({ left: 2, right: 18, top: -12, bottom: 4, middle: -4 }, 18, 14)).toBe(-1);
  });

  it("goes by the middle, not the bounds", () => {
    expect(centring({ left: 0, right: 18, top: -14, bottom: 4, middle: -6 }, 18, 14)).toBe(1);
  });

  it("rounds to half a pixel", () => {
    expect(centring({ left: 0, right: 17, top: -14, bottom: 3, middle: -5.5 }, 18, 14)).toBe(0.5);
  });
});
