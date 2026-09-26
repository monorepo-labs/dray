import { describe, expect, it } from "vitest";

import { crewAnchor, crewRows, crewSeen, hiddenChildren, inSidebar, withHiddenAsks } from "@/lib/crew";
import type { SessionIndexItem, SessionStatus } from "@/types/events";

const item = (
  sessionId: string,
  parentSessionId: string | null,
  extra: Partial<SessionIndexItem> = {},
): SessionIndexItem => ({
  sessionId,
  harness: "claude_code",
  cwd: `/work/${sessionId}`,
  projectPath: "/work",
  branch: null,
  worktreeName: null,
  worktreeRemoved: false,
  title: sessionId,
  model: "opus",
  effort: null,
  permissionMode: "auto",
  fast: false,
  status: "idle",
  forkFrom: null,
  threadId: null,
  issues: [],
  parentSessionId,
  created: "2026-09-01T00:00:00Z",
  modified: "2026-09-01T00:00:00Z",
  archived: false,
  pinned: false,
  hidden: false,
  ...extra,
});

const quiet = { statusBySession: {} as Record<string, SessionStatus>, askingSessions: new Set<string>() };

const ids = (rows: { item: SessionIndexItem }[]) => rows.map((r) => r.item.sessionId);

describe("crewRows", () => {
  it("lists what the selected session started, and nothing else", () => {
    const items = [item("a", null), item("b", "a"), item("c", "a"), item("d", null), item("e", "d")];
    expect(ids(crewRows(items, "a", quiet))).toEqual(["b", "c"]);
  });

  it("answers empty for a session that spawned nothing", () => {
    const items = [item("a", null), item("b", "a")];
    expect(crewRows(items, "b", quiet)).toEqual([]);
    expect(crewRows(items, null, quiet)).toEqual([]);
  });

  // The depth cap allows a spawned session to spawn, so a grandchild exists.
  // A flat list cannot say one row belongs to another, so it sat there as a
  // peer of the session that started it. It is one ⌘-click away instead.
  it("stops at the selected session's own children", () => {
    const items = [item("a", null), item("b", "a"), item("c", "b")];
    expect(ids(crewRows(items, "a", quiet))).toEqual(["b"]);
    expect(ids(crewRows(items, "b", quiet))).toEqual(["c"]);
  });

  it("refuses a session that names itself as its own parent", () => {
    const items = [item("a", null), item("a2", "a2"), item("b", "a")];
    expect(ids(crewRows(items, "a2", quiet))).toEqual([]);
  });

  it("drops archived sessions", () => {
    const items = [item("a", null), item("b", "a", { archived: true }), item("c", "a")];
    expect(ids(crewRows(items, "a", quiet))).toEqual(["c"]);
  });

  // Newest first, and read off `created`: `modified` moves every time a
  // session's turn ends, which would slide an open strip out from under
  // somebody reading it.
  it("puts the newest first and holds that order across a turn ending", () => {
    const items = [
      item("old", "a", { created: "2026-09-01T00:00:00Z", modified: "2026-09-09T00:00:00Z" }),
      item("a", null),
      item("new", "a", { created: "2026-09-05T00:00:00Z", modified: "2026-09-02T00:00:00Z" }),
    ];
    expect(ids(crewRows(items, "a", quiet))).toEqual(["new", "old"]);
  });

  it("reads live status over the index's", () => {
    const items = [item("a", null), item("b", "a", { status: "completed" })];
    const live = { statusBySession: { b: "idle" as SessionStatus }, askingSessions: new Set<string>() };
    expect(crewRows(items, "a", live)[0].unread).toBe(false);
    expect(crewRows(items, "a", quiet)[0].unread).toBe(true);
  });

  // The backend reports a session blocked on a card as `in_progress` and is
  // right to — the turn is still open. The row has to say the opposite thing.
  it("asking outranks the in_progress the backend still reports", () => {
    const items = [item("a", null), item("b", "a", { status: "in_progress" })];
    const live = { statusBySession: {}, askingSessions: new Set(["b"]) };
    const [row] = crewRows(items, "a", live);
    expect(row.asking).toBe(true);
    expect(row.busy).toBe(false);
  });
});

