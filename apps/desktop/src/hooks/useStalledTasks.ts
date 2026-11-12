import { useEffect, useMemo, useRef, useState } from "react";

import { botChat } from "@/lib/bots";
import { crewRows, type CrewRow } from "@/lib/crew";
import { isWindowFocused } from "@/lib/focus";
import { notifyOS } from "@/lib/notify";
import { freshStalls, stalledTasks, type Stall } from "@/lib/stalled";
import { invoke } from "@/lib/transport";
import type { BackgroundTask, Bot, BotPreview, PrMark, SessionIndexItem, SessionStatus } from "@/types/events";

/// Every bot's stalled tasks (see `stalledTasks`), keyed by bot id, with each
/// stalled task's last message for its inbox row and the clock they were read at.
///
/// Read for every bot rather than the one on screen, since the banner is for a
/// bot the reader is not looking at: once new stalls land while the window is
/// in the background, one banner per bot says how many tasks wait on the
/// reader, and a click opens its chat. Each bot's first read, once its chat is
/// found, is taken in silence, or every stall already standing would raise one.
/// PR marks are only
/// polled for the open bot's repos, so another bot's ready PR shows as idle
/// until its chat is opened; `stalledTasks` explains why that is safe.
export function useStalledTasks({
  bots,
  items,
  statusBySession,
  askingSessions,
  tasksBySession,
  prOf,
}: {
  bots: readonly Bot[];
  items: SessionIndexItem[];
  statusBySession: Record<string, SessionStatus>;
  askingSessions: ReadonlySet<string>;
  tasksBySession: Record<string, BackgroundTask[]>;
  prOf: (row: CrewRow) => PrMark | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (bots.length === 0) return;
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, [bots.length]);

  const readySince = useRef(new Map<string, number>());
  const byBot = useMemo(() => {
    const live = { statusBySession, askingSessions, tasksBySession };
    const out = new Map<string, { chatId: string; stalls: Stall[] }>();
    for (const bot of bots) {
      const chat = botChat(items, bot).map((i) => i.sessionId);
      const chatId = chat.at(-1);
      if (!chatId) continue;
      const rows = crewRows(items, chatId, live, chat.slice(0, -1));
      out.set(bot.id, { chatId, stalls: stalledTasks(rows, prOf, readySince.current, now) });
    }
    return out;
  }, [bots, items, statusBySession, askingSessions, tasksBySession, prOf, now]);

  const seen = useRef(new Set<string>());
  // Seeded per bot, the first time its chat is found: the bot list and the
  // index load after mount, so a single first pass would see nothing yet.
  const seeded = useRef(new Set<string>());
  useEffect(() => {
    for (const bot of bots) {
      const entry = byBot.get(bot.id);
      if (!entry) continue;
      const fresh = freshStalls(seen.current, entry.stalls);
      const first = !seeded.current.has(bot.id);
      seeded.current.add(bot.id);
      if (first || fresh.length === 0 || isWindowFocused()) continue;
      const n = entry.stalls.length;
      notifyOS(entry.chatId, "asking", bot.name, `${n} ${n === 1 ? "task" : "tasks"} waiting on you`);
    }
  }, [bots, byBot]);

  // Read off the end of each task's log, like a bot row's preview; again only
  // when the set of stalled tasks or their last activity moves.
  const [previews, setPreviews] = useState<Record<string, BotPreview>>({});
  const stalled = [...byBot.values()].flatMap((b) => b.stalls.map((s) => s.row.item));
  const previewKey = stalled.map((i) => `${i.sessionId}:${i.modified}`).join("|");
  useEffect(() => {
    if (stalled.length === 0) return;
    // A read overtaken by a newer one must not land over it.
    let stale = false;
    invoke<Record<string, BotPreview>>("bot_previews", { sessionIds: stalled.map((i) => i.sessionId) })
      .then((p) => stale || setPreviews(p))
      .catch(() => {});
    return () => {
      stale = true;
    };
    // The key carries everything that moves a preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  // What each waiting task needs from the reader, written from its last message
  // by the cheap title model (`task_need`). Asked once per message: a failure
  // leaves the row on the message itself until the task says something new.
  const [needByMessage, setNeedByMessage] = useState<Record<string, string>>({});
  const waiting = [...byBot.values()].flatMap((b) => b.stalls.filter((s) => s.kind === "waiting"));
  const needs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of waiting) {
      const id = s.row.item.sessionId;
      const need = needByMessage[needKey(id, previews[id]?.text)];
      if (need) out[id] = need;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byBot, previews, needByMessage]);
  useEffect(() => {
    for (const s of waiting) {
      const id = s.row.item.sessionId;
      const text = previews[id]?.text;
      const key = needKey(id, text);
      if (!text || ASKED.has(key)) continue;
      ASKED.add(key);
      invoke<string>("task_need", { sessionId: id, text })
        .then((need) => setNeedByMessage((n) => ({ ...n, [key]: need })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byBot, previews]);

  return { byBot, previews, needs, now };
}

/// Messages already sent to `task_need`, so a re-render asks nothing twice.
const ASKED = new Set<string>();

const needKey = (sessionId: string, text: string | null | undefined) => `${sessionId}\n${text ?? ""}`;
