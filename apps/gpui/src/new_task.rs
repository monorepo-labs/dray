//! The new-task screen (#856 M1): the wordmark, the pickers row that decides
//! where a task starts (ComposerToolbar.tsx with `isNewSession`), a slot the
//! composer fills, and the send hint under it (ChatInput.tsx's `isNewTask`).
//!
//! It owns only the picks. Lists come in through the setters and every pick
//! goes out as a [`NewTaskEvent`], so the window wires it to the serve wire and
//! this file never names it. Picks apply locally at once, as React's state does.

use dray_core::git::BranchList;
use dray_core::harness::Harness;
use dray_core::models::{Effort, Model, ModelId};
use dray_core::projects::Project;
use gpui::{
    AnyElement, AnyView, ClickEvent, Context, EventEmitter, FontWeight, Hsla, InteractiveElement, IntoElement,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, deferred, div, prelude::*, px, rems, svg,
};

use crate::color::oklch;
use crate::theme::{Mode, Theme};

/// A project on one machine. `server: None` is This Mac, which no label names.
#[derive(Clone, Debug)]
pub struct Checkout {
    pub project: Project,
    pub server: Option<SharedString>,
    pub connected: bool,
}

/// One harness the model menu's track offers, and whether its CLI is here.
#[derive(Clone, Copy, Debug)]
pub struct Agent {
    pub harness: Harness,
    pub available: bool,
}

/// What the screen asks its owner to do. Each one has already been applied to
/// the screen's own picks; the owner carries it to the server.
#[derive(Clone, Debug)]
pub enum NewTaskEvent {
    /// The checkout to run in: a project pick lands on its last-used checkout,
    /// a server pick on that server's.
    PickCheckout(String),
    PickHarness(Harness),
    /// `None` effort keeps the model's own default, as a row click does.
    PickModel(ModelId, Option<Effort>),
    SetWorktree(bool),
    /// Checks the branch out for real; React asks first when the tree is dirty,
    /// so the owner opens that dialog (BranchSwitchDialog), not this screen.
    PickBranch(String),
    AttachProject,
    AttachFiles,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Menu {
    Model,
    Project,
    Server,
    Branch,
}

pub struct NewTask {
    checkouts: Vec<Checkout>,
    agents: Vec<Agent>,
    models: Vec<Model>,
    branches: Option<BranchList>,
    harness: Harness,
    model: ModelId,
    effort: Option<Effort>,
    path: Option<String>,
    branch: Option<String>,
    worktree: bool,
    open: Option<Menu>,
    /// The model row whose effort submenu is showing, held until another row
    /// takes it so the pointer can cross into the submenu.
    effort_row: Option<usize>,
    composer: Option<AnyView>,
    hint: Option<SharedString>,
}

impl EventEmitter<NewTaskEvent> for NewTask {}

impl NewTask {
    pub fn new(harness: Harness) -> Self {
        NewTask {
            checkouts: Vec::new(),
            agents: Vec::new(),
            models: Vec::new(),
            branches: None,
            harness,
            model: ModelId::default(),
            effort: None,
            path: None,
            branch: None,
            worktree: false,
            open: None,
            effort_row: None,
            composer: None,
            hint: None,
        }
    }

    /// The composer goes here, between the pickers and the send hint.
    pub fn set_composer(&mut self, composer: AnyView, cx: &mut Context<Self>) {
        self.composer = Some(composer);
        cx.notify();
    }

    /// Every checkout the picked space holds, across servers.
    pub fn set_checkouts(&mut self, checkouts: Vec<Checkout>, cx: &mut Context<Self>) {
        self.checkouts = checkouts;
        cx.notify();
    }

    pub fn set_agents(&mut self, agents: Vec<Agent>, cx: &mut Context<Self>) {
        self.agents = agents;
        cx.notify();
    }

    /// The picked harness's models. Keeps the pick where it is still listed,
    /// else lands on the first, as `useSessions` resolves an unknown id.
    pub fn set_models(&mut self, models: Vec<Model>, cx: &mut Context<Self>) {
        if !models.iter().any(|m| m.id == self.model)
            && let Some(first) = models.first()
        {
            self.model = first.id.clone();
            self.effort = first.default_effort;
        }
        self.models = models;
        cx.notify();
    }

    pub fn set_branches(&mut self, branches: Option<BranchList>, cx: &mut Context<Self>) {
        self.branch = branches.as_ref().and_then(|b| b.current.clone());
        self.branches = branches;
        cx.notify();
    }

