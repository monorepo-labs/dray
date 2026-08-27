import { useCallback, useSyncExternalStore } from "react";

import {
  applyTheme,
  modeFor,
  readStoredTheme,
  watchSystemMode,
  type ResolvedMode,
  type ThemeMode,
  type ThemeName,
} from "@/lib/theme";

/// The theme, held once for the whole app.
///
/// A module store rather than the per-hook `useState` this used to be, and that
/// stopped being a preference the moment [useGlass](./useGlass.ts) started reading
/// the theme: with a copy each, the settings dialog would set a theme its own hook
/// knew about and the window would keep the old one's fullscreen behaviour. Several
/// components hold this at once — every mounted diff reads `resolvedMode` — so the
/// same argument [useCodeTheme](./useCodeTheme.ts) makes applies here too.
type ThemeState = { name: ThemeName; mode: ThemeMode; resolvedMode: ResolvedMode };

const listeners = new Set<() => void>();

let current: ThemeState = init();
let unwatch: (() => void) | null = null;

function init(): ThemeState {
  const { name, mode } = readStoredTheme();
  // The script in index.html stamped the document before paint, so this is normally
  // re-applying the same values. It exists to own the attributes from here on, and to
  // cover a stored value that script wrote through untouched but `coerceTheme`
  // rejects — a theme id we no longer ship, which is the whole of the rename path.
  return { name, mode, resolvedMode: applyTheme(name, mode) };
}

function emit() {
  for (const listener of listeners) listener();
}

/// Re-subscribes to the OS only while the mode is `system`. Torn down and rebuilt on
/// every change rather than filtered at the callback, so a window left on a fixed
/// mode holds no listener at all.
function rewatch() {
  unwatch?.();
  unwatch = null;
  if (current.mode !== "system") return;
  unwatch = watchSystemMode(() => {
    const resolvedMode = applyTheme(current.name, current.mode);
    if (resolvedMode === current.resolvedMode) return;
    current = { ...current, resolvedMode };
    emit();
  });
}

rewatch();

function set(next: Partial<Pick<ThemeState, "name" | "mode">>) {
  const name = next.name ?? current.name;
  // Picking a dark-only theme while in light mode has to force dark here rather
  // than at the call site, or every future setter has to remember the rule.
  const mode = modeFor(name, next.mode ?? current.mode);
  if (name === current.name && mode === current.mode) return;
  current = { name, mode, resolvedMode: applyTheme(name, mode) };
  rewatch();
  emit();
}

/// Exported so a surface can set these without holding the hook.
export function setTheme(name: ThemeName) {
  set({ name });
}

export function setMode(mode: ThemeMode) {
  set({ mode });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/// The palette, the mode as chosen, and the mode as rendered.
///
/// `resolvedMode` is what is actually on screen — read that, not `mode`, when a
/// component needs to branch on light/dark (a Shiki theme, say).
export function useTheme() {
  const state = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );

  return {
    theme: state.name,
    mode: state.mode,
    resolvedMode: state.resolvedMode,
    setTheme: useCallback(setTheme, []),
    setMode: useCallback(setMode, []),
  };
}
