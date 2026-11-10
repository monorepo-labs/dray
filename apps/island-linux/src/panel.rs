//! What the island draws: the panel — a waiting card, or the pinned session
//! while none waits — and the pill that says cards are waiting.

use crate::asks::{AskKind, Permission, Question, ToolLine};
use crate::draft::{Field, Menu, Target};
use crate::newtask::{self, STANCES};
use crate::prefs::Placement;
use crate::{Island, Link};
use crate::{ROOM, WIDTH};
use gpui::{
    AnyElement, App, BoxShadow, Context, Entity, FocusHandle, Focusable, Hsla, KeyDownEvent, MouseButton,
    MouseDownEvent, PathBuilder, Pixels, Window, canvas, deferred, div, point, prelude::*, px, rgb,
};

const YELLOW: u32 = 0xffd23f;
/// The Mac's waiting dot, `StatusDot.waiting`.
const WAITING: u32 = 0xe5c057;
const RED: u32 = 0xff6b5e;
/// The card's fill on a denial's flash, as the Mac turns its card red.
const DENIED: u32 = 0xc4392f;
/// The most a card's question or the waiting list may take before it
/// scrolls, as the Mac caps them; less on a short screen.
const BODY_CAP: f32 = 420.;
/// Room under (or over) the card for a dropdown, which hangs past it.
const MENU_ROOM: f32 = 250.;
/// The model menu: wide enough for every agent's name on its track.
const MODEL_MENU: f32 = 300.;
/// The draft's rows: three tall at most, then they scroll.
const ROWS_CAP: f32 = 3. * 32. + 2. * 10.;
/// The type: 13pt body, 12 for asides, 11 for the smallest.
const BODY: f32 = 13.;
const ASIDE: f32 = 12.;
const SMALL: f32 = 11.;

fn white(alpha: f32) -> Hsla {
    gpui::hsla(0., 0., 1., alpha)
}

/// Runs `f` once the current update is over: closing or reopening a window
/// from inside its own listener would pull it out from under GPUI.
fn later(island: &Entity<Island>, cx: &mut App, f: impl FnOnce(&Entity<Island>, &mut App) + 'static) {
    let island = island.clone();
    cx.defer(move |cx| f(&island, cx));
}

pub struct Panel {
    island: Entity<Island>,
    focus: FocusHandle,
    /// What the panel drew last: a card, or the draft. The keyboard follows a
    /// change between them, as the Mac's focus does.
    showing_card: Option<bool>,
}

impl Panel {
    pub fn new(island: Entity<Island>, focus: FocusHandle) -> Self {
        Self { island, focus, showing_card: None }
    }

    /// Whether the open question's text box holds the keyboard, when digits
    /// and Enter are the box's and not the card's.
    fn typing(&self, window: &Window, cx: &App) -> bool {
        let card = &self.island.read(cx).card;
        card.inputs.get(card.index).is_some_and(|i| i.focus_handle(cx).is_focused(window))
    }

