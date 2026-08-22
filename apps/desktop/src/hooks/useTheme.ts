import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  readStoredTheme,
  resolveMode,
  watchSystemMode,
  type ResolvedMode,
  type ThemeMode,
  type ThemeName,
} from "@/lib/theme";

/// Reads the theme the pre-paint script already stamped on `<html>`, then keeps it in
/// sync. `resolvedMode` is what's actually rendering — read that, not `mode`, when a
/// component needs to branch on light/dark (a Shiki theme, say).
export function useTheme() {
  const [{ name, mode }, setState] = useState(readStoredTheme);
  const [resolvedMode, setResolvedMode] = useState<ResolvedMode>(() => resolveMode(mode));

  // The script in index.html stamps the document before paint, so this effect is
  // only re-applying the same values — it exists to cover a stored value the script
  // rejected and to own the attributes from here on.
  useEffect(() => {
    setResolvedMode(applyTheme(name, mode));
  }, [name, mode]);

  useEffect(() => {
    if (mode !== "system") return;
    return watchSystemMode(() => setResolvedMode(applyTheme(name, mode)));
  }, [name, mode]);

  const setTheme = useCallback(
    (next: ThemeName) => setState((prev) => ({ ...prev, name: next })),
    [],
  );

  const setMode = useCallback(
    (next: ThemeMode) => setState((prev) => ({ ...prev, mode: next })),
    [],
  );

  return { theme: name, mode, resolvedMode, setTheme, setMode };
}
