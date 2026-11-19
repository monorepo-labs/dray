/// How near the default a stored width or a key step has to land before it
/// sticks there, in pixels.
const SNAP_PX = 12;

/// How far a drag must pull from the default before the edge lets go of it.
export const DETENT = 40;
/// The most the edge stretches toward the pointer while the default holds it.
export const GIVE = 10;

/// What a width is for: at `rest` (stored, keyed), mid-`drag`, the `release`
/// that ends one, or a drag the detent has already let go of, which it does
/// once: from then on the edge `follow`s the pointer.
export type Pull = "rest" | "drag" | "release" | "follow";

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

/// Where a pane's edge lands: clamped to its range, and held at `snapTo` near
/// it — within `SNAP_PX` at rest, within `DETENT` for a drag.
///
/// The default width is the one value a reader is likely to want back, and
/// hitting it by eye is a pixel hunt — so a drag sticks there, stretching at
/// most `GIVE` toward the pointer until it pulls clear, and a release inside
/// the detent settles on it. The hold point is clamped too: on a window too
/// narrow to hold the default, it is not a width this pane can take and
/// snapping to it would breach the range.
///
/// With a `rail`, nothing between it and the floor is ever drawn: a width under
/// halfway lands on the rail, one above it holds at the floor. One line both
/// ways, as Finder's sidebar does. With the line at the floor itself, the first
/// pixel past the default dropped to the rail with no stop at the floor.
export function snapWidth(
  raw: number,
  min: number,
  max: number,
  snapTo: number,
  rail?: number,
  pull: Pull = "rest",
): number {
  if (rail !== undefined) {
    const r = Math.min(rail, max);
    if (raw < (r + min) / 2) return r;
  }
  const within = (n: number) => Math.max(min, Math.min(max, n));
  const clamped = within(raw);
  const target = within(snapTo);
  if (pull === "follow") return clamped;
  if (pull === "rest") return Math.abs(clamped - target) < SNAP_PX ? target : clamped;
  const off = raw - target;
  if (Math.abs(off) >= DETENT) return clamped;
  // tanh gives most of the stretch early and stiffens toward the break.
  return pull === "drag" ? within(Math.round(target + GIVE * Math.tanh((1.5 * off) / DETENT))) : target;
}

/// The snap's spring, critically damped: settles in about a quarter second. A
/// bouncier one was tried and read as jank.
const STIFFNESS = 520;
const DAMPING = 2 * Math.sqrt(STIFFNESS);
/// Fixed step, so the spring feels the same at 60Hz and 120Hz.
const STEP_S = 1 / 240;

/// One frame of the resize spring: `x` at speed `v` chasing `t`, which moves at
/// `vt` px/s, over `dt` seconds. Returns the new position and speed.
///
/// Damping works on the speed relative to the target's, so a chase closes on a
/// moving pointer instead of trailing it — which also means it carries the
/// pointer's speed when the pointer stops. So a step that reaches or crosses
/// the target lands on it and ends the frame there; one starting on it counts,
/// or the steps after a landing walk straight past.
export function springFrame(x: number, v: number, t: number, vt: number, dt: number): [number, number] {
  for (let left = dt; left > 0; left -= STEP_S) {
    const h = Math.min(STEP_S, left);
    const before = x - t;
    v += (-STIFFNESS * before - DAMPING * (v - vt)) * h;
    x += v * h;
    if (before === 0 ? x !== t : before * (x - t) <= 0) return [t, vt];
  }
  return [x, v];
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
