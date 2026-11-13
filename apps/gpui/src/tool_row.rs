//! One tool call in the transcript, collapsed and expanded, drawn as
//! ToolCall.tsx draws it. What the row *says* is [tools](crate::tools); this is
//! only the deciding of which pieces show and the drawing of them.
//!
//! The row holds no state. Whether it is open belongs to the transcript, keyed
//! by call id, so a row scrolled out of the virtual list and back keeps it.

use std::rc::Rc;
use std::time::Duration;

use dray_core::events::{FileEdit, ToolResult, ToolType};
use gpui::{
    Animation, AnimationExt, AnyElement, App, ClickEvent, FontWeight, Hsla, InteractiveElement, IntoElement,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Transformation, Window, div,
    percentage, prelude::FluentBuilder, px, svg,
};
use serde_json::Value;

use crate::chat_tokens::{ChatTokens, text};
use crate::tools::{self, Changes, EditSides, ReadRange, SubagentBrief};

/// A call as the transcript holds it: `tool_call_started` joined with its
/// result on tool_use id.
#[derive(Clone, Debug)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub tool_type: ToolType,
    pub title: Option<String>,
    pub input: Value,
    /// Set while the arguments are still streaming and do not parse yet.
    pub raw_input: Option<String>,
    /// `None` while the call is in flight.
    pub result: Option<ToolResult>,
    /// Files the harness reported changed first-class (Codex).
    pub edits: Vec<FileEdit>,
}

const SUMMARY_FIELDS: &[&str] = &[
    "file_path",
    "path",
    "notebook_path",
    "command",
    "pattern",
    "query",
    "url",
    "description",
    "timeout",
    "backend",
    "location",
    "request",
];
const EDIT_EXTRA: &[&str] =
    &["old_string", "new_string", "oldText", "newText", "content", "new_source", "edits", "replace_all"];
const READ_EXTRA: &[&str] = &["offset", "limit"];
const SKILL_EXTRA: &[&str] = &["skill", "args"];
const TODO_EXTRA: &[&str] = &["todos", "merge"];

/// Long results are the norm, so expanding shows a head and the rest scrolls.
const PREVIEW_CHARS: usize = 4000;

/// How the summary beside the label is drawn.
#[derive(Clone, Debug, PartialEq)]
pub enum Summary {
    /// A file the call acted on: its basename, the full path on hover.
    File { path: String },
    /// `server method`, the server dimmer.
    Qualified { server: String, method: String },
    Plain(String),
}

/// Everything the row decides before drawing, kept apart so it can be tested
/// without a window. Mirrors the locals at the top of ToolCall.tsx.
#[derive(Clone, Debug)]
pub struct ToolView {
    pub label: Option<String>,
    pub summary: Option<Summary>,
    pub tooltip: Option<String>,
    pub pending: bool,
    pub failed: bool,
    /// Failed and worth the reader's attention: red. A routine failure is not.
    pub alarming: bool,
    /// fx's model/effort pick for a delegated child, drawn as words in the row.
    pub settings: Option<String>,
    pub delegated: Option<SubagentBrief>,
    pub changes: Option<Changes>,
    pub exit_code: Option<i32>,
    pub expandable: bool,
    pub sides: Option<EditSides>,
    pub range: Option<ReadRange>,
    pub brief: Option<String>,
    pub command: Option<String>,
    pub body: Option<String>,
    pub output: Option<String>,
    /// An answered question's result reads as a sentence, not as output.
    pub asked: bool,
}

