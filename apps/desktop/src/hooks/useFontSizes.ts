import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import {
  applyFontSizes,
  coerceFontSizes,
  DEFAULT_FONT_SIZES,
  FONT_SIZES_KEY,
  type FontSizes,
  type FontSlot,
} from "@/lib/fontSize";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";

/// The reader's text sizes, held once for the app — same shape as `useTheme`,
/// and lazy for the same reason: the first read stamps `<html>`, which must not
/// happen at import in a test with no DOM.
const changed = channel<void>();
let current: FontSizes | null = null;

function store(): FontSizes {
  if (!current) {
    current = coerceFontSizes(readLocalStorage<unknown>(FONT_SIZES_KEY, null));
    applyFontSizes(current);
  }
  return current;
}

export function setFontSize(slot: FontSlot, px: number) {
  const next = coerceFontSizes({ ...store(), [slot]: px });
  if (next[slot] === store()[slot]) return;
  commit(next);
}

export function resetFontSizes() {
  commit({ ...DEFAULT_FONT_SIZES });
}

function commit(next: FontSizes) {
  current = next;
  applyFontSizes(next);
  writeLocalStorage(FONT_SIZES_KEY, next);
  changed.emit();
}

export function useFontSizes(): FontSizes {
  return useSyncExternalStore(changed.subscribe, store, store);
}
