//! `AskUserQuestion`, drawn as QuestionRequest.tsx draws it: one question at a
//! time, choices with number shortcuts, a free-text box where the asker takes
//! one, and Skip / Next / Send.
//!
//! Keys are the shadcn Questionnaire's, read off its source: digits pick a
//! choice, ↑/↓ move between answers (selecting a radio as they land), ←/→ step
//! questions, Return on an answered item goes on or sends, ⌘/Ctrl+Return always
//! does. The logic is [QuestionState], testable without a window.

use std::collections::{BTreeMap, BTreeSet};

use dray_core::events::Question;
use gpui::{
    AnyElement, App, BoxShadow, Context, EventEmitter, FocusHandle, Focusable, FontWeight, InteractiveElement,
    IntoElement, KeyDownEvent, Keystroke, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    Window, div, point, prelude::FluentBuilder, px, svg,
};

use crate::chat_tokens::{ChatTokens, text};
use crate::permission_card::{Variant, button};

/// The answers, keyed by each question's verbatim text as the CLI matches
/// them. A skipped question is absent, which is a real answer.
#[derive(Clone, Debug)]
pub struct QuestionsAnswered(pub BTreeMap<String, String>);

/// Where focus sits inside the active question.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Spot {
    Choice(usize),
    Input,
}

#[derive(Clone, Debug)]
pub struct QuestionState {
    pub questions: Vec<Question>,
    pub active: usize,
    pub picked: Vec<BTreeSet<usize>>,
    pub text: Vec<String>,
    /// Typing in the box selects it as the answer; on a single-choice question
    /// that drops the picked choice, as the primitive does.
    pub text_selected: Vec<bool>,
    pub skipped: Vec<bool>,
    pub spot: Spot,
    pub sent: bool,
}

impl QuestionState {
    pub fn new(questions: Vec<Question>) -> Self {
        let n = questions.len();
        let mut s = QuestionState {
            questions,
            active: 0,
            picked: vec![BTreeSet::new(); n],
            text: vec![String::new(); n],
            text_selected: vec![false; n],
            skipped: vec![false; n],
            spot: Spot::Choice(0),
            sent: false,
        };
        s.spot = s.first_spot();
        s
    }

    fn q(&self) -> &Question {
        &self.questions[self.active]
    }

    fn spots(&self) -> Vec<Spot> {
        let q = self.q();
        (0..q.options.len()).map(Spot::Choice).chain(q.free_text.then_some(Spot::Input)).collect()
    }

    fn first_spot(&self) -> Spot {
        if self.questions.is_empty() {
            return Spot::Input;
        }
        self.picked[self.active].iter().next().map(|i| Spot::Choice(*i)).unwrap_or(*self.spots().first().unwrap_or(&Spot::Input))
    }

    pub fn is_last(&self) -> bool {
        self.active + 1 >= self.questions.len()
    }

    pub fn answered(&self, i: usize) -> bool {
        !self.picked[i].is_empty() || (self.text_selected[i] && !self.text[i].trim().is_empty())
    }

    /// Pick or toggle a choice, as a click does.
    pub fn toggle(&mut self, choice: usize) {
        let i = self.active;
        self.skipped[i] = false;
        self.spot = Spot::Choice(choice);
        if self.q().multi_select {
            if !self.picked[i].remove(&choice) {
                self.picked[i].insert(choice);
            }
        } else {
            self.picked[i] = BTreeSet::from([choice]);
            self.text_selected[i] = false;
        }
    }

    pub fn type_text(&mut self, s: &str) {
        let i = self.active;
        self.text[i].push_str(s);
        self.after_edit();
    }

    pub fn backspace(&mut self) {
        let i = self.active;
        self.text[i].pop();
        self.after_edit();
    }

    fn after_edit(&mut self) {
        let i = self.active;
        let filled = !self.text[i].trim().is_empty();
        self.skipped[i] = false;
        self.text_selected[i] = filled;
        if filled && !self.q().multi_select {
            self.picked[i].clear();
        }
    }

    pub fn go_to(&mut self, i: usize) {
        if i < self.questions.len() {
            self.active = i;
            self.spot = self.first_spot();
        }
    }