impl ToolView {
    pub fn new(call: &ToolCall, hide_label: bool) -> ToolView {
        let ToolCall { name, tool_type, title, input, raw_input, result, edits, .. } = call;
        let streaming = raw_input.is_some();
        let mcp = (*tool_type == ToolType::Mcp).then(|| tools::mcp_call(name, title.as_deref()));
        let summary_text = match &mcp {
            Some(m) => Some(m.label.clone()),
            None if name == "Skill" => tools::tool_summary(name, *tool_type, input).or_else(|| title.clone()),
            None => title.clone().or_else(|| tools::tool_summary(name, *tool_type, input)),
        };
        let pending = result.is_none();
        let failed = result.as_ref().is_some_and(|r| r.is_error);
        let alarming = failed && !tools::is_routine_error(result.as_ref().map(|r| r.text.as_str()));
        let show_label = !hide_label || summary_text.is_none();

        let sides = (*tool_type == ToolType::FileEdit && !streaming).then(|| tools::edit_sides(input)).flatten();
        let reported: Vec<&str> = edits.iter().filter_map(|e| e.unified_diff.as_deref()).collect();
        let changes = sides
            .as_ref()
            .map(tools::count_changes_cached)
            .or_else(|| (!edits.is_empty()).then(|| tools::count_unified_changes(reported.iter().copied())))
            .filter(|c| c.added > 0 || c.removed > 0);

        let target = if streaming { None } else { tools::file_target(*tool_type, input) };
        let output = result.as_ref().map(|r| r.text.trim().to_owned()).unwrap_or_default();
        let read = *tool_type == ToolType::FileRead && !streaming && !failed;
        let range = if read { tools::read_range(input, &output) } else { None };
        // A whole-file read is the agent loading context: nothing to open.
        let inert = read && range.is_none();
        let asked = name == "AskUserQuestion" && !streaming;
        let brief = if name == "Skill" && !streaming { tools::skill_brief(input) } else { None };
        let delegated =
            if *tool_type == ToolType::SubagentSpawn && !streaming { tools::subagent_brief(input) } else { None };
        let command = if *tool_type == ToolType::Shell { summary_text.clone() } else { None };
        let todo_call = matches!(name.as_str(), "TodoWrite" | "todo_write");

        let summary = summary_text.as_ref().map(|s| {
            if let Some(path) = &target {
                Summary::File { path: path.clone() }
            } else if let Some(server) = mcp.as_ref().and_then(|m| m.server.clone()) {
                Summary::Qualified { server, method: s.clone() }
            } else if let Some((server, method)) = tools::named_parts(s) {
                Summary::Qualified { server, method }
            } else {
                Summary::Plain(s.clone())
            }
        });
        let settings = delegated.as_ref().and_then(|d| {
            let words: Vec<String> =
                [d.model.as_ref().map(|m| m.replace('-', " ")), d.effort.clone()].into_iter().flatten().collect();
            (!words.is_empty()).then(|| words.join(" "))
        });

        let extra: &[&str] = if sides.is_some() {
            EDIT_EXTRA
        } else if range.is_some() {
            READ_EXTRA
        } else if name == "Skill" {
            SKILL_EXTRA
        } else if todo_call {
            TODO_EXTRA
        } else {
            &[]
        };
        let omit: Vec<&str> = SUMMARY_FIELDS.iter().chain(extra).copied().collect();
        let body = if inert || asked { None } else { raw_input.clone().or_else(|| tools::format_tool_input(input, &omit)) };

        // Results the row already shows another way, or that are the agent's
        // own business. A failure always shows: its text is the only reason.
        let hidden = !failed
            && (sides.is_some()
                || range.is_some()
                || inert
                || name == "Skill"
                || name == "web_fetch"
                || delegated.is_some()
                || todo_call
                || name == "exit_plan_mode"
                || name == "enter_plan_mode");
        let output = if hidden || output.is_empty() { None } else { Some(tools::truncate(&output, PREVIEW_CHARS)) };

        let expandable = body.is_some()
            || output.is_some()
            || brief.is_some()
            || delegated.is_some()
            || command.is_some()
            || sides.is_some()
            || range.is_some()
            || !edits.is_empty();

        ToolView {
            label: show_label.then(|| if mcp.is_some() { "MCP".into() } else { tools::tool_label(name, pending) }),
            summary,
            tooltip: mcp.map(|m| m.detail).or(target),
            pending,
            failed,
            alarming,
            settings,
            delegated,
            changes,
            exit_code: result.as_ref().and_then(|r| r.exit_code).filter(|c| *c != 0),
            expandable,
            sides,
            range,
            brief,
            command,
            body,
            output,
            asked,
        }
    }
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// One tool row. `open` and `on_toggle` belong to the transcript.
#[derive(IntoElement)]
pub struct ToolRow {
    call: Rc<ToolCall>,
    open: bool,
    hide_label: bool,
    on_toggle: Option<Handler>,
    /// Draws an edit's diff. The code/diff module plugs in here; without one the
    /// row draws its plain stand-in.
    diff: Option<Rc<dyn Fn(&EditSides, &ChatTokens) -> AnyElement>>,
    code: Option<Rc<dyn Fn(&ReadRange, &ChatTokens) -> AnyElement>>,
}

impl ToolRow {
    pub fn new(call: Rc<ToolCall>, open: bool) -> ToolRow {
        ToolRow { call, open, hide_label: false, on_toggle: None, diff: None, code: None }
    }