    /// Sets the picks without emitting, for restoring the last task's.
    pub fn restore(
        &mut self,
        path: Option<String>,
        model: ModelId,
        effort: Option<Effort>,
        worktree: bool,
        cx: &mut Context<Self>,
    ) {
        (self.path, self.model, self.effort, self.worktree) = (path, model, effort, worktree);
        cx.notify();
    }

    /// Replaces "Press ↵ to send" with something holding the send back.
    pub fn set_hint(&mut self, hint: Option<SharedString>, cx: &mut Context<Self>) {
        self.hint = hint;
        cx.notify();
    }

    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    pub fn harness(&self) -> Harness {
        self.harness
    }

    pub fn model(&self) -> (&ModelId, Option<Effort>) {
        (&self.model, self.effort)
    }

    pub fn worktree(&self) -> bool {
        self.worktree
    }

    pub fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }

    /// Opens one menu, for a demo screenshot or a shortcut.
    pub fn open_menu(&mut self, menu: Option<Menu>, cx: &mut Context<Self>) {
        self.open = menu;
        self.effort_row = None;
        cx.notify();
    }

    fn emit(&mut self, event: NewTaskEvent, cx: &mut Context<Self>) {
        self.open = None;
        cx.emit(event);
        cx.notify();
    }

    fn pick_checkout(&mut self, path: String, cx: &mut Context<Self>) {
        self.path = Some(path.clone());
        self.branches = None;
        self.branch = None;
        self.emit(NewTaskEvent::PickCheckout(path), cx);
    }

    fn toggle(&mut self, menu: Menu, cx: &mut Context<Self>) {
        self.open = if self.open == Some(menu) { None } else { Some(menu) };
        self.effort_row = None;
        cx.notify();
    }
}

/// One repository, its checkouts across machines (`groupProjects`).
struct ProjectGroup<'a> {
    key: &'a str,
    name: &'a str,
    checkouts: Vec<&'a Checkout>,
}

fn group_key(c: &Checkout) -> &str {
    c.project.remote.as_deref().unwrap_or(&c.project.path)
}

fn project_groups(checkouts: &[Checkout]) -> Vec<ProjectGroup<'_>> {
    let mut groups: Vec<ProjectGroup> = Vec::new();
    for c in checkouts {
        match groups.iter_mut().find(|g| g.key == group_key(c)) {
            Some(g) => g.checkouts.push(c),
            None => groups.push(ProjectGroup { key: group_key(c), name: &c.project.name, checkouts: vec![c] }),
        }
    }
    groups
}

/// `lastUsedCheckout`: the newest picked among the reachable, else among all.
fn last_used<'a>(checkouts: &[&'a Checkout]) -> &'a Checkout {
    let reachable: Vec<&Checkout> = checkouts.iter().copied().filter(|c| c.connected).collect();
    let pool = if reachable.is_empty() { checkouts } else { &reachable };
    pool.iter().copied().max_by(|a, b| a.project.last_selected.cmp(&b.project.last_selected)).unwrap_or(checkouts[0])
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// MachineSelector's `checkoutLabel`: the machine, plus the folder where that
/// machine holds two; the folder alone where every one is on This Mac.
fn checkout_label(c: &Checkout, all: &[&Checkout], folder: impl Fn(&str) -> String) -> String {
    let path = folder(&c.project.path);
    if all.iter().all(|o| o.server.is_none()) {
        return path;
    }
    let name = c.server.clone().unwrap_or_else(|| "This Mac".into());
    let two_here = all.iter().filter(|o| o.server == c.server).count() > 1;
    if two_here { format!("{name} · {path}") } else { name.to_string() }
}

/// `EFFORT_LABELS`.
pub fn effort_label(effort: Effort) -> &'static str {
    match effort {
        Effort::Low => "Low",
        Effort::Medium => "Medium",
        Effort::High => "High",
        Effort::Xhigh => "Extra High",
        Effort::Ultra => "Ultra",
        Effort::Max => "Max",
    }
}

/// Tokens the pickers draw with that the shared theme does not carry yet,
/// written the way App.css writes them for the Default palette.
struct Ink {
    /// `--popover`, which is `--surface-card`.
    popover: Hsla,
    /// The menu's `ring-1 ring-foreground/10`.
    ring: Hsla,
    /// `--surface-well`, the agent track's cut.
    well: Hsla,
    /// `--surface-thumb`, the agent track's moving part.
    thumb: Hsla,
    /// `--primary`, the worktree switch's track when on.
    primary: Hsla,
    /// `--background`, the switch's knob.
    knob: Hsla,
    destructive: Hsla,
    /// A menu row's hover, `--accent`: a veil over the card.
    row_hover: Hsla,
}

