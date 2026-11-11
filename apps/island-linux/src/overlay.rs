//! The two full-screen overlays: the screenshot's, where a region is dragged
//! out and marked up (the Mac's `MarkingView`), and the ink drawn on the live
//! screen while dictating (`InkView`). Both draw in GPUI logical pixels and
//! keep their marks in screen pixels, the capture's own, so ink lands on the
//! written image exactly where it was drawn.

use crate::capture::{INK, INK_WIDTH, Mark, Marking, Rect};
use crate::Island;
use gpui::{
    App, Bounds, Context, CursorStyle, Entity, FocusHandle, Hsla, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PathBuilder, Pixels, RenderImage, Window, canvas, div, point, prelude::*, px, rgb,
};
use std::sync::Arc;

fn white(alpha: f32) -> Hsla {
    gpui::hsla(0., 0., 1., alpha)
}

fn ink() -> Hsla {
    gpui::rgb(u32::from(INK[0]) << 16 | u32::from(INK[1]) << 8 | u32::from(INK[2])).into()
}

/// An RGBA image as GPUI draws it: BGRA.
pub fn render_image(rgba: &image::RgbaImage) -> Arc<RenderImage> {
    let mut bgra = rgba.clone();
    for p in bgra.pixels_mut() {
        p.0.swap(0, 2);
    }
    Arc::new(RenderImage::new([image::Frame::new(bgra)]))
}

/// Paints strokes in screen pixels onto the window, scaled to logical.
fn paint_marks(marks: &[Mark], color: Hsla, width: f32, scale: f32, window: &mut Window) {
    for m in marks {
        let at = |p: &(f32, f32)| point(px(p.0 / scale), px(p.1 / scale));
        if m.points.len() == 1 {
            let c = at(&m.points[0]);
            let r = px(width / 2.0);
            window.paint_quad(gpui::fill(Bounds::new(point(c.x - r, c.y - r), gpui::size(r * 2.0, r * 2.0)), color).corner_radii(r));
            continue;
        }
        let mut path = PathBuilder::stroke(px(width));
        path.move_to(at(&m.points[0]));
        for p in &m.points[1..] {
            path.line_to(at(p));
        }
        if let Ok(path) = path.build() {
            window.paint_path(path, color);
        }
        // Round caps, which a stroked path leaves square.
        for end in [m.points.first(), m.points.last()].into_iter().flatten() {
            let c = at(end);
            let r = px(width / 2.0);
            window.paint_quad(gpui::fill(Bounds::new(point(c.x - r, c.y - r), gpui::size(r * 2.0, r * 2.0)), color).corner_radii(r));
        }
    }
}

/// The screenshot in progress: the frozen screen, the pick, the marks, and
/// what the pointer is doing.
pub struct Shooting {
    pub marking: Marking,
    pub still: Arc<RenderImage>,
    /// Screen pixels per logical pixel.
    pub scale: f32,
    pub picking: Option<Rect>,
    pick_start: Option<(f32, f32)>,
    drawing: bool,
    moving: Option<(usize, (f32, f32))>,
    hovered: Option<usize>,
    pointer: Option<(f32, f32)>,
}

impl Shooting {
    pub fn new(marking: Marking, still: Arc<RenderImage>, scale: f32) -> Self {
        Self { marking, still, scale, picking: None, pick_start: None, drawing: false, moving: None, hovered: None, pointer: None }
    }

    fn over_region(&self, p: (f32, f32)) -> bool {
        self.marking.region.is_some_and(|(x, y, w, h)| p.0 >= x && p.0 <= x + w && p.1 >= y && p.1 <= y + h)
    }

    /// A press: on a mark, it is picked up; inside the region, a stroke
    /// begins; elsewhere, a new region is dragged out.
    fn down(&mut self, p: (f32, f32)) {
        if let Some(i) = self.marking.hit(p) {
            self.marking.checkpoint();
            self.marking.selected = Some(i);
            self.moving = Some((i, p));
        } else if self.over_region(p) {
            self.marking.checkpoint();
            self.marking.selected = None;
            self.drawing = true;
            self.marking.begin(p);
        } else {
            self.marking.selected = None;
            self.pick_start = Some(p);
        }
    }

    fn drag(&mut self, p: (f32, f32)) {
        self.pointer = Some(p);
        if let Some(s) = self.pick_start {
            self.picking = Some((s.0.min(p.0), s.1.min(p.1), (p.0 - s.0).abs(), (p.1 - s.1).abs()));
        } else if let Some((i, last)) = self.moving {
            // Delete or Ctrl+Z mid-drag can take the mark away under the pointer.
            let Some(m) = self.marking.marks.get_mut(i) else { return self.moving = None };
            let (dx, dy) = (p.0 - last.0, p.1 - last.1);
            for q in &mut m.points {
                *q = (q.0 + dx, q.1 + dy);
            }
            self.moving = Some((i, p));
        } else if self.drawing && let Some(m) = self.marking.marks.last_mut() {
            m.points.push(p);
        }
    }

