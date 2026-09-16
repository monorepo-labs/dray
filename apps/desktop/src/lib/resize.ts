/// How near the default a drag has to land before it sticks there, in pixels.
///
/// Wide enough to be felt, narrow enough that a reader aiming somewhere else
/// never fights it — past this the width follows the pointer again, since the
/// drag's own origin never moves.
const SNAP_PX = 12;

/// The most of the window a single pane may take.
///
/// Both panes are `shrink-0`, so their widths come off the conversation between
/// them rather than off each other: at their px maxima alone they sum to more
/// than the default window and nearly twice the minimum one, which squeezes the
/// transcript to nothing and clips it. A share of the window is what the px cap
/// cannot say, since the window is resizable and the cap is not.
export const MAX_SHARE = 0.4;

/// The widest a pane may actually be drawn: its own maximum, or its share of
/// this window, whichever is less.
export function paneCap(max: number, viewport: number): number {
  return Math.min(max, Math.round(viewport * MAX_SHARE));
}

/// Where a pane's edge lands: clamped to its range, and held at `snapTo` while
/// the drag is within `SNAP_PX` of it.
///
/// The default width is the one value a reader is likely to want back, and
/// hitting it by eye is a pixel hunt — so the drag stops there on its own. The
/// hold point is clamped too: on a window too narrow to hold the default, it is
/// not a width this pane can take and snapping to it would breach the range.
export function snapWidth(raw: number, min: number, max: number, snapTo: number): number {
  const clamped = Math.max(min, Math.min(max, raw));
  const target = Math.max(min, Math.min(max, snapTo));
  return Math.abs(clamped - target) < SNAP_PX ? target : clamped;
}
