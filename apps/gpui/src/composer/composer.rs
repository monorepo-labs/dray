//! The session composer (components/ChatInput.tsx): a card holding the
//! attachment tray, the prompt and its controls, with the `/` `@` `&` `#`
//! picker above it and the attach row beneath.
//!
//! Owns no data. The owner hands it rows per picker ([`Composer::set_rows`]),
//! refreshing on [`ComposerEvent::Query`], and acts on what it emits: send,
//! stop, dictation. It never talks to the server itself.

#[path = "attachments.rs"]
mod attachments;
#[path = "colors.rs"]
mod colors;
#[path = "picker.rs"]
mod picker;
#[path = "slot.rs"]
pub mod slot;
#[path = "segments.rs"]
pub mod segments;

use std::collections::HashMap;
use std::path::PathBuf;

use gpui::{
    AnyElement, App, ClipboardEntry, Context, Entity, EntityInputHandler, EventEmitter, ExternalPaths, FocusHandle,
    Focusable, InteractiveElement, IntoElement, ParentElement, PathPromptOptions, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, deferred, div, prelude::*, px, relative, rems, svg,
};
use gpui_base::input::{
    Enter, Escape, IndentInline, InlineToken, InlineTokenContext, InputEvent, MoveDown, MoveUp, Paste, Textarea,
    TextareaState,
};

pub use attachments::Attachment;
use colors::Colors;
use segments::{Sigil, Trigger, apply_pick, placeholder, score, trigger_at};

use crate::theme::Theme;

/// `MAX_ROWS`: the prompt grows to this many lines, then scrolls.
const MAX_ROWS: usize = 12;

/// Every icon the composer draws, by the path `svg().path()` names it with.
/// Kept here so the composer lands as one module; `Assets` chains it in.
pub const ICONS: &[(&str, &[u8])] = &[
    ("icons/arrow-up.svg", include_bytes!("../../assets/icons/arrow-up.svg")),
    ("icons/check.svg", include_bytes!("../../assets/icons/check.svg")),
    ("icons/corner-down-left.svg", include_bytes!("../../assets/icons/corner-down-left.svg")),
    ("icons/file.svg", include_bytes!("../../assets/icons/file.svg")),
    ("icons/loader-circle.svg", include_bytes!("../../assets/icons/loader-circle.svg")),
    ("icons/message-square.svg", include_bytes!("../../assets/icons/message-square.svg")),
    ("icons/mic.svg", include_bytes!("../../assets/icons/mic.svg")),
    ("icons/paperclip.svg", include_bytes!("../../assets/icons/paperclip.svg")),
    ("icons/plus.svg", include_bytes!("../../assets/icons/plus.svg")),
    ("icons/square.svg", include_bytes!("../../assets/icons/square.svg")),
    ("icons/square-slash.svg", include_bytes!("../../assets/icons/square-slash.svg")),
    ("icons/x.svg", include_bytes!("../../assets/icons/x.svg")),
];

/// One row a picker can offer.
#[derive(Clone, Debug)]
pub struct PickerRow {
    /// What the pick addresses: a path, a command name, a session id, an issue
    /// identifier. Becomes the chip's token id.
    pub id: SharedString,
    /// The row's name: a file's name, `/review`, a task's title, an issue's.
    pub title: SharedString,
    /// The quieter half: a file's directory, a command's description, an
    /// issue's identifier.
    pub detail: Option<SharedString>,
    /// The run written into the prompt, exactly what is sent: `@src/main.rs`,
    /// `/review`, `&Fix login (uuid)`, `#DRA-53 Fix login`.
    pub run: SharedString,
    /// What a chip shows in place of `run`. `None` writes the run as plain
    /// text, which is what a command is.
    pub face: Option<SharedString>,
}

impl PickerRow {
    /// A file, as the `@` picker lists one: name, then directory.
    pub fn file(path: &str) -> PickerRow {
        let name = segments::file_face(path);
        let dir = path[..path.len() - name.len()].trim_end_matches('/');
        PickerRow {
            id: path.to_string().into(),
            title: name.to_string().into(),
            detail: (!dir.is_empty()).then(|| dir.to_string().into()),
            run: format!("@{path}").into(),
            face: Some(name.to_string().into()),
        }
    }

    /// A slash command or skill. A token whose face is its whole run, so it
    /// reads as the coloured text React draws; the CLI expands it.
    pub fn command(name: &str, description: &str) -> PickerRow {
        PickerRow {
            id: name.to_string().into(),
            title: format!("/{name}").into(),
            detail: (!description.is_empty()).then(|| description.to_string().into()),
            run: format!("/{name}").into(),
            face: Some(format!("/{name}").into()),
        }
    }