    fn key_down(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let island = self.island.clone();
        let current = island.read(cx).card_up(cx);
        if current.is_none() {
            return self.draft_key(e, window, cx);
        }
        let key = e.keystroke.key.as_str();
        let typing = self.typing(window, cx);
        match key {
            "escape" => later(&island, cx, |i, cx| crate::close(i, cx)),
            "enter" => {
                if let Some((_, ask)) = &current
                    && matches!(ask.kind, AskKind::Questions(_))
                {
                    advance(&island, window, &self.focus, cx);
                }
            }
            _ if !typing && !e.keystroke.modifiers.modified() => {
                let Some(n) = key.parse::<usize>().ok().filter(|n| (1..=9).contains(n)) else { return };
                let Some((_, ask)) = current else { return };
                match &ask.kind {
                    AskKind::Permission(p) => {
                        if let Some(option) = p.options.get(n - 1) {
                            let id = option.id.clone();
                            later(&island, cx, move |i, cx| crate::respond(i, id, cx));
                        }
                    }
                    AskKind::Questions(qs) => {
                        let index = island.read(cx).card.index;
                        if let Some(option) = qs.get(index).and_then(|q| q.options.get(n - 1)) {
                            toggle_pick(&island, index, option.label.clone(), qs[index].multi_select, cx);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// The draft's keys: ⏎ sends, Ctrl+⏎ queues the box as a row, ↑/↓ walk
    /// the switcher while the box is empty or the switcher is open, Ctrl+N is
    /// a new task, Ctrl+F the switcher's search, Esc steps back out.
    fn draft_key(&mut self, e: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let island = self.island.clone();
        let m = &e.keystroke.modifiers;
        let (list, menu, empty) = {
            let d = island.read(cx).draft();
            (d.list_shown, d.menu.is_some(), d.typing.read(cx).text().is_empty())
        };
        match (e.keystroke.key.as_str(), m.control, m.shift || m.alt || m.platform) {
            ("escape", false, false) => {
                if menu || list {
                    island.update(cx, |island, cx| {
                        let d = island.draft_mut();
                        if menu {
                            d.menu = None;
                        } else {
                            d.list_shown = false;
                            d.want_focus = Some(Field::Typing);
                        }
                        cx.notify();
                    });
                } else {
                    later(&island, cx, |i, cx| crate::close(i, cx));
                }
            }
            ("enter", false, false) if list => later(&island, cx, |i, cx| crate::choose(i, None, cx)),
            ("enter", false, false) => later(&island, cx, |i, cx| crate::send(i, cx)),
            ("enter", true, false) => later(&island, cx, |i, cx| crate::add_typed(i, cx)),
            ("up" | "down", false, false) if !menu && (list || empty) => {
                let delta = if e.keystroke.key == "up" { -1 } else { 1 };
                later(&island, cx, move |i, cx| crate::move_list(i, delta, cx));
            }
            ("n", true, false) => later(&island, cx, |i, cx| crate::pick_target(i, Target::New, cx)),
            ("f", true, false) => {
                island.update(cx, |island, cx| {
                    let d = island.draft_mut();
                    d.list_shown = true;
                    d.want_focus = Some(Field::Search);
                    cx.notify();
                });
            }
            _ => {}
        }
    }
}

impl Render for Panel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.island.clone();
        let card_up = self.island.read(cx).card_up(cx);
        // The keyboard follows the panel: into the box for a draft, onto the
        // panel for a card, and wherever a key asked for it.
        let mut want = self.island.read(cx).draft().want_focus;
        if self.showing_card != Some(card_up.is_some()) && self.island.read(cx).flash.is_none() {
            if self.showing_card.is_some() {
                want = Some(if card_up.is_some() { Field::Panel } else { Field::Typing });
            }
            self.showing_card = Some(card_up.is_some());
        }
        if let Some(field) = want {
            let handle = {
                let d = self.island.read(cx).draft();
                match field {
                    Field::Typing => d.typing.read(cx).focus().clone(),
                    Field::Search => d.search.read(cx).focus().clone(),
                    Field::Panel => self.focus.clone(),
                }
            };
            window.focus(&handle, cx);
            self.island.update(cx, |island, _| island.draft_mut().want_focus = None);
        }
        let island = self.island.read(cx);
        let draft_up = island.flash.is_none() && card_up.is_none();
        let content: AnyElement = if let Some(label) = island.flash {
            flash(label).into_any_element()
        } else if let Some((key, _)) = &card_up {
            card(&state, island, key, &self.focus, cx).into_any_element()
        } else if !matches!(island.link, Link::Up) {
            pinned(island).into_any_element()
        } else {
            draft_view(&state, island, cx).into_any_element()
        };
        let menu = island.menu.then(|| placement_menu(&state, island.placement));
        let glass = island.glass;
        let top = island.placement == Placement::Top;
        let fill = if island.flash == Some("Denied") { rgb(DENIED) } else { rgb(0x000000) };
        let waiting = island.asks.attention().len();
        let peeks = (island.flash.is_none() && !island.listed && card_up.is_some() && waiting > 1)
            .then(|| peeks(waiting - 1));
        let switcher = (draft_up && island.draft().list_shown && matches!(island.link, Link::Up))
            .then(|| switcher(&state, island, glass, cx).into_any_element());
        // Room in the window for a bar dropdown, which hangs past the card.
        let dropdown_room = (draft_up && island.draft().menu.is_some()).then(|| div().h(px(MENU_ROOM)).into_any_element());
        let body = div()
            .w_full()
            .bg(fill)
            .border_color(white(0.12))
            .map(|d| match (glass, top) {
                // The notch shape: flush with the bar above, its bottom rounded,
                // and no line along the top edge, which would read as a border on the bar.
                (true, true) => d.rounded_b(px(20.)).border_l_1().border_r_1().border_b_1(),
                (true, false) => d.rounded(px(20.)).border_1(),
                (false, _) => d.border_1(),
            })
            .when(glass, |d| d.shadow(vec![shadow(gpui::hsla(0., 0., 0., 0.35), 5., 2.)]))
            .child(content);
        // The switcher is a card of its own on the far side from the edge the
        // panel hangs from, as on the Mac.
        let frame = div()
            .flex_none()
            .relative()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .when(glass, |d| d.px(px(ROOM)).pb(px(ROOM)).when(!top, |d| d.pt(px(ROOM))))
            .map(|d| {
                let card = div().w_full().flex().flex_col().items_center().child(body).children(peeks);
                if top {
                    d.child(card).children(switcher).children(dropdown_room)
                } else {
                    d.children(dropdown_room).children(switcher).child(card)
                }
            })
            .when(glass && top, |d| d.child(ear(true, fill.into())).child(ear(false, fill.into())));
        let fit = state.clone();
        div()
            // The window follows what it draws: its first child is the frame.
            .on_children_prepainted(move |bounds, window, cx| {
                let Some(frame) = bounds.first() else { return };
                let wanted = frame.size.height.as_f32().ceil();
                if (wanted - window.bounds().size.height.as_f32()).abs() > 1. {
                    let width = window.bounds().size.width.as_f32();
                    later(&fit, cx, move |i, cx| crate::fit(i, false, width, wanted, cx));
                }
            })
            .id("panel")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .when(!glass, |d| d.bg(rgb(0x000000)))
            .text_size(px(BODY))
            .text_color(white(0.92))
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _, _, cx| {
                    this.island.update(cx, |island, cx| {
                        island.menu = !island.menu;
                        cx.notify();
                    });
                }),
            )
            .child(frame)
            .children(menu)
    }
}

/// GPUI's blur reaches about twice its radius, where SwiftUI's stops near it,
/// so the Mac's radius 12 is about 5 here — enough to stay inside `ROOM`, past
/// which the window edge cuts the shadow off square.
fn shadow(color: Hsla, blur: f32, y: f32) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.), px(y)), blur_radius: px(blur), spread_radius: px(0.), inset: false }
}

/// One of the notch shape's top corners, flaring out into the bar the way
/// the Mac's notch meets the screen edge: `NotchShape`'s quarter curve, in
/// the room beside the card.
fn ear(left: bool, fill: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |b, _, window, _| {
            let (x, y, e) = (b.origin.x, b.origin.y, b.size.width);
            let at = |dx: Pixels, dy: Pixels| point(x + dx, y + dy);
            let mut path = PathBuilder::fill();
            if left {
                path.move_to(at(px(0.), px(0.)));
                path.curve_to(at(e, e), at(e, px(0.)));
                path.line_to(at(e, px(0.)));
            } else {
                path.move_to(at(e, px(0.)));
                path.curve_to(at(px(0.), e), at(px(0.), px(0.)));
                path.line_to(at(px(0.), px(0.)));
            }
            path.close();
            if let Ok(path) = path.build() {
                window.paint_path(path, fill);
            }
        },
    )
    .absolute()
    .top_0()
    .when(left, |d| d.left_0())
    .when(!left, |d| d.right_0())
    .size(px(ROOM))
}

