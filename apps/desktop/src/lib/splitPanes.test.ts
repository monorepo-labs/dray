import { describe, expect, it } from "vitest";

import { addSplit, isSplit, pruneSplits, removeSplit, splitPanesOf } from "@/lib/splitPanes";

describe("split panes", () => {
  it("keeps panes in drop order, once each", () => {
    addSplit("s1", "page:1");
    addSplit("s1", "changes");
    addSplit("s1", "page:1");
    expect(splitPanesOf("s1")).toEqual(["page:1", "changes"]);
    removeSplit("s1", "page:1");
    expect(splitPanesOf("s1")).toEqual(["changes"]);
    expect(splitPanesOf("s2")).toEqual([]);
  });

  it("takes a pick's own files out of the row with it", () => {
    addSplit("s3", "pick:7");
    expect(isSplit("s3", "pickfile:7:/a/b.ts")).toBe(true);
    expect(isSplit("s3", "pickfile:70:/a/b.ts")).toBe(false);
    expect(isSplit("s3", "pick:70")).toBe(false);
  });

  it("drops what the row no longer holds", () => {
    addSplit("s4", "page:1");
    addSplit("s4", "page:2");
    pruneSplits("s4", (key) => key !== "page:1");
    expect(splitPanesOf("s4")).toEqual(["page:2"]);
  });
});
