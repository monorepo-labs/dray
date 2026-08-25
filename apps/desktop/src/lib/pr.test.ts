import { describe, expect, it } from "vitest";

import {
  firstLine,
  isSettling,
  mergeReadiness,
  prBadgeCount,
  sessionBranch,
  stripBotMarkers,
  summarizeChecks,
  threadLabel,
} from "./pr";
import type { PrCheck, PullRequest } from "@/types/events";

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: "t",
    url: "u",
    state: "OPEN",
    isDraft: false,
    author: "a",
    baseRefName: "main",
    headRefName: "feature",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    checks: [],
    comments: [],
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    updatedAt: "",
    ...over,
  };
}

const check = (state: PrCheck["state"]): PrCheck => ({
  name: "c",
  state,
  url: null,
  workflow: null,
  avatar: null,
});

describe("sessionBranch", () => {
  it("names a worktree session's branch the way the CLI does", () => {
    expect(sessionBranch({ branch: "main", worktreeName: "calm-owl" })).toBe(
      "worktree-calm-owl",
    );
  });

  it("uses the checked-out branch otherwise", () => {
    expect(sessionBranch({ branch: "feature", worktreeName: null })).toBe("feature");
    expect(sessionBranch({ branch: null, worktreeName: null })).toBeNull();
  });

  // A settled session whose worktree was deleted keeps the branch its work is
  // on and loses only the name of the directory it ran in. The PR outlives
  // both, so the tab has to survive the tidy-up.
  it("keeps naming the PR's branch after the worktree is deleted", () => {
    expect(sessionBranch({ branch: "worktree-calm-owl", worktreeName: null })).toBe(
      "worktree-calm-owl",
    );
  });

  // The name rebuilt from the index is a guess made at creation. Anything that
  // checks out another branch inside the tree leaves it describing a branch the
  // session is no longer on, and the PR tab hid itself over it.
  it("lets git's own reading of HEAD outrank the guess", () => {
    expect(
      sessionBranch({ branch: "main", worktreeName: "calm-owl" }, "fix/thing"),
    ).toBe("fix/thing");
    expect(sessionBranch({ branch: "feature", worktreeName: null }, "fix/thing")).toBe(
      "fix/thing",
    );
  });

  // The read is per-session and lands a frame late, and a non-repo has no
  // branch at all — so both fall back rather than drawing nothing.
  it("falls back while there is no reading to use", () => {
    expect(sessionBranch({ branch: "main", worktreeName: "calm-owl" }, null)).toBe(
      "worktree-calm-owl",
    );
    expect(sessionBranch({ branch: "feature", worktreeName: null }, undefined)).toBe(
      "feature",
    );
  });
});

describe("mergeReadiness", () => {
  it("reads a clean open PR as ready", () => {
    expect(mergeReadiness(pr()).tone).toBe("ready");
  });

  // The ordering rule: a conflict has to outrank everything, since every other
  // answer here reads as "you may merge".
  it("puts a conflict above every other state", () => {
    expect(mergeReadiness(pr({ mergeable: "CONFLICTING" })).tone).toBe("conflict");
    expect(mergeReadiness(pr({ mergeStateStatus: "DIRTY" })).tone).toBe("conflict");
    expect(mergeReadiness(pr({ mergeable: "CONFLICTING", isDraft: true })).tone).toBe("conflict");
  });

  it("does not call an unresolved mergeability ready", () => {
    expect(mergeReadiness(pr({ mergeable: "UNKNOWN" })).tone).toBe("pending");
  });

  it("reports a closed or merged PR from its state, not its merge status", () => {
    expect(mergeReadiness(pr({ state: "MERGED", mergeStateStatus: "UNKNOWN" })).label).toBe(
      "Merged",
    );
    expect(mergeReadiness(pr({ state: "CLOSED" })).tone).toBe("neutral");
  });

  it("names why a blocked PR is blocked", () => {
    const blocked = pr({ mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" });
    expect(mergeReadiness(blocked).detail).toBe("Changes were requested.");
  });

  it("distinguishes behind-base from blocked", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "BEHIND" })).label).toBe("Behind main");
  });
});