/// The edges of the cards waiting under the one shown, two at most, so the
/// stack reads at a glance: the Mac's `AskPeeks`.
fn peeks(count: usize) -> impl IntoElement {
    div().flex().flex_col().items_center().children((0..count.min(2)).map(|i| {
        div()
            .w(px(WIDTH - (i as f32 + 1.) * 28.))
            .h(px(7.))
            .rounded_b(px(10.))
            .bg(gpui::hsla(0., 0., if i == 0 { 0.1 } else { 0.06 }, 1.))
            .border_l_1()
            .border_r_1()
            .border_b_1()
            .border_color(white(0.1))
    }))
}

/// What a card's body may take: the Mac's cap, less on a screen too short
/// for it once the header, padding and room are counted.
fn cap(cx: &App) -> f32 {
    BODY_CAP.min(crate::work_height(cx) - 120.).max(120.)
}

fn shell() -> gpui::Div {
    div().flex_none().w_full().flex().flex_col().gap(px(10.)).p(px(12.))
}

/// The panel while there is no server to reach: what is wrong, and the box,
/// whose draft waits for it.
fn pinned(island: &Island) -> impl IntoElement {
    let key = crate::prefs::read().key.label();
    let busy = false;
    let (title, detail): (String, String) = match &island.link {
        Link::Up | Link::Connecting => ("Connecting to Dray…".into(), String::new()),
        Link::Unreachable => ("Dray isn't running".into(), "Open Dray to reach your tasks".into()),
        Link::Refused(why) => ("Dray turned the island away".into(), why.clone()),
    };
    shell()
        .child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().size(px(6.)).rounded_full().bg(if busy { rgb(YELLOW).into() } else { white(0.25) }))
                .child(div().flex_1().truncate().font_weight(gpui::FontWeight::SEMIBOLD).text_color(white(0.45)).child(title))
                .child(div().text_size(px(ASIDE)).text_color(white(0.3)).child(detail)),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .px(px(10.))
                .h(px(32.))
                .rounded(px(8.))
                .bg(white(0.08))
                .child(div().text_color(white(0.3)).child("Reply…"))
                .child(div().text_size(px(ASIDE)).text_color(white(0.3)).child(format!("Tap {key} to close · Esc"))),
        )
}

/// The last answer's word while the panel closes on it.
fn flash(label: &'static str) -> impl IntoElement {
    let mark = if label == "Denied" { "✕" } else { "✓" };
    shell().px(px(16.)).child(div().font_weight(gpui::FontWeight::SEMIBOLD).child(format!("{mark}  {label}")))
}

/// A waiting card: the header naming the session, then its question, or the
/// list of every waiting session when the title was clicked.
fn card(state: &Entity<Island>, island: &Island, key: &str, focus: &FocusHandle, cx: &App) -> impl IntoElement {
    let keys = island.asks.attention();
    let listed = island.listed && keys.len() > 1;
    let mut el = shell();
    if listed {
        el = el.child(waiting_list(state, island, &keys, key).id("waiting-scroll").max_h(px(cap(cx))).overflow_y_scroll());
    } else {
        el = el.child(header(state, island, &keys, key));
        if let Some((_, ask)) = island.current() {
            // A long option list scrolls rather than pushing the buttons off screen.
            el = el.child(
                div().id(("ask-scroll", island.card.index)).max_h(px(cap(cx))).overflow_y_scroll().child(match &ask.kind {
                    AskKind::Permission(p) => permission(state, island, p).into_any_element(),
                    AskKind::Questions(qs) => questions(state, island, qs, focus, cx).into_any_element(),
                }),
            );
        }
    }
    el.children(island.notice.clone().map(|n| div().text_size(px(ASIDE)).text_color(rgb(RED)).child(n)))
}

/// Ctrl-click on a title opens the session in Dray, as ⌘-click does on the Mac.
fn title_click(
    state: Entity<Island>,
    key: String,
    otherwise: impl Fn(&Entity<Island>, &mut App) + 'static,
) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static {
    move |e, _, cx| {
        if e.modifiers.control {
            let key = key.clone();
            later(&state, cx, move |i, cx| crate::show_in_app(i, key, cx));
        } else {
            otherwise(&state, cx);
        }
    }
}

fn header(state: &Entity<Island>, island: &Island, keys: &[String], key: &str) -> impl IntoElement {
    let more = keys.len().saturating_sub(1);
    let title = div()
        .id("title")
        .flex()
        .items_center()
        .gap_2()
        .min_w_0()
        .font_weight(gpui::FontWeight::SEMIBOLD)
        .text_color(white(if more > 0 { 0.6 } else { 0.45 }))
        .when(more > 0, |d| d.hover(|s| s.text_color(white(0.9))))
        .child(div().truncate().child(island.title(key)))
        .children((more > 0).then(|| {
            div()
                .flex_none()
                .px(px(6.))
                .h(px(18.))
                .flex()
                .items_center()
                .rounded_full()
                .bg(white(0.18))
                .text_size(px(SMALL))
                .child(format!("+{more}"))
        }))
        .on_mouse_down(
            MouseButton::Left,
            title_click(state.clone(), key.to_string(), move |i, cx| {
                if more > 0 {
                    i.update(cx, |island, cx| {
                        island.listed = !island.listed;
                        cx.notify();
                    });
                }
            }),
        );
    let dismiss = |id: &'static str, label: &'static str, session: Option<String>| {
        let state = state.clone();
        div()
            .id(id)
            .text_size(px(ASIDE))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(white(0.5))
            .hover(|s| s.text_color(white(0.9)))
            .child(label)
            .on_click(move |_, _, cx| {
                let session = session.clone();
                later(&state, cx, move |i, cx| crate::dismiss(i, session, cx));
            })
    };
    div()
        .flex()
        .items_center()
        .gap_3()
        .child(div().flex_1().min_w_0().child(title))
        .child(dismiss("dismiss", "Dismiss", Some(key.to_string())))
        .children((more > 0).then(|| dismiss("dismiss-all", "Dismiss all", None)))
        .child(div().text_size(px(ASIDE)).text_color(white(0.3)).child("Esc"))
}

