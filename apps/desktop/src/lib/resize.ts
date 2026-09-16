/// How near the default a drag has to land before it sticks there, in pixels.
///
/// Wide enough to be felt, narrow enough that a reader aiming somewhere else
/// never fights it — past this the width follows the pointer again, since the
/// drag's own origin never moves.
const SNAP_PX = 12;

/// Where a pane's edge lands: clamped to its range, and held at `snapTo` while
/// the drag is within `SNAP_PX` of it.
///
/// The default width is the one value a reader is likely to want back, and
/// hitting it by eye is a pixel hunt — so the drag stops there on its own.
export function snapWidth(raw: number, min: number, max: number, snapTo: number): number {
  const clamped = Math.max(min, Math.min(max, raw));
  return Math.abs(clamped - snapTo) < SNAP_PX ? snapTo : clamped;
}
