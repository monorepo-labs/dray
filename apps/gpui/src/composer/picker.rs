//! The `/` `@` `&` `#` picker (PickerMenu.tsx): a key hint, then a framed list
//! of 32px rows. It never takes focus — the prompt keeps it so typing keeps
//! filtering, and the composer answers the keys.

use gpui::{
    AnyElement, App, FontWeight, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
    Window, div, prelude::*, px, svg,
};

use super::colors::Colors;
use super::{PickerRow, Sigil};
use crate::theme::Theme;
use crate::ui;

pub fn menu(
    sigil: Sigil,
    rows: &[PickerRow],
    active: usize,
    theme: &Theme,
    colors: &Colors,
    on_pick: impl Fn(&usize, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let on_pick = std::rc::Rc::new(on_pick);
    let faint = theme.muted_foreground.opacity(0.5);
    let cap = |content: AnyElement| ui::kbd_with(content, theme.muted, theme.muted_foreground);
    // The hint sits on body's own colour so the transcript behind it is masked.
    let hint = div()
        .mb(px(6.))
        .flex()
        .items_center()
        .gap_3()
        .rounded(px(8.))
        .px(px(6.))
        .py_1()
        .bg(colors.background)
        .text_size(px(13.))
        .text_color(faint)
        .child(
            div()
                .flex()
                .items_center()
                .gap_1()
                .child(cap("↑".into_any_element()))
                .child(cap("↓".into_any_element()))
                .child(div().ml(px(2.)).child("navigate")),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap_1()
                .child(cap(
                    svg().path("icons/corner-down-left.svg").size(px(12.)).text_color(theme.muted_foreground).into_any_element(),
                ))
                .child(div().ml(px(2.)).child("select")),
        );

    let list = div()
        .id("picker-list")
        .max_h(px(232.))
        .overflow_y_scroll()
        .p_1()
        .children(rows.iter().enumerate().map(|(i, row)| {
            let on_pick = on_pick.clone();
            let selected = i == active;
            let hover = colors.ghost_hover;
            div()
                .id(("pick", i))
                .h(px(32.))
                .w_full()
                .flex()
                .items_center()
                .gap_2()
                .px_2()
                .rounded(px(8.))
                .cursor_pointer()
                .text_size(px(13.))
                .text_color(theme.foreground)
                .when(selected, |d| d.bg(theme.muted))
                .when(!selected, |d| d.hover(move |s| s.bg(hover)))
                .child(row_body(sigil, row, theme))
                .on_click(move |_, window, cx| on_pick(&i, window, cx))
        }));

    div()
        .child(hint)
        .child(
            div()
                .overflow_hidden()
                .rounded(px(12.))
                .border_1()
                .border_color(colors.hairline_strong)
                .bg(colors.picker)
                .shadow_md()
                .child(list),
        )
        .into_any_element()
}

fn row_body(sigil: Sigil, row: &PickerRow, theme: &Theme) -> impl IntoElement {
    let muted = theme.muted_foreground;
    let lead: Option<AnyElement> = match sigil {
        Sigil::File => Some(svg().path("icons/file.svg").size(px(14.)).flex_shrink_0().text_color(muted).into_any_element()),
        Sigil::Task => {
            Some(svg().path("icons/message-square.svg").size(px(14.)).flex_shrink_0().text_color(muted).into_any_element())
        }
        Sigil::Issue => row.detail.clone().map(|id| {
            div().flex_shrink_0().font_weight(FontWeight::MEDIUM).text_color(muted).child(id).into_any_element()
        }),
        Sigil::Command => None,
    };
    let title = div().flex_shrink_0().truncate().child(row.title.clone());
    let title = if sigil == Sigil::Command { title.text_color(theme.accent_command) } else { title };
    let detail = match sigil {
        Sigil::Issue => None,
        _ => row.detail.clone(),
    };
    div()
        .min_w_0()
        .flex()
        .items_center()
        .gap_2()
        .children(lead)
        .child(title)
        .children(detail.map(|d| div().min_w_0().truncate().text_color(muted).child(d)))
}
