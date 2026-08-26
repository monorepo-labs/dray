import { describe, expect, it } from "vitest";

import { isNested, sessionRows, sortSessions } from "@/components/Sidebar";
import type { SessionIndexItem } from "@/types/events";

/// Only the fields the ordering reads. Everything else on the index item is
/// irrelevant here and spelling it out would make each case harder to read than
/// the rule it pins.
function item(
  sessionId: string,
  modified: string,
  parentSessionId: string | null = null,
): SessionIndexItem {
  return {
    sessionId,
    modified,
    parentSessionId,
  } as unknown as SessionIndexItem;
}

const ids = (items: SessionIndexItem[]) => items.map((i) => i.sessionId);

describe("sortSessions", () => {
  it("orders top-level sessions newest first", () => {
    const items = [
      item("old", "2026-01-01T00:00:00Z"),
      item("new", "2026-03-01T00:00:00Z"),
      item("mid", "2026-02-01T00:00:00Z"),
    ];

    expect(ids(sortSessions(items))).toEqual(["new", "mid", "old"]);
  });

  it("puts a spawned session directly under the one that spawned it", () => {
    // The child is the oldest row in the list, so recency alone would sort it
    // last — being under its parent is what this asserts.
    const items = [
      item("parent", "2026-02-01T00:00:00Z"),
      item("other", "2026-03-01T00:00:00Z"),
      item("child", "2026-01-01T00:00:00Z", "parent"),
    ];

    expect(ids(sortSessions(items))).toEqual(["other", "parent", "child"]);
  });

  it("orders siblings among themselves by recency", () => {
    const items = [
      item("parent", "2026-01-01T00:00:00Z"),
      item("younger", "2026-02-01T00:00:00Z", "parent"),
      item("older", "2026-01-15T00:00:00Z", "parent"),
    ];

    expect(ids(sortSessions(items))).toEqual(["parent", "younger", "older"]);
  });

  it("keeps a child whose parent is not on screen", () => {
    // The ordinary case, not an edge one: the parent may be archived, filtered
    // to another project, or deleted. A row that vanished with it would be
    // unreachable.
    const items = [
      item("orphan", "2026-01-01T00:00:00Z", "gone"),
      item("plain", "2026-02-01T00:00:00Z"),
    ];

    expect(ids(sortSessions(items))).toEqual(["plain", "orphan"]);
  });

  it("nests a grandchild under its own parent, not the root", () => {
    const items = [
      item("root", "2026-03-01T00:00:00Z"),
      item("child", "2026-02-01T00:00:00Z", "root"),
      item("grandchild", "2026-01-01T00:00:00Z", "child"),
    ];

    expect(ids(sortSessions(items))).toEqual(["root", "child", "grandchild"]);
  });

  it("returns every session exactly once", () => {
    // The flatMap builds the list from two collections, so a row belonging to
    // neither — or to both — is the failure worth pinning.
    const items = [
      item("a", "2026-03-01T00:00:00Z"),
      item("b", "2026-02-01T00:00:00Z", "a"),
      item("c", "2026-01-01T00:00:00Z", "missing"),
      item("d", "2026-04-01T00:00:00Z"),
    ];

    expect(ids(sortSessions(items)).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("still draws every row when the index holds a cycle", () => {
    // Nothing should be able to write one, but the walk recurses — so a cycle
    // that did exist would hang the sidebar rather than mis-sort it. Both rows
    // reach no root, so this also pins that they are appended, not dropped.
    const items = [
      item("a", "2026-01-01T00:00:00Z", "b"),
      item("b", "2026-02-01T00:00:00Z", "a"),
      item("free", "2026-03-01T00:00:00Z"),
    ];

    expect(ids(sortSessions(items)).sort()).toEqual(["a", "b", "free"]);
  });

  it("does not mutate the array it was given", () => {
    const items = [
      item("a", "2026-01-01T00:00:00Z"),
      item("b", "2026-02-01T00:00:00Z"),
    ];
    sortSessions(items);

    expect(ids(items)).toEqual(["a", "b"]);
  });
});

describe("sessionRows", () => {
  /// The layout of one row, in the shape the assertions read most plainly.
  const layout = (rows: ReturnType<typeof sessionRows>) =>
    rows.map((r) => [r.item.sessionId, r.depth, r.guides, r.opens] as const);

  it("draws a grandchild one step further in than its parent", () => {
    // Depth is drawn rather than flattened, so the chain reads as a tree and
    // not as one rail with everything below the root hanging off it.
    const rows = sessionRows([
      item("root", "2026-03-01T00:00:00Z"),
      item("child", "2026-02-01T00:00:00Z", "root"),
      item("grandchild", "2026-01-01T00:00:00Z", "child"),
    ]);

    expect(layout(rows)).toEqual([
      ["root", 0, [], true],
      ["child", 1, [false], true],
      ["grandchild", 2, [false, false], false],
    ]);
  });

  it("keeps an ancestor's rail open past its later descendants", () => {
    // `younger`'s subtree is drawn between `younger` and `older`, so the root's
    // rail has to pass straight through those rows — and close on the last row
    // of the subtree it belongs to, which is `older` itself.
    const rows = sessionRows([
      item("root", "2026-04-01T00:00:00Z"),
      item("younger", "2026-03-01T00:00:00Z", "root"),
      item("older", "2026-01-01T00:00:00Z", "root"),
      item("leaf", "2026-02-01T00:00:00Z", "younger"),
    ]);

    expect(layout(rows)).toEqual([
      ["root", 0, [], true],
      // The root's rail carries on: `older` is still to come.
      ["younger", 1, [true], true],
      // Sits under an open root rail *and* an open `younger` rail.
      ["leaf", 2, [true, false], false],
      // Last of the root's children, so the line ends at this elbow.
      ["older", 1, [false], false],
    ]);
  });

  it("draws a child whose parent is not on screen at the top level", () => {
    // The parent may be archived, filtered to another project, or deleted, so
    // the row draws as a root — a rail reaching for it would point at nothing.
    const rows = sessionRows([
      item("orphan", "2026-01-01T00:00:00Z", "gone"),
      item("plain", "2026-02-01T00:00:00Z"),
    ]);

    expect(layout(rows)).toEqual([
      ["plain", 0, [], false],
      ["orphan", 0, [], false],
    ]);
  });

  it("opens no rail on a row with nothing drawn under it", () => {
    // `opens` is read off what was emitted, not off what the index claims: a
    // cycle can list a child that was already drawn elsewhere, and a rail
    // opened for it would hang below the last row with nothing to reach.
    const rows = sessionRows([
      item("a", "2026-01-01T00:00:00Z", "b"),
      item("b", "2026-02-01T00:00:00Z", "a"),
    ]);

    expect(rows.at(-1)?.opens).toBe(false);
  });
});

describe("isNested", () => {
  it("is true only when the parent is in the same list", () => {
    const parent = item("parent", "2026-02-01T00:00:00Z");
    const child = item("child", "2026-01-01T00:00:00Z", "parent");
    const orphan = item("orphan", "2026-01-01T00:00:00Z", "gone");

    // Judged the same way `sortSessions` places the row, so the marker can
    // never point at a parent that isn't drawn.
    expect(isNested(child, [parent, child, orphan])).toBe(true);
    expect(isNested(orphan, [parent, child, orphan])).toBe(false);
    expect(isNested(parent, [parent, child, orphan])).toBe(false);
  });
});
