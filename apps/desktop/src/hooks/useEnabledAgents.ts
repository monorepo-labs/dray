import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { HARNESS_ORDER } from "@/lib/model";
import type { Harness } from "@/types/events";

/// Stores the agents turned *off*, so an agent a later build adds starts on.
const KEY = "ade.disabledAgents";

/// A module store rather than `useLocalStorage`: Settings writes it while the
/// composer's picker and `App`'s chord read it, and per-hook copies would only
/// agree after a reload.
const changed = channel<void>();

let enabled: Harness[] = read();

function read(): Harness[] {
  const off = readLocalStorage<Harness[]>(KEY, []);
  const on = HARNESS_ORDER.filter((h) => !off.includes(h));
  // Every agent off leaves the composer nothing to start a session in.
  return on.length ? on : HARNESS_ORDER;
}

/// Turns one agent on or off in the composer's picker. Refuses to turn off the
/// last one standing.
export function setAgentEnabled(harness: Harness, on: boolean) {
  const next = on
    ? HARNESS_ORDER.filter((h) => h === harness || enabled.includes(h))
    : enabled.filter((h) => h !== harness);
  if (next.length === 0) return;
  enabled = next;
  writeLocalStorage(KEY, HARNESS_ORDER.filter((h) => !next.includes(h)));
  changed.emit();
}

/// The agents the picker offers and ⌘⇧A steps through, in picker order.
/// Sessions already running on a disabled agent are untouched.
export function useEnabledAgents(): Harness[] {
  return useSyncExternalStore(changed.subscribe, () => enabled, () => enabled);
}
