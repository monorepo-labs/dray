import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import {
  type Chord,
  defaultChord,
  PREVIOUS_DEFAULTS,
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
///
/// An entry held as `null` is the row the reader **unbound**, which is a third
/// state rather than the absence of an override: absent means "whatever this
/// build ships", where null means "no chord at all, and a later build must not
/// hand one back". So every read here asks `id in` rather than reading the
/// value and falling back, or an unbound row would resolve to its default.
const KEY = "ade.shortcuts";
const changed = channel<void>();
let overrides: Overrides | null = null;

type Overrides = Partial<Record<ShortcutId, Chord | null>>;

function store(): Overrides {
  if (!overrides) {
    const read = coerce(readLocalStorage<unknown>(KEY, null));
    overrides = yieldMovedDefaults(read);
    if (overrides !== read) writeLocalStorage(KEY, overrides);
  }
  return overrides;
}

/// Puts a row whose default moved back where it was, wherever the new default
/// is a chord the reader has already bound to something else.
///
/// Idempotent without a version stamp: the fix is itself an override, so the
/// row stops qualifying, and the recorder refuses a chord any row holds, so
/// nothing but a moved default can recreate the clash. Answers the same object
/// where nothing moved, which is how the caller knows not to write. Where the
/// old default is taken too, the row is unbound rather than left colliding.
export function yieldMovedDefaults(held: Overrides): Overrides {
  let out = held;
  for (const { id } of SHORTCUTS) {
    const previous = PREVIOUS_DEFAULTS[id];
    if (!previous || id in held) continue;
    // Against every other row as it now resolves, defaults included, so the
    // chord handed back cannot land on a row that was never rebound.
    const clashes = (chord: Chord) =>
      SHORTCUTS.some(({ id: other }) => {
        const c = other in out ? out[other] : defaultChord(other);
        return other !== id && !!c && sameChord(c, chord);
      });
    if (!clashes(defaultChord(id))) continue;
    out = { ...out, [id]: clashes(previous) ? null : previous };
  }
  return out;
}

/// Unknown ids and malformed chords are dropped rather than failing the read —
/// a stale id from a renamed shortcut must not cost the rest.
function coerce(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const { id } of SHORTCUTS) {
    const c = (raw as Record<string, unknown>)[id];
    // An explicit null is an unbinding and is kept; anything else unusable is
    // dropped, which reads as never having touched the row.
    if (c === null && id in raw) {
      out[id] = null;
      continue;
    }
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

function commit(next: Overrides) {
  overrides = next;
  writeLocalStorage(KEY, next);
  changed.emit();
}

/// The chord this id answers to, or `null` where the reader has unbound it.
export function chordFor(id: ShortcutId): Chord | null {
  const held = store();
  return id in held ? (held[id] ?? null) : defaultChord(id);
}

export function isOverridden(id: ShortcutId): boolean {
  return id in store();
}

/// Which other shortcut already holds this chord, if any.
export function holderOf(chord: Chord, except?: ShortcutId): ShortcutId | null {
  const hit = SHORTCUTS.find((s) => {
    const held = chordFor(s.id);
    return s.id !== except && held !== null && sameChord(held, chord);
  });
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

/// Leaves the action with no chord at all.
///
/// Stored as an explicit null rather than by deleting the entry, which is what
/// `resetChord` does and means the opposite: a deleted entry falls back to the
/// default, so unbinding that way would put the chord straight back.
export function clearChord(id: ShortcutId) {
  commit({ ...store(), [id]: null });
}

export function resetAllChords() {
  commit({});
}

/// The chord one shortcut currently answers to; re-renders on any rebinding.
export function useChord(id: ShortcutId): Chord | null {
  useSyncExternalStore(changed.subscribe, store, store);
  return chordFor(id);
}

/// Every override, for the settings tab.
export function useShortcutOverrides() {
  return useSyncExternalStore(changed.subscribe, store, store);
}
