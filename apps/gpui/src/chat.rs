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

/// The turns read when a session opens, as useSessions' `FIRST_MOUNT` asks.
/// Paging further back is not here yet.
const FIRST_TURNS: u32 = 8;
/// `max-w-3xl`, the transcript's column.
const COLUMN: f32 = 768.;

pub struct Chat {
    pub session_id: String,
    transcript: Transcript,
    list: ListState,
    /// Live events that beat the first read, folded once it lands.
    held: Option<Vec<AgentEvent>>,
    error: Option<String>,
}

impl Chat {
    pub fn new(session_id: String, wire: &Wire, cx: &mut Context<Self>) -> Self {
        let list = ListState::new(0, ListAlignment::Bottom, px(800.));
        list.set_follow_mode(FollowMode::Tail);
        let read = wire.invoke("get_session_by_id", json!({ "sessionId": session_id, "turns": FIRST_TURNS }));
        cx.spawn(async move |this, cx| {
            let answer = read.await;
            this.update(cx, |this, cx| this.land(answer, cx)).ok();
        })
        .detach();
        Chat { session_id, transcript: Transcript::default(), list, held: Some(Vec::new()), error: None }
    }

    fn land(&mut self, answer: Result<Value, Value>, cx: &mut Context<Self>) {
        let events = match answer {
            Ok(Value::Null) => Ok(Vec::new()),
            Ok(mut snapshot) => serde_json::from_value::<Vec<AgentEvent>>(snapshot["events"].take())
                .map_err(|e| format!("a transcript this build cannot read: {e}")),
            Err(e) => Err(e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())),
        };
        let events = match events {
            Ok(events) => events,
            Err(e) => {
                log::error!("get_session_by_id: {e}");
                self.error = Some(e);
                cx.notify();
                return;
            }
        };
        let held = self.held.take().unwrap_or_default();
        let mut change = Change::default();
        for event in events.iter().chain(&held) {
            self.transcript.apply(event, &mut change);
        }
        self.commit(change, cx);
    }

    /// One live `agent_event` for this session.
    pub fn on_event(&mut self, event: AgentEvent, cx: &mut Context<Self>) {
        if let Some(held) = &mut self.held {
            held.push(event);
            return;
        }
        let mut change = Change::default();
        self.transcript.apply(&event, &mut change);
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
        // `gap-4` between rows, with `pt-6`/`pb-6` at the column's ends.
        let next_is_tool = matches!(self.transcript.rows.get(ix + 1), Some(Row::Tool(_)));
        let gap = if matches!(row, Row::Tool(_)) && next_is_tool { 12. } else { 16. };
        let body: AnyElement = match row {
            Row::User { text } => user_bubble(text, &theme),
            Row::Assistant { text, streaming, .. } => slots::assistant(text, *streaming, &theme),
            Row::Tool(tool) => slots::tool(tool, &theme),
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

/// Where the rows other milestone-1 modules draw plug in. Each is a stand-in
/// until its module lands: markdown for assistant text, tool rows for calls.
mod slots {
    use gpui::{AnyElement, div, prelude::*};

    use crate::theme::Theme;
    use crate::transcript::{Tool, label};

    /// Stand-in for the streaming markdown module: the text as written.
    pub fn assistant(text: &str, _streaming: bool, _theme: &Theme) -> AnyElement {
        div().whitespace_normal().child(text.to_string()).into_any_element()
    }

    /// Stand-in for the tool-row module: the collapsed header alone, label and
    /// target (ToolCall.tsx), with no body to expand.
    pub fn tool(tool: &Tool, theme: &Theme) -> AnyElement {
        let ink = if tool.error { theme.destructive } else { theme.foreground.opacity(0.8) };
        div()
            .flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .child(div().flex_shrink_0().text_color(ink).child(label(&tool.name, !tool.done).to_string()))
            .when_some(tool.summary.clone(), |d, s| {
                d.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_family(crate::assets::MONO)
                        .text_color(if tool.error { theme.destructive } else { theme.muted_foreground })
                        // One line, whitespace collapsed as CSS `truncate` does,
                        // or a multi-line command loses the spaces at its breaks.
                        .child(s.split_whitespace().collect::<Vec<_>>().join(" ")),
                )
            })
            .into_any_element()
    }
}
