import { describe, expect, it } from "vitest";

import { isNested, sortSessions } from "@/components/Sidebar";
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
