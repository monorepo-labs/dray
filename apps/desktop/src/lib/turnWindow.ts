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

/// How many turns a crew strip draws, and it never mounts anything above them.
///
/// A different question from `FIRST_MOUNT`, which is a *cost* window — it holds
/// the open cheap and then quietly fills the rest in, because the reader asked
/// for the whole conversation. A crew strip is a look in on work happening
/// elsewhere, in a 320px column beside the one the reader is actually in, so the
/// whole conversation is not what they asked for: scrolling somebody else's
/// transcript back through an afternoon is what ⌘-click and full view are for.
///
/// Two, which is the smallest number that can hold an exchange — the prompt and
/// what came back — where one would cut between them on every other reading. A
/// turn still running counts as one, so a strip watching a live session shows
/// the work landing under the prompt that asked for it.
///
/// Counting *rows* instead was built and cut. It reads better on paper: a turn
/// is unbounded, so two of them is no cap at all on a session that ran forty
/// tool calls. But the cut then lands mid-turn, and a fragment of somebody
/// else's work with no prompt over it answers none of the question a strip is
/// there for.
export const CREW_TAIL = 2;

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
