import { useCallback, useEffect, useRef, useState } from "react";

import { useWindowFocused } from "@/lib/focus";
import { asUnavailable } from "@/lib/pr";
import { invoke, LOCAL } from "@/lib/transport";
import type { PrSearch, PrUnavailable } from "@/types/events";

/// How often the page re-reads the search while it is up and the window has
/// focus. A read is 1 point whatever it covers, so this is 60 an hour.
const POLL_MS = 60_000;

/// Which of the reader's PRs a search asks for, as `pr_search` spells it.
export type PrSearchFilter = "involves" | "author" | "review_requested";

/// Answers kept per filter and owner across mounts, so reopening the page or
/// flipping back draws at once and reads again only past the poll interval.
const cache = new Map<string, { answer: PrSearch; at: number }>();

/// Whether `who` is an organization, as any answer so far named it — a repo's
/// owner type, or one of the reader's orgs — so a pick searches `org:` for an
/// org and `user:` for a person.
const orgOf = (who: string | null) => {
  if (!who) return false;
  const same = (name: string) => name.toLowerCase() === who.toLowerCase();
  return [...cache.values()].some(
    ({ answer }) => answer.orgs.some(same) || answer.prs.some((p) => p.ownerIsOrg && same(p.repo.split("/")[0])),
  );
};

/// The pull requests page's list across GitHub: one `pr_search` per read,
/// through This Mac's `gh`, narrowed to `owner` when one is picked. Reads only
/// while `active`, and polls only while the window has focus.
export function usePrSearch(active: boolean, owner: string | null, filter: PrSearchFilter) {
  const key = `${filter}:${owner ?? ""}`;
  const [answer, setAnswer] = useState<PrSearch | null>(() => cache.get(key)?.answer ?? null);
  const [error, setError] = useState<PrUnavailable | null>(null);
  const [loading, setLoading] = useState(false);
  const focused = useWindowFocused();
  // The search on screen now: an answer for an earlier filter or owner that
  // lands late is cached under its own key and never drawn here.
  const current = useRef(key);
  current.current = key;

  const read = useCallback(
    async (force: boolean) => {
      const kept = cache.get(key);
      if (kept) setAnswer(kept.answer);
      // A fresh cached answer ends the wait too: a read still running for the
      // filter switched away from no longer clears the spinner.
      if (!force && kept && Date.now() - kept.at < POLL_MS) {
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      try {
        const found = await invoke<PrSearch>("pr_search", { owner, org: orgOf(owner), filter }, LOCAL);
        cache.set(key, { answer: found, at: Date.now() });
        if (current.current !== key) return;
        setAnswer(found);
        setError(null);
      } catch (e) {
        if (current.current === key) setError(asUnavailable(e));
      } finally {
        if (current.current === key) setLoading(false);
      }
    },
    [key, owner, filter],
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