    /// Another session, tagged the way `sessionTag` writes one: the title for
    /// the reader, the id in parens for the backend.
    pub fn task(id: &str, title: &str) -> PickerRow {
        PickerRow {
            id: id.to_string().into(),
            title: title.to_string().into(),
            detail: None,
            run: format!("&{title} ({id})").into(),
            face: Some(title.to_string().into()),
        }
    }

    /// An issue, written `#DRA-53 Title` as `issueTag` does.
    pub fn issue(identifier: &str, title: &str) -> PickerRow {
        PickerRow {
            id: identifier.to_string().into(),
            title: title.to_string().into(),
            detail: Some(identifier.to_string().into()),
            run: format!("#{identifier} {title}").into(),
            face: Some(segments::issue_face(title, 32).into()),
        }
    }
}

/// Where dictation is, as DictateControl draws it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dictation {
    Idle,
    /// Recording, with the input level 0–1 for the bars.
    Recording { level: f32 },
    Transcribing,
}

#[derive(Clone, Debug)]
pub enum ComposerEvent {
    /// The prompt, trimmed, and every attachment's path. Images and files alike:
    /// the server decides which travels as a block and which as a mention.
    Send { text: String, attachments: Vec<PathBuf> },
    /// The empty composer's button during a turn.
    Stop,
    /// A picker opened or its query moved; refresh its rows with `set_rows`.
    Query { sigil: Sigil, query: String },
    DictateStart,
    DictateCancel,
    DictateStop,
}

pub struct Composer {
    input: Entity<TextareaState>,
    rows: HashMap<Sigil, Vec<PickerRow>>,
    trigger: Option<Trigger>,
    active: usize,
    /// The token Esc closed the picker on, by its start, so it stays shut until
    /// the caret leaves it.
    dismissed: Option<usize>,
    attachments: Vec<Attachment>,
    dragging: bool,
    busy: bool,
    dictation: Dictation,
    new_task: bool,
    can_mention_task: bool,
    issues_connected: bool,
    _subscription: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}

