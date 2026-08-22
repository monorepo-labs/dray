import { useCallback, useSyncExternalStore } from "react";

import {
  CODE_THEMES,
  DEFAULT_CODE_THEME,
  codeThemePair,
  type CodeThemeId,
  type CodeThemePair,
} from "@/lib/codeTheme";
import { useTheme } from "@/hooks/useTheme";

const KEY = "ade.codeTheme";

/// Shared rather than per-hook state. Diffs and markdown code blocks both read
/// this, and several of each are mounted at once — with `useLocalStorage`'s
/// per-component `useState` they would each hold their own copy and only the
/// component that owned the picker would re-render on a change.
const listeners = new Set<() => void>();

let current: CodeThemeId = read();

function read(): CodeThemeId {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_CODE_THEME;
    const parsed = JSON.parse(raw) as CodeThemeId;
    return CODE_THEMES.some((t) => t.id === parsed) ? parsed : DEFAULT_CODE_THEME;
  } catch {
    return DEFAULT_CODE_THEME;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/// Exported so a settings surface can set this without holding the hook.
export function setCodeTheme(id: CodeThemeId) {
  if (id === current) return;
  current = id;
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    // Non-fatal: the preference just won't outlive the session.
  }
  for (const listener of listeners) listener();
}

/// The chosen code theme, the pair it resolves to, and a setter.
///
/// `pair` is what both consumers want: Shiki takes light and dark together and
/// picks a side by the mode it's told, so neither has to branch on it.
export function useCodeTheme(): {
  id: CodeThemeId;
  pair: CodeThemePair;
  setCodeTheme: (id: CodeThemeId) => void;
} {
  const id = useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_CODE_THEME,
  );

  return {
    id,
    pair: codeThemePair(id),
    setCodeTheme: useCallback(setCodeTheme, []),
  };
}

/// The resolved mode alongside the pair, for a surface that needs both — Shiki
/// picks by the mode we hand it rather than sniffing the OS, so a user whose app
/// mode disagrees with their system still gets matching code colors.
export function useCodeThemeWithMode() {
  const { resolvedMode } = useTheme();
  const { id, pair, setCodeTheme } = useCodeTheme();
  return { id, pair, resolvedMode, setCodeTheme };
}
