//! The transcript's markdown, as Markdown.tsx draws it through Streamdown.
//!
//! Parsing, layout and selection are gpui-base's `TextView` (#856 settle point
//! c), restyled here to the web app's rules; nothing of the kit's own look is
//! kept. What this module adds on top:
//!
//! - **Streaming without flicker.** While a message streams, its text goes
//!   through [`remend`] first, the port of what Streamdown runs, so `**bold`
//!   draws bold rather than flashing its asterisks. The view appends where the
//!   new text extends the old and re-parses only where a closer moved.
//! - **Hooks for the rest of the app**: code colouring belongs to the code
//!   module and link opening to the window, so both are installed once with
//!   [`set_code_highlighter`] and [`set_link_handler`] and read by every view.
//! - **Copy controls** on code blocks and tables, which Markdown.tsx and
//!   MarkdownTable.tsx keep.

// Spelled out so the example, which mounts this file by path, finds it too.
#[path = "markdown/remend.rs"]
pub mod remend;

use std::ops::Range;
use std::sync::Arc;
use std::time::Duration;

use gpui::{
    App, AppContext, ClickEvent, ClipboardItem, Context, ElementId, Entity, FontWeight, Global, HighlightStyle, Hsla,
    InteractiveElement, IntoElement, ParentElement, Render, RenderOnce, SharedString, StatefulInteractiveElement,
    StyleRefinement, Styled, Window, div, px, relative, rems, svg,
};
use gpui_base::text::{TableData, TextView, TextViewState, TextViewStyle};

use crate::color::oklch;
use crate::theme::{Mode, Theme};

/// `--text-chat`: every element in a message is drawn at this one size.
pub const CHAT_SIZE: f32 = 15.;
/// `--text-chat--line-height`.
pub const CHAT_LINE_HEIGHT: f32 = 1.65;
/// `--text-code`, for fences and inline code alike.
pub const CODE_SIZE: f32 = 14.;
/// `--text-code--line-height`.
pub const CODE_LINE_HEIGHT: f32 = 1.6;
const MONO: &str = "Geist Mono";

/// Colours a fenced block: the fence's language (`None` for a bare fence) and
/// its code, to byte ranges of that code and their styles.
///
/// Called again while a fence streams, so it should be cheap on a prefix.
pub type CodeHighlighter = dyn Fn(Option<&str>, &str) -> Vec<(Range<usize>, HighlightStyle)> + Send + Sync;

/// Opens a link the reader clicked: its href, and the click for its modifiers
/// (⌘-click leaves for the system browser in the React app).
pub type LinkHandler = dyn Fn(&str, &ClickEvent, &mut Window, &mut App) + Send + Sync;

/// The hooks every markdown view reads. One per app.
#[derive(Default, Clone)]
struct Hooks {
    /// Wrapped once, since `TextView` keeps a block's highlights only while
    /// the highlighter is the same `Arc`.
    highlighter: Option<Arc<dyn Fn(&gpui_base::text::CodeBlock) -> Vec<(Range<usize>, HighlightStyle)> + Send + Sync>>,
    link: Option<Arc<LinkHandler>>,
}

impl Global for Hooks {}

/// Prepares GPUI for markdown views. Call once at startup, after the fonts.
///
/// gpui-base keeps its text machinery's key bindings and theme in globals of
/// its own; nothing it draws here takes its colours from that theme.
pub fn init(cx: &mut App) {
    gpui_base::init(cx);
    cx.set_global(Hooks::default());
}

/// Installs the code module's highlighter for every fenced block.
pub fn set_code_highlighter(cx: &mut App, highlighter: Arc<CodeHighlighter>) {
    let wrapped = Arc::new(move |block: &gpui_base::text::CodeBlock| {
        let lang = block.lang();
        highlighter(lang.as_deref(), &block.code())
    });
    cx.default_global::<Hooks>().highlighter = Some(wrapped);
    cx.refresh_windows();
}

/// Installs what a click on a link does. Without one a link opens in the
/// system browser.
pub fn set_link_handler(cx: &mut App, handler: Arc<LinkHandler>) {
    cx.default_global::<Hooks>().link = Some(handler);
}

/// One message's markdown as an element, for a caller that holds no view of
/// its own and hands over the whole text on every change (the transcript's
/// `slots::assistant`). `id` must name the message and stay put while it
/// streams: it keys the [`Markdown`] view kept between frames, and with it the
/// parse, the selection and the copy controls' state.
pub fn element(id: impl Into<ElementId>, text: impl Into<SharedString>, streaming: bool) -> MarkdownText {
    MarkdownText { id: id.into(), text: text.into(), streaming }
}