    /// Letting go is the shot; a click rather than a drag takes none.
    fn up(&mut self, p: (f32, f32), moved: bool) {
        if let Some(r) = self.picking.take()
            && r.2 >= 4.0
            && r.3 >= 4.0
        {
            self.marking.take(r);
        }
        // A click on a mark selects it; only a real move is worth an undo step.
        if self.moving.is_some() && !moved {
            self.marking.history.pop();
        }
        self.pick_start = None;
        self.drawing = false;
        self.moving = None;
        self.hovered = self.marking.hit(p);
    }
}

pub struct CaptureOverlay {
    pub island: Entity<Island>,
    pub focus: FocusHandle,
    pressed_at: Option<(f32, f32)>,
}

impl CaptureOverlay {
    pub fn new(island: Entity<Island>, focus: FocusHandle) -> Self {
        Self { island, focus, pressed_at: None }
    }

    fn with<R>(&self, cx: &mut Context<Self>, f: impl FnOnce(&mut Shooting) -> R) -> Option<R> {
        self.island.update(cx, |island, cx| {
            let r = island.shooting.as_mut().map(f);
            cx.notify();
            r
        })
    }

    fn pos(&self, p: gpui::Point<Pixels>, cx: &App) -> (f32, f32) {
        let scale = self.island.read(cx).shooting.as_ref().map_or(1.0, |s| s.scale);
        (p.x.as_f32() * scale, p.y.as_f32() * scale)
    }

    fn key(&mut self, e: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let m = &e.keystroke.modifiers;
        let island = self.island.clone();
        match (e.keystroke.key.as_str(), m.control) {
            ("escape", _) => cx.defer(move |cx| crate::finish_capture(&island, false, cx)),
            ("enter", false) => {
                let region = self.island.read(cx).shooting.as_ref().is_some_and(|s| s.marking.region.is_some());
                if region {
                    cx.defer(move |cx| crate::finish_capture(&island, true, cx));
                } else {
                    self.with(cx, |s| s.marking.whole_screen());
                }
            }
            ("z", true) => {
                self.with(cx, |s| s.marking.undo());
            }
            ("backspace" | "delete", false) => {
                self.with(cx, |s| s.marking.delete_selected());
            }
            _ => {}
        }
    }
}

impl Render for CaptureOverlay {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(s) = self.island.read(cx).shooting.as_ref() else { return div().into_any_element() };
        let scale = s.scale;
        let view = window.viewport_size();
        let (vw, vh) = (view.width.as_f32(), view.height.as_f32());
        let still = s.still.clone();
        let shown = s.picking.or(s.marking.region);
        let marks = s.marking.marks.clone();
        let halos: Vec<(Mark, f32)> = [s.marking.selected.map(|i| (i, 0.9)), s.hovered.map(|i| (i, 0.5))]
            .into_iter()
            .flatten()
            .filter_map(|(i, a)| s.marking.marks.get(i).map(|m| (m.clone(), a)))
            .collect();
        let over_region = s.pointer.is_some_and(|p| s.over_region(p)) && s.picking.is_none();
        let pen = over_region.then_some(s.pointer).flatten().filter(|_| s.hovered.is_none() && s.moving.is_none());
        let cursor = if s.moving.is_some() {
            CursorStyle::ClosedHand
        } else if s.hovered.is_some() {
            CursorStyle::OpenHand
        } else {
            CursorStyle::Crosshair
        };
        let chrome = chrome(&self.island, s, vw, vh);
        let picture = canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                let _ = window.paint_image(bounds, bounds, gpui::Corners::default(), still, 0, false);
                // Dim everything but the region.
                let dim = gpui::hsla(0., 0., 0., 0.35);
                match shown {
                    Some((x, y, w, h)) => {
                        let (x, y, w, h) = (x / scale, y / scale, w / scale, h / scale);
                        for (bx, by, bw, bh) in [(0., 0., vw, y), (0., y + h, vw, vh - y - h), (0., y, x, h), (x + w, y, vw - x - w, h)] {
                            if bw > 0. && bh > 0. {
                                window.paint_quad(gpui::fill(Bounds::new(point(px(bx), px(by)), gpui::size(px(bw), px(bh))), dim));
                            }
                        }
                        window.paint_quad(
                            gpui::outline(Bounds::new(point(px(x), px(y)), gpui::size(px(w), px(h))), white(0.8), gpui::BorderStyle::Solid),
                        );
                    }
                    None => window.paint_quad(gpui::fill(bounds, gpui::hsla(0., 0., 0., 0.12))),
                }
                for (m, a) in &halos {
                    paint_marks(std::slice::from_ref(m), white(*a), 10.0, scale, window);
                }
                paint_marks(&marks, ink(), INK_WIDTH, scale, window);
                if let Some(p) = pen {
                    let c = point(px(p.0 / scale), px(p.1 / scale));
                    window.paint_quad(gpui::fill(Bounds::new(point(c.x - px(6.), c.y - px(6.)), gpui::size(px(12.), px(12.))), white(1.)).corner_radii(px(6.)));
                    window.paint_quad(gpui::fill(Bounds::new(point(c.x - px(4.), c.y - px(4.)), gpui::size(px(8.), px(8.))), ink()).corner_radii(px(4.)));
                }
            },
        )
        .size_full();
        div()
            .id("capture")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .cursor(cursor)
            .on_key_down(cx.listener(Self::key))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &MouseDownEvent, _, cx| {
                    let p = this.pos(e.position, cx);
                    this.pressed_at = Some(p);
                    this.with(cx, |s| s.down(p));
                }),
            )
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                let p = this.pos(e.position, cx);
                if this.pressed_at.is_some() {
                    this.with(cx, |s| s.drag(p));
                } else {
                    this.with(cx, |s| {
                        s.pointer = Some(p);
                        s.hovered = s.marking.hit(p);
                    });
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, e: &MouseUpEvent, _, cx| {
                    let p = this.pos(e.position, cx);
                    let moved = this.pressed_at.take().is_some_and(|s| s != p);
                    this.with(cx, |s| s.up(p, moved));
                }),
            )
            .child(picture)
            .child(chrome)
            .into_any_element()
    }
}

