import { describe, expect, it } from "vitest";

import { crewRows, crewSeen, hiddenChildren, inSidebar, withHiddenAsks } from "@/lib/crew";
import type { BackgroundTask, SessionIndexItem, SessionStatus } from "@/types/events";

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
  titleLocked: false,
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
  aside: false,
  continueOff: false,
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

  // A grandchild's card must surface on the root too: a hidden parent is
  // never the selection, so it would otherwise be unanswerable.
  it("walks every depth, each child followed by its own", () => {
    const items = [
      item("a", null),
      item("b", "a", { created: "2026-09-02T00:00:00Z" }),
      item("c", "b"),
      item("d", "a", { created: "2026-09-01T00:00:00Z" }),
    ];
    expect(ids(crewRows(items, "a", quiet))).toEqual(["b", "c", "d"]);
    expect(ids(crewRows(items, "b", quiet))).toEqual(["c"]);
  });

  it("counts a bot chat's earlier sessions' tasks as its own", () => {
    const items = [
      item("old", null),
      item("new", null),
      item("t1", "old", { created: "2026-09-01T00:00:00Z" }),
      item("t2", "new", { created: "2026-09-02T00:00:00Z" }),
    ];
    expect(ids(crewRows(items, "new", quiet, ["old"]))).toEqual(["t2", "t1"]);
  });

  it("survives a cycle in the index", () => {
    const items = [item("a", null), item("b", "a"), item("c", "b"), item("a", "c")];
    expect(ids(crewRows(items, "a", quiet))).toEqual(["b", "c"]);
  });

  it("refuses a session that names itself as its own parent", () => {
    const items = [item("a", null), item("a2", "a2"), item("b", "a")];
    expect(ids(crewRows(items, "a2", quiet))).toEqual([]);
  });

  it("drops archived sessions, and what sits under them", () => {
    const items = [
      item("a", null),
      item("b", "a", { archived: true }),
      item("b2", "b"),
      item("c", "a"),
    ];
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

  // A turn over with a background shell still running reads as idle without
  // this, and the reader takes the task for finished.
  it("flags a background task only once no turn runs", () => {
    const items = [item("a", null), item("b", "a"), item("c", "a", { status: "in_progress" })];
    const task = { taskId: "t", toolUseId: "u", kind: "local_bash", description: "dev server" } as unknown as BackgroundTask;
    const live = { statusBySession: {}, askingSessions: new Set<string>(), tasksBySession: { b: [task], c: [task] } };
    const [b, c] = crewRows(items, "a", live);
    expect(b.background).toBe(true);
    expect(c.background).toBe(false);
    expect(crewRows(items, "a", quiet)[0].background).toBe(false);
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

  // Behind another view tab, on the issues page or beside a split: a child
  // whose card cannot be seen must still announce.
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

  it("leaves a bot's own chat to the Bots section", () => {
    const bot = { id: "b", name: "Ops", path: "/h/bots/b", created: "" };
    const withBot = [...items, item("chat", null, { cwd: "/h/bots/b" })];
    expect(inSidebar(withBot, [bot]).map((i) => i.sessionId)).toEqual(["a", "shown", "orphan"]);
  });

  it("keeps a bot's settled chat in the history", () => {
    const bot = { id: "b", name: "Ops", path: "/h/bots/b", created: "" };
    const settled = [item("old", null, { cwd: "/h/bots/b", archived: true })];
    expect(inSidebar(settled, [bot]).map((i) => i.sessionId)).toEqual(["old"]);
  });

  it("leaves a settled hidden child out of the settled list too", () => {
    const settled = [item("a", null, { archived: true }), item("review", "a", { hidden: true, archived: true })];
    expect(inSidebar(settled).map((i) => i.sessionId)).toEqual(["a"]);
  });

  it("still lists it under the parent", () => {
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