impl Ink {
    fn of(theme: &Theme) -> Ink {
        match theme.mode {
            Mode::Dark => {
                let card = oklch(0.205, 0., 0., 1.).lab();
                Ink {
                    popover: card.hsla(),
                    ring: theme.foreground.opacity(0.1),
                    well: oklch(0., 0., 0., 0.22).hsla(),
                    thumb: oklch(1., 0., 0., 1.).lab().mix(0.16, card).hsla(),
                    primary: oklch(0.922, 0., 0., 1.).hsla(),
                    knob: oklch(0.145, 0., 0., 1.).hsla(),
                    destructive: oklch(0.704, 0.191, 22.216, 1.).hsla(),
                    row_hover: theme.muted,
                }
            }
            Mode::Light => {
                let card = oklch(0.99, 0.004, 250., 1.);
                Ink {
                    popover: card.hsla(),
                    ring: theme.foreground.opacity(0.1),
                    well: oklch(0., 0., 0., 0.07).hsla(),
                    thumb: card.hsla(),
                    primary: oklch(0.65, 0.17, 250., 1.).hsla(),
                    knob: oklch(0.965, 0.012, 250., 1.).hsla(),
                    destructive: oklch(0.55, 0.2, 25., 1.).hsla(),
                    row_hover: theme.muted,
                }
            }
        }
    }
}

/// `CLAUDE_RUST`, a brand constant no palette moves.
fn claude_rust() -> Hsla {
    gpui::rgb(0xd97757).into()
}

/// The agent's mark at `size`, in brand colour where it has one. Harnesses
/// without a mark here yet draw their initial.
fn agent_mark(harness: Harness, size: f32, ink: Hsla) -> AnyElement {
    let icon = |path: &'static str, color: Hsla| svg().path(path).size(px(size)).flex_none().text_color(color);
    match harness {
        Harness::ClaudeCode => icon("icons/claude.svg", claude_rust()).into_any_element(),
        Harness::Codex => icon("icons/codex.svg", ink).into_any_element(),
        other => div()
            .size(px(size))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(size * 0.8))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(ink)
            .child(other.label().chars().next().unwrap_or('?').to_uppercase().to_string())
            .into_any_element(),
    }
}

/// `Button variant="ghost" size="sm"` as the toolbar draws it: h-7, `px-1.5`,
/// `gap-1.5`, `text-ui`, held at `muted-foreground`.
fn ghost(id: impl Into<gpui::ElementId>, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    let fill = theme.muted.opacity(0.5);
    div()
        .id(id)
        .h(px(28.))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(6.))
        .px(px(6.))
        .rounded(px(8.))
        .border_1()
        .border_color(gpui::transparent_black())
        .cursor_pointer()
        .text_size(rems(0.8125))
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.muted_foreground)
        .hover(move |s| s.bg(fill))
}

fn label(text: impl Into<SharedString>) -> impl IntoElement {
    div().min_w_0().overflow_hidden().text_ellipsis().whitespace_nowrap().child(text.into())
}

impl Render for NewTask {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx).clone();
        let ink = Ink::of(&theme);
        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_end()
            // ChatInput's `px-4 pb-4` round a `max-w-3xl` column.
            .px_4()
            .pb_4()
            .child(
                div()
                    .w_full()
                    .max_w(px(768.))
                    .mx_auto()
                    .flex()
                    .flex_col()
                    .child(
                        // The wordmark: a `h-10 max-w-30` box, the logo masked
                        // in at `contain` + `left`, so 120px wide and centred
                        // down the box. GPUI masks an svg to `text_color` too.
                        div().h(px(40.)).mb_4().flex().items_center().child(
                            svg()
                                .path("icons/dray-logo.svg")
                                .w(px(120.))
                                .h(px(120. * 96. / 466.))
                                .text_color(theme.foreground.opacity(0.1)),
                        ),
                    )
                    // `-ml-2.5 pb-1.5`: the `+` glyph, not its box, lines up
                    // with the text below.
                    .child(div().ml(px(-10.)).pb(px(6.)).child(self.toolbar(&theme, &ink, cx)))
                    .child(match &self.composer {
                        Some(view) => view.clone().into_any_element(),
                        None => div().h(px(36.)).into_any_element(),
                    })
                    .child(self.send_hint(&theme)),
            )
    }
}

