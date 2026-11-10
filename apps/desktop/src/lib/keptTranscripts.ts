import type { SessionSnapshot } from "@/types/events";

/// What evicted transcripts may hold between them, in JSON characters.
const BUDGET = 32 * 1024 * 1024;

/// Evicted transcripts of sessions on a remote server, so a return draws at
/// once and asks only for what is new. A remote page is megabytes over a slow
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

export function forgetTranscript(sessionId: string): void {
  const json = kept.get(sessionId);
  if (json === undefined) return;
  kept.delete(sessionId);
  used -= json.length;
}
