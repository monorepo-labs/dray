import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";

const KEY = "ade.zoom";
/// Safari's own ladder, so a step lands where a Mac reader expects it to.
const STEPS = [0.5, 0.75, 0.85, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3];

function stored(): number {
  const v = readLocalStorage<unknown>(KEY, 1);
  return typeof v === "number" && v >= STEPS[0] && v <= STEPS[STEPS.length - 1] ? v : 1;
}

let level = stored();

/// The webview's page zoom. CSS pixels are this many window points, which is
/// what the browser pane's native view has to be told in.
export function zoomLevel(): number {
  return level;
}

/// Sets the zoom and remembers it. Also run once at launch, since the webview
/// starts at 1 whatever was stored.
export function applyZoom(next = level): void {
  level = next;
  writeLocalStorage(KEY, level);
  try {
    void getCurrentWebview()
      .setZoom(level)
      // The browser pane re-reports its rect on resize, and a zoom moves every
      // rect in points without necessarily resizing anything in CSS pixels.
      .then(() => window.dispatchEvent(new Event("resize")))
      .catch(() => undefined);
  } catch {
    // Outside Tauri (a demo page) there is no webview to zoom.
  }
}

/// One step up or down the ladder, or back to 100% on `0`.
export function stepZoom(dir: 1 | -1 | 0): void {
  if (dir === 0) return applyZoom(1);
  const next =
    dir > 0 ? STEPS.find((s) => s > level + 1e-6) : [...STEPS].reverse().find((s) => s < level - 1e-6);
  if (next !== undefined) applyZoom(next);
}
