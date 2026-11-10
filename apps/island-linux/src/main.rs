//! Dray Island on Linux: GPUI draws the panel and the pill, `server` keeps a
//! socket to This computer's `dray --serve`, and `x11` watches for the
//! reader's modifier tapped alone. See PLAN.md.

mod asks;
mod capture;
mod draft;
mod input;
mod newtask;
mod orb;
mod overlay;
mod panel;
mod prefs;
mod server;
mod sound;
mod x11;

use asks::{Ask, AskKind, Asks};
use draft::{Draft, Field, Pinned, Target};
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
    /// The screenshot key.
    Capture,
    /// Shift alone held, or let go: the pen armed while dictating.
    Shift(bool),
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
    /// Made at start, since its text boxes need the app: always `Some` after.
    draft: Option<Draft>,
    /// The pill opened the panel, whose whole point is the cards: they show
    /// even over a draft under way.
    pub cards_first: bool,
    /// Asking Dray which session its window has open, before the panel shows.
    asking_app: bool,
    /// A tap landed while asking: the double tap that opens listening.
    dictate_on_open: bool,
    /// The orb's motion, one for the process, as the Mac's `OrbClock` is.
    pub motion: orb::Motion,
    /// The orb's last frame, kept to draw again while it holds still and to
    /// drop from the window's atlas once replaced.
    pub orb_image: Option<(u32, std::sync::Arc<gpui::RenderImage>)>,
    pub retired_images: Vec<std::sync::Arc<gpui::RenderImage>>,
    /// The pointer is on the orb, which shows the clock beside it.
    pub orb_hovered: bool,
    /// The panel's layout, the reader's pick from the right-click menu.
    pub mode: prefs::Mode,
    /// A screenshot under way: its overlay's state, and the run around it.
    pub shooting: Option<overlay::Shooting>,
    shot: Option<ShotRun>,
    /// Ink on the live screen while dictating, and its overlay.
    pub inking: Option<overlay::Inking>,
    ink_window: Option<(WindowHandle<overlay::InkOverlay>, Option<u32>)>,
    /// The full screen the ink is drawn over where there is no compositor.
    ink_still: Option<image::RgbaImage>,
    /// The moment being drawn: the row held for it and the cut placing the
    /// words said before it.
    moment: Option<Moment>,
    rest_clock: u64,
    /// "Hold Shift to draw" in the recording tools, for a reader's first
    /// dictations, until the first stroke.
    pub draw_hint: bool,
    /// The pointer is on the camera, which shows its key beside it.
    pub camera_hovered: bool,
}

/// One screenshot's run: the row held for it, whether dictation was
/// recording (the panel stays up over the overlay) or the panel was open
/// (it steps aside and comes back), and the cut placing words said before it.
struct ShotRun {
    slot: u64,
    recording: bool,
    was_open: bool,
    cut: Option<futures::channel::oneshot::Receiver<()>>,
    window: Option<(WindowHandle<overlay::CaptureOverlay>, Option<u32>)>,
    /// Whoever had the keyboard before the overlay took it.
    focus_before: Option<u32>,
}

struct Moment {
    slot: u64,
    cut: Option<futures::channel::oneshot::Receiver<()>>,
}

impl Island {
    pub fn draft(&self) -> &Draft {
        self.draft.as_ref().expect("made at start")
    }

