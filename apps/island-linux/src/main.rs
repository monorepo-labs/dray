//! Dray Island on Linux: GPUI draws the panel and the pill, `server` keeps a
//! socket to This computer's `dray --serve`, and `x11` watches for the
//! reader's modifier tapped alone. See PLAN.md.

mod asks;
mod input;
mod panel;
mod prefs;
mod server;
mod sound;
mod x11;

use asks::{Ask, AskKind, Asks};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::{
    App, AppContext, Bounds, Entity, Pixels, QuitMode, Window, WindowBackgroundAppearance, WindowBounds,
    WindowHandle, WindowKind, WindowOptions, px, size,
};
use input::TextInput;
use panel::{Panel, Pill};
use prefs::Placement;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde_json::json;
use server::{Session, Update};
use std::io::Read;
use std::time::Duration;

/// The Mac panel's composer width, so both islands read alike.
pub const WIDTH: f32 = 520.;
/// The panel before it has measured what it draws.
const HEIGHT: f32 = 128.;
/// The pill before it has measured its words.
const PILL: (f32, f32) = (260., 40.);
/// Clear room around a see-through window for the card's shadow, and at the
/// top for the notch shape's flared ears: the Mac's `shadowRoom` and `ear`.
pub const ROOM: f32 = 12.;
/// Clear of a dock at the bottom when there is no room to stand off in.
const GAP: f32 = 8.;
/// How long a pointer rests on the pill before the cards open, as on the Mac.
const DWELL: Duration = Duration::from_millis(150);
/// How long the last answer's word stays before the panel closes.
const FLASH: Duration = Duration::from_millis(900);
/// How long news lights the pill's edge.
const GLOW: Duration = Duration::from_secs(2);

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

/// What the reader has done with the card on screen: which question, what
/// was picked or typed. Keyed on the ask, so answers never carry over.
#[derive(Default)]
pub struct Card {
    pub ask_id: String,
    pub index: usize,
    pub picks: Vec<Vec<String>>,
    pub inputs: Vec<Entity<TextInput>>,
    /// The free-text box is open; until clicked it is a button, so the card
    /// never opens with the caret in it and digits stay picks.
    pub editing: bool,
    pub show_command: bool,
    /// An answer is on its way.
    pub busy: bool,
}

/// Everything the panel and pill draw, kept apart from their windows: those
/// are made on each open and dropped on each close, and this lives for the
/// process.
#[derive(Default)]
pub struct Island {
    link: Link,
    sessions: Vec<Session>,
    placement: Placement,
    window: Option<WindowHandle<Panel>>,
    /// The panel's X window, and whoever had the keyboard before it took it.
    focus: Option<(u32, u32)>,
    x_window: Option<u32>,
    pill_x_window: Option<u32>,
    /// A compositor runs, so windows can be see-through and the card drawn
    /// in its Mac shape with its shadow. Read at each open.
    pub glass: bool,
    pub menu: bool,
    server: Option<server::Server>,
    pub asks: Asks,
    pill: Option<WindowHandle<Pill>>,
    /// The session whose card is up, picked from the list; the oldest when unpicked.
    pub ask_tab: Option<String>,
    /// The waiting sessions drawn as a list in place of the card.
    pub listed: bool,
    pub card: Card,
    /// The last answer's word, drawn while the panel closes on it.
    pub flash: Option<&'static str>,
    /// Counts flashes, so a timer closes only on the one it was started for.
    flash_clock: u64,
    /// Why the last answer did not land.
    pub notice: Option<String>,
    pub glowing: bool,
    glow_clock: u64,
    pill_hovered: bool,
    hover_clock: u64,
}

impl Island {
    /// The session the panel is pinned to: the newest that is not hidden.
    /// The switcher and "last used" come with replying (stage 3).
    pub fn pinned(&self) -> Option<&Session> {
        self.sessions
            .iter()
            .filter(|s| s.hidden != Some(true) && s.archived != Some(true))
            .max_by(|a, b| a.modified.cmp(&b.modified))
    }

