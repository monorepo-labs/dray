import { useEffect, useMemo, useRef, useState } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import type { CrewRow } from "@/lib/crew";
import { isWindowFocused } from "@/lib/focus";
import { notifyOS } from "@/lib/notify";
import { botCrews, freshStalls, needLine, onCard, stalledTasks, type Stall } from "@/lib/stalled";
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
/// Stalls the reader has no part in go to the bot instead, once each, as a
/// hidden message from the task (`nudge_bot`): a PR the task can mend, or a
/// task idle on the reader, which the bot either answers itself or names in a
/// need line (`dray session need`) that puts it on the card.
///
/// Read for every bot rather than the one on screen, since the banner is for a
/// bot the reader is not looking at: once new card rows land while the window
/// is in the background, one banner per bot says how many. Each bot's first
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
  const byBot = useMemo(() => {
    const out = new Map<string, { chatId: string; stalls: Stall[]; card: Stall[] }>();
    for (const { bot, chatId, rows } of botCrews(bots, items, { statusBySession, askingSessions, tasksBySession })) {
      const stalls = stalledTasks(rows, prOf, readySince.current, now, prReadAt);
      out.set(bot.id, { chatId, stalls, card: stalls.filter(onCard) });
    }
    return out;
  }, [bots, items, statusBySession, askingSessions, tasksBySession, prOf, prReadAt, now]);

  const mountedAt = useRef(Date.now());
  // Sent and not yet answered. A key is stored only once its nudge landed, so
  // a dropped connection or a bot that failed to start is tried again on the
  // next minute's tick rather than never.
  const sending = useRef(new Set<string>());
  useEffect(() => {
    if (now - mountedAt.current < NUDGE_HOLD_MS) return;
    const nudged = new Set(readLocalStorage<string[]>(NUDGED_KEY, []));
    const due = [...byBot.values()]
      .flatMap((b) => b.stalls)
      .filter((s) => s.kind !== "ready" && !needLine(s) && !nudged.has(s.key) && !sending.current.has(s.key));
    for (const s of due) {
      sending.current.add(s.key);
      invoke("nudge_bot", { sessionId: s.row.item.sessionId, problem: s.problem ?? null })
        .then(() => {
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
      const fresh = freshStalls(seen.current, entry.card);
      const first = !seeded.current.has(bot.id);
      seeded.current.add(bot.id);
      if (first || fresh.length === 0 || isWindowFocused()) continue;
      const n = entry.card.length;
      notifyOS(entry.chatId, "asking", bot.name, `${n} ${n === 1 ? "task" : "tasks"} waiting on you`);
    }
  }, [bots, byBot]);

  return { byBot, now };
}
