import { describe, expect, it } from "vitest";

import { centring, inkBox, opticalDrop } from "@/lib/emojiInk";

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
  it("moves ink sitting low up to the box's middle", () => {
    // An 18px box, baseline 14px down; ink centre at 14 - 4 = 10 against 9.
    expect(centring({ left: 2, right: 18, top: -12, bottom: 4 }, 18, 14)).toBe(-1);
  });

  it("drops the ink further where it reads high centred", () => {
    expect(centring({ left: 0, right: 18, top: -14, bottom: 4 }, 18, 14, 1.008)).toBe(1);
  });

  it("rounds to half a pixel", () => {
    expect(centring({ left: 0, right: 17, top: -14, bottom: 3 }, 18, 14)).toBe(0.5);
  });
});

describe("opticalDrop", () => {
  it("lifts every reaction half a pixel at 18px and sinks the heart one past that", () => {
    expect(opticalDrop("👍") * 18).toBeCloseTo(-0.5, 1);
    expect(opticalDrop("❤️") * 18).toBeCloseTo(0.5, 1);
  });
});
