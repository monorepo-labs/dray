import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import type { Issue, IssueQuery } from "@/types/events";

/// How deep the picker's list goes. The backend ranks by priority, so this is
/// the depth somebody might scroll before typing another character rather than
/// an attempt to show everything that matched.
const LIMIT = 25;

/// Longer than the file picker's 60ms, and for a different reason: that one is
/// spacing out an IPC hop over an in-memory index, and this is a round trip to
/// Linear. Every keystroke that reaches the network is one the reader waits on.
const DEBOUNCE_MS = 200;

/// Issues matching `query`, best first, or an empty list while the picker is
/// closed.
///
/// `query` is `null` when the caret isn't in a tag, which is what closes the
/// picker — passed rather than the hook being called conditionally, since hooks
/// cannot be.
///
/// Shaped like [useFileSearch](./useFileSearch.ts) deliberately: the composer
/// reads both the same way, and a second shape would be a second set of
/// race-and-debounce rules to get right.
export function useIssueSearch(query: string | null): Issue[] {
  const [issues, setIssues] = useState<Issue[]>([]);
  /// Whether anything is on screen to protect. A first read has nothing to wait
  /// for, so it skips the debounce and the picker never opens blank.
  const showing = useRef(false);

  useEffect(() => {
    if (query === null) {
      setIssues([]);
      showing.current = false;
      return;
    }

    // Guards out-of-order replies as well as unmounting: two reads in flight
    // can land either way round, and the older one landing last would leave the
    // list describing a query already typed past.
    let cancelled = false;

    const run = () => {
      const filters: IssueQuery = {
        text: query || null,
        // The picker is "what am I working on", which is the assigned and
        // unfinished list. Widening lives on the issues page, where there is
        // room for a filter row to say what it is doing.
        scope: "assigned",
        teamId: null,
        projectId: null,
        settled: false,
      };

      invoke<Issue[]>("list_issues", { query: filters, limit: LIMIT })
        .then((matches) => {
          if (cancelled) return;
          setIssues(matches);
          showing.current = true;
        })
        // The list is left as it was rather than cleared: a failed refresh must
        // not empty a list somebody is reading, and there is nothing to say
        // here anyway — a picker is not where "Linear is down" belongs.
        .catch((e) => console.error("[issue search]", e));
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

  return issues;
}