    pub fn skip(&mut self) -> Option<QuestionsAnswered> {
        let i = self.active;
        self.picked[i].clear();
        self.text_selected[i] = false;
        self.skipped[i] = true;
        if self.is_last() { self.submit() } else { self.go_to(i + 1).into_none() }
    }

    /// Next, or Send on the last question.
    pub fn advance(&mut self) -> Option<QuestionsAnswered> {
        if self.is_last() { self.submit() } else { self.go_to(self.active + 1).into_none() }
    }

    pub fn submit(&mut self) -> Option<QuestionsAnswered> {
        if self.sent {
            return None;
        }
        self.sent = true;
        let answers = (0..self.questions.len())
            .filter(|i| !self.skipped[*i])
            .filter_map(|i| {
                let q = &self.questions[i];
                let mut parts: Vec<String> = self.picked[i].iter().map(|c| q.options[*c].label.clone()).collect();
                if self.text_selected[i] && !self.text[i].trim().is_empty() {
                    parts.push(self.text[i].clone());
                }
                let parts: Vec<String> = parts.into_iter().filter(|p| !p.trim().is_empty()).collect();
                (!parts.is_empty()).then(|| (q.question.clone(), parts.join(", ")))
            })
            .collect();
        Some(QuestionsAnswered(answers))
    }

    /// One keystroke. `None` when the card did not use it; `Some(answers)` once
    /// the card is sent.
    pub fn key(&mut self, k: &Keystroke) -> KeyOutcome {
        if self.sent || self.questions.is_empty() {
            return KeyOutcome::Ignored;
        }
        let m = &k.modifiers;
        if k.key == "enter" && (m.platform || m.control) && !m.alt && !m.shift {
            return self.advance().map_or(KeyOutcome::Used, KeyOutcome::Sent);
        }
        if m.platform || m.control || m.alt {
            return KeyOutcome::Ignored;
        }
        let in_box = self.spot == Spot::Input;
        match k.key.as_str() {
            "up" | "down" => {
                let spots = self.spots();
                let at = spots.iter().position(|s| *s == self.spot).unwrap_or(0);
                let n = spots.len();
                let next = if k.key == "down" { (at + 1) % n } else { (at + n - 1) % n };
                self.spot = spots[next];
                if let Spot::Choice(c) = self.spot
                    && !self.q().multi_select
                {
                    self.toggle(c);
                }
                KeyOutcome::Used
            }
            "left" | "right" if !in_box => {
                if k.key == "left" {
                    if self.active > 0 {
                        self.go_to(self.active - 1);
                    }
                } else if !self.is_last() && (self.answered(self.active) || self.skipped[self.active]) {
                    self.go_to(self.active + 1);
                }
                KeyOutcome::Used
            }
            "enter" if in_box && m.shift => {
                self.type_text("\n");
                KeyOutcome::Used
            }
            "enter" => {
                let ready = match self.spot {
                    Spot::Choice(c) => self.picked[self.active].contains(&c),
                    Spot::Input => self.answered(self.active) && self.text_selected[self.active],
                };
                if !ready {
                    return KeyOutcome::Used;
                }
                self.advance().map_or(KeyOutcome::Used, KeyOutcome::Sent)
            }
            "space" if !in_box => {
                if let Spot::Choice(c) = self.spot {
                    self.toggle(c);
                }
                KeyOutcome::Used
            }
            "backspace" if in_box => {
                self.backspace();
                KeyOutcome::Used
            }
            key if in_box => match k.key_char.as_deref() {
                Some(ch) if !ch.chars().any(char::is_control) => {
                    self.type_text(ch);
                    KeyOutcome::Used
                }
                _ => {
                    let _ = key;
                    KeyOutcome::Ignored
                }
            },
            key => match key.parse::<usize>() {
                Ok(n) if (1..=9).contains(&n) && n <= self.q().options.len() => {
                    self.toggle(n - 1);
                    KeyOutcome::Used
                }
                _ => KeyOutcome::Ignored,
            },
        }
    }
}

trait IntoNone {
    fn into_none<T>(self) -> Option<T>;
}