    pub fn title(&self, session_id: &str) -> String {
        self.sessions
            .iter()
            .find(|s| s.session_id == session_id)
            .map(|s| s.title.clone())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "Session".into())
    }

    /// The card the panel draws: the picked session's oldest ask, so
    /// answering one moves to the next.
    pub fn current(&self) -> Option<(String, Ask)> {
        let keys = self.asks.attention();
        let key = self.ask_tab.clone().filter(|k| keys.contains(k)).or_else(|| keys.first().cloned())?;
        let ask = (*self.asks.waiting(&key).first()?).clone();
        Some((key, ask))
    }

    fn status_of(&self, session_id: &str) -> Option<&str> {
        self.sessions.iter().find(|s| s.session_id == session_id).map(|s| s.status.as_str())
    }

    /// Applies one update; `true` where an ask arrived that the island had
    /// not seen, which is news.
    fn apply(&mut self, update: Update) -> bool {
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
                let ended = status != "in_progress";
                if let Some(s) = self.sessions.iter_mut().find(|s| s.session_id == session_id) {
                    s.status = status;
                    if let Some(m) = modified {
                        s.modified = m;
                    }
                }
                if ended {
                    self.asks.strand(&session_id);
                }
            }
            Update::Title { session_id, title } => {
                if let Some(s) = self.sessions.iter_mut().find(|s| s.session_id == session_id) {
                    s.title = title;
                }
            }
            Update::Live { asks, tasks } => return self.asks.replace(asks, tasks),
            Update::Asked(ask) => return self.asks.add(ask),
            Update::Decided { session_id, request_id } => self.asks.decided(&session_id, &request_id),
            Update::Tasks { session_id, count } => {
                let busy = self.status_of(&session_id) == Some("in_progress");
                self.asks.set_tasks(&session_id, count, busy);
            }
        }
        false
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
        input::bind_keys(cx);
        let island = cx.new(|_| Island { placement: prefs::read().placement, server: Some(server), ..Default::default() });
        cx.spawn(async move |cx| {
            while let Some(msg) = rx.next().await {
                cx.update(|cx| match msg {
                    Msg::Tap => toggle(&island, cx),
                    Msg::Server(update) => {
                        let had_cards = !island.read(cx).asks.attention().is_empty();
                        let fresh = island.update(cx, |island, _| island.apply(update));
                        asks_changed(&island, fresh, had_cards, cx);
                    }
                    Msg::Quit => {
                        sound::forget();
                        cx.quit();
                    }
                });
            }
        })
        .detach();
    });
}

/// After the asks moved: news is announced on a shut panel, the last card
/// answered elsewhere closes the panel it was on, and the pill and card follow.
fn asks_changed(island: &Entity<Island>, fresh: bool, had_cards: bool, cx: &mut App) {
    let (open, empty, flashing) = {
        let i = island.read(cx);
        (i.window.is_some(), i.asks.attention().is_empty(), i.flash.is_some())
    };
    if fresh && !open {
        announce(island, cx);
    }
    if empty && had_cards && open && !flashing {
        close(island, cx);
    }
    island.update(cx, |island, cx| {
        if island.asks.attention().len() < 2 {
            island.listed = false;
        }
        cx.notify();
    });
    sync_card(island, cx);
    sync_pill(island, cx);
}

/// News reaching a shut panel: the pill's edge lit for a moment, and the
/// chime unless Dray's own window is in front, which sounds its own.
fn announce(island: &Entity<Island>, cx: &mut App) {
    if !x11::dray_in_front() {
        sound::chime();
    }
    let clock = island.update(cx, |island, cx| {
        island.glowing = true;
        island.glow_clock += 1;
        cx.notify();
        island.glow_clock
    });
    let island = island.clone();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(GLOW).await;
        cx.update(|cx| {
            island.update(cx, |island, cx| {
                if island.glow_clock == clock {
                    island.glowing = false;
                    cx.notify();
                }
            })
        });
    })
    .detach();
}

/// Resets the card's state when the card on screen is a different ask.
fn sync_card(island: &Entity<Island>, cx: &mut App) {
    let Some((_, ask)) = island.read(cx).current() else { return };
    if island.read(cx).card.ask_id == ask.id {
        return;
    }
    let count = match &ask.kind {
        AskKind::Questions(qs) => qs.len(),
        AskKind::Permission(_) => 0,
    };
    let inputs = (0..count).map(|_| cx.new(|cx| TextInput::new("Something else…", cx))).collect();
    island.update(cx, |island, cx| {
        island.card = Card { ask_id: ask.id, picks: vec![Vec::new(); count], inputs, ..Default::default() };
        cx.notify();
    });
}

