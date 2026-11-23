//! One bot's news drawn as the Mac's #1279 draws it: the bot's face in a
//! black disc joined to the pill. Above the dock the disc eases out of the
//! pill's left end, joined by a metaball waist (`FluidPill`); at the top the
//! pill's bottom is flat, so the disc drops from its middle, held by two
//! fillets (`DropNotch`). GPUI has no path union, so the parts are filled
//! one over another in the same black, and an edge lit for news is each
//! part's outline drawn first and covered where the parts overlap.

use gpui::{Bounds, Hsla, PathBuilder, Pixels, Point, Window, fill, point, px, quad};
use std::f32::consts::PI;
use std::time::Duration;

/// The disc's radius, the pill's end's.
pub const RADIUS: f32 = 20.;
/// The gap the waist spans between disc and pill above the dock.
const WAIST: f32 = 4.;
/// Room left of the pill above the dock for the disc.
pub const SLOT: f32 = 2. * RADIUS + WAIST;
/// How far the disc hangs below a top pill, with its gap.
const DROP_GAP: f32 = 4.;
pub const DROP: f32 = 2. * RADIUS + DROP_GAP;
const FILLET: f32 = 14.;
/// The wait before the disc eases out, as on the Mac.
const DELAY: f32 = 0.12;
/// Past this the spring has settled to within a pixel.
pub const SETTLED: Duration = Duration::from_millis(1000);

/// How far out the disc is `t` seconds after the pill showed: SwiftUI's
/// `.spring(duration: 0.55, bounce: 0.3)`, a damping ratio of 0.7 at a
/// period of 0.55s, after the Mac's 120ms wait.
pub fn emerge(t: f32) -> f32 {
    let t = t - DELAY;
    if t <= 0. {
        return 0.;
    }
    let zeta = 0.7_f32;
    let w0 = 2. * PI / 0.55;
    let wd = w0 * (1. - zeta * zeta).sqrt();
    1. - (-zeta * w0 * t).exp() * ((wd * t).cos() + zeta * w0 / wd * (wd * t).sin())
}

/// The disc's centre and radius above the dock, level with the pill's first
/// row so a pill grown taller keeps it at its top. `rect` is the pill and its slot.
pub fn side_disc(rect: Bounds<Pixels>, emerge: f32) -> (Point<f32>, f32) {
    let (x, y, h) = (rect.origin.x.as_f32(), rect.origin.y.as_f32(), rect.size.height.as_f32());
    let r = RADIUS.min(h / 2.);
    let end = x + SLOT + r;
    let rest = x + SLOT - WAIST - r;
    (Point { x: end + (rest - end) * emerge, y: y + r }, r)
}

/// The disc's centre and radius at the top: sunk in the pill at 0, hanging
/// below its flat bottom at 1. `rect` is the pill.
pub fn drop_disc(rect: Bounds<Pixels>, emerge: f32) -> (Point<f32>, f32) {
    let r = RADIUS;
    let gap = -2. * r + (2. * r + DROP_GAP) * emerge;
    let mid = rect.origin.x.as_f32() + rect.size.width.as_f32() / 2.;
    (Point { x: mid, y: (rect.origin.y + rect.size.height).as_f32() + gap + r }, r)
}

/// The desktop's own "reduce motion": GNOME's animations switch, which
/// most desktops honour, or Windows' animation effects. Read when a disc
/// shows; no answer means animate.
pub fn still() -> bool {
    #[cfg(windows)]
    return crate::sys::animations_off();
    #[cfg(not(windows))]
    std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "enable-animations"])
        .output()
        .is_ok_and(|out| out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "false")
}

fn at(p: Point<f32>) -> Point<Pixels> {
    point(px(p.x), px(p.y))
}

fn circle(window: &mut Window, c: Point<f32>, r: f32, color: Hsla) {
    let b = Bounds { origin: point(px(c.x - r), px(c.y - r)), size: gpui::size(px(2. * r), px(2. * r)) };
    window.paint_quad(fill(b, color).corner_radii(px(r)));
}