impl Composer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, MAX_ROWS)
                .submit_on_enter(true)
                .placeholder(placeholder(false, false, false))
        });
        let subscription = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::Change => this.refresh_trigger(cx),
            InputEvent::PressEnter { shift: false, secondary: false } => this.submit(window, cx),
            _ => {}
        });
        Composer {
            input,
            rows: HashMap::new(),
            trigger: None,
            active: 0,
            dismissed: None,
            attachments: Vec::new(),
            dragging: false,
            busy: false,
            dictation: Dictation::Idle,
            new_task: false,
            can_mention_task: false,
            issues_connected: false,
            _subscription: subscription,
        }
    }

    /// The rows a picker offers. Filtered here by the query, so a whole list is
    /// fine; files can arrive ranked by the server's index and stay in order
    /// among equal scores.
    pub fn set_rows(&mut self, sigil: Sigil, rows: Vec<PickerRow>, cx: &mut Context<Self>) {
        self.rows.insert(sigil, rows);
        self.active = 0;
        cx.notify();
    }

    /// A turn is running: an empty composer's button becomes Stop.
    pub fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        self.busy = busy;
        cx.notify();
    }

    pub fn set_dictation(&mut self, dictation: Dictation, cx: &mut Context<Self>) {
        self.dictation = dictation;
        cx.notify();
    }

    pub fn dictation(&self) -> Dictation {
        self.dictation
    }

    /// Words dictation produced, put in at the caret.
    pub fn insert_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |s, cx| s.insert(text.to_string(), window, cx));
    }

    /// Which tags the placeholder names, and which presentation: `new_task` is
    /// the empty state's wording ("Describe a task.").
    pub fn set_context(
        &mut self,
        new_task: bool,
        can_mention_task: bool,
        issues_connected: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        (self.new_task, self.can_mention_task, self.issues_connected) = (new_task, can_mention_task, issues_connected);
        let text = placeholder(new_task, can_mention_task, issues_connected);
        self.input.update(cx, |s, cx| s.set_placeholder(text, window, cx));
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |s, cx| s.focus(window, cx));
    }

    /// Attach files by path: a drop, a paste, the `+` dialog.
    pub fn attach(&mut self, paths: impl IntoIterator<Item = PathBuf>, cx: &mut Context<Self>) {
        for path in paths {
            if !self.attachments.iter().any(|a| a.path == path) {
                self.attachments.push(Attachment::read(path));
            }
        }
        cx.notify();
    }

    fn text(&self, cx: &App) -> String {
        self.input.read(cx).value().to_string()
    }

    fn can_send(&self, cx: &App) -> bool {
        !self.text(cx).trim().is_empty() || !self.attachments.is_empty()
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.text(cx).trim().to_string();
        // An attachment alone is a real prompt: a dropped screenshot and Enter
        // is asking about the screenshot.
        if text.is_empty() && self.attachments.is_empty() {
            return;
        }
        let attachments = std::mem::take(&mut self.attachments).into_iter().map(|a| a.path).collect();
        cx.emit(ComposerEvent::Send { text, attachments });
        self.input.update(cx, |s, cx| s.set_value("", window, cx));
        self.trigger = None;
        cx.notify();
    }

    fn refresh_trigger(&mut self, cx: &mut Context<Self>) {
        let (text, caret) = {
            let input = self.input.read(cx);
            (input.value().to_string(), input.cursor())
        };
        let next = trigger_at(&text, caret).filter(|t| self.dismissed != Some(t.start));
        if self.dismissed.is_some_and(|start| next.as_ref().is_none_or(|t| t.start != start)) {
            self.dismissed = None;
        }
        let moved = next.as_ref().map(|t| (t.sigil, &t.query)) != self.trigger.as_ref().map(|t| (t.sigil, &t.query));
        if moved {
            self.active = 0;
            if let Some(t) = &next {
                cx.emit(ComposerEvent::Query { sigil: t.sigil, query: t.query.clone() });
            }
        }
        self.trigger = next;
        cx.notify();
    }

    /// The open picker's rows for its query, best first.
    fn matches(&self) -> Vec<PickerRow> {
        let Some(trigger) = &self.trigger else { return Vec::new() };
        let Some(rows) = self.rows.get(&trigger.sigil) else { return Vec::new() };
        let mut scored: Vec<(u32, usize, &PickerRow)> = rows
            .iter()
            .enumerate()
            .filter_map(|(i, row)| {
                let best = score(&trigger.query, &row.title)
                    .max(row.detail.as_ref().and_then(|d| score(&trigger.query, d)).map(|s| s.saturating_sub(1)));
                best.map(|s| (s, i, row))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored.into_iter().take(50).map(|(_, _, row)| row.clone()).collect()
    }

    fn menu_open(&self) -> bool {
        self.trigger.is_some() && !self.matches().is_empty()
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let count = self.matches().len() as isize;
        if count > 0 {
            self.active = (self.active as isize + by).rem_euclid(count) as usize;
            cx.notify();
        }
    }

    /// Writes the picked row over the token being typed. A tag becomes a chip
    /// whose face is short while its text stays the whole run; a command stays
    /// text, since the CLI reads it off the front of the prompt.
    pub fn pick(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(trigger), Some(row)) = (self.trigger.clone(), self.matches().get(index).cloned()) else { return };
        let text = self.text(cx);
        self.input.update(cx, |s, cx| match &row.face {
            Some(face) => {
                // Taking the space after along with the token, then writing one
                // back, leaves the caret past it either way.
                let end = if text[trigger.end..].starts_with(' ') { trigger.end + 1 } else { trigger.end };
                let token = InlineToken::new(format!("{}:{}", trigger.sigil.char(), row.id), row.run.clone())
                    .with_label(face.clone());
                if s.replace_range_with_token(trigger.start..end, token, window, cx).is_ok() {
                    s.insert(" ", window, cx);
                } else {
                    // A run the token store refuses still sends right as text.
                    let (next, _) = apply_pick(&text, &trigger, &row.run);
                    s.set_value(next, window, cx);
                }
            }
            None => {
                let utf16 = |byte: usize| text[..byte].encode_utf16().count();
                let range = utf16(trigger.start)..utf16(trigger.end);
                let tail = if text[trigger.end..].starts_with(' ') { "" } else { " " };
                s.replace_text_in_range(Some(range), &format!("{}{tail}", row.run), window, cx);
            }
        });
        self.trigger = None;
        self.active = 0;
        cx.notify();
    }

    /// A paste holding files or an image attaches them; text goes on to the
    /// input. Images are written out as files, so every attachment is a path —
    /// the shape `send_msg` takes.
    fn paste(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(item) = cx.read_from_clipboard() else { return false };
        let mut paths = Vec::new();
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(p) => paths.extend(p.paths().iter().cloned()),
                ClipboardEntry::Image(image) => match attachments::write_pasted(image) {
                    Ok(path) => paths.push(path),
                    Err(e) => log::warn!("could not keep a pasted image: {e:#}"),
                },
                ClipboardEntry::String(_) => {}
            }
        }
        if paths.is_empty() {
            return false;
        }
        self.attach(paths, cx);
        true
    }

    fn pick_files(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update(cx, |this, cx| this.attach(paths, cx)).ok();
            }
        })
        .detach();
    }
}

