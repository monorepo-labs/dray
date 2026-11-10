//! Dray Island on Linux: GPUI draws the panel, `server` keeps a socket to
//! This computer's `dray --serve`, and `x11` watches for the reader's
//! modifier tapped alone. See PLAN.md.

mod prefs;
mod server;
mod x11;

use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{
    App, Bounds, Context, Entity, FocusHandle, QuitMode, Hsla, KeyDownEvent, MouseButton, Window, WindowBackgroundAppearance,
    WindowBounds, WindowHandle, WindowKind, WindowOptions, div, prelude::*, px, rgb, size,
};
use prefs::Placement;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use server::{Session, Update};
use std::io::Read;

/// The Mac panel's composer width, so both islands read alike.
const WIDTH: f32 = 520.;
const HEIGHT: f32 = 128.;
/// Clear of the work area's edge, since there is no notch to hang from.
const GAP: f32 = 8.;
const YELLOW: u32 = 0xffd23f;

enum Msg {
    Tap,
    Server(Update),
    /// Dray quit: the island does not outlive it.
    Quit,
}

#[derive(Clone, Debug, Default)]
enum Link {
    #[default]
    Connecting,
    Up,
    Unreachable,
    Refused(String),
}

/// Everything the panel draws, kept apart from the window: the window is made
/// on each open and dropped on each close, and this lives for the process.
#[derive(Default)]
struct Island {
    link: Link,
    sessions: Vec<Session>,
    placement: Placement,
    window: Option<WindowHandle<Panel>>,
    /// The panel's X window and whoever had the keyboard before it took it.
    focus: Option<(u32, u32)>,
    menu: bool,
    server: Option<server::Server>,
}

impl Island {
    /// The session the panel is pinned to: the newest that is not hidden.
    /// The switcher and "last used" come with replying (stage 3).
    fn pinned(&self) -> Option<&Session> {
        self.sessions
            .iter()
            .filter(|s| s.hidden != Some(true) && s.archived != Some(true))
            .max_by(|a, b| a.modified.cmp(&b.modified))
    }

    fn apply(&mut self, update: Update) {
        match update {
            Update::Unreachable => self.link = Link::Unreachable,
            Update::Refused(why) => self.link = Link::Refused(why),
            Update::Sessions(list) => {
                self.link = Link::Up;
                self.sessions = list;
            }
            // A settle from the CLI arrives as a changed entry, archived.
            Update::Session(s) if s.archived == Some(true) => self.sessions.retain(|o| o.session_id != s.session_id),
            Update::Session(s) => match self.sessions.iter_mut().find(|o| o.session_id == s.session_id) {
                Some(old) => *old = s,
                None => self.sessions.push(s),
            },
            Update::Status { session_id, status, modified } => {
                if let Some(s) = self.sessions.iter_mut().find(|s| s.session_id == session_id) {
                    s.status = status;
                    if let Some(m) = modified {
                        s.modified = m;
                    }
                }
            }
            Update::Title { session_id, title } => {
                if let Some(s) = self.sessions.iter_mut().find(|s| s.session_id == session_id) {
                    s.title = title;
                }
            }
        }
    }
}

fn main() {
    let (tx, mut rx) = mpsc::unbounded::<Msg>();
    // Dray holds our stdin open for its life, so EOF is Dray gone however it
    // went — quit, crash or kill. Run by hand, the flag is left off.
    if std::env::args().any(|a| a == "--child") {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = std::io::stdin().read_to_end(&mut Vec::new());
            let _ = tx.unbounded_send(Msg::Quit);
        });
    }
    let taps = tx.clone();
    x11::watch_taps(move || {
        let _ = taps.unbounded_send(Msg::Tap);
    });
    let server = server::run(move |update| {
        let _ = tx.unbounded_send(Msg::Server(update));
    });

    // Off a Mac GPUI quits once its last window closes, and the panel's
    // window goes on every close.
    gpui_platform::application().with_quit_mode(QuitMode::Explicit).run(move |cx: &mut App| {
        let island = cx.new(|_| Island { placement: prefs::read().placement, server: Some(server), ..Default::default() });
        cx.spawn(async move |cx| {
            while let Some(msg) = rx.next().await {
                cx.update(|cx| match msg {
                    Msg::Tap => toggle(&island, cx),
                    Msg::Server(update) => island.update(cx, |island, cx| {
                        island.apply(update);
                        cx.notify();
                    }),
                    Msg::Quit => cx.quit(),
                });
            }
        })
        .detach();
    });
}

/// A tap opens the panel, and one on an open panel closes it — until
/// dictation lands (stage 4), when that second tap starts listening instead.
fn toggle(island: &Entity<Island>, cx: &mut App) {
    if island.read(cx).window.is_some() {
        close(island, cx);
    } else {
        open(island, cx);
    }
}

fn open(island: &Entity<Island>, cx: &mut App) {
    if let Some(server) = &island.read(cx).server {
        server.relist();
    }
    let placement = island.read(cx).placement;
    let bounds = place(placement, cx);
    let state = island.clone();
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: None,
            // Override-redirect on X11: the window manager neither frames,
            // moves nor focuses it, and it sits over every managed window.
            kind: WindowKind::PopUp,
            focus: true,
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: WindowBackgroundAppearance::Opaque,
            app_id: Some("dray-island".into()),
            ..Default::default()
        },
        move |window, cx| {
            let focus = cx.focus_handle();
            window.focus(&focus, cx);
            cx.new(|cx| {
                cx.observe(&state, |_, _, cx| cx.notify()).detach();
                Panel { island: state, focus }
            })
        },
    );
    let Ok(handle) = opened else {
        eprintln!("island: could not open the panel");
        return;
    };
    let focus = handle
        .update(cx, |_, window, _| x_window(window))
        .ok()
        .flatten()
        .and_then(|ours| Some((ours, x11::take_focus(ours)?)));
    island.update(cx, |island, cx| {
        island.window = Some(handle);
        island.focus = focus;
        island.menu = false;
        cx.notify();
    });
}

