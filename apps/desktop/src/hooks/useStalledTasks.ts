import { useEffect, useMemo, useRef, useState } from "react";

import { pruneFixAsks, recordFixAsk } from "@/hooks/useFixAsks";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import type { CrewRow } from "@/lib/crew";
import { isWindowFocused } from "@/lib/focus";
import { islandOn } from "@/lib/island";
import { notifyOS } from "@/lib/notify";
import {
  botCrews,
  cardRows,
  DISMISSED_KEY,
  freshStalls,
  needLine,
  onCard,
  stalledTasks,
  type Stall,
} from "@/lib/stalled";
import { invoke } from "@/lib/transport";
import type { BackgroundTask, Bot, PrMark, SessionIndexItem, SessionStatus } from "@/types/events";

/// Stalls already handed to their bot, by key: kept across launches, so a
/// relaunch never nudges the bot about the same stall twice.
const NUDGED_KEY = "ade.nudgedStalls";
const NUDGED_CAP = 400;

/// How long after mount nudges hold, so a task's PR marks have landed before
/// it is judged: unread, a task with a ready PR looks like one idle on the
/// reader.
const NUDGE_HOLD_MS = 60_000;

/// Every bot's stalled tasks, keyed by bot id: `card` is what the bot's chat
/// draws, and the clock they were read at.
///
/// Each stall also goes to the bot, once, as a hidden message from the task
/// (`nudge_bot`): a PR the task can mend; a task idle on the reader, which the
/// bot either answers itself or names in a need line (`dray session need`)
/// that puts it on the card; or a ready PR, which gets a need line only where
/// the task asked the reader to try something before merging.
///
/// Read for every bot rather than the one on screen, since the notice is for a
/// bot the reader is not looking at: once new card rows land while the window
/// is in the background, one notice per bot says how many rows its card draws.
/// Dray Island shows it while it runs, a banner otherwise. Each bot's first
/// read, once its chat is found, is taken in silence, or every row already
/// standing would raise one.
export function useStalledTasks({
  bots,
  items,
  statusBySession,
  askingSessions,
  tasksBySession,
  prOf,
  prReadAt,
}: {
  bots: readonly Bot[];
  items: SessionIndexItem[];
  statusBySession: Record<string, SessionStatus>;
  askingSessions: ReadonlySet<string>;
  tasksBySession: Record<string, BackgroundTask[]>;
  prOf: (row: CrewRow) => PrMark | undefined;
  prReadAt: (row: CrewRow) => number | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (bots.length === 0) return;
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, [bots.length]);

  const readySince = useRef(new Map<string, number>());
  // When this app saw each task's `modified` change, on its own clock: that
  // stamp is the server's, and a remote one's clock running behind would let a
  // mark read before the task's push pass as newer than it.
  const movedAt = useRef(new Map<string, { modified: string; at: number }>());
  const byBot = useMemo(() => {
    const markFresh = (row: CrewRow) => (prReadAt(row) ?? 0) > (movedAt.current.get(row.item.sessionId)?.at ?? Infinity);
    const out = new Map<string, { chatId: string; rows: CrewRow[]; stalls: Stall[]; card: Stall[] }>();
    for (const { bot, chatId, rows } of botCrews(bots, items, { statusBySession, askingSessions, tasksBySession })) {
      for (const { item } of rows) {
        if (movedAt.current.get(item.sessionId)?.modified !== item.modified)
          movedAt.current.set(item.sessionId, { modified: item.modified, at: Date.now() });
      }
      const stalls = stalledTasks(rows, prOf, readySince.current, now, markFresh);
      out.set(bot.id, { chatId, rows, stalls, card: stalls.filter(onCard) });
    }
    return out;
  }, [bots, items, statusBySession, askingSessions, tasksBySession, prOf, prReadAt, now]);

  // Here rather than in the Tasks tab, which is on screen for one bot at most.
  useEffect(() => {
    pruneFixAsks([...byBot.values()].flatMap((b) => b.rows.map((r) => [r.item.sessionId, prOf(r)] as const)));
  }, [byBot, prOf]);

  const mountedAt = useRef(Date.now());
  // Sent and not yet answered. A key is stored only once its nudge was taken,
  // so a dropped connection, a bot that failed to start or a nudge nobody can
  // read yet is tried again on the next minute's tick rather than never.
  const sending = useRef(new Set<string>());
  // The tick each unsent nudge was last tried on, so a retry waits for the
  // next one instead of going out on every index change.
  const triedOn = useRef(new Map<string, number>());
  useEffect(() => {
    if (now - mountedAt.current < NUDGE_HOLD_MS) return;
    const nudged = new Set(readLocalStorage<string[]>(NUDGED_KEY, []));
    const due = [...byBot.values()]
      .flatMap((b) => b.stalls)
      // A ready stall is nudged even under a need, which a waiting stall
      // wrote and `nudge_bot` clears for the bot to judge afresh.
      .filter(
        (s) =>
          (s.kind === "ready" || !needLine(s)) &&
          !nudged.has(s.key) &&
          !sending.current.has(s.key) &&
          triedOn.current.get(s.key) !== now,
      );
    for (const s of due) {
      sending.current.add(s.key);
      triedOn.current.set(s.key, now);
      invoke<boolean | null>("nudge_bot", {
        sessionId: s.row.item.sessionId,
        problem: s.problem ?? null,
        ready: s.kind === "ready" ? (s.pr?.number ?? null) : null,
      })
        .then((sent) => {
          // `false`: nobody will read it yet, so try again. `null` is a server
          // from before it said so, which may have sent it — a retry there
          // could cost the bot a turn every minute, so it stands as nudged —
          // but it may also have held no bot for a task on another machine,
          // so only `true` says a fix is under way.
          if (sent === false) return;
          triedOn.current.delete(s.key);
          if (sent === true && s.kind === "fix" && s.pr && s.status)
            recordFixAsk(s.row.item.sessionId, s.pr.number, s.status);
          const stored = readLocalStorage<string[]>(NUDGED_KEY, []);
          writeLocalStorage(NUDGED_KEY, [...stored, s.key].slice(-NUDGED_CAP));
        })
        .catch(() => {})
        .finally(() => sending.current.delete(s.key));
    }
  }, [byBot, now]);

  const seen = useRef(new Set<string>());
  // Seeded per bot, the first time its chat is found: the bot list and the
  // index load after mount, so a single first pass would see nothing yet.
  const seeded = useRef(new Set<string>());
  useEffect(() => {
    for (const bot of bots) {
      const entry = byBot.get(bot.id);
      if (!entry) continue;
      const shown = cardRows(entry.card, readLocalStorage<string[]>(DISMISSED_KEY, []));
      const fresh = freshStalls(seen.current, shown);
      const first = !seeded.current.has(bot.id);
      seeded.current.add(bot.id);
      if (first || fresh.length === 0 || isWindowFocused()) continue;
      const { chatId } = entry;
      const body = `${shown.length} ${shown.length === 1 ? "task" : "tasks"} waiting on you`;
      const banner = () => notifyOS(chatId, "asking", bot.name, body);
      // The card's rows, which the island's pill grows into under the pointer
      // (`WaitingTask` in the island).
      const rows = shown.map((s) => ({
        id: s.row.item.sessionId,
        title: s.row.item.title,
        projectPath: s.row.item.projectPath,
        modified: s.row.item.modified,
        need: needLine(s) ?? null,
        ready: s.kind === "ready",
        pr: s.pr ?? null,
      }));
      void islandOn("done", chatId).then((on) =>
        on ? invoke("island_done", { sessionId: chatId, note: body, rows }).catch(banner) : banner(),
      );
    }
  }, [bots, byBot]);

  return { byBot, now };
}