fn button(id: &'static str, label: &'static str, strong: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px(px(10.))
        .h(px(28.))
        .flex()
        .items_center()
        .rounded_full()
        .text_color(white(0.95))
        .when(strong, |d| d.font_weight(gpui::FontWeight::SEMIBOLD))
        .hover(|s| s.bg(white(0.12)))
        .child(label)
}

/// Before a region: Full screen and Cancel at the foot, where macOS's own
/// screenshot bar sits. While one is dragged: its size. Once taken: Undo,
/// Cancel and Done under the region, over it, or inside its foot where the
/// screen runs out.
fn chrome(island: &Entity<Island>, s: &Shooting, vw: f32, vh: f32) -> gpui::AnyElement {
    let scale = s.scale;
    let bar = || div().absolute().flex().items_center().gap(px(4.)).p(px(4.)).rounded_full().bg(rgb(0x000000)).text_size(px(13.));
    let (fin, cancel) = (island.clone(), island.clone());
    if let Some((x, y, w, h)) = s.picking {
        let (x, y, w, h) = (x / scale, y / scale, w / scale, h / scale);
        return div()
            .absolute()
            .left(px((x + w - 60.).min(vw - 100.)))
            .top(px((y + h + 8.).min(vh - 28.)))
            .px(px(8.))
            .py(px(4.))
            .rounded(px(6.))
            .bg(white(1.))
            .text_color(rgb(0x000000))
            .text_size(px(13.))
            .font_weight(gpui::FontWeight::MEDIUM)
            .child(format!("{} × {}", (w * scale) as u32, (h * scale) as u32))
            .into_any_element();
    }
    match s.marking.region {
        Some((x, y, w, h)) => {
            let (x, y, w, h) = (x / scale, y / scale, w / scale, h / scale);
            let top = if y + h + 48. < vh { y + h + 10. } else if y - 48. > 8. { y - 46. } else { y + h - 46. };
            let undo = island.clone();
            bar()
                .left(px((x + w / 2. - 110.).clamp(8., vw - 228.)))
                .top(px(top))
                .child(button("undo", "↶", false).opacity(if s.marking.history.is_empty() { 0.4 } else { 1. }).on_click(move |_, _, cx| {
                    undo.update(cx, |i, cx| {
                        if let Some(s) = i.shooting.as_mut() {
                            s.marking.undo();
                        }
                        cx.notify();
                    })
                }))
                .child(button("cancel", "Cancel", false).on_click(move |_, _, cx| {
                    let i = cancel.clone();
                    cx.defer(move |cx| crate::finish_capture(&i, false, cx));
                }))
                .child(button("done", "Done", true).on_click(move |_, _, cx| {
                    let i = fin.clone();
                    cx.defer(move |cx| crate::finish_capture(&i, true, cx));
                }))
                .into_any_element()
        }
        None => {
            let whole = island.clone();
            bar()
                .left(px(vw / 2. - 110.))
                .top(px(vh - 64.))
                .child(button("full", "▭  Full screen", false).on_click(move |_, _, cx| {
                    whole.update(cx, |i, cx| {
                        if let Some(s) = i.shooting.as_mut() {
                            s.marking.whole_screen();
                        }
                        cx.notify();
                    })
                }))
                .child(button("cancel", "Cancel", false).on_click(move |_, _, cx| {
                    let i = cancel.clone();
                    cx.defer(move |cx| crate::finish_capture(&i, false, cx));
                }))
                .into_any_element()
        }
    }
}

