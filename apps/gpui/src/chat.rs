//! One session's transcript on screen (Chat.tsx): its newest turns read from
//! the server, live events folded on after, in GPUI's virtualised `list`
//! following the tail the way Chat.tsx's pin does.

use dray_core::events::AgentEvent;
use gpui::{
    AnyElement, BoxShadow, Context, FollowMode, ListAlignment, ListState, Render, Window, div, list, point,
    prelude::*, px, rems,
};
use serde_json::{Value, json};

use crate::theme::Theme;
use crate::transcript::{Change, Row, Transcript};
use crate::wire::Wire;

/// The turns read when a session opens, as useSessions' `FIRST_MOUNT` asks,
/// and how many each page back adds once the reader reaches the top.
const FIRST_TURNS: u32 = 8;
const PAGE_TURNS: u32 = 16;
/// `max-w-3xl`, the transcript's column.
const COLUMN: f32 = 768.;

pub struct Chat {
    pub session_id: String,
    transcript: Transcript,
    list: ListState,
    /// Every event folded, in order, so a page of older ones can be folded
    /// in front of them. ponytail: deltas are kept too; drop each block's once
    /// it commits if a long session's memory ever shows it.
    events: Vec<AgentEvent>,
    /// Live events that beat a read, folded once it lands.
    held: Option<Vec<AgentEvent>>,
    /// Where the log's unread older part ends; `None` once the top is reached.
    older_before: Option<u64>,
    /// The first read has landed, so a later one is a catch-up and must not
    /// move `older_before` back to the tail's start.
    opened: bool,
    paging: bool,
    wire: Wire,
    error: Option<String>,
}

impl Chat {
    pub fn new(session_id: String, wire: &Wire, cx: &mut Context<Self>) -> Self {
        let list = ListState::new(0, ListAlignment::Bottom, px(800.));
        list.set_follow_mode(FollowMode::Tail);
        let mut chat = Chat {
            session_id,
            transcript: Transcript::default(),
            list,
            events: Vec::new(),
            held: None,
            older_before: None,
            opened: false,
            paging: false,
            wire: wire.clone(),
            error: None,
        };
        chat.read(cx);
        chat
    }

    /// Reads the newest turns and folds them in. Run again on every reconnect:
    /// events are folded once by id, so whatever the drop cost lands and the
    /// rest is skipped. Live events wait behind the read, so order holds.
    pub fn read(&mut self, cx: &mut Context<Self>) {
        self.held.get_or_insert_with(Vec::new);
        let read = self.wire.invoke("get_session_by_id", json!({ "sessionId": self.session_id, "turns": FIRST_TURNS }));
        cx.spawn(async move |this, cx| {
            let answer = read.await;
            this.update(cx, |this, cx| this.land(answer, cx)).ok();
        })
        .detach();
    }

