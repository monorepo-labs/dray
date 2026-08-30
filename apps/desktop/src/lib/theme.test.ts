import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME,
  THEMES,
  coerceTheme,
  hasLightMode,
  keepsGlassInFullscreen,
  modeFor,
} from "./theme";

// The pre-paint script in index.html reads `ade.theme` with a bare `getItem` and
// cannot import this module, so the two agree only by hand.

describe("coerceTheme", () => {
  it("takes every theme on offer", () => {
    for (const { id } of THEMES) expect(coerceTheme(id)).toBe(id);
  });

  // This is the whole of the rename path — `neutral`, then `shadcn`, now
  // `default`. Nothing migrates the stored value: an install still holding an
  // old id falls back to the default, and the default is that same palette
  // under its current name. If the default ever stops being that palette, this
  // test is what should fail.
  it("lands a store holding a retired id back on the same palette", () => {
    expect(coerceTheme("neutral")).toBe("default");
    expect(coerceTheme("shadcn")).toBe("default");
    expect(DEFAULT_THEME).toBe("default");
  });

  it("falls back on an unknown value or an empty store", () => {
    expect(coerceTheme(null)).toBe(DEFAULT_THEME);
    expect(coerceTheme("slate")).toBe(DEFAULT_THEME);
  });
});

describe("keepsGlassInFullscreen", () => {
  // The field is an opt-out, and that shape is the point: a theme added later
  // keeps its layering by saying nothing, so the failure mode of forgetting is a
  // theme that looks right rather than one that goes flat with no clue why.
  it("is on for a theme that says nothing", () => {
    expect(keepsGlassInFullscreen("catppuccin", "dark")).toBe(true);
  });

  it("is off for the one theme that opts out", () => {
    expect(keepsGlassInFullscreen("default", "dark")).toBe(false);
  });

  // Light outranks the theme's own answer, and this is the test that says so: a
  // light veil is black, and in fullscreen there is nothing behind it for the
  // darkening to read as. Written against the themes that opt *in*, or it would
  // pass on `flatInFullscreen` alone and prove nothing.
  it("is off in light whatever the theme says", () => {
    expect(keepsGlassInFullscreen("catppuccin", "light")).toBe(false);
    expect(keepsGlassInFullscreen("gruvbox", "light")).toBe(false);
  });
});

describe("modeFor", () => {
  // `darkOnly` is an opt-out for the same reason `flatInFullscreen` is: a ported
  // theme arrives with both palettes, so saying nothing has to mean both.
  it("passes the asked-for mode through where the theme has both", () => {
    expect(hasLightMode("catppuccin")).toBe(true);
    expect(modeFor("catppuccin", "light")).toBe("light");
    expect(modeFor("gruvbox", "system")).toBe("system");
  });

  // Default was the last theme to carry `darkOnly`, and its light side is built.
  // Asserted rather than left implied, because the flag reads as harmless and is
  // not: it silently takes the whole mode picker away from whichever palette
  // carries it, and every reader of Dray is on this one.
  it("lets every shipped theme reach light", () => {
    for (const t of THEMES) {
      expect(hasLightMode(t.id)).toBe(true);
      expect(modeFor(t.id, "light")).toBe("light");
    }
  });

  // No test for the forcing branch, and that is a statement rather than a gap:
  // nothing sets `darkOnly` now, so exercising it would mean pushing a fake theme
  // onto the exported array — a test that edits the thing it is checking. The
  // branch earns a test again the day a palette arrives without a light side.
});

describe("THEMES", () => {
  it("leads with the default", () => {
    expect(THEMES[0].id).toBe(DEFAULT_THEME);
  });

  // Each id is a `[data-theme="<id>"]` block in App.css, so an id with no block
  // renders as the `:root` fallback — a theme that silently is not one.
  it("has no duplicate ids", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The credit is the licence being honoured, not a nicety: a ported palette
  // with no `credit` is one the README cannot name.
  it("credits every ported palette", () => {
    for (const t of THEMES.filter((t) => t.id !== DEFAULT_THEME)) {
      expect(t.credit?.name).toBeTruthy();
      expect(t.credit?.url).toMatch(/^https:\/\//);
    }
  });
});
