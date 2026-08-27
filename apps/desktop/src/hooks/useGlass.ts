import { useEffect } from "react";

import { useTheme } from "@/hooks/useTheme";
import { keepsGlassInFullscreen } from "@/lib/theme";

/// Whether the document opened as glass at all — read once, at import, because
/// index.html stamps it before first paint and nothing else ever adds it. A
/// non-macOS window has no material behind the webview, so it must stay opaque.
const VIBRANT = document.documentElement.dataset.vibrancy !== undefined;

/// Owns both translucency attributes for the length of a fullscreen session.
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
  const { theme, resolvedMode } = useTheme();

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
}
