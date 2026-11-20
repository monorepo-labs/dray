import { describe, expect, it } from "vitest";

import { parseIdentifier } from "@/lib/issue";
import { filterPrs, prEmptyNote, prIdentifier } from "@/lib/prMention";
import type { PrMark } from "@/types/events";

const pr = (number: number, title: string, headRefName = `branch-${number}`): PrMark => ({
  number,
  url: `https://github.com/monorepo-labs/dray/pull/${number}`,
  headRefName,
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: null,
  mergeStateStatus: null,
  reviewDecision: null,
  listing: {
    title,
    author: "someone",
    authorAvatar: null,
    updatedAt: "2026-11-20T00:00:00Z",
    additions: 0,
    deletions: 0,
    commentCount: 0,
    isCrossRepository: false,
    viewerDidAuthor: false,
    reviewRequested: false,
  },
});

describe("prIdentifier", () => {
  it("spells a PR the way an issue tag does, so the send resolves it", () => {
    const id = prIdentifier(pr(1349, "Pull requests page"));
    expect(id).toBe("monorepo-labs/dray#1349");
    expect(parseIdentifier(id!)).toBe(id);
  });
});

describe("filterPrs", () => {
  const prs = [pr(1349, "Pull requests page"), pr(12, "Fix the sidebar", "worktree-sidebar-fix"), pr(130, "Docs")];

  it("lists everything on a bare #", () => {
    expect(filterPrs(prs, "").map((p) => p.number)).toEqual([1349, 12, 130]);
  });

  it("matches a number from its start", () => {
    expect(filterPrs(prs, "13").map((p) => p.number)).toEqual([1349, 130]);
  });

  it("matches title and branch, case aside", () => {
    expect(filterPrs(prs, "PULL").map((p) => p.number)).toEqual([1349]);
    expect(filterPrs(prs, "sidebar-fix").map((p) => p.number)).toEqual([12]);
  });
});

describe("prEmptyNote", () => {
  it("says why the list is empty", () => {
    expect(prEmptyNote(null, "")).toBe("No GitHub repository here.");
    expect(prEmptyNote("o/r", "", { kind: "not_authenticated" })).toMatch(/gh auth login/);
    expect(prEmptyNote("o/r", "zz")).toBe("No pull request matches that.");
    expect(prEmptyNote("o/r", "")).toBe("No open pull requests in this repository.");
  });
});
