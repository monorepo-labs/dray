import { describe, expect, it } from "vitest";

import { coerceFontSizes, DEFAULT_FONT_SIZES, FONT_MAX, FONT_MIN } from "./fontSize";

describe("coerceFontSizes", () => {
  it("reads nothing as the defaults", () => {
    expect(coerceFontSizes(null)).toEqual(DEFAULT_FONT_SIZES);
    expect(coerceFontSizes("junk")).toEqual(DEFAULT_FONT_SIZES);
  });

  it("clamps, rounds, and drops what it does not know", () => {
    const out = coerceFontSizes({ chat: 99, code: 15.6, ui: 1, composer: 30, tool: 12 });
    expect(out).toEqual({ ...DEFAULT_FONT_SIZES, chat: FONT_MAX, code: 16, ui: FONT_MIN });
    expect("composer" in out).toBe(false);
    expect("tool" in out).toBe(false);
  });
});