/// The pill is up while cards wait and the panel is shut.
fn sync_pill(island: &Entity<Island>, cx: &mut App) {
    let (want, has, placement) = {
        let i = island.read(cx);
        (i.window.is_none() && !i.asks.attention().is_empty(), i.pill.is_some(), i.placement)
    };
    if want && !has {
        let glass = x11::compositing();
        island.update(cx, |island, _| island.glass = glass);
        let bounds = place(placement, PILL.0, PILL.1, glass, cx);
        let state = island.clone();
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: None,
                kind: WindowKind::PopUp,
                // Drawn, never focused: a pill must not take the keys from
                // the app being typed in.
                focus: false,
                is_movable: false,
                is_resizable: false,
                is_minimizable: false,
                window_background: background(glass),
                app_id: Some("dray-island".into()),
                ..Default::default()
            },
            move |_, cx| {
                cx.new(|cx| {
                    cx.observe(&state, |_, _, cx| cx.notify()).detach();
                    Pill { island: state }
                })
            },
        );
        if let Ok(pill) = opened {
            let xid = pill.update(cx, |_, window, _| x_window(window)).ok().flatten();
            island.update(cx, |island, _| {
                island.pill = Some(pill);
                island.pill_x_window = xid;
            });
        }
    } else if !want && has {
        let pill = island.update(cx, |island, _| {
            island.pill_hovered = false;
            island.pill_x_window = None;
            island.pill.take()
        });
        if let Some(pill) = pill {
            let _ = pill.update(cx, |_, window, _| window.remove_window());
        }
    }
}

/// The pointer on the pill: the cards open once it has rested there.
pub fn pill_hovered(island: &Entity<Island>, hovered: bool, cx: &mut App) {
    let clock = island.update(cx, |island, _| {
        island.pill_hovered = hovered;
        island.hover_clock += 1;
        island.hover_clock
    });
    if !hovered {
        return;
    }
    let island = island.clone();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(DWELL).await;
        cx.update(|cx| {
            let i = island.read(cx);
            if i.pill_hovered && i.hover_clock == clock && i.window.is_none() {
                open(&island, cx);
            }
        });
    })
    .detach();
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
    sync_card(island, cx);
    let glass = x11::compositing();
    island.update(cx, |island, _| island.glass = glass);
    let placement = island.read(cx).placement;
    let bounds = place(placement, panel_width(glass), HEIGHT, glass, cx);
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
            window_background: background(glass),
            app_id: Some("dray-island".into()),
            ..Default::default()
        },
        move |window, cx| {
            let focus = cx.focus_handle();
            window.focus(&focus, cx);
            cx.new(|cx| {
                cx.observe(&state, |_, _, cx| cx.notify()).detach();
                Panel::new(state, focus)
            })
        },
    );
    let Ok(handle) = opened else {
        eprintln!("island: could not open the panel");
        return;
    };
    let ours = handle.update(cx, |_, window, _| x_window(window)).ok().flatten();
    let focus = ours.and_then(|ours| Some((ours, x11::take_focus(ours)?)));
    island.update(cx, |island, cx| {
        island.window = Some(handle);
        island.x_window = ours;
        island.focus = focus;
        island.menu = false;
        cx.notify();
    });
    sync_pill(island, cx);
}

pub fn close(island: &Entity<Island>, cx: &mut App) {
    let (window, focus) = island.update(cx, |island, cx| {
        // The text box's focus goes with the window, so it reopens as the
        // button showing what was typed; a click takes the keyboard back.
        island.card.editing = false;
        island.listed = false;
        island.flash = None;
        island.notice = None;
        island.ask_tab = None;
        island.x_window = None;
        cx.notify();
        (island.window.take(), island.focus.take())
    });
    // Before the window goes, while the panel can still be asked whether it
    // holds the keyboard.
    if let Some((ours, before)) = focus {
        x11::give_back(ours, before);
    }
    if let Some(window) = window {
        let _ = window.update(cx, |_, window, _| window.remove_window());
    }
    sync_pill(island, cx);
}

