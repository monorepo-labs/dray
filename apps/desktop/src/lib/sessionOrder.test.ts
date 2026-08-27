import { describe, expect, it } from "vitest";

import { isNested, sessionGroups, sessionRows, sortSessions } from "@/components/Sidebar";
import type { Project, SessionIndexItem } from "@/types/events";

/// Only the fields the ordering reads. Everything else on the index item is
/// irrelevant here and spelling it out would make each case harder to read than
/// the rule it pins.
function item(
  sessionId: string,
  modified: string,
  parentSessionId: string | null = null,
  projectPath = "/repo",
  pinned = false,
): SessionIndexItem {
  return {
    sessionId,
    modified,
    parentSessionId,
    projectPath,
    pinned,
  } as unknown as SessionIndexItem;
}

/// The same row, pinned. A separate spelling rather than a fifth positional
/// argument at every call, since the project path in front of it is rarely the
/// thing the pinned cases are about.
const pin = (
  sessionId: string,
  modified: string,
  parentSessionId: string | null = null,
  projectPath = "/repo",
) => item(sessionId, modified, parentSessionId, projectPath, true);

const ids = (items: SessionIndexItem[]) => items.map((i) => i.sessionId);

/// Only the field the grouping reads. The list's *order* is the whole of what
/// it takes from a project, so the rest would be noise here.
const project = (path: string) => ({ path }) as unknown as Project;

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

  it("steps the pinned rows first, matching the order drawn", () => {
    // ⌘⇧↑/↓ walks this, so a pin that led the sidebar but sorted last here
    // would make the shortcut step an order nothing on screen shows.
    const items = [
      item("newest", "2026-04-01T00:00:00Z"),
      pin("pinned", "2026-01-01T00:00:00Z"),
      item("mid", "2026-02-01T00:00:00Z"),
    ];

    expect(ids(sortSessions(items))).toEqual(["pinned", "newest", "mid"]);
  });

  it("returns every session exactly once with pins in the list", () => {
    // Three collections build the list now, so a row belonging to none — or to
    // two of them — is still the failure worth pinning.
    const items = [
      pin("a", "2026-03-01T00:00:00Z"),
      item("b", "2026-02-01T00:00:00Z", "a"),
      pin("c", "2026-01-01T00:00:00Z", "b"),
      item("d", "2026-04-01T00:00:00Z"),
    ];

    expect(ids(sortSessions(items)).sort()).toEqual(["a", "b", "c", "d"]);
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

describe("sessionGroups", () => {
  /// What the heading over each run says — the project's own path, or the one
  /// word the pinned group is drawn under.
  const label = (group: ReturnType<typeof sessionGroups>[number]) =>
    group.kind === "pinned" ? "Pinned" : group.projectPath;
  const shape = (groups: ReturnType<typeof sessionGroups>) =>
    groups.map((g) => [label(g), g.rows.map((r) => r.item.sessionId)] as const);
  const paths = (groups: ReturnType<typeof sessionGroups>) => groups.map(label);

  it("gathers each project's sessions into one run, in the project list's order", () => {
    const items = [
      item("a1", "2026-01-01T00:00:00Z", null, "/a"),
      item("b1", "2026-03-01T00:00:00Z", null, "/b"),
      item("a2", "2026-02-01T00:00:00Z", null, "/a"),
    ];

    // `/a` leads because the project list says so, even though `/b` holds the
    // newest session — and `a2` joins `a1` rather than sitting between the two
    // projects where plain recency would put it.
    expect(shape(sessionGroups(items, [project("/a"), project("/b")]))).toEqual([
      ["/a", ["a2", "a1"]],
      ["/b", ["b1"]],
    ]);
  });

  it("holds the group order still while a session works", () => {
    // The whole reason the order is the project list's: a reply to any session
    // used to lift its project over the others, moving every heading under the
    // reader's eye mid-turn.
    const projects = [project("/a"), project("/b")];
    const before = [
      item("a1", "2026-01-01T00:00:00Z", null, "/a"),
      item("b1", "2026-02-01T00:00:00Z", null, "/b"),
    ];
    const after = [
      item("a1", "2026-01-01T00:00:00Z", null, "/a"),
      item("b1", "2026-09-01T00:00:00Z", null, "/b"),
    ];

    expect(paths(sessionGroups(before, projects))).toEqual(
      paths(sessionGroups(after, projects)),
    );
  });

  it("puts a project nobody attached after the ones that are", () => {
    // A detached project still has sessions to draw; it just has no place in
    // the list that orders the rest.
    const items = [
      item("loose", "2026-03-01T00:00:00Z", null, "/loose"),
      item("known", "2026-01-01T00:00:00Z", null, "/a"),
    ];

    expect(paths(sessionGroups(items, [project("/a")]))).toEqual(["/a", "/loose"]);
  });

  it("keeps a spawned session under its parent's project", () => {
    // A fork can run in another repo, and following its own path would file the
    // child under a second heading with no parent above it.
    const items = [
      item("parent", "2026-02-01T00:00:00Z", null, "/a"),
      item("child", "2026-01-01T00:00:00Z", "parent", "/b"),
    ];

    expect(shape(sessionGroups(items))).toEqual([["/a", ["parent", "child"]]]);
  });

  it("opens no group for a project with no session", () => {
    // Headings come from the rows present, so nothing here can draw one for a
    // project that has no work in the list.
    expect(sessionGroups([]).length).toBe(0);
    expect(
      shape(sessionGroups([item("only", "2026-01-01T00:00:00Z", null, "/a")])),
    ).toEqual([["/a", ["only"]]]);
  });

  it("leaves a single-project list in the order it already had", () => {
    // What keeps the ⌘⇧↑/↓ walk unchanged under a project filter.
    const items = [
      item("old", "2026-01-01T00:00:00Z"),
      item("new", "2026-03-01T00:00:00Z"),
      item("mid", "2026-02-01T00:00:00Z"),
    ];

    expect(ids(sortSessions(items))).toEqual(ids(sessionRows(items).map((r) => r.item)));
  });

  it("leads with the pinned group, above every project", () => {
    // `/a` leads the project list and holds the newest session, and the pin
    // still comes out first — it is the reader's own pick, not another repo.
    const items = [
      item("a1", "2026-03-01T00:00:00Z", null, "/a"),
      pin("b1", "2026-01-01T00:00:00Z", null, "/b"),
    ];

    expect(shape(sessionGroups(items, [project("/a"), project("/b")]))).toEqual([
      ["Pinned", ["b1"]],
      ["/a", ["a1"]],
    ]);
  });

  it("draws a pinned session once, not again under its project", () => {
    // The whole cost of drawing it twice: the reader has to work out which of
    // the two copies is the one they pinned.
    const items = [
      pin("pinned", "2026-02-01T00:00:00Z"),
      item("plain", "2026-01-01T00:00:00Z"),
    ];

    expect(shape(sessionGroups(items))).toEqual([
      ["Pinned", ["pinned"]],
      ["/repo", ["plain"]],
    ]);
  });

  it("opens no pinned group when nothing is pinned", () => {
    // What makes the group disappear under a project filter holding no pins:
    // the caller narrows the list, and an empty half draws no heading.
    expect(paths(sessionGroups([item("only", "2026-01-01T00:00:00Z")]))).toEqual([
      "/repo",
    ]);
  });

  it("orders pinned sessions among themselves by recency", () => {
    const items = [
      pin("older", "2026-01-01T00:00:00Z"),
      pin("newer", "2026-02-01T00:00:00Z"),
    ];

    expect(shape(sessionGroups(items))).toEqual([["Pinned", ["newer", "older"]]]);
  });

  it("takes a pinned session's children with it", () => {
    // Leaving them behind would split one nest across two headings, drawing a
    // child under a parent that isn't there.
    const items = [
      pin("parent", "2026-02-01T00:00:00Z"),
      item("child", "2026-01-01T00:00:00Z", "parent"),
      item("other", "2026-03-01T00:00:00Z"),
    ];

    expect(shape(sessionGroups(items))).toEqual([
      ["Pinned", ["parent", "child"]],
      ["/repo", ["other"]],
    ]);
  });

  it("nests a grandchild of a pinned session under its own parent", () => {
    const groups = sessionGroups([
      pin("root", "2026-03-01T00:00:00Z"),
      item("child", "2026-02-01T00:00:00Z", "root"),
      item("grandchild", "2026-01-01T00:00:00Z", "child"),
    ]);

    expect(groups[0].rows.map((r) => [r.item.sessionId, r.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ]);
  });

  it("draws a pinned child at the top of the pinned group, its parent left behind", () => {
    // Pinning a spawned session has to do something. The row moves out on its
    // own and draws as a root there — a rail reaching for a parent drawn under
    // another heading would point at nothing.
    const groups = sessionGroups([
      item("parent", "2026-02-01T00:00:00Z"),
      pin("child", "2026-01-01T00:00:00Z", "parent"),
    ]);

    expect(shape(groups)).toEqual([
      ["Pinned", ["child"]],
      ["/repo", ["parent"]],
    ]);
    expect(groups[0].rows[0].depth).toBe(0);
    // The parent keeps no rail either: the row it opened for is drawn in
    // another group entirely.
    expect(groups[1].rows[0].opens).toBe(false);
  });

  it("draws a pinned child of a pinned parent once, still nested", () => {
    // Both are pinned-side, so the child must not be lifted out beside its
    // parent — and it must not be emitted twice for holding a pin of its own.
    const groups = sessionGroups([
      pin("parent", "2026-02-01T00:00:00Z"),
      pin("child", "2026-01-01T00:00:00Z", "parent"),
    ]);

    expect(shape(groups)).toEqual([["Pinned", ["parent", "child"]]]);
    expect(groups[0].rows.map((r) => r.depth)).toEqual([0, 1]);
  });

  it("keeps a pinned session out of its project's group even in another repo", () => {
    // Pinned spans projects, which is why it can hold no path of its own.
    const items = [
      pin("a1", "2026-01-01T00:00:00Z", null, "/a"),
      pin("b1", "2026-02-01T00:00:00Z", null, "/b"),
      item("a2", "2026-03-01T00:00:00Z", null, "/a"),
    ];

    expect(shape(sessionGroups(items, [project("/a"), project("/b")]))).toEqual([
      ["Pinned", ["b1", "a1"]],
      ["/a", ["a2"]],
    ]);
  });
});