/// See [`element`].
#[derive(IntoElement)]
pub struct MarkdownText {
    id: ElementId,
    text: SharedString,
    streaming: bool,
}

impl RenderOnce for MarkdownText {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (text, streaming) = (self.text, self.streaming);
        let view = window.use_keyed_state(self.id, cx, |_, cx| Markdown::new(&text, streaming, cx));
        // An unchanged text costs one comparison; a grown one appends.
        view.update(cx, |m, cx| m.set_source(&text, streaming, cx));
        view
    }
}

/// One message's markdown. Hold it in an entity and feed it the message's
/// text as it grows; [`Markdown::finish`] when the turn commits it.
pub struct Markdown {
    state: Entity<TextViewState>,
    source: String,
    streaming: bool,
}

impl Markdown {
    /// A view of `source`, finished unless `streaming`.
    pub fn new(source: &str, streaming: bool, cx: &mut Context<Self>) -> Self {
        let shown = display_text(source, streaming);
        let state = cx.new(|cx| TextViewState::markdown(&shown, cx).selectable(true));
        Markdown { state, source: source.to_string(), streaming }
    }

    /// The message's text, as written.
    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn is_streaming(&self) -> bool {
        self.streaming
    }

    /// Replaces the text, as the committed event replaces the deltas.
    pub fn set_source(&mut self, source: &str, streaming: bool, cx: &mut Context<Self>) {
        if self.source == source && self.streaming == streaming {
            return;
        }
        self.source.clear();
        self.source.push_str(source);
        self.streaming = streaming;
        self.sync(cx);
    }

    /// Appends one delta to a streaming message.
    pub fn push_str(&mut self, delta: &str, cx: &mut Context<Self>) {
        if delta.is_empty() {
            return;
        }
        self.source.push_str(delta);
        self.streaming = true;
        self.sync(cx);
    }

    /// Ends the stream: the text is drawn as written, with nothing closed for it.
    pub fn finish(&mut self, cx: &mut Context<Self>) {
        if self.streaming {
            self.streaming = false;
            self.sync(cx);
        }
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let shown = display_text(&self.source, self.streaming);
        // `set_text` appends when `shown` extends what is drawn, which keeps
        // selection and parses only the last block; anything else re-parses.
        self.state.update(cx, |state, cx| state.set_text(&shown, cx));
        cx.notify();
    }
}

/// What a message draws: as written once finished, and with what it leaves
/// open closed while it streams. An unfinished link draws as its label and an
/// unfinished image as nothing, which is what the React app is left with
/// once harden has refused the placeholder href.
pub fn display_text(source: &str, streaming: bool) -> String {
    if !streaming {
        return source.to_string();
    }
    let mut text = remend::remend(source);
    for (placeholder, keep_label) in [(remend::INCOMPLETE_LINK, true), (remend::INCOMPLETE_IMAGE, false)] {
        let tail = format!("]({placeholder})");
        let Some(head) = text.strip_suffix(&tail) else { continue };
        let Some(open) = matching_bracket(head) else { continue };
        let label = &head[open + 1..];
        let start = if !keep_label && head[..open].ends_with('!') { open - 1 } else { open };
        text = format!("{}{}", &head[..start], if keep_label { label } else { "" });
        break;
    }
    text
}