    /// Inside a group whose header already names the tool.
    pub fn hide_label(mut self, hide: bool) -> Self {
        self.hide_label = hide;
        self
    }

    pub fn on_toggle(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(f));
        self
    }

    pub fn diff_view(mut self, f: impl Fn(&EditSides, &ChatTokens) -> AnyElement + 'static) -> Self {
        self.diff = Some(Rc::new(f));
        self
    }

    pub fn code_view(mut self, f: impl Fn(&ReadRange, &ChatTokens) -> AnyElement + 'static) -> Self {
        self.code = Some(Rc::new(f));
        self
    }
}

/// The running state, ShimmerText's sweep as a pulse between the two inks.
pub fn shimmer(id: impl Into<SharedString>, el: gpui::Div, rest: Hsla, peak: Hsla) -> AnyElement {
    let id: SharedString = id.into();
    el.with_animation(
        gpui::ElementId::Name(id),
        Animation::new(Duration::from_millis(1800)).repeat().with_easing(gpui::pulsating_between(0., 1.)),
        move |el, t| el.text_color(lerp(rest, peak, t)),
    )
    .into_any_element()
}

fn lerp(a: Hsla, b: Hsla, t: f32) -> Hsla {
    Hsla { h: a.h + (b.h - a.h) * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t, a: a.a + (b.a - a.a) * t }
}

/// The boxed monospace block every expanded body uses:
/// `rounded-md bg-surface-raised px-2.5 py-2 font-mono text-tool text-muted-foreground`.
pub fn output_box(id: impl Into<SharedString>, tokens: &ChatTokens, scroll_cap: bool) -> gpui::Stateful<gpui::Div> {
    let id: SharedString = id.into();
    div()
        .id(gpui::ElementId::Name(id))
        .rounded(px(8.))
        .bg(tokens.surface_raised)
        .px(px(10.))
        .py(px(8.))
        .font_family(text::MONO).font_features(text::mono_features())
        .text_size(px(text::TOOL))
        .line_height(px(text::TOOL_LEADING))
        .text_color(tokens.muted_foreground)
        .when(scroll_cap, |d| d.max_h(px(384.)).overflow_y_scroll())
}

