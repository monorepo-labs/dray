import { describe, expect, it } from "vitest";

import { luminance, readableStateColor } from "@/lib/issueColor";

/// The threshold the module works to, restated here on purpose: a test that
/// imported the constant would pass whatever it drifted to.
const FLOOR = 0.3;

describe("readableStateColor", () => {
  it("leaves dark mode alone", () => {
    // The whole palette, untouched — the app must not disagree with the tracker
    // beside it where the colour already reads.
    expect(readableStateColor("#f2c94c", false)).toBe("#f2c94c");
    expect(readableStateColor("#e2e2e2", false)).toBe("#e2e2e2");
  });

  it("darkens what light mode cannot show, and only that", () => {
    // Linear's own "In Progress" yellow and its pale "Todo" grey, the two the
    // page actually draws most.
    for (const pale of ["#f2c94c", "#e2e2e2", "#ffffff"]) {
      const fixed = readableStateColor(pale, true);
      expect(fixed).not.toBe(pale);
      // Exactly at or under the floor, no tolerance. A single-pass correction
      // left `#f2c94c` at 0.315 — plausible on screen, and still short of 3:1,
      // which is the whole failure this file exists to catch.
      expect(luminance(fixed)).toBeLessThanOrEqual(FLOOR);
    }

    // Already readable: returned as it came, not re-encoded. Round-tripping a
    // colour that needed nothing is how a "fix" starts changing every glyph.
    expect(readableStateColor("#5e6ad2", true)).toBe("#5e6ad2");
    expect(readableStateColor("#000000", true)).toBe("#000000");
  });

  it("keeps the hue it was given", () => {
    // Green stays green. Substituting a palette colour of ours would pass a
    // contrast check and lose the one thing these marks carry the tracker's
    // colour for.
    const green = readableStateColor("#4cf25e", true);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));

    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it("leaves anything it cannot parse", () => {
    // A named colour, a short hex, and the empty string Linear sends for a
    // state with no colour set. Guessing at one is how a glyph goes black.
    for (const odd of ["", "red", "#fff", "rgb(1,2,3)"]) {
      expect(readableStateColor(odd, true)).toBe(odd);
    }
  });
});