/// The panel's X window id, which GPUI hands out only as a raw handle.
fn x_window(window: &Window) -> Option<u32> {
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(h) => Some(h.window.get()),
        RawWindowHandle::Xlib(h) => u32::try_from(h.window).ok(),
        _ => None,
    }
}

/// X pixels per GPUI pixel: the work area is in the former, bounds in the latter.
fn scale(cx: &App) -> f32 {
    let Some(display) = cx.primary_display() else { return 1. };
    x11::screen_width().map_or(1., |w| w as f32 / display.bounds().size.width.as_f32())
}

fn background(glass: bool) -> WindowBackgroundAppearance {
    if glass { WindowBackgroundAppearance::Transparent } else { WindowBackgroundAppearance::Opaque }
}

/// The panel window's width: the card, and the room beside it when clear.
fn panel_width(glass: bool) -> f32 {
    if glass { WIDTH + 2. * ROOM } else { WIDTH }
}

/// Centred on the primary display, against the work area's top or bottom so
/// a panel bar or dock that reserves an edge is never covered. At the top it
/// hangs flush from the bar, as the Mac's hangs from the notch.
fn place(placement: Placement, width: f32, height: f32, glass: bool, cx: &App) -> Bounds<Pixels> {
    let size = size(px(width), px(height));
    let Some(display) = cx.primary_display() else {
        return Bounds::centered(None, size, cx);
    };
    let screen = display.bounds();
    let scale = scale(cx);
    let (top, bottom) = match x11::work_area() {
        Some((_, y, _, h)) => (
            px(y as f32 / scale).max(screen.top()),
            px((y + h) as f32 / scale).min(screen.bottom()),
        ),
        None => (screen.top(), screen.bottom()),
    };
    let x = screen.center().x - px(width / 2.);
    let y = match placement {
        Placement::Top => top,
        // A clear window stands off by its own shadow room.
        Placement::Bottom => bottom - px(height + if glass { 0. } else { GAP }),
    };
    Bounds::new(gpui::point(x, y), size)
}

/// Fits the open panel, or the pill, to what it draws, keeping it against
/// its edge: at the bottom it grows upward.
pub fn fit(island: &Entity<Island>, pill: bool, width: f32, height: f32, cx: &mut App) {
    let (xid, placement, glass) = {
        let i = island.read(cx);
        (if pill { i.pill_x_window } else { i.x_window }, i.placement, i.glass)
    };
    let Some(xid) = xid else { return };
    let height = height.min(work_height(cx));
    let bounds = place(placement, width, height, glass, cx);
    let s = scale(cx);
    let at = |p: Pixels| (p.as_f32() * s).round() as i32;
    x11::configure(xid, at(bounds.origin.x), at(bounds.origin.y), at(bounds.size.width), at(bounds.size.height));
}

/// The work area's height in GPUI pixels, which a window never outgrows.
pub fn work_height(cx: &App) -> f32 {
    let screen = cx.primary_display().map(|d| d.bounds().size.height.as_f32()).unwrap_or(f32::MAX);
    x11::work_area().map_or(screen, |(_, _, _, h)| (h as f32 / scale(cx)).min(screen))
}

/// Moves an open panel to the reader's pick, and keeps the pick.
pub fn set_placement(island: &Entity<Island>, placement: Placement, cx: &mut App) {
    prefs::set_placement(placement);
    island.update(cx, |island, _| island.placement = placement);
    // GPUI has no move for a window it made, so the panel is made again there.
    close(island, cx);
    open(island, cx);
}

/// Puts one session's cards away unanswered, or every session's with none
/// named. They still wait in Dray, and the next new ask brings them back.
pub fn dismiss(island: &Entity<Island>, session_id: Option<String>, cx: &mut App) {
    let empty = island.update(cx, |island, cx| {
        island.asks.dismiss(session_id.as_deref());
        if session_id.is_none() || island.ask_tab == session_id {
            island.ask_tab = None;
        }
        island.listed = false;
        cx.notify();
        island.asks.attention().is_empty()
    });
    if empty {
        close(island, cx);
    }
    sync_card(island, cx);
    sync_pill(island, cx);
}

/// Picks a session's card from the list.
pub fn pick(island: &Entity<Island>, session_id: String, cx: &mut App) {
    island.update(cx, |island, cx| {
        island.ask_tab = Some(session_id);
        island.listed = false;
        cx.notify();
    });
    sync_card(island, cx);
}

