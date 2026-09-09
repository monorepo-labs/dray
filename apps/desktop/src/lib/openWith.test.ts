import { describe, expect, it } from "vitest";

import { fileOpenerChoices, lineUrl, pickFileOpener } from "@/lib/openWith";
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

describe("lineUrl", () => {
  it("asks a known editor through its own scheme", () => {
    expect(lineUrl(CURSOR, "/Users/me/a.ts", 12)).toBe("cursor://file/Users/me/a.ts:12");
    expect(lineUrl(ZED, "/Users/me/a.ts", 12)).toBe("zed://file/Users/me/a.ts:12");
  });

  /// A space or a `#` in a directory would end the URL early or start a
  /// fragment; the slashes have to stay slashes.
  it("escapes each segment and leaves the slashes", () => {
    expect(lineUrl(CURSOR, "/Users/me/My Project/#1/a.ts", 3)).toBe(
      "cursor://file/Users/me/My%20Project/%231/a.ts:3",
    );
  });

  /// No line, or an app with no known scheme, is the plain open of before.
  it("answers null with no line or no known scheme", () => {
    expect(lineUrl(CURSOR, "/Users/me/a.ts")).toBeNull();
    expect(lineUrl(app("Nova", "editor"), "/Users/me/a.ts", 12)).toBeNull();
    expect(lineUrl(FINDER, "/Users/me/a.ts", 12)).toBeNull();
  });
});
