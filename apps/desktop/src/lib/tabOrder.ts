/// One entry in the titlebar's row: `chat`, `changes`, the `browser` and
/// `files` stand-ins drawn while nothing of theirs is open, `blank:<n>` for a
/// new browser tab awaiting its URL, `page:<id>` and `file:<path>`.
export type TabKey = string;

/// What a key stands for, so an entry arriving can take the slot of one of
/// its own kind that just left.
function kindOf(key: TabKey): string {
  if (key === "browser" || key.startsWith("blank:") || key.startsWith("page:")) return "browser";
  if (key === "files" || key.startsWith("file:")) return "files";
  return key;
}

/// The row the reader arranged, brought up to date with what is open.
///
/// Gone entries drop out and new ones are appended — except that a new entry
/// takes the place of one of its own kind that left in the same change. That
/// one rule is what keeps the row still under the ordinary transitions: the
/// first page lands where the Browser stand-in was, a new tab's real page lands
/// where the new tab was, and closing the last file puts Files back where the
/// file had been.
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