/// The `[` that the `]` ending `head` closes.
fn matching_bracket(head: &str) -> Option<usize> {
    let mut depth = 0usize;
    for (i, c) in head.char_indices().rev() {
        match c {
            ']' => depth += 1,
            '[' if depth == 0 => return Some(i),
            '[' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// The colours this module draws with, beside the shared theme's: tokens no
/// other surface needed yet, in App.css's notation for the Default palette.
struct Ink {
    foreground: Hsla,
    muted_foreground: Hsla,
    /// `--primary`, which links are drawn in.
    primary: Hsla,
    /// `--border`.
    border: Hsla,
    /// `--muted` under glass, the inline code chip.
    muted: Hsla,
}

impl Ink {
    fn of(theme: &Theme) -> Ink {
        let (primary, border) = match theme.mode {
            Mode::Dark => (oklch(0.922, 0., 0., 1.), oklch(1., 0., 0., 0.10)),
            Mode::Light => (oklch(0.65, 0.17, 250., 1.), oklch(0., 0., 0., 0.10)),
        };
        Ink {
            foreground: theme.foreground,
            muted_foreground: theme.muted_foreground,
            primary: primary.hsla(),
            border: border.hsla(),
            muted: theme.muted,
        }
    }
}

/// Markdown.tsx's class list, as a `TextView` style.
fn style(theme: &Theme) -> TextViewStyle {
    let ink = Ink::of(theme);
    let foreground = ink.foreground;
    // Every heading at `text-chat`, semibold (Streamdown's weight), with the
    // rhythm tightened for h1–h3 and Streamdown's `mt-6 mb-2` left on h4–h6.
    // Padding rather than margin: the block above already leaves its 16px gap,
    // which CSS collapses with the heading's own top margin.
    let heading = move |level: u8| {
        let s = StyleRefinement::default()
            .text_size(px(CHAT_SIZE))
            .line_height(relative(CHAT_LINE_HEIGHT))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(foreground)
            .pt(px(if level <= 3 { 0. } else { 8. }));
        match level {
            1 | 2 => s.pb(px(8.)),
            3 => s.pb(px(6.)),
            _ => s.pb(px(8.)),
        }
    };
    // `[data-streamdown=code-block]` as App.css leaves it: a 1px `--border`
    // box at `--radius-md`, `p-4`, no fill.
    let code_block = StyleRefinement::default()
        .border_1()
        .border_color(ink.border)
        .rounded(px(8.))
        .p_4()
        .font_family(MONO)
        .text_size(px(CODE_SIZE))
        .line_height(relative(CODE_LINE_HEIGHT));
    // Streamdown's inline code: `rounded bg-muted px-1.5 py-0.5 font-mono`,
    // at `text-code`.
    let inline_code =
        StyleRefinement::default().bg(ink.muted).rounded(px(4.)).px(px(6.)).font_family(MONO).text_size(px(CODE_SIZE));
    // `my-4 border-l-4 border-muted-foreground/30 pl-4 text-muted-foreground italic`.
    let blockquote = StyleRefinement::default()
        .border_l_4()
        .border_color(ink.muted_foreground.opacity(0.3))
        .pl_4()
        .text_color(ink.muted_foreground)
        .italic();
    // No box round the table and no column rules: only rows are ruled.
    let table = StyleRefinement::default().border_0().bg(gpui::transparent_black()).rounded(px(0.));
    let head = StyleRefinement::default().bg(gpui::transparent_black()).font_weight(FontWeight::SEMIBOLD);
    // A transparent cell border is what hides the column rules, which the kit
    // draws in the cell's colour.
    let cell = StyleRefinement::default().py_2().border_color(gpui::transparent_black());
    TextViewStyle::default()
        .with_dark(theme.mode == Mode::Dark)
        .with_foreground(ink.foreground)
        .with_muted_foreground(ink.muted_foreground)
        .with_link(ink.primary)
        // Row rules and `hr` share this one colour; React rules the header at
        // `/60` and body rows at `/30`, which the kit cannot tell apart.
        .with_border(ink.border.opacity(0.45))
        .with_code_background(gpui::transparent_black())
        .with_paragraph_gap(rems(1.))
        .with_heading(heading)
        .with_code_block(code_block)
        .with_inline_code(HighlightStyle { font_weight: None, ..Default::default() })
        .with_inline_code_style(inline_code)
        .with_blockquote_style(blockquote)
        .with_table(table)
        .with_table_head(head)
        .with_table_cell(cell)
}

impl Render for Markdown {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let hooks = cx.try_global::<Hooks>().cloned().unwrap_or_default();
        let ink = Ink::of(&theme);
        let mut view = TextView::new(&self.state)
            .style(style(&theme))
            .selectable(true)
            .code_block_actions({
                let theme = theme.clone();
                move |block, window, cx| copy_button("copy-code", block.code(), &theme, window, cx)
            })
            .table_actions({
                let theme = theme.clone();
                move |table, window, cx| {
                    div().flex().justify_end().child(copy_button(
                        "copy-table",
                        serialize_table(&table_rows(table), TableFormat::Markdown).into(),
                        &theme,
                        window,
                        cx,
                    ))
                }
            });
        if let Some(highlighter) = hooks.highlighter {
            view = view.shared_code_block_highlighter(highlighter);
        }
        if let Some(link) = hooks.link {
            view = view.on_link_click(move |href, event, window, cx| link(href, event, window, cx));
        }
        div()
            .group("markdown")
            .w_full()
            .min_w_0()
            .font_family(crate::assets::SANS)
            .text_size(px(CHAT_SIZE))
            .line_height(relative(CHAT_LINE_HEIGHT))
            .text_color(ink.foreground)
            .child(view)
    }
}

/// The copy control: no chrome at rest, `bg-muted/60` under the cursor, a
/// check for two seconds after a copy. Shown while the message is hovered.
fn copy_button(id: &'static str, text: SharedString, theme: &Theme, window: &mut Window, cx: &mut App) -> impl IntoElement + use<> {
    let copied = window.use_keyed_state(id, cx, |_, _| false);
    let done = *copied.read(cx);
    let (rest, fill) = (theme.muted_foreground, theme.muted.opacity(0.6));
    div()
        .id(id)
        .size(px(26.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .opacity(if done { 1. } else { 0. })
        .group_hover("markdown", |s| s.opacity(1.))
        .hover(move |s| s.bg(fill))
        .on_click(move |_, _, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(text.to_string()));
            copied.update(cx, |c, cx| {
                *c = true;
                cx.notify();
            });
            let copied = copied.downgrade();
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                _ = copied.update(cx, |c, cx| {
                    *c = false;
                    cx.notify();
                });
            })
            .detach();
        })
        .child(svg().path(if done { "icons/check.svg" } else { "icons/copy.svg" }).size(px(14.)).text_color(rest))
}

