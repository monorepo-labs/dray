import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME,
  THEMES,
  coerceTheme,
  hasLightMode,
  keepsGlassInFullscreen,
  modeFor,
  type ThemeName,
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
  // Every shipped theme opts out today. That began as Default's own call and
  // turned out to hold generally: nothing is behind a fullscreen window, so the
  // veils sit on the theme's own backdrop and cost contrast without buying depth.
  // Asserted over the array rather than theme by theme, so a palette added
  // without the flag fails here and gets the question asked of it.
  it("is off in fullscreen for every theme shipped today", () => {
    for (const t of THEMES) expect(keepsGlassInFullscreen(t.id, "dark")).toBe(false);
  });

  // No test for the glass branch, and it is a statement rather than a gap: the
  // flag is an opt-out that everything now opts out of, so reaching the `true`
  // case means pushing a fake theme onto the exported array — a test that edits
  // the thing it checks. It earns one back the day a palette wants its veils in
  // fullscreen, which is the case the flag is kept for.

  // Light outranks the theme's own answer. This cannot tell the two apart while
  // every theme is flat anyway, so it is written against the *mode* and is here
  // to fail if that precedence is ever inverted.
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

  // The forcing branch, and it is a shipped theme exercising it rather than a fake
  // one pushed onto the exported array — which is what this file said it was
  // waiting for. Cobalt2 has no light palette upstream, so
  // `[data-theme="cobalt2"][data-mode="light"]` matches no block: without the
  // forcing the app falls through to the light ramp's own neutrals and draws a grey
  // that is legible, is not Cobalt2, and says nothing about why.
  it("forces dark for a theme with no light palette", () => {
    for (const id of ["cobalt2", "one-dark-pro"] as const) {
      expect(hasLightMode(id)).toBe(false);
      expect(modeFor(id, "light")).toBe("dark");
      expect(modeFor(id, "system")).toBe("dark");
      expect(modeFor(id, "dark")).toBe("dark");
    }
  });

  // The default is what every reader lands on and what every retired id falls back
  // to, so it reaching light is asserted on its own rather than as one row of a
  // loop: `darkOnly` reads as harmless and is not, and on this palette it would
  // take the mode picker away from everybody.
  it("lets the default reach light", () => {
    expect(hasLightMode(DEFAULT_THEME)).toBe(true);
    expect(modeFor(DEFAULT_THEME, "light")).toBe("light");
  });

  // Whether a palette that claims a light side actually has one is a fact about
  // App.css this cannot read. What it can pin is the direction: saying nothing
  // means both modes, so a port that arrives light-less and forgets the flag fails
  // here rather than on someone's screen.
  it("passes light through for every theme that does not opt out", () => {
    for (const t of THEMES.filter((t) => hasLightMode(t.id))) {
      expect(modeFor(t.id, "light")).toBe("light");
    }
  });
});

// Palettes written here rather than ported, so nothing upstream to credit.
const OURS: ThemeName[] = ["default", "lab"];

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
    for (const t of THEMES.filter((t) => !OURS.includes(t.id))) {
      expect(t.credit?.name).toBeTruthy();
      expect(t.credit?.url).toMatch(/^https:\/\//);
    }
  });
});
