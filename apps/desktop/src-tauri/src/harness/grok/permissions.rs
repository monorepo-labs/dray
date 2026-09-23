//! The three things grok asks the client, and the shape each answer takes.
//!
//! All three arrive as JSON-RPC **requests** and all three block the turn until
//! something replies, so silence stalls the session exactly as an unanswered
//! `can_use_tool` does. What differs is what the reader is shown:
//!
//! - `session/request_permission` is a consent card whose options are grok's
//!   own, built by [`acp::pending_for`].
//! - `_x.ai/ask_user_question` is a *question*, not a consent: the call may
//!   always run and the answer **is** the reply. Drawn as the form Claude
//!   Code's `AskUserQuestion` already draws.
//! - `_x.ai/exit_plan_mode` is a plan approval, drawn as a two-button card,
//!   since the wire has exactly two answers — see [`plan_options`].

use crate::events::{
    PermissionBehavior, PermissionOption, PermissionOptionKind, Question, QuestionOption,
};
use crate::harness::acp;
use crate::harness::claude_code::permissions::{PendingRequest, Reply, ResolvedOption};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use super::parser::{AskUserQuestion, ExitPlanMode, PermissionRequest};

/// Builds the held request and its buttons in one pass.
pub fn pending_for(
    request: &PermissionRequest,
    rpc_id: i64,
) -> (PendingRequest, Vec<PermissionOption>) {
    let call = &request.tool_call;
    acp::pending_for("grok", &call.tool_call_id, call.meta.name().unwrap_or("tool"), &request.options, rpc_id)
}

/// A plan approval, held like any other request but drawn with two buttons.
///
/// **The wire has exactly two answers and seven spellings of the second.**
/// `{"outcome":"approved"}` approves — the tool then reads "Your plan has been
/// approved. You can now start coding." Every other shape measured
/// (`decision: approve|approved|reject|abandon`, `executePlan`,
/// `approved: true`, `outcome: abandon`) *and* a JSON-RPC error all read as
/// "The user wants to revise the plan", so Revise sends the cheapest of them.
/// Abandoning a plan is the reader's next prompt rather than a third button.
pub fn plan_pending(request: &ExitPlanMode, rpc_id: i64) -> (PendingRequest, Vec<PermissionOption>) {
    let resolved = plan_options();
    let offered = resolved.iter().map(|r| r.option.clone()).collect();

    let pending = PendingRequest {
        tool_use_id: request.tool_call_id.clone(),
        tool_name: "exit_plan_mode".to_string(),
        // The plan does *not* go here, and that is the fix rather than an
        // omission: this struct is only ever read to rebuild an answer, and a
        // plan's answer is a fixed outcome that rebuilds nothing. The frontend
        // reads the **event**, so the plan rides `PermissionRequested.input` —
        // one copy, in the one place anything looks.
        input: Value::Null,
        options: resolved
            .into_iter()
            .map(|r| (r.option.id.clone(), r))
            .collect(),
        reply: Reply::Rpc(rpc_id),
    };

    (pending, offered)
}

fn plan_options() -> Vec<ResolvedOption> {
    vec![
        ResolvedOption {
            option: PermissionOption {
                id: "grok-plan-approve".to_string(),
                label: "Approve plan".to_string(),
                kind: PermissionOptionKind::Once,
                behavior: PermissionBehavior::Allow,
            },
            updates: Vec::new(),
            decision: Some(json!({"outcome": "approved"})),
        },
        ResolvedOption {
            option: PermissionOption {
                id: "grok-plan-revise".to_string(),
                // Not "Deny": the turn carries on either way and grok's own
                // answer to this is to ask what to change, so a refusal's
                // wording would promise a stop that does not happen.
                label: "Keep planning".to_string(),
                kind: PermissionOptionKind::Deny,
                behavior: PermissionBehavior::Deny,
            },
            updates: Vec::new(),
            // Anything but `approved`. An empty object is the cheapest of the
            // seven measured spellings and needs no field this build invented.
            decision: Some(json!({})),
        },
    ]
}

/// A held question, registered like a permission — grok is blocked on it either
/// way — but with **no options**, because the form is the answer.
pub fn question_pending(request: &AskUserQuestion, rpc_id: i64) -> (PendingRequest, Vec<Question>) {
    let questions = request
        .questions
        .iter()
        .map(|asked| Question {
            question: asked.question.clone(),
            // grok sends no short chip label beside the question, where Claude
            // Code's tool schema has one. Absent rather than a truncation of the
            // question, which the card already draws in full.
            header: None,
            multi_select: asked.multi_select,
            options: asked
                .options
                .iter()
                .map(|option| QuestionOption {
                    label: option.label.clone(),
                    description: option.description.clone(),
                    preview: None,
                })
                .collect(),
            // grok's `answers` value is `StringOrVec` with no closed set behind
            // it — a typed sentence reaches the model verbatim, measured.
            free_text: true,
        })
        .collect();

    let pending = PendingRequest {
        tool_use_id: request.tool_call_id.clone(),
        tool_name: "ask_user_question".to_string(),
        input: Value::Null,
        options: HashMap::new(),
        reply: Reply::Rpc(rpc_id),
    };

    (pending, questions)
}

