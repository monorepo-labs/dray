import type { PrCheck, PullRequest } from "@/types/events";

/// The branch a session's work lands on. A worktree session's branch is named
/// by the CLI from the worktree name and never recorded on the index, so it has
/// to be rebuilt here — and both the header and the PR lookup have to rebuild
/// it the same way or they disagree about which PR the session has.
export function sessionBranch(session: {
  branch: string | null;
  worktreeName: string | null;
}): string | null {
  return session.worktreeName ? `worktree-${session.worktreeName}` : session.branch;
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

/// True while something could still change on its own. The panel's poll hangs
/// off this — a PR whose checks have all reported is not going to move under
/// the reader's eyes, so nothing needs to keep asking.
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
