//! The three code surfaces as GPUI elements: a markdown fence, a ranged `Read`
//! and a diff. Each takes prepared data ([`Highlighted`], [`Diff`]) so a
//! re-render never re-highlights; the caller caches that beside its event.

use std::ops::Range;
use std::sync::Arc;

use gpui::{
    AnyElement, App, ElementId, FontWeight, HighlightStyle, Hsla, IntoElement, ParentElement, Pixels, RenderOnce,
    SharedString, Styled, StyledText, Window, div, prelude::*, px,
};

use super::diff::{Diff, DiffItem, RowKind};
use super::highlight::{Lang, Span, Token, highlight, line_ranges, spans_in};
use super::palette::CodePalette;
use crate::theme::{Mode, Theme};

const MONO: &str = "Geist Mono";
const SANS: &str = "Geist";

/// Geist Mono's `liga` eats the space before `--` under GPUI's shaping, so
/// `ls --all` drew `ls--all`. Same as `assets::mono_features` in #1033; use
/// that one once both land.
fn mono_features() -> gpui::FontFeatures {
    gpui::FontFeatures(Arc::new(vec![("liga".into(), 0)]))
}

/// `@pierre/diffs`' own metrics, which its shadow root sets whatever the host's
/// `text-code` says: 13px on 20px rows.
const DIFF_SIZE: f32 = 13.;
const DIFF_LINE: f32 = 20.;
/// Markdown.tsx's `[&_pre_code]:text-code`: 0.875rem at 1.6.
const FENCE_SIZE: f32 = 14.;
const FENCE_LINE: f32 = 22.4;
/// One `ch` of Geist Mono at 13px (600 units to the em).
const CH: f32 = DIFF_SIZE * 0.6;
/// `--radius-md`.
const RADIUS: f32 = 8.;
/// CodeView's `max-h-96`: a `Read` of 2000 lines is legal.
const READ_MAX_HEIGHT: f32 = 384.;

/// A text highlighted once and split into lines. Tabs become four spaces first,
/// so the spans index the text that is drawn.
#[derive(Clone, Debug)]
pub struct Highlighted {
    text: String,
    lines: Vec<(Range<usize>, Vec<Span>)>,
}

impl Highlighted {
    pub fn new(lang: Option<Lang>, text: &str) -> Arc<Highlighted> {
        let text = text.replace('\t', "    ");
        let spans = lang.map(|lang| highlight(lang, &text)).unwrap_or_default();
        let lines = line_ranges(&text)
            .into_iter()
            .map(|range| {
                let line_spans = spans_in(&spans, &range);
                (range, line_spans)
            })
            .collect();
        Arc::new(Highlighted { text, lines })
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }
}

/// The styles a fence's text takes, for a host that lays the block out itself:
/// gpui-base `TextView`'s `code_block_highlighter` wants exactly this shape.
pub fn fence_highlights(info: &str, code: &str, mode: Mode) -> Vec<(Range<usize>, HighlightStyle)> {
    let Some(lang) = Lang::from_fence(info) else { return Vec::new() };
    let palette = palette(mode);
    highlight(lang, code)
        .into_iter()
        .map(|s| (s.range, HighlightStyle { color: Some(palette.token(s.token)), ..Default::default() }))
        .collect()
}

fn palette(mode: Mode) -> &'static CodePalette {
    use std::sync::OnceLock;
    static DARK: OnceLock<CodePalette> = OnceLock::new();
    static LIGHT: OnceLock<CodePalette> = OnceLock::new();
    match mode {
        Mode::Dark => DARK.get_or_init(|| CodePalette::pierre(Mode::Dark)),
        Mode::Light => LIGHT.get_or_init(|| CodePalette::pierre(Mode::Light)),
    }
}

fn resolve(mode: Option<Mode>, cx: &App) -> &'static CodePalette {
    palette(mode.unwrap_or_else(|| Theme::get(cx).mode))
}

/// One line's text with its token colours and, on a changed diff line, the
/// changed words' wash. The two overlap, so they are cut at every boundary
/// into the sorted, disjoint runs `StyledText` wants.
fn styled_line(text: &str, spans: &[Span], marks: &[Range<usize>], mark: Hsla, palette: &CodePalette) -> StyledText {
    let text = SharedString::from(text.to_string());
    if marks.is_empty() {
        let runs = spans
            .iter()
            .map(|s| (s.range.clone(), HighlightStyle { color: Some(palette.token(s.token)), ..Default::default() }));
        return StyledText::new(text).with_highlights(runs);
    }
    let runs = merge_runs(spans, marks).into_iter().map(|(range, token, marked)| {
        let style = HighlightStyle {
            color: token.map(|t| palette.token(t)),
            background_color: marked.then_some(mark),
            ..Default::default()
        };
        (range, style)
    });
    StyledText::new(text).with_highlights(runs)
}

