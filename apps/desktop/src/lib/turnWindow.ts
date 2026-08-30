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

/// The newest `mounted` turns, in transcript order. Fewer turns than that is
/// every turn.
export function mountedTurns<T>(turns: readonly T[], mounted: number): T[] {
  return turns.slice(Math.max(0, turns.length - mounted));
}

/// How many turns the next step draws. Never past the total, so a session that
/// finishes backfilling stops scheduling steps.
export function grow(mounted: number, total: number): number {
  return Math.min(total, mounted + MOUNT_STEP);
}