/// One cubic's outline: start, two controls, end.
fn stroke_cubic(window: &mut Window, c: &[Point<f32>; 4], color: Hsla) {
    let mut path = PathBuilder::stroke(px(2.));
    path.move_to(at(c[0]));
    path.cubic_bezier_to(at(c[3]), at(c[1]), at(c[2]));
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

fn polyline(window: &mut Window, points: &[Point<f32>], color: Hsla) {
    let mut path = PathBuilder::stroke(px(2.));
    path.add_polygon(&points.iter().copied().map(at).collect::<Vec<_>>(), false);
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// The pill with its disc eased out of its left end. `rect` is the pill and
/// its slot; `edge` lights the outline for news.
pub fn paint_side(window: &mut Window, rect: Bounds<Pixels>, emerge: f32, edge: Option<Hsla>) {
    let black = gpui::hsla(0., 0., 0., 1.);
    let pill = Bounds { origin: point(rect.origin.x + px(SLOT), rect.origin.y), size: gpui::size(rect.size.width - px(SLOT), rect.size.height) };
    let corner = px(RADIUS.min(rect.size.height.as_f32() / 2.));
    let (c, r) = side_disc(rect, emerge);
    let neck = neck(r, c, Point { x: pill.origin.x.as_f32() + r, y: c.y });
    if let Some(edge) = edge {
        let grown = Bounds { origin: pill.origin - point(px(1.), px(1.)), size: pill.size + gpui::size(px(2.), px(2.)) };
        window.paint_quad(quad(grown, corner + px(1.), edge, px(0.), edge, Default::default()));
        circle(window, c, r + 1., edge);
        if let Some(n) = &neck {
            stroke_cubic(window, &n.top, edge);
            stroke_cubic(window, &n.bottom, edge);
        }
    }
    window.paint_quad(fill(pill, black).corner_radii(corner));
    circle(window, c, r, black);
    if let Some(n) = neck {
        let mut path = PathBuilder::fill();
        path.move_to(at(n.top[0]));
        path.cubic_bezier_to(at(n.top[3]), at(n.top[1]), at(n.top[2]));
        path.line_to(at(n.c2));
        path.line_to(at(n.bottom[3]));
        path.cubic_bezier_to(at(n.bottom[0]), at(n.bottom[2]), at(n.bottom[1]));
        path.line_to(at(c));
        path.close();
        if let Ok(path) = path.build() {
            window.paint_path(path, black);
        }
    }
}

/// The disc dropped from the middle of a top pill's flat bottom, and the
/// fillets holding it. `rect` is the pill, which draws itself.
pub fn paint_drop(window: &mut Window, rect: Bounds<Pixels>, emerge: f32, edge: Option<Hsla>) {
    let black = gpui::hsla(0., 0., 0., 1.);
    let (c, r) = drop_disc(rect, emerge);
    let (f, bottom) = (FILLET, (rect.origin.y + rect.size.height).as_f32());
    // Each fillet's centre sits `f` below the edge and `r + f` from the disc's.
    let dx = ((r + f).powi(2) - (c.y - bottom - f).powi(2)).max(0.).sqrt();
    let fillet = |side: f32| -> Vec<Point<f32>> {
        let fc = Point { x: c.x + side * dx, y: bottom + f };
        let tangent = Point { x: c.x + (fc.x - c.x) * r / (r + f), y: c.y + (fc.y - c.y) * r / (r + f) };
        let from = -PI / 2.;
        let mut sweep = (tangent.y - fc.y).atan2(tangent.x - fc.x) - from;
        if sweep > PI {
            sweep -= 2. * PI;
        } else if sweep < -PI {
            sweep += 2. * PI;
        }
        (0..=16).map(|i| {
            let a = from + sweep * i as f32 / 16.;
            Point { x: fc.x + f * a.cos(), y: fc.y + f * a.sin() }
        })
        .collect()
    };
    let (left, right) = (fillet(-1.), fillet(1.));
    if let Some(edge) = edge {
        circle(window, c, r + 1., edge);
        polyline(window, &left, edge);
        polyline(window, &right, edge);
    }
    circle(window, c, r, black);
    // Starts inside the pill, so the join leaves no seam along its edge.
    let mut points = vec![Point { x: c.x - dx, y: bottom - 2. }];
    points.extend(&left);
    points.push(c);
    points.extend(right.iter().rev());
    points.push(Point { x: c.x + dx, y: bottom - 2. });
    let mut path = PathBuilder::fill();
    path.add_polygon(&points.into_iter().map(at).collect::<Vec<_>>(), true);
    if let Ok(path) = path.build() {
        window.paint_path(path, black);
    }
}

/// The bridge between two circles of radius `r`: each curve as its start,
/// two controls and end.
struct Neck {
    top: [Point<f32>; 4],
    bottom: [Point<f32>; 4],
    c2: Point<f32>,
}

/// The metaball construction: tangent points spread by `v`, joined by cubics,
/// as the Mac's `FluidPill.neck`.
fn neck(r: f32, c1: Point<f32>, c2: Point<f32>) -> Option<Neck> {
    let (v, handle) = (0.55_f32, 2.4_f32);
    let d = (c2.x - c1.x).hypot(c2.y - c1.y);
    if d <= 0.5 || d >= r * 3.5 {
        return None;
    }
    // Equal radii: both overlaps are one angle, and the widest spread is a right angle.
    let u = if d < 2. * r { (d / (2. * r)).acos() } else { 0. };
    let spread = PI / 2.;
    let a0 = (c2.y - c1.y).atan2(c2.x - c1.x);
    let a1 = a0 + u + (spread - u) * v;
    let a2 = a0 - u - (spread - u) * v;
    let a3 = a0 + PI - u - (PI - u - spread) * v;
    let a4 = a0 - PI + u + (PI - u - spread) * v;
    let at = |c: Point<f32>, a: f32, l: f32| Point { x: c.x + l * a.cos(), y: c.y + l * a.sin() };
    let (p1, p2, p3, p4) = (at(c1, a1, r), at(c1, a2, r), at(c2, a3, r), at(c2, a4, r));
    let k = (v * handle).min((p1.x - p3.x).hypot(p1.y - p3.y) / (2. * r)) * (d / r).min(1.);
    Some(Neck {
        top: [p1, at(p1, a1 - PI / 2., r * k), at(p3, a3 + PI / 2., r * k), p3],
        // Drawn from p2 to p4, so the outline strokes it in one piece.
        bottom: [p2, at(p2, a2 + PI / 2., r * k), at(p4, a4 - PI / 2., r * k), p4],
        c2,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spring_waits_then_settles_past_one() {
        assert_eq!(emerge(0.1), 0.);
        let peak = (0..100).map(|i| emerge(i as f32 * 0.01)).fold(0., f32::max);
        // Bounce 0.3 overshoots a little, as the Mac's does.
        assert!(peak > 1.01 && peak < 1.1, "{peak}");
        assert!((emerge(SETTLED.as_secs_f32()) - 1.).abs() < 0.01);
    }

    #[test]
    fn the_disc_starts_in_the_pills_end_and_ends_in_its_slot() {
        let rect = Bounds { origin: point(px(0.), px(0.)), size: gpui::size(px(200.), px(40.)) };
        let (sunk, r) = side_disc(rect, 0.);
        assert_eq!((sunk.x, sunk.y, r), (SLOT + 20., 20., 20.));
        let (out, _) = side_disc(rect, 1.);
        assert_eq!(out.x, 20.);
        // Out, it sits a waist's width clear of the pill.
        assert_eq!(SLOT - (out.x + r), WAIST);
        let (dropped, _) = drop_disc(rect, 1.);
        assert_eq!(dropped.y, 40. + DROP_GAP + 20.);
    }

    #[test]
    fn a_neck_joins_only_circles_near_enough() {
        let c = |x: f32| Point { x, y: 0. };
        assert!(neck(20., c(0.), c(44.)).is_some());
        assert!(neck(20., c(0.), c(0.2)).is_none());
        assert!(neck(20., c(0.), c(80.)).is_none());
    }
}