    pub fn draft_mut(&mut self) -> &mut Draft {
        self.draft.as_mut().expect("made at start")
    }

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.session_id == id)
    }

    /// The switcher's rows for the search typed so far.
    pub fn listed(&self, cx: &App) -> Vec<&Session> {
        draft::listed(&self.sessions, self.draft().search.read(cx).text(), &draft::stale_line())
    }

    /// The card the panel draws in place of the draft: held back while the
    /// reader is busy in it, unless they came for the cards.
    pub fn card_up(&self, cx: &App) -> Option<(String, Ask)> {
        if self.flash.is_some() || (!self.cards_first && self.draft().busy(cx)) {
            return None;
        }
        self.current()
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
    // `--orb-png <dir>`: the orb's reference frames as PNGs, for setting the
    // port beside the Mac's captures. No window, no server.
    let args: Vec<String> = std::env::args().collect();
    if let Some(dir) = args.iter().position(|a| a == "--orb-png").and_then(|i| args.get(i + 1)) {
        return orb::write_references(std::path::Path::new(dir)).expect("orb frames written");
    }
    // `--orb-csv <uniforms.csv> <size> <scale> <dir>`: the Mac reference's rows.
    if let Some(i) = args.iter().position(|a| a == "--orb-csv")
        && let [csv, size, scale, dir] = &args[i + 1..(i + 5).min(args.len())]
    {
        let (size, scale) = (size.parse().expect("a size in points"), scale.parse().expect("a scale"));
        return orb::write_from_csv(std::path::Path::new(csv), size, scale, std::path::Path::new(dir)).expect("orb frames written");
    }
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
    let (taps, shots, shift) = (tx.clone(), tx.clone(), tx.clone());
    x11::watch_taps(
        move || {
            let _ = taps.unbounded_send(Msg::Tap);
        },
        move || {
            let _ = shots.unbounded_send(Msg::Capture);
        },
        move |armed| {
            let _ = shift.unbounded_send(Msg::Shift(armed));
        },
    );
    let server = server::run(move |update| {
        let _ = tx.unbounded_send(Msg::Server(update));
    });

    // Off a Mac GPUI quits once its last window closes, and the panel's
    // window goes on every close.
    gpui_platform::application().with_quit_mode(QuitMode::Explicit).run(move |cx: &mut App| {
        input::bind_keys(cx);
        let draft = Draft::new(cx);
        let island = cx.new(|_| Island {
            placement: prefs::read().placement,
            mode: prefs::read().mode,
            server: Some(server),
            draft: Some(draft),
            ..Default::default()
        });
        cx.spawn(async move |cx| {
            while let Some(msg) = rx.next().await {
                cx.update(|cx| match msg {
                    Msg::Tap => toggle(&island, cx),
                    Msg::Capture => start_capture(&island, cx),
                    Msg::Shift(armed) => set_armed(&island, armed, cx),
                    Msg::Server(update) => {
                        let had_cards = !island.read(cx).asks.attention().is_empty();
                        let fresh = island.update(cx, |island, _| island.apply(update));
                        asks_changed(&island, fresh, had_cards, cx);
                    }
                    Msg::Quit => {
                        sound::forget();
                        // Throws away what is being said, as quitting the Mac's does.
                        if island.read(cx).draft().dictation != orb::Dictation::Idle
                            && let Some(server) = &island.read(cx).server
                        {
                            let _ = server.call("cancel_transcription", json!({}));
                        }
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
    // Not while the reader is busy in the draft — dictating, or writing: a
    // card answered elsewhere leaves them to it, as on the Mac.
    if empty && had_cards && open && !flashing && !island.read(cx).draft().busy(cx) {
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
        (i.window.is_none() && !i.asks.attention().is_empty() && i.shot.is_none(), i.pill.is_some(), i.placement)
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
                open_cards(&island, cx);
            }
        });
    })
    .detach();
}

/// A tap opens the panel, and one on an open panel closes it — until
/// dictation lands (stage 4), when that second tap starts listening instead.
/// The reader's tap: it opens the panel, and on an open panel starts or
/// stops dictating, so a double tap opens it listening. Under Sent the panel
/// is on its way out, so a tap keeps it open rather than dictating.
fn toggle(island: &Entity<Island>, cx: &mut App) {
    let (shown, asking, flashing) = {
        let i = island.read(cx);
        (i.window.is_some(), i.asking_app, i.flash.is_some())
    };
    if shown && flashing {
        island.update(cx, |island, cx| {
            island.flash = None;
            island.flash_clock += 1;
            cx.notify();
        });
    } else if shown {
        toggle_dictation(island, cx);
    } else if asking {
        // The panel is on its way up, so this is the tap that dictates.
        island.update(cx, |island, _| island.dictate_on_open = !island.dictate_on_open);
    } else {
        open(island, cx);
    }
}

pub fn toggle_dictation(island: &Entity<Island>, cx: &mut App) {
    match island.read(cx).draft().dictation {
        orb::Dictation::Recording => stop_dictation(island, false, cx),
        orb::Dictation::Idle => start_dictation(island, cx),
        _ => {}
    }
}


fn call(island: &Entity<Island>, cmd: &str, args: serde_json::Value, cx: &App) -> Option<futures::channel::oneshot::Receiver<server::Reply>> {
    island.read(cx).server.as_ref().map(|s| s.call(cmd, args))
}

/// Through the server to Dray's own recorder and model: one place sets up
/// dictation — model, microphone, mute — and the server forwards these to the
/// app over `host_call`. A server with no app answers "Open Dray to dictate".
pub fn start_dictation(island: &Entity<Island>, cx: &mut App) {
    let d = island.read(cx).draft();
    if d.dictation != orb::Dictation::Idle || d.start_pending {
        return;
    }
    let Some(reply) = call(island, "start_transcription", json!({}), cx) else { return };
    let run = island.update(cx, |island, cx| {
        island.notice = None;
        // The pill opened the panel on its cards; dictating is the reader
        // turning to the draft, so the orb and its clock must show.
        island.cards_first = false;
        let d = island.draft_mut();
        d.run += 1;
        d.start_pending = true;
        d.dictation = orb::Dictation::Starting;
        d.list_shown = false;
        d.menu = None;
        // The box leaves the panel while listening — gone in compact, hidden
        // in expanded — so its keys go to the panel, where ⏎ and Ctrl+Esc are
        // read; the box takes them back once the words land.
        d.want_focus = Some(Field::Panel);
        cx.notify();
        d.run
    });
    let island = island.clone();
    cx.spawn(async move |cx| {
        let answer = wait(reply, cx).await;
        cx.update(|cx| {
            island.update(cx, |island, _| island.draft_mut().start_pending = false);
            // Cancelled while it opened: a start that took is closed again.
            // `start_pending` kept any newer start from going out until now,
            // so this cancel can only close this run's own recording.
            let d = island.read(cx).draft();
            if d.run != run || d.dictation != orb::Dictation::Starting {
                if matches!(answer, Ok(serde_json::Value::Null)) {
                    let _ = call(&island, "cancel_transcription", json!({}), cx);
                }
                return;
            }
            let refusal = match &answer {
                Ok(serde_json::Value::Null) => None,
                Ok(v) => Some(match v.get("kind").and_then(|k| k.as_str()) {
                    Some("needsModel") => "Pick a dictation model in Dray → Settings → Transcription.".to_string(),
                    _ => "Dray needs the microphone.".to_string(),
                }),
                Err(why) => Some(why.clone()),
            };
            match refusal {
                Some(why) => island.update(cx, |island, cx| {
                    let d = island.draft_mut();
                    d.dictation = orb::Dictation::Idle;
                    d.want_focus = Some(Field::Typing);
                    island.notice = Some(why);
                    cx.notify();
                }),
                None => {
                    island.update(cx, |island, cx| {
                        let d = island.draft_mut();
                        d.dictation = orb::Dictation::Recording;
                        d.recording_since = Some(std::time::Instant::now());
                        cx.notify();
                    });
                    sound::dictation_started();
                    poll_level(&island, cx);
                    start_annotation(&island, cx);
                }
            }
        });
    })
    .detach();
}

/// The microphone's level, polled rather than pushed, as the app's own
/// composer reads it: a missed reading is a dropped frame.
fn poll_level(island: &Entity<Island>, cx: &mut App) {
    let island = island.clone();
    cx.spawn(async move |cx| {
        loop {
            let reply = cx.update(|cx| {
                (island.read(cx).draft().dictation == orb::Dictation::Recording)
                    .then(|| call(&island, "transcription_level", json!({}), cx))
                    .flatten()
            });
            let Some(reply) = reply else { break };
            let peak = wait(reply, cx).await.ok().and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            cx.update(|cx| island.update(cx, |island, _| island.draft_mut().peak = peak));
            cx.background_executor().timer(Duration::from_millis(50)).await;
        }
        cx.update(|cx| island.update(cx, |island, _| island.draft_mut().peak = 0.0));
    })
    .detach();
}

/// Stops and transcribes; the words become a row. `then_send` is a send that
/// waited on the words still being said, and goes once they have landed.
pub fn stop_dictation(island: &Entity<Island>, then_send: bool, cx: &mut App) {
    if island.read(cx).draft().dictation != orb::Dictation::Recording {
        return;
    }
    // A send waiting on the words goes where the reader pressed ⏎ with what
    // was there then, whatever they pick or write while the model works.
    if then_send && !pin(island, true, cx) {
        return;
    }
    transcribe(island, "stop_transcription", json!({}), then_send, cx);
}

/// Holds the send as it stands at ⏎ in the draft until what it waits on has
/// landed. The box's text joins it as a row of its own, and the box empties:
/// what is typed next is not this message's. A send already waiting for the
/// same task takes the new rows in; one waiting for another refuses, as one
/// pin is all there is and the rows must not go to the wrong task.
fn pin(island: &Entity<Island>, awaiting_words: bool, cx: &mut App) -> bool {
    let clash = island.read(cx).draft().pinned.as_ref().is_some_and(|p| p.target != island.read(cx).draft().target);
    if clash {
        island.update(cx, |island, cx| {
            island.notice = Some("The last message is still waiting on its screenshot.".into());
            cx.notify();
        });
        return false;
    }
    let typing = island.read(cx).draft().typing.clone();
    let text = typing.read(cx).text().trim().to_string();
    if !text.is_empty() {
        island.update(cx, |island, cx| island.draft_mut().add_row(&text, cx));
        typing.update(cx, |t, cx| t.clear(cx));
    }
    island.update(cx, |island, cx| {
        let d = island.draft_mut();
        let rows: Vec<u64> = d.rows.iter().map(|r| r.id).collect();
        let target = d.target.clone();
        let p = d.pinned.get_or_insert(Pinned { target, rows: Vec::new(), awaiting_words: false });
        let fresh: Vec<u64> = rows.into_iter().filter(|id| !p.rows.contains(id)).collect();
        p.rows.extend(fresh);
        p.awaiting_words |= awaiting_words;
        cx.notify();
    });
    true
}

/// Whether any of `ids` is a screenshot or moment still landing.
fn landing(d: &Draft, ids: &[u64]) -> bool {
    d.rows.iter().any(|r| r.pending && ids.contains(&r.id))
}

/// Something a waiting send held for has landed: it goes once its words
/// are in and no screenshot or moment is still landing.
fn release_send(island: &Entity<Island>, cx: &mut App) {
    let d = island.read(cx).draft();
    // One request at a time: a send still running releases this one when done.
    if d.sending || d.pinned.as_ref().is_none_or(|p| p.awaiting_words || landing(d, &p.rows)) {
        return;
    }
    if let Some(pinned) = island.update(cx, |island, _| island.draft_mut().pinned.take()) {
        send_to_target(island, Some(pinned), cx);
    }
}

/// Runs the model again over the recording a failed run kept, so the words
/// need not be said twice.
pub fn retry_dictation(island: &Entity<Island>, cx: &mut App) {
    let Some(path) = island.read(cx).draft().retry_path.clone() else { return };
    if island.read(cx).draft().dictation != orb::Dictation::Idle {
        return;
    }
    transcribe(island, "retry_transcription", json!({ "path": path }), false, cx);
}

/// How long the model may take over a long recording.
const TRANSCRIBE_WITHIN: Duration = Duration::from_secs(180);

fn transcribe(island: &Entity<Island>, cmd: &str, args: serde_json::Value, then_send: bool, cx: &mut App) {
    let Some(reply) = call(island, cmd, args, cx) else { return };
    // The microphone closes, and the screen with it: a moment still being
    // drawn is taken first.
    end_annotation(island, cx);
    let run = island.update(cx, |island, cx| {
        island.notice = None;
        let d = island.draft_mut();
        // A retry is a run of its own; a stop finishes the run it stops.
        if d.dictation == orb::Dictation::Idle {
            d.run += 1;
        }
        d.dictation = orb::Dictation::Transcribing;
        d.recording_since = None;
        cx.notify();
        d.run
    });
    let island = island.clone();
    cx.spawn(async move |cx| {
        let timer = cx.background_executor().timer(TRANSCRIBE_WITHIN);
        let answer = match futures::future::select(reply, Box::pin(timer)).await {
            futures::future::Either::Left((answer, _)) => answer.unwrap_or_else(|_| Err("No answer from Dray.".into())),
            futures::future::Either::Right(_) => Err("Dray didn't answer in time.".into()),
        };
        cx.update(|cx| {
            // Thrown away meanwhile: its words, its state and its send are void.
            if island.read(cx).draft().run != run {
                return;
            }
            let (placed, row) = island.update(cx, |island, cx| {
                let placed = place_words(island, answer, cx);
                let d = island.draft_mut();
                d.dictation = orb::Dictation::Idle;
                d.want_focus = Some(Field::Typing);
                cx.notify();
                placed
            });
            if then_send {
                // A failed run keeps the draft open, its notice and Retry
                // with it, so the send waits for the reader again.
                island.update(cx, |island, _| {
                    let d = island.draft_mut();
                    if !placed {
                        d.pinned = None;
                    } else if let Some(p) = d.pinned.as_mut() {
                        p.rows.extend(row);
                        p.awaiting_words = false;
                    }
                });
                release_send(&island, cx);
            }
        });
    })
    .detach();
}

/// Whether the model answered: words become a row, every other outcome a
/// notice, and a failure keeps its recording for Retry.
fn place_words(island: &mut Island, answer: server::Reply, cx: &mut App) -> (bool, Option<u64>) {
    let outcome = match answer {
        Ok(v) => v,
        // Nothing was read or deleted: whatever Retry held still stands.
        Err(why) => {
            island.notice = Some(why);
            return (false, None);
        }
    };
    let mut row = None;
    let value = outcome.get("value").cloned().unwrap_or_default();
    let (notice, ok) = match outcome.get("kind").and_then(|k| k.as_str()) {
        Some("text") => {
            let text = value.as_str().unwrap_or_default().trim().to_string();
            if !text.is_empty() {
                row = Some(island.draft_mut().add_said(&text, cx));
                sound::dictation_stopped();
            }
            (None, true)
        }
        Some("empty") => (Some("No words heard.".to_string()), true),
        Some("needsModel") => (Some("Pick a dictation model in Dray → Settings → Transcription.".to_string()), false),
        Some("noAudio") => (Some("Dray heard nothing. Check the microphone.".to_string()), false),
        _ => (Some(value.get("message").and_then(|m| m.as_str()).unwrap_or("Dictation failed.").to_string()), false),
    };
    island.notice = notice;
    let kept = value.get("audioPath").and_then(|p| p.as_str()).map(str::to_string);
    let d = island.draft_mut();
    if ok {
        d.retry_path = None;
    } else if kept.is_some() {
        d.retry_path = kept;
    }
    (ok, row)
}

/// Ctrl+Esc: throws away what is being said and puts the panel away, the
/// Mac's ⌘Esc.
pub fn cancel_dictation(island: &Entity<Island>, cx: &mut App) {
    throw_away(island, cx);
    close(island, cx);
}

/// Ends the current run unheard: the recorder is told, and any reply still
/// coming for it is ignored.
fn throw_away(island: &Entity<Island>, cx: &mut App) {
    if island.read(cx).draft().dictation == orb::Dictation::Idle {
        return;
    }
    end_annotation(island, cx);
    let _ = call(island, "cancel_transcription", json!({}), cx);
    island.update(cx, |island, cx| {
        let d = island.draft_mut();
        d.run += 1;
        d.thrown += 1;
        // A send waiting on these words is called off; its rows stay.
        d.pinned = None;
        d.dictation = orb::Dictation::Idle;
        d.recording_since = None;
        d.peak = 0.0;
        cx.notify();
    });
}

/// The reader's layout pick, kept and drawn at once.
pub fn set_mode(island: &Entity<Island>, mode: prefs::Mode, cx: &mut App) {
    prefs::set("mode", mode);
    island.update(cx, |island, cx| {
        island.mode = mode;
        island.menu = false;
        cx.notify();
    });
}

/// The pill: the panel, on the cards, whatever the draft holds.
pub fn open_cards(island: &Entity<Island>, cx: &mut App) {
    island.update(cx, |island, _| island.cards_first = true);
    open(island, cx);
}

/// A tap over Dray's window opens on the session that window has open, asked
/// before the panel shows so the title never flips under the reader. The app
/// answers nothing unless its window has focus, so every open asks, and gives
/// up after half a second.
pub fn open(island: &Entity<Island>, cx: &mut App) {
    if island.read(cx).asking_app || island.read(cx).window.is_some() {
        return;
    }
    let Some(reply) = island.read(cx).server.as_ref().map(|s| s.call("selected_session", json!({}))) else { return };
    island.update(cx, |island, _| island.asking_app = true);
    let island = island.clone();
    cx.spawn(async move |cx| {
        let timer = cx.background_executor().timer(Duration::from_millis(500));
        let picked = match futures::future::select(reply, Box::pin(timer)).await {
            futures::future::Either::Left((Ok(Ok(serde_json::Value::String(id))), _)) => Some(id),
            _ => None,
        };
        cx.update(|cx| {
            island.update(cx, |island, _| island.asking_app = false);
            if let Some(id) = picked.filter(|id| island.read(cx).session(id).is_some()) {
                pick_target(&island, Target::Session(id), cx);
            }
            show(&island, cx);
            if island.update(cx, |island, _| std::mem::take(&mut island.dictate_on_open)) {
                start_dictation(&island, cx);
            }
        });
    })
    .detach();
}

/// With nothing picked, or a pick gone from the index: the session last
/// used, else the newest, else a new task.
fn settle_target(island: &Entity<Island>, cx: &mut App) {
    let target = {
        let i = island.read(cx);
        let ok = match &i.draft().target {
            Some(Target::Session(id)) => i.session(id).is_some(),
            Some(Target::New) => true,
            None => false,
        };
        if ok {
            return;
        }
        let listed = i.listed(cx);
        let last: Option<String> = prefs::get("lastSession");
        listed
            .iter()
            .find(|s| Some(&s.session_id) == last.as_ref())
            .or(listed.first())
            .map(|s| Target::Session(s.session_id.clone()))
            .unwrap_or(Target::New)
    };
    pick_target(island, target, cx);
}

fn show(island: &Entity<Island>, cx: &mut App) {
    if island.read(cx).window.is_some() {
        return;
    }
    if let Some(server) = &island.read(cx).server {
        server.relist();
        // Counted by the server off this connection; nothing rides but the name.
        let _ = server.call("island_opened", json!({}));
    }
    settle_target(island, cx);
    let typing = island.read(cx).draft().typing.clone();
    typing.update(cx, |t, cx| t.set_placeholder(draft::placeholder(), cx));
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
        let field = if island.card_up(cx).is_some() { Field::Panel } else { Field::Typing };
        island.draft_mut().want_focus = Some(field);
        cx.notify();
    });
    sync_pill(island, cx);
}

pub fn close(island: &Entity<Island>, cx: &mut App) {
    if island.read(cx).draft().listening() {
        throw_away(island, cx);
    }
    let (window, focus) = island.update(cx, |island, cx| {
        // The text box's focus goes with the window, so it reopens as the
        // button showing what was typed; a click takes the keyboard back.
        island.card.editing = false;
        // A window going away under the pointer never hears it leave.
        island.camera_hovered = false;
        island.orb_hovered = false;
        island.listed = false;
        island.flash = None;
        island.notice = None;
        island.ask_tab = None;
        island.x_window = None;
        island.cards_first = false;
        let draft = island.draft_mut();
        draft.list_shown = false;
        draft.menu = None;
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
        let answer = wait(reply, cx).await;
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

/// How long a call may go unanswered before the reader is told: a server
/// stopped with its socket still open would otherwise hold a send forever.
const ANSWER_WITHIN: Duration = Duration::from_secs(30);

/// A call's answer, or the reason there is none.
async fn wait(reply: futures::channel::oneshot::Receiver<server::Reply>, cx: &mut gpui::AsyncApp) -> server::Reply {
    let timer = cx.background_executor().timer(ANSWER_WITHIN);
    match futures::future::select(reply, Box::pin(timer)).await {
        futures::future::Either::Left((answer, _)) => answer.unwrap_or_else(|_| Err("No answer from Dray.".into())),
        futures::future::Either::Right(_) => Err("Dray didn't answer in time.".into()),
    }
}

/// Says what was done and starts its clock; `after_flash` with the same
/// clock closes on it, or turns to a card still waiting.
fn start_flash(island: &mut Island, label: &'static str) -> u64 {
    island.flash = Some(label);
    island.flash_clock += 1;
    sound::send();
    island.flash_clock
}

async fn after_flash(island: &Entity<Island>, clock: u64, cx: &mut gpui::AsyncApp) {
    cx.background_executor().timer(FLASH).await;
    cx.update(|cx| {
        let (flashing, empty) = {
            let i = island.read(cx);
            (i.flash.is_some() && i.flash_clock == clock, i.asks.attention().is_empty())
        };
        // A waiting send can go while the reader dictates or writes the
        // next one; closing then would throw that away.
        let busy = island.read(cx).draft().busy(cx);
        if flashing && empty && !busy {
            close(island, cx);
        } else if flashing {
            island.update(cx, |island, cx| {
                island.flash = None;
                cx.notify();
            });
        }
    });
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
        let flash = last.then(|| start_flash(island, label));
        cx.notify();
        Some((island.server.as_ref()?.call(cmd, args), flash))
    });
    let Some((reply, flash)) = reply else { return };
    let island = island.clone();
    cx.spawn(async move |cx| {
        let answer = wait(reply, cx).await;
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
        after_flash(&island, clock, cx).await;
    })
    .detach();
}

/// Where the draft goes: a session, remembered as the last one used, or a
/// new task, whose lists are read fresh.
pub fn pick_target(island: &Entity<Island>, target: Target, cx: &mut App) {
    if let Target::Session(id) = &target {
        prefs::set("lastSession", id);
    }
    let new = target == Target::New;
    island.update(cx, |island, cx| {
        let draft = island.draft_mut();
        draft.target = Some(target);
        draft.menu = None;
        if new {
            draft.list_shown = false;
        }
        cx.notify();
    });
    if new {
        load_picks(island, cx);
    }
}

/// ↑/↓ through the switcher; opening it, either lands on its top row.
pub fn move_list(island: &Entity<Island>, delta: isize, cx: &mut App) {
    let next = {
        let i = island.read(cx);
        let list = i.listed(cx);
        if list.is_empty() {
            None
        } else {
            let opening = !i.draft().list_shown;
            let at = (!opening).then(|| i.draft().session().and_then(|id| list.iter().position(|s| s.session_id == id))).flatten();
            let next = at.map_or(0, |at| at.saturating_add_signed(delta).min(list.len() - 1));
            i.draft().list_scroll.scroll_to_item(next);
            Some(list[next].session_id.clone())
        }
    };
    island.update(cx, |island, cx| {
        island.draft_mut().list_shown = true;
        cx.notify();
    });
    if let Some(id) = next {
        pick_target(island, Target::Session(id), cx);
    }
}

/// Return in the switcher, or a click on a row: that session, then back to
/// the box. A search with no row picked takes its best match.
pub fn choose(island: &Entity<Island>, picked: Option<String>, cx: &mut App) {
    let target = picked.or_else(|| {
        let i = island.read(cx);
        let list = i.listed(cx);
        let held = i.draft().session().is_some_and(|id| list.iter().any(|s| s.session_id == id));
        (!held).then(|| list.first().map(|s| s.session_id.clone())).flatten()
    });
    if let Some(id) = target {
        pick_target(island, Target::Session(id), cx);
    }
    let search = island.read(cx).draft().search.clone();
    search.update(cx, |s, cx| s.clear(cx));
    island.update(cx, |island, cx| {
        let draft = island.draft_mut();
        draft.list_shown = false;
        draft.want_focus = Some(Field::Typing);
        cx.notify();
    });
}

/// Opens or closes the switcher; opened, the search takes the keys.
pub fn toggle_list(island: &Entity<Island>, cx: &mut App) {
    island.update(cx, |island, cx| {
        let draft = island.draft_mut();
        draft.list_shown = !draft.list_shown;
        draft.want_focus = Some(if draft.list_shown { Field::Search } else { Field::Typing });
        cx.notify();
    });
}

/// Ctrl+⏎: what is in the box becomes a row of the message.
pub fn add_typed(island: &Entity<Island>, cx: &mut App) {
    let typing = island.read(cx).draft().typing.clone();
    let text = typing.read(cx).text().trim().to_string();
    if text.is_empty() {
        return;
    }
    island.update(cx, |island, cx| {
        island.draft_mut().add_row(&text, cx);
        cx.notify();
    });
    typing.update(cx, |t, cx| t.clear(cx));
}

pub fn remove_row(island: &Entity<Island>, id: u64, cx: &mut App) {
    island.update(cx, |island, cx| {
        island.draft_mut().rows.retain(|r| r.id != id);
        cx.notify();
    });
}

/// Every connected list a new task's bar reads, fresh on every new task:
/// projects get attached in Dray.
pub fn load_picks(island: &Entity<Island>, cx: &mut App) {
    let Some((projects, agents)) = island
        .read(cx)
        .server
        .as_ref()
        .map(|s| (s.call("list_projects", json!({})), s.call("agent_availability", json!({}))))
    else {
        return;
    };
    let island = island.clone();
    cx.spawn(async move |cx| {
        let (projects, agents) = futures::join!(projects, agents);
        let read = |r: Result<server::Reply, _>| r.ok().and_then(Result::ok);
        let (projects, agents) = (read(projects), read(agents));
        cx.update(|cx| {
            island.update(cx, |island, cx| {
                let projects = projects.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
                let agents = agents.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
                island.draft_mut().picks.take(projects, agents);
                cx.notify();
            });
            load_models(&island, cx);
        });
    })
    .detach();
}

/// The picked agent's models, read once per run: a failure caches nothing.
pub fn load_models(island: &Entity<Island>, cx: &mut App) {
    let harness = island.read(cx).draft().picks.harness.clone();
    if island.read(cx).draft().picks.models.contains_key(&harness) {
        return;
    }
    let Some(reply) = island.read(cx).server.as_ref().map(|s| s.call("list_models", json!({ "harness": harness })))
    else {
        return;
    };
    let island = island.clone();
    cx.spawn(async move |cx| {
        let Ok(Ok(list)) = reply.await else { return };
        let Ok(list) = serde_json::from_value::<Vec<newtask::Model>>(list) else { return };
        cx.update(|cx| {
            island.update(cx, |island, cx| {
                island.draft_mut().picks.models.insert(harness, list);
                cx.notify();
            })
        });
    })
    .detach();
}

/// Picks a project, stamped on the server as Dray's own pick is, so the next
/// new task in either lands on it.
pub fn pick_project(island: &Entity<Island>, path: String, cx: &mut App) {
    if let Some(server) = &island.read(cx).server {
        let _ = server.call("set_last_selected_project", json!({ "path": path }));
    }
    island.update(cx, |island, cx| {
        let draft = island.draft_mut();
        draft.picks.project = Some(path);
        draft.menu = None;
        draft.want_focus = Some(Field::Typing);
        cx.notify();
    });
}

/// ⏎: the rows and the box as one prompt, to the session picked or as a new
/// task. Sent is said at once and the request runs behind it; a send that
/// fails comes back as the draft, with the reason.
pub fn send(island: &Entity<Island>, cx: &mut App) {
    send_to_target(island, None, cx);
}

/// `send`, to `pinned` where a send waited on dictation, else to the task
/// picked now.
fn send_to_target(island: &Entity<Island>, pinned: Option<Pinned>, cx: &mut App) {
    // A pinned send's rows are fixed, so a recording started since is
    // neither its business nor stopped by it.
    if pinned.is_none() {
        match island.read(cx).draft().dictation {
            orb::Dictation::Recording => return stop_dictation(island, true, cx),
            orb::Dictation::Idle => {}
            _ => return,
        }
    }
    // This send's rows: a pinned one's own, else every row no waiting send
    // holds, so a second ⏎ sends what came after without waiting on the first.
    let own: Vec<u64> = match &pinned {
        Some(p) => p.rows.clone(),
        None => {
            let d = island.read(cx).draft();
            let waiting = d.pinned.as_ref().map(|p| p.rows.clone()).unwrap_or_default();
            d.rows.iter().map(|r| r.id).filter(|id| !waiting.contains(id)).collect()
        }
    };
    // A screenshot or moment still landing is part of this message: the send
    // waits for it, holding the rows as they are now.
    if landing(island.read(cx).draft(), &own) {
        match pinned {
            Some(p) => island.update(cx, |island, _| island.draft_mut().pinned = Some(p)),
            None => {
                pin(island, false, cx);
            }
        }
        return;
    }
    let (target, rows, typing, picks) = {
        let i = island.read(cx);
        let d = i.draft();
        // A pinned send reads only its own rows, never the box or rows
        // written since ⏎.
        let (rows, typing) = match &pinned {
            Some(_) => (d.snapshot(Some(&own), cx), String::new()),
            None => (d.snapshot(Some(&own), cx), d.typing.read(cx).text().to_string()),
        };
        let p = &d.picks;
        let picks = json!({
            "harness": p.harness,
            "model": p.model_id(),
            "effort": p.effort(),
            "permissionMode": p.stance(),
            "cwd": p.project,
            "useWorktree": p.worktree(),
        });
        let target = match &pinned {
            Some(p) => p.target.clone(),
            None => d.target.clone(),
        };
        (target, rows, typing, picks)
    };
    let (text, files) = draft::compose(&rows, &typing);
    let Some(target) = target else { return };
    // An image alone is a message, as in Dray's own composer; a screenshot
    // still being taken is not yet one.
    if (text.is_empty() && files.is_empty()) || island.read(cx).draft().sending {
        return;
    }
    if target == Target::New && picks["cwd"].is_null() {
        island.update(cx, |island, cx| {
            island.notice = Some("Pick a project first.".into());
            cx.notify();
        });
        return;
    }
    // The message leaves the draft whole first, so nothing typed after
    // Return can join it; a pinned one takes only what it held.
    let typing_box = island.read(cx).draft().typing.clone();
    if pinned.is_none() {
        typing_box.update(cx, |t, cx| t.clear(cx));
    }
    let clock = island.update(cx, |island, cx| {
        // A waiting send goes on its own, often as another fails; that
        // failure's notice is the reader's to read, not this send's to clear.
        if pinned.is_none() {
            island.notice = None;
        }
        let draft = island.draft_mut();
        draft.rows.retain(|r| !own.contains(&r.id));
        draft.sending = true;
        draft.list_shown = false;
        draft.menu = None;
        cx.notify();
        start_flash(island, "Sent")
    });
    // The panel closes on Sent's own clock while the request runs behind
    // it; a failure brings the draft back up.
    let flashing = island.clone();
    cx.spawn(async move |cx| after_flash(&flashing, clock, cx).await).detach();
    let island = island.clone();
    let server = |cx: &mut App, cmd: &str, args: serde_json::Value| island.read(cx).server.as_ref().map(|s| s.call(cmd, args));
    let fresh = match &target {
        Target::Session(id) => server(cx, "get_session_by_id", json!({ "sessionId": id, "turns": 0 })),
        Target::New => None,
    };
    let send_new = match &target {
        Target::New => {
            let id = draft::new_session_id();
            let mut args = picks.clone();
            args["sessionId"] = json!(id);
            args["prompt"] = json!(text);
            args["fast"] = json!(false);
            // No branch picker here, so the server reads the checkout's own.
            args["branch"] = serde_json::Value::Null;
            args["worktreeName"] = serde_json::Value::Null;
            args["baseRef"] = serde_json::Value::Null;
            args["attachmentPaths"] = json!(files);
            args["isNewSession"] = json!(true);
            server(cx, "send_msg", args).map(|reply| (id, reply))
        }
        Target::Session(_) => None,
    };
    let state = island.clone();
    cx.spawn(async move |cx| {
        let outcome: Result<String, String> = match (&target, fresh, send_new) {
            (Target::Session(id), Some(fresh), _) => {
                // The session's own settings, read fresh, as the phone's reply does.
                match wait(fresh, cx).await {
                    Ok(item) => match serde_json::from_value::<Session>(item) {
                        Ok(s) => {
                            let args = json!({
                                "sessionId": id, "prompt": text, "attachmentPaths": files,
                                "harness": s.harness, "model": s.model, "effort": s.effort,
                                "permissionMode": s.permission_mode, "fast": s.fast.unwrap_or(false),
                                "cwd": s.cwd, "branch": null, "useWorktree": false,
                                "worktreeName": null, "baseRef": null, "isNewSession": false,
                            });
                            match cx.update(|cx| state.read(cx).server.as_ref().map(|s| s.call("send_msg", args))) {
                                Some(reply) => wait(reply, cx).await.map(|_| id.clone()),
                                None => Err("Dray's server isn't reachable.".into()),
                            }
                        }
                        Err(_) => Err("That task is gone.".into()),
                    },
                    Err(why) => Err(why),
                }
            }
            (Target::New, _, Some((id, reply))) => {
                wait(reply, cx).await.map(|_| id)
            }
            _ => Err("Dray's server isn't reachable.".into()),
        };
        cx.update(|cx| {
            match outcome {
                Ok(id) => {
                    state.update(cx, |island, _| island.draft_mut().sending = false);
                    // A pick made while the request ran is the reader's, and outranks this one.
                    if state.read(cx).draft().target.as_ref() == Some(&target) {
                        pick_target(&state, Target::Session(id), cx);
                    } else {
                        prefs::set("lastSession", &id);
                    }
                }
                Err(why) => restore(&state, rows, typing, target, why, cx),
            }
            // A send that came ready while this one ran goes now.
            release_send(&state, cx);
        });
    })
    .detach();
}

/// A send that failed behind its Sent comes back as the draft, on the target
/// it was for, the panel open on it. Anything written since stays after it,
/// in order: the failed box text becomes a row ahead of newer rows. A draft
/// begun since for somewhere else is the reader's and is left alone, so the
/// failed message goes to the clipboard instead, as on the Mac.
fn restore(island: &Entity<Island>, rows: Vec<draft::RowData>, typing: String, target: Target, why: String, cx: &mut App) {
    let typing_box = island.read(cx).draft().typing.clone();
    let now = typing_box.read(cx).text().to_string();
    let (same, empty) = {
        let d = island.read(cx).draft();
        (d.target.as_ref() == Some(&target), d.rows.is_empty() && now.trim().is_empty())
    };
    let mut why = why;
    if empty {
        typing_box.update(cx, |t, cx| t.set_text(&typing, cx));
    } else if !same {
        // Each file as its path, since a label like `[Image 1]` would lose it.
        let parts: Vec<String> = rows.iter().map(|r| r.file.clone().unwrap_or_else(|| r.text.clone())).collect();
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(draft::prompt(&parts, &typing)));
        why.push_str(" The message is on the clipboard.");
    }
    island.update(cx, |island, cx| {
        island.flash = None;
        let draft = island.draft_mut();
        draft.sending = false;
        if same || empty {
            draft.target = Some(target);
            let held = std::mem::take(&mut draft.rows);
            draft.restore_rows(&rows, cx);
            if !empty && !typing.trim().is_empty() {
                draft.add_row(&typing, cx);
            }
            draft.rows.extend(held);
        }
        cx.notify();
    });
    if island.read(cx).window.is_none() {
        show(island, cx);
    }
    // Last: opening the panel clears it.
    island.update(cx, |island, cx| {
        island.notice = Some(why);
        cx.notify();
    });
}

/// What one window of ours is in X: its id, read through the raw handle.
fn x_of<V: 'static>(window: &WindowHandle<V>, cx: &mut App) -> Option<u32> {
    window.update(cx, |_, window, _| x_window(window)).ok().flatten()
}

/// The primary display's whole area, in GPUI's logical pixels.
fn screen_bounds(cx: &App) -> Bounds<Pixels> {
    cx.primary_display().map(|d| d.bounds()).unwrap_or_else(|| Bounds::centered(None, size(px(1280.), px(800.)), cx))
}

fn overlay_options(glass: bool, focus: bool, cx: &App) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(screen_bounds(cx))),
        titlebar: None,
        kind: WindowKind::PopUp,
        focus,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        window_background: background(glass),
        app_id: Some("dray-island".into()),
        ..Default::default()
    }
}

