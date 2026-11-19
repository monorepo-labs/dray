//! The session composer on fake data, for building it apart from the window.
//!
//! Type `@`, `/`, `&` or `#` for the pickers; ↑↓ and ⏎ or Tab pick. Paste or
//! drop files and images. The mic cycles dictation through its states with a
//! fake level. Sending prints the prompt and attachments to stdout, and a send
//! makes the next few seconds a running turn, so the empty button reads Stop.
//!
//! `cargo run --example composer [-- --light] [-- --demo]`
//! `--demo` opens with a tagged prompt, two attachments and the `@` picker up,
//! for a screenshot.

#[path = "../src/assets.rs"]
mod assets;
#[path = "../src/color.rs"]
mod color;
#[allow(dead_code)]
#[path = "../src/composer/composer.rs"]
mod composer;
#[allow(dead_code)]
#[path = "../src/theme.rs"]
mod theme;
#[allow(dead_code)]
#[path = "../src/ui.rs"]
mod ui;

use std::time::Duration;

use composer::segments::Sigil;
use composer::{Composer, ComposerEvent, Dictation, PickerRow};
use gpui::{
    App, Bounds, Context, Entity, FontWeight, Render, Subscription, Window, WindowBounds, WindowOptions, div,
    prelude::*, px, size,
};
use theme::{Mode, Theme};

const FILES: &[&str] = &[
    "apps/desktop/src/components/ChatInput.tsx",
    "apps/desktop/src/components/composer/RichInput.tsx",
    "apps/desktop/src/components/composer/PickerMenu.tsx",
    "apps/desktop/src/lib/mention.ts",
    "apps/desktop/src/lib/highlight.ts",
    "apps/gpui/src/composer/composer.rs",
    "apps/gpui/src/sidebar.rs",
    "apps/gpui/Cargo.toml",
    "CLAUDE.md",
    "README.md",
];

const COMMANDS: &[(&str, &str)] = &[
    ("review", "Review a pull request"),
    ("init", "Initialize a new CLAUDE.md file with codebase documentation"),
    ("security-review", "Complete a security review of the pending changes"),
    ("caveman-commit", "Ultra-compressed commit message generator (user)"),
    ("greploop", "Loop Greptile review until 5/5 (user)"),
];

const TASKS: &[(&str, &str)] = &[
    ("6f1c2d0e-0000-4000-8000-000000000001", "Port the sidebar to GPUI"),
    ("6f1c2d0e-0000-4000-8000-000000000002", "Markdown renderer for the transcript"),
    ("6f1c2d0e-0000-4000-8000-000000000003", "Fix flaky changes-panel test"),
];

const ISSUES: &[(&str, &str)] = &[
    ("DRA-53", "Composer loses its draft on session switch"),
    ("DRA-217", "Slash picker is silent for a harness with no commands"),
    ("DRA-264", "Tasks panel full of running Wait-for rows"),
];

struct Demo {
    composer: Entity<Composer>,
    sent: Vec<String>,
    _subscription: Subscription,
}

