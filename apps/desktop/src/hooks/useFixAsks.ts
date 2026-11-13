import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import type { PrStatusKey } from "@/lib/pr";
import { fixAskDone, type FixAsk } from "@/lib/stalled";
import type { PrMark } from "@/types/events";

/// When each task was asked to mend its PR, by session id. Kept across
/// launches, so a relaunch still says how long a fix has run.
const KEY = "ade.fixAsks";
const CAP = 200;

const EMPTY: Record<string, FixAsk> = {};
let asks: Record<string, FixAsk> | null = null;
const listeners = new Set<() => void>();

// Read on first use, not at import: tests stand `localStorage` up after.
const current = () => (asks ??= readLocalStorage<Record<string, FixAsk>>(KEY, EMPTY));

function write(next: Record<string, FixAsk>) {
  asks = next;
  writeLocalStorage(KEY, next);
  listeners.forEach((l) => l());
}

/// Notes that a task was asked to fix `status` on PR `pr`: by the app's nudge
/// to its bot, or the reader's Fix conflicts. An ask already standing for the
/// same problem keeps its time, so a second nudge never hides how long the
/// first has run.
export function recordFixAsk(sessionId: string, pr: number, status: PrStatusKey, at = Date.now()): void {
  const was = current()[sessionId];
  if (was && was.pr === pr && was.status === status) return;
  const kept = Object.entries({ ...current(), [sessionId]: { pr, status, at } })
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, CAP);
  write(Object.fromEntries(kept));
}

/// Drops each ask whose task's PR has moved off what it was asked about:
/// conflict gone, checks passing or running again, merged, a new PR. A task
/// with no mark read yet keeps its ask.
export function pruneFixAsks(prs: Iterable<readonly [string, PrMark | undefined]>): void {
  const all = current();
  const done = [...prs].filter(([id, pr]) => all[id] && pr && fixAskDone(all[id], pr)).map(([id]) => id);
  if (done.length === 0) return;
  write(Object.fromEntries(Object.entries(all).filter(([id]) => !done.includes(id))));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/// Every standing ask, by session id.
export function useFixAsks(): Record<string, FixAsk> {
  return useSyncExternalStore(subscribe, current, current);
}
