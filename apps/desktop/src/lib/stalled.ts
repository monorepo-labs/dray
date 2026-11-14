import { botChat } from "@/lib/bots";
import { crewRows, type CrewRow } from "@/lib/crew";
import { prStatus, type PrStatusKey } from "@/lib/pr";
import type { BackgroundTask, Bot, PrMark, SessionIndexItem, SessionStatus } from "@/types/events";

/// How long a bot's task sits untouched before the reader hears of it. What
/// the task can mend itself waits for none of it.
export const STALL_MS = 5 * 60_000;

/// A task of a bot's that has stalled. `ready`: its pull request has been
/// able to land for [STALL_MS], and the reader merges it from the card. `fix`:
/// something the task can mend on its own is in the way, said in `problem`, and
/// the bot is told at once rather than the reader. `waiting`: the task has sat
/// idle on the reader for [STALL_MS];
/// the bot reads it and either answers it or writes the line the card draws.
/// `key` names this one stall, so it is acted on once and comes back only
/// after the task moves.
export type Stall = {
  row: CrewRow;
  pr?: PrMark;
  kind: "ready" | "fix" | "waiting";
  problem?: string;
  /// The PR status a `fix` stall is about.
  status?: PrStatusKey;
  since: number;
  key: string;
};

/// What a task can mend itself, by PR status: `problem` as its bot is told
/// it, `fixing` as the Tasks row says it while the task is on it.
const FIXABLE: Partial<Record<PrStatusKey, { problem: (n: number) => string; fixing: string }>> = {
  conflict: { problem: (n) => `PR #${n} has merge conflicts.`, fixing: "Fixing merge conflicts" },
  checksFailing: { problem: (n) => `PR #${n} has failing checks.`, fixing: "Fixing failing checks" },
  behind: { problem: (n) => `PR #${n} is behind its base branch.`, fixing: "Updating from base" },
  changesRequested: { problem: (n) => `A review on PR #${n} asked for changes.`, fixing: "Addressing review" },
};

/// A task asked to mend its PR: which PR, the status it was asked about, and
/// when, in ms.
export type FixAsk = { pr: number; status: PrStatusKey; at: number };

/// Whether `pr` has moved off what `ask` was about, so the ask is done with.
/// `unknown` holds: it is GitHub's recompute after a push, not an answer.
export function fixAskDone(ask: FixAsk, pr: PrMark): boolean {
  const key = prStatus(pr).key;
  return pr.number !== ask.pr || (key !== ask.status && key !== "unknown");
}

/// A Tasks row's line while its task mends its PR: "Fixing merge conflicts ·
/// 3m", timed from the ask. Nothing once the PR has moved on.
export function fixLine(ask: FixAsk | undefined, pr: PrMark | undefined, now: number): string | undefined {
  const fixing = ask && pr && !fixAskDone(ask, pr) && FIXABLE[ask.status]?.fixing;
  return fixing ? `${fixing} · ${compactAge(new Date(ask.at).toISOString(), now)}` : undefined;
}

