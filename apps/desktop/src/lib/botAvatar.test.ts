import { describe, expect, it } from "vitest";

import { avatarProps, seededAvatar, SHAPES } from "@/lib/botAvatar";

// The library's bands, copied from blobatar's `styles/blob.ts` (gen2).
const BANDS: Record<string, [number, number]> = {
  round: [0, 0.22],
  organic: [0.22, 0.48],
  boxy: [0.48, 0.6],
  capsule: [0.6, 0.7],
  nub: [0.7, 0.79],
  cloud: [0.79, 0.86],
  droplet: [0.86, 0.915],
  hexagon: [0.915, 0.95],
  sun: [0.95, 0.98],
  triangle: [0.98, 1],
};

describe("SHAPES", () => {
  it("puts each shape inside its own band", () => {
    for (const shape of SHAPES) {
      const [low, high] = BANDS[shape.name];
      expect(shape.position).toBeGreaterThan(low);
      expect(shape.position).toBeLessThan(high);
    }
  });

  it("never offers the droplet, picked or seeded", () => {
    expect(SHAPES.map((s) => s.name)).not.toContain("droplet");
    for (let i = 0; i < 200; i++) expect(seededAvatar(`seed-${i}`).shape).not.toBe("droplet");
  });
});

describe("avatarProps", () => {
  it("pins the shape and hue a bot picked", () => {
    expect(avatarProps({ shape: "sun", hue: 145 })).toMatchObject({ traits: { shape: 0.965 }, hue: 145 });
  });

  it("leaves a bot with no pick to its seeded face", () => {
    expect(avatarProps(null)).toBeUndefined();
  });

  it("falls back to round for a shape this build cannot name", () => {
    expect(avatarProps({ shape: "star", hue: 0 })?.traits.shape).toBe(SHAPES[0].position);
  });
});
