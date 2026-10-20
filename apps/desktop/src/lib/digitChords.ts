import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { chordFor } from "@/hooks/useShortcuts";
import { channel } from "@/lib/channel";
import { IS_MAC } from "@/lib/platform";
import { type ShortcutGroup, type ShortcutId, SHORTCUTS } from "@/lib/shortcuts";

/// A modifier set, bound once over a run of digits.
///
/// Raw flags rather than a registry `Chord`: the registry reads ⌃ as ⌘ on a
/// Mac (`meta` is either), so ⌃ alone could not be spelled there at all.
export type Mods = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };

const mods = (m: Partial<Mods>): Mods => ({ meta: false, ctrl: false, alt: false, shift: false, ...m });
/// The platform's own accelerator.
const ACCEL: Partial<Mods> = IS_MAC ? { meta: true } : { ctrl: true };

/// The shortcuts that are one modifier set over many digits, each a single row
/// in settings rather than one per digit. `slots` is how many digits it takes:
/// 9 is 1–9, 10 adds 0 as the tenth.
export const DIGIT_CHORDS = [
  // ⌥, not ⌃: off Mac ⌃ is the accelerator `tab.pick` holds, and on a Mac a
  // tap of ⌃ is Dray Notch's default, which held here would flash the badges.
  { id: "session.jump", label: "Jump to session", group: "Sessions", slots: 10, mods: mods({ alt: true }) },
  { id: "pane.focus", label: "Focus pane", group: "Sessions", slots: 9, mods: mods({ ...ACCEL, alt: true }) },
  // By position in the titlebar's row, the way a browser numbers its tabs; 9
  // is the last tab, not the ninth.
  { id: "tab.pick", label: "Go to tab (9 is the last)", group: "Panels and views", slots: 9, mods: mods(ACCEL) },
] as const satisfies readonly { id: string; label: string; group: ShortcutGroup; slots: number; mods: Mods }[];

export type DigitChordId = (typeof DIGIT_CHORDS)[number]["id"];

const KEY = "ade.digitChords";
const changed = channel<void>();
let overrides: Partial<Record<DigitChordId, Mods>> | null = null;

function store() {
  overrides ??= readLocalStorage<Partial<Record<DigitChordId, Mods>>>(KEY, {});
  return overrides;
}

const entry = (id: DigitChordId) => DIGIT_CHORDS.find((c) => c.id === id)!;

/// The modifiers this row answers to, read at the keystroke.
export function modsFor(id: DigitChordId): Mods {
  return store()[id] ?? entry(id).mods;
}

export function setMods(id: DigitChordId, next: Mods | null) {
  const { [id]: _, ...rest } = store();
  overrides = next && !sameMods(next, entry(id).mods) ? { ...rest, [id]: next } : rest;
  writeLocalStorage(KEY, overrides);
  changed.emit();
}

/// Re-renders on any rebinding.
export function useMods(id: DigitChordId): Mods {
  useSyncExternalStore(changed.subscribe, store);
  return modsFor(id);
}

/// Whether any row has left its default, for the settings tab's "Reset all".
export function useAnyModsOverride(): boolean {
  return Object.keys(useSyncExternalStore(changed.subscribe, store)).length > 0;
}

export function resetAllMods() {
  overrides = {};
  writeLocalStorage(KEY, overrides);
  changed.emit();
}

/// The ordinary shortcut bound on exactly `mods` plus this slot's digit, if any.
///
/// Such a binding wins its digit: it predates the row (search moved onto ⌘5
/// back when tab 5 was unbound) or was refused against it since. Only the
/// accelerator alone can say that — the registry spells nothing else under a
/// digit, and its `meta` taking ⌃ on a Mac is an alias nobody presses, so a
/// digit row on ⌃ claims those keys outright.
///
/// Matched on `code` as well as `key`, `useHotkey`'s own rule: a shifted digit
/// is recorded as `!` with `code: "Digit1"`.
export function registryHolder(m: Mods, slot: number): ShortcutId | null {
  const accel = IS_MAC ? m.meta && !m.ctrl : m.ctrl && !m.meta;
  if (!accel) return null;
  const digit = String((slot + 1) % 10);
  const hit = SHORTCUTS.find(({ id }) => {
    const c = chordFor(id);
    return (
      !!c &&
      c.meta &&
      c.shift === m.shift &&
      c.alt === m.alt &&
      (c.key === digit || c.code === `Digit${digit}`)
    );
  });
  return hit?.id ?? null;
}

type ModEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/// What is held on a keydown, counting the key being pressed. WebKit can
/// report a modifier's own keydown with its flag still down.
export function heldMods(e: ModEvent): Mods {
  return {
    meta: e.metaKey || e.key === "Meta",
    ctrl: e.ctrlKey || e.key === "Control",
    alt: e.altKey || e.key === "Alt",
    shift: e.shiftKey || e.key === "Shift",
  };
}

/// What is still held after a keyup, the released key not counted.
export function modsAfterUp(e: ModEvent): Mods {
  return {
    meta: e.metaKey && e.key !== "Meta",
    ctrl: e.ctrlKey && e.key !== "Control",
    alt: e.altKey && e.key !== "Alt",
    shift: e.shiftKey && e.key !== "Shift",
  };
}

/// Exactly the set and nothing else, so ⌘⌥digit never reads as ⌘ plus extra.
export function sameMods(a: Mods, b: Mods): boolean {
  return a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

export function anyMods(m: Mods): boolean {
  return m.meta || m.ctrl || m.alt || m.shift;
}

/// Shift alone types `!@#`, and no modifier at all is typing digits.
export function usableMods(m: Mods): boolean {
  return m.meta || m.ctrl || m.alt;
}

/// The caps, in the order the registry draws its own.
export function modCaps(m: Mods): string[] {
  return [
    m.meta && (IS_MAC ? "⌘" : "Win"),
    m.ctrl && (IS_MAC ? "⌃" : "Ctrl"),
    m.alt && (IS_MAC ? "⌥" : "Alt"),
    m.shift && "Shift",
  ].filter((c): c is string => !!c);
}

/// The slot a key names, 0-based, or null. Read off `code`: ⌥ and ⇧ both
/// rewrite `key` (⌥1 is "¡", ⇧1 is "!"), the physical row does not move.
export function digitSlot(code: string): number | null {
  const m = /^Digit(\d)$/.exec(code);
  if (!m) return null;
  return m[1] === "0" ? 9 : Number(m[1]) - 1;
}

/// The rows wearing a number right now, in slot order, or null while hidden.
/// A module store so each sidebar row reads its own digit without the list
/// threading an index through every group it draws.
let shown: readonly string[] | null = null;
const badges = channel<void>();

/// The rows the badges name, so a digit pressed while they are up opens the
/// session wearing it even if the list has reordered underneath.
export const jumpBadges = () => shown;

export function showJumpBadges(ids: readonly string[] | null) {
  if (shown === ids) return;
  shown = ids;
  badges.emit();
}

/// The digit this row answers to while the badges are up, else null.
export function useJumpDigit(sessionId: string): string | null {
  const ids = useSyncExternalStore(badges.subscribe, () => shown);
  const at = ids?.indexOf(sessionId) ?? -1;
  return at === -1 ? null : String((at + 1) % 10);
}