impl RenderOnce for ToolRow {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let tokens = ChatTokens::get(cx);
        let view = ToolView::new(&self.call, self.hide_label);
        let id = self.call.call_id.clone();
        // No owner for the open state: keep it here, keyed by call id. It lives
        // while the row is drawn, so a row scrolled out of a virtual list
        // closes again; an owner that wants it kept passes `on_toggle`.
        if self.on_toggle.is_none() {
            let state = window.use_keyed_state(SharedString::from(format!("tool-open-{id}")), cx, |_, _| self.open);
            self.open = *state.read(cx);
            self.on_toggle = Some(Rc::new(move |_, _, cx| state.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            })));
        }
        let open = self.open && view.expandable;
        let group: SharedString = format!("tool-{id}").into();

        let label_ink = if view.alarming { tokens.destructive } else { tokens.foreground.opacity(0.8) };
        let label = view.label.clone().map(|l| {
            let el = div().flex_none().when(view.delegated.is_some(), |d| d.mr(px(4.))).child(l);
            if view.pending {
                shimmer(format!("{id}-label"), el, tokens.muted_foreground, tokens.foreground)
            } else {
                el.text_color(label_ink).into_any_element()
            }
        });

        let summary_ink = if view.label.is_none() && view.alarming { tokens.destructive } else { tokens.muted_foreground };
        let summary = view.summary.clone().map(|s| {
            let el = div().min_w_0().font_family(text::MONO).font_features(text::mono_features()).text_color(summary_ink);
            let el = if view.delegated.is_some() && open { el } else { el.truncate() };
            let el = match s {
                Summary::File { path } => el.child(tools::basename(&path).to_owned()),
                Summary::Qualified { server, method } => el
                    .flex()
                    .gap(px(9.)) // one Geist Mono space at 15px, as the web app spaces them
                    .child(div().flex_none().text_color(tokens.muted_foreground.opacity(0.6)).child(server))
                    .child(div().min_w_0().truncate().child(method)),
                Summary::Plain(s) => el.child(s),
            };
            if view.label.is_none() && view.pending {
                shimmer(format!("{id}-summary"), el, tokens.muted_foreground, tokens.foreground)
            } else {
                el.into_any_element()
            }
        });

        let changes = view.changes.map(|c| {
            div()
                .flex_none()
                .flex()
                .gap(px(5.))
                .font_family(text::MONO).font_features(text::mono_features())
                .when(c.added > 0, |d| d.child(div().text_color(tokens.accent_add).child(format!("+{}", c.added))))
                .when(c.removed > 0, |d| d.child(div().text_color(tokens.destructive).child(format!("-{}", c.removed))))
        });

        // Trails the text, shown on hover and while open.
        let chevron = div()
            .flex_none()
            .size(px(12.))
            .when(!view.expandable, |d| d.invisible())
            .opacity(if open { 1. } else { 0. })
            .group_hover(group.clone(), |s| s.opacity(1.))
            .child(
                svg()
                    .path("icons/chevron-right.svg")
                    .size(px(12.))
                    .text_color(tokens.muted_foreground)
                    .when(open, |s| s.with_transformation(Transformation::rotate(percentage(0.25)))),
            );

        let exit = view.exit_code.map(|code| {
            div()
                .ml_auto()
                .flex_none()
                .text_color(if view.alarming { tokens.destructive } else { tokens.muted_foreground })
                .child(format!("exit {code}"))
        });

        let header = div()
            .id(SharedString::from(format!("{id}-header")))
            .flex()
            .w_full()
            .gap(px(8.))
            .text_size(px(text::CHAT))
            .line_height(px(text::CHAT_LEADING))
            .map(|d| if view.delegated.is_some() && open { d.items_start() } else { d.items_center() })
            .when(view.expandable, |d| d.cursor_pointer())
            .when_some(self.on_toggle.clone().filter(|_| view.expandable), |d, f| d.on_click(move |e, w, cx| f(e, w, cx)))
            .when_some(view.tooltip.clone(), |d, tip| d.tooltip(move |_, cx| tooltip(tip.clone(), cx)))
            .children(label)
            .when_some(view.settings.clone(), |d, s| {
                d.child(div().flex_none().font_family(text::MONO).font_features(text::mono_features()).text_color(tokens.muted_foreground.opacity(0.7)).child(s))
            })
            .children(summary)
            .children(changes)
            .child(chevron)
            .children(exit);

        let mut col = div().group(group).flex().flex_col().gap(px(6.)).child(header);
        if !open {
            return col;
        }
        if let Some(sides) = &view.sides {
            col = col.child(match &self.diff {
                Some(f) => f(sides, &tokens),
                None => stand_in_diff(&id, sides, &tokens),
            });
        }
        for (i, edit) in self.call.edits.iter().enumerate() {
            col = col.child(stand_in_unified(&format!("{id}-edit-{i}"), edit, &tokens));
        }
        if let Some(range) = &view.range {
            col = col.child(match &self.code {
                Some(f) => f(range, &tokens),
                None => stand_in_code(&id, range, &tokens),
            });
        }
        if let Some(brief) = &view.brief {
            col = col.child(
                div()
                    .text_size(px(text::CHAT))
                    .line_height(px(text::CHAT_LEADING))
                    .text_color(tokens.foreground.opacity(0.9))
                    .child(brief.clone()),
            );
        }
        if let Some(command) = &view.command {
            col = col.child(output_box(format!("{id}-command"), &tokens, true).child(command.clone()));
        }
        if let Some(body) = &view.body {
            col = col.child(output_box(format!("{id}-body"), &tokens, false).overflow_x_scroll().child(body.clone()));
        }
        if let Some(output) = &view.output {
            // A failure and an answered question drop the box and read at the
            // row's own size: one is the reason to look, the other is prose.
            let el = if view.failed || view.asked {
                div()
                    .id(SharedString::from(format!("{id}-output")))
                    .max_h(px(384.))
                    .overflow_y_scroll()
                    .text_size(px(text::CHAT))
                    .line_height(px(text::CHAT_LEADING))
                    .text_color(tokens.foreground.opacity(0.9))
                    .when(view.failed, |d| d.font_family(text::MONO).font_features(text::mono_features()))
                    .child(if view.failed { format!("Error: {output}") } else { output.clone() })
            } else {
                output_box(format!("{id}-output"), &tokens, true).child(output.clone())
            };
            col = col.child(el);
        }
        col
    }
}

