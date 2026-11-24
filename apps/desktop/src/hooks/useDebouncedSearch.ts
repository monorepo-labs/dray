import { useEffect, useState } from "react";

/// How long typing in a page's search box settles before the search runs.
/// Longer than the composer picker's 200ms: that one filters a menu somebody
/// is mid-word in, where a search box gets a whole phrase typed before the
/// answer is wanted.
export const SEARCH_DEBOUNCE_MS = 300;

/// `value` once it has stopped changing for [SEARCH_DEBOUNCE_MS]. Clearing
/// lands at once, so Esc puts the whole list back on the same frame.
export function useDebouncedSearch(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), value ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [value]);
  return value ? settled : "";
}
