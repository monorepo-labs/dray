// Set aside, or brought back, on a session whose server is down (#1050). This
// Mac's server holds the flag (`held_flags.rs`) and writes it to the session's
// server once that answers; until then the sidebar draws the held value over
// the row the server last sent, so the row sinks at once and does not bounce
// back up when a reconnect re-reads the stale one.

import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { invoke, listen, LOCAL, qualifyRecord, serverOfSession, type ServerId } from "@/lib/transport";
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

/// Bumped by every event, so a read outlived by one is dropped rather than
/// putting back a list the event already replaced.
let generation = 0;

/// Reads the list whole. Retried a few times, since This Mac's server can be
/// mid-restart; one from before #1050 refuses every time and holds nothing.
function read(tries = 3) {
  const asked = generation;
  invoke<HeldFlag[]>("held_session_flags", {}, LOCAL)
    .then((list) => {
      if (asked !== generation) return;
      held = list;
      changed.emit();
    })
    .catch(() => {
      if (tries > 1) setTimeout(() => read(tries - 1), 2000);
    });
}

function start() {
  if (started) return;
  started = true;
  const events = listen<Changed>("held_flags_changed", ({ payload, server }) => {
    if (server !== LOCAL) return;
    generation++;
    held = payload.held;
    changed.emit();
    for (const { server: from, item } of payload.landed) {
      landedRows.emit(qualifyRecord(item, from) as SessionIndexItem);
    }
  });
  // This Mac's server restarting drops whatever it announced meanwhile, and
  // a stale hold would sit over a row its server has long since written.
  const reconnects = listen("live_state", ({ server }) => {
    if (server === LOCAL) read();
  });
  void Promise.all([events, reconnects]).then(() => read());
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

export const heldFlagFor = (sessionId: string): HeldFlag | undefined =>
  held.find((h) => h.sessionId === sessionId);

/// Holds `aside` (and `pinned`) for a session on `server`, which is down.
export async function holdFlags(
  server: ServerId,
  sessionId: string,
  flags: { aside: boolean; pinned?: boolean },
): Promise<void> {
  await invoke("hold_session_flags", { machine: server, sessionId, aside: flags.aside, pinned: flags.pinned ?? null }, LOCAL);
}

/// Drops a held flag before a newer write goes to its server. Answers once
/// any flush writing it has finished, so that write lands after it.
export async function unholdFlags(sessionId: string): Promise<void> {
  if (!heldFlagFor(sessionId)) return;
  await invoke("unhold_session_flags", { sessionId }, LOCAL);
}

/// Each session's flags written last from here, so a send's undo below never
/// lands over a choice the reader made while it was out.
const lastWrite = new Map<string, number>();

export const noteFlagWrite = (sessionId: string) => void lastWrite.set(sessionId, Date.now());

type Released = "held" | "landed" | "newer" | "gone";

/// A message reached a session that had a flag held when it went out: the
/// message brought it back, so the hold goes. A Set aside that a flush wrote
/// meanwhile may have landed after the message, so it is undone there —
/// unless the reader has set flags on the session since.
export async function settleAfterSend(was: HeldFlag, sentAt: number): Promise<void> {
  const released = await invoke<Released>("release_held_flag", { sessionId: was.sessionId, at: was.at }, LOCAL);
  if (released !== "landed" || !was.aside || (lastWrite.get(was.sessionId) ?? 0) > sentAt) return;
  await invoke("set_session_flags", { sessionId: was.sessionId, aside: false }, serverOfSession(was.sessionId));
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
