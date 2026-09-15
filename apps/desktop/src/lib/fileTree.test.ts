import { describe, expect, it } from "vitest";

import { expandTo, flattenTree, tabLabels } from "@/lib/fileTree";
import type { DirEntry } from "@/types/events";

const dir = (path: string): DirEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: true,
  ignored: false,
});

const file = (path: string): DirEntry => ({ ...dir(path), isDir: false });

describe("flattenTree", () => {
  const listings = new Map<string, DirEntry[]>([
    ["", [dir("src"), dir("src-tauri"), file("README.md")]],
    ["src", [dir("src/lib"), file("src/App.tsx")]],
    ["src/lib", [file("src/lib/diff.ts")]],
  ]);

  it("draws only what is expanded, in order, with the depth of each row", () => {
    const rows = flattenTree(listings, new Set(["src"]));

    expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([
      ["src", 0],
      ["src/lib", 1],
      ["src/App.tsx", 1],
      ["src-tauri", 0],
      ["README.md", 0],
    ]);
  });

  it("nests as deep as the expanded set goes", () => {
    const rows = flattenTree(listings, new Set(["src", "src/lib"]));

    expect(rows.map((r) => r.entry.path)).toContain("src/lib/diff.ts");
    expect(rows.find((r) => r.entry.path === "src/lib/diff.ts")?.depth).toBe(2);
  });

  /// The frame between an expand and its listing landing. The row has to draw
  /// itself and nothing under it rather than throwing on a missing key.
  it("draws an expanded directory whose listing has not arrived", () => {
    const rows = flattenTree(listings, new Set(["src-tauri"]));

    expect(rows.map((r) => r.entry.path)).toEqual([
      "src",
      "src-tauri",
      "README.md",
    ]);
  });
});

describe("expandTo", () => {
  it("names every directory above a file, outermost first", () => {
    expect(expandTo("src/lib/diff.ts")).toEqual(["src", "src/lib"]);
  });

  it("wants nothing open for a file at the root", () => {
    expect(expandTo("README.md")).toEqual([]);
  });
});

describe("tabLabels", () => {
  it("uses the basename where nothing collides", () => {
    expect(tabLabels(["/a/one.ts", "/b/two.ts"])).toEqual(["one.ts", "two.ts"]);
  });

  /// Both sides move, not just the newcomer: the tab already on screen is the
  /// one that stops being unambiguous.
  it("appends the parent directory to every side of a collision", () => {
    expect(tabLabels(["/repo/changes/index.ts", "/repo/files/index.ts"])).toEqual([
      "index.ts — changes",
      "index.ts — files",
    ]);
  });

  it("leaves a collided name alone where there is no parent to name", () => {
    expect(tabLabels(["/index.ts", "/repo/index.ts"])).toEqual([
      "index.ts",
      "index.ts — repo",
    ]);
  });
});
