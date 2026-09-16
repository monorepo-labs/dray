/// How near the default a drag has to land before it sticks there, in pixels.
///
/// Wide enough to be felt, narrow enough that a reader aiming somewhere else
/// never fights it — past this the width follows the pointer again, since the
/// drag's own origin never moves.
const SNAP_PX = 12;

/// The range a pane can actually occupy right now — the one bounds the clamp,
/// the keys and the ARIA values all read.
///
/// One rule: a pane may take everything except what the chat column keeps and
/// what the other side panes are already holding. A share of the window sat
/// beside this for a while and every number it held was wrong somewhere — a
/// proportion cannot see the sidebar, so the same percentage left the
/// conversation a comfortable width in one state and a sliver in the other.
/// `floor` says what "good enough" is in the only units that mean it.
///
/// The pane's own floor gives way to that ceiling rather than outranking it: on
/// a window with no room for both, a minimum that won wrote a width wider than
/// the pane was drawn, so the value handed to assistive technology described a
/// panel nobody could see.
export function paneBounds(
  min: number,
  viewport: number,
  taken = 0,
  floor = 0,
): { min: number; max: number } {
  const cap = Math.max(0, viewport - taken - floor);
  return { min: Math.min(min, cap), max: cap };
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

/// Width the panes ahead of `self` are holding — what it cannot have.
///
/// `order` is a precedence, and that is the whole reason the bounds settle.
/// Read symmetrically — each pane taking every other's width off its own
/// ceiling — a pair too wide for the window never converges: each clamps
/// against the other's old width, republishes, and frees the other to grow
/// back. A pane yields to those ahead of it and to none behind, which makes the
/// dependency an order rather than a loop. A pane not in `order` at all yields
/// to every one of them, since it sits inside the column they have bounded.
export function takenBy<P extends string>(
  widths: Partial<Record<P, number>>,
  order: readonly P[],
  self?: P,
): number {
  const ahead = self ? order.slice(0, order.indexOf(self)) : order;
  return ahead.reduce((total, key) => total + (widths[key] ?? 0), 0);
}
