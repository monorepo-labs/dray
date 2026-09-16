import { useRef, useState, type ReactNode } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { snapWidth } from "@/lib/resize";
import { cn } from "@/lib/utils";

/// Which edge of the pane the strip sits on. Dragging *away* from the pane
/// widens it, which is the opposite direction on each side.
type Edge = "left" | "right";

/// A pane the reader can drag wider, with its width remembered.
///
/// Returns the width to apply and the strip to render; the pane needs
/// `relative`, since the strip is absolutely placed over its own border.
///
/// The width is `useState` read once rather than `useLocalStorage`: a drag
/// moves it on every frame and only the last one is a preference, so the write
/// lands on pointerup alone. `setPointerCapture` is what makes the drag work
/// past the pane's edge — without it the pointer leaves this element on the
/// first frame and every move after that is delivered to whatever is beside it.
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
}): { width: number; handle: ReactNode } {
  const [width, setWidth] = useState(() => readLocalStorage(storageKey, initial));
  const from = useRef<{ x: number; width: number } | null>(null);

  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
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
        setWidth(snapWidth(start.width + moved, min, max, initial));
      }}
      onPointerUp={() => {
        if (!from.current) return;
        from.current = null;
        writeLocalStorage(storageKey, width);
      }}
      onDoubleClick={() => {
        setWidth(initial);
        writeLocalStorage(storageKey, initial);
      }}
      className={cn(
        // No hover fill: the pane already draws a border here, and lighting a
        // second one beside it reads as the edge thickening. The cursor is the
        // affordance.
        "absolute inset-y-0 z-10 w-1 cursor-col-resize",
        edge === "right" ? "-right-0.5" : "-left-0.5",
      )}
    />
  );

  return { width, handle };
}