/// Every waiting session by title; a click opens its card.
fn waiting_list(state: &Entity<Island>, island: &Island, keys: &[String], current: &str) -> gpui::Div {
    div().flex().flex_col().gap(px(2.)).children(keys.iter().enumerate().map(|(n, k)| {
        let on = k == current;
        let pick_key = k.clone();
        div()
            .id(("waiting", n))
            .px(px(10.))
            .h(px(30.))
            .flex()
            .items_center()
            .rounded(px(8.))
            .when(on, |d| d.bg(white(0.08)).font_weight(gpui::FontWeight::SEMIBOLD))
            .text_color(white(if on { 0.95 } else { 0.75 }))
            .hover(|s| s.bg(white(0.08)))
            .child(div().truncate().child(island.title(k)))
            .on_mouse_down(
                MouseButton::Left,
                title_click(state.clone(), k.clone(), move |i, cx| {
                    let k = pick_key.clone();
                    later(i, cx, move |i, cx| crate::pick(i, k, cx));
                }),
            )
    }))
}

/// A pickable row: lifted under the pointer, brighter once picked.
fn item(id: (&'static str, usize), on: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .px(px(10.))
        .min_h(px(30.))
        .rounded(px(8.))
        .bg(white(if on { 0.2 } else { 0.08 }))
        .hover(move |s| s.bg(white(if on { 0.2 } else { 0.13 })))
}

fn number(n: usize) -> impl IntoElement {
    div().w(px(10.)).text_color(white(0.3)).child(if n < 9 { (n + 1).to_string() } else { String::new() })
}

/// A permission as one line, its command behind a click, then its options.
fn permission(state: &Entity<Island>, island: &Island, p: &Permission) -> impl IntoElement {
    let line = ToolLine::new(p);
    let show = island.card.show_command;
    let busy = island.card.busy;
    let toggle = state.clone();
    let has_hidden = line.hidden.is_some();
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .id("tool-line")
                .flex()
                .gap_2()
                .child(div().flex_none().font_weight(gpui::FontWeight::MEDIUM).child(line.tool))
                .children(line.beside.map(|b| div().truncate().text_color(white(0.5)).child(b)))
                .on_click(move |_, _, cx| {
                    if has_hidden {
                        toggle.update(cx, |island, cx| {
                            island.card.show_command = !island.card.show_command;
                            cx.notify();
                        });
                    }
                }),
        )
        .children(line.hidden.filter(|_| show).map(|c| {
            div().text_size(px(SMALL)).font_family("monospace").text_color(white(0.5)).child(c)
        }))
        .children(p.options.iter().enumerate().map(|(n, option)| {
            let state = state.clone();
            let id = option.id.clone();
            item(("option", n), false)
                .child(number(n))
                .child(div().truncate().text_color(if option.behavior == "deny" { rgb(RED).into() } else { white(0.95) }).child(option.label.clone()))
                .when(busy, |d| d.opacity(0.5))
                .on_click(move |_, _, cx| {
                    let id = id.clone();
                    later(&state, cx, move |i, cx| crate::respond(i, id, cx));
                })
        }))
}

/// One question at a time: a number or a click picks (toggles, on a
/// multi-select), Enter moves on and sends from the last, Skip leaves a
/// question unanswered — a real answer.
fn questions(state: &Entity<Island>, island: &Island, qs: &[Question], focus: &FocusHandle, cx: &App) -> impl IntoElement {
    let card = &island.card;
    let index = card.index.min(qs.len().saturating_sub(1));
    let q = &qs[index];
    let picked = card.picks.get(index).cloned().unwrap_or_default();
    let last = index + 1 == qs.len();
    let input = card.inputs.get(index).cloned();
    let typed = input.as_ref().map(|i| i.read(cx).text().to_string()).unwrap_or_default();
    let mut body = div()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .flex()
                .gap_2()
                .child(div().flex_1().font_weight(gpui::FontWeight::MEDIUM).child(q.question.clone()))
                .children((qs.len() > 1).then(|| div().text_size(px(ASIDE)).text_color(white(0.3)).child(format!("{} of {}", index + 1, qs.len())))),
        )
        .children(q.options.iter().enumerate().map(|(n, option)| {
            let on = picked.contains(&option.label);
            let state = state.clone();
            let label = option.label.clone();
            let multi = q.multi_select;
            item(("choice", n), on)
                .py(px(7.))
                .items_start()
                .child(number(n))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(div().text_color(white(0.95)).child(option.label.clone()))
                        .children(option.description.clone().map(|d| div().text_size(px(SMALL)).text_color(white(0.4)).child(d))),
                )
                .on_click(move |_, _, cx| toggle_pick(&state, index, label.clone(), multi, cx))
        }));
    if q.free_text {
        if card.editing && let Some(input) = input.clone() {
            body = body.child(div().px(px(10.)).h(px(32.)).flex().items_center().rounded(px(8.)).bg(white(0.14)).child(input));
        } else {
            let state = state.clone();
            body = body.child(
                item(("something-else", 0), false)
                    .h(px(32.))
                    .text_color(white(if typed.is_empty() { 0.3 } else { 0.95 }))
                    .child(if typed.is_empty() { "Something else…".to_string() } else { typed })
                    .on_click(move |_, window, cx| {
                        let input = state.update(cx, |island, cx| {
                            island.card.editing = true;
                            cx.notify();
                            island.card.inputs.get(island.card.index).cloned()
                        });
                        if let Some(input) = input {
                            let handle = input.focus_handle(cx);
                            window.focus(&handle, cx);
                        }
                    }),
            );
        }
    }
    let back = state.clone();
    let skip = state.clone();
    let next = state.clone();
    let (f1, f2) = (focus.clone(), focus.clone());
    body.child(
        div()
            .flex()
            .items_center()
            .gap(px(14.))
            .children((index > 0).then(|| {
                div().id("back").text_color(white(0.5)).hover(|s| s.text_color(white(0.9))).child("Back").on_click(move |_, window, cx| {
                    step(&back, -1, window, &f1, cx);
                })
            }))
            .child(div().flex_1())
            .child(div().id("skip").text_color(white(0.5)).hover(|s| s.text_color(white(0.9))).child("Skip").on_click(move |_, window, cx| {
                skip_question(&skip, window, &f2, cx);
            }))
            .child(
                div()
                    .id("next")
                    .px_3()
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .rounded_full()
                    .bg(white(1.))
                    .text_color(rgb(0x000000))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .when(card.busy, |d| d.opacity(0.5))
                    .child(if last { "Send  ⏎" } else { "Next  ⏎" })
                    .on_click({
                        let focus = focus.clone();
                        move |_, window, cx| advance(&next, window, &focus, cx)
                    }),
            ),
    )
}

