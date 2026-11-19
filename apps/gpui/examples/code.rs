//! The code module with fake data: a fence, a ranged `Read`, an `Edit` diff and
//! a full-file diff, light on the left and dark on the right.
//!
//! `cargo run --example code`

#[path = "../src/assets.rs"]
#[allow(dead_code)]
mod assets;
#[path = "../src/code/code.rs"]
#[allow(dead_code)]
mod code;
#[path = "../src/color.rs"]
#[allow(dead_code)]
mod color;
#[path = "../src/theme.rs"]
#[allow(dead_code)]
mod theme;

use std::sync::Arc;

use gpui::{
    App, Bounds, Context, Hsla, Render, SharedString, Window, WindowBounds, WindowOptions, div, prelude::*, px, size,
};

use code::{CodeBlock, CodeView, Diff, DiffView, Highlighted, Lang};
use theme::{Mode, Theme};

// `--` after a space is what Geist Mono's `liga` used to swallow.
const SHELL: &str = "ls --all -- \"$dir\" | grep -v '^\\.' # a -- b\n";

const FENCE: &str = r#"export function sessionRows(items: SessionIndexItem[], now = Date.now()) {
  // Pinned first, then newest activity.
  const rows = items.filter((s) => !s.archived && s.status !== "settled");
  return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}
"#;

const READ: &str = r#"    /// The session's child, spawned on first send.
    pub async fn send(&self, id: &str, prompt: &str) -> anyhow::Result<SendOutcome> {
        let mut slots = self.slots.lock().await;
        let slot = slots.entry(id.to_string()).or_default();
        if slot.child.is_none() {
            slot.child = Some(spawn(id, 0x2a, "resume").await?);
        }
        Ok(SendOutcome { queued: slot.busy, snapshot: None })
    }
"#;

const EDIT_OLD: &str = r#"fn reap_idle(slots: &mut Slots, now: Instant) {
    for slot in slots.values_mut() {
        if now - slot.last_used > Duration::from_secs(600) {
            slot.stop();
        }
    }
}"#;

const EDIT_NEW: &str = r#"fn reap_idle(slots: &mut Slots, now: Instant) {
    for slot in slots.values_mut() {
        // Never a child with a card open: only it can answer.
        if now - slot.last_used > IDLE && !slot.has_open_card() {
            slot.stop();
        }
    }
}"#;

fn full_file_old() -> String {
    let mut out = String::from(
        "import json\nimport sys\n\n\ndef load(path):\n    with open(path) as f:\n        return json.load(f)\n\n",
    );
    for i in 0..12 {
        out.push_str(&format!("def step_{i}(x):\n    return x + {i}\n\n"));
    }
    out.push_str("if __name__ == \"__main__\":\n    print(load(sys.argv[1]))\n");
    out
}

fn full_file_new() -> String {
    full_file_old()
        .replace("import sys\n", "import sys\nfrom pathlib import Path\n")
        .replace(
            "    with open(path) as f:\n        return json.load(f)\n",
            "    return json.loads(Path(path).read_text())\n",
        )
        .replace("print(load(sys.argv[1]))", "print(load(sys.argv[1]), file=sys.stderr)")
}

struct Example {
    fence: Arc<Highlighted>,
    shell: Arc<Highlighted>,
    read: Arc<Highlighted>,
    edit: Arc<Diff>,
    write: Arc<Diff>,
    full: Arc<Diff>,
}

impl Example {
    fn column(&self, mode: Mode) -> impl IntoElement {
        let theme = Theme::new(mode);
        let page: Hsla = match mode {
            Mode::Light => gpui::rgb(0xf3f6f9).into(),
            Mode::Dark => gpui::rgb(0x151515).into(),
        };
        let label = |text: &str, diff: Option<&Diff>| {
            let counts = diff.map(|d| format!("  +{} -{}", d.additions, d.deletions)).unwrap_or_default();
            div()
                .mt_4()
                .mb_1p5()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child(SharedString::from(format!("{text}{counts}")))
        };
        let tag = match mode {
            Mode::Light => "light",
            Mode::Dark => "dark",
        };
        div()
            .id(SharedString::from(format!("column-{tag}")))
            .flex_1()
            .h_full()
            .overflow_y_scroll()
            .bg(page)
            .p_5()
            .font_family("Geist")
            .text_color(theme.foreground)
            .child(label("Markdown fence · typescript", None))
            .child(CodeBlock::new(SharedString::from(format!("fence-{tag}")), self.fence.clone()).mode(mode))
            .child(label("Markdown fence · sh", None))
            .child(CodeBlock::new(SharedString::from(format!("shell-{tag}")), self.shell.clone()).mode(mode))
            .child(label("Read session.rs:212–220", None))
            .child(CodeView::new(SharedString::from(format!("read-{tag}")), self.read.clone(), 212).mode(mode))
            .child(label("Edit reap.rs", Some(&self.edit)))
            .child(DiffView::new(self.edit.clone()).mode(mode))
            .child(label("Write new.json", Some(&self.write)))
            .child(DiffView::new(self.write.clone()).mode(mode))
            .child(label("Full file · load.py", Some(&self.full)))
            .child(DiffView::new(self.full.clone()).mode(mode))
    }
}

impl Render for Example {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().flex().child(self.column(Mode::Light)).child(self.column(Mode::Dark))
    }
}

fn main() {
    gpui_platform::application().run(|cx: &mut App| {
        for font in [
            include_bytes!("../assets/fonts/Geist-Regular.ttf").as_slice(),
            include_bytes!("../assets/fonts/Geist-Medium.ttf"),
            include_bytes!("../assets/fonts/Geist-SemiBold.ttf"),
            include_bytes!("../assets/fonts/GeistMono-Regular.ttf"),
        ] {
            cx.text_system().add_fonts(vec![font.into()]).ok();
        }
        cx.set_global(Theme::new(Mode::Light));
        let full_old = full_file_old();
        let full_new = full_file_new();
        let example = Example {
            fence: Highlighted::new(Lang::from_fence("typescript"), FENCE),
            shell: Highlighted::new(Lang::from_fence("sh"), SHELL),
            read: Highlighted::new(Lang::from_path("src/session.rs"), READ),
            edit: Arc::new(Diff::new("src/reap.rs", Some(EDIT_OLD), EDIT_NEW)),
            write: Arc::new(Diff::new(
                "new.json",
                None,
                "{\n  \"name\": \"dray\",\n  \"private\": true,\n  \"version\": 3\n}\n",
            )),
            full: Arc::new(Diff::new("load.py", Some(&full_old), &full_new)),
        };
        let bounds = Bounds::centered(None, size(px(1500.), px(1000.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| cx.new(|_| example),
        )
        .unwrap();
        cx.activate(true);
    });
}
