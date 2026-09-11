import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import {
  type Chord,
  defaultChord,
  sameChord,
  SHORTCUTS,
  type ShortcutId,
} from "@/lib/shortcuts";

/// The reader's rebindings, held once for the app.
///
/// A module store, since every `useHotkey` reads it and every keycap draws
/// from it: a per-hook copy would leave a tooltip naming the old chord after
/// the settings tab moved it. Only overrides are stored, so a default that
/// changes in a later build reaches everyone who never touched that row.
const KEY = "ade.shortcuts";
const changed = channel<void>();
let overrides: Partial<Record<ShortcutId, Chord>> | null = null;

function store() {
  if (!overrides) overrides = coerce(readLocalStorage<unknown>(KEY, null));
  return overrides;
}

/// Unknown ids and malformed chords are dropped rather than failing the read —
/// a stale id from a renamed shortcut must not cost the rest.
function coerce(raw: unknown): Partial<Record<ShortcutId, Chord>> {
  const out: Partial<Record<ShortcutId, Chord>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const { id } of SHORTCUTS) {
    const c = (raw as Record<string, unknown>)[id];
    if (!c || typeof c !== "object") continue;
    const { key, meta, shift, alt, code } = c as Record<string, unknown>;
    if (typeof key !== "string" || !key) continue;
    out[id] = {
      key,
      meta: !!meta,
      shift: !!shift,
      alt: !!alt,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return out;
}

function commit(next: Partial<Record<ShortcutId, Chord>>) {
  overrides = next;
  writeLocalStorage(KEY, next);
  changed.emit();
}

export function chordFor(id: ShortcutId): Chord {
  return store()[id] ?? defaultChord(id);
}

export function isOverridden(id: ShortcutId): boolean {
  return id in store();
}

/// Which other shortcut already holds this chord, if any.
export function holderOf(chord: Chord, except?: ShortcutId): ShortcutId | null {
  const hit = SHORTCUTS.find((s) => s.id !== except && sameChord(chordFor(s.id), chord));
  return hit?.id ?? null;
}

/// Sets the chord, or clears the override where it is the default again.
export function setChord(id: ShortcutId, chord: Chord) {
  const next = { ...store() };
  if (sameChord(chord, defaultChord(id))) delete next[id];
  else next[id] = chord;
  commit(next);
}

/// Puts the default back, unless another shortcut has since been moved onto
/// it — then nothing changes and the holder is answered, for the row to name.
/// The same refusal recording makes: a reset that quietly restored ⌘N beside a
/// search rebound to ⌘N would fire both on one press.
export function resetChord(id: ShortcutId): ShortcutId | null {
  const by = holderOf(defaultChord(id), id);
  if (by) return by;
  const next = { ...store() };
  delete next[id];
  commit(next);
  return null;
}

export function resetAllChords() {
  commit({});
}

/// The chord one shortcut currently answers to; re-renders on any rebinding.
export function useChord(id: ShortcutId): Chord {
  useSyncExternalStore(changed.subscribe, store, store);
  return chordFor(id);
}

/// Every override, for the settings tab.
export function useShortcutOverrides() {
  return useSyncExternalStore(changed.subscribe, store, store);
}
