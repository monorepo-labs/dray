import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useTheme } from "@/hooks/useTheme";
import { keepsGlassInFullscreen, modeFor } from "@/lib/theme";

/// Whether the document opened as glass at all — read once, at import, because
/// index.html stamps it before first paint and nothing else ever adds it. A
/// non-macOS window has no material behind the webview, so it must stay opaque.
const VIBRANT = document.documentElement.dataset.vibrancy !== undefined;

/// Owns both translucency attributes for the length of a fullscreen session, and
/// the appearance of the native material behind them.
///
/// Windowed, the app is always translucent — there is a desktop behind it, and a
/// window that layers over the thing it is sitting on is the whole look. So there
/// is nothing to ask about, and the toggle does not reach this case.
///
/// Fullscreen is where the question is real. Nothing is behind a fullscreen window
/// but the space's own black, so `data-vibrancy` comes off unconditionally — the
/// material would go flat grey and read as the theme washing out. What is left is
/// whether the surfaces stay layered over the theme's own backdrop or the app goes
/// fully opaque, and **the palette answers that**, not the reader — see
/// `keepsGlassInFullscreen`, which weighs the mode and the theme in that order.
///
/// The invariant this guarantees, which App.css leans on: vibrancy is never present
/// without transparency. Two veils can therefore never stack, because the pair that
/// would stack them cannot occur.
///
/// Takes `fullscreen` rather than calling [useFullscreen](./useFullscreen.ts) itself
/// so the app keeps one resize listener.
export function useGlass(fullscreen: boolean) {
  const { theme, mode, resolvedMode } = useTheme();

  useEffect(() => {
    const el = document.documentElement;

    // Stamped pre-paint and true for every windowed launch, so this only ever
    // takes it away — in fullscreen, for light mode or a flat-in-fullscreen
    // theme. One frame of glass is the cost of not being able to ask the OS
    // about fullscreen before the first paint.
    if (!fullscreen || keepsGlassInFullscreen(theme, resolvedMode)) {
      el.dataset.transparency = "";
    } else {
      delete el.dataset.transparency;
    }

    if (!VIBRANT) return;
    if (fullscreen) delete el.dataset.vibrancy;
    else el.dataset.vibrancy = "";
  }, [fullscreen, theme, resolvedMode]);

  // An NSVisualEffectView blurs in the appearance it is *given* and inherits the
  // system's otherwise, so a light palette on a Mac set to Dark composited over a
  // dark blur and went grey — the whole reason light's `--vibrancy-alpha` sat at
  // 92%. This is the fix App.css said could not come from the CSS side. App-wide,
  // which is what `set_theme` is on macOS: traffic lights, menu bar and native
  // dialogs follow Dray's mode rather than the system's.
  //
  // `null` is not a spelling of "whatever is on screen", and passing
  // `resolvedMode` unconditionally breaks the case that distinction exists for:
  // pinning the appearance also pins what the webview reports for
  // `prefers-color-scheme`, the only thing `watchSystemMode` has to go on, so a
  // reader on System would freeze at the mode the app launched in. `modeFor`
  // already draws that line — it answers `system` only where the theme has a light
  // palette to switch to, and pins a dark-only one to `dark`.
  useEffect(() => {
    const wanted = modeFor(theme, mode) === "system" ? null : resolvedMode;
    try {
      // Throws rather than rejects outside a Tauri webview, so the promise's own
      // `catch` cannot stand in for the `try`.
      void getCurrentWindow().setTheme(wanted).catch(noop);
    } catch {
      // `pnpm dev` in a plain browser — no native window to dress.
    }
  }, [theme, mode, resolvedMode]);
}

function noop() {}