describe("crewAnchor", () => {
  const items = [item("a", null), item("b", "a"), item("c", "a"), item("solo", null)];

  it("anchors a session that spawned something to itself", () => {
    expect(crewAnchor(items, "a", null)).toBe("a");
  });

  // Opening a crew row selects it. Read straight off the selection the crew
  // would delete itself on the first click it received.
  it("survives one of its own rows being selected", () => {
    expect(crewAnchor(items, "b", "a")).toBe("a");
  });

  it("goes when the reader leaves for a session it was not showing", () => {
    expect(crewAnchor(items, "solo", "a")).toBe(null);
    expect(crewAnchor(items, null, "a")).toBe(null);
  });

  // Narrower than "a child keeps its parent's crew": reached from the sidebar
  // with no crew up, B is full width.
  it("does not conjure a crew for a child reached from nowhere", () => {
    expect(crewAnchor(items, "b", null)).toBe(null);
  });

  // A spawned session may spawn, so a row can have children of its own. Asking
  // "does the selection have descendants" first made that row the anchor, which
  // swapped the list and took the main column with it — the crew reading as a
  // replacement for the conversation rather than a column beside it.
  it("keeps the anchor when a row with children of its own is selected", () => {
    const nested = [item("a", null), item("b", "a"), item("c", "b")];
    expect(crewAnchor(nested, "b", "a")).toBe("a");
  });

  // The grandchild is not a row of A's crew, so nothing holds A — and C
  // started nothing, so it anchors none of its own. Reaching it at all means
  // having left the crew, which is what makes this the right answer.
  it("lets go when the selection is below the crew it was showing", () => {
    const nested = [item("a", null), item("b", "a"), item("c", "b")];
    expect(crewAnchor(nested, "c", "a")).toBe(null);
  });

  // Reached with no crew up it still anchors its own, which is clause 2 doing
  // its job rather than clause 1 being skipped.
  it("still anchors a row with children when it is reached from nowhere", () => {
    const nested = [item("a", null), item("b", "a"), item("c", "b")];
    expect(crewAnchor(nested, "b", null)).toBe("b");
  });

  it("drops an anchor whose own rows have all been archived", () => {
    const settled = [item("a", null), item("b", "a", { archived: true })];
    expect(crewAnchor(settled, "a", "a")).toBe(null);
  });
});

describe("crewSeen", () => {
  const items = [item("a", null), item("b", "a"), item("c", "a")];

  // The regression. `announce` used to read a set filtered by `asking`, which
  // the very event being announced is what sets — so a child raising a card was
  // judged off screen, given a notice, and then drew the card a render later
  // anyway.
  it("names every row, whatever it is doing", () => {
    expect(crewSeen(crewRows(items, "a", quiet), true)).toEqual(["b", "c"]);
    const live = { statusBySession: {}, askingSessions: new Set(["b"]) };
    expect(crewSeen(crewRows(items, "a", live), true)).toEqual(["b", "c"]);
  });

  // Put away with the chord, behind another view tab, or anchored outside the
  // active space: a child that cannot be seen must still announce.
  it("names nobody where the column is not drawn", () => {
    expect(crewSeen(crewRows(items, "a", quiet), false)).toEqual([]);
  });
});

describe("hidden sessions", () => {
  const items = [
    item("a", null),
    item("review", "a", { hidden: true }),
    item("shown", "a"),
    item("orphan", "gone", { hidden: true }),
  ];

  it("leaves a hidden child out of the sidebar while its parent is listed", () => {
    expect(inSidebar(items).map((i) => i.sessionId)).toEqual(["a", "shown", "orphan"]);
  });

  it("leaves a settled hidden child out of the settled list too", () => {
    const settled = [item("a", null, { archived: true }), item("review", "a", { hidden: true, archived: true })];
    expect(inSidebar(settled).map((i) => i.sessionId)).toEqual(["a"]);
  });

  it("still draws it in the parent's crew", () => {
    expect(ids(crewRows(items, "a", quiet))).toContain("review");
  });

  it("lights the parent of a hidden asker, and no one else's", () => {
    const deep = [...items, item("sub", "review", { hidden: true })];
    expect([...withHiddenAsks(deep, new Set(["sub"]))].sort()).toEqual(["a", "review", "sub"]);
    expect([...withHiddenAsks(deep, new Set(["shown"]))]).toEqual(["shown"]);
  });

  it("names only the hidden children for a cascade", () => {
    expect(hiddenChildren(items, "a").map((i) => i.sessionId)).toEqual(["review"]);
  });
});