struct Tip(SharedString);

impl gpui::Render for Tip {
    fn render(&mut self, _: &mut Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let tokens = ChatTokens::get(cx);
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(8.))
            .bg(tokens.foreground)
            .text_color(tokens.button_primary_foreground)
            .text_size(px(12.))
            .font_family(text::MONO).font_features(text::mono_features())
            .child(self.0.clone())
    }
}

fn tooltip(text: String, cx: &mut App) -> gpui::AnyView {
    use gpui::AppContext as _;
    cx.new(|_| Tip(text.into())).into()
}

/// Until the code/diff module lands: both sides as `-`/`+` lines.
fn stand_in_diff(id: &str, sides: &EditSides, tokens: &ChatTokens) -> AnyElement {
    let removed = sides.old.as_deref().unwrap_or("").lines().map(|l| (false, l.to_owned()));
    let added = sides.new.lines().map(|l| (true, l.to_owned()));
    let lines: Vec<(bool, String)> = removed.chain(added).collect();
    output_box(format!("{id}-diff"), tokens, true)
        .children(lines.into_iter().map(|(add, l)| {
            let (sign, ink, fill) =
                if add { ("+", tokens.accent_add, tokens.accent_add.opacity(0.1)) } else { ("-", tokens.destructive, tokens.destructive.opacity(0.1)) };
            div().flex().bg(fill).child(div().w(px(16.)).flex_none().text_color(ink).child(sign)).child(div().text_color(tokens.foreground).child(l))
        }))
        .into_any_element()
}

fn stand_in_unified(id: &str, edit: &FileEdit, tokens: &ChatTokens) -> AnyElement {
    let diff = edit.unified_diff.clone().unwrap_or_default();
    output_box(id.to_owned(), tokens, true)
        .child(div().font_weight(FontWeight::MEDIUM).text_color(tokens.foreground).child(edit.path.clone()))
        .children(diff.lines().map(|l| {
            let ink = if l.starts_with('+') {
                tokens.accent_add
            } else if l.starts_with('-') {
                tokens.destructive
            } else {
                tokens.muted_foreground
            };
            div().text_color(ink).child(l.to_owned())
        }))
        .into_any_element()
}

