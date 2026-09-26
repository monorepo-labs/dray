import { useRef, useState } from "react";

/// Pointer travel before a press becomes a drag, so a click on a tab or row
/// draws no drag state for the frame between press and release.
const DEAD_ZONE = 4;

/// Drag-to-reorder for one list: the Spaces settings rows, and the browser and
/// Files tab strips. The item follows the pointer and the ones it passes slide
/// aside by transform, so nothing re-lays out mid-drag and the drop point is
/// judged against where items sat when the drag began. One move is written on
/// release, however far the item travelled.
///
/// Pointer events rather than HTML drag: Tauri takes the native drag for file
/// drops, so `dragstart` never reaches the page.
///
/// The list's first `items.length` children must be the items, in order —
/// anything after them (a tab strip's + button) is ignored.
export function useDragReorder<T>(
  items: readonly T[],
  /// What a release compares, to tell whether the list moved under the drag.
  /// Keys, not identity: a tab's title landing mid-drag rebuilds the array
  /// without changing the order.
  keyOf: (item: T) => string | number,
  /// `to` is the item's new index, for a store that takes a place over a step.
  onMove: (item: T, delta: number, to: number) => Promise<unknown> | void,
  axis: "x" | "y" = "y",
) {
  // The order after a drop, held until the write answers so the items do not
  // snap back for the frame it takes.
  const [order, setOrder] = useState<readonly T[] | null>(null);
  // `from` and `to` index `shown`; `d` is how far the pointer has travelled
  // and `step` how far an item moves to make room.
  const [drag, setDrag] = useState<{ from: number; to: number; d: number; step: number } | null>(
    null,
  );
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(items);
  latest.current = items;
  // Set synchronously for as long as a move is being written.
  const pending = useRef(false);
  const shown = order ?? items;

  const start = (e: React.PointerEvent<HTMLElement>, from: number) => {
    // Not while the last drop is still being written: the move is a relative
    // delta, so one measured against an unconfirmed order lands wrong if that
    // write fails.
    if (e.button !== 0 || !list.current || pending.current) return;
    // The item's own controls and fields answer their own presses.
    if ((e.target as Element).closest("button:not([data-grip]), input")) return;
    // Keeps the press from starting a text selection across the items.
    e.preventDefault();
    const el = e.currentTarget;
    const lo = axis === "x" ? "left" : "top";
    const hi = axis === "x" ? "right" : "bottom";
    const at = (ev: { clientX: number; clientY: number }) =>
      axis === "x" ? ev.clientX : ev.clientY;
    const origin = at(e);
    const before = shown.map(keyOf).join("\n");
    const rects = [...list.current.children]
      .slice(0, shown.length)
      .map((child) => child.getBoundingClientRect());
    const gap = rects.length > 1 ? rects[1][lo] - rects[0][hi] : 0;
    const step = rects[from][hi] - rects[from][lo] + gap;
    const mids = rects.map((r) => (r[lo] + r[hi]) / 2);
    // Held inside the list, so the item cannot be dragged off into nothing.
    const min = rects[0][lo] - rects[from][lo];
    const max = rects[rects.length - 1][hi] - rects[from][hi];
    let to = from;
    let moved = false;
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const raw = at(ev) - origin;
      if (!moved && Math.abs(raw) < DEAD_ZONE) return;
      if (!moved) document.body.classList.add("session-drag");
      moved = true;
      const d = Math.min(max, Math.max(min, raw));
      // The leading edge crossing a neighbour's middle is past the neighbour.
      // Judged on the edge rather than the item's own middle, which the clamp
      // stops exactly on the end items' middles and so could never pass them.
      const lead = rects[from][lo] + d;
      const trail = rects[from][hi] + d;
      to = from;
      while (to < mids.length - 1 && trail > mids[to + 1]) to++;
      while (to > 0 && lead < mids[to - 1]) to--;
      setDrag({ from, to, d, step });
    };

    const end = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.classList.remove("session-drag");
      setDrag(null);
      // A cancelled gesture (focus lost, the OS taking the pointer) is not a
      // drop, and a list that changed mid-drag no longer matches the indexes.
      if (!moved || ev.type !== "pointerup") return;
      if (latest.current.map(keyOf).join("\n") !== before) return;
      commit(from, to);
    };

    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  /// Draws the move at once and writes it. Both the drag and the keyboard come
  /// through here, so neither can start one while another is unconfirmed.
  const commit = (from: number, to: number) => {
    // A ref, not `order`: a drag's release runs the closure from its press,
    // which may predate a keyboard move made while it was held.
    const items = latest.current;
    if (pending.current || to === from || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    pending.current = true;
    setOrder(next);
    void Promise.resolve(onMove(items[from], to - from, to))
      .catch(() => undefined)
      .finally(() => {
        pending.current = false;
        setOrder(null);
      });
  };

  /// The transform an item draws at, mid-drag.
  const offset = (i: number) => {
    let d = 0;
    if (drag && i === drag.from) d = drag.d;
    else if (drag && drag.from < drag.to && i > drag.from && i <= drag.to) d = -drag.step;
    else if (drag && drag.to < drag.from && i >= drag.to && i < drag.from) d = drag.step;
    return `translate${axis === "x" ? "X" : "Y"}(${d}px)`;
  };

  return { list, shown, drag, start, commit, offset };
}