fn table_rows(table: &TableData) -> Vec<Vec<String>> {
    std::iter::once(table.headers.clone()).chain(table.rows.iter().cloned()).collect()
}

/// A table's copy formats, as MarkdownTable.tsx offers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableFormat {
    Markdown,
    Csv,
    Tsv,
}

/// markdownTable.ts's `serializeTable`: the header row first.
pub fn serialize_table(rows: &[Vec<String>], format: TableFormat) -> String {
    let Some((head, body)) = rows.split_first() else { return String::new() };
    match format {
        TableFormat::Markdown => {
            let line = |r: &[String]| format!("| {} |", r.iter().map(|c| c.replace('|', "\\|")).collect::<Vec<_>>().join(" | "));
            let rule: Vec<String> = head.iter().map(|_| "---".to_string()).collect();
            std::iter::once(line(head)).chain(std::iter::once(line(&rule))).chain(body.iter().map(|r| line(r))).collect::<Vec<_>>().join("\n")
        }
        TableFormat::Csv | TableFormat::Tsv => {
            let sep = if format == TableFormat::Csv { ',' } else { '\t' };
            // Quoted only where the field holds its own delimiter, a quote or
            // a newline: a comma is ordinary text in TSV.
            let field = |c: &String| {
                if c.contains(['"', '\n', sep]) { format!("\"{}\"", c.replace('"', "\"\"")) } else { c.clone() }
            };
            rows.iter().map(|r| r.iter().map(field).collect::<Vec<_>>().join(&sep.to_string())).collect::<Vec<_>>().join("\n")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_message_is_drawn_as_written() {
        assert_eq!(display_text("some **bold", false), "some **bold");
    }

    #[test]
    fn a_streaming_message_closes_what_it_opened() {
        assert_eq!(display_text("some **bold", true), "some **bold**");
        assert_eq!(display_text("a `cod", true), "a `cod`");
    }

    #[test]
    fn an_unfinished_link_draws_as_its_label() {
        assert_eq!(display_text("see [the docs](https://dr", true), "see the docs");
        assert_eq!(display_text("see [the do", true), "see the do");
        // Growing text keeps extending what is drawn, so the view appends.
        assert!(display_text("see [the doc", true).starts_with(&display_text("see [the do", true)));
    }

    #[test]
    fn an_unfinished_image_draws_nothing() {
        assert_eq!(display_text("look ![shot](https://x", true), "look ");
    }

    #[test]
    fn tables_serialize_as_markdown_table_does() {
        let rows = vec![vec!["a|b".into(), "c".into()], vec!["1, 2".into(), "say \"hi\"".into()]];
        assert_eq!(serialize_table(&rows, TableFormat::Markdown), "| a\\|b | c |\n| --- | --- |\n| 1, 2 | say \"hi\" |");
        assert_eq!(serialize_table(&rows, TableFormat::Csv), "a|b,c\n\"1, 2\",\"say \"\"hi\"\"\"");
        assert_eq!(serialize_table(&rows, TableFormat::Tsv), "a|b\tc\n1, 2\t\"say \"\"hi\"\"\"");
        assert_eq!(serialize_table(&[], TableFormat::Csv), "");
    }
}