/// Ink on the live screen while dictating. The overlay lets the mouse through
/// until Shift is held (`x11::pass_mouse`), so the page under it still
/// scrolls and clicks; with no compositor to see through it, it shows the
/// screen as it was when Shift went down.
pub struct Inking {
    pub marks: Vec<Mark>,
    pub armed: bool,
    pub drawing: bool,
    pub scale: f32,
    /// The frozen screen, where there is no compositor to see the live one.
    pub still: Option<Arc<RenderImage>>,
    pub pointer: Option<(f32, f32)>,
    /// Marks a moment being taken still holds; the next moment leaves them out.
    pub claimed: Vec<u64>,
    next: u64,
}

impl Inking {
    pub fn new(scale: f32) -> Self {
        Self { marks: Vec::new(), armed: false, drawing: false, scale, still: None, pointer: None, claimed: Vec::new(), next: 1 << 32 }
    }

    pub fn begin(&mut self, p: (f32, f32)) {
        self.next += 1;
        self.drawing = true;
        self.marks.push(Mark { id: self.next, points: vec![p] });
    }
}

pub struct InkOverlay {
    pub island: Entity<Island>,
}

impl Render for InkOverlay {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(ink_state) = self.island.read(cx).inking.as_ref() else { return div().into_any_element() };
        let scale = ink_state.scale;
        let marks = ink_state.marks.clone();
        let still = ink_state.still.clone();
        let tip = ink_state.armed.then_some(ink_state.pointer).flatten();
        div()
            .id("ink")
            .size_full()
            .cursor(CursorStyle::Crosshair)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &MouseDownEvent, _, cx| {
                    let island = this.island.clone();
                    let began = island.update(cx, |island, cx| {
                        let Some(s) = island.inking.as_mut() else { return false };
                        if !s.armed {
                            return false;
                        }
                        let p = (e.position.x.as_f32() * s.scale, e.position.y.as_f32() * s.scale);
                        s.begin(p);
                        cx.notify();
                        true
                    });
                    if began {
                        cx.defer(move |cx| crate::stroke_began(&island, cx));
                    }
                }),
            )
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                this.island.update(cx, |island, cx| {
                    let Some(s) = island.inking.as_mut() else { return };
                    let p = (e.position.x.as_f32() * s.scale, e.position.y.as_f32() * s.scale);
                    s.pointer = Some(p);
                    if s.drawing && let Some(m) = s.marks.last_mut() {
                        m.points.push(p);
                    }
                    cx.notify();
                })
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| {
                    let island = this.island.clone();
                    let ended = island.update(cx, |island, _| {
                        island.inking.as_mut().is_some_and(|s| std::mem::replace(&mut s.drawing, false))
                    });
                    if ended {
                        cx.defer(move |cx| crate::stroke_ended(&island, cx));
                    }
                }),
            )
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        if let Some(still) = still {
                            let _ = window.paint_image(bounds, bounds, gpui::Corners::default(), still, 0, false);
                        }
                        paint_marks(&marks, ink(), INK_WIDTH, scale, window);
                        if let Some(p) = tip {
                            let c = point(px(p.0 / scale), px(p.1 / scale));
                            window.paint_quad(gpui::fill(Bounds::new(point(c.x - px(6.), c.y - px(6.)), gpui::size(px(12.), px(12.))), white(1.)).corner_radii(px(6.)));
                            window.paint_quad(gpui::fill(Bounds::new(point(c.x - px(4.), c.y - px(4.)), gpui::size(px(8.), px(8.))), ink()).corner_radii(px(4.)));
                        }
                    },
                )
                .size_full(),
            )
            .into_any_element()
    }
}

/// The picture flying from where it was taken into the panel: the Mac's
/// `Capture.fly`, a window of its own moved a frame at a time.
pub struct Flight {
    pub image: Arc<RenderImage>,
}

impl Render for Flight {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let image = self.image.clone();
        canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                let _ = window.paint_image(bounds, bounds, gpui::Corners::all(px(10.)), image, 0, false);
            },
        )
        .size_full()
    }
}
