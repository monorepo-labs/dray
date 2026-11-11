//! Controls built to the web app's `Button` and `Kbd` (components/ui/), on raw
//! GPUI. Sizes are the Tailwind classes those components carry, in pixels.

use gpui::{
    AnyElement, Div, ElementId, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, SharedString,
    Stateful, Styled, div, px, svg,
};

use crate::theme::Theme;

/// `Button variant="ghost" size="icon-sm"` holding one glyph, held back to
/// `muted-foreground` at rest the way the sidebar toggle and gear are.
pub fn icon_button(id: impl Into<ElementId>, icon: &'static str, glyph: f32, theme: &Theme) -> Stateful<Div> {
    let (rest, hover, fill) = (theme.muted_foreground, theme.foreground, theme.muted.opacity(0.5));
    div()
        .id(id)
        .size(px(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .cursor_pointer()
        .text_color(rest)
        .hover(move |s| s.bg(fill).text_color(hover))
        .child(svg().path(icon).size(px(glyph)).text_color(rest))
}

/// The same at `icon-xs`: 24px with a 12px glyph.
pub fn icon_button_xs(id: impl Into<ElementId>, icon: &'static str, theme: &Theme) -> Stateful<Div> {
    let (rest, fill) = (theme.muted_foreground, theme.muted.opacity(0.5));
    div()
        .id(id)
        .size(px(24.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .cursor_pointer()
        .hover(move |s| s.bg(fill))
        .child(svg().path(icon).size(px(12.)).text_color(rest))
}

/// One keycap: `h-5 min-w-5 rounded-sm px-1 text-xs font-medium`.
pub fn kbd(label: impl Into<SharedString>, fill: Hsla, theme: &Theme) -> impl IntoElement {
    kbd_with(div().child(label.into()).into_any_element(), fill, theme.muted_foreground)
}

/// A keycap holding anything — a word or a glyph — in `ink`.
pub fn kbd_with(content: AnyElement, fill: Hsla, ink: Hsla) -> impl IntoElement {
    div()
        .h(px(20.))
        .min_w(px(20.))
        .px(px(4.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .bg(fill)
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink)
        .child(content)
}

/// A chord as `KbdGroup` draws it: one cap per key, `gap-1`.
pub fn chord(keys: &[&'static str], fill: Hsla, theme: &Theme) -> AnyElement {
    div().flex().items_center().gap_1().children(keys.iter().map(|k| kbd(*k, fill, theme))).into_any_element()
}
