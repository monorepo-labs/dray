import { describe, expect, it } from "vitest";

import { countUnifiedChanges, diffSide, diffSides } from "./diff";

describe("diffSide", () => {
  it("keys on full path and content, names by basename", () => {
    const a = diffSide("src/a/index.ts", "one");
    const b = diffSide("src/b/index.ts", "one");
    const c = diffSide("src/a/index.ts", "one\ntwo");
    expect(a.name).toBe("index.ts");
    expect(a.cacheKey).not.toBe(b.cacheKey);
    expect(a.cacheKey).not.toBe(c.cacheKey);
    expect(a.cacheKey).toBe(diffSide("src/a/index.ts", "one").cacheKey);
  });

  it("leaves the old side null for a creation", () => {
    const [before, after] = diffSides({ path: "x.ts", oldText: null, newText: "n" });
    expect(before).toBeNull();
    expect(after.cacheKey).toContain("x.ts#1:");
  });
});

describe("countUnifiedChanges", () => {
  // Codex hands over a real diff rather than two sides, so there is nothing to
  // re-diff — but the row still owes the reader the same `+N -M` a Claude edit
  // gets. Without this a Codex edit drew no size beside it at all.
  it("counts a unified diff's own prefixes", () => {
    const diff = "@@ -1 +1,2 @@\n Small steps.\n+Curiosity turns.\n-Gone.\n";
    expect(countUnifiedChanges([diff])).toEqual({ added: 1, removed: 1 });
  });

  // `+++` and `---` are file headers, and they are the one pair that would
  // otherwise be counted as a line each.
  it("does not count file headers as content", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+one\n";
    expect(countUnifiedChanges([diff])).toEqual({ added: 1, removed: 0 });
  });

  it("sums across files and skips a side with no diff", () => {
    expect(countUnifiedChanges(["@@\n+a\n+b\n", null, "@@\n-c\n"])).toEqual({
      added: 2,
      removed: 1,
    });
  });
});
