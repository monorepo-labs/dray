import { describe, expect, it } from "vitest";

import { continueList } from "./list";

describe("continueList", () => {
  it("carries a bullet onto the next line", () => {
    expect(continueList("- one", 5)).toEqual({ text: "- one\n- ", caret: 8 });
  });

  it("keeps the marker and indent the reader chose", () => {
    expect(continueList("  * one", 7)).toEqual({ text: "  * one\n  * ", caret: 12 });
  });

  it("increments an ordered item, keeping its delimiter", () => {
    expect(continueList("1. one", 6)).toEqual({ text: "1. one\n2. ", caret: 10 });
    expect(continueList("9) one", 6)).toEqual({ text: "9) one\n10) ", caret: 11 });
  });

  it("splits an item at the caret and leaves the rest under the new marker", () => {
    expect(continueList("- one two", 5)).toEqual({ text: "- one\n-  two", caret: 8 });
  });

  it("reads the caret's line, not the first", () => {
    expect(continueList("intro\n- one", 11)).toEqual({ text: "intro\n- one\n- ", caret: 14 });
  });

  it("takes the marker back off an empty item instead of adding a line", () => {
    expect(continueList("- one\n- ", 8)).toEqual({ text: "- one\n", caret: 6 });
  });

  it("keeps the marker where the empty item has text after the caret", () => {
    expect(continueList("- one\n- two", 8)).toEqual({ text: "- one\n- \n- two", caret: 11 });
  });

  it("does nothing outside a list", () => {
    expect(continueList("plain", 5)).toBeNull();
    expect(continueList("-no gap", 7)).toBeNull();
    expect(continueList("a - b", 5)).toBeNull();
  });
});

describe("continueList renumbering", () => {
  it("renumbers the items below an insertion", () => {
    expect(continueList("1. a\n2. b\n3. c", 4)).toEqual({
      text: "1. a\n2. \n3. b\n4. c",
      caret: 8,
    });
  });

  it("renumbers the items below a removal", () => {
    expect(continueList("1. a\n2. \n3. b", 8)).toEqual({ text: "1. a\n\n2. b", caret: 5 });
  });

  it("steps over a nested list and stops at prose", () => {
    expect(continueList("1. a\n  1. x\n2. b\ndone\n3. c", 4)?.text).toBe(
      "1. a\n2. \n  1. x\n3. b\ndone\n3. c",
    );
  });

  it("steps over a nested bullet under a numbered parent", () => {
    expect(continueList("1. a\n  - child\n2. b", 4)?.text).toBe("1. a\n2. \n  - child\n3. b");
  });

  it("leaves bullets below alone", () => {
    expect(continueList("- a\n- b", 3)?.text).toBe("- a\n- \n- b");
  });
});
