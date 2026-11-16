import { useEffect, useState } from "react";

import { writingTurns, type WritingRange } from "@/lib/changes";
import { invoke } from "@/lib/transport";
import type { SessionPage } from "@/types/events";

/// Pages read looking for a turn that wrote before giving up: 256 turns back.
const MAX_PAGES = 16;
const PAGE_TURNS = 16;
/// Answers kept, one per session and read-back point.
const CACHE_MAX = 64;

const NONE: WritingRange[] = [];
const found = new Map<string, WritingRange[]>();
const reading = new Set<string>();

/// The newest `need` turns that changed something above a transcript's held
/// events, starting at `before`, for the changes panel. A transcript opens on
/// its tail and reads back only as the reader scrolls, but the panel shows the
/// last turn that wrote however far back it was. The pages are read here and
/// let go: only the ranges are kept, so the chat's window holds what it held.
///
/// Keyed on `before`, which moves only when a page lands or is let go, so a
/// session streaming turns asks once. Empty while reading.
export function useOlderWrites(sessionId: string | null, before: number | null | undefined, need: number): WritingRange[] {
  const key = sessionId && before != null && need > 0 ? `${sessionId}:${before}:${need}` : null;
  const [, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !sessionId || before == null || found.has(key) || reading.has(key)) return;
    reading.add(key);
    void (async () => {
      const ranges: WritingRange[] = [];
      let at: number | null = before;
      for (let page = 0; page < MAX_PAGES && at != null && ranges.length < need; page++) {
        const read: SessionPage = await invoke<SessionPage>("get_session_page", { sessionId, before: at, turns: PAGE_TURNS });
        ranges.push(...writingTurns(read.events, need - ranges.length, false).ranges);
        at = read.olderBefore;
      }
      if (found.size >= CACHE_MAX) found.delete(found.keys().next().value!);
      found.set(key, ranges);
      setDone(key);
    })()
      .catch((e) => console.error("failed to read back for the changes panel", e))
      .finally(() => reading.delete(key));
  }, [key]);

  return key ? (found.get(key) ?? NONE) : NONE;
}