describe("summarizeChecks", () => {
  it("counts each terminal state apart from the rest", () => {
    const summary = summarizeChecks([
      check("success"),
      check("failure"),
      check("pending"),
      check("skipped"),
    ]);
    expect(summary).toEqual({ passed: 1, failed: 1, pending: 1, total: 4 });
  });
});

describe("isSettling", () => {
  it("is true only while something can still change by itself", () => {
    expect(isSettling(pr({ checks: [check("pending")] }))).toBe(true);
    expect(isSettling(pr({ mergeable: "UNKNOWN" }))).toBe(true);
    expect(isSettling(pr({ checks: [check("success")] }))).toBe(false);
    // A closed PR's pending check will never report.
    expect(isSettling(pr({ state: "CLOSED", checks: [check("pending")] }))).toBe(false);
    expect(isSettling(null)).toBe(false);
  });
});

describe("stripBotMarkers", () => {
  it("drops the machinery bots address to GitHub", () => {
    const body = "[vc]: #abc=:eyJ0eXBlIjoiZ2l0aHViIn0=\nThe latest updates.";
    expect(stripBotMarkers(body)).toBe("The latest updates.");
  });

  it("drops HTML comments wrapping a badge", () => {
    expect(stripBotMarkers("## Done\n<!-- badge-begin -->\n<!-- badge-end -->")).toBe("## Done");
  });

  it("leaves an ordinary comment untouched", () => {
    expect(stripBotMarkers("Looks good to me.")).toBe("Looks good to me.");
  });
});

describe("firstLine", () => {
  it("skips blank lines and strips a heading's marks", () => {
    expect(firstLine("\n## Devin Review: No Issues Found\n\nDetails follow.")).toBe(
      "Devin Review: No Issues Found",
    );
  });

  it("is empty for a body with nothing in it", () => {
    expect(firstLine("\n\n")).toBe("");
  });
});

describe("firstLine, markup", () => {
  it("keeps a link's text and drops its URL", () => {
    expect(firstLine("Learn more about [Vercel for GitHub](https://vercel.link/x).")).toBe(
      "Learn more about Vercel for GitHub.",
    );
  });

  it("keeps an image's alt text, which is its only readable part", () => {
    expect(firstLine("![Ready](https://vercel.com/ready.svg)")).toBe("Ready");
  });

  it("drops emphasis marks that render as nothing in a plain preview", () => {
    expect(firstLine("**Deploy** failed on `main`")).toBe("Deploy failed on main");
  });
});

describe("prBadgeCount", () => {
  it("says nothing for a single pull request", () => {
    expect(prBadgeCount([pr()])).toBeUndefined();
    expect(prBadgeCount([])).toBeUndefined();
  });

  // A merged PR has no action left on this panel, so it is a record rather
  // than workload — every other state still has one.
  it("leaves merged ones out", () => {
    expect(prBadgeCount([pr({ number: 1 }), pr({ number: 2, state: "MERGED" })])).toBeUndefined();
    expect(prBadgeCount([pr(), pr({ state: "CLOSED" })])).toBe(2);
    expect(
      prBadgeCount([pr(), pr({ isDraft: true }), pr({ state: "MERGED" })]),
    ).toBe(2);
  });
});

describe("threadLabel", () => {
  it("keeps the filename and the line, and drops the directory", () => {
    expect(threadLabel("apps/desktop/src/hooks/useRepo.ts:80")).toBe("useRepo.ts:80");
  });

  // GitHub forgets the line once the code has been pushed over, and leaves
  // the path standing alone.
  it("reads a path with no line", () => {
    expect(threadLabel("apps/desktop/src/lib/pr.ts")).toBe("pr.ts");
    expect(threadLabel("README.md")).toBe("README.md");
  });
});
