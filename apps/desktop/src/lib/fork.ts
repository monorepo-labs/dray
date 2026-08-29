import type { SessionStatus } from "@/types/events";

/// Whether Fork is refused right now, which is the *turn* being in flight and
/// nothing wider. The CLI forks by reading the parent's transcript, which a
/// live child is appending to mid-turn, so a fork taken there inherits half a
/// turn.
///
/// One question stated twice: `SessionManager::fork` refuses on
/// `StatusTracker::turn_in_flight()`, and `in_progress` is exactly that
/// predicate — pinned on the Rust side, since neither half can call the other.
/// It sits here rather than inline in the menu so there is one place the rule
/// is written, and the two cannot drift again: guarding on a background task
/// outstanding took Fork away from every session running a dev server, while
/// this side went on drawing the item enabled, so it looked available and
/// errored on click.
export function forkBlocked(status: SessionStatus | undefined): boolean {
  return status === "in_progress";
}
