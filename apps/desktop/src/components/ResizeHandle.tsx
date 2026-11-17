import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { GIVE, paneBounds, snapWidth, takenBy, type Pull } from "@/lib/resize";
import { cn } from "@/lib/utils";

/// Which edge of the pane the strip sits on. Dragging *away* from the pane
/// widens it, which is the opposite direction on each side.
type Edge = "left" | "right";

/// How far one arrow press moves the edge. Coarse enough to cross the range in
/// a few presses, since the keyboard cannot aim the way a pointer does; Home is
/// there for the default.
const STEP_PX = 16;

/// The snap's spring, critically damped: settles in about a quarter second and
/// never passes its target. A bouncier one was tried and read as jank.
const STIFFNESS = 520;
const DAMPING = 2 * Math.sqrt(STIFFNESS);
/// Fixed step, so the spring feels the same at 60Hz and 120Hz.
const STEP_S = 1 / 240;
/// A target moving further than this in a frame jumped rather than moved, and
/// is chased from rest rather than matched.
const JUMP_PX = 24;

/// A snap while its spring runs: onto or off the rail, or into or out of the
/// default's detent.
export type RailSnap = "toRail" | "fromRail" | "detent" | null;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

/// What a side pane is drawn at right now, 0 while it is not on screen.
export function usePaneWidth(pane: Pane): number {
  return useSyncExternalStore(layoutChanged.subscribe, () => widths[pane] ?? 0);
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
  rail,
  widen = false,
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
  /// A width below the floor the pane snaps to, its icon-only form.
  rail?: number;
  /// Drawn at `initial` while on the rail, without touching what is stored —
  /// for a moment that needs the full pane, like the sidebar's search field.
  widen?: boolean;
}): { style: CSSProperties; handle: ReactNode; width: number; held: number; snap: RailSnap } {
  const read = () => readLocalStorage(storageKey, initial);
  const [stored, setStored] = useState(read);
  // The key moves under a mounted pane — the right panel follows the selected
  // session without remounting — so the width is re-read during render, or the
  // new session draws one frame at the old one's width.
  const [readFor, setReadFor] = useState(storageKey);
  if (readFor !== storageKey) {
    setReadFor(storageKey);
    setStored(read());
  }
  // `raw` is the pointer's last width, kept here as well as in state: a release
  // landing in the same frame as a move must not read the width before it.
  const from = useRef<{ x: number; width: number; raw?: number } | null>(null);
  // A drag, and whether the default's detent has let go of it yet.
  const [drag, setDrag] = useState<"pull" | "free" | null>(null);

  // One range for everything here, so what is drawn, what the keys move and
  // what assistive technology is told can never disagree. A CSS `max-width`
  // beside this was the alternative and it is the very split it would recreate:
  // CSS drew the pane at its share while the clamp here still answered its own
  // minimum.
  const columnFloor = useChatFloor();
  const bounds = paneBounds(min, useViewportWidth(), useSeniorPanes(pane), floor ?? columnFloor);
  const clamp = useCallback(
    (raw: number, pull?: Pull) => snapWidth(raw, bounds.min, bounds.max, initial, rail, pull),
    [bounds.min, bounds.max, initial, rail],
  );

  // Narrowing the window narrows the pane; widening it back restores what the
  // reader asked for, which is why the stored width is left alone. Mid-drag
  // `stored` is the pointer's own width, unclamped, so the detent can read how
  // hard it is being pulled.
  const held = clamp(stored, drag === "pull" ? "drag" : drag === "free" ? "follow" : "rest");
  const width = widen && held === rail ? clamp(initial) : held;

  // Every jump the pointer did not make — onto or off the rail, into or out of
  // the detent, a release settling — springs; a drag in open range follows the
  // pointer with no lag. Decided during render so the frame that changes the
  // width is the frame the spring starts from.
  const def = clamp(initial);
  const zone = (w: number) => (w === rail ? "rail" : Math.abs(w - def) <= GIVE ? "detent" : "free");
  const [last, setLast] = useState(width);
  const [spring, setSpring] = useState<{ id: number; from: number; snap: RailSnap } | null>(null);
  const [drawn, setDrawn] = useState(width);
  if (last !== width) {
    setLast(width);
    const [a, b] = [zone(last), zone(width)];
    const snap: RailSnap = b === "rail" ? "toRail" : a === "rail" ? "fromRail" : "detent";
    const letGo = a === "detent" && b === "free";
    if (letGo && drag === "pull") setDrag("free");
    if (reducedMotion()) {
      // Drawn as stored, no spring.
    } else if (spring) {
      if (a !== b && (a === "rail" || b === "rail")) setSpring({ ...spring, snap });
    } else if (a !== b || (a === "detent" && !drag)) {
      // The stretch inside the detent follows the pointer; only a jump springs.
      setSpring({ id: Date.now(), from: last, snap });
      setDrawn(last);
    }
  }
  const target = useRef(width);
  useEffect(() => {
    target.current = width;
  });
  useEffect(() => {
    if (!spring) return;
    let x = spring.from;
    let v = 0;
    let prev = performance.now();
    let chased = target.current;
    let frame = requestAnimationFrame(function step(now) {
      const dt = Math.min((now - prev) / 1000, 1 / 30);
      prev = now;
      // Damping works on the speed relative to the target's own, so a spring
      // chasing a moving pointer closes on it instead of trailing it.
      const t = target.current;
      const vt = Math.abs(t - chased) > JUMP_PX || !dt ? 0 : (t - chased) / dt;
      chased = t;
      for (let left = dt; left > 0; left -= STEP_S) {
        const h = Math.min(STEP_S, left);
        v += (-STIFFNESS * (x - t) - DAMPING * (v - vt)) * h;
        x += v * h;
      }
      // Ends only once it has caught the target, so handing back to the pointer
      // never jumps.
      if (Math.abs(x - t) < (vt ? 3 : 1.5) && Math.abs(v - vt) < 100) return setSpring(null);
      setDrawn(x);
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
    // The spring chases `target`; only a new spring restarts it.
  }, [spring?.id]);
  const shown = spring ? Math.round(drawn) : width;

  // Published on every change and cleared on unmount, which is what a collapsed
  // sidebar is — it returns null. The drawn width, so chrome placed against the
  // pane's edge moves with the spring — before paint, or the titlebar's tabs
  // draw a frame behind the pane they line up with.
  useLayoutEffect(() => {
    if (!pane) return;
    widths[pane] = shown;
    layoutChanged.emit();
    return () => {
      delete widths[pane];
      layoutChanged.emit();
    };
  }, [pane, shown]);

  const commit = (next: number) => {
    setStored(next);
    writeLocalStorage(storageKey, next);
  };

  // Ends a drag however it stops — released, cancelled by the OS, or capture
  // lost. `pointerup` alone used to clear it, so a cancelled drag left the
  // press live and every later pointer move resized the pane with nothing held
  // down. The write lands here because only the last frame is a preference.
  const end = () => {
    const start = from.current;
    if (!start) return;
    from.current = null;
    // A press with no move is not a drag, and must not pull a saved width in.
    if (start.raw === undefined) return;
    setDrag(null);
    const next = clamp(start.raw, drag === "free" ? "rest" : "release");
    setStored(next);
    writeLocalStorage(storageKey, next);
  };

  // Arrows widen and narrow, Home resets: the pointer's three verbs, since a
  // separator nothing can focus leaves every pane here unresizable without a
  // mouse.
  const byKey = (key: string): number | null => {
    if (key === "Home") return clamp(initial);
    const step = key === "ArrowRight" ? STEP_PX : key === "ArrowLeft" ? -STEP_PX : null;
    if (step === null) return null;
    const delta = edge === "right" ? step : -step;
    // One press either way between the floor and the rail: a 16px step never
    // crosses the halfway line the pointer snaps on.
    if (rail !== undefined && width === rail) return delta > 0 ? clamp(bounds.min) : rail;
    if (rail !== undefined && width === bounds.min && delta < 0) return clamp(rail);
    return clamp(width + delta);
  };

  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={rail ?? bounds.min}
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
        // Out of the rail stops at the default for the rest of the drag:
        // going wider is a second drag, through the detent.
        start.raw = start.width === rail ? Math.min(start.width + moved, def) : start.width + moved;
        setStored(start.raw);
        setDrag((d) => d ?? "pull");
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

  return { style: { width: shown }, handle, width, held, snap: spring?.snap ?? null };
}
