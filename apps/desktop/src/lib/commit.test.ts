import { describe, expect, it } from "vitest";

import {
  checkedCount,
  commitBase,
  commitPaths,
  defaultSubTab,
  EMPTY_TREE,
  reconcileLog,
  reconcileUnchecked,
} from "./commit";
import type { ChangedFile, Commit } from "@/types/events";

function file(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "a.txt",
    oldPath: null,
    status: "modified",
    added: 1,
    removed: 0,
    binary: false,
    ...over,
  };
}

function commit(over: Partial<Commit> = {}): Commit {
  return {
    sha: "aaa",
    parent: "bbb",
    subject: "s",
    body: "",
    author: "Test",
    authorEmail: "t@example.com",
    authoredAt: "2026-08-22T10:00:00+05:45",
    ...over,
  };
}

describe("commitBase", () => {
  it("diffs a root commit against the empty tree", () => {
    expect(commitBase(commit({ parent: null }))).toBe(EMPTY_TREE);
    expect(commitBase(commit({ parent: "bbb" }))).toBe("bbb");
  });
});

describe("reconcileUnchecked", () => {
  it("forgets a file that is no longer changed", () => {
    const unchecked = new Set(["a.txt", "gone.txt"]);

    const next = reconcileUnchecked(unchecked, [file({ path: "a.txt" })]);

    expect([...next]).toEqual(["a.txt"]);
  });

  it("holds its identity when nothing was dropped", () => {
    const unchecked = new Set(["a.txt"]);

    expect(reconcileUnchecked(unchecked, [file({ path: "a.txt" })])).toBe(unchecked);
  });

  it("leaves a file the agent just wrote checked", () => {
    // The set is inverted for exactly this: a file nobody has touched the
    // checkbox of is one that goes in the commit.
    const next = reconcileUnchecked(new Set(["a.txt"]), [
      file({ path: "a.txt" }),
      file({ path: "fresh.txt" }),
    ]);

    expect(next.has("fresh.txt")).toBe(false);
  });
});

describe("commitPaths", () => {
  it("leaves out what the reader unchecked", () => {
    const files = [file({ path: "a.txt" }), file({ path: "b.txt" })];

    expect(commitPaths(files, new Set(["b.txt"]))).toEqual(["a.txt"]);
  });

  it("carries both sides of a rename", () => {
    // Without the old name the commit records the copy and leaves the delete
    // behind as a dirty file.
    const files = [file({ path: "new.txt", oldPath: "old.txt", status: "renamed" })];

    expect(commitPaths(files, new Set())).toEqual(["new.txt", "old.txt"]);
  });
});

describe("checkedCount", () => {
  it("counts files, not the paths a rename expands to", () => {
    const files = [
      file({ path: "new.txt", oldPath: "old.txt", status: "renamed" }),
      file({ path: "b.txt" }),
    ];

    expect(checkedCount(files, new Set(["b.txt"]))).toBe(1);
  });
});

describe("reconcileLog", () => {
  it("keeps the list when the tip has not moved", () => {
    // The reader may have paged well past the first page; a refresh that
    // replaced the array would throw all of that away on every event.
    const prev = [commit({ sha: "c3" }), commit({ sha: "c2" }), commit({ sha: "c1" })];

    expect(reconcileLog(prev, [commit({ sha: "c3" }), commit({ sha: "c2" })])).toBe(prev);
  });

  it("starts again when the tip moved", () => {
    const prev = [commit({ sha: "c2" })];
    const page = [commit({ sha: "c3" }), commit({ sha: "c2" })];

    expect(reconcileLog(prev, page)).toBe(page);
  });

  it("takes the first page it is given", () => {
    const page = [commit({ sha: "c1" })];

    expect(reconcileLog([], page)).toBe(page);
  });
});

describe("defaultSubTab", () => {
  it("opens on work still being written", () => {
    expect(
      defaultSubTab({ hasUncommitted: true, settled: true, hasBranchCommits: true }),
    ).toBe("uncommitted");
  });

  it("opens on the branch when the tree is clean and the branch has commits", () => {
    expect(
      defaultSubTab({ hasUncommitted: false, settled: true, hasBranchCommits: true }),
    ).toBe("branch");
  });

  // The view paints before the first read lands, and there an empty list is
  // "not asked yet" rather than "nothing changed" — read as clean, it opens
  // the branch tab for a frame and steps off it when the read replies.
  it("waits for the working tree to answer before leaving Uncommitted", () => {
    expect(
      defaultSubTab({ hasUncommitted: false, settled: false, hasBranchCommits: true }),
    ).toBe("uncommitted");
  });

  it("stays put when the branch has nothing of its own either", () => {
    expect(
      defaultSubTab({ hasUncommitted: false, settled: true, hasBranchCommits: false }),
    ).toBe("uncommitted");
  });
});
