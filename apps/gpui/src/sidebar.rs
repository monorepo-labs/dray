//! The sidebar (components/Sidebar.tsx): the three top buttons, the project
//! filter row, and the session list in the order `sessions` computes.

use std::collections::BTreeSet;

use dray_core::store::{SessionIndexItem, SessionStatus};
use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
    Styled, div, prelude::*, px, svg,
};

use crate::sessions::{Group, ListRow, Stage, relative_time, session_groups};
use crate::theme::Theme;
use crate::ui;
use crate::workspace::Workspace;

/// Where the first rail runs, and how far each level steps in (`RAIL_X`, `STEP`).
const RAIL_X: f32 = 12.;
const STEP: f32 = 12.;
const ELBOW: f32 = 10.;

pub fn sidebar(ws: &Workspace, theme: &Theme, cx: &mut Context<Workspace>) -> impl IntoElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(top_buttons(theme))
        .child(filter_row(ws, theme))
        .child(list(ws, theme, cx))
}

/// New Task, Issues and Search, as ghost buttons drawn at a row's strength.
/// Inert in this PR: each lands with the screen it opens.
fn top_buttons(theme: &Theme) -> impl IntoElement {
    let button = |id: &'static str, icon: &'static str, label: &'static str, key: &'static str| {
        let hover = theme.sidebar_accent_hover;
        div()
            .id(id)
            .h(px(28.))
            .w_full()
            .flex()
            .items_center()
            .gap_1()
            // `px-1.5` inside the 1px transparent border every button carries.
            .px(px(7.))
            .rounded(px(8.))
            .cursor_pointer()
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.sidebar_foreground)
            .hover(move |s| s.bg(hover))
            .child(svg().path(icon).size(px(14.)).text_color(theme.sidebar_foreground))
            .child(label)
            .child(div().ml_auto().child(ui::chord(&["⌘", key], theme.sidebar_kbd, theme)))
    };
    div()
        .flex()
        .flex_col()
        .gap(px(1.))
        .px_2()
        .pt_3()
        .child(button("new-task", "icons/plus.svg", "New Task", "N"))
        .child(button("issues", "icons/circle-dot.svg", "Issues", "I"))
        .child(button("search", "icons/search.svg", "Search", "F"))
}

/// The project filter on the left, the drafts and settled toggles on the right.
fn filter_row(ws: &Workspace, theme: &Theme) -> impl IntoElement {
    // One entry per repository, as `projectGroups` folds checkouts, plus All.
    let entries = 1 + ws.projects.iter().map(|p| p.remote.as_deref().unwrap_or(&p.path)).collect::<BTreeSet<_>>().len();
    let fg = theme.foreground;
    div()
        .mt_4()
        .flex()
        .items_start()
        .justify_between()
        .py_1()
        .pr_2()
        .pl_3()
        .child(
            // The band is the control. Its dots show only while it is reached
            // (and, in the web app, for a moment after the filter steps).
            div()
                .id("project-filter")
                .group("projects")
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .items_start()
                .pl_1()
                .cursor_pointer()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.muted_foreground)
                                .group_hover("projects", move |s| s.text_color(fg))
                                .child("All Projects"),
                        )
                        .child(
                            div()
                                .opacity(0.)
                                .group_hover("projects", |s| s.opacity(1.))
                                .child(dot_track(entries, 0, theme)),
                        ),
                ),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(2.))
                .child(ui::icon_button_xs("drafts", "icons/circle-dashed.svg", theme))
                .child(ui::icon_button_xs("settled", "icons/check-check.svg", theme)),
        )
}

