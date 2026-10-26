import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { readHandoffConfig } from "@/lib/handoff";
import type { HandoffConfig } from "@/lib/handoff";

const KEY = "ade.handoff";

/// A module store rather than `useLocalStorage`: Settings writes it while the
/// composer's row reads it, and per-hook copies would only agree after a reload.
const changed = channel<void>();

let config: HandoffConfig = readHandoffConfig(readLocalStorage<unknown>(KEY, null));

export function setHandoffConfig(next: HandoffConfig) {
  config = next;
  writeLocalStorage(KEY, next);
  changed.emit();
}

/// Which built-ins the reader switched off and the buttons they added, before
/// `handoffActions` decides which of them this checkout earns.
export function useHandoffConfig(): HandoffConfig {
  return useSyncExternalStore(changed.subscribe, () => config, () => config);
}