/// The words said so far, cut off into a row just ahead of `before`, with
/// the microphone left open: a screenshot or a moment of ink lands where it
/// was taken in the speech. Answers once the words are placed.
fn cut_dictation(island: &Entity<Island>, before: u64, cx: &mut App) -> Option<futures::channel::oneshot::Receiver<()>> {
    let reply = call(island, "cut_transcription", json!({}), cx)?;
    let thrown = island.read(cx).draft().thrown;
    let (done, placed) = futures::channel::oneshot::channel();
    let island = island.clone();
    cx.spawn(async move |cx| {
        let timer = cx.background_executor().timer(TRANSCRIBE_WITHIN);
        let answer = match futures::future::select(reply, Box::pin(timer)).await {
            futures::future::Either::Left((answer, _)) => answer.unwrap_or_else(|_| Err("No answer from Dray.".into())),
            futures::future::Either::Right(_) => Err("Dray didn't answer in time.".into()),
        };
        cx.update(|cx| {
            island.update(cx, |island, cx| {
                // Thrown away meanwhile: its words are void, as a stop's are.
                if island.draft().thrown != thrown {
                    return;
                }
                match answer {
                    Ok(o) => match o.get("kind").and_then(|k| k.as_str()) {
                        Some("text") => {
                            let text = o.get("value").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
                            if !text.is_empty() {
                                island.draft_mut().add_said_before(&text, before, cx);
                            }
                        }
                        // Silence before the shot is ordinary, so it says nothing.
                        Some("empty" | "noAudio") => {}
                        _ => {
                            let message = o.get("value").and_then(|v| v.get("message")).and_then(|m| m.as_str());
                            island.notice = Some(message.unwrap_or("Speech before a screenshot didn't transcribe.").to_string());
                        }
                    },
                    Err(why) => island.notice = Some(why),
                }
                cx.notify();
            })
        });
        let _ = done.send(());
    })
    .detach();
    Some(placed)
}