/// The reply `_x.ai/ask_user_question` wants, given what the form collected.
///
/// The result is an **internally tagged enum whose tag is `outcome`** — every
/// shape without that field is refused outright (`missing field \`outcome\``),
/// which fails the tool. `answers` is a map keyed by each question's **verbatim
/// text**, exactly Claude Code's rule; a list is refused (`invalid type:
/// sequence, expected a map`). An unanswered question is simply left out.
///
/// An empty map answers `skip_interview` rather than `accepted` with nothing in
/// it: both are accepted and both complete the tool, but only the first tells
/// grok what actually happened — that the reader chose not to answer — where the
/// second claims answers were given and names none.
///
/// **A multi-select answer rides as the one comma-joined string the card
/// collects**, not as the array grok also takes. Both deserialize — the field is
/// `StringOrVec` — and splitting the string back apart would be lossy the first
/// time an option's own label contains a comma.
pub fn question_answer(answers: &HashMap<String, String>) -> Value {
    if answers.is_empty() {
        return json!({"outcome": "skip_interview"});
    }

    let map: Map<String, Value> = answers
        .iter()
        .map(|(question, answer)| (question.clone(), Value::String(answer.clone())))
        .collect();

    // `partial_answers` is optional and defaults false, and a shape sending it
    // was accepted alongside one that did not. Omitted: nothing here knows
    // whether a question went unanswered on purpose.
    json!({"outcome": "accepted", "answers": map})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::grok::parser::{AskedOption, AskedQuestion, PermissionChoice, ToolCallRef};

    fn request(kinds: &[(&str, &str)]) -> PermissionRequest {
        PermissionRequest {
            tool_call: ToolCallRef {
                tool_call_id: "call-1".into(),
                ..Default::default()
            },
            options: kinds
                .iter()
                .map(|(id, kind)| PermissionChoice {
                    option_id: id.to_string(),
                    name: id.replace('-', " "),
                    kind: kind.to_string(),
                })
                .collect(),
        }
    }

    /// The four options a shell command raises, drawn in card order with grok's
    /// own ids carried back whole inside the outcome envelope.
    #[test]
    fn the_captured_options_become_four_buttons() {
        let request = request(&[
            ("always-allow", "allow_always"),
            ("allow-once", "allow_once"),
            ("reject-once", "reject_once"),
            ("reject-always", "reject_always"),
        ]);
        let (pending, offered) = pending_for(&request, 7);

        let kinds: Vec<PermissionOptionKind> = offered.iter().map(|o| o.kind).collect();
        assert_eq!(
            kinds,
            [
                PermissionOptionKind::Once,
                PermissionOptionKind::AlwaysRule,
                PermissionOptionKind::Deny,
                PermissionOptionKind::Deny,
            ]
        );
        assert_eq!(pending.reply, Reply::Rpc(7));
        assert_eq!(pending.tool_use_id, "call-1");
        assert_eq!(
            pending.options["grok-allow-once"].decision.as_ref().unwrap(),
            &json!({"outcome": {"outcome": "selected", "optionId": "allow-once"}})
        );
    }

    /// A kind this build cannot spell is dropped, and a card left with no way
    /// to refuse gets ACP's own `cancelled` outcome — a request nobody can say
    /// no to stalls the turn just as an unanswered one does.
    #[test]
    fn a_request_with_no_refusal_gets_one() {
        let request = request(&[("allow-once", "allow_once"), ("later", "some_new_kind")]);
        let (pending, offered) = pending_for(&request, 2);

        assert_eq!(offered.len(), 2, "the unknown kind goes, a Deny arrives");
        assert_eq!(
            pending.options["grok-cancelled"].decision.as_ref().unwrap(),
            &json!({"outcome": {"outcome": "cancelled"}})
        );
    }

    /// Only `{"outcome":"approved"}` approves a plan — seven other spellings
    /// and a JSON-RPC error all read as "revise" — so Approve's payload is
    /// pinned rather than left to the comment above it.
    #[test]
    fn approving_a_plan_sends_the_one_shape_grok_accepts() {
        let (pending, offered) = plan_pending(
            &ExitPlanMode {
                tool_call_id: "call-9".into(),
                plan_content: "do the thing".into(),
            },
            3,
        );

        assert_eq!(offered.len(), 2);
        assert_eq!(pending.tool_use_id, "call-9");
        assert_eq!(
            pending.options["grok-plan-approve"].decision.as_ref().unwrap(),
            &json!({"outcome": "approved"})
        );
        assert_eq!(
            pending.options["grok-plan-revise"].decision.as_ref().unwrap(),
            &json!({})
        );
    }

    /// The tag is `outcome` and the answers are a map keyed by the question's
    /// own text. Every shape without that tag is refused and fails the tool.
    #[test]
    fn an_answer_is_tagged_and_keyed_by_the_question_text() {
        let mut answers = HashMap::new();
        answers.insert("Q1 tea or coffee?".to_string(), "tea".to_string());

        assert_eq!(
            question_answer(&answers),
            json!({"outcome": "accepted", "answers": {"Q1 tea or coffee?": "tea"}})
        );
    }

    /// Answering nothing is a real answer, and `skip_interview` is the one that
    /// says so — `accepted` with an empty map claims answers were given.
    #[test]
    fn answering_nothing_skips_rather_than_accepting_nothing() {
        assert_eq!(
            question_answer(&HashMap::new()),
            json!({"outcome": "skip_interview"})
        );
    }

    /// A question is not a consent: the call runs either way, so the card
    /// carries a form and no buttons at all.
    #[test]
    fn a_question_is_held_with_no_options() {
        let asked = AskUserQuestion {
            tool_call_id: "call-3".into(),
            questions: vec![AskedQuestion {
                question: "tea or coffee?".into(),
                options: vec![AskedOption {
                    label: "tea".into(),
                    description: Some("tea".into()),
                }],
                multi_select: false,
            }],
        };

        let (pending, questions) = question_pending(&asked, 4);
        assert!(pending.options.is_empty());
        assert_eq!(pending.tool_name, "ask_user_question");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].options[0].label, "tea");
        // grok takes any string, so the box the card promises is a real answer.
        assert!(questions[0].free_text);
    }
}
