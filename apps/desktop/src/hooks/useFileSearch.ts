import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import type { FileMatch } from "@/types/events";

/// How many matches to ask for. The fuzzy matcher ranks rather than filters — a
/// three-letter query matches most of a repo — so this is the depth someone
/// might scroll to before giving up and typing another character, not an
/// attempt to show everything that matched.
const LIMIT = 25;

/// Long enough to skip the middle of a fast burst of typing, short enough that
/// the list still feels attached to the keyboard. The search itself is ~1ms; it
/// is the IPC hop and the re-render this is spacing out, not the query.
const DEBOUNCE_MS = 60;

/// Files matching `query` in `cwd`, best first, or an empty list while the
/// picker is closed.
///
/// `query` is `null` when the caret isn't in a mention, which is what closes the
/// picker — passed rather than the hook being conditionally called, since hooks
/// can't be.
export function useFileSearch(cwd: string | null, query: string | null): FileMatch[] {
  const [files, setFiles] = useState<FileMatch[]>([]);
  /// Whether anything is on screen to protect. A first read has nothing to
  /// wait for, so it skips the debounce — the same rule the changes panel
  /// makes, and it is what stops a freshly typed `@` from opening blank.
  const showing = useRef(false);

  // Indexing takes as long as walking the tree, so it starts when the composer
  // learns its directory rather than on the keystroke that opens the picker.
  // Fire-and-forget: a failure here costs a slower first search, and
  // `search_files` builds the index itself if this never landed.
  useEffect(() => {
    if (!cwd) return;
    invoke("warm_file_index", { cwd }).catch((e) => console.error("[file index]", e));
  }, [cwd]);

  useEffect(() => {
    if (!cwd || query === null) {
      setFiles([]);
      showing.current = false;
      return;
    }

    // Guards against out-of-order replies as well as unmounting: two searches
    // in flight can land in either order, and the older one landing last would
    // leave the list describing a query that has already been typed past.
    let cancelled = false;

    const run = () => {
      invoke<FileMatch[]>("search_files", { cwd, query, limit: LIMIT })
        .then((matches) => {
          if (cancelled) return;
          setFiles(matches);
          showing.current = true;
        })
        // The list is left as it was rather than cleared: a failed refresh
        // should not empty a list the user is reading, and a failed first read
        // has nothing to empty.
        .catch((e) => console.error("[file search]", e));
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
  }, [cwd, query]);

  return files;
}
