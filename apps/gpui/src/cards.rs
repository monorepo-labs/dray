//! The open session's permission and question cards, as Chat.tsx draws
//! `pendingAsks`: oldest first, under the transcript, outside the turn stack.
//! Shaped to the window's `slots::cards`, so its body is one call to [cards].
//!
//! Each card is an entity held in keyed state by request id, since the slot is
//! a function and has nowhere else to keep one. Answers go out through the
//! [CardResponder] the window sets once: `respond_permission` and
//! `answer_questions` on the wire.

use std::collections::BTreeMap;
use std::rc::Rc;

use dray_core::events::{AgentEvent, AgentEventPayload, PermissionOption, Question};
use gpui::{
    AnyElement, App, Global, IntoElement, Keystroke, ParentElement, RenderOnce, SharedString, Styled, Task, Window,
    div, px,
};
use serde_json::Value;

use crate::permission_card::PermissionCard;
use crate::question_card::QuestionCard;
use crate::theme::Theme;
use crate::tools;

/// An answer for the wire, with the ids it is addressed by.
#[derive(Clone, Debug, PartialEq)]
pub enum CardAnswer {
    /// `respond_permission { sessionId, requestId, optionId }`.
    Permission { session_id: String, request_id: String, option_id: String },
    /// `answer_questions { sessionId, requestId, answers }`.
    Questions { session_id: String, request_id: String, answers: BTreeMap<String, String> },
}

/// Whether an answer reached the server. A card that sees `Err` takes answers
/// again, since the request is still open and the agent still blocked.
pub type Delivery = Task<Result<(), String>>;

/// Where answers go. Set once by the window; until then every answer fails.
pub struct CardResponder(pub Rc<dyn Fn(CardAnswer, &mut App) -> Delivery>);

impl Global for CardResponder {}

/// Sets what sends a card's answer, for every card in the window.
pub fn set_responder(cx: &mut App, f: impl Fn(CardAnswer, &mut App) -> Delivery + 'static) {
    cx.set_global(CardResponder(Rc::new(f)));
}

fn respond(answer: CardAnswer, cx: &mut App) -> Delivery {
    match cx.try_global::<CardResponder>().map(|r| r.0.clone()) {
        Some(f) => f(answer, cx),
        None => Task::ready(Err("not connected".into())),
    }
}

/// The card the window's keys reach when nothing else holds focus: the oldest
/// open one, as cardKeys.ts picks. Weak, so a card gone from screen takes none.
struct KeyOwner(Rc<dyn Fn(&Keystroke, &mut Window, &mut App) -> bool>);

impl Global for KeyOwner {}

/// A keystroke the window's root got with nothing else focused. True when the
/// owning card used it, so the caller stops it there.
pub fn forward_key(keystroke: &Keystroke, window: &mut Window, cx: &mut App) -> bool {
    let Some(f) = cx.try_global::<KeyOwner>().map(|o| o.0.clone()) else { return false };
    f(keystroke, window, cx)
}

/// One open request, read off its `agent_event` frame.
#[derive(Clone, Debug)]
pub enum Ask {
    Permission { request_id: String, description: String, argument: Option<String>, options: Vec<PermissionOption> },
    Questions { request_id: String, questions: Vec<Question> },
}

impl Ask {
    /// `None` for any other event, or a frame this build cannot read.
    pub fn parse(frame: &Value) -> Option<Ask> {
        let event: AgentEvent = serde_json::from_value(frame.clone()).ok()?;
        match event.payload {
            AgentEventPayload::PermissionRequested {
                request_id, tool_name, display_name, title, description, input, options, ..
            } => {
                // A plan's argument is pages of markdown, not a command: the
                // card points at the Plan tab instead of drawing it.
                let plan = matches!(tool_name.as_str(), "ExitPlanMode" | "exit_plan_mode");
                Some(Ask::Permission {
                    request_id,
                    description: description.or(title).or(display_name).unwrap_or(tool_name),
                    argument: if plan { None } else { tools::tool_argument(&input) },
                    options,
                })
            }
            AgentEventPayload::QuestionsAsked { request_id, questions, .. } => {
                Some(Ask::Questions { request_id, questions })
            }
            _ => None,
        }
    }

    fn request_id(&self) -> &str {
        match self {
            Ask::Permission { request_id, .. } | Ask::Questions { request_id, .. } => request_id,
        }
    }
}

/// The `slots::cards` body: `None` with nothing open.
pub fn cards(session_id: &str, asks: &[&Value], _theme: &Theme) -> Option<AnyElement> {
    let asks: Vec<Ask> = asks.iter().filter_map(|v| Ask::parse(v)).collect();
    (!asks.is_empty()).then(|| Cards { session_id: session_id.into(), asks }.into_any_element())
}

