//! Tool rows, the permission card and the question card on fake data, for the
//! transcript to wire in (#856). The cards come through `cards::cards`, the
//! `slots::cards` body, fed `agent_event` frames. Click a row to open it. The
//! question card has focus at start: digits pick, ↑/↓ move, Return goes on or sends. Click the
//! permission card to give it the keys: digits move the pick, Return answers.
//! `t` flips dark and light. Answers print to stdout.
//!
//! `cargo run --example tool_rows`

#![allow(dead_code)]

#[path = "../src/assets.rs"]
mod assets;
#[path = "../src/cards.rs"]
mod cards;
#[path = "../src/chat_tokens.rs"]
mod chat_tokens;
#[path = "../src/color.rs"]
mod color;
#[path = "../src/permission_card.rs"]
mod permission_card;
#[path = "../src/question_card.rs"]
mod question_card;
#[path = "../src/theme.rs"]
mod theme;
#[path = "../src/tool_row.rs"]
mod tool_row;
#[path = "../src/tools.rs"]
mod tools;

use std::collections::HashSet;
use std::rc::Rc;

use dray_core::events::{
    FileChange, FileEdit, PermissionBehavior, PermissionOption, PermissionOptionKind, Question, QuestionOption,
    ToolResult, ToolType,
};
use gpui::{
    App, Bounds, Context, KeyDownEvent, Render, Window, WindowBounds, WindowOptions, div,
    prelude::*, px, size,
};
use serde_json::{Value, json};

use crate::chat_tokens::ChatTokens;
use crate::color::oklch;
use crate::theme::{Mode, Theme};
use crate::tool_row::{ToolCall, ToolRow};

fn result(text: &str, is_error: bool, exit_code: Option<i32>) -> Option<ToolResult> {
    Some(ToolResult {
        text: text.into(),
        is_error,
        structured: None,
        exit_code,
        duration_ms: None,
        images: Vec::new(),
    })
}

fn call(id: &str, name: &str, tool_type: ToolType, input: Value, result: Option<ToolResult>) -> ToolCall {
    ToolCall {
        call_id: id.into(),
        name: name.into(),
        tool_type,
        title: None,
        input,
        raw_input: None,
        result,
        edits: Vec::new(),
    }
}

fn calls() -> Vec<Rc<ToolCall>> {
    calls_owned().into_iter().map(Rc::new).collect()
}

fn calls_owned() -> Vec<ToolCall> {
    let mut codex = call(
        "codex-patch",
        "apply_patch",
        ToolType::FileEdit,
        json!({}),
        result("Success", false, None),
    );
    codex.edits = vec![FileEdit {
        path: "src/lib/format.ts".into(),
        change: FileChange::Update,
        unified_diff: Some("@@ -1,3 +1,3 @@\n export function truncate(s: string) {\n-  return s.slice(0, 80);\n+  return s.length > 80 ? `${s.slice(0, 80)}…` : s;\n }".into()),
    }];
    vec![
        call("bash-live", "Bash", ToolType::Shell, json!({"command": "cargo test -p dray-gpui", "timeout": 300000}), None),
        call(
            "read-whole",
            "Read",
            ToolType::FileRead,
            json!({"file_path": "/Users/me/dray/apps/gpui/src/theme.rs"}),
            result("     1\t//! The Default palette", false, None),
        ),
        call(
            "read-range",
            "Read",
            ToolType::FileRead,
            json!({"file_path": "/Users/me/dray/apps/gpui/src/main.rs", "offset": 15, "limit": 6}),
            result(
                "    15\tfn main() {\n    16\t    env_logger::init();\n    17\t    gpui_platform::application()\n    18\t        .with_assets(assets::Assets)\n    19\t        .run(|cx| workspace::open(cx));\n    20\t}",
                false,
                None,
            ),
        ),
        call(
            "edit",
            "Edit",
            ToolType::FileEdit,
            json!({
                "file_path": "/Users/me/dray/apps/gpui/src/sidebar.rs",
                "old_string": "    .gap(px(4.))\n    .child(title)",
                "new_string": "    .gap(px(6.))\n    .child(title)\n    .child(badge)"
            }),
            result("The file has been updated successfully.", false, None),
        ),
        codex,
        call(
            "grep",
            "Grep",
            ToolType::Search,
            json!({"pattern": "fn render", "path": "apps/gpui/src", "output_mode": "files_with_matches"}),
            result("apps/gpui/src/sidebar.rs\napps/gpui/src/workspace.rs", false, None),
        ),
        call(
            "bash-fail",
            "Bash",
            ToolType::Shell,
            json!({"command": "cargo build --release"}),
            result("error[E0425]: cannot find value `theme` in this scope\n --> src/sidebar.rs:42:9", true, Some(101)),
        ),
        call(
            "bash-routine",
            "Bash",
            ToolType::Shell,
            json!({"command": "cat ~/.dray/serve-port"}),
            result("cat: /Users/me/.dray/serve-port: No such file or directory", true, Some(1)),
        ),
        call(
            "mcp",
            "mcp__linear-server__save_issue",
            ToolType::Mcp,
            json!({"title": "Tool rows in GPUI", "team": "DRA"}),
            result("{\"id\": \"DRA-312\"}", false, None),
        ),
        call("skill", "Skill", ToolType::Other, json!({"skill": "caveman-commit"}), result("Launching skill: caveman-commit", false, None)),
        call(
            "fetch",
            "WebFetch",
            ToolType::Web,
            json!({"url": "https://zed.dev/docs/gpui", "prompt": "How does focus work?"}),
            result("Focus is tracked by FocusHandle; elements call track_focus.", false, None),
        ),
        call(
            "write",
            "Write",
            ToolType::FileEdit,
            json!({"file_path": "/Users/me/dray/apps/gpui/README.md", "content": "# Dray on GPUI\n\nThe desktop app rewritten on GPUI.\n"}),
            None,
        ),
        call(
            "asked",
            "AskUserQuestion",
            ToolType::Other,
            json!({"questions": []}),
            result("User has answered your questions: \"Tabs or spaces?\"=\"Spaces\".", false, None),
        ),
    ]
}

