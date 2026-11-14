import { describe, expect, it } from "vitest";

import {
  addSplit,
  isSplit,
  pruneSplits,
  removeSplit,
  setLitGroup,
  splitGroupsOf,
  splitPanesOf,
} from "@/lib/splitPanes";

describe("split groups", () => {
  it("grows a group in drop order, a tab in one group at a time", () => {
    addSplit("s1", "chat", "page:1");
    addSplit("s1", "chat", "changes");
    expect(splitGroupsOf("s1")).toEqual([["chat", "page:1", "changes"]]);
    addSplit("s1", "file:a", "page:1");
    expect(splitGroupsOf("s1")).toEqual([
      ["chat", "changes"],
      ["file:a", "page:1"],
    ]);
  });

  it("draws panes for the lit group alone", () => {
    addSplit("s2", "chat", "page:1");
    addSplit("s2", "file:a", "changes");
    expect(splitPanesOf("s2")).toEqual([]);
    setLitGroup("s2", "file:a");
    expect(splitPanesOf("s2")).toEqual(["changes"]);
  });

  it("dissolves a group left with one tab", () => {
    addSplit("s3", "chat", "page:1");
    removeSplit("s3", "page:1");
    expect(splitGroupsOf("s3")).toEqual([]);
    addSplit("s3", "page:1", "page:2");
    addSplit("s3", "page:1", "changes");
    pruneSplits("s3", (key) => key !== "page:1");
    expect(splitGroupsOf("s3")).toEqual([["page:2", "changes"]]);
  });

  it("takes a pick's own files out of the row with it, never the lead's", () => {
    addSplit("s4", "chat", "pick:7");
    expect(isSplit("s4", "pickfile:7:/a/b.ts")).toBe(true);
    expect(isSplit("s4", "pickfile:70:/a/b.ts")).toBe(false);
    expect(isSplit("s4", "chat")).toBe(false);
  });
});