/// A pick on the open question. A single pick is the answer, so it lets go
/// of typed text, which would otherwise outrank it unseen.
fn toggle_pick(state: &Entity<Island>, index: usize, label: String, multi: bool, cx: &mut App) {
    let input = state.update(cx, |island, cx| {
        let card = &mut island.card;
        let Some(picks) = card.picks.get_mut(index) else { return None };
        if picks.contains(&label) {
            picks.retain(|l| l != &label);
        } else if multi {
            picks.push(label);
        } else {
            *picks = vec![label];
        }
        cx.notify();
        if multi {
            return None;
        }
        card.editing = false;
        card.inputs.get(index).cloned()
    });
    if let Some(input) = input {
        input.update(cx, |input, cx| input.clear(cx));
    }
}

/// Moves between questions, out of any text box.
fn step(state: &Entity<Island>, delta: isize, window: &mut Window, focus: &FocusHandle, cx: &mut App) {
    state.update(cx, |island, cx| {
        let card = &mut island.card;
        card.index = card.index.saturating_add_signed(delta);
        card.editing = false;
        cx.notify();
    });
    window.focus(focus, cx);
}

/// Next, or Send on the last question.
fn advance(state: &Entity<Island>, window: &mut Window, focus: &FocusHandle, cx: &mut App) {
    let (index, count) = {
        let i = state.read(cx);
        let count = match i.current() {
            Some((_, ask)) => match ask.kind {
                AskKind::Questions(qs) => qs.len(),
                AskKind::Permission(_) => 0,
            },
            None => 0,
        };
        (i.card.index, count)
    };
    if count == 0 {
        return;
    }
    if index + 1 >= count {
        later(state, cx, |i, cx| crate::answer(i, cx));
    } else {
        step(state, 1, window, focus, cx);
    }
}

/// Leaves the open question unanswered and moves on.
fn skip_question(state: &Entity<Island>, window: &mut Window, focus: &FocusHandle, cx: &mut App) {
    let input = state.update(cx, |island, _| {
        let card = &mut island.card;
        if let Some(picks) = card.picks.get_mut(card.index) {
            picks.clear();
        }
        card.inputs.get(card.index).cloned()
    });
    if let Some(input) = input {
        input.update(cx, |input, cx| input.clear(cx));
    }
    advance(state, window, focus, cx);
}

fn placement_menu(state: &Entity<Island>, placement: Placement) -> impl IntoElement {
    let item = |label: &'static str, pick: Placement| {
        let state = state.clone();
        div()
            .id(label)
            .px(px(10.))
            .py_1()
            .rounded(px(6.))
            .text_color(if pick == placement { rgb(YELLOW).into() } else { white(0.85) })
            .hover(|s| s.bg(white(0.1)))
            .child(label)
            .on_click(move |_, _, cx| later(&state, cx, move |i, cx| crate::set_placement(i, pick, cx)))
    };
    let shut = state.clone();
    div()
        // GPUI hands a click to everything under the pointer: without this,
        // a pick at the bottom also pressed Dismiss all beneath it.
        .occlude()
        .on_mouse_down_out(move |_, _, cx| {
            shut.update(cx, |island, cx| {
                island.menu = false;
                cx.notify();
            })
        })
        .absolute()
        .right(px(12. + ROOM))
        .top(px(8.))
        .flex()
        .flex_col()
        .p_1()
        .rounded_lg()
        .bg(rgb(0x1c1c1c))
        .border_1()
        .border_color(white(0.15))
        .child(item("Top of screen", Placement::Top))
        .child(item("Bottom of screen", Placement::Bottom))
}

/// The draft: who it goes to — the title, or a new task's bar — the rows
/// typed so far, the box and Send.
fn draft_view(state: &Entity<Island>, island: &Island, cx: &App) -> impl IntoElement {
    let d = island.draft();
    let top = island.placement == Placement::Top;
    let head: AnyElement = match &d.target {
        Some(Target::Session(id)) => title_row(state, island, id).into_any_element(),
        _ => new_task_bar(state, island, top).into_any_element(),
    };
    let rows = (!d.rows.is_empty()).then(|| {
        div()
            .id("rows")
            .max_h(px(ROWS_CAP))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(10.))
            .children(d.rows.iter().map(|row| {
                let (state, id) = (state.clone(), row.id);
                div()
                    .flex_none()
                    .flex()
                    .items_start()
                    .gap_2()
                    .p(px(8.))
                    .rounded(px(10.))
                    .bg(white(0.06))
                    .child(div().w(px(16.)).flex_none().text_color(white(0.4)).child("›"))
                    .child(div().flex_1().min_w_0().child(row.input.clone()))
                    .child(
                        div()
                            .id(("remove", id as usize))
                            .flex_none()
                            .text_color(white(0.4))
                            .hover(|s| s.text_color(white(0.9)))
                            .child("✕")
                            .on_click(move |_, _, cx| later(&state, cx, move |i, cx| crate::remove_row(i, id, cx))),
                    )
            }))
    });
    let can_send = !d.sending && (!d.rows.is_empty() || !d.typing.read(cx).text().trim().is_empty());
    let send = {
        let state = state.clone();
        div()
            .id("send")
            .flex_none()
            .size(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .bg(white(if can_send { 1. } else { 0.25 }))
            .text_color(rgb(0x000000))
            .font_weight(gpui::FontWeight::BOLD)
            .child("↑")
            .when(can_send, |d| d.on_click(move |_, _, cx| later(&state, cx, |i, cx| crate::send(i, cx))))
    };
    shell()
        .gap(px(8.))
        .child(head)
        .children(rows)
        .child(div().flex().items_end().gap_2().child(div().flex_1().min_w_0().py(px(2.)).child(d.typing.clone())).child(send))
        .children(island.notice.clone().map(|n| div().text_size(px(ASIDE)).text_color(white(0.5)).child(n)))
}