impl IntoNone for () {
    fn into_none<T>(self) -> Option<T> {
        None
    }
}

#[derive(Debug)]
pub enum KeyOutcome {
    Ignored,
    Used,
    Sent(QuestionsAnswered),
}

pub struct QuestionCard {
    state: QuestionState,
    owns_keys: bool,
    contested: bool,
    focus: FocusHandle,
}

impl EventEmitter<QuestionsAnswered> for QuestionCard {}

impl Focusable for QuestionCard {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl QuestionCard {
    /// Takes focus on mount, as the web card does, so Return reaches a choice.
    pub fn new(questions: Vec<Question>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        QuestionCard { state: QuestionState::new(questions), owns_keys: true, contested: false, focus }
    }

    pub fn state(&self) -> &QuestionState {
        &self.state
    }

    pub fn set_owns_keys(&mut self, owns: bool, contested: bool, cx: &mut Context<Self>) {
        (self.owns_keys, self.contested) = (owns, contested);
        cx.notify();
    }

    /// A keystroke from the window when no text field holds focus.
    pub fn key(&mut self, k: &Keystroke, cx: &mut Context<Self>) -> bool {
        if !self.owns_keys {
            return false;
        }
        let out = self.state.key(k);
        self.finish(out, cx)
    }

    fn finish(&mut self, out: KeyOutcome, cx: &mut Context<Self>) -> bool {
        match out {
            KeyOutcome::Ignored => false,
            KeyOutcome::Used => {
                cx.notify();
                true
            }
            KeyOutcome::Sent(a) => {
                cx.emit(a);
                cx.notify();
                true
            }
        }
    }

    fn act(&mut self, f: impl FnOnce(&mut QuestionState) -> Option<QuestionsAnswered>, cx: &mut Context<Self>) {
        if self.state.sent {
            return;
        }
        let out = f(&mut self.state).map_or(KeyOutcome::Used, KeyOutcome::Sent);
        self.finish(out, cx);
    }
}

fn focus_ring(tokens: &ChatTokens) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: tokens.ring.opacity(0.5),
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(3.),
        inset: false,
    }]
}