#[derive(IntoElement)]
struct Cards {
    session_id: SharedString,
    asks: Vec<Ask>,
}

impl RenderOnce for Cards {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let contested = self.asks.len() > 1;
        let mut col = div().flex().flex_col().gap(px(12.)).px(px(24.)).pb(px(12.));
        for (i, ask) in self.asks.into_iter().enumerate() {
            // Equal rank, so the oldest takes the keys, as cardKeys.ts picks.
            let owns = i == 0;
            let key = SharedString::from(format!("card-{}", ask.request_id()));
            let session_id = self.session_id.to_string();
            col = col.child(match ask {
                Ask::Permission { request_id, description, argument, options } => {
                    let card = window.use_keyed_state(key, cx, move |_, cx| {
                        PermissionCard::new(description, argument, options, cx).on_respond(move |id, cx| {
                            respond(
                                CardAnswer::Permission {
                                    session_id: session_id.clone(),
                                    request_id: request_id.clone(),
                                    option_id: id.to_owned(),
                                },
                                cx,
                            )
                        })
                    });
                    sync_keys(&card, owns, contested, cx, PermissionCard::keys, |c, o, k, cx| c.set_owns_keys(o, k, cx));
                    if owns {
                        let card = card.downgrade();
                        cx.set_global(KeyOwner(Rc::new(move |k, _, cx| {
                            card.update(cx, |c, cx| c.key(k, cx)).unwrap_or(false)
                        })));
                    }
                    card.into_any_element()
                }
                Ask::Questions { request_id, questions } => {
                    let card = window.use_keyed_state(key, cx, move |window, cx| {
                        QuestionCard::new(questions, window, cx).on_answer(move |a, cx| {
                            respond(
                                CardAnswer::Questions {
                                    session_id: session_id.clone(),
                                    request_id: request_id.clone(),
                                    answers: a.0.clone(),
                                },
                                cx,
                            )
                        })
                    });
                    sync_keys(&card, owns, contested, cx, QuestionCard::keys, |c, o, k, cx| c.set_owns_keys(o, k, cx));
                    if owns {
                        let card = card.downgrade();
                        cx.set_global(KeyOwner(Rc::new(move |k, window, cx| {
                            card.update(cx, |c, cx| c.key(k, window, cx)).unwrap_or(false)
                        })));
                    }
                    card.into_any_element()
                }
            });
        }
        col
    }
}

/// Only on a change: `set_owns_keys` notifies, and notifying every frame would
/// re-render forever.
fn sync_keys<C: 'static>(
    card: &gpui::Entity<C>,
    owns: bool,
    contested: bool,
    cx: &mut App,
    keys: impl FnOnce(&C) -> (bool, bool),
    set: impl FnOnce(&mut C, bool, bool, &mut gpui::Context<C>),
) {
    if keys(card.read(cx)) != (owns, contested) {
        card.update(cx, |c, cx| set(c, owns, contested, cx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(payload: Value) -> Value {
        json!({
            "id": "e1", "sessionId": "s1", "harness": "claude_code", "seq": 4,
            "ts": "2026-11-13T15:00:00Z", "payload": payload
        })
    }

    #[test]
    fn non_ask_frames_are_skipped() {
        assert!(Ask::parse(&json!({"nonsense": true})).is_none());
    }

    #[test]
    fn reads_a_question_frame() {
        let f = frame(json!({
            "type": "questions_asked", "requestId": "r1", "toolUseId": "t1",
            "questions": [{"question": "Tabs?", "multiSelect": false, "freeText": true,
                           "options": [{"label": "Tabs"}, {"label": "Spaces"}]}]
        }));
        let Some(Ask::Questions { request_id, questions }) = Ask::parse(&f) else { panic!("did not parse") };
        assert_eq!(request_id, "r1");
        assert_eq!(questions[0].options.len(), 2);
    }

    #[test]
    fn permission_falls_back_to_the_tool_name() {
        let f = frame(json!({
            "type": "permission_requested", "requestId": "r2", "toolUseId": "t2", "toolName": "Bash",
            "input": {"command": "rm -rf target"},
            "options": [{"id": "o1", "label": "Allow once", "kind": "once", "behavior": "allow"}]
        }));
        let Some(Ask::Permission { description, argument, .. }) = Ask::parse(&f) else { panic!("did not parse") };
        assert_eq!(description, "Bash");
        assert_eq!(argument.as_deref(), Some("rm -rf target"));
    }
}
