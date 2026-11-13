import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import type { GreptileReview } from "@/types/events";

export const GREPTILE_SCORES = [1, 2, 3, 4, 5] as const;
const KEY = "dray.mergeCardGreptileScore";
const DEFAULT_SCORE = 5;

function coerce(raw: unknown): number {
  return GREPTILE_SCORES.includes(raw as never) ? (raw as number) : DEFAULT_SCORE;
}

// A module store: Settings writes it while `App`'s hook reads it.
let minScore = coerce(readLocalStorage<unknown>(KEY, DEFAULT_SCORE));
const changed = channel<void>();

export function setMinGreptileScore(score: number) {
  minScore = coerce(score);
  writeLocalStorage(KEY, minScore);
  changed.emit();
}

export const useMinGreptileScore = () => useSyncExternalStore(changed.subscribe, () => minScore);

/// Whether Greptile lets a task's merge card go up: a score at `min`, or one
/// below it with every Greptile thread resolved — resolving is how a finding is
/// marked seen and set aside. A repo without Greptile passes on GitHub's
/// verdict alone; one with it waits for a review of the head commit.
export function greptileClears(review: GreptileReview, min: number): boolean {
  if (!review.present) return true;
  if (review.score === null || review.stale) return false;
  return review.score >= min || (review.score === min - 1 && review.unresolved === 0);
}