/// The camera, or the screenshot key: a clear overlay over the screen as it
/// is now, where a dragged region is the shot. While dictating, the words so
/// far are cut ahead of it with the microphone left open, and the panel stays
/// up over the overlay; otherwise the panel steps aside and comes back.
pub fn start_capture(island: &Entity<Island>, cx: &mut App) {
    let (busy, dictation, open) = {
        let i = island.read(cx);
        (i.shot.is_some(), i.draft().dictation, i.window.is_some())
    };
    // Claimed here, before the first wait: a second press while the first is
    // still reading the screen would otherwise start a second overlay.
    if busy || !matches!(dictation, orb::Dictation::Idle | orb::Dictation::Recording) {
        return;
    }
    let recording = dictation == orb::Dictation::Recording;
    let slot = island.update(cx, |island, cx| island.draft_mut().reserve_shot(cx));
    let cut = if recording { cut_dictation(island, slot, cx) } else { None };
    island.update(cx, |island, _| {
        island.shot = Some(ShotRun { slot, recording, was_open: open, cut, window: None, focus_before: None });
        island.camera_hovered = false;
    });
    let hidden = hide_own(island, recording, open, cx);
    sync_pill(island, cx);
    let island = island.clone();
    cx.spawn(async move |cx| {
        // The windows going away is a repaint for the apps under them.
        cx.background_executor().timer(Duration::from_millis(150)).await;
        let still = x11::screen_size().and_then(|(w, h)| x11::capture(0, 0, w, h));
        cx.update(|cx| {
            show_own(&hidden);
            let Some(still) = still else {
                island.update(cx, |island, _| island.notice = Some("Couldn't read the screen.".into()));
                return end_capture(&island, None, cx);
            };
            let scale = scale(cx);
            let image = overlay::render_image(&still);
            island.update(cx, |island, _| {
                island.shooting = Some(overlay::Shooting::new(capture::Marking::new(still), image, scale));
            });
            let state = island.clone();
            let opened = cx.open_window(overlay_options(false, true, cx), move |window, cx| {
                let focus = cx.focus_handle();
                window.focus(&focus, cx);
                cx.new(|_| overlay::CaptureOverlay::new(state, focus))
            });
            let Ok(handle) = opened else {
                return end_capture(&island, None, cx);
            };
            let xid = x_of(&handle, cx);
            let before = xid.and_then(x11::take_focus);
            island.update(cx, |island, _| {
                if let Some(run) = island.shot.as_mut() {
                    run.window = Some((handle, xid));
                    run.focus_before = before;
                }
            });
            // Dictation stays in sight and in reach, over the overlay.
            if recording && let Some(id) = island.read(cx).x_window {
                x11::raise(id);
            }
        });
    })
    .detach();
}

