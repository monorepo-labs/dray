import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { cachedIssues, ISSUE_LIST_LIMIT, rememberIssues } from "@/hooks/useIssues";
import { filterIssues, issueGeneration } from "@/lib/issue";

import type { Issue, IssueQuery } from "@/types/events";

/// How deep the picker's list goes. The backend ranks by priority, so this is
/// the depth somebody might scroll before typing another character rather than
/// an attempt to show everything that matched.
///
/// A display depth alone — the *read* asks for `ISSUE_LIST_LIMIT`, since the
/// list cache is keyed on the query and not on how far it was read, so a
/// shallower read here would file a truncated answer under the key the issues
/// page paints from.
const LIMIT = 25;

/// Longer than the file picker's 60ms, and for a different reason: that one is
/// spacing out an IPC hop over an in-memory index, and this is a round trip to
/// Linear. Every keystroke that reaches the network is one the reader waits on.
const DEBOUNCE_MS = 200;

/// The picker's question with `text` filled in. The picker is "what am I working
/// on", which is the assigned and unfinished list — widening lives on the issues
/// page, where there is room for a filter row to say what it is doing.
///
/// Which also makes the empty-text shape the issues page's own default query, so
/// the two share cache entries rather than each paying for the same read.
const queryFor = (text: string): IssueQuery => ({
  text: text || null,
  scope: "assigned",
  teamId: null,
  projectId: null,
  settled: false,
});

/// Issues matching `query`, best first, and whether a read is in flight — or an
/// empty list while the picker is closed.
///
/// `query` is `null` when the caret isn't in a tag, which is what closes the
/// picker — passed rather than the hook being called conditionally, since hooks
/// cannot be.
///
/// Shaped like [useFileSearch](./useFileSearch.ts) deliberately: the composer
/// reads both the same way, and a second shape would be a second set of
/// race-and-debounce rules to get right. The one thing it does not share is the
/// cache: that one is an in-memory index and free to ask, where every read here
/// is a round trip to Linear — so this paints from
/// [useIssues](./useIssues.ts)'s cache first and lets the network correct it.
///
/// `loading` is what the file picker has no use for and this one does: a cold
/// `#` has nothing cached to paint and no index to ask, so the menu draws
/// placeholder rows rather than staying shut until Linear answers.
export function useIssueSearch(query: string | null): { issues: Issue[]; loading: boolean } {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  /// Whether anything is on screen to protect. A first read has nothing to wait
  /// for, so it skips the debounce and the picker never opens blank.
  const showing = useRef(false);

  useEffect(() => {
    if (query === null) {
      setIssues([]);
      setLoading(false);
      showing.current = false;
      return;
    }

    // Guards out-of-order replies as well as unmounting: two reads in flight
    // can land either way round, and the older one landing last would leave the
    // list describing a query already typed past.
    let cancelled = false;

    // Captured before anything is read, not when an answer lands — the same
    // guard `useIssueList` makes, and for the same reason: a connection
    // changing under this read must refuse its write rather than re-stamp it.
    const reading = issueGeneration();

    // What can be answered without the network, best first: this exact query if
    // it has been asked before, else the whole assigned list narrowed here.
    // Either is on screen for the frame the keystroke lands in, which is the
    // whole point — the read below then replaces it, since Linear matches
    // descriptions and this cannot.
    const exact = cachedIssues(queryFor(query));
    const base = query ? cachedIssues(queryFor("")) : undefined;
    const painted = exact?.issues ?? (base && filterIssues(base.issues, query));
    if (painted) {
      setIssues(painted.slice(0, LIMIT));
      showing.current = true;
    }

    // A fresh answer to this exact question is the whole answer, so nothing is
    // read: that is what makes a second `#` open from memory. The issues page's
    // own 60s window decides it, since the two are filling one cache.
    //
    // Clearing `loading` here is not belt and braces — it is the only path that
    // clears it with no request having finished, and a read cancelled by the
    // next keystroke never reaches its own `finally`. Without it, backspacing
    // onto a cached query leaves placeholder rows under a list already right.
    if (exact?.fresh) {
      setLoading(false);
      return;
    }

    setLoading(true);

    const run = () => {
      invoke<Issue[]>("list_issues", { query: queryFor(query), limit: ISSUE_LIST_LIMIT })
        .then((matches) => {
          // Filed whether or not this read still has a picker to draw into: the
          // answer is as true for the next `#` as for this one, and the reader
          // typing past it is the ordinary way a read gets cancelled.
          rememberIssues(queryFor(query), matches, reading);
          if (cancelled) return;
          setIssues(matches.slice(0, LIMIT));
          showing.current = true;
        })
        // The list is left as it was rather than cleared: a failed refresh must
        // not empty a list somebody is reading, and there is nothing to say
        // here anyway — a picker is not where "Linear is down" belongs.
        .catch((e) => console.error("[issue search]", e))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    if (!showing.current) {
      run();
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(run, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return { issues, loading };
}