    fn land(&mut self, answer: Result<Value, Value>, cx: &mut Context<Self>) {
        let events = match answer {
            Ok(Value::Null) => Ok(Vec::new()),
            Ok(mut snapshot) => {
                if !self.opened {
                    self.older_before = snapshot["olderBefore"].as_u64();
                }
                serde_json::from_value::<Vec<AgentEvent>>(snapshot["events"].take())
                    .map_err(|e| format!("a transcript this build cannot read: {e}"))
            }
            Err(e) => Err(e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())),
        };
        let events = match events {
            Ok(events) => {
                self.error = None;
                events
            }
            Err(e) => {
                log::error!("get_session_by_id: {e}");
                // Before history first lands, live events stay held: folded
                // now they would sit above the history a retry brings. A
                // failed catch-up keeps the transcript and lets them through.
                if !self.opened {
                    self.error = Some(e);
                    cx.notify();
                    return;
                }
                Vec::new()
            }
        };
        self.opened = true;
        let held = self.held.take().unwrap_or_default();
        let mut change = Change::default();
        for event in events.into_iter().chain(held) {
            self.fold(event, &mut change);
        }
        self.commit(change, cx);
        cx.notify();
    }

    pub fn failed(&self) -> bool {
        self.error.is_some()
    }

    /// Folds one event, keeping it for a page's refold only if it was new,
    /// so each catch-up's overlap with what is held is not stored twice.
    fn fold(&mut self, event: AgentEvent, change: &mut Change) {
        if self.transcript.apply(&event, change) {
            self.events.push(event);
        }
    }

    /// Reads the turns before the oldest held and folds everything again with
    /// them in front. The rows already drawn are what the new fold ends with,
    /// so the list gains the difference at its top and keeps its place.
    fn page(&mut self, cx: &mut Context<Self>) {
        let Some(before) = self.older_before.filter(|_| !self.paging) else { return };
        self.paging = true;
        let read = self
            .wire
            .invoke("get_session_page", json!({ "sessionId": self.session_id, "before": before, "turns": PAGE_TURNS }));
        cx.spawn(async move |this, cx| {
            let answer = read.await;
            this.update(cx, |this, cx| {
                this.paging = false;
                let Ok(mut page) = answer else { return };
                let Ok(older) = serde_json::from_value::<Vec<AgentEvent>>(page["events"].take()) else { return };
                this.older_before = page["olderBefore"].as_u64();
                let mut transcript = Transcript::default();
                let mut ignored = Change::default();
                for event in older.iter().chain(&this.events) {
                    transcript.apply(event, &mut ignored);
                }
                let added = transcript.rows.len().saturating_sub(this.transcript.rows.len());
                log::debug!("paged back {added} rows, more: {}", this.older_before.is_some());
                this.transcript = transcript;
                this.events.splice(0..0, older);
                this.list.splice(0..0, added);
                this.list.remeasure_items(added..this.transcript.rows.len());
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// One live `agent_event` for this session.
    pub fn on_event(&mut self, event: AgentEvent, cx: &mut Context<Self>) {
        if let Some(held) = &mut self.held {
            held.push(event);
            return;
        }
        let mut change = Change::default();
        self.fold(event, &mut change);
        self.commit(change, cx);
    }

    fn commit(&mut self, mut change: Change, cx: &mut Context<Self>) {
        if change.added == 0 && change.changed.is_empty() {
            return;
        }
        let start = self.transcript.rows.len() - change.added;
        self.list.splice(start..start, change.added);
        change.changed.sort_unstable();
        change.changed.dedup();
        for &i in change.changed.iter().filter(|&&i| i < start) {
            self.list.remeasure_items(i..i + 1);
        }
        cx.notify();
    }

    fn row(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::get(cx).clone();
        let Some(row) = self.transcript.rows.get(ix) else {
            return div().into_any_element();
        };
        // A preview before its first character, or a block of invisible
        // characters, takes no room; rows are never removed, only emptied.
        if let Row::Assistant { text, .. } = row
            && !dray_core::events::has_text(text)
        {
            return div().into_any_element();
        }
        // `gap-4` between rows, with `pt-6`/`pb-6` at the column's ends.
        let next_is_tool = matches!(self.transcript.rows.get(ix + 1), Some(Row::Tool(_)));
        let gap = if matches!(row, Row::Tool(_)) && next_is_tool { 12. } else { 16. };
        let body: AnyElement = match row {
            Row::User { text } => user_bubble(text, &theme),
            Row::Assistant { key, text, streaming, .. } => crate::slots::assistant(key, text, *streaming, &theme),
            Row::Tool(tool) => crate::slots::tool(tool, &theme),
            Row::Failed { text } => div().text_color(theme.destructive).child(text.clone()).into_any_element(),
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .px_6()
            .when(ix == 0, |d| d.pt_6())
            .pb(px(if ix + 1 == self.transcript.rows.len() { 24. } else { gap }))
            .child(div().w_full().max_w(px(COLUMN)).child(body))
            .into_any_element()
    }
}

/// UserMessage.tsx's bubble: right-aligned, `max-w-[85%] rounded-xl bg-card
/// px-3 py-2`, with `--shadow-card` in light.
fn user_bubble(text: &str, theme: &Theme) -> AnyElement {
    let shadow = |y: f32, blur: f32, a: f32| BoxShadow {
        color: gpui::black().opacity(a),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
        inset: false,
    };
    div()
        .flex()
        .justify_end()
        .child(
            div()
                .max_w(gpui::relative(0.85))
                .rounded(px(12.))
                .bg(theme.card)
                .when(theme.card_shadow, |d| {
                    d.shadow(vec![shadow(1., 1., 0.04), shadow(1., 1., 0.06), shadow(1., 4., 0.04)])
                })
                .px_3()
                .py_2()
                .child(text.to_string()),
        )
        .into_any_element()
}

impl Render for Chat {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        if let Some(error) = &self.error {
            return div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child(error.clone())
                .into_any_element();
        }
        if self.list.logical_scroll_top().item_ix == 0 && !self.transcript.rows.is_empty() {
            self.page(cx);
        }
        // `text-chat`: 15px at 1.65.
        div()
            .size_full()
            .text_size(px(15.))
            .line_height(rems(0.9375 * 1.65))
            .text_color(theme.foreground)
            .child(list(self.list.clone(), cx.processor(|this, ix, _, cx| this.row(ix, cx))).size_full())
            .into_any_element()
    }
}
