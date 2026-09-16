import { describe, expect, it } from "vitest";

import {
  closePane,
  dropLabel,
  members,
  openBeside,
  paneOrder,
  place,
  pruneGroups,
  type SplitGroup,
} from "@/lib/groups";

const group = (id: number, ...columns: string[][]): SplitGroup => ({
  id,
  columns,
  space: null,
});

describe("place", () => {
  it("opens beside, above and below, and replaces at the centre", () => {
    expect(place([["a"]], "a", "b", "right")).toEqual([["a"], ["b"]]);
    expect(place([["a"]], "a", "b", "left")).toEqual([["b"], ["a"]]);
    expect(place([["a"]], "a", "b", "bottom")).toEqual([["a", "b"]]);
    expect(place([["a"], ["b"]], "b", "c", "top")).toEqual([["a"], ["c", "b"]]);
    expect(place([["a"], ["b"]], "b", "c", "center")).toEqual([["a"], ["c"]]);
  });

  it("grows past two columns and two rows", () => {
    expect(place([["a"], ["b"]], "a", "c", "left")).toEqual([["c"], ["a"], ["b"]]);
    expect(place([["a", "b"]], "a", "c", "bottom")).toEqual([["a", "c", "b"]]);
  });

  it("refuses a drop onto itself and an anchor outside the grid", () => {
    expect(place([["a"]], "a", "a", "right")).toBeNull();
    expect(place([["a"]], "x", "b", "right")).toBeNull();
  });

  it("moves a session already in the grid rather than duplicating it", () => {
    expect(place([["a"], ["b"]], "a", "b", "bottom")).toEqual([["a", "b"]]);
    expect(place([["a", "b"], ["c"]], "c", "a", "center")).toEqual([["b"], ["a"]]);
  });
});

describe("dropLabel", () => {
  it("names each outcome and says nothing where nothing would happen", () => {
    const groups = [group(1, ["a", "b"], ["c"])];
    expect(dropLabel(groups, "x", "y", "right")).toBe("Open on the right");
    expect(dropLabel(groups, "x", "y", "center")).toBeNull();
    expect(dropLabel(groups, "c", "y", "center")).toBe("Replace");
    expect(dropLabel(groups, "c", "y", "top")).toBe("Open above");
    expect(dropLabel(groups, "a", "y", "bottom")).toBe("Open below");
    expect(dropLabel(groups, "a", "y", "left")).toBe("Open on the left");
    expect(dropLabel(groups, "x", "x", "right")).toBeNull();
  });
});

describe("openBeside", () => {
  it("makes a group of two from a single view, and a centre drop there is no drop", () => {
    expect(openBeside([], "a", "b", "right", "work")).toEqual([
      { id: 1, columns: [["a"], ["b"]], space: "work" },
    ]);
    // Replacing a single view is a click; refused whole, so the dropped
    // session's own group stands.
    const groups = [group(1, ["b"], ["c"])];
    expect(openBeside(groups, "a", "b", "center", null)).toBe(groups);
  });

  it("builds on the anchor's group", () => {
    expect(openBeside([group(1, ["a"], ["b"])], "b", "c", "bottom", null)[0].columns).toEqual([
      ["a"],
      ["b", "c"],
    ]);
  });

  it("moves a session out of its old group, dissolving one left with a single member", () => {
    const groups = [group(1, ["a"], ["b"]), group(2, ["c"], ["d"])];
    expect(openBeside(groups, "c", "a", "top", null)).toEqual([
      { id: 2, columns: [["a", "c"], ["d"]], space: null },
    ]);
  });

  it("leaves a group from another space alone and moves the anchor out of it", () => {
    const elsewhere = { id: 1, columns: [["a", "b"], ["c"]], space: "work" };
    expect(openBeside([elsewhere], "a", "d", "right", null)).toEqual([
      { id: 1, columns: [["b"], ["c"]], space: "work" },
      { id: 2, columns: [["a"], ["d"]], space: null },
    ]);
  });

  it("grows a full 2×2 rather than refusing", () => {
    const full = [group(1, ["a", "b"], ["c", "d"])];
    expect(openBeside(full, "a", "e", "bottom", null)[0].columns).toEqual([
      ["a", "e", "b"],
      ["c", "d"],
    ]);
    expect(openBeside(full, "a", "e", "left", null)[0].columns).toEqual([
      ["e"],
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("numbers past the highest id standing", () => {
    expect(openBeside([group(3, ["a"], ["b"])], "c", "d", "right", null)[1].id).toBe(4);
  });
});

describe("closePane", () => {
  it("removes the pane, drops an emptied column, and dissolves a group of one", () => {
    expect(closePane([group(1, ["a", "b"], ["c"])], "c")[0].columns).toEqual([["a", "b"]]);
    expect(closePane([group(1, ["a"], ["b"])], "b")).toEqual([]);
  });
});

describe("pruneGroups", () => {
  it("answers the same array when every member is present", () => {
    const groups = [group(1, ["a"], ["b"])];
    expect(pruneGroups(groups, new Set(["a", "b", "c"]))).toBe(groups);
  });

  it("drops missing members and any group that falls below two", () => {
    const groups = [group(1, ["a", "b"], ["c"]), group(2, ["d"], ["e"])];
    expect(pruneGroups(groups, new Set(["a", "c", "d"]))).toEqual([
      { id: 1, columns: [["a"], ["c"]], space: null },
    ]);
  });
});

describe("members", () => {
  it("reads left to right, top to bottom", () => {
    expect(members(group(1, ["a", "c"], ["b", "d"]))).toEqual(["a", "c", "b", "d"]);
  });
});

describe("paneOrder", () => {
  it("reads row by row, left to right", () => {
    expect(paneOrder(group(1, ["a", "b"], ["c", "d"]))).toEqual(["a", "c", "b", "d"]);
    expect(paneOrder(group(1, ["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]))).toEqual([
      "a", "d", "g", "b", "e", "h", "c", "f", "i",
    ]);
  });

  it("skips a short column's missing rows", () => {
    expect(paneOrder(group(1, ["a", "b"], ["c"]))).toEqual(["a", "c", "b"]);
    expect(paneOrder(group(1, ["a"], ["b", "c", "d"]))).toEqual(["a", "b", "c", "d"]);
  });

  it("reads top to bottom in one column and left to right in one row", () => {
    expect(paneOrder(group(1, ["a", "b"]))).toEqual(["a", "b"]);
    expect(paneOrder(group(1, ["a"], ["b"]))).toEqual(["a", "b"]);
  });
});
