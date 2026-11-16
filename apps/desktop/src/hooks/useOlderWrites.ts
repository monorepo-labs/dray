import { useEffect, useState } from "react";

import { writingTurns, type WritingRange } from "@/lib/changes";
import { invoke } from "@/lib/transport";
import type { SessionPage } from "@/types/events";

/// Pages read looking for a turn that wrote before giving up: 256 turns back.
const MAX_PAGES = 16;
const PAGE_TURNS = 16;
/// A failed read is tried again after 1s, 2s and 4s: the panel asks only when
/// its key moves, so a read lost to a dropped connection would otherwise stay
/// lost for as long as the session sits still.
const RETRIES = 3;
/// Answers kept, one per session and read-back point.
const CACHE_MAX = 64;

const NONE: WritingRange[] = [];
const found = new Map<string, WritingRange[]>();

/// The newest `need` turns that changed something above a transcript's held
/// events, starting at `before`, for the changes panel. A transcript opens on
/// its tail and reads back only as the reader scrolls, but the panel shows the
/// last turn that wrote however far back it was. The pages are read here and
/// let go: only the ranges are kept, so the chat's window holds what it held.
///
/// Keyed on `before`, which moves only when a page lands or is let go, so a
/// session streaming turns asks once. Reads only while `enabled`, and stops
/// between pages once it is not. Empty while reading.
export function useOlderWrites(
  sessionId: string | null,
  before: number | null | undefined,
  need: number,
  enabled: boolean,
): WritingRange[] {
  const key = sessionId && before != null && need > 0 ? `${sessionId}:${before}:${need}` : null;
  const [attempt, setAttempt] = useState({ key, n: 0 });
  const n = attempt.key === key ? attempt.n : 0;

  useEffect(() => {
    if (!enabled || !key || !sessionId || before == null || found.has(key)) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const ranges: WritingRange[] = [];
      let at: number | null = before;
      for (let page = 0; page < MAX_PAGES && at != null && ranges.length < need; page++) {
        const read: SessionPage = await invoke<SessionPage>("get_session_page", { sessionId, before: at, turns: PAGE_TURNS });
        if (!live) return;
        ranges.push(...writingTurns(read.events, need - ranges.length, false).ranges);
        at = read.olderBefore;
      }
      if (found.size >= CACHE_MAX) found.delete(found.keys().next().value!);
      found.set(key, ranges);
      setAttempt({ key, n: n + 1 });
    })().catch((e) => {
      console.error("failed to read back for the changes panel", e);
      if (live && n < RETRIES) retry = setTimeout(() => setAttempt({ key, n: n + 1 }), 1000 * 2 ** n);
    });
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [key, enabled, n]);

  return key ? (found.get(key) ?? NONE) : NONE;
}