/// The island's own windows taken off the screen for a read of it: the
/// Mac's capture leaves its app's windows out, X11 cannot. Answers what to
/// put back.
fn hide_own(island: &Entity<Island>, recording: bool, open: bool, cx: &mut App) -> Hidden {
    let mut ids = Vec::new();
    if recording || !open {
        let i = island.read(cx);
        ids.extend(i.x_window);
        ids.extend(i.ink_window.as_ref().and_then(|w| w.1));
        ids.extend(i.pill_x_window);
    } else {
        close(island, cx);
    }
    unmap_own(ids)
}

/// Our windows off the screen for a read of it, and which held the keyboard.
struct Hidden {
    ids: Vec<u32>,
    focused: Option<u32>,
}

fn unmap_own(ids: Vec<u32>) -> Hidden {
    let focus = x11::focus();
    let focused = focus.filter(|f| ids.contains(f));
    for id in &ids {
        x11::unmap(*id);
    }
    Hidden { ids, focused }
}

/// Puts them back. An unmapped window loses the keyboard to whatever is
/// under it, so the one that held it takes it back, or ⏎ goes to that app.
fn show_own(hidden: &Hidden) {
    for id in &hidden.ids {
        x11::map(*id);
    }
    if let Some(id) = hidden.focused {
        let _ = x11::take_focus(id);
    }
}