/// The sidebar's mark for a session: asking, running, or nothing.
fn lead_color(island: &Island, id: &str) -> Option<Hsla> {
    let asking = island.asks.attention().iter().any(|k| k == id);
    let busy = island.session(id).is_some_and(|s| s.status == "in_progress");
    if asking {
        Some(rgb(WAITING).into())
    } else if busy {
        Some(rgb(YELLOW).into())
    } else {
        None
    }
}

fn dot(color: Hsla) -> gpui::Div {
    div().flex_none().size(px(6.)).rounded_full().bg(color)
}

fn lead_mark(island: &Island, id: &str) -> Option<gpui::Div> {
    lead_color(island, id).map(dot)
}

/// The session the draft goes to. A click opens the switcher rather than
/// Dray, since a title clicked without thinking must not switch apps;
/// Ctrl-click is the deliberate way to Dray.
fn title_row(state: &Entity<Island>, island: &Island, id: &str) -> impl IntoElement {
    let key = crate::prefs::read().key.label();
    let title = island.session(id).map(|s| s.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| "Task".into());
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(
            div()
                .id("draft-title")
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(6.))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(white(0.7))
                .hover(|s| s.text_color(white(1.)))
                .children(lead_mark(island, id))
                .child(div().truncate().child(title))
                .on_mouse_down(MouseButton::Left, title_click(state.clone(), id.to_string(), |i, cx| crate::toggle_list(i, cx))),
        )
        .child(hints(&format!("Ctrl+N New   ↑↓ Tasks   Tap {key} to close")))
}

fn hints(text: &str) -> impl IntoElement {
    div().flex_none().text_size(px(ASIDE)).text_color(white(0.3)).child(text.to_string())
}

/// A bar control that opens a dropdown: the dropdown hangs from it, under the
/// bar at the top of the screen and over it at the bottom, and draws over
/// whatever it overhangs.
fn bar_button(state: &Entity<Island>, id: &'static str, menu: Menu, open: bool, top: bool, label: impl IntoElement, dropdown: impl FnOnce() -> AnyElement) -> impl IntoElement {
    let toggle = state.clone();
    div()
        .relative()
        .flex_none()
        .child(
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(5.))
                .text_color(white(if open { 1. } else { 0.85 }))
                .hover(|s| s.text_color(white(1.)))
                .child(label)
                .on_click(move |_, _, cx| {
                    toggle.update(cx, |island, cx| {
                        let d = island.draft_mut();
                        d.menu = if d.menu == Some(menu) { None } else { Some(menu) };
                        d.hovered_model = None;
                        d.want_focus = Some(Field::Typing);
                        cx.notify();
                    })
                }),
        )
        .children(open.then(|| {
            let shut = state.clone();
            deferred(
                div()
                    .occlude()
                    .absolute()
                    .left(px(-6.))
                    .map(|d| if top { d.top(px(24.)) } else { d.bottom(px(24.)) })
                    .on_mouse_down_out(move |_, _, cx| {
                        shut.update(cx, |island, cx| {
                            let d = island.draft_mut();
                            d.menu = None;
                            d.want_focus = Some(Field::Typing);
                            cx.notify();
                        })
                    })
                    .child(dropdown()),
            )
            .with_priority(1)
        }))
}

/// The dark card every dropdown is drawn on.
fn menu_card(width: f32) -> gpui::Div {
    div()
        .w(px(width))
        .flex()
        .flex_col()
        .p(px(4.))
        .rounded(px(10.))
        .bg(gpui::hsla(0., 0., 0.12, 1.))
        .border_1()
        .border_color(white(0.1))
        .shadow(vec![shadow(gpui::hsla(0., 0., 0., 0.4), 6., 3.)])
}