/// Spans and marks, both sorted and disjoint, cut into runs that each carry
/// at most one token and a marked flag. One pass with an index into each: a
/// minified line can hold thousands of spans, and this runs on every repaint.
fn merge_runs(spans: &[Span], marks: &[Range<usize>]) -> Vec<(Range<usize>, Option<Token>, bool)> {
    let mut cuts: Vec<usize> = spans
        .iter()
        .flat_map(|s| [s.range.start, s.range.end])
        .chain(marks.iter().flat_map(|m| [m.start, m.end]))
        .collect();
    cuts.sort_unstable();
    cuts.dedup();
    let (mut si, mut mi) = (0, 0);
    let mut runs = Vec::new();
    for pair in cuts.windows(2) {
        let range = pair[0]..pair[1];
        while si < spans.len() && spans[si].range.end <= range.start {
            si += 1;
        }
        while mi < marks.len() && marks[mi].end <= range.start {
            mi += 1;
        }
        let token = spans.get(si).filter(|s| s.range.start <= range.start).map(|s| s.token);
        let marked = marks.get(mi).is_some_and(|m| m.start <= range.start);
        if token.is_some() || marked {
            runs.push((range, token, marked));
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_tokens_and_marks_into_disjoint_runs() {
        let spans = [Span { range: 0..4, token: Token::Keyword }, Span { range: 6..10, token: Token::String }];
        let runs = merge_runs(&spans, &[2..8]);
        assert_eq!(
            runs,
            vec![
                (0..2, Some(Token::Keyword), false),
                (2..4, Some(Token::Keyword), true),
                (4..6, None, true),
                (6..8, Some(Token::String), true),
                (8..10, Some(Token::String), false),
            ]
        );
    }
}

/// A gutter wide enough for the largest number, plus the library's
/// `padding-left: 2ch; padding-right: 1ch` and its `3ch` minimum. Half a `ch`
/// of slack, since a number one subpixel too wide for its box wraps.
fn gutter_width(largest: usize) -> Pixels {
    let digits = largest.max(1).to_string().len().max(3);
    px((digits as f32 + 3.5) * CH)
}

/// A gutter cell, then the 2px `--diffs-gap-style` rule in the background
/// colour, then the line.
fn row(
    number: Option<usize>,
    width: Pixels,
    number_color: Hsla,
    gutter_bg: Option<Hsla>,
    line_bg: Option<Hsla>,
    content: impl IntoElement,
    palette: &CodePalette,
) -> gpui::Div {
    let mut gutter = div()
        .flex_none()
        .w(width)
        .pl(px(2. * CH))
        .pr(px(CH))
        .text_right()
        .whitespace_nowrap()
        .text_color(number_color)
        .children(number.map(|n| n.to_string()));
    if let Some(bg) = gutter_bg {
        gutter = gutter.bg(bg);
    }
    let mut line = div().flex_1().min_w_0().px(px(CH)).text_color(palette.foreground).child(content);
    if let Some(bg) = line_bg {
        line = line.bg(bg);
    }
    div()
        .flex()
        .w_full()
        .min_h(px(DIFF_LINE))
        .child(gutter)
        .child(div().flex_none().w(px(2.)).bg(palette.background))
        .child(line)
}

/// The DiffView/CodeView frame: `rounded-md border border-border/60`, on the
/// theme's editor background.
fn frame(palette: &CodePalette) -> gpui::Div {
    div()
        .w_full()
        .overflow_hidden()
        .rounded(px(RADIUS))
        .border_1()
        .border_color(palette.frame_border)
        .bg(palette.background)
        .font_family(MONO)
        .font_features(mono_features())
        .text_size(px(DIFF_SIZE))
        .line_height(px(DIFF_LINE))
}

/// A markdown fence: a `--border` box, transparent inside, no line numbers,
/// scrolling sideways rather than wrapping as Streamdown's does.
#[derive(IntoElement)]
pub struct CodeBlock {
    id: ElementId,
    code: Arc<Highlighted>,
    mode: Option<Mode>,
}

impl CodeBlock {
    pub fn new(id: impl Into<ElementId>, code: Arc<Highlighted>) -> CodeBlock {
        CodeBlock { id: id.into(), code, mode: None }
    }

    /// Draw in this mode rather than the app theme's.
    pub fn mode(mut self, mode: Mode) -> Self {
        self.mode = Some(mode);
        self
    }
}

impl RenderOnce for CodeBlock {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = resolve(self.mode, cx);
        let code = &self.code;
        div().w_full().rounded(px(RADIUS)).border_1().border_color(palette.fence_border).overflow_hidden().child(
            div()
                .id(self.id)
                .overflow_x_scroll()
                .p_4()
                .font_family(MONO)
                .font_features(mono_features())
                .text_size(px(FENCE_SIZE))
                .line_height(px(FENCE_LINE))
                .text_color(palette.foreground)
                .children(code.lines.iter().map(|(range, spans)| {
                    div().min_h(px(FENCE_LINE)).whitespace_nowrap().child(styled_line(
                        &code.text[range.clone()],
                        spans,
                        &[],
                        palette.foreground,
                        palette,
                    ))
                })),
        )
    }
}

/// The slice a ranged `Read` returned, numbered from where it starts in the file.
#[derive(IntoElement)]
pub struct CodeView {
    id: ElementId,
    code: Arc<Highlighted>,
    start_line: usize,
    mode: Option<Mode>,
}

impl CodeView {
    /// `start_line` is 1-based, the `Read`'s `offset`.
    pub fn new(id: impl Into<ElementId>, code: Arc<Highlighted>, start_line: usize) -> CodeView {
        CodeView { id: id.into(), code, start_line: start_line.max(1), mode: None }
    }

    pub fn mode(mut self, mode: Mode) -> Self {
        self.mode = Some(mode);
        self
    }
}

impl RenderOnce for CodeView {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = resolve(self.mode, cx);
        let code = &self.code;
        let width = gutter_width(self.start_line + code.line_count());
        frame(palette).child(div().id(self.id).max_h(px(READ_MAX_HEIGHT)).overflow_y_scroll().py(px(8.)).children(
            code.lines.iter().enumerate().map(|(i, (range, spans))| {
                let text = styled_line(&code.text[range.clone()], spans, &[], palette.foreground, palette);
                row(Some(self.start_line + i), width, palette.line_number, None, None, text, palette)
            }),
        ))
    }
}