/// Done or Cancel on the screenshot's overlay.
pub fn finish_capture(island: &Entity<Island>, done: bool, cx: &mut App) {
    let shot = island.update(cx, |island, _| {
        let s = island.shooting.take()?;
        let image = if done { s.marking.done() } else { None };
        Some((image, s.marking.region, s.scale))
    });
    let Some((image, region, scale)) = shot else { return };
    end_capture(island, image.map(|i| (i, region.unwrap_or_default(), scale)), cx);
}

/// Puts the screen back, and the shot into the place held for it: the
/// picture flies from where it was taken into the panel first.
fn end_capture(island: &Entity<Island>, shot: Option<(image::RgbaImage, capture::Rect, f32)>, cx: &mut App) {
    let Some(run) = island.update(cx, |island, _| island.shot.take()) else { return };
    island.update(cx, |island, _| island.shooting = None);
    if let Some((window, _)) = run.window {
        let _ = window.update(cx, |_, window, _| window.remove_window());
    }
    if run.recording {
        // The keys go back to the panel, which dictation is still in.
        if let Some(id) = island.read(cx).x_window {
            x11::raise(id);
            let _ = x11::take_focus(id);
        }
    } else {
        if let Some(before) = run.focus_before {
            x11::refocus(before);
        }
        if run.was_open {
            show(island, cx);
        }
    }
    sync_pill(island, cx);
    let written = shot.as_ref().map(|(image, _, _)| capture::write(image));
    let island = island.clone();
    cx.spawn(async move |cx| {
        let path = match written {
            Some(Ok(path)) => Some(path.to_string_lossy().to_string()),
            Some(Err(err)) => {
                cx.update(|cx| island.update(cx, |island, _| island.notice = Some(format!("Couldn't save the screenshot: {err}"))));
                None
            }
            None => None,
        };
        if let (Some((image, region, scale)), Some(_)) = (&shot, &path) {
            fly(&island, image, *region, *scale, cx).await;
        }
        // The cut transcribes while the overlay is up; its words go first.
        if let Some(cut) = run.cut {
            let _ = cut.await;
        }
        cx.update(|cx| {
            island.update(cx, |island, cx| {
                island.draft_mut().fill_shot(run.slot, path.as_deref());
                cx.notify();
            });
            release_send(&island, cx);
        });
    })
    .detach();
}

