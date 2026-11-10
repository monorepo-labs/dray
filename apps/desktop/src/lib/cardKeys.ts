import { useEffect, useRef, useSyncExternalStore } from "react";

import { isTextField } from "@/hooks/useHotkey";

/// Who answers number keys and Return while a card is waiting and the caret is
/// nowhere that wants them.
///
/// Several cards can be up at once — the conversation's own, and a child's in
/// the crew above the composer — and a keystroke must reach exactly one. The
/// conversation's own card ranks higher, since it blocks the turn the reader is
/// in; the crew's gets the keys once it is answered. A click on a card makes it
/// the one until it goes.

/// A card's rank: the conversation's own outranks the crew's.
export const RANK_OWN = 2;
export const RANK_CREW = 1;

type Card = {
  rank: number;
  el: () => HTMLElement | null;
  /// Answers one keystroke; false when the card has nothing for it.
  key: (e: KeyboardEvent) => boolean;
};

const cards: Card[] = [];
let preferred: Card | null = null;
let owner: Card | null = null;
const listeners = new Set<() => void>();

function drawn(card: Card): boolean {
  const el = card.el();
  return !!el && el.getClientRects().length > 0;
}

/// Highest rank wins, first to arrive among equals; a clicked card overrides.
function pick(): Card | null {
  if (preferred && cards.includes(preferred) && drawn(preferred)) return preferred;
  let best: Card | null = null;
  for (const card of cards) if (drawn(card) && (!best || card.rank > best.rank)) best = card;
  return best;
}

let crowded = false;

function settle() {
  const next = pick();
  const many = cards.filter(drawn).length > 1;
  if (next === owner && many === crowded) return;
  owner = next;
  crowded = many;
  listeners.forEach((l) => l());
}

/// Where Enter already means something to whatever has focus.
const ACTS_ON_ENTER = "button, a[href], select, [role=button], [role=link], [role=option]";

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.repeat) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const digit = e.key.length === 1 && e.key >= "1" && e.key <= "9";
  if (!digit && e.key !== "Enter") return;

  const target = e.target instanceof HTMLElement ? e.target : null;
  // The composer, or any field, keeps what it is typed; a question card's own
  // form answers to its keys itself once it has the focus.
  if (isTextField(target) || target?.closest("form, [role=dialog], [role=menu], [role=listbox]"))
    return;
  settle();
  const card = owner;
  if (!card) return;
  // A focused button presses itself — Deny included, which a forwarded Enter
  // would have turned into the card's pick.
  if (e.key === "Enter" && target?.closest(ACTS_ON_ENTER)) return;

  if (card.key(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/// Registers a waiting card for number keys and Return, and reports whether it
/// is the one they reach, and whether it has company. `rank` undefined opts out.
export function useCardKeys(
  ref: React.RefObject<HTMLElement | null>,
  rank: number | undefined,
  key: (e: KeyboardEvent) => boolean,
): { owns: boolean; contested: boolean } {
  const keyRef = useRef(key);
  keyRef.current = key;
  const cardRef = useRef<Card | null>(null);

  useEffect(() => {
    if (rank === undefined) return;
    const card: Card = { rank, el: () => ref.current, key: (e) => keyRef.current(e) };
    cardRef.current = card;
    cards.push(card);
    if (cards.length === 1) window.addEventListener("keydown", onKeyDown, true);
    const el = ref.current;
    const claim = () => {
      preferred = card;
      settle();
    };
    el?.addEventListener("pointerdown", claim);
    settle();
    return () => {
      el?.removeEventListener("pointerdown", claim);
      cards.splice(cards.indexOf(card), 1);
      if (preferred === card) preferred = null;
      if (cards.length === 0) window.removeEventListener("keydown", onKeyDown, true);
      cardRef.current = null;
      settle();
    };
  }, [rank, ref]);

  const owns = useSyncExternalStore(subscribe, () => !!owner && owner === cardRef.current);
  const contested = useSyncExternalStore(subscribe, () => crowded);
  return { owns, contested };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
