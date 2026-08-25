import { describe, expect, it } from "vitest";

import { diffSide, diffSides } from "./diff";

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
