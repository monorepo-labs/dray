import { useSyncExternalStore } from "react";

import { invoke } from "@/lib/transport";

let shown = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (shown === next) return;
  shown = next;
  for (const fn of listeners) fn();
}

/// Counts a merge made in the app, raising the star card where Rust says this
/// one is due. Silent on failure: the merge already landed, and a server pointed
/// at from a plain browser answers this command `unknown command`.
export function noteMergeForStar() {
  invoke<boolean>("note_merge_for_star")
    .then((ask) => ask && set(true))
    .catch(() => {});
}

export const closeStarPrompt = () => set(false);

/// Whether the star card is up.
export function useStarPrompt(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => shown,
  );
}