/// The bot's tasks that have stalled, oldest stall first.
///
/// `readySince` is kept by the caller across calls and updated here: when each
/// task's pull request was seen turning ready, `0` where it was ready the first
/// time it was seen, `-1` while it is not. A PR found already ready counts from
/// the task's last activity — waiting another [STALL_MS] of watching would hide
/// one that has sat for a day.
///
/// `markFresh` says whether a task's PR mark was asked for after the task last
/// moved. A fix is called at once only on a fresh mark, and otherwise after
/// [STALL_MS]: a mark read before the task's push would nudge the bot about
/// checks the task had just fixed.
///
/// Left out: a task mid-turn or with a background shell or subagent still
/// running, one behind a card (the card is in the chat already), one set aside
/// or waiting on its usage limit, one whose PR is running checks or still being
/// worked out by GitHub — those wait on CI, not on anyone — and one whose PR
/// has merged, which is done.
export function stalledTasks(
  rows: readonly CrewRow[],
  prOf: (row: CrewRow) => PrMark | undefined,
  readySince: Map<string, number>,
  now: number,
  markFresh: (row: CrewRow) => boolean,
): Stall[] {
  const stalls: Stall[] = [];
  for (const row of rows) {
    const { item } = row;
    const id = item.sessionId;
    const pr = prOf(row);
    const status = pr && prStatus(pr).key;
    // Ready by the same word the Tasks tab says, so failing checks on a clean
    // merge state never read as mergeable.
    const ready = status && (status === "unknown" ? null : status === "ready");
    if (ready === false) readySince.set(id, -1);
    if (ready === true) {
      const was = readySince.get(id);
      if (was === undefined) readySince.set(id, 0);
      else if (was === -1) readySince.set(id, now);
    }
    if (row.busy || row.background || row.asking || item.aside || item.continueAt) continue;
    // Unknown is held, not drawn: a merge elsewhere drops every open PR there
    // to unknown for a poll, and a waiting stall in that gap would be a new one.
    if (ready === null || status === "checksRunning" || status === "merged") continue;

    const touched = Date.parse(item.modified) || now;
    if (ready === true) {
      const since = Math.max(readySince.get(id) ?? 0, touched);
      if (now - since >= STALL_MS) stalls.push({ row, pr, kind: "ready", since, key: `${id}:ready:${pr.number}:${item.modified}` });
      continue;
    }
    const idle = now - touched >= STALL_MS;
    const fix = pr && status && FIXABLE[status];
    if (fix) {
      if (idle || markFresh(row))
        stalls.push({
          row,
          pr,
          kind: "fix",
          problem: fix.problem(pr.number),
          status,
          since: touched,
          key: `${id}:${status}:${item.modified}`,
        });
    } else if (idle) stalls.push({ row, pr, kind: "waiting", since: touched, key: `${id}:waiting:${item.modified}` });
  }
  return stalls.sort((a, b) => a.since - b.since);
}

/// Whether a stall belongs in the bot's card: a PR ready to merge, or a task
/// idle on the reader. The rest are the bot's alone.
export const onCard = (stall: Stall): boolean => stall.kind !== "fix";

/// Dismissed stalls, by key. A key names one stall, so the list only grows by
/// what the reader dismisses.
export const DISMISSED_KEY = "ade.dismissedStalls";

/// The rows the bot's card draws: what is on it and not dismissed. The card
/// and its notice both count from here, or the notice names rows nobody sees.
export const cardRows = (stalls: readonly Stall[], dismissed: readonly string[]): Stall[] =>
  stalls.filter((s) => onCard(s) && !dismissed.includes(s.key));

/// What a card row needs from the reader, as its bot wrote it since the task
/// last moved: an answer for a waiting task, something to try before a ready
/// PR is merged. Nothing while the bot is still on it, and for most ready PRs
/// nothing at all.
export function needLine(stall: Stall): string | undefined {
  const { need, modified } = stall.row.item;
  return onCard(stall) && need && Date.parse(need.at) >= Date.parse(modified) ? need.text : undefined;
}

/// Each bot that has a chat: the chat's session id and the bot's tasks.
export function botCrews(
  bots: readonly Bot[],
  items: SessionIndexItem[],
  live: {
    statusBySession: Record<string, SessionStatus>;
    askingSessions: ReadonlySet<string>;
    tasksBySession?: Record<string, BackgroundTask[]>;
  },
): { bot: Bot; chatId: string; rows: CrewRow[] }[] {
  return bots.flatMap((bot) => {
    const chat = botChat(items, bot).map((i) => i.sessionId);
    const chatId = chat.at(-1);
    return chatId ? [{ bot, chatId, rows: crewRows(items, chatId, live, chat.slice(0, -1)) }] : [];
  });
}

/// "45m", "2h", "3d": time since `iso`, as an inbox row says it.
export function compactAge(iso: string, now: number): string {
  const min = Math.max(1, Math.floor((now - (Date.parse(iso) || now)) / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/// The stalls in `stalls` not yet in `seen`, which takes them in.
export function freshStalls(seen: Set<string>, stalls: readonly Stall[]): Stall[] {
  const fresh = stalls.filter((s) => !seen.has(s.key));
  for (const s of fresh) seen.add(s.key);
  return fresh;
}
