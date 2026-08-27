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

let current: ThemeState | null = null;
let unwatch: (() => void) | null = null;

/// The store, built on first read rather than at import.
///
/// Laziness is load-bearing, not tidiness: `init` stamps `document`, so importing
/// this module used to have a side effect. That was invisible while only components
/// reached it, and broke the moment [Orb](../components/Orb.tsx) put `useTheme` into
/// `Sidebar`'s import graph — the pure-logic tests import `sortSessions` from there
/// and run with no DOM, so merely resolving the import threw. Nothing is lost by
/// waiting: the first read happens during the first render, and the pre-paint script
/// in index.html has already stamped the document by then.
function store(): ThemeState {
  if (!current) {
    const { name, mode } = readStoredTheme();
    // Normally re-applying what the pre-paint script already wrote. It exists to own
    // the attributes from here on, and to cover a stored value that script wrote
    // through untouched but `coerceTheme` rejects — a theme id we no longer ship,
    // which is the whole of the rename path.
    current = { name, mode, resolvedMode: applyTheme(name, mode) };
    rewatch();
  }
  return current;
}

function emit() {
  for (const listener of listeners) listener();
}

/// Re-subscribes to the OS only while the mode is `system`. Torn down and rebuilt on
/// every change rather than filtered at the callback, so a window left on a fixed
/// mode holds no listener at all.
///
/// Only ever called with `current` already set, so it reads the field directly rather
/// than through `store()` — going back through it here would recurse on first build.
function rewatch() {
  unwatch?.();
  unwatch = null;
  const state = current;
  if (!state || state.mode !== "system") return;
  unwatch = watchSystemMode(() => {
    const resolvedMode = applyTheme(state.name, state.mode);
    if (resolvedMode === current?.resolvedMode) return;
    current = { ...state, resolvedMode };
    emit();
  });
}

function set(next: Partial<Pick<ThemeState, "name" | "mode">>) {
  const state = store();
  const name = next.name ?? state.name;
  // Picking a dark-only theme while in light mode has to force dark here rather
  // than at the call site, or every future setter has to remember the rule.
  const mode = modeFor(name, next.mode ?? state.mode);
  if (name === state.name && mode === state.mode) return;
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
  const state = useSyncExternalStore(subscribe, store, store);

  return {
    theme: state.name,
    mode: state.mode,
    resolvedMode: state.resolvedMode,
    setTheme: useCallback(setTheme, []),
    setMode: useCallback(setMode, []),
  };
}
