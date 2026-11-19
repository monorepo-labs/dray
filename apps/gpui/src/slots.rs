//! Where the parts other milestone-1 modules build plug into the window
//! (#856). Each function is a stand-in until its module lands: replace the
//! body, keep the signature. The window, the sidebar and the transcript's
//! wiring call only these.

use gpui::{AnyElement, App, Window, div, prelude::*};
use serde_json::Value;

use crate::theme::Theme;
use crate::transcript::{Tool, label};

/// An assistant message as streaming markdown. Called on every change while
/// `streaming`, with the whole text so far; `key` names the message for as
/// long as its row lives, the commit included, and keys the parse kept
/// between frames.
pub fn assistant(key: &str, text: &str, streaming: bool, _theme: &Theme) -> AnyElement {
    crate::markdown::element(gpui::SharedString::from(key.to_string()), text.to_string(), streaming).into_any_element()
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
                    .font_features(crate::assets::mono_features())
                    .text_color(if tool.error { theme.destructive } else { theme.muted_foreground })
                    // One line, whitespace collapsed as CSS `truncate` does,
                    // or a multi-line command loses the spaces at its breaks.
                    .child(s.split_whitespace().collect::<Vec<_>>().join(" ")),
            )
        })
        .into_any_element()
}

/// Stand-in for the permission and question cards: the open session's
/// requests, oldest first, as the `agent_event` frames that raised them
/// (`permission_requested`, `questions_asked`). Drawn under the transcript and
/// above the composer, outside the turn stack, as Chat.tsx draws
/// `pendingAsks`. Answers go back as `respond_permission`/`answer_questions`;
/// the decision's event retires the frame from this list.
pub fn cards(session_id: &str, asks: &[&Value], theme: &Theme) -> Option<AnyElement> {
    crate::cards::cards(session_id, asks, theme)
}

/// The composer, under the open session's transcript and its cards: one
/// input per session, kept between renders. What it emits goes through
/// `composer::slot::on_event`, set at startup.
pub fn composer(session_id: &str, _theme: &Theme, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    Some(crate::composer::slot::slot(session_id, window, cx))
}

/// The new-task screen, drawn in the sheet while no session is open. `None`
/// until `new_task::install` has run, which leaves the sheet's empty state.
pub fn new_task(theme: &Theme) -> Option<AnyElement> {
    crate::new_task::element(theme)
}