fn close(island: &Entity<Island>, cx: &mut App) {
    let (window, focus) = island.update(cx, |island, _| (island.window.take(), island.focus.take()));
    // Before the window goes, while the panel can still be asked whether it
    // holds the keyboard.
    if let Some((ours, before)) = focus {
        x11::give_back(ours, before);
    }
    if let Some(window) = window {
        let _ = window.update(cx, |_, window, _| window.remove_window());
    }
}

/// The panel's X window id, which GPUI hands out only as a raw handle.
fn x_window(window: &Window) -> Option<u32> {
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(h) => Some(h.window.get()),
        RawWindowHandle::Xlib(h) => u32::try_from(h.window).ok(),
        _ => None,
    }
}

/// Centred on the primary display, against the work area's top or bottom so
/// a panel bar or dock that reserves an edge is never covered.
fn place(placement: Placement, cx: &App) -> Bounds<gpui::Pixels> {
    let size = size(px(WIDTH), px(HEIGHT));
    let Some(display) = cx.primary_display() else {
        return Bounds::centered(None, size, cx);
    };
    let screen = display.bounds();
    // The work area is in X pixels and GPUI's bounds are logical.
    let scale = x11::screen_width().map_or(1., |w| w as f32 / screen.size.width.as_f32());
    let (top, bottom) = match x11::work_area() {
        Some((_, y, _, h)) => (
            px(y as f32 / scale).max(screen.top()),
            px((y + h) as f32 / scale).min(screen.bottom()),
        ),
        None => (screen.top(), screen.bottom()),
    };
    let x = screen.center().x - px(WIDTH / 2.);
    let y = match placement {
        Placement::Top => top + px(GAP),
        Placement::Bottom => bottom - px(HEIGHT + GAP),
    };
    Bounds::new(gpui::point(x, y), size)
}

/// Moves an open panel to the reader's pick, and keeps the pick.
fn set_placement(island: &Entity<Island>, placement: Placement, cx: &mut App) {
    prefs::set_placement(placement);
    island.update(cx, |island, _| island.placement = placement);
    // GPUI has no move for a window it made, so the panel is made again there.
    close(island, cx);
    open(island, cx);
}

struct Panel {
    island: Entity<Island>,
    focus: FocusHandle,
}

fn white(alpha: f32) -> Hsla {
    gpui::hsla(0., 0., 1., alpha)
}

impl Render for Panel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let island = self.island.read(cx);
        let key = prefs::read().key.label();
        let (title, detail, busy) = match (&island.link, island.pinned()) {
            (Link::Up, Some(s)) => (s.title.clone(), s.project().to_string(), s.status == "in_progress"),
            (Link::Up, None) => ("No tasks yet".into(), "Start one in Dray".into(), false),
            (Link::Connecting, _) => ("Connecting to Dray…".into(), String::new(), false),
            (Link::Unreachable, _) => ("Dray isn't running".into(), "Open Dray to reach your tasks".into(), false),
            (Link::Refused(why), _) => ("Dray turned the island away".into(), why.clone(), false),
        };
        let placement = island.placement;
        let menu = island.menu;
        let state = self.island.clone();

        let header = div()
            .flex()
            .items_center()
            .gap_2()
            .child(div().size(px(8.)).rounded_full().bg(if busy { rgb(YELLOW).into() } else { white(0.25) }))
            .child(div().flex_1().truncate().text_sm().text_color(white(0.92)).child(title))
            .child(div().text_xs().text_color(white(0.45)).child(detail));
        let composer = div()
            .flex()
            .items_center()
            .justify_between()
            .px_3()
            .py_2()
            .rounded_lg()
            .bg(white(0.06))
            .text_sm()
            .child(div().text_color(white(0.35)).child("Reply…"))
            .child(div().text_xs().text_color(white(0.3)).child(format!("Tap {key} to close · Esc")));

        let mut root = div()
            .id("panel")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .justify_center()
            .gap_3()
            .p_4()
            .bg(rgb(0x000000))
            .border_1()
            .border_color(white(0.12))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" {
                    let island = this.island.clone();
                    cx.defer(move |cx| close(&island, cx));
                }
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _, _, cx| {
                    this.island.update(cx, |island, cx| {
                        island.menu = !island.menu;
                        cx.notify();
                    });
                }),
            )
            .child(header)
            .child(composer);

        if menu {
            let item = |label: &'static str, pick: Placement| {
                let state = state.clone();
                div()
                    .id(label)
                    .px_3()
                    .py_1()
                    .rounded_md()
                    .text_sm()
                    .text_color(if pick == placement { rgb(YELLOW).into() } else { white(0.85) })
                    .hover(|s| s.bg(white(0.1)))
                    .child(label)
                    .on_click(move |_, _, cx| {
                        let state = state.clone();
                        cx.defer(move |cx| set_placement(&state, pick, cx));
                    })
            };
            root = root.child(
                div()
                    .absolute()
                    .right(px(12.))
                    .top(px(8.))
                    .flex()
                    .flex_col()
                    .p_1()
                    .rounded_lg()
                    .bg(rgb(0x1c1c1c))
                    .border_1()
                    .border_color(white(0.15))
                    .child(item("Top of screen", Placement::Top))
                    .child(item("Bottom of screen", Placement::Bottom)),
            );
        }
        root
    }
}
