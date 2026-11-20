import { useCallback, useEffect, useState } from "react";

import { useWindowFocused } from "@/lib/focus";
import { asUnavailable } from "@/lib/pr";
import { invoke, LOCAL } from "@/lib/transport";
import type { PrSearch, PrUnavailable } from "@/types/events";

/// How often the page re-reads the search while it is up and the window has
/// focus. A read is 1 point whatever it covers, so this is 60 an hour.
const POLL_MS = 60_000;

/// Answers kept per owner across mounts, so reopening the page or flipping back
/// to an owner draws at once and reads again only past the poll interval.
const cache = new Map<string, { answer: PrSearch; at: number }>();

/// Whether `who` is one of the reader's orgs, as any answer so far named
/// them, so a pick searches `org:` for an org and `user:` for a person.
const orgOf = (who: string | null) =>
  !!who && [...cache.values()].some(({ answer }) => answer.orgs.some((o) => o.toLowerCase() === who.toLowerCase()));

/// The pull requests page's list across GitHub: one `pr_search` per read,
/// through This Mac's `gh`, narrowed to `owner` when one is picked. Reads only
/// while `active`, and polls only while the window has focus.
export function usePrSearch(active: boolean, owner: string | null) {
  const key = owner ?? "";
  const [answer, setAnswer] = useState<PrSearch | null>(() => cache.get(key)?.answer ?? null);
  const [error, setError] = useState<PrUnavailable | null>(null);
  const [loading, setLoading] = useState(false);
  const focused = useWindowFocused();

  const read = useCallback(
    async (force: boolean) => {
      const kept = cache.get(key);
      if (kept) setAnswer(kept.answer);
      if (!force && kept && Date.now() - kept.at < POLL_MS) return;
      setLoading(true);
      try {
        const found = await invoke<PrSearch>("pr_search", { owner, org: orgOf(owner) }, LOCAL);
        cache.set(key, { answer: found, at: Date.now() });
        setAnswer(found);
        setError(null);
      } catch (e) {
        setError(asUnavailable(e));
      } finally {
        setLoading(false);
      }
    },
    [key, owner],
  );

  useEffect(() => {
    if (!active) return;
    setAnswer(cache.get(key)?.answer ?? null);
    void read(false);
    if (!focused) return;
    const t = setInterval(() => void read(true), POLL_MS);
    return () => clearInterval(t);
  }, [active, focused, key, read]);

  return { answer, error, loading, refresh: useCallback(() => read(true), [read]) };
}
