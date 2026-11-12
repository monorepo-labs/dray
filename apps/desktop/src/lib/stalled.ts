import type { CrewRow } from "@/lib/crew";
import { readyToMerge } from "@/lib/pr";
import type { PrMark } from "@/types/events";

/// How long a bot's task sits untouched before its chat says so.
export const STALL_MS = 30 * 60_000;

/// A task of a bot's that has sat untouched for [STALL_MS]: its pull request
/// ready to merge, or the task idle and waiting on the reader. `since` is when
/// the stall began; `key` names this one stall, so a dismissed stall stays
/// dismissed until the task moves or the reader acts on it.
export type Stall = {
  row: CrewRow;
  pr?: PrMark;
  kind: "ready" | "waiting";
  since: number;
  key: string;
};

/// The bot's tasks that want the reader, oldest stall first.
///
/// `readySince` is kept by the caller across calls and updated here: when each
/// task's pull request was seen turning ready, `0` where it was ready the first
/// time it was seen, `-1` while it is not. Marks are only read while the bot's
/// chat is up, so a PR found already ready counts from the task's last
/// activity — waiting another [STALL_MS] of watching would hide one that has
/// sat for a day.
///
/// Left out: a task mid-turn or with a background shell or subagent still
/// running (the Tasks tab counts it as working), one behind a card (the card is
/// in the chat already), one set aside or waiting on its usage limit, and one
/// whose PR is still running checks — that waits on CI, not on the reader.
export function stalledTasks(
  rows: readonly CrewRow[],
  prOf: (row: CrewRow) => PrMark | undefined,
  readySince: Map<string, number>,
  now: number,
): Stall[] {
  const stalls: Stall[] = [];
  for (const row of rows) {
    const { item } = row;
    const id = item.sessionId;
    const pr = prOf(row);
    const open = pr?.state === "OPEN";
    // GitHub not having worked it out yet changes nothing either way.
    const ready = pr && (open && !pr.isDraft ? readyToMerge(pr) : false);
    if (ready === false) readySince.set(id, -1);
    if (ready === true) {
      const was = readySince.get(id);
      if (was === undefined) readySince.set(id, 0);
      else if (was === -1) readySince.set(id, now);
    }
    if (row.busy || row.background || row.asking || item.aside || item.continueAt) continue;
    // Unknown is held, not drawn: a merge elsewhere drops every open PR there
    // to unknown for a poll, and a waiting row in that gap would be a new stall.
    if (ready === null || (open && pr.checksState === "RUNNING")) continue;

    const touched = Date.parse(item.modified) || now;
    if (ready === true) {
      const since = Math.max(readySince.get(id) ?? 0, touched);
      if (now - since >= STALL_MS) stalls.push({ row, pr, kind: "ready", since, key: `${id}:ready:${pr.number}:${item.modified}` });
      continue;
    }
    if (now - touched >= STALL_MS) stalls.push({ row, pr, kind: "waiting", since: touched, key: `${id}:waiting:${item.modified}` });
  }
  return stalls.sort((a, b) => a.since - b.since);
}

/// "45m", "2h", "3d": time since `iso`, as an inbox row says it.
export function compactAge(iso: string, now: number): string {
  const min = Math.max(1, Math.floor((now - (Date.parse(iso) || now)) / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/// The stalls in `stalls` not yet in `seen`, which takes them in. Ones the
/// reader has not been told about, for the bot's one banner.
export function freshStalls(seen: Set<string>, stalls: readonly Stall[]): Stall[] {
  const fresh = stalls.filter((s) => !seen.has(s.key));
  for (const s of fresh) seen.add(s.key);
  return fresh;
}
