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
/// Left out: a task mid-turn, one behind a card (the card is in the chat
/// already), one set aside or waiting on its usage limit, and one whose PR is
/// still running checks — that waits on CI, not on the reader.
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
    if (row.busy || row.asking || item.aside || item.continueAt) continue;
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

/// "31 min", "2 h": how long a stall has stood, said briefly.
export function stalledFor(since: number, now: number): string {
  const min = Math.max(1, Math.floor((now - since) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`;
}