/// A unified diff: an `Edit`'s region, a `Write`'s new file, or a whole file
/// against its old self.
#[derive(IntoElement)]
pub struct DiffView {
    diff: Arc<Diff>,
    mode: Option<Mode>,
}

impl DiffView {
    pub fn new(diff: Arc<Diff>) -> DiffView {
        DiffView { diff, mode: None }
    }

    pub fn mode(mut self, mode: Mode) -> Self {
        self.mode = Some(mode);
        self
    }
}

impl RenderOnce for DiffView {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = resolve(self.mode, cx);
        let largest = self
            .diff
            .items
            .iter()
            .filter_map(|item| match item {
                DiffItem::Row(r) => Some(r.number),
                DiffItem::Folded(_) => None,
            })
            .max()
            .unwrap_or(1);
        let width = gutter_width(largest);
        let items: Vec<AnyElement> = self
            .diff
            .items
            .iter()
            .map(|item| match item {
                DiffItem::Folded(n) => folded(*n, width, palette).into_any_element(),
                DiffItem::Row(r) => {
                    let (number_color, gutter_bg, line_bg, mark) = match r.kind {
                        RowKind::Context => (palette.line_number, None, None, palette.foreground),
                        RowKind::Addition => (
                            palette.addition,
                            Some(palette.addition_gutter),
                            Some(palette.addition_line),
                            palette.addition_emphasis,
                        ),
                        RowKind::Deletion => (
                            palette.deletion,
                            Some(palette.deletion_gutter),
                            Some(palette.deletion_line),
                            palette.deletion_emphasis,
                        ),
                    };
                    let text = styled_line(&r.text, &r.spans, &r.emphasis, mark, palette);
                    row(Some(r.number), width, number_color, gutter_bg, line_bg, text, palette).into_any_element()
                }
            })
            .collect();
        frame(palette).child(div().py(px(8.)).children(items))
    }
}

/// The library's `line-info` separator: a 32px bar naming what was folded.
fn folded(lines: usize, width: Pixels, palette: &CodePalette) -> impl IntoElement {
    let label = if lines == 1 { "1 unmodified line".to_string() } else { format!("{lines} unmodified lines") };
    div()
        .flex()
        .items_center()
        .h(px(32.))
        .my(px(4.))
        .bg(palette.separator)
        .pl(width + px(2. + CH))
        .font_family(SANS)
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(palette.line_number)
        .child(label)
}
