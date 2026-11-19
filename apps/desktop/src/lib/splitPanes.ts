import { useSyncExternalStore } from "react";

import type { TabKey } from "@/lib/tabOrder";

/// One split group. `lead` is the tab whose view the main column draws;
/// `keys` is every member, the lead among them, left to right as the cards
/// sit. The row draws a group as one tab in the lead's slot; the others keep
/// their own slots in the row's order, so a pane closed puts its tab back
/// where it was.
export type SplitGroup = { lead: TabKey; keys: TabKey[] };
export type Side = "left" | "right";

/// A session's split groups, keyed by the row's session. In memory, like the
/// row's order.
const groups = new Map<string, SplitGroup[]>();
/// The lead of the group whose tab is lit, published by the row.
const lit = new Map<string, TabKey | null>();
/// What a pane's header draws, published by the row that knows it.
export type PaneHead = { icon: React.ReactNode; label: string };
const heads = new Map<string, Map<TabKey, PaneHead>>();
/// A tab held over the main view: the drop that would split it out, and on
/// which side.
export type SplitDrag = { sessionId: string; key: TabKey; label: string | null; side: Side };
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

const NONE: SplitGroup[] = [];
const EMPTY: TabKey[] = [];

export function splitGroupsOf(sessionId: string): SplitGroup[] {
  return groups.get(sessionId) ?? NONE;
}

export function useSplitGroups(sessionId: string | null): SplitGroup[] {
  return useSyncExternalStore(subscribe, () => (sessionId ? splitGroupsOf(sessionId) : NONE));
}

/// Every tab sitting behind a lead, out of the row.
export const membersOf = (group: SplitGroup) => group.keys.filter((k) => k !== group.lead);

export function litGroupOf(sessionId: string): SplitGroup | null {
  const lead = lit.get(sessionId);
  return splitGroupsOf(sessionId).find((g) => g.lead === lead) ?? null;
}

export function useLitGroup(sessionId: string | null): SplitGroup | null {
  return useSyncExternalStore(subscribe, () => (sessionId ? litGroupOf(sessionId) : null));
}

// Per group object, which is replaced on every change: a store snapshot must
// be the same object until something moves.
const tails = new WeakMap<SplitGroup, TabKey[]>();

/// The lit group's panes, lead left out: what is drawn beside the main view.
export function splitPanesOf(sessionId: string): TabKey[] {
  const group = litGroupOf(sessionId);
  if (!group) return EMPTY;
  if (!tails.has(group)) tails.set(group, membersOf(group));
  return tails.get(group)!;
}

export function useSplitPanes(sessionId: string | null): TabKey[] {
  return useSyncExternalStore(subscribe, () => (sessionId ? splitPanesOf(sessionId) : EMPTY));
}

/// Called from the row, which alone knows which tab is lit.
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
  return splitGroupsOf(sessionId).some((g) => membersOf(g).some((m) => covers(m, key)));
}

/// Writes `next`, keeping each group's lead among its keys — a lead gone
/// hands the group to its leftmost card — and dissolving a group of one,
/// which is just its tab again.
function save(sessionId: string, next: SplitGroup[]) {
  groups.set(
    sessionId,
    next
      .filter((g) => g.keys.length > 1)
      .map((g) => (g.keys.includes(g.lead) ? g : { lead: g.keys[0], keys: g.keys })),
  );
  notify();
}

/// Puts `key` at `side`'s end of `lead`'s group, or makes one of the two.
/// Out of any group it was in first.
export function addSplit(sessionId: string, lead: TabKey, key: TabKey, side: Side = "right") {
  if (lead === key) return;
  const rest = splitGroupsOf(sessionId).map((g) => ({ ...g, keys: g.keys.filter((m) => m !== key) }));
  let group = rest.find((g) => g.lead === lead);
  if (!group) {
    group = { lead, keys: [lead] };
    rest.push(group);
  }
  group.keys = side === "left" ? [key, ...group.keys] : [...group.keys, key];
  // Equal again: a card dropped in beside dragged ones would get a share
  // measured in different units.
  for (const k of group.keys) weights.get(sessionId)?.delete(k);
  save(sessionId, rest);
}

/// ⌥-drag inside a group's tab: `key` to place `to` among the cards.
export function moveInGroup(sessionId: string, lead: TabKey, key: TabKey, to: number) {
  save(
    sessionId,
    splitGroupsOf(sessionId).map((g) => {
      if (g.lead !== lead) return g;
      const keys = g.keys.filter((k) => k !== key);
      keys.splice(to, 0, key);
      return { ...g, keys };
    }),
  );
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
  pruneSplits(sessionId, (k) => k !== key);
}

/// Drops every member `keep` refuses: a page closed, a task gone.
export function pruneSplits(sessionId: string, keep: (key: TabKey) => boolean) {
  const now = splitGroupsOf(sessionId);
  if (now.every((g) => g.keys.every(keep))) return;
  save(sessionId, now.map((g) => ({ ...g, keys: g.keys.filter(keep) })));
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
  if (
    next?.sessionId === drag?.sessionId &&
    next?.key === drag?.key &&
    next?.label === drag?.label &&
    next?.side === drag?.side
  )
    return;
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

/// The gap between two cards, `SplitPanes`' `w-1.5`.
export const SPLIT_GAP = 6;

/// Whether a point over the main view would split a tab out, on which side —
/// the half it is over — and whether the host is at least `need` wide: what
/// the cards after the drop take at their floors, gaps included.
export function splitTarget(
  x: number,
  y: number,
  need: number,
): { room: boolean; side: Side } | null {
  const host = document.querySelector(`[${SPLIT_HOST}]`)?.getBoundingClientRect();
  if (!host || x < host.left || x > host.right || y < host.top || y > host.bottom) return null;
  return {
    room: host.width >= need,
    side: x < host.left + host.width / 2 ? "left" : "right",
  };
}