impl NewTask {
    fn send_hint(&self, theme: &Theme) -> impl IntoElement {
        let dim = theme.muted_foreground.opacity(0.6);
        div().pt_2().flex().items_center().gap_1().text_size(rems(0.8125)).text_color(dim).map(|d| match &self.hint {
            Some(hint) => d.child(hint.clone()),
            None => d
                .child("Press")
                .child(svg().path("icons/corner-down-left.svg").size(px(12.)).text_color(dim))
                .child("to send"),
        })
    }

    fn toolbar(&self, theme: &Theme, ink: &Ink, cx: &mut Context<Self>) -> impl IntoElement {
        let mut row = div().flex().min_w_0().items_center().gap(px(2.)).px_1();
        row = row.child(
            div()
                .id("attach")
                .size(px(28.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(8.))
                .cursor_pointer()
                .hover({
                    let fill = theme.muted.opacity(0.5);
                    move |s| s.bg(fill)
                })
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.emit(NewTaskEvent::AttachFiles, cx)))
                .child(svg().path("icons/plus.svg").size(px(16.)).text_color(theme.muted_foreground)),
        );
        row = row.child(self.model_picker(theme, ink, cx));
        row = row.child(self.project_picker(theme, ink, cx));
        if let Some(server) = self.server_picker(theme, ink, cx) {
            row = row.child(server);
        }
        // Both describe a repo, so neither means anything until one is picked.
        if self.path.is_some() {
            row = row.child(self.worktree_toggle(theme, ink, cx));
            if self.worktree {
                // A worktree forks from the remote's default branch whatever
                // is checked out, so the real base is stated, not offered.
                if let Some(base) = self.branches.as_ref().and_then(|b| b.default_base.clone()) {
                    row = row.child(
                        div()
                            .px(px(6.))
                            .min_w_0()
                            .text_size(rems(0.8125))
                            .text_color(theme.muted_foreground.opacity(0.6))
                            .child(label(format!("from {base}"))),
                    );
                }
            } else if let Some(branch) = self.branch_picker(theme, ink, cx) {
                row = row.child(branch);
            }
        }
        row
    }

    /// A trigger with its menu hung above it, since the composer sits at the
    /// window's foot and Radix flips every one of these to open upward there.
    fn anchored_menu(trigger: impl IntoElement, menu: Option<AnyElement>, cx: &mut Context<Self>) -> impl IntoElement {
        div().relative().flex_none().min_w_0().child(trigger).when_some(menu, |d, menu| {
            d.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .left_0()
                        .mb_1()
                        .occlude()
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.open = None;
                            cx.notify();
                        }))
                        .child(menu),
                )
                .with_priority(1),
            )
        })
    }

    fn menu_card(ink: &Ink) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .p_1()
            .rounded(px(10.))
            .bg(ink.popover)
            .border_1()
            .border_color(ink.ring)
            .shadow_md()
            .text_size(rems(0.8125))
    }

    /// `DropdownMenuRadioItem`: the check sits at the right.
    fn menu_row(
        id: impl Into<gpui::ElementId>,
        text: impl Into<SharedString>,
        checked: bool,
        enabled: bool,
        theme: &Theme,
        ink: &Ink,
    ) -> gpui::Stateful<gpui::Div> {
        let hover = ink.row_hover;
        div()
            .id(id)
            .h(px(28.))
            .flex()
            .items_center()
            .gap_2()
            .pl(px(6.))
            .pr(px(8.))
            .rounded(px(6.))
            .text_color(theme.foreground)
            .when(enabled, |d| d.cursor_pointer().hover(move |s| s.bg(hover)))
            .when(!enabled, |d| d.opacity(0.5))
            .child(label(text))
            .child(div().flex_1())
            .when(checked, |d| {
                d.child(svg().path("icons/check.svg").size(px(14.)).flex_none().text_color(theme.foreground))
            })
    }

    fn model_picker(&self, theme: &Theme, ink: &Ink, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.models.iter().find(|m| m.id == self.model);
        let name: SharedString = match selected {
            Some(m) => m.label.clone().into(),
            None if self.model.is_unset() => "Select Model".into(),
            None => self.model.as_str().to_string().into(),
        };
        let trigger = ghost("model-picker", theme)
            .gap_1()
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle(Menu::Model, cx)))
            .child(agent_mark(self.harness, 14., theme.foreground))
            .child(label(name))
            // Effort qualifies the model, so it is held back a step.
            .when_some(self.effort, |d, e| {
                d.child(div().text_color(theme.muted_foreground.opacity(0.6)).child(effort_label(e)))
            });
        let menu = (self.open == Some(Menu::Model)).then(|| self.model_menu(theme, ink, cx).into_any_element());
        Self::anchored_menu(trigger, menu, cx)
    }

    fn model_menu(&self, theme: &Theme, ink: &Ink, cx: &mut Context<Self>) -> impl IntoElement {
        // `w-[232px]`, set by the agent track rather than by the rows.
        let mut menu = Self::menu_card(ink).w(px(232.));
        if !self.agents.is_empty() {
            let active = self.agents.iter().position(|a| a.harness == self.harness).unwrap_or(0);
            let mut track = div().relative().flex().items_center();
            track = track.child(
                div()
                    .absolute()
                    .top_0()
                    .left(px(active as f32 * 24.))
                    .size(px(24.))
                    .rounded(px(6.))
                    .bg(ink.thumb)
                    .shadow_xs(),
            );
            for agent in &self.agents {
                let harness = agent.harness;
                let picked = harness == self.harness;
                track = track.child(
                    div()
                        .id(SharedString::from(format!("agent-{}", harness.label())))
                        .relative()
                        .size(px(24.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.))
                        .cursor_pointer()
                        // Dimmed by opacity, the one dial a brand mark answers to.
                        .opacity(if picked { 1. } else { 0.55 })
                        .hover(|s| s.opacity(1.))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            if this.harness != harness {
                                this.harness = harness;
                                cx.emit(NewTaskEvent::PickHarness(harness));
                                cx.notify();
                            }
                        }))
                        .child(agent_mark(harness, 14., theme.foreground))
                        // Marked, not disabled: picking it is what draws the
                        // install notice under the composer.
                        .when(!agent.available, |d| {
                            d.child(
                                div()
                                    .absolute()
                                    .top(px(-1.))
                                    .right(px(-1.))
                                    .size(px(6.))
                                    .rounded_full()
                                    .bg(ink.destructive)
                                    .border_1()
                                    .border_color(ink.well),
                            )
                        }),
                );
            }
            menu =
                menu.child(div().mb_1().flex().items_center().gap_1().rounded(px(6.)).bg(ink.well).p_1().child(track));
        }
        if self.models.is_empty() {
            menu = menu.child(
                div()
                    .h(px(28.))
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .text_color(theme.muted_foreground)
                    .child("Loading models…"),
            );
        }
        for (index, model) in self.models.iter().enumerate() {
            let picked = model.id == self.model;
            let effort = if picked { self.effort } else { model.default_effort };
            let id = model.id.clone();
            let hover = ink.row_hover;
            let open_effort = self.effort_row == Some(index) && !model.efforts.is_empty();
            let row = div()
                .id(SharedString::from(format!("model-{index}")))
                .h(px(28.))
                .flex()
                .items_center()
                .gap_1()
                .pl(px(6.))
                .pr(px(8.))
                .rounded(px(6.))
                .cursor_pointer()
                .text_color(theme.foreground)
                .hover(move |s| s.bg(hover))
                .when(open_effort, |d| d.bg(hover))
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    if *hovered && this.effort_row != Some(index) {
                        this.effort_row = Some(index);
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    let default = this.models.iter().find(|m| m.id == id).and_then(|m| m.default_effort);
                    if this.model != id {
                        this.effort = default;
                    }
                    this.model = id.clone();
                    this.emit(NewTaskEvent::PickModel(id.clone(), None), cx);
                }))
                .child(label(model.label.clone()))
                .when_some(effort.filter(|_| !model.efforts.is_empty()), |d, e| {
                    d.child(div().flex_none().text_color(theme.muted_foreground.opacity(0.6)).child(effort_label(e)))
                })
                .child(div().flex_1())
                // The picked row takes a check where the submenu chevron sits.
                .child(
                    svg()
                        .path(if picked { "icons/check.svg" } else { "icons/chevron-right.svg" })
                        .size(px(14.))
                        .flex_none()
                        .text_color(theme.foreground)
                        .when(!picked && model.efforts.is_empty(), |s| s.invisible()),
                );
            let wrap = div().relative().child(row).when(open_effort, |d| {
                d.child(
                    div()
                        .absolute()
                        .left_full()
                        .top(px(-5.))
                        .ml(px(6.))
                        .occlude()
                        .child(self.effort_menu(model, effort, theme, ink, cx)),
                )
            });
            menu = menu.child(wrap);
        }
        menu
    }

    fn effort_menu(
        &self,
        model: &Model,
        current: Option<Effort>,
        theme: &Theme,
        ink: &Ink,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut menu = Self::menu_card(ink).min_w(px(96.));
        for level in model.efforts.iter().copied() {
            let id = model.id.clone();
            menu = menu.child(
                Self::menu_row(
                    SharedString::from(format!("effort-{}", effort_label(level))),
                    effort_label(level),
                    current == Some(level),
                    true,
                    theme,
                    ink,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.model = id.clone();
                    this.effort = Some(level);
                    this.emit(NewTaskEvent::PickModel(id.clone(), Some(level)), cx);
                })),
            );
        }
        menu
    }

    fn project_picker(&self, theme: &Theme, ink: &Ink, cx: &mut Context<Self>) -> impl IntoElement {
        // Nothing to choose between yet, so the trigger does the only useful thing.
        if self.checkouts.is_empty() {
            return div()
                .child(
                    ghost("attach-project", theme)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.emit(NewTaskEvent::AttachProject, cx)))
                        .child(
                            svg()
                                .path("icons/folder-plus.svg")
                                .size(px(14.))
                                .flex_none()
                                .text_color(theme.muted_foreground),
                        )
                        .child("Attach project"),
                )
                .into_any_element();
        }
        let groups = project_groups(&self.checkouts);
        let current =
            groups.iter().position(|g| g.checkouts.iter().any(|c| Some(&c.project.path) == self.path.as_ref()));
        let name: String = match (current, &self.path) {
            (Some(i), _) => groups[i].name.to_string(),
            (None, Some(path)) => basename(path).to_string(),
            (None, None) => "Attach project".to_string(),
        };
        let trigger = ghost("project-picker", theme)
            .max_w(px(160.))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle(Menu::Project, cx)))
            // Filled: an outline folder at 14px reads as a shard.
            .child(svg().path("icons/folder.svg").size(px(14.)).flex_none().text_color(theme.muted_foreground))
            .child(label(name));
        let menu = (self.open == Some(Menu::Project)).then(|| {
            let mut menu = Self::menu_card(ink).min_w(px(208.));
            for (i, group) in groups.iter().enumerate() {
                let reachable = group.checkouts.iter().any(|c| c.connected);
                let target = last_used(&group.checkouts).project.path.clone();
                // A project on one server alone says which, `projectLabel`.
                let only = group.checkouts.iter().map(|c| &c.server).collect::<Vec<_>>();
                let text = match only.first() {
                    Some(Some(server)) if only.iter().all(|s| s.as_ref() == Some(server)) => {
                        format!("{} - {}", group.name, server)
                    }
                    _ => group.name.to_string(),
                };
                let mut row = Self::menu_row(
                    SharedString::from(format!("project-{i}")),
                    text,
                    current == Some(i),
                    reachable,
                    theme,
                    ink,
                );
                if reachable {
                    row = row.on_click(
                        cx.listener(move |this, _: &ClickEvent, _, cx| this.pick_checkout(target.clone(), cx)),
                    );
                } else {
                    row = row.child(div().flex_none().pl_3().opacity(0.7).child("disconnected"));
                }
                menu = menu.child(row);
            }
            let hover = ink.row_hover;
            menu = menu.child(
                div()
                    .id("attach-project-row")
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .gap_2()
                    .px(px(6.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_color(theme.foreground)
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.emit(NewTaskEvent::AttachProject, cx)))
                    .child(svg().path("icons/folder-plus.svg").size(px(16.)).text_color(theme.muted_foreground))
                    .child("Attach project…"),
            );
            menu.into_any_element()
        });
        Self::anchored_menu(trigger, menu, cx).into_any_element()
    }

    /// MachineSelector: nothing for a project only on This Mac, a named and
    /// inert trigger for one checkout on a server, a menu for several.
    fn server_picker(&self, theme: &Theme, ink: &Ink, cx: &mut Context<Self>) -> Option<AnyElement> {
        let path = self.path.as_ref()?;
        let current = self.checkouts.iter().find(|c| &c.project.path == path)?;
        let siblings: Vec<&Checkout> = self.checkouts.iter().filter(|c| group_key(c) == group_key(current)).collect();
        let only = siblings.len() == 1;
        if only && current.server.is_none() {
            return None;
        }
        let text = checkout_label(current, &siblings, |p| basename(p).to_string());
        let trigger = ghost("server-picker", theme)
            .max_w(px(160.))
            .when(!only, |d| d.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle(Menu::Server, cx))))
            .when(only, |d| d.cursor_default().hover(|s| s))
            .child(svg().path("icons/server-filled.svg").size(px(14.)).flex_none().text_color(theme.muted_foreground))
            .child(label(text));
        let menu = (self.open == Some(Menu::Server)).then(|| {
            let mut menu = Self::menu_card(ink).min_w(px(160.)).max_w(px(384.));
            for (i, c) in siblings.iter().enumerate() {
                let target = c.project.path.clone();
                let text = checkout_label(c, &siblings, |p| p.to_string());
                let mut row = Self::menu_row(
                    SharedString::from(format!("server-{i}")),
                    text,
                    c.project.path == *path,
                    c.connected,
                    theme,
                    ink,
                );
                if c.connected {
                    row = row.on_click(
                        cx.listener(move |this, _: &ClickEvent, _, cx| this.pick_checkout(target.clone(), cx)),
                    );
                } else {
                    row = row.child(div().flex_none().pl_3().opacity(0.7).child("disconnected"));
                }
                menu = menu.child(row);
            }
            menu.into_any_element()
        });
        Some(Self::anchored_menu(trigger, menu, cx).into_any_element())
    }

    /// WorktreeToggle: a track that reads as on/off at a glance, then the word.
    fn worktree_toggle(&self, theme: &Theme, ink: &Ink, cx: &mut Context<Self>) -> impl IntoElement {
        let on = self.worktree;
        let off_track = theme.muted_foreground.opacity(0.3);
        ghost("worktree-toggle", theme)
            .when(on, |d| d.text_color(theme.foreground))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.worktree = !this.worktree;
                let on = this.worktree;
                this.emit(NewTaskEvent::SetWorktree(on), cx);
            }))
            .child(
                div()
                    .w(px(20.))
                    .h(px(12.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .p(px(1.))
                    .rounded_full()
                    .bg(if on { ink.primary } else { off_track })
                    .child(div().size(px(10.)).rounded_full().bg(ink.knob).when(on, |d| d.ml(px(8.)))),
            )
            .child("Worktree")
    }

    fn branch_picker(&self, theme: &Theme, ink: &Ink, cx: &mut Context<Self>) -> Option<AnyElement> {
        // A folder that isn't a repo has no branches, and an empty picker is
        // worse than none.
        let list = self.branches.as_ref().filter(|b| !b.branches.is_empty())?;
        let name = self.branch.clone().or_else(|| list.current.clone()).unwrap_or_else(|| "detached".into());
        let trigger = ghost("branch-picker", theme)
            .max_w(px(160.))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle(Menu::Branch, cx)))
            .child(svg().path("icons/branch.svg").size(px(14.)).flex_none().text_color(theme.muted_foreground))
            .child(label(name.clone()));
        let menu = (self.open == Some(Menu::Branch)).then(|| {
            let mut menu = Self::menu_card(ink).min_w(px(176.));
            // Picking checks out for real, so the count warns a dialog is next.
            if list.dirty > 0 {
                let noun = if list.dirty == 1 { "change" } else { "changes" };
                menu = menu.child(
                    div()
                        .px(px(6.))
                        .py_1()
                        .text_color(theme.muted_foreground)
                        .child(format!("{} uncommitted {noun}", list.dirty)),
                );
            }
            for (i, b) in list.branches.iter().enumerate() {
                let target = b.clone();
                menu = menu.child(
                    Self::menu_row(SharedString::from(format!("branch-{i}")), b.clone(), *b == name, true, theme, ink)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            // Dirty trees ask first, so the owner moves the pick.
                            if this.branches.as_ref().is_some_and(|l| l.dirty == 0) {
                                this.branch = Some(target.clone());
                            }
                            this.emit(NewTaskEvent::PickBranch(target.clone()), cx);
                        })),
                );
            }
            menu.into_any_element()
        });
        Some(Self::anchored_menu(trigger, menu, cx).into_any_element())
    }
}
