import { useSyncExternalStore } from "react";

import type { TabKey } from "@/lib/tabOrder";

/// A session's split groups, keyed by the row's session. Each is its lead —
/// the tab whose view the main column draws — then the tabs dragged out right
/// of it, left to right. The row draws a group as one tab in the lead's slot;
/// the others keep their own slots in the row's order, so a pane closed puts
/// its tab back where it was. In memory, like the row's order.
const groups = new Map<string, TabKey[][]>();
/// The lead of the group whose tab is lit, published by the row.
const lit = new Map<string, TabKey | null>();
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

const NONE: TabKey[][] = [];
const EMPTY: TabKey[] = [];

export function splitGroupsOf(sessionId: string): TabKey[][] {
  return groups.get(sessionId) ?? NONE;
}

export function useSplitGroups(sessionId: string | null): TabKey[][] {
  return useSyncExternalStore(subscribe, () => (sessionId ? splitGroupsOf(sessionId) : NONE));
}

/// The lit group's panes, lead left out: what is drawn beside the main view.
// Per group array, which is replaced on every change: a store snapshot must
// be the same object until something moves.
const tails = new WeakMap<TabKey[], TabKey[]>();

export function splitPanesOf(sessionId: string): TabKey[] {
  const lead = lit.get(sessionId);
  const group = splitGroupsOf(sessionId).find((g) => g[0] === lead);
  if (!group) return EMPTY;
  if (!tails.has(group)) tails.set(group, group.slice(1));
  return tails.get(group)!;
}

export function useSplitPanes(sessionId: string | null): TabKey[] {
  return useSyncExternalStore(subscribe, () => (sessionId ? splitPanesOf(sessionId) : EMPTY));
}

/// Called from the row, which alone knows which tab is lit.
export function useLitLead(sessionId: string | null): TabKey | null {
  return useSyncExternalStore(subscribe, () => (sessionId ? (lit.get(sessionId) ?? null) : null));
}

export function setLitGroup(sessionId: string, lead: TabKey | null) {
  if ((lit.get(sessionId) ?? null) === lead) return;
  lit.set(sessionId, lead);
  notify();
}

const covers = (member: TabKey, key: TabKey) =>
  member === key || (member.startsWith("pick:") && key.startsWith(`pickfile:${member.slice(5)}:`));

/// Whether `key` sits in a group behind its lead, so out of the row: a pick's
/// own files go with the pick.
export function isSplit(sessionId: string, key: TabKey): boolean {
  return splitGroupsOf(sessionId).some((g) => g.slice(1).some((m) => covers(m, key)));
}

function save(sessionId: string, next: TabKey[][]) {
  // A group of one is just its tab again.
  groups.set(sessionId, next.filter((g) => g.length > 1));
  notify();
}

/// Puts `key` right of `lead`'s group, or makes one of the two. Out of any
/// group it was in first.
export function addSplit(sessionId: string, lead: TabKey, key: TabKey) {
  if (lead === key) return;
  const rest = splitGroupsOf(sessionId).map((g) => g.filter((m) => m !== key));
  const at = rest.findIndex((g) => g[0] === lead);
  if (at === -1) rest.push([lead, key]);
  else rest[at] = [...rest[at], key];
  // Equal again: a card dropped in beside dragged ones would get a share
  // measured in different units.
  for (const k of rest[at === -1 ? rest.length - 1 : at]) weights.get(sessionId)?.delete(k);
  save(sessionId, rest);
}

/// Each card's share of the split's width, by its tab's key. Absent is 1;
/// a drag sets every card on screen to its width in pixels.
const weights = new Map<string, Map<TabKey, number>>();

export function useSplitWeight(sessionId: string | null, key: TabKey | null): number {
  return useSyncExternalStore(subscribe, () => (sessionId && key ? weights.get(sessionId)?.get(key) : undefined) ?? 1);
}

export function setSplitWeights(sessionId: string, next: [TabKey, number][]) {
  const held = weights.get(sessionId) ?? new Map<TabKey, number>();
  for (const [key, w] of next) held.set(key, w);
  weights.set(sessionId, held);
  notify();
}

/// Takes `key` out of its group, back to its own tab.
export function removeSplit(sessionId: string, key: TabKey) {
  const now = splitGroupsOf(sessionId);
  if (!now.some((g) => g.includes(key))) return;
  save(sessionId, now.map((g) => g.filter((m) => m !== key)));
}

/// Drops every member `keep` refuses: a page closed, a task gone. A lead
/// dropped hands the group to the next member.
export function pruneSplits(sessionId: string, keep: (key: TabKey) => boolean) {
  const now = splitGroupsOf(sessionId);
  if (now.every((g) => g.every(keep))) return;
  save(sessionId, now.map((g) => g.filter(keep)));
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
/// On each card of a lit split, naming its tab's key: what a gap drag measures.
export const SPLIT_CARD = "data-split-card";

/// Whether a point over the main view would split a tab out, and so whether
/// the window has room for one more pane at `PANE_MIN`.
export function splitTarget(x: number, y: number, count: number): "room" | "full" | null {
  const host = document.querySelector(`[${SPLIT_HOST}]`)?.getBoundingClientRect();
  if (!host || x < host.left || x > host.right || y < host.top || y > host.bottom) return null;
  return host.width / (count + 2) >= PANE_MIN ? "room" : "full";
}
