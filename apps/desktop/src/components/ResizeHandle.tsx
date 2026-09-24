import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { paneBounds, snapWidth, takenBy } from "@/lib/resize";
import { cn } from "@/lib/utils";

/// Which edge of the pane the strip sits on. Dragging *away* from the pane
/// widens it, which is the opposite direction on each side.
type Edge = "left" | "right";

/// How far one arrow press moves the edge. Coarse enough to cross the range in
/// a few presses, since the keyboard cannot aim the way a pointer does; Home is
/// there for the default.
const STEP_PX = 16;

const subscribeToResize = (fn: () => void) => {
  window.addEventListener("resize", fn);
  return () => window.removeEventListener("resize", fn);
};

/// The window's width, as state. A pane's bounds are a share of it, so the
/// clamp, the keys and the ARIA values all go stale the moment the window is
/// resized — and the reader resizing the window is exactly when a pane has to
/// give ground.
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeToResize, () => window.innerWidth);
}

/// The panes that sit either side of the chat column, each holding width no
/// other pane can have.
type Pane = "sidebar" | "panel";

/// Who yields to whom — see `takenBy`, which is where that matters.
///
/// The sidebar leads because it is a list at a width the reader sets once,
/// where the panel is the one dragged about. The chat's floor is still
/// guaranteed either way: the sidebar may take everything but that floor, and
/// the panel everything the sidebar left over it, so what remains is exactly
/// the floor.
const ORDER: readonly Pane[] = ["sidebar", "panel"];

/// The narrowest the chat column may be squeezed to, whatever the share works
/// out at. The share alone is a proportion, so on a small window it still hands
/// the conversation something unreadable; this is the absolute floor under it.
export const CHAT_MIN = 360;

/// What each side pane is holding, and how much the chat column must keep.
///
/// Published by the panes themselves rather than measured off the DOM: each is
/// the one place that already knows its number, and a pane *unmounting* — which
/// is what a collapsed sidebar is — is the state a query selector cannot tell
/// from one that has not mounted yet. Module-level because the readers are
/// siblings with nothing above them to hang it on but `App`, which would then
/// thread it through components that have no other use for it.
const widths: Partial<Record<Pane, number>> = {};
let chatFloor = CHAT_MIN;
const layoutChanged = channel<void>();

function useSeniorPanes(self: Pane | undefined): number {
  return useSyncExternalStore(layoutChanged.subscribe, () => takenBy(widths, ORDER, self));
}

function useChatFloor(): number {
  return useSyncExternalStore(layoutChanged.subscribe, () => chatFloor);
}

/// Called by `App` with whether the chat column is showing one conversation,
/// and what else is sharing that column's width.
///
/// Split view is the exception to the first: its panes are deliberately small,
/// so a floor written for a single transcript would refuse a layout the reader
/// asked for outright. `beside` is the crew, which is fixed-width and refuses
/// to shrink — so without it the sidebar and the panel could be dragged until
/// the transcript was a sliver with the floor still reporting itself honoured.
export function useChatColumnFloor(single: boolean, beside = 0) {
  useEffect(() => {
    chatFloor = (single ? CHAT_MIN : 0) + beside;
    layoutChanged.emit();
    return () => {
      chatFloor = CHAT_MIN;
      layoutChanged.emit();
    };
  }, [single, beside]);
}

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
  edge,
  label,
  pane,
  floor,
}: {
  storageKey: string;
  initial: number;
  min: number;
  edge: Edge;
  label: string;
  /// What the pane's sibling keeps, where that sibling is not the chat column.
  /// The chat floor is lifted for a split — its panes are deliberately small —
  /// and a pane on another row must not inherit that lifting, since nothing
  /// about a split makes *its* neighbour safe to squeeze to nothing.
  floor?: number;
  /// Set on the two panes flanking the chat column, so each publishes what it
  /// is holding and every other one can take it off the width it is bidding
  /// for. Absent for a pane on some other row — the files list, whose siblings
  /// are inside the chat column rather than beside it.
  pane?: Pane;
}): { style: CSSProperties; handle: ReactNode } {
  const [stored, setStored] = useState(() => readLocalStorage(storageKey, initial));
  const from = useRef<{ x: number; width: number } | null>(null);

  // One range for everything here, so what is drawn, what the keys move and
  // what assistive technology is told can never disagree. A CSS `max-width`
  // beside this was the alternative and it is the very split it would recreate:
  // CSS drew the pane at its share while the clamp here still answered its own
  // minimum.
  const columnFloor = useChatFloor();
  const bounds = paneBounds(min, useViewportWidth(), useSeniorPanes(pane), floor ?? columnFloor);
  const clamp = useCallback(
    (raw: number) => snapWidth(raw, bounds.min, bounds.max, initial),
    [bounds.min, bounds.max, initial],
  );

  // Narrowing the window narrows the pane; widening it back restores what the
  // reader asked for, which is why the stored width is left alone.
  const width = clamp(stored);

  // Published on every change and cleared on unmount, which is what a collapsed
  // sidebar is — it returns null rather than rendering a rail.
  useEffect(() => {
    if (!pane) return;
    widths[pane] = width;
    layoutChanged.emit();
    return () => {
      delete widths[pane];
      layoutChanged.emit();
    };
  }, [pane, width]);

  const commit = (next: number) => {
    setStored(next);
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
    if (key === "Home") return clamp(initial);
    const step = key === "ArrowRight" ? STEP_PX : key === "ArrowLeft" ? -STEP_PX : null;
    return step === null ? null : clamp(width + (edge === "right" ? step : -step));
  };

  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
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
        setStored(clamp(start.width + moved));
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
      onDoubleClick={() => commit(clamp(initial))}
      className={cn(
        // No hover fill: the pane already draws a border here, and lighting a
        // second one beside it reads as the edge thickening. The cursor is the
        // affordance, and the focus ring is its keyboard twin.
        "absolute inset-y-0 z-10 w-1 cursor-col-resize focus-visible:bg-ring focus-visible:outline-none",
        edge === "right" ? "-right-0.5" : "-left-0.5",
      )}
    />
  );

  return { style: { width }, handle };
}