/// `DotTrack`: one dot per filter entry under the label, the active one bright,
/// centred on the active dot and faded at both ends.
fn dot_track(count: usize, active: usize, theme: &Theme) -> impl IntoElement {
    const DOT: f32 = 4.;
    const GAP: f32 = 4.;
    const PITCH: f32 = DOT + GAP;
    const TRACK: f32 = PITCH * 5. - GAP;
    let offset = TRACK / 2. - DOT / 2. - active as f32 * PITCH;
    div().h(px(6.)).when(count > 1, |d| {
        d.child(div().w(px(TRACK)).h_full().relative().overflow_hidden().children((0..count).map(|i| {
            let x = offset + i as f32 * PITCH;
            // The mask's `transparent, black 30%, black 70%, transparent`.
            let centre = (x + DOT / 2.) / TRACK;
            let fade = (centre / 0.3).min((1. - centre) / 0.3).clamp(0., 1.);
            let color = if i == active { theme.foreground.opacity(0.8) } else { theme.muted_foreground.opacity(0.3) };
            div().absolute().left(px(x)).top(px(1.)).size(px(DOT)).rounded_full().bg(color.opacity(color.a * fade))
        })))
    })
}

fn list(ws: &Workspace, theme: &Theme, cx: &mut Context<Workspace>) -> impl IntoElement {
    let refs: Vec<&SessionIndexItem> = ws.items.iter().filter(|i| !i.hidden).collect();
    let now = chrono::Utc::now().timestamp_millis();
    let groups = session_groups(&refs, &ws.live, now);

    let mut children: Vec<AnyElement> = Vec::new();
    if groups.is_empty() {
        children.push(
            div()
                .px_2()
                .py_6()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child("No tasks yet.")
                .into_any_element(),
        );
    }
    for (index, group) in groups.iter().enumerate() {
        if index > 0 {
            children.push(div().h_4().flex_shrink_0().into_any_element());
        }
        if let Group::Pinned(_) = group {
            children.push(heading("Pinned", theme).into_any_element());
        }
        let aside_run = matches!(group, Group::Stage(Stage::Aside, _));
        for row in group.rows() {
            children.push(session_row(ws, row, aside_run || row.item.aside, now, theme, cx).into_any_element());
        }
    }

    let rows: usize = groups.iter().map(|g| g.rows().len()).sum();
    if rows > 1 {
        children.push(shortcut_hint(ws.selected.is_some(), theme).into_any_element());
    }

    div()
        .id("session-list")
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap(px(1.))
        .overflow_y_scroll()
        .track_scroll(&ws.sidebar_scroll)
        .pb_3()
        .pl_2()
        .pr_2()
        .children(children)
}

fn heading(label: &'static str, theme: &Theme) -> impl IntoElement {
    div()
        .min_h(px(24.))
        .flex()
        .items_center()
        .pl_2()
        .pr(px(2.))
        .text_size(px(13.))
        .text_color(theme.muted_foreground.opacity(0.7))
        .child(label)
}

