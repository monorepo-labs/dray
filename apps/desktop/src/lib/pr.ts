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

/// Whether two readings of one branch's mark say the same thing, on every field
/// a row or a notice reads. What [usePrMarks](../hooks/usePrMarks.ts) asks after
/// each read to decide whether the panel's own cache for that branch is stale.
export function sameMark(a: PrMark | undefined, b: PrMark | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.isDraft === b.isDraft &&
    a.checksState === b.checksState &&
    a.mergeable === b.mergeable &&
    a.mergeStateStatus === b.mergeStateStatus
  );
}

/// Whether the panel's answer for a branch contradicts the sidebar's mark for
/// it — the trigger for a marks re-read, never the mark itself.
///
/// Compared on the fields both carry: which pull request the mark would pick,
/// and its merge state. Checks are compared loosely, since the mark's checks
/// state is the backend's fold of GitHub's rollup and the panel holds a
/// per-check list; a row spinning with nothing pending, or plain with something
/// failed, are the disagreements a reader sees, so those are what is asked. A
/// wrong answer here costs one extra `gh` and never a wrong glyph, because the
/// re-read is what draws.
///
/// Closed-without-merging sits outside the marks' vocabulary, so the panel's
/// list is narrowed to what the marks would have seen first.
export function markDisagrees(mark: PrMark | undefined, prs: PullRequest[]): boolean {
  // Newest-updated first, the order the marks arrive in. `pickPrMark` breaks
  // ties within a rank by position, and the panel's list is ordered by number,
  // so without this two open PRs on one branch pick differently on each side
  // and every panel poll would force a marks read that changes nothing.
  const seen = prs
    .filter((pr) => pr.state === "OPEN" || pr.state === "MERGED")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pick = pickPrMark(
    seen.map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      isDraft: pr.isDraft,
      state: pr.state as PrMark["state"],
      checksState: "CLEAR",
      mergeable: pr.state === "OPEN" ? pr.mergeable : null,
      mergeStateStatus: pr.state === "OPEN" ? pr.mergeStateStatus : null,
    })),
  );

  if (!mark || !pick) return mark !== pick;
  if (!sameMark({ ...mark, checksState: "CLEAR" }, pick)) return true;

  const checks = seen.find((pr) => pr.number === pick.number)?.checks ?? [];
  const pending = checks.some((c) => c.state === "pending");
  const failing = checks.some((c) => c.state === "failure");
  if (mark.checksState === "RUNNING") return !pending;
  if (mark.checksState === "FAILING") return !failing;
  return failing && !pending;
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

/// The fields the verdict below turns on, and no more — so a sidebar mark can
/// be judged by the same rule the panel is, without carrying a panel's worth of
/// pull request to do it. Nullable because the marks query asks for them on its
/// open half alone.
export type MergeState = {
  state: string;
  isDraft: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
};

/// Why a pull request can or cannot land, as one word.
///
/// GitHub answers this across three fields that overlap — `state`, `mergeable`,
/// `mergeStateStatus` — and the order they're read in is the whole of the
/// logic: a closed PR's merge state is stale, a conflict outranks a failing
/// check, and `UNKNOWN` means GitHub hasn't worked it out rather than that the
/// answer is no. Reading them in any other order puts "Ready to merge" above a
/// conflict.
///
/// Split from the words it is said in because two surfaces need the verdict and
/// only one of them needs a sentence: [mergeReadiness] writes the panel's line,
/// and [isReadyToMerge] asks the one question a notice turns on. A predicate
/// written beside this rather than out of it would be a second copy of an order
/// that took a while to get right.
export type MergeVerdict =
  | "merged"
  | "closed"
  | "conflict"
  | "unknown"
  | "draft"
  | "behind"
  | "blocked"
  | "unstable"
  | "ready";

export function mergeVerdict(pr: MergeState): MergeVerdict {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";

  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflict";

  // `UNKNOWN` is asked lazily by GitHub, so the first read of a fresh PR lands
  // here and the next poll settles it. A *null* is the other way of not
  // knowing — the sidebar's marks carry these for open pull requests only — and
  // it has to land in the same place: not having asked is not an answer, and
  // reading it as one would announce a merged PR as ready to merge.
  if (pr.mergeable === "UNKNOWN" || pr.mergeable === null || pr.mergeStateStatus === null) {
    return "unknown";
  }

  if (pr.isDraft) return "draft";

  switch (pr.mergeStateStatus) {
    case "BEHIND":
      return "behind";
    case "BLOCKED":
      return "blocked";
    case "UNSTABLE":
      return "unstable";
    // GitHub's own word for "I cannot work this out right now", and the second
    // way this field says nothing — `mergeable` settling to `MERGEABLE` does not
    // settle this one, so it has to be named rather than left to the arm below.
    // Read as ready it puts a merge button under a PR that cannot take one, and
    // now also sounds a notification for it.
    case "UNKNOWN":
      return "unknown";
    // What is left is `CLEAN` and `HAS_HOOKS` — nothing in the way, with or
    // without a pre-receive hook to run on the way in.
    default:
      return "ready";
  }
}

/// Whether it can land right now — nothing in the way, nothing left to wait
/// for. What the "Ready to merge" notice fires on.
export function isReadyToMerge(pr: MergeState): boolean {
  return mergeVerdict(pr) === "ready";
}

/// One step of "which pull requests have just become ready", against what they
/// last said. `observed` is every session being watched paired with its answer
/// now; the result is what to remember and which sessions changed.
///
/// **A session seen for the first time changes nothing.** Its answer is
/// recorded and no more, because the app cannot tell a pull request that turned
/// green a moment ago from one that has been green for a week — so announcing
/// on a first sighting would open a card for every landed branch in the list
/// each time the app starts, or a project is switched back to.
///
/// **Pruning falls out of building the map from `observed` alone.** A session
/// that stops being watched — archived, filtered away, its repo's read not
/// landed — is forgotten rather than carried, so it comes back as a first
/// sighting. That is the safe direction: re-seeding costs one announcement that
/// was never made, where remembering a `false` across an absence would raise
/// one for a pull request that was ready the whole time the row was gone.
export function readyTransitions(
  prev: Map<string, boolean>,
  observed: Iterable<readonly [string, boolean]>,
): { next: Map<string, boolean>; became: string[] } {
  const next = new Map<string, boolean>();
  const became: string[] = [];

  for (const [sessionId, ready] of observed) {
    next.set(sessionId, ready);
    if (ready && prev.get(sessionId) === false) became.push(sessionId);
  }

  return { next, became };
}

/// Whether the PR can land, in the words the reader needs.
export function mergeReadiness(pr: PullRequest): Readiness {
  switch (mergeVerdict(pr)) {
    case "merged":
      return { tone: "neutral", label: "Merged" };
    case "closed":
      return { tone: "neutral", label: "Closed without merging" };
    case "conflict":
      return {
        tone: "conflict",
        label: "Conflicts with base",
        detail: `Resolve against ${pr.baseRefName} before merging.`,
      };
    // Saying so beats showing a merge button that fails.
    case "unknown":
      return { tone: "pending", label: "Checking mergeability…" };
    case "draft":
      return { tone: "neutral", label: "Draft", detail: "Mark ready to request review and merge." };
    case "behind":
      return {
        tone: "blocked",
        label: `Behind ${pr.baseRefName}`,
        detail: "Update the branch before merging.",
      };
    case "blocked":
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
    case "unstable":
      return {
        tone: "pending",
        label: "Checks not passing",
        detail: "Merging is allowed, but something is red.",
      };
    case "ready":
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
