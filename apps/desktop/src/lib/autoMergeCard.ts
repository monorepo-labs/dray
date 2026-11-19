import { prStatus } from "@/lib/pr";
import type { PrMark, SessionStatus } from "@/types/events";

/// How long a new tip waits before its card can go up. Checks register on
/// their own schedule after a push — CI and a review bot a few seconds to a
/// minute later — and until one has, GitHub reads the PR as `CLEAN`.
export const SETTLE_MS = 60_000;

/// How long a tip waits for as many checks as an earlier push carried before
/// it is taken without them: a path-filtered workflow may never run on it.
export const EXPECT_MS = 10 * 60_000;

/// Whether a task's PR is ready for its merge card, by the repo's own GitHub
/// rules alone: `CLEAN` covers branch protection, required checks and required
/// reviews, and `prStatus` adds that nothing is still running.
export function readyForCard(mark: PrMark): boolean {
  return mark.state === "OPEN" && mark.mergeStateStatus === "CLEAN" && prStatus(mark).key === "ready";
}

/// What the card gate remembers of one open PR between reads.
export type CardWatch = {
  /// The tip it describes; `null` from a server too old to say.
  head: string | null;
  /// When the first read showing this tip was asked for.
  since: number;
  /// The most checks an earlier tip of this PR carried.
  expected: number;
  /// The most checks this tip has carried so far.
  seen: number;
};

/// Folds one read of an open PR into what the gate remembers of it. A new tip
/// starts the wait again and expects the checks the last one had.
export function watchPr(prev: CardWatch | undefined, mark: PrMark, readAt: number): CardWatch {
  const head = mark.headOid ?? null;
  const count = mark.checkCount ?? 0;
  if (prev && prev.head === head) return count > prev.seen ? { ...prev, seen: count } : prev;
  return { head, since: readAt, expected: Math.max(prev?.expected ?? 0, prev?.seen ?? 0), seen: count };
}

/// Whether the card can go up on a read asked at `readAt`.
///
/// `CLEAN` with no check running is also what a push reads as before any check
/// has started, so ready must hold on a read asked [SETTLE_MS] after the tip
/// first showed: a check registering in between reads as running there. A tip
/// carrying fewer checks than the one before it waits on the rest, up to
/// [EXPECT_MS].
export function cardDue(mark: PrMark, watch: CardWatch, readAt: number): boolean {
  if (!readyForCard(mark)) return false;
  const waited = readAt - watch.since;
  if (waited < SETTLE_MS) return false;
  return (mark.checkCount ?? 0) >= watch.expected || waited >= EXPECT_MS;
}

/// Whether a task's turn is over, judged on a PR read asked at `readAt`.
/// `endedAt` is when this app saw the task stop, on its own clock: a task on
/// another machine stamps `modified` with that machine's. A read asked before
/// then may predate the turn's last push, so the card waits for the next one
/// and ready must still hold.
export function turnEnded(status: SessionStatus, endedAt: number, readAt: number): boolean {
  return status !== "in_progress" && readAt >= endedAt;
}