impl Render for Composer {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let colors = Colors::new(&theme);
        let matches = self.matches();
        let menu = self.trigger.as_ref().filter(|_| !matches.is_empty()).map(|t| {
            picker::menu(t.sigil, &matches, self.active, &theme, &colors, cx.listener(|this, ix: &usize, window, cx| {
                this.pick(*ix, window, cx)
            }))
        });
        let menu_open = menu.is_some();
        let can_send = self.can_send(cx);

        let chip_colors = colors.clone();
        let editor = Textarea::new(&self.input).token(move |ctx: &InlineTokenContext, _, _| chip(ctx, &chip_colors));

        let tray = (!self.attachments.is_empty()).then(|| {
            div().pt_3().px_3().child(attachments::tray(
                &self.attachments,
                &theme,
                &colors,
                cx.listener(|this, path: &PathBuf, _, cx| {
                    this.attachments.retain(|a| &a.path != path);
                    cx.notify();
                }),
            ))
        });

        let card = div()
            .id("composer-card")
            .relative()
            .rounded(px(16.))
            .border_1()
            .border_color(colors.edge_surface)
            .bg(colors.composer)
            .when_some(colors.shadow_surface.clone(), |d, s| d.shadow(s))
            .children(tray)
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_1()
                    .py_3()
                    .px_3()
                    .child(
                        div()
                            .relative()
                            .min_w_0()
                            .flex_1()
                            .px_1()
                            .py_1()
                            .text_size(rems(0.9375))
                            .line_height(relative(1.5))
                            .text_color(theme.foreground)
                            .child(editor),
                    )
                    .child(self.controls(can_send, &theme, &colors, cx)),
            )
            .when(self.dragging, |d| d.child(drop_overlay(&theme, &colors)));

        div()
            .id("composer")
            .w_full()
            .px_4()
            .pb_4()
            .key_context("Composer")
            .capture_action(cx.listener(|this, _: &MoveUp, _, cx| {
                if this.menu_open() {
                    this.step(-1, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &MoveDown, _, cx| {
                if this.menu_open() {
                    this.step(1, cx);
                    cx.stop_propagation();
                }
            }))
            // Enter completes the highlighted row instead of sending: the one
            // place the Enter-sends rule gives way. Tab does the same.
            .capture_action(cx.listener(|this, action: &Enter, window, cx| {
                if this.menu_open() && !action.shift {
                    this.pick(this.active, window, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &IndentInline, window, cx| {
                if this.menu_open() {
                    this.pick(this.active, window, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Escape, _, cx| {
                if let Some(t) = this.trigger.take() {
                    this.dismissed = Some(t.start);
                    cx.notify();
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Paste, _, cx| {
                if this.paste(cx) {
                    cx.stop_propagation();
                }
            }))
            // The window is the drop target in the web app; here it is the
            // composer's own box, which the Mac task can widen by putting the
            // same two handlers on its root.
            .on_drag_move::<ExternalPaths>(cx.listener(|this, e: &gpui::DragMoveEvent<ExternalPaths>, _, cx| {
                let over = e.bounds.contains(&e.event.position);
                if over != this.dragging {
                    this.dragging = over;
                    cx.notify();
                }
            }))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                this.dragging = false;
                this.attach(paths.paths().iter().cloned(), cx);
            }))
            .child(
                div()
                    .mx_auto()
                    .max_w(px(768.))
                    .w_full()
                    // The picker anchors to this wrapper, whose box is the card's.
                    .child(
                        div()
                            .relative()
                            .when_some(menu, |d, menu| {
                                d.child(deferred(
                                    div().absolute().left_0().w_full().bottom(relative(1.)).pb(px(6.)).child(menu),
                                ))
                            })
                            .child(card),
                    )
                    .child(div().pt(px(6.)).child(self.toolbar(menu_open, &theme, cx))),
            )
    }
}

impl Composer {
    /// Dictation and Send/Stop, at the right of the prompt's row.
    fn controls(&self, can_send: bool, theme: &Theme, colors: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let row = div().ml_auto().flex().flex_shrink_0().items_center().gap_1();
        match self.dictation {
            Dictation::Transcribing => {
                row.child(round(div().id("transcribing")).child(icon("icons/loader-circle.svg", 16., theme.muted_foreground)))
                    .into_any_element()
            }
            Dictation::Recording { level } => row
                .child(visualizer(level, theme))
                .child(
                    ghost(round(div().id("dictate-cancel")), colors)
                        .child(icon("icons/x.svg", 16., theme.muted_foreground))
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::DictateCancel))),
                )
                .child(
                    round(div().id("dictate-stop"))
                        .bg(colors.primary)
                        .shadow(colors.shadow_button.clone())
                        .child(icon("icons/check.svg", 16., colors.primary_foreground))
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::DictateStop))),
                )
                .into_any_element(),
            Dictation::Idle => {
                // One button, two jobs: an empty composer during a turn stops
                // it; with text in it the prompt queues onto the turn.
                let stopping = self.busy && !can_send;
                let enabled = stopping || can_send;
                let (fill, ink) =
                    if enabled { (colors.primary, colors.primary_foreground) } else { (theme.muted, theme.muted_foreground) };
                let glyph = if stopping { "icons/square.svg" } else { "icons/arrow-up.svg" };
                let send = round(div().id("send"))
                    .bg(fill)
                    .when(enabled, |d| d.cursor_pointer().shadow(colors.shadow_button.clone()))
                    .child(icon(glyph, if stopping { 14. } else { 16. }, ink))
                    .when(enabled, |d| {
                        d.on_click(cx.listener(move |this, _, window, cx| {
                            if stopping {
                                cx.emit(ComposerEvent::Stop);
                            } else {
                                this.submit(window, cx);
                            }
                        }))
                    });
                row.child(
                    ghost(round(div().id("dictate")), colors)
                        .child(icon("icons/mic.svg", 16., theme.muted_foreground))
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(ComposerEvent::DictateStart))),
                )
                .child(send)
                .into_any_element()
            }
        }
    }

    /// The row under the card. Holds only the composer's own `+` here; the
    /// model, effort and stance pickers are the toolbar's, wired by the owner.
    fn toolbar(&self, menu_open: bool, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let _ = menu_open;
        div().flex().items_center().gap_1().px_1().child(
            crate::ui::icon_button("attach", "icons/plus.svg", 16., theme)
                .on_click(cx.listener(|this, _, _, cx| this.pick_files(cx))),
        )
    }
}

