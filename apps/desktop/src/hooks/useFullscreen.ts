import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/// True while the window is fullscreen. Under `titleBarStyle: Overlay` the macOS
/// traffic lights float over our own chrome, but they disappear in fullscreen —
/// so the space reserved for them has to be reclaimed or it reads as a gap.
///
/// Asks Tauri rather than matching `display-mode: fullscreen`: the media query
/// stays false in a Tauri webview through a native fullscreen transition, so it
/// silently never fires. Kept only as the plain-browser fallback.
export function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const apply = (value: boolean) => {
      if (!cancelled) setFullscreen(value);
    };

    void (async () => {
      try {
        const win = getCurrentWindow();
        apply(await win.isFullscreen());

        // Fires on every resize, including the fullscreen transition — there is
        // no dedicated fullscreen event.
        unlisten = await win.onResized(async () => {
          apply(await win.isFullscreen());
        });
      } catch {
        // Not in a Tauri window (the dev server in a browser).
        if (typeof matchMedia === "undefined") return;
        const mq = matchMedia("(display-mode: fullscreen)");
        const onChange = () => apply(mq.matches);
        mq.addEventListener("change", onChange);
        onChange();
        unlisten = () => mq.removeEventListener("change", onChange);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return fullscreen;
}
