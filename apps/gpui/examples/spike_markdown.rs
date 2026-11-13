//! Settle point (c) of #856: markdown with tables, fences, links and images
//! renders as well as the web app's Streamdown does.
//!
//! gpui-base's `TextView` (the machinery under gpui-component's), styled to
//! Markdown.tsx's rules: one size for every element, bold headings with the
//! tightened rhythm, rules under table rows rather than a box, a bordered code
//! block coloured by tree-sitter. Pass `--stream` to feed the same text in a
//! few characters a frame, the way deltas arrive.
//!
//! `cargo run --example spike_markdown [-- --stream]`

use std::ops::Range;
use std::sync::Arc;

use gpui::{
    App, Bounds, Context, Entity, FontWeight, HighlightStyle, Render, StyleRefinement, Window, WindowBounds,
    WindowOptions, div, prelude::*, px, rems, rgb, size,
};
use gpui_base::text::{TextView, TextViewState, TextViewStyle};
use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

const FIXTURE: &str = include_str!("fixtures/markdown.md");

/// Default light, as App.css resolves it (hex of the `oklch()` tokens).
const FOREGROUND: u32 = 0x171b1f;
const MUTED_FOREGROUND: u32 = 0x65696f;
const LINK: u32 = 0x2393f1;
/// `--border` is black at 10%; this is it over the page.
const BORDER: u32 = 0xd6dce2;

/// Capture names the highlighter reports, and the colour each draws in —
/// GitHub light's, as the web app's default Shiki pair uses.
const CAPTURES: &[(&str, u32)] = &[
    ("keyword", 0xcf222e),
    ("function", 0x8250df),
    ("type", 0x953800),
    ("constructor", 0x0550ae),
    ("variable.parameter", 0x953800),
    ("string", 0x0a3069),
    ("comment", 0x6e7781),
    ("punctuation", 0x24292f),
    ("operator", 0xcf222e),
];

struct Spike {
    state: Entity<TextViewState>,
    fed: usize,
    stream: bool,
    highlight: Arc<dyn Fn(&gpui_base::text::CodeBlock) -> Vec<(Range<usize>, HighlightStyle)> + Send + Sync>,
}

fn highlighter() -> Arc<dyn Fn(&gpui_base::text::CodeBlock) -> Vec<(Range<usize>, HighlightStyle)> + Send + Sync> {
    let mut config = HighlightConfiguration::new(
        tree_sitter_rust::LANGUAGE.into(),
        "rust",
        tree_sitter_rust::HIGHLIGHTS_QUERY,
        tree_sitter_rust::INJECTIONS_QUERY,
        "",
    )
    .expect("rust highlight query");
    let names: Vec<&str> = CAPTURES.iter().map(|(n, _)| *n).collect();
    config.configure(&names);
    let config = Arc::new(config);
    Arc::new(move |block| {
        let mut out = Vec::new();
        let mut hl = Highlighter::new();
        let code = block.code();
        let Ok(events) = hl.highlight(&config, code.as_bytes(), None, None, |_| None) else { return out };
        let mut stack = Vec::new();
        for event in events.flatten() {
            match event {
                HighlightEvent::HighlightStart(h) => stack.push(h.0),
                HighlightEvent::HighlightEnd => {
                    stack.pop();
                }
                HighlightEvent::Source { start, end } => {
                    if let Some(&ix) = stack.last() {
                        out.push((
                            start..end,
                            HighlightStyle { color: Some(rgb(CAPTURES[ix].1).into()), ..Default::default() },
                        ));
                    }
                }
            }
        }
        out
    })
}

fn style() -> TextViewStyle {
    // Markdown.tsx: every element at `text-chat`; headings keep their weight
    // and lose the size jump, with `mt-4 mb-2` (h1, h2) and `mt-3 mb-1.5` (h3).
    let heading = |level: u8| {
        let mut s = StyleRefinement::default().font_weight(FontWeight::BOLD).text_size(px(15.));
        s = if level <= 2 { s.mt_4().mb_2() } else { s.mt_3().mb(px(6.)) };
        s
    };
    // `[data-streamdown=code-block]`: a 1px `--border` box at `--radius-md`.
    let code_block = StyleRefinement::default().border_1().border_color(rgb(BORDER)).rounded(px(8.)).p_4();
    // Streamdown's inline code: a `--muted` chip (black 11.5% over the page in
    // light), `rounded-md`, a little padding.
    let inline_code = StyleRefinement::default().bg(gpui::hsla(0., 0., 0., 0.08)).rounded(px(6.)).px_1();
    // The table: no enclosing box and no column rules, only row rules.
    let table = StyleRefinement::default().border_0().bg(gpui::transparent_black());
    let cell = StyleRefinement::default().border_color(gpui::transparent_black());
    TextViewStyle::default()
        .with_foreground(rgb(FOREGROUND).into())
        .with_muted_foreground(rgb(MUTED_FOREGROUND).into())
        .with_link(rgb(LINK).into())
        .with_border(rgb(BORDER).into())
        .with_code_background(gpui::transparent_black())
        .with_paragraph_gap(rems(1.))
        .with_heading(heading)
        .with_code_block(code_block)
        .with_inline_code_style(inline_code)
        .with_table(table)
        .with_table_cell(cell)
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.stream && self.fed < FIXTURE.len() {
            let mut end = (self.fed + 6).min(FIXTURE.len());
            while !FIXTURE.is_char_boundary(end) {
                end += 1;
            }
            let delta = &FIXTURE[self.fed..end];
            self.state.update(cx, |s, cx| s.push_str(delta, cx));
            self.fed = end;
            window.request_animation_frame();
        }
        div().size_full().bg(rgb(0xeef4fb)).flex().justify_center().overflow_hidden().child(
            div().w(px(720.)).pt_8().font_family("Geist").text_size(px(15.)).line_height(rems(1.65 * 0.9375)).child(
                TextView::new(&self.state)
                    .style(style())
                    .shared_code_block_highlighter(self.highlight.clone())
                    // React's copy control; setting actions also drops the
                    // language label, which the web app hides.
                    .code_block_actions(|_, _, _| div().text_xs().opacity(0.5).child("Copy"))
                    .selectable(true),
            ),
        )
    }
}

fn main() {
    let stream = std::env::args().any(|a| a == "--stream");
    // Remote images load through the app's HTTP client; GPUI has none by default.
    let http = Arc::new(reqwest_client::ReqwestClient::new());
    gpui_platform::application().with_http_client(http).run(move |cx: &mut App| {
        gpui_base::init(cx);
        for font in [
            include_bytes!("../assets/fonts/Geist-Regular.ttf").as_slice(),
            include_bytes!("../assets/fonts/Geist-Medium.ttf"),
            include_bytes!("../assets/fonts/Geist-SemiBold.ttf"),
            include_bytes!("../assets/fonts/GeistMono-Regular.ttf"),
        ] {
            cx.text_system().add_fonts(vec![font.into()]).ok();
        }
        let bounds = Bounds::centered(None, size(px(960.), px(800.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| {
                cx.new(|cx| Spike {
                    state: cx.new(|cx| TextViewState::markdown(if stream { "" } else { FIXTURE }, cx)),
                    fed: if stream { 0 } else { FIXTURE.len() },
                    stream,
                    highlight: highlighter(),
                })
            },
        )
        .unwrap();
        cx.activate(true);
    });
}
