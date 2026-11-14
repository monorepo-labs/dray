//! The transcript's markdown module with fake data: a finished reply on the
//! left and the same reply streaming on the right, a few characters a frame
//! the way deltas arrive, over and over. The left is a held `Markdown` view;
//! the right is `markdown::element`, handed the whole text every frame.
//!
//! `cargo run --example markdown [-- --dark] [-- --fast]`
//!
//! The highlighter here is a stand-in that colours a handful of Rust keywords,
//! to show the hook working; the code module supplies the real one.

#[path = "../src/assets.rs"]
mod assets;
#[path = "../src/color.rs"]
#[allow(dead_code)]
mod color;
#[path = "../src/markdown.rs"]
#[allow(dead_code)]
mod markdown;
#[path = "../src/theme.rs"]
#[allow(dead_code)]
mod theme;

use std::ops::Range;
use std::sync::Arc;

use gpui::{
    App, AppContext, Bounds, Context, Entity, HighlightStyle, Render, Window, WindowBounds, WindowOptions, div,
    prelude::*, px, size,
};

use markdown::Markdown;
use theme::{Mode, Theme};

const REPLY: &str = include_str!("../src/markdown/fixtures/reply.md");

struct Demo {
    finished: Entity<Markdown>,
    fed: usize,
    step: usize,
    pause: u32,
}

impl Render for Demo {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.pause > 0 {
            self.pause -= 1;
        } else if self.fed < REPLY.len() {
            let mut end = (self.fed + self.step).min(REPLY.len());
            while !REPLY.is_char_boundary(end) {
                end += 1;
            }
            self.fed = end;
            if self.fed == REPLY.len() {
                self.pause = 180;
            }
        } else {
            self.fed = 0;
        }
        // The streaming side goes the transcript's way: the whole text so
        // far, every frame, through the stateless entry.
        let streaming = markdown::element("streaming-reply", &REPLY[..self.fed], self.fed < REPLY.len());
        window.request_animation_frame();

        let theme = Theme::get(cx).clone();
        // No glass on Linux: the light page or dark background, as the body
        // would look over a plain desktop.
        let page = match theme.mode {
            Mode::Light => color::oklch(0.965, 0.012, 250., 1.).hsla(),
            Mode::Dark => color::oklch(0.145, 0., 0., 1.).hsla(),
        };
        let column = |label: &'static str, view: gpui::AnyElement| {
            div()
                .id(label)
                .flex_1()
                .min_w_0()
                .h_full()
                .overflow_y_scroll()
                .px_8()
                .pt_6()
                .pb_16()
                .child(div().text_xs().text_color(theme.muted_foreground).pb_4().child(label))
                .child(view)
        };
        div()
            .size_full()
            .bg(page)
            .flex()
            .gap_4()
            .child(column("finished", self.finished.clone().into_any_element()))
            .child(div().w(px(1.)).h_full().bg(theme.sidebar_border))
            .child(column("streaming", streaming.into_any_element()))
    }
}

/// Colours `fn`, `match`, `let` and friends, and `//` comments.
fn fake_highlighter(dark: bool) -> Arc<markdown::CodeHighlighter> {
    let keyword = if dark { gpui::rgb(0xff7b72) } else { gpui::rgb(0xcf222e) };
    let comment = if dark { gpui::rgb(0x8b949e) } else { gpui::rgb(0x6e7781) };
    Arc::new(move |_lang, code| {
        let mut out: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
        let mut offset = 0;
        for line in code.split_inclusive('\n') {
            if let Some(c) = line.find("//") {
                out.push((offset + c..offset + line.trim_end().len(), HighlightStyle { color: Some(comment.into()), ..Default::default() }));
            }
            for kw in ["fn ", "match ", "let ", "Some", "None"] {
                for (i, _) in line.match_indices(kw) {
                    let end = offset + i + kw.trim_end().len();
                    out.push((offset + i..end, HighlightStyle { color: Some(keyword.into()), ..Default::default() }));
                }
            }
            offset += line.len();
        }
        out.sort_by_key(|(r, _)| r.start);
        out
    })
}

fn main() {
    let dark = std::env::args().any(|a| a == "--dark");
    let fast = std::env::args().any(|a| a == "--fast");
    gpui_platform::application().with_assets(assets::Assets).run(move |cx: &mut App| {
        assets::load_fonts(cx);
        cx.set_global(Theme::new(if dark { Mode::Dark } else { Mode::Light }));
        markdown::init(cx);
        markdown::set_code_highlighter(cx, fake_highlighter(dark));
        markdown::set_link_handler(
            cx,
            Arc::new(|href, _, _, _| println!("link clicked: {href}")),
        );
        let bounds = Bounds::centered(None, size(px(1500.), px(1000.)), cx);
        cx.open_window(WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() }, |_, cx| {
            cx.new(|cx| Demo {
                finished: cx.new(|cx| Markdown::new(REPLY, false, cx)),
                fed: 0,
                step: if fast { 24 } else { 3 },
                pause: 30,
            })
        })
        .unwrap();
        cx.activate(true);
    });
}