fn session_row(
    ws: &Workspace,
    row: &ListRow,
    aside: bool,
    now: i64,
    theme: &Theme,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let item = row.item;
    let id = item.session_id.clone();
    let active = ws.selected.as_deref() == Some(item.session_id.as_str());
    let asking = ws.live.asking.contains(&item.session_id);
    let status = ws.live.status.get(&item.session_id).copied().unwrap_or(item.status);
    let hover = theme.sidebar_accent_hover;

    let depth = row.depth;
    let own_rail = RAIL_X + depth.saturating_sub(1) as f32 * STEP;
    let parent_carries_on = depth > 0 && row.guides.get(depth - 1).copied().unwrap_or(false);
    let rail = theme.sidebar_border;
    let mut lines: Vec<AnyElement> = Vec::new();
    for (level, open) in row.guides.iter().take(depth.saturating_sub(1)).enumerate() {
        if *open {
            lines.push(
                div()
                    .absolute()
                    .top_0()
                    .bottom(px(-1.))
                    .w(px(1.))
                    .left(px(RAIL_X + level as f32 * STEP))
                    .bg(rail)
                    .into_any_element(),
            );
        }
    }
    if depth > 0 {
        lines.push(
            div()
                .absolute()
                .top_0()
                .left(px(own_rail))
                .w(px(1.))
                .map(|d| if parent_carries_on { d.bottom(px(-1.)) } else { d.h(gpui::relative(0.5)) })
                .bg(rail)
                .into_any_element(),
        );
        lines.push(
            div()
                .absolute()
                .top(gpui::relative(0.5))
                .left(px(own_rail + 1.))
                .w(px(ELBOW - 5.))
                .h(px(1.))
                .bg(rail)
                .into_any_element(),
        );
    }
    if row.opens {
        lines.push(
            div()
                .absolute()
                .top(gpui::relative(0.5))
                .bottom(px(-1.))
                .left(px(RAIL_X + depth as f32 * STEP))
                .w(px(1.))
                .bg(rail)
                .into_any_element(),
        );
    }

    div()
        .id(gpui::SharedString::from(item.session_id.clone()))
        .relative()
        .min_h(px(28.))
        .w_full()
        .flex()
        .items_center()
        .pr(px(2.))
        .rounded(px(8.))
        .cursor_pointer()
        .text_size(px(13.))
        .map(|d| {
            if active {
                d.bg(theme.sidebar_accent).text_color(theme.foreground)
            } else if aside {
                // A set-aside row sits at 30% until reached.
                d.text_color(theme.sidebar_foreground).opacity(0.3).hover(move |s| s.bg(hover).opacity(1.))
            } else {
                d.text_color(theme.sidebar_foreground).hover(move |s| s.bg(hover))
            }
        })
        .on_click(cx.listener(move |this, _, _, cx| this.select(&id, cx)))
        // The rail: "over to you". Waiting wins over unread.
        .child(div().w_2().flex_shrink_0().self_stretch().flex().items_center().when(
            asking || status == SessionStatus::Completed,
            |slot| {
                slot.child(div().h(px(6.)).w(px(2.)).rounded(px(1.)).bg(if asking {
                    theme.accent_command
                } else {
                    theme.accent_add
                }))
            },
        ))
        .children(lines)
        .when(depth > 0, |d| d.child(div().flex_shrink_0().w(px(own_rail + ELBOW - 8.))))
        .child(div().flex_1().min_w_0().truncate().child(item.title.clone()))
        .child(
            div().flex_shrink_0().pl_2().text_color(theme.muted_foreground).child(relative_time(&item.modified, now)),
        )
}

/// `ShortcutHint`: the walk and jump chords under the last row, held back
/// further than the caps elsewhere. Drawn only with something to walk.
fn shortcut_hint(selected: bool, theme: &Theme) -> impl IntoElement {
    // `HINT_KEYS` is `bg-muted/40`, which the frame's own keycap fill outranks in light.
    let fill = match theme.mode {
        crate::theme::Mode::Dark => theme.muted.opacity(theme.muted.a * 0.4),
        crate::theme::Mode::Light => theme.sidebar_kbd,
    };
    let ink = theme.muted_foreground.opacity(0.6);
    let cap = |content: AnyElement| ui::kbd_with(content, fill, ink);
    let word = |t: &'static str| div().child(t).into_any_element();
    let arrow = |icon: &'static str| svg().path(icon).size(px(12.)).text_color(ink).into_any_element();
    let arrows = if selected {
        div()
            .flex()
            .items_center()
            .gap_1()
            .child(arrow("icons/arrow-up.svg"))
            .child(arrow("icons/arrow-down.svg"))
            .into_any_element()
    } else {
        arrow("icons/arrow-down.svg")
    };
    div()
        .min_h(px(28.))
        .flex()
        .items_center()
        .justify_between()
        .pr(px(2.))
        .pl_2()
        .child(div().flex().items_center().gap_1().child(cap(word("⌘"))).child(cap(word("Shift"))).child(cap(arrows)))
        .child(div().flex().items_center().gap_1().child(cap(word("⌥"))).child(cap(word("1–0"))))
}
