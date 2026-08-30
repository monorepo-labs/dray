/// How many of the newest turns a transcript draws on its first commit. The
/// transcript opens pinned to the bottom, so these are the turns on screen;
/// everything older mounts behind them in steps of `MOUNT_STEP`.
///
/// Why not all of them: each collapsed turn renders its answer through
/// Streamdown, and that parse is the whole cost of opening a long session —
/// measured at 150–260ms for 53 answers before the DOM was even committed,
/// against under 100ms for reading, transferring and parsing the 11MB log they
/// came from. Eight covers a full pane at any height this app runs at.
export const FIRST_MOUNT = 8;

/// Turns mounted per deferred step. Small enough that a step never holds the
/// main thread for more than a few frames, large enough that a 60-turn session
/// finishes in under ten.
export const MOUNT_STEP = 8;

/// The window is the index of the oldest mounted turn, not a count from the
/// end. A count would re-anchor on every turn the live session appends —
/// evicting the oldest mounted turn until the next step put it back, losing
/// its expansion state and shifting an unpinned reader's view. An index only
/// ever moves down, and a turn appended at the end is inside the window by
/// construction.
export function firstMount(total: number): number {
  return Math.max(0, total - FIRST_MOUNT);
}

/// Every turn from `start` on, in transcript order.
export function mountedTurns<T>(turns: readonly T[], start: number): T[] {
  return start <= 0 ? [...turns] : turns.slice(start);
}

/// Where the next step begins. Stops at 0, so a finished backfill schedules
/// nothing.
export function grow(start: number): number {
  return Math.max(0, start - MOUNT_STEP);
}