fn stand_in_code(id: &str, range: &ReadRange, tokens: &ChatTokens) -> AnyElement {
    output_box(format!("{id}-code"), tokens, true)
        .children(range.text.lines().enumerate().map(|(i, l)| {
            div()
                .flex()
                .gap(px(12.))
                .child(div().w(px(32.)).flex_none().text_color(tokens.muted_foreground.opacity(0.6)).child(format!("{}", range.start_line as usize + i)))
                .child(div().text_color(tokens.foreground).child(l.to_owned()))
        }))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, tool_type: ToolType, input: Value, result: Option<(&str, bool)>) -> ToolCall {
        ToolCall {
            call_id: "c".into(),
            name: name.into(),
            tool_type,
            title: None,
            input,
            raw_input: None,
            result: result.map(|(text, is_error)| ToolResult {
                text: text.into(),
                is_error,
                structured: None,
                exit_code: None,
                duration_ms: None,
                images: Vec::new(),
            }),
            edits: Vec::new(),
        }
    }

    #[test]
    fn whole_file_read_has_nothing_to_open() {
        let v = ToolView::new(&call("Read", ToolType::FileRead, json!({"file_path": "/a/b.rs"}), Some(("x", false))), false);
        assert!(!v.expandable);
        assert_eq!(v.summary, Some(Summary::File { path: "/a/b.rs".into() }));
    }

    #[test]
    fn failed_read_still_expands() {
        let v = ToolView::new(&call("Read", ToolType::FileRead, json!({"file_path": "/a"}), Some(("boom", true))), false);
        assert!(v.expandable);
        assert!(v.alarming);
    }

    #[test]
    fn edit_draws_a_diff_and_drops_its_boilerplate() {
        let input = json!({"file_path": "/a.rs", "old_string": "a", "new_string": "b"});
        let v = ToolView::new(&call("Edit", ToolType::FileEdit, input, Some(("The file has been updated", false))), false);
        assert!(v.sides.is_some());
        assert_eq!(v.output, None);
        assert_eq!(v.body, None);
        assert_eq!(v.changes, Some(Changes { added: 1, removed: 1 }));
        assert_eq!(v.label.as_deref(), Some("Edited"));
    }

    #[test]
    fn bash_puts_its_command_in_a_box() {
        let v = ToolView::new(&call("Bash", ToolType::Shell, json!({"command": "ls", "timeout": 5}), None), false);
        assert!(v.pending);
        assert_eq!(v.label.as_deref(), Some("Bash"));
        assert_eq!(v.command.as_deref(), Some("ls"));
        assert_eq!(v.body, None);
    }

    #[test]
    fn routine_failure_is_not_red() {
        let v = ToolView::new(
            &call("Bash", ToolType::Shell, json!({"command": "cat x"}), Some(("cat: x: No such file or directory", true))),
            false,
        );
        assert!(v.failed && !v.alarming);
    }

    #[test]
    fn grouped_rows_keep_a_label_only_without_a_summary() {
        let with = ToolView::new(&call("Read", ToolType::FileRead, json!({"file_path": "/a"}), None), true);
        assert_eq!(with.label, None);
        let without = ToolView::new(&call("Read", ToolType::FileRead, json!({}), None), true);
        assert_eq!(without.label.as_deref(), Some("Reading"));
    }

    #[test]
    fn mcp_reads_as_mcp() {
        let v = ToolView::new(&call("mcp__linear-server__save_issue", ToolType::Mcp, json!({"title": "x"}), None), false);
        assert_eq!(v.label.as_deref(), Some("MCP"));
        assert_eq!(v.summary, Some(Summary::Qualified { server: "Linear Server".into(), method: "Save Issue".into() }));
        assert_eq!(v.tooltip.as_deref(), Some("linear-server · save_issue"));
    }
}