/// The picture shrinks from where it was taken into the panel, or into its
/// edge of the screen while the panel is away, so the reader sees where it
/// went: the Mac's `Capture.fly`, half a second, eased.
async fn fly(island: &Entity<Island>, image: &image::RgbaImage, region: capture::Rect, scale: f32, cx: &mut gpui::AsyncApp) {
    let from = (region.0 / scale, region.1 / scale, region.2.max(1.) / scale, region.3.max(1.) / scale);
    let k = (96. / from.2).min(72. / from.3).min(1.);
    let to_size = (from.2 * k, from.3 * k);
    let target = cx.update(|cx| {
        let screen = screen_bounds(cx);
        let i = island.read(cx);
        let (cx_, top) = (screen.center().x.as_f32(), i.placement == Placement::Top);
        let y = match (top, i.window.is_some()) {
            (true, true) => screen.top().as_f32() + 70.,
            (true, false) => screen.top().as_f32() + 20.,
            (false, true) => screen.bottom().as_f32() - 120.,
            (false, false) => screen.bottom().as_f32() - 40.,
        };
        (cx_, y)
    });
    let rendered = overlay::render_image(image);
    let opened = cx.update(|cx| {
        let mut options = overlay_options(false, false, cx);
        options.window_bounds = Some(WindowBounds::Windowed(Bounds::new(gpui::point(px(from.0), px(from.1)), size(px(from.2), px(from.3)))));
        cx.open_window(options, move |_, cx| cx.new(|_| overlay::Flight { image: rendered }))
    });
    let Ok(handle) = opened else { return };
    let xid = cx.update(|cx| x_of(&handle, cx));
    let started = std::time::Instant::now();
    loop {
        let t = (started.elapsed().as_secs_f32() / 0.5).min(1.);
        let e = orb::bezier_curve(t, 0.3, 0.0, 0.2, 1.0);
        let w = from.2 + (to_size.0 - from.2) * e;
        let h = from.3 + (to_size.1 - from.3) * e;
        let x = (from.0 + from.2 / 2.) + (target.0 - (from.0 + from.2 / 2.)) * e - w / 2.;
        let y = (from.1 + from.3 / 2.) + (target.1 - (from.1 + from.3 / 2.)) * e - h / 2.;
        if let Some(id) = xid {
            let at = |v: f32| (v * scale).round() as i32;
            x11::configure(id, at(x), at(y), at(w).max(1), at(h).max(1));
        }
        if t >= 1. {
            break;
        }
        cx.background_executor().timer(Duration::from_millis(16)).await;
    }
    cx.update(|cx| {
        let _ = handle.update(cx, |_, window, _| window.remove_window());
    });
}

/// Drawing on the screen is part of dictating: the ink's overlay is up while
/// the microphone records, letting the mouse through until Shift is held.
/// With no compositor there is nothing to see through, so the overlay waits
/// for Shift and then shows the screen as it was.
fn start_annotation(island: &Entity<Island>, cx: &mut App) {
    if island.read(cx).inking.is_some() {
        return;
    }
    // "Hold Shift to draw" until the first stroke, for the first five dictations.
    let hints: u32 = prefs::get("drawHints").unwrap_or(0);
    if hints < 5 {
        prefs::set("drawHints", hints + 1);
    }
    let scale = scale(cx);
    island.update(cx, |island, _| {
        island.inking = Some(overlay::Inking::new(scale));
        island.draw_hint = hints < 5;
    });
    if island.read(cx).glass {
        open_ink(island, cx);
        // ⇧ may already be down from before the microphone opened.
        if x11::shift_alone() {
            set_armed(island, true, cx);
        }
    }
}

fn open_ink(island: &Entity<Island>, cx: &mut App) {
    let glass = island.read(cx).glass;
    let state = island.clone();
    let Ok(handle) = cx.open_window(overlay_options(glass, false, cx), move |_, cx| cx.new(|_| overlay::InkOverlay { island: state })) else {
        return;
    };
    let xid = x_of(&handle, cx);
    if let Some(id) = xid {
        // The page under the ink keeps the mouse until the pen is armed.
        let armed = island.read(cx).inking.as_ref().is_some_and(|i| i.armed);
        x11::pass_mouse(id, !armed);
    }
    island.update(cx, |island, _| island.ink_window = Some((handle, xid)));
    if let Some(id) = island.read(cx).x_window {
        x11::raise(id);
    }
}

fn close_ink(island: &Entity<Island>, cx: &mut App) {
    if let Some((window, _)) = island.update(cx, |island, _| island.ink_window.take()) {
        let _ = window.update(cx, |_, window, _| window.remove_window());
    }
    island.update(cx, |island, _| island.ink_still = None);
}

