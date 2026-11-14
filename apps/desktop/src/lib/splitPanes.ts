import { useSyncExternalStore } from "react";

import type { TabKey } from "@/lib/tabOrder";

/// Tabs dragged out of a session's row into panes right of its main view,
/// left to right, keyed by the row's session. A split tab keeps its place in
/// the row's order but is not drawn there, so closing the pane puts it back
/// where it was. In memory, like the row's order.
const panes = new Map<string, TabKey[]>();
/// What a pane's header draws, published by the row that knows it.
export type PaneHead = { icon: React.ReactNode; label: string };
const heads = new Map<string, Map<TabKey, PaneHead>>();
/// A tab held over the main view: the drop that would split it out.
export type SplitDrag = { sessionId: string; key: TabKey; label: string | null };
let drag: SplitDrag | null = null;

/// The narrowest a pane gets, the main view included. A drop that would
/// leave any narrower is refused, which is the only cap on how many there are.
export const PANE_MIN = 320;

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const NONE: TabKey[] = [];

export function splitPanesOf(sessionId: string): TabKey[] {
  return panes.get(sessionId) ?? NONE;
}

export function useSplitPanes(sessionId: string | null): TabKey[] {
  return useSyncExternalStore(subscribe, () => (sessionId ? splitPanesOf(sessionId) : NONE));
}

/// Whether `key` is out of the row: a pick's own files go with the pick.
export function isSplit(sessionId: string, key: TabKey): boolean {
  return splitPanesOf(sessionId).some((p) => p === key || (p.startsWith("pick:") && key.startsWith(`pickfile:${p.slice(5)}:`)));
}

export function addSplit(sessionId: string, key: TabKey) {
  const now = splitPanesOf(sessionId);
  if (now.includes(key)) return;
  panes.set(sessionId, [...now, key]);
  notify();
}

export function removeSplit(sessionId: string, key: TabKey) {
  const now = splitPanesOf(sessionId);
  if (!now.includes(key)) return;
  panes.set(sessionId, now.filter((p) => p !== key));
  notify();
}

/// Drops every pane `keep` refuses: a page closed, a task gone.
export function pruneSplits(sessionId: string, keep: (key: TabKey) => boolean) {
  const now = splitPanesOf(sessionId);
  const next = now.filter(keep);
  if (next.length === now.length) return;
  panes.set(sessionId, next);
  notify();
}

/// Called from the row on every render, so it moves only where a label did:
/// the row reads this store too, and an icon is a new element each time,
/// which would loop.
export function setPaneHeads(sessionId: string, next: Map<TabKey, PaneHead>) {
  const held = heads.get(sessionId);
  const same =
    held?.size === next.size && [...next].every(([key, head]) => held.get(key)?.label === head.label);
  if (same) return;
  heads.set(sessionId, next);
  notify();
}

export function usePaneHead(sessionId: string, key: TabKey): PaneHead | null {
  return useSyncExternalStore(subscribe, () => heads.get(sessionId)?.get(key) ?? null);
}

export function setSplitDrag(next: SplitDrag | null) {
  if (next?.sessionId === drag?.sessionId && next?.key === drag?.key && next?.label === drag?.label) return;
  drag = next;
  notify();
}

export function useSplitDrag(): SplitDrag | null {
  return useSyncExternalStore(subscribe, () => drag);
}

/// The element the main view and its panes share, measured for room.
export const SPLIT_HOST = "data-split-host";

/// Whether a point over the main view would split a tab out, and so whether
/// the window has room for one more pane at `PANE_MIN`.
export function splitTarget(x: number, y: number, count: number): "room" | "full" | null {
  const host = document.querySelector(`[${SPLIT_HOST}]`)?.getBoundingClientRect();
  if (!host || x < host.left || x > host.right || y < host.top || y > host.bottom) return null;
  return host.width / (count + 2) >= PANE_MIN ? "room" : "full";
}
