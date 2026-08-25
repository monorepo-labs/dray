import type { PrCheck, PrMark, PullRequest } from "@/types/events";

/// The branch a session's work lands on, for the PR lookup and the header.
///
/// `observed` is what git says HEAD is, and it wins wherever the session still
/// has a checkout of its own to be read off. Everything else
/// here is a *guess made at creation*: a worktree session's branch is the
/// CLI's to name, so it is rebuilt from the worktree name, and the recorded
/// `branch` is whatever was checked out when the session was first sent to.
/// Neither is re-read, so a checkout inside the tree moves HEAD and leaves
/// both describing a branch the session is no longer on — which the PR tab
/// fails *closed* on, asking GitHub about a branch that has no PR and hiding
/// itself because the answer is empty.
///
/// A null `observed` is the ordinary resting state, not an error: the read is
/// per-session and lands a frame late, and a non-repo has no branch at all.
/// The guess is right for every session that leaves HEAD where the CLI put it,
/// which is most of them, so falling back to it beats drawing nothing.
///
/// `worktreeRemoved` is the one case `observed` loses. A relocated session runs
/// in the project root, shared with every other session and with the reader's
/// own editor — so HEAD there answers "what is this checkout on", never "where
/// did this session's work land". Reading it moved the PR tab onto `main` the
/// moment a tree was settled, which is exactly when the PR is most likely open.
/// The recorded `branch` survives the removal for this, and the sidebar's mark
/// kept working throughout because it never had an `observed` to be misled by.
///
/// One function because the header and the PR lookup have to agree about which
/// branch the session is on; two rebuilding it apart is how they come to
/// disagree about which PR it has.
export function sessionBranch(
  session: {
    branch: string | null;
    worktreeName: string | null;
    worktreeRemoved?: boolean;
  },
  observed?: string | null,
): string | null {
  if (session.worktreeRemoved) return session.branch;
  if (observed) return observed;
  return session.worktreeName ? `worktree-${session.worktreeName}` : session.branch;
}

/// Which pull request a sidebar row draws, out of every one on its branch.
///
/// One branch can carry several — the same fix opened against `main` and a
/// release branch, or a follow-up opened after the first one landed — and the
/// row has space for exactly one glyph. Live work outranks a record: an open PR
/// wins over a merged one however recently that merged, because the mark's job
/// is "what is there to do here", and a draft beats a merged one for the same
/// reason. Only where *nothing* is open does the row say merged, which is
/// precisely when that is the useful thing to say: the work landed and the
/// session can be settled.
///
/// Ties inside a rank go to the first, and the backend hands both halves back
/// ordered by most recently updated — so a branch with two open PRs marks
/// itself from the one being worked on.
export function pickPrMark(prs: PrMark[]): PrMark | undefined {
  const rank = (pr: PrMark) => (pr.state !== "OPEN" ? 2 : pr.isDraft ? 1 : 0);

  let best: PrMark | undefined;
  for (const pr of prs) {
    if (!best || rank(pr) < rank(best)) best = pr;
  }
  return best;
}

/// What the tab's badge says, or nothing.
///
/// Merged PRs are left out. Every other state on this panel has something the
/// reader can still do — an open one merges, a draft goes ready, a closed one
/// reopens — and a merged one has nothing at all, so counting it inflates a
/// badge that exists to say how much is still live. It stays in the list
/// either way; the list is a record and the badge is a workload.
///
/// Absent at one, like the subagent count: a tab reading "PR 1" says what
/// opening it says.
export function prBadgeCount(prs: PullRequest[]): number | undefined {
  const live = prs.filter((pr) => pr.state !== "MERGED").length;
  return live > 1 ? live : undefined;
}

export type Tone = "ready" | "blocked" | "conflict" | "pending" | "neutral";

export type Readiness = {
  tone: Tone;
  label: string;
  /// One line of why, or nothing where the label says all of it.
  detail?: string;
};