fn option(id: &str, label: &str, kind: PermissionOptionKind) -> PermissionOption {
    let behavior = if kind == PermissionOptionKind::Deny { PermissionBehavior::Deny } else { PermissionBehavior::Allow };
    PermissionOption { id: id.into(), label: label.into(), kind, behavior }
}

fn questions() -> Vec<Question> {
    let opt = |label: &str, description: Option<&str>| QuestionOption {
        label: label.into(),
        description: description.map(Into::into),
        preview: None,
    };
    vec![
        Question {
            question: "Which radius should tool output boxes use?".into(),
            header: Some("Radius".into()),
            multi_select: false,
            options: vec![
                opt("rounded-md", Some("8px, what ToolCall.tsx uses today")),
                opt("rounded-lg", Some("10px, matching the permission card's argument")),
                opt("Square", None),
            ],
            free_text: true,
        },
        Question {
            question: "Which tool rows should open by default?".into(),
            header: None,
            multi_select: true,
            options: vec![opt("Edits", None), opt("Failures", None), opt("Ranged reads", None)],
            free_text: true,
        },
    ]
}

fn frame(payload: Value) -> Value {
    json!({"id": "e", "sessionId": "demo", "harness": "claude_code", "seq": 1, "ts": "2026-11-13T15:00:00Z", "payload": payload})
}

/// The two open requests as the window hands them to `slots::cards`.
fn asks() -> Vec<Value> {
    let options = vec![
        option("deny", "Deny", PermissionOptionKind::Deny),
        option("rule", "Always allow cargo run:*", PermissionOptionKind::AlwaysRule),
        option("once", "Allow once", PermissionOptionKind::Once),
        option("dir", "Always allow in apps/gpui", PermissionOptionKind::AlwaysDirectory),
    ];
    vec![
        frame(json!({
            "type": "permission_requested", "requestId": "perm-1", "toolUseId": "t1", "toolName": "Bash",
            "description": "Run the GPUI example against a fresh build",
            "input": {"command": "cargo run --example tool_rows -- --release"},
            "options": serde_json::to_value(options).unwrap(),
        })),
        frame(json!({
            "type": "questions_asked", "requestId": "ask-1", "toolUseId": "t2",
            "questions": serde_json::to_value(questions()).unwrap(),
        })),
    ]
}

struct Demo {
    calls: Vec<Rc<ToolCall>>,
    open: HashSet<String>,
    asks: Vec<Value>,
}

impl Demo {
    fn new(cx: &mut Context<Self>) -> Self {
        cards::set_responder(cx, |answer, _| println!("{answer:?}"));
        let open = ["read-range", "edit", "bash-fail", "codex-patch"].iter().map(|s| s.to_string()).collect();
        Demo { calls: calls(), open, asks: asks() }
    }
}

impl Render for Demo {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let tokens = ChatTokens::new(&theme);
        let backdrop = match theme.mode {
            Mode::Dark => oklch(0.145, 0., 0., 1.).hsla(),
            Mode::Light => oklch(0.965, 0.012, 250., 1.).hsla(),
        };
        let rows = self.calls.iter().map(|c| {
            let id = c.call_id.clone();
            ToolRow::new(c.clone(), self.open.contains(&id)).on_toggle(cx.listener(move |this, _, _, cx| {
                if !this.open.remove(&id) {
                    this.open.insert(id.clone());
                }
                cx.notify();
            }))
        });
        div()
            .id("demo")
            .size_full()
            .bg(backdrop)
            .font_family(assets::SANS)
            .text_color(tokens.foreground)
            .on_key_down(cx.listener(|_, e: &KeyDownEvent, window, cx| {
                if e.keystroke.key == "t" {
                    let mode = if Theme::get(cx).mode == Mode::Dark { Mode::Light } else { Mode::Dark };
                    cx.set_global(Theme::new(mode));
                    window.refresh();
                }
            }))
            .flex()
            .gap(px(40.))
            .p(px(32.))
            .child(
                div()
                    .id("rows")
                    .w(px(640.))
                    .h_full()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .children(rows),
            )
            .child(
                div()
                    .w(px(460.))
                    .flex()
                    .flex_col()
                    .children(cards::cards("demo", &self.asks.iter().collect::<Vec<_>>(), &theme)),
            )
    }
}

fn main() {
    gpui_platform::application().with_assets(assets::Assets).run(|cx: &mut App| {
        assets::load_fonts(cx);
        let light = std::env::args().any(|a| a == "--light");
        cx.set_global(Theme::new(if light { Mode::Light } else { Mode::Dark }));
        let bounds = Bounds::centered(None, size(px(1240.), px(980.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| cx.new(Demo::new),
        )
        .unwrap();
        cx.activate(true);
    });
}
