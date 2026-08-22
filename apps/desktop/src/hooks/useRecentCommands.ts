import { useCallback } from "react";

import { useLocalStorage } from "@/hooks/useLocalStorage";

const KEY = "ade.recentCommands";
/// Enough to survive a stretch of one-off commands without the list becoming a
/// record of everything ever typed. The picker shows fewer than this.
const KEPT = 20;

/// Command names in most-recently-used order.
///
/// Recency only — no counts. A tally answers "what do I use most", which is a
/// different and worse question for a picker: it takes days to reflect a change
/// in what you're working on, and it buries the command you ran a minute ago
/// under one you leaned on last month.
///
/// Global rather than per-project, deliberately. Project-scoped commands only
/// appear in projects that define them, so a shared list can't surface one
/// where it doesn't belong — while habits like `/compact` do carry across.
export function useRecentCommands() {
  const [recent, setRecent] = useLocalStorage<string[]>(KEY, []);

  /// Records a command as used. Called on *send*, not on pick: choosing a
  /// command from the list and then deleting it is not using it.
  const record = useCallback(
    (name: string) => setRecent((prev) => [name, ...prev.filter((n) => n !== name)].slice(0, KEPT)),
    [setRecent],
  );

  return [recent, record] as const;
}