/// A placed tag: coloured text behind its glyph, no pill, as richDom draws one.
fn chip(ctx: &InlineTokenContext, colors: &Colors) -> AnyElement {
    let id = ctx.token().id();
    let (ink, glyph) = match id.chars().next() {
        Some('@') => (colors.mention, Some("icons/file.svg")),
        Some('&') => (colors.session, Some("icons/message-square.svg")),
        Some('#') => (colors.issue, None),
        Some('/') => (colors.command, None),
        _ => (colors.mention, None),
    };
    div()
        .flex()
        .items_center()
        .text_color(ink)
        .when(ctx.is_selected(), |d| d.bg(colors.selection))
        .when_some(glyph, |d, g| d.child(svg().path(g).size(rems(0.9375)).mr_1().text_color(ink)))
        .child(ctx.token().label().clone())
        .into_any_element()
}

fn icon(path: &'static str, size: f32, ink: gpui::Hsla) -> impl IntoElement {
    svg().path(path).size(px(size)).text_color(ink)
}

/// `size="icon-sm"` and `rounded-full`: the composer's control shape.
fn round(d: gpui::Stateful<gpui::Div>) -> gpui::Stateful<gpui::Div> {
    d.size(px(28.)).flex_shrink_0().flex().items_center().justify_center().rounded_full()
}

fn ghost(d: gpui::Stateful<gpui::Div>, colors: &Colors) -> gpui::Stateful<gpui::Div> {
    let hover = colors.ghost_hover;
    d.cursor_pointer().hover(move |s| s.bg(hover))
}

/// AudioVisualizer: five bars following the input level, in `foreground`.
fn visualizer(level: f32, theme: &Theme) -> impl IntoElement {
    const SHAPE: [f32; 5] = [0.5, 0.8, 1.0, 0.8, 0.5];
    div().h(px(28.)).px_1().flex().items_center().gap(px(2.)).children(SHAPE.iter().map(|k| {
        let h = 3. + 13. * (level.clamp(0., 1.) * k);
        div().w(px(2.)).h(px(h)).rounded_full().bg(theme.foreground)
    }))
}

/// Over the card rather than replacing it, so the box keeps its size while a
/// file crosses the window.
fn drop_overlay(theme: &Theme, colors: &Colors) -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .gap_2()
        .rounded(px(16.))
        .border_2()
        .border_color(theme.muted_foreground.opacity(0.25))
        .bg(colors.background.opacity(0.7))
        .text_size(px(13.))
        .text_color(theme.muted_foreground)
        .child(icon("icons/paperclip.svg", 14., theme.muted_foreground))
        .child("Drop to attach")
}
