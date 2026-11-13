//! A tool call waiting on the user, drawn as PermissionRequest.tsx draws it.
//! The agent is blocked while this is up, so it always carries the command
//! itself: nothing above it is guaranteed to be on screen.
//!
//! Keys follow cardKeys.ts: number keys move the pick, Return answers it, and
//! Return alone is Allow once. The card takes them while it has focus; the
//! window passes them in through [PermissionCard::key] when no text field does,
//! which is how the web app reaches a card without focusing it.

use std::rc::Rc;

use dray_core::events::{PermissionOption, PermissionOptionKind};
use gpui::{
    AnyElement, App, BoxShadow, Context, EventEmitter, FocusHandle, Focusable, FontWeight, Hsla, InteractiveElement,
    IntoElement, KeyDownEvent, Keystroke, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    Window, div, point, prelude::FluentBuilder, px,
};

use crate::chat_tokens::{ChatTokens, text};

/// What the card answered with. Emitted once.
#[derive(Clone, Debug)]
pub enum PermissionEvent {
    Respond { option_id: String },
    ViewPlan,
}

/// Ordered by how much they grant, not the order the CLI suggests them in.
fn kind_order(kind: PermissionOptionKind) -> u8 {
    match kind {
        PermissionOptionKind::Once => 0,
        PermissionOptionKind::AlwaysRule => 1,
        PermissionOptionKind::AlwaysDirectory => 2,
        PermissionOptionKind::SwitchMode => 3,
        PermissionOptionKind::Deny => 4,
    }
}

pub struct PermissionCard {
    description: SharedString,
    argument: Option<SharedString>,
    options: Vec<PermissionOption>,
    picked: Option<String>,
    /// Never cleared: the reply is one-shot in the backend.
    sent: Option<String>,
    /// Whether this card is the one the keys reach. Numbers show on the buttons
    /// only then.
    owns_keys: bool,
    /// Another card is up too, so this one rings to say the keys are its.
    contested: bool,
    view_plan: bool,
    on_respond: Option<Rc<dyn Fn(&str, &mut App)>>,
    focus: FocusHandle,
}

impl EventEmitter<PermissionEvent> for PermissionCard {}

impl Focusable for PermissionCard {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl PermissionCard {
    pub fn new(
        description: impl Into<SharedString>,
        argument: Option<String>,
        mut options: Vec<PermissionOption>,
        cx: &mut Context<Self>,
    ) -> Self {
        options.sort_by_key(|o| kind_order(o.kind));
        let picked = options.iter().find(|o| o.kind == PermissionOptionKind::Once).map(|o| o.id.clone());
        PermissionCard {
            description: description.into(),
            argument: argument.map(Into::into),
            options,
            picked,
            sent: None,
            owns_keys: true,
            contested: false,
            view_plan: false,
            on_respond: None,
            focus: cx.focus_handle(),
        }
    }

    /// A plan approval: adds View plan ahead of the answers.
    pub fn with_view_plan(mut self) -> Self {
        self.view_plan = true;
        self
    }

    /// Called with the option id as well as emitted, for an owner that holds
    /// the card in keyed state and so has nowhere to keep a subscription.
    pub fn on_respond(mut self, f: impl Fn(&str, &mut App) + 'static) -> Self {
        self.on_respond = Some(Rc::new(f));
        self
    }

    /// `(owns_keys, contested)`, as last set.
    pub fn keys(&self) -> (bool, bool) {
        (self.owns_keys, self.contested)
    }

    pub fn set_owns_keys(&mut self, owns: bool, contested: bool, cx: &mut Context<Self>) {
        (self.owns_keys, self.contested) = (owns, contested);
        cx.notify();
    }

    pub fn picked(&self) -> Option<&str> {
        self.picked.as_deref()
    }

    fn respond(&mut self, id: String, cx: &mut Context<Self>) {
        if self.sent.is_some() {
            return;
        }
        self.sent = Some(id.clone());
        if let Some(f) = self.on_respond.clone() {
            f(&id, cx);
        }
        cx.emit(PermissionEvent::Respond { option_id: id });
        cx.notify();
    }

    /// One keystroke from outside a text field. True when the card used it.
    pub fn key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        self.owns_keys && self.handle_key(keystroke, cx)
    }

    /// Focused, the card takes its own keys whoever owns the window's.
    fn handle_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        let m = &keystroke.modifiers;
        if self.sent.is_some() || m.platform || m.control || m.alt || m.shift {
            return false;
        }
        if keystroke.key == "enter" {
            let Some(id) = self.picked.clone() else { return false };
            self.respond(id, cx);
            return true;
        }
        let Some(n) = keystroke.key.parse::<usize>().ok().filter(|n| (1..=9).contains(n)) else { return false };
        let Some(option) = self.options.get(n - 1) else { return false };
        self.picked = Some(option.id.clone());
        cx.notify();
        true
    }
}

/// `Button size="sm"`, one of the four variants the cards use.
#[derive(Clone, Copy, PartialEq)]
pub enum Variant {
    Default,
    Outline,
    Destructive,
}

