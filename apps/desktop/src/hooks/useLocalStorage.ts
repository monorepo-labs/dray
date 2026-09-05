import { useCallback, useState } from "react";

/// One stored preference, read outside a render.
///
/// Exported so a plain function can read a key this hook writes without keeping
/// a second copy of the JSON encoding — which is the sort of contract that
/// drifts once and then silently reads every stored value as its default.
export function readLocalStorage<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? initial : (JSON.parse(raw) as T);
  } catch {
    return initial;
  }
}

/// Stores one preference, best-effort: a refused write costs the preference
/// its next launch, never the render.
export function writeLocalStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or a store the webview refuses; the value lives in state meanwhile.
  }
}

/// State that survives reload. Reads lazily so a throwing or absent store costs the
/// initial value rather than the render, and writes are best-effort for the same reason.
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readLocalStorage(key, initial));

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writeLocalStorage(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set] as const;
}
