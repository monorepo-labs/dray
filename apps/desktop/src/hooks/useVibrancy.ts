import { useEffect } from "react";

/// Whether the document opened as glass at all — read once, at import, because
/// index.html stamps it before first paint and nothing else ever adds it. A
/// non-macOS window has no material behind the webview, so it must stay opaque.
const VIBRANT = document.documentElement.dataset.vibrancy !== undefined;

/// Turns the window's translucency off for the length of a fullscreen session.
///
/// A fullscreen window has nothing behind it but the space's own black, so the
/// material stops being glass and becomes flat grey — which reads as the theme
/// having washed out rather than as an effect. Takes `fullscreen` rather than
/// calling [useFullscreen](./useFullscreen.ts) itself so the app keeps one
/// resize listener.
export function useVibrancy(fullscreen: boolean) {
  useEffect(() => {
    if (!VIBRANT) return;

    const el = document.documentElement;
    if (fullscreen) delete el.dataset.vibrancy;
    else el.dataset.vibrancy = "";
  }, [fullscreen]);
}