/// `Button` at `sm` (or `default` when `tall`): `h-7 px-2.5 text-[0.8rem]
/// rounded-[min(radius-md,12px)] font-medium`, filled ones with their shadow.
pub fn button(
    id: impl Into<SharedString>,
    label: impl IntoElement,
    variant: Variant,
    tall: bool,
    disabled: bool,
    tokens: &ChatTokens,
) -> gpui::Stateful<gpui::Div> {
    let id: SharedString = id.into();
    let dark = tokens.shadow_card.is_empty();
    let (fill, ink, border, hover) = match variant {
        Variant::Default => (tokens.button_primary, tokens.button_primary_foreground, gpui::transparent_black(), tokens.button_primary.opacity(0.9)),
        Variant::Outline if dark => (tokens.input.opacity(0.3), tokens.foreground, tokens.input, tokens.input.opacity(0.5)),
        Variant::Outline => (tokens.card, tokens.foreground, tokens.border, tokens.muted),
        Variant::Destructive => {
            let (rest, over) = if dark { (0.2, 0.3) } else { (0.1, 0.2) };
            (tokens.destructive.opacity(rest), tokens.destructive, gpui::transparent_black(), tokens.destructive.opacity(over))
        }
    };
    div()
        .id(gpui::ElementId::Name(id))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(px(4.))
        .min_h(px(if tall { 32. } else { 28. }))
        .px(px(10.))
        .py(px(4.))
        .rounded(px(8.))
        .border_1()
        .border_color(border)
        .bg(fill)
        .text_color(ink)
        .text_size(px(if tall { 14. } else { 12.8 }))
        .font_weight(FontWeight::MEDIUM)
        .when(variant == Variant::Default, |d| d.shadow(tokens.shadow_button.clone()))
        .map(|d| if disabled { d.opacity(0.5) } else { d.cursor_pointer().hover(move |s| s.bg(hover)) })
        .child(label)
}

/// `ring-2 ring-ring/60 ring-offset-1 ring-offset-card`, as two spread shadows.
pub fn picked_ring(tokens: &ChatTokens, offset: Hsla) -> Vec<BoxShadow> {
    let ring = |spread: f32, color: Hsla| BoxShadow {
        color,
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(spread),
        inset: false,
    };
    vec![ring(3., tokens.ring.opacity(0.6)), ring(1., offset)]
}

impl Render for PermissionCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tokens = ChatTokens::get(cx);
        let focused = self.focus.is_focused(window);
        // Focused, it takes keys whoever owns them, so it shows them too.
        let owns = (self.owns_keys || focused) && self.sent.is_none();
        let disabled = self.sent.is_some();

        let buttons: Vec<AnyElement> = self
            .options
            .iter()
            .enumerate()
            .map(|(i, option)| {
                let variant = match option.kind {
                    PermissionOptionKind::Once => Variant::Default,
                    PermissionOptionKind::Deny => Variant::Destructive,
                    _ => Variant::Outline,
                };
                let id = option.id.clone();
                let label = div()
                    .flex()
                    .items_baseline()
                    .gap(px(2.))
                    .child(option.label.clone())
                    .when(owns && i < 9, |d| {
                        d.child(div().font_family(text::MONO).font_features(crate::assets::mono_features()).text_size(px(10.)).opacity(0.6).child(format!("{}", i + 1)))
                    });
                button(SharedString::from(format!("perm-{}", option.id)), label, variant, false, disabled, &tokens)
                    .max_w_full()
                    .when(owns && self.picked.as_deref() == Some(option.id.as_str()), |d| {
                        d.shadow(picked_ring(&tokens, tokens.card))
                    })
                    .when(!disabled, |d| d.on_click(cx.listener(move |this, _, _, cx| this.respond(id.clone(), cx))))
                    .into_any_element()
            })
            .collect();

        div()
            .id("permission-card")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                if this.handle_key(&e.keystroke, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|this, _, window, cx| this.focus.focus(window, cx)))
            .rounded(px(18.))
            .border_1()
            .border_color(tokens.border)
            .bg(tokens.card)
            .p(px(16.))
            .shadow(tokens.shadow_card.clone())
            .when(owns && (self.contested || focused), |d| {
                d.shadow(vec![BoxShadow {
                    color: tokens.ring.opacity(0.5),
                    offset: point(px(0.), px(0.)),
                    blur_radius: px(0.),
                    spread_radius: px(2.),
                    inset: false,
                }])
            })
            .when_some(self.argument.clone(), |d, arg| {
                d.child(
                    div()
                        .id("permission-argument")
                        .mb(px(12.))
                        .overflow_x_scroll()
                        .rounded(px(10.))
                        .border_1()
                        .border_color(tokens.border)
                        .px(px(12.))
                        .py(px(10.))
                        .font_family(text::MONO).font_features(crate::assets::mono_features())
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(tokens.foreground)
                        .child(arg),
                )
            })
            .child(
                div()
                    .text_size(px(text::CHAT))
                    .line_height(px(text::CHAT * 1.375))
                    .text_color(tokens.foreground)
                    .child(self.description.clone()),
            )
            .child(
                div()
                    .mt(px(12.))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.))
                    .when(self.view_plan, |d| {
                        d.child(
                            button("perm-view-plan", "View plan", Variant::Outline, false, false, &tokens)
                                .on_click(cx.listener(|_, _, _, cx| cx.emit(PermissionEvent::ViewPlan))),
                        )
                    })
                    .children(buttons),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_sort_by_what_they_grant() {
        let mut kinds = [PermissionOptionKind::Deny, PermissionOptionKind::AlwaysRule, PermissionOptionKind::Once];
        kinds.sort_by_key(|k| kind_order(*k));
        assert_eq!(kinds, [PermissionOptionKind::Once, PermissionOptionKind::AlwaysRule, PermissionOptionKind::Deny]);
    }
}