impl Render for QuestionCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tokens = ChatTokens::get(cx);
        let focused = self.focus.is_focused(window);
        let s = &self.state;
        let sent = s.sent;
        let dark = tokens.shadow_card.is_empty();
        let Some(q) = s.questions.get(s.active).cloned() else { return div().id("question-card") };
        let active = s.active;
        let multi = q.multi_select;

        let choices: Vec<AnyElement> = q
            .options
            .iter()
            .enumerate()
            .map(|(i, option)| {
                let checked = s.picked[active].contains(&i);
                let here = focused && s.spot == Spot::Choice(i);
                let indicator = div()
                    .mt(px(2.))
                    .size(px(16.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_1()
                    .rounded(px(if multi { 4. } else { 8. }))
                    .map(|d| {
                        if checked {
                            d.border_color(tokens.primary).bg(tokens.primary)
                        } else {
                            d.border_color(tokens.input).when(dark, |d| d.bg(tokens.input.opacity(0.3)))
                        }
                    })
                    .when(checked && !multi, |d| d.child(div().size(px(8.)).rounded(px(4.)).bg(tokens.primary_foreground)))
                    .when(checked && multi, |d| {
                        d.child(svg().path("icons/check.svg").size(px(14.)).text_color(tokens.primary_foreground))
                    });
                let shortcut = div().ml_auto().size(px(20.)).flex_none().when(i < 9, |d| {
                    d.mt(px(1.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(tokens.input)
                        .font_family(text::MONO).font_features(text::mono_features())
                        .text_size(px(10.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(tokens.muted_foreground)
                        .child(format!("{}", i + 1))
                });
                let body = div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .line_height(px(14. * 1.375))
                    .child(div().font_weight(FontWeight::MEDIUM).child(option.label.clone()))
                    .when_some(option.description.clone(), |d, desc| d.child(div().text_color(tokens.muted_foreground).child(desc)))
                    .when_some(option.preview.clone(), |d, preview| {
                        d.child(
                            div()
                                .mt(px(6.))
                                .rounded(px(8.))
                                .border_1()
                                .border_color(tokens.border)
                                .px(px(10.))
                                .py(px(8.))
                                .font_family(text::MONO).font_features(text::mono_features())
                                .text_size(px(12.))
                                .child(preview),
                        )
                    });
                div()
                    .id(SharedString::from(format!("q-{active}-{i}")))
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .px(px(12.))
                    .py(px(8.))
                    .rounded(px(10.))
                    .border_1()
                    .text_size(px(14.))
                    .text_color(tokens.foreground)
                    .map(|d| {
                        if checked {
                            d.border_color(tokens.primary.opacity(0.4)).bg(tokens.muted)
                        } else {
                            d.border_color(tokens.input)
                                .when(dark, |d| d.bg(tokens.input.opacity(0.2)))
                                .hover(|st| st.bg(tokens.muted.opacity(0.5)))
                        }
                    })
                    .when(here, |d| d.border_color(tokens.ring).shadow(focus_ring(&tokens)))
                    .when(sent, |d| d.opacity(0.5))
                    .when(!sent, |d| d.cursor_pointer())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.focus.focus(window, cx);
                        this.act(|s| s.toggle(i).into_none(), cx);
                    }))
                    .child(indicator)
                    .child(body)
                    .child(shortcut)
                    .into_any_element()
            })
            .collect();

        let in_box = focused && s.spot == Spot::Input;
        let typed = s.text[active].clone();
        let free_text = q.free_text.then(|| {
            div()
                .id(SharedString::from(format!("q-{active}-text")))
                .min_h(px(40.))
                .max_h(px(160.))
                .overflow_y_scroll()
                .px(px(10.))
                .py(px(8.))
                .rounded(px(10.))
                .border_1()
                .border_color(if in_box { tokens.ring } else { tokens.input })
                .when(dark, |d| d.bg(tokens.input.opacity(0.3)))
                .when(in_box, |d| d.shadow(focus_ring(&tokens)))
                .text_size(px(14.))
                .line_height(px(20.))
                .cursor_text()
                .on_click(cx.listener(|this, _, window, cx| {
                    this.focus.focus(window, cx);
                    this.state.spot = Spot::Input;
                    cx.notify();
                }))
                .map(|d| {
                    if typed.is_empty() {
                        d.flex().child(div().when(in_box, |d| d.child(caret(&tokens)))).child(
                            div().text_color(tokens.muted_foreground).child("Something else…"),
                        )
                    } else {
                        d.text_color(tokens.foreground)
                            .child(div().flex().flex_wrap().child(typed.clone()).when(in_box, |d| d.child(caret(&tokens))))
                    }
                })
        });

        let total = s.questions.len();
        let actions = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .when(active > 0, |d| {
                d.child(
                    button("q-previous", "Previous", Variant::Outline, true, sent, &tokens)
                        .on_click(cx.listener(move |this, _, _, cx| this.act(|s| s.go_to(active - 1).into_none(), cx))),
                )
            })
            .child(
                button("q-skip", "Skip", Variant::Outline, true, sent, &tokens)
                    .flex_grow(1.)
                    .flex_basis(gpui::relative(0.))
                    .on_click(cx.listener(|this, _, _, cx| this.act(QuestionState::skip, cx))),
            )
            .child(
                button("q-forward", if s.is_last() { "Send" } else { "Next" }, Variant::Default, true, sent, &tokens)
                    // `flex-4` against Skip's `flex-1`: the answer is the bigger target.
                    .flex_grow(4.)
                    .flex_basis(gpui::relative(0.))
                    .on_click(cx.listener(|this, _, _, cx| this.act(QuestionState::advance, cx))),
            );

        div()
            .id("question-card")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                if this.key(&e.keystroke, cx) {
                    cx.stop_propagation();
                }
            }))
            .max_w(px(448.))
            .rounded(px(14.))
            .when(self.owns_keys && self.contested, |d| {
                d.shadow(vec![BoxShadow {
                    color: tokens.ring.opacity(0.5),
                    offset: point(px(0.), px(0.)),
                    blur_radius: px(0.),
                    spread_radius: px(2.),
                    inset: false,
                }])
            })
            .flex()
            .flex_col()
            .gap(px(12.))
            .when(total > 1, |d| {
                d.child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(tokens.muted_foreground)
                        .child(format!("Question {} of {total}", active + 1)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .mb(px(16.))
                            .text_size(px(text::CHAT))
                            .line_height(px(text::CHAT * 1.375))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(tokens.foreground)
                            .child(q.question.clone()),
                    )
                    .child(div().flex().flex_col().gap(px(8.)).children(choices).children(free_text)),
            )
            .child(actions)
    }
}

