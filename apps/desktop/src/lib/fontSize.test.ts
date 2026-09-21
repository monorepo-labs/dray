import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  coerceFontSizes,
  DEFAULT_FONT_SIZES,
  FONT_MAX,
  FONT_MIN,
  FONT_SLOTS,
} from "./fontSize";

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

// The pre-paint script in index.html applies stored sizes before React mounts,
// and it lists the slots by hand rather than importing this module. A slot
// added here and forgotten there costs a flash of the default size on every
// launch — visible, brief, and easy to read as a rendering quirk.
describe("the pre-paint script", () => {
  it("names every slot", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const listed = html.match(/\[([^\]]*)\]\.forEach\(function \(slot\)/)?.[1];
    expect(listed, "the slot array moved; update this matcher").toBeDefined();
    for (const { id } of FONT_SLOTS) expect(listed).toContain(`"${id}"`);
  });
});
