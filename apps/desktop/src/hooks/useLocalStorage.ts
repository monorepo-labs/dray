import { useCallback, useState } from "react";

/// What a write held that the store refused to take.
///
/// The write below is best-effort and the hook keeps the value in React state
/// either way, which is what makes "the preference just won't outlive the
/// session" true. It was only true for the hook: a reader coming through
/// [`readLocalStorage`] got the last value the store *accepted*, so on that
/// path the two disagreed — and the pair that would disagree is a menu and the
/// chord that has to cycle exactly what the menu draws.
const unwritten = new Map<string, unknown>();

/// One stored preference, read outside a render.
///
/// Exported so a plain function can read a key this hook writes without keeping
/// a second copy of the JSON encoding — which is the sort of contract that
/// drifts once and then silently reads every stored value as its default.
export function readLocalStorage<T>(key: string, initial: T): T {
  if (unwritten.has(key)) return unwritten.get(key) as T;

  try {
    const raw = localStorage.getItem(key);
    return raw === null ? initial : (JSON.parse(raw) as T);
  } catch {
    return initial;
  }
}

/// Stores one preference, best-effort, and keeps it readable either way.
///
/// Split out of the hook so the pair with [`readLocalStorage`] can be tested
/// without a renderer — which is the half that broke, not the React state.
export function writeLocalStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    unwritten.delete(key);
  } catch {
    unwritten.set(key, value);
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
