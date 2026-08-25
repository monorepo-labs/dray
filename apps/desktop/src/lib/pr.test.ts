import { describe, expect, it } from "vitest";

import {
  firstLine,
  isReadyToMerge,
  isSettling,
  readyTransitions,
  mergeReadiness,
  pickPrMark,
  prBadgeCount,
  sessionBranch,
  stripBotMarkers,
  summarizeChecks,
  threadLabel,
} from "./pr";
import type { PrCheck, PrMark, PullRequest } from "@/types/events";

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

  // The relocated session runs in the project root, so HEAD there is whatever
  // that shared checkout happens to be on — `main`, most of the time. Reading
  // it took the PR tab away the moment a tree was settled.
  it("ignores the shared checkout's HEAD once the worktree is gone", () => {
    expect(
      sessionBranch(
        { branch: "worktree-calm-owl", worktreeName: null, worktreeRemoved: true },
        "main",
      ),
    ).toBe("worktree-calm-owl");
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

  // The two fields settle separately, so `mergeable` coming back `MERGEABLE`
  // says nothing about this one. Left to the switch's default arm it read as
  // ready, which puts a merge button under a PR that cannot take one.
  it("does not call an unresolved merge state ready either", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "UNKNOWN" })).tone).toBe("pending");
  });

  // The arm everything unnamed falls through to, and the only two words that
  // belong there.
  it("reads a clean tree with hooks to run as ready", () => {
    expect(mergeReadiness(pr({ mergeStateStatus: "HAS_HOOKS" })).tone).toBe("ready");
    expect(mergeReadiness(pr({ mergeStateStatus: "CLEAN" })).tone).toBe("ready");
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

describe("isReadyToMerge", () => {
  const mark = (over: Partial<PrMark> = {}): PrMark => ({
    number: 1,
    headRefName: "feat/x",
    isDraft: false,
    state: "OPEN",
    checksState: "CLEAR",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    ...over,
  });

  // The whole point of the split: a sidebar mark carries four of the panel's
  // fields and is judged by the same ordered rule, so the notice and the
  // panel's own line can never disagree about whether something can land.
  it("answers for a sidebar mark and for a full pull request alike", () => {
    expect(isReadyToMerge(mark())).toBe(true);
    expect(isReadyToMerge(pr())).toBe(true);
    expect(mergeReadiness(pr()).tone).toBe("ready");
  });

  it("is false for everything standing in the way", () => {
    expect(isReadyToMerge(mark({ isDraft: true }))).toBe(false);
    expect(isReadyToMerge(mark({ mergeable: "CONFLICTING" }))).toBe(false);
    expect(isReadyToMerge(mark({ mergeStateStatus: "BLOCKED" }))).toBe(false);
    expect(isReadyToMerge(mark({ mergeStateStatus: "BEHIND" }))).toBe(false);
    expect(isReadyToMerge(mark({ mergeStateStatus: "UNSTABLE" }))).toBe(false);
  });

  // The marks query asks for these on its open half alone, so a merged mark
  // carries nulls. Reading a null as "nothing in the way" would announce work
  // that has already landed as ready to land.
  it("reads unasked fields as not knowing, never as ready", () => {
    expect(isReadyToMerge(mark({ state: "MERGED", mergeable: null, mergeStateStatus: null }))).toBe(
      false,
    );
    expect(isReadyToMerge(mark({ mergeable: null }))).toBe(false);
    expect(isReadyToMerge(mark({ mergeStateStatus: null }))).toBe(false);
    // Same answer for GitHub's own two ways of not knowing. `mergeable` lands
    // there on the first read of a fresh PR; `mergeStateStatus` can be there
    // while `mergeable` has already settled, which is the case that fired a
    // notification sound for a PR that could not be merged.
    expect(isReadyToMerge(mark({ mergeable: "UNKNOWN" }))).toBe(false);
    expect(isReadyToMerge(mark({ mergeStateStatus: "UNKNOWN" }))).toBe(false);
  });
});

describe("readyTransitions", () => {
  // Launching onto a sidebar of work that landed last week must not open a card
  // for every row of it. The app cannot tell that from a PR that turned green a
  // second ago, so the first sighting is only ever recorded.
  it("records a first sighting without announcing it", () => {
    const { next, became } = readyTransitions(new Map(), [
      ["a", true],
      ["b", false],
    ]);
    expect(became).toEqual([]);
    expect(next.get("a")).toBe(true);
    expect(next.get("b")).toBe(false);
  });

  it("announces the change out of not-ready, once", () => {
    const first = readyTransitions(new Map([["a", false]]), [["a", true]]);
    expect(first.became).toEqual(["a"]);

    // The same answer again is not news.
    expect(readyTransitions(first.next, [["a", true]]).became).toEqual([]);
  });

  // A check re-runs, goes red and comes back green: that is a pull request
  // becoming ready again, and saying so is right.
  it("announces again after it stops being ready", () => {
    const ready = readyTransitions(new Map([["a", false]]), [["a", true]]);
    const broke = readyTransitions(ready.next, [["a", false]]);
    expect(broke.became).toEqual([]);
    expect(readyTransitions(broke.next, [["a", true]]).became).toEqual(["a"]);
  });

  // Archived, filtered away, or its repo's read simply not landed. Forgetting
  // is the safe direction: it costs an announcement that was never made, where
  // remembering the `false` would raise one for a PR that had been ready the
  // whole time the row was off screen.
  it("forgets a session it stops being told about", () => {
    const seeded = readyTransitions(new Map([["a", false]]), [["a", false]]);
    const away = readyTransitions(seeded.next, []);
    expect(away.next.size).toBe(0);
    expect(readyTransitions(away.next, [["a", true]]).became).toEqual([]);
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

describe("pickPrMark", () => {
  const mark = (over: Partial<PrMark> = {}): PrMark => ({
    number: 1,
    headRefName: "feat/x",
    isDraft: false,
    state: "OPEN",
    checksState: "CLEAR",
    mergeable: null,
    mergeStateStatus: null,
    ...over,
  });

  it("has nothing to pick from an empty list", () => {
    expect(pickPrMark([])).toBeUndefined();
  });

  // A branch whose first PR landed and whose follow-up is still open reads as
  // live work, not as done.
  it("takes an open one over a merged one whichever order they arrive in", () => {
    const open = mark({ number: 9 });
    const merged = mark({ number: 4, state: "MERGED" });
    expect(pickPrMark([merged, open])).toBe(open);
    expect(pickPrMark([open, merged])).toBe(open);
  });

  it("takes a draft over a merged one, for the same reason", () => {
    const draft = mark({ number: 9, isDraft: true });
    const merged = mark({ number: 4, state: "MERGED" });
    expect(pickPrMark([merged, draft])).toBe(draft);
  });

  it("takes a real open one over a draft", () => {
    const draft = mark({ number: 9, isDraft: true });
    const open = mark({ number: 8 });
    expect(pickPrMark([draft, open])).toBe(open);
  });

  // Only where nothing is live, which is exactly when "this landed, settle it"
  // is the useful thing for the row to say.
  it("says merged when that is all there is", () => {
    const merged = mark({ number: 4, state: "MERGED" });
    expect(pickPrMark([merged])).toBe(merged);
  });

  // Each half arrives most-recently-updated first, so the first of a rank is
  // the one being worked on.
  it("keeps the first within a rank", () => {
    const newer = mark({ number: 9 });
    const older = mark({ number: 2 });
    expect(pickPrMark([newer, older])).toBe(newer);
  });
});
