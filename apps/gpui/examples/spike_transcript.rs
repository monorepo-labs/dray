//! Settle point (b) of #856: a virtualised transcript scrolls smoothly while
//! streaming text grows at the bottom.
//!
//! 3,000 messages of wrapped text in GPUI's `list`, the last one growing every
//! frame. Phase one follows the tail; phase two scrolls up through the history
//! while the stream keeps growing; phase three scrolls back down, where tail
//! following should pick up again. Frame intervals are logged per phase.
//!
//! `cargo run --release --example spike_transcript` — keep the window in front,
//! since macOS throttles a hidden window's frames.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, Context, FollowMode, ListAlignment, ListState, Render, Window, WindowBounds, WindowOptions, div, list,
    prelude::*, px, rgb, size,
};

const MESSAGES: usize = 3000;
const PHASE_FRAMES: usize = 600;
const PHASES: &[&str] = &["idle baseline", "follow tail", "scroll up while streaming", "scroll back down"];
const WORDS: &[&str] = &[
    "the",
    "transcript",
    "streams",
    "tokens",
    "while",
    "a",
    "reader",
    "scrolls",
    "through",
    "history",
    "and",
    "nothing",
    "should",
    "jank",
    "or",
    "jump",
    "under",
    "the",
    "cursor",
    "when",
    "rows",
    "wrap",
    "differently",
];

struct Spike {
    list: ListState,
    texts: Rc<RefCell<Vec<String>>>,
    frame: usize,
    last: Option<Instant>,
    intervals: Vec<Duration>,
    phase: usize,
}

fn paragraph(seed: usize) -> String {
    // Varied lengths, so rows wrap to different heights.
    let words = 8 + (seed * 37) % 120;
    (0..words).map(|i| WORDS[(seed + i * 7) % WORDS.len()]).collect::<Vec<_>>().join(" ")
}

impl Spike {
    fn new() -> Self {
        let texts: Vec<String> = (0..MESSAGES).map(paragraph).collect();
        let list = ListState::new(MESSAGES, ListAlignment::Bottom, px(800.));
        list.set_follow_mode(FollowMode::Tail);
        Spike { list, texts: Rc::new(RefCell::new(texts)), frame: 0, last: None, intervals: Vec::new(), phase: 0 }
    }

    fn report(&mut self) {
        let mut ms: Vec<f64> = self.intervals.iter().map(|d| d.as_secs_f64() * 1000.).collect();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pick = |q: f64| ms[((ms.len() as f64 - 1.) * q) as usize];
        let mean = ms.iter().sum::<f64>() / ms.len() as f64;
        let over = ms.iter().filter(|&&m| m > 25.).count();
        let name = PHASES[self.phase];
        println!(
            "{name:<26} frames={} mean={mean:.2}ms p50={:.2} p95={:.2} p99={:.2} max={:.2} over25ms={over} following={}",
            ms.len(),
            pick(0.5),
            pick(0.95),
            pick(0.99),
            ms[ms.len() - 1],
            self.list.is_following_tail(),
        );
        self.intervals.clear();
    }
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        if let Some(last) = self.last.replace(now) {
            self.intervals.push(now - last);
        }
        self.frame += 1;

        // The stream: a word onto the last message every frame (~60 tok/s),
        // with a paragraph break every 40 words, as a markdown reply has.
        // Phase 0 is the baseline: nothing changes, only frames are asked for.
        let last = MESSAGES - 1;
        if self.phase > 0 {
            let word = if self.frame % 40 == 0 { "\n\nnext" } else { " streaming" };
            self.texts.borrow_mut()[last].push_str(word);
            self.list.remeasure_items(last..last + 1);
        }

        match self.phase {
            2 => self.list.scroll_by(px(-12.)),
            3 => self.list.scroll_by(px(12.)),
            _ => {}
        }
        if self.intervals.len() == PHASE_FRAMES {
            self.report();
            self.phase += 1;
            if self.phase == PHASES.len() {
                cx.quit();
            }
        }
        window.request_animation_frame();

        let texts = self.texts.clone();
        div().size_full().bg(rgb(0x0a0a0a)).text_color(rgb(0xfafafa)).text_size(px(15.)).child(
            list(self.list.clone(), move |ix, _, _| {
                // One element per paragraph, so a growing reply re-lays-out its
                // last paragraph and GPUI's line cache keeps the rest.
                div()
                    .px_6()
                    .py_2()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .children(
                        texts.borrow()[ix]
                            .split("\n\n")
                            .map(|p| div().line_height(px(24.)).child(p.to_string()))
                            .collect::<Vec<_>>(),
                    )
                    .into_any_element()
            })
            .size_full(),
        )
    }
}

fn main() {
    gpui_platform::application().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(900.), px(800.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| cx.new(|_| Spike::new()),
        )
        .unwrap();
        cx.activate(true);
    });
}