fn caret(tokens: &ChatTokens) -> impl IntoElement {
    div().w(px(1.)).h(px(16.)).mt(px(2.)).bg(tokens.foreground)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dray_core::events::QuestionOption;
    use gpui::Modifiers;

    fn question(text: &str, multi: bool) -> Question {
        Question {
            question: text.into(),
            header: None,
            multi_select: multi,
            options: ["A", "B", "C"]
                .iter()
                .map(|l| QuestionOption { label: (*l).into(), description: None, preview: None })
                .collect(),
            free_text: true,
        }
    }

    fn key(k: &str) -> Keystroke {
        Keystroke { modifiers: Modifiers::default(), key: k.into(), key_char: (k.len() == 1).then(|| k.into()) }
    }

    fn sent(out: KeyOutcome) -> BTreeMap<String, String> {
        match out {
            KeyOutcome::Sent(a) => a.0,
            other => panic!("not sent: {other:?}"),
        }
    }

    #[test]
    fn digit_then_enter_sends_the_label() {
        let mut s = QuestionState::new(vec![question("Tabs?", false)]);
        assert!(matches!(s.key(&key("2")), KeyOutcome::Used));
        assert_eq!(sent(s.key(&key("enter"))), BTreeMap::from([("Tabs?".into(), "B".into())]));
    }

    #[test]
    fn enter_on_an_unpicked_choice_does_nothing() {
        let mut s = QuestionState::new(vec![question("Tabs?", false)]);
        assert!(matches!(s.key(&key("enter")), KeyOutcome::Used));
        assert!(!s.sent);
    }

    #[test]
    fn multi_select_joins_with_commas() {
        let mut s = QuestionState::new(vec![question("Which?", true)]);
        s.key(&key("1"));
        s.key(&key("3"));
        assert_eq!(sent(s.key(&key("enter"))), BTreeMap::from([("Which?".into(), "A, C".into())]));
    }

    #[test]
    fn free_text_replaces_a_single_pick() {
        let mut s = QuestionState::new(vec![question("Name?", false)]);
        s.key(&key("1"));
        s.spot = Spot::Input;
        for c in ["h", "i"] {
            s.key(&key(c));
        }
        assert!(s.picked[0].is_empty());
        assert_eq!(sent(s.key(&key("enter"))), BTreeMap::from([("Name?".into(), "hi".into())]));
    }

    #[test]
    fn skip_leaves_the_question_out_and_moves_on() {
        let mut s = QuestionState::new(vec![question("One?", false), question("Two?", false)]);
        assert!(s.skip().is_none());
        assert_eq!(s.active, 1);
        s.key(&key("1"));
        assert_eq!(sent(s.key(&key("enter"))), BTreeMap::from([("Two?".into(), "A".into())]));
    }

    #[test]
    fn arrows_select_radios_and_wrap() {
        let mut s = QuestionState::new(vec![question("Tabs?", false)]);
        s.key(&key("up"));
        assert_eq!(s.spot, Spot::Input);
        s.key(&key("up"));
        assert_eq!(s.spot, Spot::Choice(2));
        assert!(s.picked[0].contains(&2));
    }

    #[test]
    fn right_waits_for_an_answer() {
        let mut s = QuestionState::new(vec![question("One?", false), question("Two?", false)]);
        s.key(&key("right"));
        assert_eq!(s.active, 0);
        s.key(&key("1"));
        s.key(&key("right"));
        assert_eq!(s.active, 1);
    }
}
