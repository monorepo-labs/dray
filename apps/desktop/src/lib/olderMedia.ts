import type { AgentEvent, SessionPage } from "@/types/events";
import { sessionMedia, type SessionMedia } from "@/lib/transcript";

/// One session's log as far as the transcript holds it.
export type HeldLog = { sessionId: string; events: AgentEvent[]; olderBefore: number | null };

/// What Load more has read above a log's held tail: the media alone, never the
/// events, so paging a long log back costs the pictures and not the turns.
/// `before` is where the next page ends, `null` once the log's start is read.
export type OlderMedia = { before: number | null; media: SessionMedia[] };

export const mediaKey = (m: SessionMedia) => ("video" in m ? m.video : (m.image.path ?? m.image.url ?? ""));

/// Where the next page above `log` ends, or `null` where nothing is left.
/// The lower of Load more's cursor and the transcript's own, since the chat
/// may have paged further back on its own meanwhile.
export function olderCursor(log: HeldLog, older: OlderMedia | undefined): number | null {
  if (log.olderBefore == null) return null;
  if (!older) return log.olderBefore;
  return older.before == null ? null : Math.min(older.before, log.olderBefore);
}

/// Every picture and recording in `logs` (newest log first), newest first:
/// each log's held events, then what Load more read above them.
export function allMedia(logs: HeldLog[], older: Record<string, OlderMedia>): SessionMedia[] {
  const seen = new Set<string>();
  return logs
    .flatMap((log) => [...sessionMedia(log.events), ...(older[log.sessionId]?.media ?? [])])
    .filter((m) => {
      const key = mediaKey(m);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/// Reads pages above the held logs, newest log first, until `want` media not
/// already shown turn up or every log is read to its start. A page is usually
/// enough on its own; the loop covers a page short of `want` — the log's top,
/// pictures the transcript already holds — and an older server's whole turns.
export async function loadOlderMedia(
  logs: HeldLog[],
  older: Record<string, OlderMedia>,
  page: (sessionId: string, before: number) => Promise<SessionPage>,
  want: number,
): Promise<Record<string, OlderMedia>> {
  const next = { ...older };
  const seen = new Set(allMedia(logs, older).map(mediaKey));
  let found = 0;
  for (const log of logs) {
    let before = olderCursor(log, next[log.sessionId]);
    while (before != null && found < want) {
      const read = await page(log.sessionId, before);
      const fresh = sessionMedia(read.events).filter((m) => !seen.has(mediaKey(m)));
      for (const m of fresh) seen.add(mediaKey(m));
      found += fresh.length;
      before = read.olderBefore;
      next[log.sessionId] = { before, media: [...(next[log.sessionId]?.media ?? []), ...fresh] };
    }
    if (found >= want) break;
  }
  return next;
}
