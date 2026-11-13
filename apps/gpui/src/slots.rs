//! Where the parts other milestone-1 modules build plug into the window
//! (#856). Each function is a stand-in until its module lands: replace the
//! body, keep the signature. The window, the sidebar and the transcript's
//! wiring call only these.

use gpui::{AnyElement, App, Window, div, prelude::*, px};
use serde_json::Value;

use crate::theme::Theme;
use crate::transcript::{Tool, label};

/// Stand-in for the streaming markdown module: the text as written. Called
/// on every change while `streaming`, with the whole text so far.
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

/// Stand-in for the permission and question cards: the open session's
/// requests, oldest first, as the `agent_event` frames that raised them
/// (`permission_requested`, `questions_asked`). Drawn under the transcript and
/// above the composer, outside the turn stack, as Chat.tsx draws
/// `pendingAsks`. Answers go back as `respond_permission`/`answer_questions`;
/// the decision's event retires the frame from this list.
pub fn cards(_session_id: &str, asks: &[&Value], theme: &Theme) -> Option<AnyElement> {
    let line = match asks.len() {
        0 => return None,
        1 => "1 request waiting on you".to_string(),
        n => format!("{n} requests waiting on you"),
    };
    Some(div().px_6().pb_3().text_size(px(13.)).text_color(theme.accent_command).child(line).into_any_element())
}

/// Stand-in for the composer, under the open session's transcript and its
/// cards. Sending is `send_msg` with the session's id. Called on every
/// render, with the window, so a stateful input can live per session.
pub fn composer(_session_id: &str, _theme: &Theme, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
    None
}

/// Stand-in for the new-task screen, drawn in the sheet while no session is
/// open. `None` leaves the sheet's empty state.
pub fn new_task(_theme: &Theme) -> Option<AnyElement> {
    None
}