/// Shift alone held or let go while dictating: the overlay takes the mouse
/// or lets it through. A stroke in progress keeps the mouse until it lets go.
fn set_armed(island: &Entity<Island>, armed: bool, cx: &mut App) {
    let Some(drawing) = island.update(cx, |island, cx| {
        let s = island.inking.as_mut()?;
        s.armed = armed;
        cx.notify();
        Some(s.drawing)
    }) else {
        return;
    };
    let (glass, ink) = {
        let i = island.read(cx);
        (i.glass, i.ink_window.as_ref().and_then(|w| w.1))
    };
    if glass {
        if let Some(id) = ink
            && !drawing
        {
            x11::pass_mouse(id, !armed);
        }
        return;
    }
    // No compositor: Shift freezes the screen to draw on.
    if armed && island.read(cx).ink_window.is_none() {
        let hidden = unmap_own(island.read(cx).x_window.into_iter().chain(island.read(cx).pill_x_window).collect());
        let island = island.clone();
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            let still = x11::screen_size().and_then(|(w, h)| x11::capture(0, 0, w, h));
            cx.update(|cx| {
                show_own(&hidden);
                let Some(still) = still else { return };
                let armed = island.read(cx).inking.as_ref().is_some_and(|s| s.armed);
                if !armed || island.read(cx).inking.is_none() {
                    return;
                }
                let image = overlay::render_image(&still);
                island.update(cx, |island, _| {
                    island.ink_still = Some(still);
                    if let Some(s) = island.inking.as_mut() {
                        s.still = Some(image);
                    }
                });
                open_ink(&island, cx);
            });
        })
        .detach();
    } else if !armed {
        idle_ink(island, cx);
    }
}

/// Without a compositor the frozen screen goes once nothing on it waits to
/// be taken and the pen is down.
fn idle_ink(island: &Entity<Island>, cx: &mut App) {
    let i = island.read(cx);
    if i.glass || i.moment.is_some() {
        return;
    }
    let quiet = i.inking.as_ref().is_some_and(|s| !s.armed && !s.drawing && s.marks.is_empty());
    if quiet {
        close_ink(island, cx);
        island.update(cx, |island, _| {
            if let Some(s) = island.inking.as_mut() {
                s.still = None;
            }
        });
    }
}

/// A stroke's first touch: strokes made close together are one moment, and
/// the first of one holds its place in the draft and cuts the words before it.
pub fn stroke_began(island: &Entity<Island>, cx: &mut App) {
    island.update(cx, |island, _| {
        island.rest_clock += 1;
        island.draw_hint = false;
    });
    if island.read(cx).moment.is_some() {
        return;
    }
    let slot = island.update(cx, |island, cx| island.draft_mut().reserve_shot(cx));
    let cut = cut_dictation(island, slot, cx);
    island.update(cx, |island, _| island.moment = Some(Moment { slot, cut }));
}

/// The pen lifted: once it has rested 1.5s, the moment is taken.
pub fn stroke_ended(island: &Entity<Island>, cx: &mut App) {
    let (glass, ink, armed) = {
        let i = island.read(cx);
        (i.glass, i.ink_window.as_ref().and_then(|w| w.1), i.inking.as_ref().is_some_and(|s| s.armed))
    };
    if glass && let Some(id) = ink {
        x11::pass_mouse(id, !armed);
    }
    let clock = island.update(cx, |island, _| {
        island.rest_clock += 1;
        island.rest_clock
    });
    let island = island.clone();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_millis(1500)).await;
        cx.update(|cx| {
            if island.read(cx).rest_clock == clock {
                take_moment(&island, cx);
            }
        });
    })
    .detach();
}

/// The moment's area with its ink, into the place held for it, and the ink
/// goes from the screen. Strokes begun after this belong to the next moment.
fn take_moment(island: &Entity<Island>, cx: &mut App) {
    let Some(moment) = island.update(cx, |island, _| island.moment.take()) else { return };
    let marks: Vec<capture::Mark> = island.update(cx, |island, cx| {
        let Some(s) = island.inking.as_mut() else { return Vec::new() };
        let taken: Vec<capture::Mark> = s.marks.iter().filter(|m| !s.claimed.contains(&m.id)).cloned().collect();
        s.claimed.extend(taken.iter().map(|m| m.id));
        cx.notify();
        taken
    });
    let area = x11::screen_size().and_then(|size| capture::moment_area(&marks, size));
    let glass = island.read(cx).glass;
    let still = island.read(cx).ink_still.clone();
    let hidden = if glass && area.is_some() {
        let i = island.read(cx);
        unmap_own(i.x_window.into_iter().chain(i.ink_window.as_ref().and_then(|w| w.1)).chain(i.pill_x_window).collect())
    } else {
        Hidden { ids: Vec::new(), focused: None }
    };
    let island = island.clone();
    cx.spawn(async move |cx| {
        let image = match (area, glass) {
            (Some(a), true) => {
                cx.background_executor().timer(Duration::from_millis(120)).await;
                let read = x11::capture(a.0 as i32, a.1 as i32, a.2 as u32, a.3 as u32);
                read.map(|r| {
                    let local: Vec<capture::Mark> =
                        marks.iter().map(|m| capture::Mark { id: m.id, points: m.points.iter().map(|p| (p.0 - a.0, p.1 - a.1)).collect() }).collect();
                    capture::inked(&r, &local, (0.0, 0.0, a.2, a.3))
                })
            }
            (Some(a), false) => still.as_ref().map(|s| capture::inked(s, &marks, a)),
            _ => None,
        };
        cx.update(|cx| {
            show_own(&hidden);
            if let Some(id) = island.read(cx).x_window {
                x11::raise(id);
            }
            island.update(cx, |island, cx| {
                if let Some(s) = island.inking.as_mut() {
                    let taken: Vec<u64> = marks.iter().map(|m| m.id).collect();
                    s.marks.retain(|m| !taken.contains(&m.id));
                    s.claimed.retain(|id| !taken.contains(id));
                }
                cx.notify();
            });
            idle_ink(&island, cx);
        });
        let written = image.as_ref().map(capture::write);
        let path = match written {
            Some(Ok(p)) => Some(p.to_string_lossy().to_string()),
            Some(Err(err)) => {
                cx.update(|cx| island.update(cx, |island, _| island.notice = Some(format!("Couldn't save the drawing: {err}"))));
                None
            }
            None => None,
        };
        if let (Some(image), Some(a), Some(_)) = (&image, area, &path) {
            let scale = cx.update(|cx| scale(cx));
            fly(&island, image, a, scale, cx).await;
        }
        if let Some(cut) = moment.cut {
            let _ = cut.await;
        }
        cx.update(|cx| {
            island.update(cx, |island, cx| {
                island.draft_mut().fill_shot(moment.slot, path.as_deref());
                cx.notify();
            });
            release_send(&island, cx);
        });
    })
    .detach();
}

/// Takes any moment still being drawn, then puts the screen back.
fn end_annotation(island: &Entity<Island>, cx: &mut App) {
    if island.read(cx).inking.is_none() {
        return;
    }
    island.update(cx, |island, _| island.rest_clock += 1);
    take_moment(island, cx);
    island.update(cx, |island, _| {
        island.inking = None;
        island.draw_hint = false;
    });
    close_ink(island, cx);
}

/// Files dropped on the panel ride the message as rows, folders left out,
/// since the server skips them.
pub fn drop_files(island: &Entity<Island>, paths: &[std::path::PathBuf], cx: &mut App) {
    island.update(cx, |island, cx| {
        for p in paths.iter().filter(|p| p.is_file()) {
            island.draft_mut().add_file(&p.to_string_lossy(), cx);
        }
        cx.notify();
    });
}
