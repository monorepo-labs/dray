//! The window's one view: what the server has said about every session, and the
//! frame and sheet it is drawn in (AppShell.tsx).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use dray_core::projects::Project;
use dray_core::store::{SessionIndexItem, SessionStatus};
use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use gpui::{
    App, Context, IntoElement, MouseButton, ParentElement, PathBuilder, Pixels, Point, Render, ScrollHandle, Styled,
    Task, Window, canvas, div, point, prelude::*, px,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::sessions::Live;
use crate::theme::{Mode, Theme};
use crate::wire::{Signal, Wire};

/// `--titlebar-h`.
pub const TITLEBAR_H: f32 = 40.;
/// `--traffic-lights-w`: the lead space the header keeps clear on macOS.
pub const TRAFFIC_LIGHTS_W: f32 = 78.;
/// `SIDEBAR_MIN`, the width the sidebar opens at.
pub const SIDEBAR_W: f32 = 240.;
/// The frame's rim round the sheet's right and foot (`w-2`, `h-2`).
const RIM: f32 = 8.;
/// The sheet's corner (`rounded-[8px]`).
const SHEET_RADIUS: f32 = 8.;

pub enum Connection {
    Connecting,
    Up,
    Down(String),
}

pub struct Workspace {
    pub wire: Wire,
    pub items: Vec<SessionIndexItem>,
    pub projects: Vec<Project>,
    pub live: Live,
    /// Open permission and question requests by session, so a decision retires
    /// its own request and the row stops reading as asking only with the last.
    asks: HashMap<String, HashSet<String>>,
    /// Sessions holding background tasks, whose asks outlive the turn.
    tasked: HashSet<String>,
    /// Index events seen while a list read is in flight, laid over its answer.
    replay: Option<Vec<(String, Value)>>,
    /// Counts list reads, so only the newest one's answer lands.
    reads: u64,
    pub selected: Option<String>,
    pub connection: Connection,
    pub sidebar_open: bool,
    pub sidebar_scroll: ScrollHandle,
    _tasks: Vec<Task<()>>,
}

impl Workspace {
    pub fn new(wire: Wire, signals: UnboundedReceiver<Signal>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let listen = cx.spawn(async move |this, cx| {
            let mut signals = signals;
            while let Some(signal) = signals.next().await {
                if this.update(cx, |this, cx| this.on_signal(signal, cx)).is_err() {
                    break;
                }
            }
        });
        // Relative times move on the minute; nothing else would redraw them.
        let tick = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(30)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        });
        cx.observe_window_appearance(window, |_, window, cx| {
            cx.set_global(Theme::new(Mode::of(window.appearance())));
            cx.notify();
        })
        .detach();
        Workspace {
            wire,
            items: Vec::new(),
            projects: Vec::new(),
            live: Live::default(),
            asks: HashMap::new(),
            tasked: HashSet::new(),
            replay: None,
            reads: 0,
            selected: None,
            connection: Connection::Connecting,
            sidebar_open: true,
            sidebar_scroll: ScrollHandle::new(),
            _tasks: vec![listen, tick],
        }
    }

    fn on_signal(&mut self, signal: Signal, cx: &mut Context<Self>) {
        let changed = match signal {
            Signal::Up => {
                self.connection = Connection::Up;
                true
            }
            Signal::Down(why) => {
                self.connection = Connection::Down(why);
                true
            }
            Signal::Event { name, payload } => self.on_event(&name, payload, cx),
        };
        // Deltas stream by the hundred and change nothing here; a redraw for
        // each would regroup the whole list per token.
        if changed {
            cx.notify();
        }
    }

    /// Applies one server event. Answers whether anything the view draws moved.
    fn on_event(&mut self, name: &str, payload: Value, cx: &mut Context<Self>) -> bool {
        match name {
            // Opens every connect. Replaces what is held, and the index is
            // re-read, since status lives there rather than in this frame.
            "live_state" => {
                self.asks.clear();
                for ask in payload["asks"].as_array().into_iter().flatten() {
                    self.note_ask(ask);
                }
                self.tasked = payload["tasks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["sessionId"].as_str().map(str::to_string))
                    .collect();
                self.live.status.clear();
                self.sync_asking();
                self.reload(cx);
                true
            }
            "agent_event" => match payload["payload"]["type"].as_str() {
                Some("permission_requested" | "questions_asked") => {
                    self.note_ask(&payload);
                    self.sync_asking();
                    true
                }
                Some("permission_decided") => {
                    let session = payload["sessionId"].as_str().unwrap_or_default();
                    let request = payload["payload"]["requestId"].as_str().unwrap_or_default();
                    if let Some(open) = self.asks.get_mut(session) {
                        open.remove(request);
                    }
                    self.sync_asking();
                    true
                }
                // A turn that ended with a task open kept its asks, since the
                // task's subagent could be the one asking; this is the other half.
                Some("background_tasks_changed") => {
                    let session = payload["sessionId"].as_str().unwrap_or_default().to_string();
                    let empty = payload["payload"]["tasks"].as_array().is_none_or(|t| t.is_empty());
                    if !empty {
                        self.tasked.insert(session);
                    } else {
                        self.tasked.remove(&session);
                        if self.running(&session) == Some(false) {
                            self.asks.remove(&session);
                            self.sync_asking();
                        }
                    }
                    true
                }
                _ => false,
            },
            "session_status" | "session_created" | "session_changed" | "session_title" => {
                // A list read in flight answers with the index as it was before
                // this event, so the event is kept and laid over that answer.
                if let Some(replay) = &mut self.replay {
                    replay.push((name.to_string(), payload.clone()));
                }
                self.apply_index_event(name, payload);
                true
            }
            _ => false,
        }
    }

    /// The events that change the index, applied to the list held.
    fn apply_index_event(&mut self, name: &str, payload: Value) {
        match name {
            "session_status" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct StatusEvent {
                    session_id: String,
                    status: SessionStatus,
                    modified: Option<String>,
                }
                let Ok(e) = serde_json::from_value::<StatusEvent>(payload) else {
                    return;
                };
                if let Some(modified) = e.modified
                    && let Some(item) = self.items.iter_mut().find(|i| i.session_id == e.session_id)
                {
                    item.modified = modified;
                }
                // A turn over with no task left strands its asks, as the server does.
                if e.status != SessionStatus::InProgress && !self.tasked.contains(&e.session_id) {
                    self.asks.remove(&e.session_id);
                    self.sync_asking();
                }
                self.live.status.insert(e.session_id, e.status);
            }
            "session_created" | "session_changed" => {
                let Ok(item) = serde_json::from_value::<SessionIndexItem>(payload) else {
                    return;
                };
                self.items.retain(|i| i.session_id != item.session_id);
                // The live list holds active rows; one settled from anywhere leaves it.
                if !item.archived {
                    self.items.push(item);
                }
            }
            "session_title" => {
                let id = payload["sessionId"].as_str().unwrap_or_default();
                let locked = payload["titleLocked"].as_bool().unwrap_or(false);
                if let (Some(item), Some(title)) =
                    (self.items.iter_mut().find(|i| i.session_id == id), payload["title"].as_str())
                    && (locked || !item.title_locked)
                {
                    item.title = title.to_string();
                    item.title_locked = locked;
                }
            }
            _ => {}
        }
    }

    /// Whether a session's turn is running, or `None` while that is unknown:
    /// between a reconnect and the list it re-reads, the list held is stale
    /// and no live reading has arrived yet.
    fn running(&self, session: &str) -> Option<bool> {
        if let Some(status) = self.live.status.get(session) {
            return Some(*status == SessionStatus::InProgress);
        }
        if self.replay.is_some() {
            return None;
        }
        self.items.iter().find(|i| i.session_id == session).map(|i| i.status == SessionStatus::InProgress)
    }

    fn note_ask(&mut self, frame: &Value) {
        let session = frame["sessionId"].as_str().unwrap_or_default().to_string();
        let request = frame["payload"]["requestId"].as_str().unwrap_or_default().to_string();
        self.asks.entry(session).or_default().insert(request);
    }

    fn sync_asking(&mut self) {
        self.live.asking = self.asks.iter().filter(|(_, open)| !open.is_empty()).map(|(s, _)| s.clone()).collect();
    }

    /// Re-reads the active list and the projects, as the React app does on
    /// every `live_state`. The two land apart, since projects wait on git.
    fn reload(&mut self, cx: &mut Context<Self>) {
        self.reads += 1;
        let read = self.reads;
        self.replay = Some(Vec::new());
        let items = self.wire.invoke("list_session_index_items", json!({ "archived": false }));
        cx.spawn(async move |this, cx| {
            let items = items.await;
            this.update(cx, |this, cx| {
                // A later reconnect started a read of its own; this answer is older.
                if read != this.reads {
                    return;
                }
                let replay = this.replay.take().unwrap_or_default();
                match items.map(serde_json::from_value::<Vec<SessionIndexItem>>) {
                    Ok(Ok(items)) => {
                        this.items = items;
                        for (name, payload) in replay {
                            this.apply_index_event(&name, payload);
                        }
                    }
                    Ok(Err(e)) => log::error!("session list in a shape this build cannot read: {e}"),
                    Err(e) => log::error!("list_session_index_items: {e}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();

        let projects = self.wire.invoke("list_projects", json!({}));
        cx.spawn(async move |this, cx| {
            let projects = projects.await;
            this.update(cx, |this, cx| {
                if let Ok(Ok(projects)) = projects.map(serde_json::from_value::<Vec<Project>>) {
                    this.projects = projects;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn select(&mut self, session_id: &str, cx: &mut Context<Self>) {
        self.selected = Some(session_id.to_string());
        cx.notify();
    }

    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_open = !self.sidebar_open;
        cx.notify();
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let size = window.viewport_size();
        // Collapsed, the sidebar leaves a `w-2` strip of frame.
        let lead = if self.sidebar_open { SIDEBAR_W } else { RIM };
        // `tallSheet`: with no session open the sheet rises to an `h-2` rim and
        // the header floats over it. The web app eases the change; this snaps.
        let top = if self.selected.is_none() { RIM } else { TITLEBAR_H };
        let sheet = gpui::Bounds::new(
            point(px(lead), px(top)),
            gpui::size(size.width - px(lead + RIM), size.height - px(top + RIM)),
        );
        let frame_color = theme.frame;

        div()
            .size_full()
            .relative()
            .bg(theme.body)
            .font_family(crate::assets::SANS)
            // `--text-ui--line-height`. GPUI's own default is 1.618, which
            // pushes every row of text down a few pixels against the web app.
            .line_height(gpui::relative(1.4))
            .text_color(theme.foreground)
            // The frame is everything but the sheet, painted as one shape with
            // the sheet's rounded rect cut out. The web app draws strips and
            // four corner masks; a hole is the same picture with no seams.
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        if let Some(path) = frame_path(bounds, sheet) {
                            window.paint_path(path, frame_color);
                        }
                    },
                )
                .absolute()
                .size_full(),
            )
            // `--shadow-sheet`: a 1px ring just outside the sheet's edge.
            .child(
                div()
                    .absolute()
                    .left(sheet.origin.x - px(1.))
                    .top(sheet.origin.y - px(1.))
                    .w(sheet.size.width + px(2.))
                    .h(sheet.size.height + px(2.))
                    .rounded(px(SHEET_RADIUS + 1.))
                    .border_1()
                    .border_color(theme.sheet_ring),
            )
            .when(self.sidebar_open, |root| {
                root.child(
                    div()
                        .absolute()
                        .left_0()
                        .top(px(TITLEBAR_H))
                        .bottom_0()
                        .w(px(SIDEBAR_W))
                        .child(crate::sidebar::sidebar(self, &theme, cx)),
                )
            })
            .child(
                div()
                    .absolute()
                    .left(sheet.origin.x)
                    .top(sheet.origin.y)
                    .w(sheet.size.width)
                    .h(sheet.size.height)
                    .rounded(px(SHEET_RADIUS))
                    .bg(theme.sheet)
                    .overflow_hidden()
                    .child(self.empty_state(&theme)),
            )
            .child(self.header(&theme, cx))
    }
}

impl Workspace {
    /// The titlebar row: what the window is dragged by, holding the sidebar
    /// toggle after the traffic lights and the settings gear at the sidebar's
    /// right edge (App.tsx's `header`).
    fn header(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("titlebar")
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(TITLEBAR_H))
            .flex()
            .items_center()
            .gap_2()
            .pl(px(TRAFFIC_LIGHTS_W))
            .pr_3()
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(
                crate::ui::icon_button("sidebar-toggle", "icons/panel-left.svg", 18., theme)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_sidebar(cx))),
            )
            .when(self.sidebar_open, |header| {
                header.child(
                    div()
                        .absolute()
                        .top(px((TITLEBAR_H - 28.) / 2.))
                        .left(px(SIDEBAR_W - 8. - 28.))
                        .child(crate::ui::icon_button("settings", "icons/cog-6-tooth.svg", 16., theme)),
                )
            })
    }

    /// The sheet while no session is open. Milestone 1 fills it with the
    /// transcript and the new-task composer; until then it says why it is empty.
    fn empty_state(&self, theme: &Theme) -> impl IntoElement {
        let line = match &self.connection {
            Connection::Connecting => "Connecting to the server on this Mac…".to_string(),
            Connection::Down(why) => why.clone(),
            Connection::Up => String::new(),
        };
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(13.))
            .text_color(theme.muted_foreground)
            .child(line)
    }
}

/// The window's rect with the sheet's rounded rect cut out of it, filled
/// even-odd — the frame as one shape.
fn frame_path(window: gpui::Bounds<Pixels>, sheet: gpui::Bounds<Pixels>) -> Option<gpui::Path<Pixels>> {
    let mut path = PathBuilder::fill();
    let o = window.origin;
    let (w, h) = (window.size.width, window.size.height);
    path.add_polygon(&[o, o + point(w, px(0.)), o + point(w, h), o + point(px(0.), h)], true);

    let r = px(SHEET_RADIUS);
    let s = sheet.origin + o;
    let (sw, sh) = (sheet.size.width, sheet.size.height);
    let at = |x: Pixels, y: Pixels| -> Point<Pixels> { s + point(x, y) };
    path.move_to(at(r, px(0.)));
    path.line_to(at(sw - r, px(0.)));
    path.curve_to(at(sw, r), at(sw, px(0.)));
    path.line_to(at(sw, sh - r));
    path.curve_to(at(sw - r, sh), at(sw, sh));
    path.line_to(at(r, sh));
    path.curve_to(at(px(0.), sh - r), at(px(0.), sh));
    path.line_to(at(px(0.), r));
    path.curve_to(at(r, px(0.)), at(px(0.), px(0.)));
    path.close();
    path.build().ok()
}

pub fn open(cx: &mut App) {
    let (wire, signals) = Wire::start();
    let bounds = gpui::Bounds::centered(None, gpui::size(px(1200.), px(800.)), cx);
    cx.open_window(
        gpui::WindowOptions {
            window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
            window_min_size: Some(gpui::size(px(720.), px(480.))),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Dray".into()),
                appears_transparent: true,
                // tauri.conf.json's `trafficLightPosition` is { x: 9, y: 22 }.
                traffic_light_position: Some(point(px(9.), px(22. - 7.))),
            }),
            // Transparent rather than GPUI's `Blurred`; `glass` adds the material.
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| {
            crate::glass::apply(window);
            cx.set_global(Theme::new(Mode::of(window.appearance())));
            cx.new(|cx| Workspace::new(wire, signals, window, cx))
        },
    )
    .expect("open the window");
    cx.activate(true);
}
