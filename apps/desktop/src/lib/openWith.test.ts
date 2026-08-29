import { describe, expect, it } from "vitest";

import { fileOpenerChoices, pickFileOpener } from "@/lib/openWith";
import type { ExternalApp } from "@/types/events";

function app(name: string, kind: ExternalApp["kind"]): ExternalApp {
  return { path: `/Applications/${name}.app`, name, kind, icon: null };
}

const ZED = app("Zed", "editor");
const CURSOR = app("Cursor", "editor");
const GHOSTTY = app("Ghostty", "terminal");
const FINDER = app("Finder", "files");

const DETECTED = [ZED, CURSOR, GHOSTTY, FINDER];

describe("fileOpenerChoices", () => {
  it("drops terminals and keeps the table's order", () => {
    expect(fileOpenerChoices(DETECTED)).toEqual([ZED, CURSOR, FINDER]);
  });
});

describe("pickFileOpener", () => {
  it("falls back to Finder when nothing is stored", () => {
    expect(pickFileOpener(DETECTED, null)).toBe(FINDER);
  });

  it("takes the stored editor", () => {
    expect(pickFileOpener(DETECTED, CURSOR.path)).toBe(CURSOR);
  });

  /// The panel button falls back to the first app so it always opens
  /// something. This one has a quiet correct answer, and reseating on
  /// whichever editor leads the table would open the wrong app in silence.
  it("falls back to Finder when the stored editor is gone", () => {
    expect(pickFileOpener(DETECTED, "/Applications/Uninstalled.app")).toBe(FINDER);
  });

  /// A terminal cannot be picked through the menu, so a stored one is a
  /// hand-edited value — and handing it one file answers nothing.
  it("ignores a stored terminal", () => {
    expect(pickFileOpener(DETECTED, GHOSTTY.path)).toBe(FINDER);
  });

  /// Off macOS the scan detects nothing at all, Finder included.
  it("answers null when nothing was detected", () => {
    expect(pickFileOpener([], ZED.path)).toBeNull();
  });
});
