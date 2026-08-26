/// The two pull-request readers telling each other what they learned.
///
/// [usePrMarks](../hooks/usePrMarks.ts) reads one repo at a time for the
/// sidebar and the "Ready to merge" notice; [usePullRequest](../hooks/usePullRequest.ts)
/// reads one branch at a time for the panel. Each has its own cache, poll rate
/// and freshness window, and with nothing joining them the reader saw one
/// surface move while the other stood still — a card saying ready above a panel
/// still saying "Checks not passing", or a panel gone green beside a row still
/// spinning. Neither reader can import the other's hook without a cycle, so
/// they meet here.
///
/// Signals only, never data. The marks read cannot fill the panel (it carries
/// no checks, no comments) and the panel read cannot fill a mark (its checks
/// state is the backend's fold of GitHub's rollup, which the panel's per-check
/// list is not). So each side says *what it thinks is stale* and the other
/// re-reads for itself, which keeps one source of truth per surface.
import type { PullRequest } from "@/types/events";

type Listener<T> = (value: T) => void;

function channel<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(value: T) {
      for (const listener of listeners) listener(value);
    },
  };
}

/// A marks read found this branch's pull request changed since the last read.
/// The panel drops its stamp for the branch and re-reads if it is on screen.
export const branchChanged = channel<string>();

/// A panel read landed. The marks side compares it against the mark it holds
/// for that branch — only it has one — and re-reads the repo on disagreement.
export const panelRead = channel<{ cwd: string; branch: string; prs: PullRequest[] }>();