fn menu_row(id: (&'static str, usize), title: String, on: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .px(px(8.))
        .h(px(26.))
        .rounded(px(6.))
        .hover(|s| s.bg(white(0.1)))
        .child(div().flex_1().truncate().child(title))
        .child(div().w(px(12.)).text_color(rgb(YELLOW)).child(if on { "✓" } else { "" }))
}

/// A new task's bar: agent and model, project, worktree, stance — the
/// desktop composer's, each control opening its dropdown.
fn new_task_bar(state: &Entity<Island>, island: &Island, top: bool) -> impl IntoElement {
    let d = island.draft();
    let p = &d.picks;
    let menu = d.menu;
    let model_label = p.model().map(|m| m.label.clone()).unwrap_or_else(|| "Default".into());
    let agent_label = p.agents.iter().find(|a| a.harness == p.harness).map(|a| a.label.clone()).unwrap_or_else(|| p.harness.clone());
    let effort = p.effort().map(|e| newtask::effort_label(&e).to_string());
    let stance = STANCES.iter().find(|(m, _)| *m == p.stance()).map_or("Auto", |(_, l)| *l);
    let worktree = p.worktree();
    let toggle = state.clone();
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .child(bar_button(
            state,
            "bar-model",
            Menu::Model,
            menu == Some(Menu::Model),
            top,
            div()
                .flex()
                .gap(px(5.))
                .child(div().text_color(white(0.5)).child(agent_label))
                .child(model_label)
                .children(effort.map(|e| div().text_color(white(0.45)).child(e))),
            || model_menu(state, island).into_any_element(),
        ))
        .child(bar_button(
            state,
            "bar-project",
            Menu::Project,
            menu == Some(Menu::Project),
            top,
            div().flex().gap(px(5.)).child(div().text_color(white(0.45)).child("▤")).child(p.project_name().unwrap_or("Project").to_string()),
            || {
                menu_card(240.)
                    .children(p.projects.iter().enumerate().map(|(n, project)| {
                        let (state, path) = (state.clone(), project.path.clone());
                        menu_row(("project", n), project.name.clone(), p.project.as_ref() == Some(&project.path))
                            .on_click(move |_, _, cx| {
                                let path = path.clone();
                                later(&state, cx, move |i, cx| crate::pick_project(i, path, cx))
                            })
                    }))
                    .when(p.projects.is_empty(), |d| d.child(div().p(px(8.)).text_color(white(0.4)).child("No projects")))
                    .into_any_element()
            },
        ))
        .child(
            div()
                .id("bar-worktree")
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_color(white(if worktree { 0.95 } else { 0.5 }))
                .child(switch(worktree))
                .child("Worktree")
                .on_click(move |_, _, cx| {
                    toggle.update(cx, |island, cx| {
                        let d = island.draft_mut();
                        d.picks.toggle_worktree();
                        d.want_focus = Some(Field::Typing);
                        cx.notify();
                    })
                }),
        )
        .children(newtask::offers_stances(&p.harness).then(|| {
            bar_button(state, "bar-stance", Menu::Stance, menu == Some(Menu::Stance), top, stance.to_string(), || {
                menu_card(200.)
                    .children(STANCES.iter().filter(|(m, _)| newtask::honours(&p.harness, m)).enumerate().map(|(n, (mode, label))| {
                        let (state, mode) = (state.clone(), mode.to_string());
                        menu_row(("stance", n), label.to_string(), mode == p.stance()).on_click(move |_, _, cx| {
                            state.update(cx, |island, cx| {
                                let d = island.draft_mut();
                                d.picks.pick_stance(&mode);
                                d.menu = None;
                                d.want_focus = Some(Field::Typing);
                                cx.notify();
                            })
                        })
                    }))
                    .into_any_element()
            })
        }))
}

/// The worktree toggle's little switch.
fn switch(on: bool) -> impl IntoElement {
    div()
        .w(px(22.))
        .h(px(13.))
        .p(px(2.))
        .rounded_full()
        .bg(if on { rgb(YELLOW).into() } else { white(0.2) })
        .flex()
        .when(on, |d| d.justify_end())
        .child(div().size(px(9.)).rounded_full().bg(rgb(0x000000)))
}

/// The desktop's model menu: the agents on a track, the shortlist with each
/// row's effort beside it, and the hovered row's effort levels flying out.
fn model_menu(state: &Entity<Island>, island: &Island) -> impl IntoElement {
    const ROW: f32 = 26.;
    const TRACK: f32 = 30.;
    let p = &island.draft().picks;
    let list = p.shortlist();
    let picked = p.model_id();
    let hovered = island.draft().hovered_model.clone();
    let flyout = hovered.as_ref().and_then(|id| list.iter().position(|m| &m.id == id)).and_then(|i| {
        let m = list[i];
        (!m.efforts.is_empty()).then(|| {
            let current = p.effort_of(m);
            let model = m.id.clone();
            deferred(
                menu_card(140.)
                    .absolute()
                    .left(px(MODEL_MENU + 4.))
                    .top(px(4. + TRACK + i as f32 * ROW))
                    .children(m.efforts.iter().enumerate().map(|(n, level)| {
                        let (state, model, level) = (state.clone(), model.clone(), level.clone());
                        menu_row(("effort", n), newtask::effort_label(&level).to_string(), current.as_deref() == Some(level.as_str()))
                            .on_click(move |_, _, cx| {
                                state.update(cx, |island, cx| {
                                    let d = island.draft_mut();
                                    d.picks.pick_model(&model);
                                    d.picks.pick_effort(&model, &level);
                                    d.menu = None;
                                    d.want_focus = Some(Field::Typing);
                                    cx.notify();
                                })
                            })
                    })),
            )
            .with_priority(2)
        })
    });
    let track = div().h(px(TRACK)).flex().items_center().gap(px(4.)).px(px(4.)).children(
        p.agents.iter().filter(|a| a.available).enumerate().map(|(n, agent)| {
            let (state, harness) = (state.clone(), agent.harness.clone());
            let on = agent.harness == p.harness;
            div()
                .id(("agent", n))
                .px(px(8.))
                .h(px(22.))
                .flex()
                .items_center()
                .rounded_full()
                .text_size(px(ASIDE))
                .bg(white(if on { 0.2 } else { 0.06 }))
                .hover(|s| s.bg(white(0.14)))
                .child(agent.label.clone())
                .on_click(move |_, _, cx| {
                    let harness = harness.clone();
                    later(&state, cx, move |i, cx| {
                        i.update(cx, |island, cx| {
                            let d = island.draft_mut();
                            d.picks.pick_harness(&harness);
                            d.hovered_model = None;
                            cx.notify();
                        });
                        crate::load_models(i, cx);
                    })
                })
        }),
    );
    menu_card(MODEL_MENU)
        .relative()
        .child(track)
        .children(list.iter().enumerate().map(|(n, m)| {
            let (pick, hover) = (state.clone(), state.clone());
            let (id, hover_id) = (m.id.clone(), m.id.clone());
            let effort = p.effort_of(m).map(|e| newtask::effort_label(&e).to_string());
            div()
                .id(("model", n))
                .flex()
                .items_center()
                .gap_2()
                .px(px(8.))
                .h(px(ROW))
                .rounded(px(6.))
                .hover(|s| s.bg(white(0.1)))
                .child(div().flex_1().truncate().child(m.label.clone()))
                .children(effort.map(|e| div().text_color(white(0.4)).child(e)))
                .child(div().w(px(12.)).text_color(rgb(YELLOW)).child(if m.id == picked { "✓" } else { "" }))
                .on_hover(move |on, _, cx| {
                    if *on {
                        let id = hover_id.clone();
                        hover.update(cx, |island, cx| {
                            island.draft_mut().hovered_model = Some(id);
                            cx.notify();
                        })
                    }
                })
                .on_click(move |_, _, cx| {
                    pick.update(cx, |island, cx| {
                        let d = island.draft_mut();
                        d.picks.pick_model(&id);
                        d.menu = None;
                        d.want_focus = Some(Field::Typing);
                        cx.notify();
                    })
                })
        }))
        .when(list.is_empty(), |d| d.child(div().p(px(8.)).text_color(white(0.4)).child("No models")))
        .children(flyout)
}

/// The switcher: a search over the sessions, newest first, five rows in view.
fn switcher(state: &Entity<Island>, island: &Island, glass: bool, cx: &App) -> SwitcherCard {
    let d = island.draft();
    let current = d.session().map(str::to_string);
    let rows: Vec<(String, String, String, Option<Hsla>)> = island
        .listed(cx)
        .iter()
        .map(|s| (s.session_id.clone(), s.title.clone(), s.project().to_string(), lead_color(island, &s.session_id)))
        .collect();
    let empty = rows.is_empty();
    let state = state.clone();
    let search = d.search.clone();
    SwitcherCard { state, search, current, rows, empty, glass }
}

/// Held as its parts so the frame can put it above or below the card.
struct SwitcherCard {
    state: Entity<Island>,
    search: Entity<crate::input::TextInput>,
    current: Option<String>,
    rows: Vec<(String, String, String, Option<Hsla>)>,
    empty: bool,
    glass: bool,
}

impl IntoElement for SwitcherCard {
    type Element = gpui::AnyElement;

    fn into_element(self) -> Self::Element {
        div()
            .w_full()
            .flex()
            .flex_col()
            .bg(rgb(0x000000))
            .border_1()
            .border_color(white(0.12))
            .when(self.glass, |d| d.rounded(px(16.)).shadow(vec![shadow(gpui::hsla(0., 0., 0., 0.35), 5., 2.)]))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px(px(12.))
                    .py(px(10.))
                    .child(div().text_color(white(0.4)).child("⌕"))
                    .child(div().flex_1().min_w_0().child(self.search.clone()))
                    .child(hints("↑↓ navigate   ⏎ select")),
            )
            .child(
                div()
                    .id("switcher")
                    .max_h(px(5. * 32. + 14.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .px(px(6.))
                    .pb(px(6.))
                    .children(self.rows.into_iter().enumerate().map(|(n, (id, title, project, mark))| {
                        let on = self.current.as_deref() == Some(id.as_str());
                        let state = self.state.clone();
                        div()
                            .id(("task", n))
                            .flex_none()
                            .h(px(32.))
                            .px(px(10.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(8.))
                            .when(on, |d| d.bg(white(0.1)))
                            .hover(|s| s.bg(white(0.08)))
                            .children(mark.map(dot))
                            .child(div().flex_1().truncate().text_color(white(if on { 0.95 } else { 0.8 })).child(if title.is_empty() { "Untitled".to_string() } else { title }))
                            .child(div().flex_none().text_size(px(ASIDE)).text_color(white(0.35)).child(project))
                            .on_click(move |_, _, cx| {
                                let id = id.clone();
                                later(&state, cx, move |i, cx| crate::choose(i, Some(id), cx))
                            })
                    }))
                    .when(self.empty, |d| d.child(div().h(px(64.)).flex().items_center().justify_center().text_color(white(0.4)).child("No tasks"))),
            )
            .into_any_element()
    }
}

/// How many tasks wait on the reader. Resting the pointer on it opens the
/// cards, as does a click.
pub struct Pill {
    pub island: Entity<Island>,
}

impl Render for Pill {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let island = self.island.read(cx);
        let count = island.asks.attention().len();
        let text = format!("{count} {} attention", if count == 1 { "task needs" } else { "tasks need" });
        let (glass, top, glowing) = (island.glass, island.placement == Placement::Top, island.glowing);
        let open = self.island.clone();
        let fit = self.island.clone();
        let glow = gpui::rgb(WAITING);
        let face = div()
            .id("pill")
            .flex()
            .items_center()
            .gap_2()
            .px(px(16.))
            .py(px(10.))
            .when(glass && top, |d| d.min_w(px(200.)).justify_center())
            .bg(rgb(0x000000))
            .text_size(px(BODY))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(white(0.92))
            .map(|d| match (glass, top) {
                (true, true) => d.rounded_b(px(16.)),
                (true, false) => d.rounded(px(20.)),
                (false, _) => d,
            })
            .when(glowing, |d| {
                let edge = gpui::Hsla { a: 0.25, ..glow.into() };
                let d = if glass && top { d.border_l_1().border_r_1().border_b_1() } else { d.border_1() };
                d.border_color(edge).when(glass, |d| d.shadow(vec![shadow(gpui::Hsla { a: 0.45, ..glow.into() }, 5., 0.)]))
            })
            .child(div().size(px(6.)).rounded_full().bg(glow))
            .child(text)
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                let hovered = *hovered;
                later(&this.island, cx, move |i, cx| crate::pill_hovered(i, hovered, cx));
            }))
            .on_click(move |_, _, cx| {
                later(&open, cx, |i, cx| {
                    if i.read(cx).window.is_none() {
                        crate::open(i, cx);
                    }
                })
            });
        let frame = div()
            .flex_none()
            .relative()
            .flex()
            .when(glass, |d| d.px(px(ROOM)).pb(px(ROOM)).when(!top, |d| d.pt(px(ROOM))))
            .child(face)
            .when(glass && top, |d| {
                let black = gpui::hsla(0., 0., 0., 1.);
                d.child(ear(true, black)).child(ear(false, black))
            });
        div()
            // The window hugs the words: its first child is the frame.
            .on_children_prepainted(move |bounds, window, cx| {
                let Some(frame) = bounds.first() else { return };
                let (w, h) = (frame.size.width.as_f32().ceil(), frame.size.height.as_f32().ceil());
                let now = window.bounds().size;
                if (w - now.width.as_f32()).abs() > 1. || (h - now.height.as_f32()).abs() > 1. {
                    later(&fit, cx, move |i, cx| crate::fit(i, true, w, h, cx));
                }
            })
            .size_full()
            .flex()
            .flex_col()
            .items_start()
            .when(!glass, |d| d.bg(rgb(0x000000)))
            .child(frame)
    }
}
