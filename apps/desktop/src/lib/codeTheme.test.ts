import { describe, expect, it } from "vitest";

import { CODE_THEMES, codeThemePair } from "./codeTheme";
import { THEMES } from "./theme";

describe("codeThemePair", () => {
  it("resolves auto against the app theme, not mode alone", () => {
    // The defect this table fixes: every palette drew its code in Pierre's colours.
    expect(codeThemePair("auto", "catppuccin")).toEqual(codeThemePair("catppuccin"));
    expect(codeThemePair("auto", "gruvbox")).toEqual(codeThemePair("gruvbox"));
    expect(codeThemePair("auto", "one-dark-pro")).toEqual(codeThemePair("one"));
    expect(codeThemePair("auto", "default")).toEqual(codeThemePair("pierre"));
  });

  it("answers a pair for every app theme", () => {
    for (const { id } of THEMES) {
      const pair = codeThemePair("auto", id);
      expect(pair.light).toBeTruthy();
      expect(pair.dark).toBeTruthy();
    }
  });

  // App reruns `warmHighlighter` and DiffWorkerPool pushes `setRenderOptions` on a
  // new pair, so a fresh object per render would rewarm the highlighter every frame.
  it("returns a stable object for an unchanged choice", () => {
    expect(codeThemePair("auto", "gruvbox")).toBe(codeThemePair("auto", "gruvbox"));
  });

  it("falls back for an id no longer shipped", () => {
    expect(codeThemePair("moonlight" as never)).toEqual(codeThemePair("pierre"));
  });

  it("names only ids the picker holds", () => {
    const ids = new Set(CODE_THEMES.map((t) => t.id));
    for (const { id } of THEMES) {
      const pair = codeThemePair("auto", id);
      expect([...ids].some((i) => codeThemePair(i) === pair)).toBe(true);
    }
  });
});
