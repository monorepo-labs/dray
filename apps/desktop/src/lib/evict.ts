import type { SessionStatus } from "@/types/events";

/// How long a loaded transcript may sit unviewed before it is dropped from
/// memory and left to be re-read from disk on the next open.
export const IDLE_EVICT_MS = 10 * 60 * 1000;

export type EvictInput = {
  selected: boolean;
  status: SessionStatus | undefined;
  asking: boolean;
  /// `undefined` = never viewed since it was loaded, which counts as idle.
  lastViewed: number | undefined;
  now: number;
  /// Archive or settle: the idle clock is skipped, the safety checks are not.
  force: boolean;
};

/// Whether a loaded session's transcript may leave memory.
///
/// Three things are never evicted whatever the clock says: the session on
/// screen, one mid-turn (its live events would land in the early-event hold
/// instead of the transcript), and one holding a permission or question card,
/// since that card is not on disk and only the child that asked can redraw it.
export function shouldEvict(s: EvictInput): boolean {
  if (s.selected || s.status === "in_progress" || s.asking) return false;
  if (s.force) return true;
  return s.now - (s.lastViewed ?? 0) >= IDLE_EVICT_MS;
}
