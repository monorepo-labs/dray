import type { SessionIndexItem, SessionSnapshot } from "@/types/events";

/// What evicted transcripts may hold between them, in JSON characters.
const BUDGET = 32 * 1024 * 1024;

/// Transcripts of sessions on a remote server that are not loaded — evicted,
/// or read ahead of a click (`warmPicks`), which holds a first frame alone
/// (`lite`) — so opening one draws at once and asks only for what it lacks. A remote page is megabytes over a slow
/// link, where This Mac reads its own disk in milliseconds and keeps nothing.
///
/// Held as JSON rather than as the objects: eviction exists because resident
/// transcripts reached hundreds of megabytes, and a string's size is what it
/// costs, where an object graph is several times its JSON and unmeasurable. A
/// return pays one `JSON.parse`. Map order is the LRU order.
const kept = new Map<string, string>();
let used = 0;

export function keepTranscript(snapshot: SessionSnapshot, budget = BUDGET): void {
  forgetTranscript(snapshot.sessionId);
  const json = JSON.stringify(snapshot);
  if (json.length > budget) return;
  kept.set(snapshot.sessionId, json);
  used += json.length;
  for (const [id] of kept) {
    if (used <= budget) break;
    forgetTranscript(id);
  }
}

/// The kept copy, handed back and no longer held — it is going back into state.
export function takeTranscript(sessionId: string): SessionSnapshot | null {
  const json = kept.get(sessionId);
  if (json === undefined) return null;
  forgetTranscript(sessionId);
  return JSON.parse(json) as SessionSnapshot;
}

export const hasTranscript = (sessionId: string): boolean => kept.has(sessionId);

/// How many of a server's sessions are read ahead of a click.
const WARM_COUNT = 6;

/// The sessions on one remote server worth reading before the reader asks:
/// its most recently touched, pinned first, as the sidebar leads with them.
/// A first frame still costs the link's round trip — 195ms to a sandbox,
/// measured — so the only open that feels local is one with no read in it.
///
/// Mid-turn is skipped: its copy would be stale on arrival, and the turn's end
/// reads it then. Set aside and hidden are skipped as rows nobody is about to
/// click.
export function warmPicks(items: SessionIndexItem[], count = WARM_COUNT): string[] {
  return items
    .filter((i) => !i.archived && !i.aside && !i.hidden && i.status !== "in_progress")
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modified.localeCompare(a.modified))
    .slice(0, count)
    .map((i) => i.sessionId);
}

export function forgetTranscript(sessionId: string): void {
  const json = kept.get(sessionId);
  if (json === undefined) return;
  kept.delete(sessionId);
  used -= json.length;
}
