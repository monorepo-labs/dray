// Set aside, or brought back, on a session whose server is down (#1050). This
// Mac's server holds the flag (`held_flags.rs`) and writes it to the session's
// server once that answers; until then the sidebar draws the held value over
// the row the server last sent, so the row sinks at once and does not bounce
// back up when a reconnect re-reads the stale one.

import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { invoke, listen, LOCAL, qualifyRecord, type ServerId } from "@/lib/transport";
import type { SessionIndexItem } from "@/types/events";

/// One flag waiting on its server, as `held_flags.rs` spells it.
export type HeldFlag = {
  machine: ServerId;
  sessionId: string;
  aside: boolean;
  pinned?: boolean;
  at: string;
};

type Changed = { held: HeldFlag[]; landed: { server: ServerId; item: SessionIndexItem }[] };

let held: HeldFlag[] = [];
let started = false;
const changed = channel<void>();
const landedRows = channel<SessionIndexItem>();

function start() {
  if (started) return;
  started = true;
  let heard = false;
  void listen<Changed>("held_flags_changed", ({ payload, server }) => {
    if (server !== LOCAL) return;
    heard = true;
    held = payload.held;
    changed.emit();
    for (const { server: from, item } of payload.landed) {
      landedRows.emit(qualifyRecord(item, from) as SessionIndexItem);
    }
  }).then(() =>
    invoke<HeldFlag[]>("held_session_flags", {}, LOCAL)
      .then((list) => {
        if (heard) return;
        held = list;
        changed.emit();
      })
      // A server from before #1050 holds nothing.
      .catch(() => {}),
  );
}

function subscribe(listener: () => void): () => void {
  start();
  return changed.subscribe(listener);
}

const snapshot = (): HeldFlag[] => held;

export function useHeldFlags(): HeldFlag[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/// Rows a flush just wrote, as their own servers answered them.
export function onLanded(listener: (item: SessionIndexItem) => void): () => void {
  start();
  return landedRows.subscribe(listener);
}

export const heldFor = (sessionId: string): HeldFlag | undefined =>
  held.find((h) => h.sessionId === sessionId);

/// Holds `aside` (and `pinned`) for a session on `server`, which is down.
export async function holdFlags(
  server: ServerId,
  sessionId: string,
  flags: { aside: boolean; pinned?: boolean },
): Promise<void> {
  await invoke("hold_session_flags", { machine: server, sessionId, aside: flags.aside, pinned: flags.pinned ?? null }, LOCAL);
}

/// Drops a held flag: a message brought the session back, or its server took
/// a newer flag directly.
export function unholdFlags(sessionId: string): void {
  if (!heldFor(sessionId)) return;
  void invoke("unhold_session_flags", { sessionId }, LOCAL).catch(() => {});
}

/// `server` just connected: its held flags go now rather than on the timer.
export function flushHeld(server: ServerId): void {
  if (!held.some((h) => h.machine === server)) return;
  void invoke("flush_held_flags", { machine: server }, LOCAL).catch(() => {});
}

/// `items` with each held flag drawn over its row. Bringing one back restarts
/// the sidebar's three-day clock, which the server does with `modified`, so
/// the held time stands in for it until the flag lands.
export function overlayHeld(items: SessionIndexItem[], flags: HeldFlag[]): SessionIndexItem[] {
  if (!flags.length) return items;
  const bySession = new Map(flags.map((h) => [h.sessionId, h]));
  return items.map((item) => {
    const h = bySession.get(item.sessionId);
    if (!h) return item;
    return {
      ...item,
      aside: h.aside,
      pinned: h.pinned ?? item.pinned,
      modified: !h.aside && Date.parse(h.at) > Date.parse(item.modified) ? h.at : item.modified,
    };
  });
}
