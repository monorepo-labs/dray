import type { PointerEvent as ReactPointerEvent } from "react";
import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import type { Region } from "@/lib/groups";

/// Marks a pane a sidebar row can be dropped on; the value is the session
/// the drop lands on.
export const DROP_ATTR = "data-drop-session";

export type DropTarget = { sessionId: string; region: Region };

export type SessionDrag = {
  sessionId: string;
  title: string;
  x: number;
  y: number;
  /// The pane under the pointer and where on it, read off `DROP_ATTR`.
  over: DropTarget | null;
};

/// Pointer-based, not HTML5 drag: Tauri's file-drop handler takes native drag
/// events before the webview sees them, and attachments depend on that
/// handler, so `dragover`/`drop` never fire for an internal drag.
let drag: SessionDrag | null = null;
const changed = channel<void>();

export function useSessionDrag(): SessionDrag | null {
  return useSyncExternalStore(changed.subscribe, () => drag);
}

/// How far the pointer moves before a press becomes a drag, so a click stays
/// a click.
const THRESHOLD_PX = 6;

/// How much of a pane's width or height, from each edge, is that edge's zone.
const EDGE = 0.25;

/// Which of the five zones a point in a box falls in. The nearer edge wins a
/// corner; the middle is the centre.
export function regionAt(x: number, y: number, width: number, height: number): Region {
  const fx = x / width;
  const fy = y / height;
  const dx = Math.min(fx, 1 - fx);
  const dy = Math.min(fy, 1 - fy);
  if (dx >= EDGE && dy >= EDGE) return "center";
  if (dx < dy) return fx < 0.5 ? "left" : "right";
  return fy < 0.5 ? "top" : "bottom";
}

function targetAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest(`[${DROP_ATTR}]`);
  const sessionId = el?.getAttribute(DROP_ATTR);
  if (!el || !sessionId) return null;
  const rect = el.getBoundingClientRect();
  return { sessionId, region: regionAt(x - rect.left, y - rect.top, rect.width, rect.height) };
}

/// Wires a row's `onPointerDown`. `onDrop` fires on release over a pane other
/// than the row's own session.
export function startSessionDrag(
  e: ReactPointerEvent<HTMLElement>,
  sessionId: string,
  title: string,
  onDrop: (target: DropTarget, dropped: string) => void,
) {
  if (e.button !== 0) return;
  // A press that becomes a drag would otherwise start a text selection at the
  // row and extend it across whatever the pointer crosses. Cancelling
  // pointerdown suppresses the mouse events that selection rides on; click
  // still fires.
  e.preventDefault();
  const el = e.currentTarget;
  const { pointerId, clientX: startX, clientY: startY } = e;
  let live = false;

  const move = (ev: PointerEvent) => {
    if (!live) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD_PX) return;
      live = true;
      el.setPointerCapture(pointerId);
    }
    drag = { sessionId, title, x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY) };
    changed.emit();
  };

  const end = (ev: PointerEvent) => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    if (!live) return;

    el.releasePointerCapture(pointerId);
    // The click that follows a captured pointerup would select the row that
    // was dragged. Swallowed at capture, and the listener retired on the next
    // task so a later real click is not eaten.
    const swallow = (c: Event) => c.stopPropagation();
    el.addEventListener("click", swallow, { capture: true });
    setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 0);

    const over = ev.type === "pointerup" ? targetAt(ev.clientX, ev.clientY) : null;
    drag = null;
    changed.emit();
    if (over && over.sessionId !== sessionId) onDrop(over, sessionId);
  };

  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
