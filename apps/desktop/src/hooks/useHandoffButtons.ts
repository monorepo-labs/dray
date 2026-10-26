import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { DEFAULT_HANDOFF_BUTTONS, readHandoffButtons } from "@/lib/handoff";
import type { HandoffButton } from "@/lib/handoff";

const KEY = "ade.handoffButtons";

/// A module store rather than `useLocalStorage`: Settings writes it while the
/// composer's row reads it, and per-hook copies would only agree after a reload.
const changed = channel<void>();

let buttons: HandoffButton[] = readHandoffButtons(readLocalStorage<unknown>(KEY, null));

export function setHandoffButtons(next: HandoffButton[]) {
  buttons = next;
  writeLocalStorage(KEY, next);
  changed.emit();
}

/// Back to the row as shipped. The key is removed rather than written, so a
/// later build's defaults reach this reader too.
export function resetHandoffButtons() {
  buttons = DEFAULT_HANDOFF_BUTTONS;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // A store the webview refuses; the defaults live in memory meanwhile.
  }
  changed.emit();
}

/// The reader's handoff buttons, in draw order, before `handoffActions`
/// decides which of them this checkout earns.
export function useHandoffButtons(): HandoffButton[] {
  return useSyncExternalStore(changed.subscribe, () => buttons, () => buttons);
}
