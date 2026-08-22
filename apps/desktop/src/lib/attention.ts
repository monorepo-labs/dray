import type { SessionIndexItem, SessionStatus } from "@/types/events";

/// How many sessions want the reader — the count the dock badge carries.
///
/// Deliberately the same predicate the sidebar rail draws a mark from
/// (`asking || status === "completed"`), so the badge is a promise about what
/// opening the window shows: this many marked rows. A second definition would
/// let the dock and the list disagree about how much is waiting.
///
/// Three sources rather than one, because no single one covers both ends of a
/// run. The live status map is empty at launch, where the index carries the
/// `completed` that survived the last one; and it holds sessions the index list
/// currently filters out, since the sidebar shows one side of the archived split
/// at a time and unread is unread either way.
export function attentionCount(
  statusBySession: Record<string, SessionStatus>,
  asksBySession: Record<string, string[]>,
  items: Pick<SessionIndexItem, "sessionId" | "status">[],
): number {
  const persisted = new Map(items.map((item) => [item.sessionId, item.status]));
  const ids = new Set([
    ...Object.keys(statusBySession),
    ...Object.keys(asksBySession),
    ...persisted.keys(),
  ]);

  let count = 0;
  for (const id of ids) {
    const asking = (asksBySession[id]?.length ?? 0) > 0;
    const unread = (statusBySession[id] ?? persisted.get(id)) === "completed";
    if (asking || unread) count += 1;
  }
  return count;
}
