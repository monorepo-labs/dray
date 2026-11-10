//! Settle point (d) of #856: text input good enough for the composer.
//!
//! gpui-base's `Textarea` in the composer's shape: `text-prompt` (15px / 1.5),
//! growing from one row, Enter sends and Shift+Enter breaks the line, the
//! placeholder the web app shows. What was sent prints to stdout, so a driven
//! test can read it back.
//!
//! `cargo run --example spike_input`

use gpui::{
    App, Bounds, Context, Entity, Render, Subscription, Window, WindowBounds, WindowOptions, div, prelude::*, px, rems,
    rgb, size,
};
use gpui_base::input::{InputEvent, Textarea, TextareaState};

struct Spike {
    input: Entity<TextareaState>,
    sent: Vec<String>,
    _subscription: Subscription,
}

impl Spike {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 12)
                .placeholder("Describe a task. @files. /skills. &tasks. #issues.")
        });
        let subscription = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { shift: false, secondary: false } = event {
                let text = input.read(cx).value().trim_end().to_string();
                if !text.is_empty() {
                    println!("sent: {text:?}");
                    this.sent.push(text);
                    input.update(cx, |s, cx| s.set_value("", window, cx));
                    cx.notify();
                }
            }
        });
        input.update(cx, |s, cx| s.focus(window, cx));
        Spike { input, sent: Vec::new(), _subscription: subscription }
    }
}

impl Render for Spike {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(rgb(0xeef4fb))
            .font_family("Geist")
            .text_color(rgb(0x171b1f))
            .flex()
            .flex_col()
            .justify_end()
            .items_center()
            .p_8()
            .gap_4()
            .children(
                self.sent
                    .iter()
                    .map(|s| div().max_w(px(720.)).px_4().py_2().rounded(px(14.)).bg(rgb(0xffffff)).child(s.clone())),
            )
            .child(
                // The composer card: `rounded-2xl`, the prompt at 15px / 1.5.
                div()
                    .w(px(720.))
                    .px_4()
                    .py_3()
                    .rounded(px(18.))
                    .bg(rgb(0xfcfdfe))
                    .border_1()
                    .border_color(rgb(0xd6dce2))
                    .text_size(px(15.))
                    .line_height(rems(0.9375 * 1.5))
                    .child(Textarea::new(&self.input)),
            )
    }
}

fn main() {
    gpui_platform::application().run(|cx: &mut App| {
        gpui_base::init(cx);
        for font in [
            include_bytes!("../assets/fonts/Geist-Regular.ttf").as_slice(),
            include_bytes!("../assets/fonts/Geist-Medium.ttf"),
        ] {
            cx.text_system().add_fonts(vec![font.into()]).ok();
        }
        let bounds = Bounds::centered(None, size(px(900.), px(600.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |window, cx| cx.new(|cx| Spike::new(window, cx)),
        )
        .unwrap();
        cx.activate(true);
    });
}
