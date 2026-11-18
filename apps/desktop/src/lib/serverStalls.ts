import { useSyncExternalStore } from "react";

import type { CrewRow } from "@/lib/crew";
import type { Stall } from "@/lib/stalled";
import { prRepoSlug } from "@/lib/pr";
import { invoke, listen, qualifyRecord, serverOfPath, type ServerId } from "@/lib/transport";
import type { BotStalls, SessionIndexItem, StallRow } from "@/types/events";

/// Each server's "Waiting on you" cards, as it judged them (#1259): an array
/// from a server that judges its bots' stalls, `null` from one too old to,
/// where the app judges them itself as it always did. Absent until asked.
const cards = new Map<ServerId, BotStalls[] | null>();
let snapshot: ReadonlyMap<ServerId, BotStalls[] | null> = new Map();
const listeners = new Set<() => void>();
const asking = new Set<ServerId>();
/// Bumped by every write, so a `bot_stalls` reply overtaken by an event or a
/// `live_state` (the server's writer lets them pass each other) is dropped.
const version = new Map<ServerId, number>();

function set(server: ServerId, next: BotStalls[] | null) {
  version.set(server, (version.get(server) ?? 0) + 1);
  cards.set(server, next);
  snapshot = new Map(cards);
  listeners.forEach((l) => l());
}

/// One bot's card from `server` replacing what it held for that bot.
function setCard(server: ServerId, card: BotStalls) {
  const held = cards.get(server) ?? [];
  set(server, [...held.filter((c) => c.botId !== card.botId), card]);
}

/// Asks `server` for its cards where it has not said yet. An older server
/// answers `unknown command` and is judged here instead; one that cannot be
/// reached is asked again on its next connect, whose `live_state` says anyway.
export async function askStalls(server: ServerId): Promise<void> {
  if (cards.has(server) || asking.has(server)) return;
  asking.add(server);
  const at = version.get(server);
  const current = () => version.get(server) === at;
  try {
    const answer = await invoke<BotStalls[]>("bot_stalls", {}, server);
    if (current()) set(server, answer);
  } catch (e) {
    if (current() && String(e).includes("unknown command")) set(server, null);
  } finally {
    asking.delete(server);
  }
}

/// Keeps every server's cards current: a connect's `live_state` carries them
/// all, or says by their absence that the server does not judge stalls, and
/// `bot_stalls_changed` carries each bot's as it moves.
export function listenForStalls(): () => void {
  const connects = listen<{ stalls?: BotStalls[] }>("live_state", ({ server, payload }) =>
    set(server, payload.stalls ?? null),
  );
  const changes = listen<BotStalls>("bot_stalls_changed", ({ server, payload }) => setCard(server, payload));
  return () => {
    void connects.then((off) => off());
    void changes.then((off) => off());
  };
}

export function useServerStalls(): ReadonlyMap<ServerId, BotStalls[] | null> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/// A server's card as the rows the card draws. A task this app holds is drawn
/// from its own row, so opening and merging go where they always did; one it
/// has moved since the server judged it is left out, since the server is a
/// pass behind and the card clears the moment a task moves. A task on a
/// machine this app holds no connection to is drawn from what the bot's
/// server said, with nothing to open.
export function serverCard(card: BotStalls | undefined, rows: readonly CrewRow[], server: ServerId): Stall[] {
  const held = new Map(rows.map((r) => [r.item.sessionId, r]));
  return (card?.rows ?? []).flatMap((r): Stall[] => {
    const own = held.get(r.item.sessionId);
    if (own && (own.item.modified !== r.item.modified || own.busy || own.asking)) return [];
    const row = own ?? farRow(r, server);
    const machine = r.machine ?? "Its machine";
    const repo = own ? undefined : (r.repo ?? prRepoSlug(r.pr?.url));
    return [
      {
        row,
        pr: r.pr,
        kind: r.kind,
        checking: r.checking || undefined,
        since: r.since,
        key: r.key,
        judged: { need: r.need ?? null, repo: r.repo ?? null },
        offline: own ? undefined : r.offline ? `${machine} is offline` : `${machine} is not connected here`,
        via: repo ? { server, repo } : undefined,
      },
    ];
  });
}

/// A row for a task this app does not hold, keyed under a server id no list
/// names, so it reads as offline wherever a row's server is asked about. For
/// drawing only: its merge goes by `Stall.via`, never by this id.
function farRow(r: StallRow, server: ServerId): CrewRow {
  const where = r.machine ? `machine:${r.machine}` : server;
  const item = (r.machine ? qualifyRecord(r.item, where) : qualifyRecord(r.item, server)) as SessionIndexItem;
  return { item, busy: false, asking: false, unread: false, background: false, serving: [] };
}

/// The server a bot's card comes from.
export const stallServer = (botPath: string): ServerId => serverOfPath(botPath);