/// Opens a session in Dray's window and puts the panel away.
pub fn show_in_app(island: &Entity<Island>, session_id: String, cx: &mut App) {
    let Some(reply) = island.read(cx).server.as_ref().map(|s| s.call("show_session", json!({ "sessionId": session_id })))
    else {
        return;
    };
    let island = island.clone();
    cx.spawn(async move |cx| {
        let answer = reply.await.unwrap_or_else(|_| Err("No answer from Dray.".into()));
        cx.update(|cx| match answer {
            Ok(_) => close(&island, cx),
            Err(why) => island.update(cx, |island, cx| {
                island.notice = Some(why);
                cx.notify();
            }),
        });
    })
    .detach();
}

/// Answers the card on screen with a permission option.
pub fn respond(island: &Entity<Island>, option_id: String, cx: &mut App) {
    let Some((key, ask)) = island.read(cx).current() else { return };
    let AskKind::Permission(p) = &ask.kind else { return };
    let Some(option) = p.options.iter().find(|o| o.id == option_id) else { return };
    let label = asks::answered_label(option);
    let args = json!({ "sessionId": key, "requestId": ask.request_id, "optionId": option_id });
    send_answer(island, key, ask, "respond_permission", args, label, cx);
}

/// Answers the card on screen's questions with what was picked and typed.
pub fn answer(island: &Entity<Island>, cx: &mut App) {
    let Some((key, ask)) = island.read(cx).current() else { return };
    let AskKind::Questions(questions) = &ask.kind else { return };
    let (picks, typed) = {
        let card = &island.read(cx).card;
        (card.picks.clone(), card.inputs.iter().map(|i| i.read(cx).text().to_string()).collect::<Vec<_>>())
    };
    let answers = asks::answers(questions, &picks, &typed);
    let args = json!({ "sessionId": key, "requestId": ask.request_id, "answers": answers });
    send_answer(island, key, ask, "answer_questions", args, "Sent", cx);
}

/// Sends an answer. The last card says what was done, then the panel
/// closes; an answer that did not land leaves the card, with the reason.
fn send_answer(
    island: &Entity<Island>,
    key: String,
    ask: Ask,
    cmd: &str,
    args: serde_json::Value,
    label: &'static str,
    cx: &mut App,
) {
    let reply = island.update(cx, |island, cx| {
        if island.card.busy || island.server.is_none() {
            return None;
        }
        let last = island.asks.attention() == [key.clone()] && island.asks.waiting(&key).len() == 1;
        island.card.busy = true;
        island.notice = None;
        let flash = last.then(|| {
            island.flash = Some(label);
            island.flash_clock += 1;
            sound::send();
            island.flash_clock
        });
        cx.notify();
        Some((island.server.as_ref()?.call(cmd, args), flash))
    });
    let Some((reply, flash)) = reply else { return };
    let island = island.clone();
    cx.spawn(async move |cx| {
        let answer = reply.await.unwrap_or_else(|_| Err("No answer from Dray.".into()));
        let landed = answer.is_ok();
        cx.update(|cx| {
            let had_cards = !island.read(cx).asks.attention().is_empty();
            island.update(cx, |island, cx| {
                island.card.busy = false;
                match answer {
                    // The server's own `permission_decided` follows; retiring
                    // it now keeps the card from lingering until it does.
                    Ok(_) => island.asks.decided(&key, &ask.request_id),
                    Err(why) => {
                        island.flash = None;
                        island.notice = Some(why);
                    }
                }
                cx.notify();
            });
            asks_changed(&island, false, had_cards, cx);
        });
        // Only an answer that drew the flash closes on it.
        let Some(clock) = flash.filter(|_| landed) else { return };
        cx.background_executor().timer(FLASH).await;
        cx.update(|cx| {
            let (flashing, empty) = {
                let i = island.read(cx);
                (i.flash.is_some() && i.flash_clock == clock, i.asks.attention().is_empty())
            };
            if flashing && empty {
                close(&island, cx);
            } else if flashing {
                island.update(cx, |island, cx| {
                    island.flash = None;
                    cx.notify();
                });
            }
        });
    })
    .detach();
}
