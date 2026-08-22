import { useCallback, useState } from "react";

/// State that survives reload. Reads lazily so a throwing or absent store costs the
/// initial value rather than the render, and writes are best-effort for the same reason.
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Non-fatal: the preference just won't outlive the session.
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set] as const;
}
