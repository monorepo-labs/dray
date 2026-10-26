/// One entry in the titlebar's row: `chat`, `changes`, the `files` stand-in
/// drawn while no file is open, `blank:<n>` for a new browser tab awaiting its
/// URL, `page:<id>` and `file:<path>`.
export type TabKey = string;

/// What a key stands for, so an entry arriving can take the slot of one of
/// its own kind that just left.
function kindOf(key: TabKey): string {
  if (key.startsWith("blank:") || key.startsWith("page:")) return "browser";
  if (key === "files" || key.startsWith("file:")) return "files";
  return key;
}

/// The row the reader arranged, brought up to date with what is open.
///
/// Gone entries drop out and new ones are appended — except that a new entry
/// takes the place of one of its own kind that left in the same change. That
/// one rule is what keeps the row still under the ordinary transitions: a new
/// tab's real page lands where the new tab was, and closing the last file puts
/// Files back where the file had been.
export function reconcile(prev: readonly TabKey[], present: readonly TabKey[]): TabKey[] {
  const live = new Set(present);
  const known = new Set(prev);
  const arriving = present.filter((key) => !known.has(key));
  const next: TabKey[] = [];
  for (const key of prev) {
    if (live.has(key)) {
      next.push(key);
      continue;
    }
    const heir = arriving.findIndex((k) => kindOf(k) === kindOf(key));
    if (heir !== -1) next.push(...arriving.splice(heir, 1));
  }
  return [...next, ...arriving];
}

/// Moves `key` to index `to`, the drag hook's answer.
export function moveKey(order: readonly TabKey[], key: TabKey, to: number): TabKey[] {
  const next = order.filter((k) => k !== key);
  next.splice(to, 0, key);
  return next;
}

/// A tab the reader closed. A page keeps its address, title and icon, since
/// its id went with it; `at` is the slot it sat in, where the title row knows it.
export type ClosedTab = {
  key: TabKey;
  page?: { url: string; title: string; favicon: string };
  at?: number;
};

/// What ⌘⇧T brings back, per session, newest last. Filled by the reader's own
/// closes — every store's close function pushes here — never by the agent's,
/// which arrive from Rust and are not the reader's to undo.
// ponytail: in memory and capped, a browser's own bargain; a restart forgets.
const closed = new Map<string, ClosedTab[]>();
const CLOSED_CAP = 25;

export function pushClosedTab(sessionId: string, tab: ClosedTab) {
  closed.set(sessionId, [...(closed.get(sessionId) ?? []), tab].slice(-CLOSED_CAP));
}

/// Records the row slot a close just left, on the entry that close pushed.
export function markClosedSlot(sessionId: string, key: TabKey, at: number) {
  const top = closed.get(sessionId)?.at(-1);
  if (top?.key === key) top.at = at;
}

export function popClosedTab(sessionId: string): ClosedTab | undefined {
  return closed.get(sessionId)?.pop();
}

/// Drops a deleted session's closed tabs.
export function forgetClosedTabs(sessionId: string) {
  closed.delete(sessionId);
}
