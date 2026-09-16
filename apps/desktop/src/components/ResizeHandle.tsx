import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { MAX_SHARE, paneCap, snapWidth } from "@/lib/resize";
import { cn } from "@/lib/utils";

/// Which edge of the pane the strip sits on. Dragging *away* from the pane
/// widens it, which is the opposite direction on each side.
type Edge = "left" | "right";

/// How far one arrow press moves the edge. Coarse enough to cross the range in
/// a few presses, since the keyboard cannot aim the way a pointer does; Home is
/// there for the default.
const STEP_PX = 16;

/// A pane the reader can drag wider, with its width remembered.
///
/// Returns the pane's own style and the strip to render; the pane needs
/// `relative`, since the strip is absolutely placed over its own border.
///
/// The width is `useState` read once rather than `useLocalStorage`: a drag
/// moves it on every frame and only the last one is a preference, so the write
/// lands at the end of the drag alone. `setPointerCapture` is what makes the
/// drag work past the pane's edge — without it the pointer leaves this element
/// on the first frame and every move after that is delivered to whatever is
/// beside it.
export function useResizable({
  storageKey,
  initial,
  min,
  max,
  edge,
  label,
}: {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  edge: Edge;
  label: string;
}): { style: CSSProperties; handle: ReactNode } {
  const [width, setWidth] = useState(() => readLocalStorage(storageKey, initial));
  const from = useRef<{ x: number; width: number } | null>(null);

  // The cap is read at the press rather than held: the window is resizable and
  // nothing here re-renders on that, so one captured at mount would answer for
  // the window the app launched in.
  const capped = (raw: number) => snapWidth(raw, min, paneCap(max, window.innerWidth), initial);

  const commit = (next: number) => {
    setWidth(next);
    writeLocalStorage(storageKey, next);
  };

  // Ends a drag however it stops — released, cancelled by the OS, or capture
  // lost. `pointerup` alone used to clear it, so a cancelled drag left the
  // press live and every later pointer move resized the pane with nothing held
  // down. The write lands here because only the last frame is a preference.
  const end = () => {
    if (!from.current) return;
    from.current = null;
    writeLocalStorage(storageKey, width);
  };

  // Arrows widen and narrow, Home resets: the pointer's three verbs, since a
  // separator nothing can focus leaves every pane here unresizable without a
  // mouse.
  const byKey = (key: string): number | null => {
    if (key === "Home") return initial;
    const step = key === "ArrowRight" ? STEP_PX : key === "ArrowLeft" ? -STEP_PX : null;
    return step === null ? null : capped(width + (edge === "right" ? step : -step));
  };

  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        // Without this the drag starts a text selection at the handle and
        // extends it across whatever the pointer crosses. Cancelling
        // pointerdown suppresses the mouse events selection rides on — the
        // same cure a session-row drag takes.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        const start = from.current;
        if (!start) return;
        const moved = edge === "right" ? e.clientX - start.x : start.x - e.clientX;
        setWidth(capped(start.width + moved));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        const next = byKey(e.key);
        if (next === null) return;
        e.preventDefault();
        commit(next);
      }}
      onDoubleClick={() => commit(initial)}
      className={cn(
        // No hover fill: the pane already draws a border here, and lighting a
        // second one beside it reads as the edge thickening. The cursor is the
        // affordance, and the focus ring is its keyboard twin.
        "absolute inset-y-0 z-10 w-1 cursor-col-resize focus-visible:bg-ring focus-visible:outline-none",
        edge === "right" ? "-right-0.5" : "-left-0.5",
      )}
    />
  );

  // `maxWidth` is the drag's own cap stated to CSS, and it is not a second
  // statement of it: a window resized narrower moves that bound with no drag to
  // re-run the clamp, and both panes are `shrink-0`, so without it their widths
  // come off the transcript between them until it is clipped to nothing.
  return { style: { width, maxWidth: `${MAX_SHARE * 100}vw` }, handle };
}
