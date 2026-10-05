import type { AgentEvent } from "@/types/events";

/// What a `dray-serve` sends on every connect: what lives in its memory and in
/// no log. A request is only ever answerable by the child that asked, so this
/// is the whole truth about which cards are open — a reconnect that kept its
/// own copy could draw one already answered, or miss one raised meanwhile.
/// See SERVE-PLAN.md.
export type LiveState = {
  asks: AgentEvent[];
  /// The newest `background_tasks_changed` per session, which replaces.
  tasks: AgentEvent[];
};

/// The logged events a client missed: everything in `fetched` (a log tail, in
/// log order) after the newest event it already `held`. `null` where the tail
/// shares no event with what is held, so an older page is needed first.
///
/// Matched on event id, never `seq`: a Claude Code subagent numbers its own
/// events from 0 inside the same log, so no seq is a cursor.
export function missedEvents(held: AgentEvent[], fetched: AgentEvent[]): AgentEvent[] | null {
  const ids = new Set(held.map((e) => e.id));
  for (let i = fetched.length - 1; i >= 0; i--) {
    if (ids.has(fetched[i].id)) return fetched.slice(i + 1);
  }
  return held.length === 0 ? fetched : null;
}