impl Demo {
    fn new(demo: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| {
            let mut c = Composer::new(window, cx);
            c.set_context(false, true, true, window, cx);
            c.set_rows(Sigil::File, FILES.iter().map(|p| PickerRow::file(p)).collect(), cx);
            c.set_rows(Sigil::Command, COMMANDS.iter().map(|(n, d)| PickerRow::command(n, d)).collect(), cx);
            c.set_rows(Sigil::Task, TASKS.iter().map(|(id, t)| PickerRow::task(id, t)).collect(), cx);
            c.set_rows(Sigil::Issue, ISSUES.iter().map(|(id, t)| PickerRow::issue(id, t)).collect(), cx);
            c.focus(window, cx);
            c
        });
        let subscription = cx.subscribe_in(&composer, window, |this, composer, event: &ComposerEvent, window, cx| {
            println!("{event:?}");
            match event {
                ComposerEvent::Send { text, attachments } => {
                    let names: Vec<_> = attachments.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy()).collect();
                    this.sent.push(if names.is_empty() { text.clone() } else { format!("{text}  [{}]", names.join(", ")) });
                    composer.update(cx, |c, cx| c.set_busy(true, cx));
                    let composer = composer.clone();
                    cx.spawn(async move |_, cx| {
                        cx.background_executor().timer(Duration::from_secs(6)).await;
                        composer.update(cx, |c, cx| c.set_busy(false, cx));
                    })
                    .detach();
                    cx.notify();
                }
                ComposerEvent::Stop => composer.update(cx, |c, cx| c.set_busy(false, cx)),
                ComposerEvent::DictateStart => {
                    composer.update(cx, |c, cx| c.set_dictation(Dictation::Recording { level: 0.3 }, cx));
                    let composer = composer.clone();
                    cx.spawn(async move |_, cx| {
                        for i in 0..400u32 {
                            cx.background_executor().timer(Duration::from_millis(80)).await;
                            let level = ((i as f32 * 0.7).sin() * 0.5 + 0.5) * 0.9;
                            let still = composer
                                .update(cx, |c, cx| {
                                    let on = matches!(c.dictation(), Dictation::Recording { .. });
                                    if on {
                                        c.set_dictation(Dictation::Recording { level }, cx);
                                    }
                                    on
                                })
                                ;
                            if !still {
                                break;
                            }
                        }
                    })
                    .detach();
                }
                ComposerEvent::DictateCancel => composer.update(cx, |c, cx| c.set_dictation(Dictation::Idle, cx)),
                ComposerEvent::DictateStop => {
                    composer.update(cx, |c, cx| c.set_dictation(Dictation::Transcribing, cx));
                    let composer = composer.clone();
                    let window = window.window_handle();
                    cx.spawn(async move |_, cx| {
                        cx.background_executor().timer(Duration::from_millis(1200)).await;
                        window
                            .update(cx, |_, window, cx| {
                                composer.update(cx, |c, cx| {
                                    c.set_dictation(Dictation::Idle, cx);
                                    c.insert_text("words from the microphone ", window, cx);
                                })
                            })
                            .ok();
                    })
                    .detach();
                }
                ComposerEvent::Query { .. } => {}
            }
        });
        if demo {
            stage_demo(composer.clone(), window, cx);
        }
        Demo { composer, sent: Vec::new(), _subscription: subscription }
    }
}

/// Types a prompt the way a reader would, picking a tag of each kind, then
/// leaves the `@` picker open. Each step waits a beat for the input's change
/// event to reach the composer.
fn stage_demo(composer: Entity<Composer>, window: &mut Window, cx: &mut Context<Demo>) {
    let window = window.window_handle();
    let root = std::env::current_dir().unwrap_or_default();
    cx.spawn(async move |_, cx| {
        let steps: &[(&str, bool)] =
            &[("Fix ", false), ("#DRA-5", true), ("— same bug as ", false), ("&GPUI", true), ("then check ", false), ("@ChatIn", false)];
        for (text, pick) in steps {
            window
                .update(cx, |_, window, cx| composer.update(cx, |c, cx| c.insert_text(text, window, cx)))
                .ok();
            cx.background_executor().timer(Duration::from_millis(150)).await;
            if *pick {
                window.update(cx, |_, window, cx| composer.update(cx, |c, cx| c.pick(0, window, cx))).ok();
                cx.background_executor().timer(Duration::from_millis(150)).await;
            }
        }
        let attach = [
            root.join("../desktop/src-tauri/icons/128x128.png"),
            root.join("Cargo.toml"),
        ];
        composer.update(cx, |c, cx| c.attach(attach, cx));
    })
    .detach();
}

impl Render for Demo {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        div()
            .size_full()
            .bg(theme.body)
            .font_family(assets::SANS)
            .text_color(theme.foreground)
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .justify_end()
                    .items_center()
                    .gap_3()
                    .p_8()
                    .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.muted_foreground).child("Composer, fake data"))
                    .children(self.sent.iter().map(|s| {
                        div().max_w(px(720.)).px_4().py_2().rounded(px(16.)).bg(theme.muted).text_size(px(15.)).child(s.clone())
                    })),
            )
            .child(self.composer.clone())
    }
}

fn main() {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let light = args.iter().any(|a| a == "--light");
    let demo = args.iter().any(|a| a == "--demo");
    gpui_platform::application().with_assets(assets::Assets).run(move |cx: &mut App| {
        gpui_base::init(cx);
        assets::load_fonts(cx);
        cx.set_global(Theme::new(if light { Mode::Light } else { Mode::Dark }));
        let bounds = Bounds::centered(None, size(px(1000.), px(640.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |window, cx| cx.new(|cx| Demo::new(demo, window, cx)),
        )
        .unwrap();
        cx.activate(true);
    });
}