/// Whether the PR can land, in the words the reader needs.
///
/// GitHub answers this across three fields that overlap — `state`, `mergeable`,
/// `mergeStateStatus` — and the order they're read in is the whole of the
/// logic: a closed PR's merge state is stale, a conflict outranks a failing
/// check, and `UNKNOWN` means GitHub hasn't worked it out rather than that the
/// answer is no. Reading them in any other order puts "Ready to merge" above a
/// conflict.
export function mergeReadiness(pr: PullRequest): Readiness {
  if (pr.state === "MERGED") return { tone: "neutral", label: "Merged" };
  if (pr.state === "CLOSED") return { tone: "neutral", label: "Closed without merging" };

  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return {
      tone: "conflict",
      label: "Conflicts with base",
      detail: `Resolve against ${pr.baseRefName} before merging.`,
    };
  }

  // Asked lazily by GitHub, so the first read of a fresh PR lands here and the
  // next poll settles it. Saying so beats showing a merge button that fails.
  if (pr.mergeable === "UNKNOWN") {
    return { tone: "pending", label: "Checking mergeability…" };
  }

  if (pr.isDraft) {
    return { tone: "neutral", label: "Draft", detail: "Mark ready to request review and merge." };
  }

  switch (pr.mergeStateStatus) {
    case "BEHIND":
      return {
        tone: "blocked",
        label: `Behind ${pr.baseRefName}`,
        detail: "Update the branch before merging.",
      };
    case "BLOCKED":
      return {
        tone: "blocked",
        label: "Blocked",
        detail:
          pr.reviewDecision === "CHANGES_REQUESTED"
            ? "Changes were requested."
            : pr.reviewDecision === "REVIEW_REQUIRED"
              ? "A review is required."
              : "A required check or rule is not satisfied.",
      };
    case "UNSTABLE":
      return {
        tone: "pending",
        label: "Checks not passing",
        detail: "Merging is allowed, but something is red.",
      };
    default:
      return { tone: "ready", label: "Ready to merge" };
  }
}

export type CheckSummary = {
  passed: number;
  failed: number;
  pending: number;
  total: number;
};

export function summarizeChecks(checks: PrCheck[]): CheckSummary {
  const summary: CheckSummary = { passed: 0, failed: 0, pending: 0, total: checks.length };

  for (const check of checks) {
    if (check.state === "success") summary.passed += 1;
    else if (check.state === "failure") summary.failed += 1;
    else if (check.state === "pending") summary.pending += 1;
  }

  return summary;
}

/// True while something is *visibly* in flight — a check still running, a
/// mergeability GitHub has not worked out yet.
///
/// This picks the panel's poll *rate*, not whether it polls at all. It used to
/// gate the poll outright, and that was wrong in the one window that mattered:
/// a check which has not registered yet leaves the rollup empty, exactly like a
/// repo with no CI, so a PR the app had just opened read as settled and never
/// re-asked. See `OPEN_POLL_MS`.
export function isSettling(pr: PullRequest | null): boolean {
  if (!pr || pr.state !== "OPEN") return false;
  return pr.mergeable === "UNKNOWN" || pr.checks.some((c) => c.state === "pending");
}

/// The first line worth showing, for a collapsed comment's preview.
///
/// The preview is plain text in a truncating span, so the markup that would
/// have been rendered has to come off first: a heading's `#` marks say nothing
/// at one line long, and a link's `(https://…)` half is usually longer than the
/// words around it and is not clickable here anyway.
export function firstLine(body: string): string {
  return (
    body
      .split("\n")
      .map((line) =>
        line
          .replace(/^#{1,6}\s+/, "")
          // `[text](url)` keeps its text; a bare image `![alt](url)` keeps its
          // alt, which is the only word in it a reader can use.
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/[*_`]/g, "")
          .trim(),
      )
      .find((line) => line.length > 0) ?? ""
  );
}

/// What an inline thread's row calls the place it hangs — the filename and the
/// line, out of a path that carries both.
///
/// The directory goes: the pane is half a window wide and a deep path spends
/// the whole row saying where in the tree a file sits, which is the half a
/// reader who is looking at this PR already knows. The full path rides the
/// row's `title`, which is what that attribute is for here — text the app is
/// truncating rather than a fact it is hiding.
export function threadLabel(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/// Bodies as bots write them, minus the machinery they hide their state in.
///
/// Vercel opens every comment with a base64 blob on a `[vc]: #…` line and
/// several reviewers bracket their badges in HTML comments. Both are addressed
/// to GitHub rather than to a reader, and both survive into the rendered
/// markdown as a stray line of noise at the top of the card.
export function stripBotMarkers(body: string): string {
  return body
    .replace(/^\[[a-z-]+\]: #[^\n]*\n?/gim, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}
