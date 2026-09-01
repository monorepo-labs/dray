//! Extension dialogs, turned into the question Dray already draws.
//!
//! pi is extensible, and an extension is where its permission gates, its
//! approval classifiers and its path guards actually live — there is no gate in
//! pi itself. Every one of those packages asks the reader the same way, over
//! `extension_ui_request`, because [`createExtensionUIContext`] is the single
//! bridge each of them is handed. So supporting *the channel* supports every
//! package anyone installs, including ones nobody has written yet, and Dray
//! ships no gate of its own to compete with them.
//!
//! Nine methods reach the wire. Four block until they are answered and are
//! what this module builds a card for; the other five are announcements pi
//! registers no waiter for.
//!
//! Which is which is read off `createExtensionUIContext` and stated here in two
//! lists rather than inferred, because both ways of being wrong are silent: pi
//! drops a reply nobody is waiting for without complaining, and a blocking
//! method mistaken for an announcement hangs the tool call that raised it.
//!
//! The card is [`QuestionsAsked`](crate::events::AgentEventPayload::QuestionsAsked),
//! not a permission request, and that is the honest reading rather than a reuse
//! of convenience: nothing is being consented to, the call runs either way, and
//! the answer *is* the reply. An Allow/Deny pair over "Which framework?" would
//! describe the wrong act, and picking Allow would send the string `"allow"` to
//! an extension expecting one of its own labels.
//!
//! [`createExtensionUIContext`]: https://pi.dev

use serde_json::{json, Value};
use std::collections::HashMap;

use super::parser::PiEvent;
use crate::events::{Question, QuestionOption};
use crate::harness::claude_code::permissions::PendingRequest;

/// The methods that block. Kept as one list because the read loop and this
/// module have to agree on which lines get a card and which get dropped, and
/// disagreeing either hangs a turn or files an announcement as a coverage gap.
///
/// `editor` is the one with no deadline of its own. The other three are built
/// by `createDialogPromise`, which honours `opts.timeout`; `editor` registers
/// its waiter by hand and passes none, so an unanswered one blocks its tool
/// call for the life of the process.
pub const BLOCKING: [&str; 4] = ["select", "confirm", "input", "editor"];

/// The methods pi sends and registers no waiter for. A reply to one of these is
/// dropped, so refusing them would file five ordinary UI messages as coverage
/// gaps and tell the reader they were refused something they were only being
/// told.
///
/// Read off `createExtensionUIContext`, which is the only place the split is
/// stated. Getting it wrong is quiet in both directions: a blocking method
/// treated as an announcement hangs the turn, and an announcement treated as
/// blocking answers a question nobody asked.
pub const ANNOUNCEMENTS: [&str; 5] = [
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
];

/// pi's own wording for a yes/no. `confirm` carries no labels on the wire — it
/// resolves to a boolean — so these are Dray's, and they are what maps back.
const YES: &str = "Yes";
const NO: &str = "No";

/// Builds the card an extension's question is drawn as, or `None` where the
/// line is not one that blocks.
///
/// The dialog's own id becomes the request id, so the map entry is already
/// filed under the id the answer has to name and nothing extra has to be
/// remembered to address the reply.
pub fn for_request(event: &PiEvent) -> Option<(String, PendingRequest, Vec<Question>)> {
    let PiEvent::ExtensionUiRequest {
        id,
        method,
        title,
        message,
        options,
    } = event
    else {
        return None;
    };

    if !BLOCKING.contains(&method.as_str()) {
        return None;
    }

    // Both go in the question, and neither in `header`. The card does not draw
    // headers — that slot is a chip-sized label `AskUserQuestion`'s model writes,
    // and it says nothing the question doesn't — so a title put there is a title
    // nobody sees. `ctx.ui.confirm("Overwrite?", "file exists")` drew "file
    // exists" over Yes and No, hiding what Yes authorised.
    //
    // Which of the two carries the substance is not knowable: `confirm` often
    // asks in its title and explains in its message, while `project_trust`'s
    // `select` puts the whole prompt in the title. So both are shown, as two
    // lines rather than one sentence, since running them together reads as one
    // long question with a fragment on the end.
    let question = match (title, message) {
        (Some(title), Some(message)) => format!("{title}\n\n{message}"),
        (Some(text), None) | (None, Some(text)) => text.clone(),
        (None, None) => format!("The extension is asking for a {method}"),
    };

    let choices: Vec<QuestionOption> = match method.as_str() {
        "select" => options
            .iter()
            .flatten()
            .map(|option| QuestionOption {
                // An option is a bare string on the wire, and a non-string is
                // rendered rather than dropped: losing one silently would offer
                // a list the extension will not recognise an answer from.
                label: match option {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                },
                description: None,
                preview: None,
            })
            .collect(),
        "confirm" => [YES, NO]
            .into_iter()
            .map(|label| QuestionOption {
                label: label.to_string(),
                description: None,
                preview: None,
            })
            .collect(),
        // `input` and `editor` both take an answer that is not on a list. The
        // difference is only how much of one: `editor` opens a text area with
        // `prefill` in it, and neither the area nor the prefill has anywhere to
        // go on this card yet — so it draws as a plain box, which takes the
        // answer even where it flatters the question.
        _ => Vec::new(),
    };

    let pending = PendingRequest {
        // No tool call to hang this off: an extension may ask from a
        // `tool_call` hook, from a command, or from nothing at all, and the
        // wire carries no correlation to one. The dialog's own id stands in, so
        // the retiring `PermissionDecided` still names something real.
        tool_use_id: id.clone(),
        tool_name: method.clone(),
        input: Value::Null,
        options: HashMap::new(),
        rpc_id: None,
        pi_dialog_method: Some(method.clone()),
    };

    let questions = vec![Question {
        question,
        header: None,
        multi_select: false,
        // A box beside a `select` would let the reader send the extension a
        // sentence where it expects one of its own options.
        free_text: choices.is_empty(),
        options: choices,
    }];

    Some((id.clone(), pending, questions))
}

/// The line that answers one, in the shape its own method reads.
///
/// A dialog is answered in its own shape rather than through one envelope, so
/// this is where the four diverge: `confirm` reads `confirmed`, the other
/// three read `value`. A reply in the wrong shape is dropped in silence and
/// the turn stays blocked, which is why the method is remembered rather than
/// guessed at from what came back.
///
/// No answer is `cancelled`, which every dialog understands and resolves to the
/// default it was constructed with. That is the truthful answer to a skip: the
/// alternative is sending an empty string, which `confirm` would read as `false`
/// and `select` would hand its extension as a choice nobody made.
pub fn response(method: &str, id: &str, answers: &HashMap<String, String>) -> Value {
    let Some(answer) = answers.values().next() else {
        return json!({"type": "extension_ui_response", "id": id, "cancelled": true});
    };

    match method {
        "confirm" => json!({
            "type": "extension_ui_response",
            "id": id,
            "confirmed": answer == YES,
        }),
        _ => json!({"type": "extension_ui_response", "id": id, "value": answer}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, title: Option<&str>, options: Option<Vec<&str>>) -> PiEvent {
        PiEvent::ExtensionUiRequest {
            id: "d-1".to_string(),
            method: method.to_string(),
            title: title.map(str::to_string),
            message: None,
            options: options.map(|o| o.into_iter().map(|s| json!(s)).collect()),
        }
    }

    fn answers(text: &str, question: &str) -> HashMap<String, String> {
        HashMap::from([(question.to_string(), text.to_string())])
    }

    /// A `select` draws the extension's own options and nothing beside them.
    #[test]
    fn a_select_offers_exactly_what_the_extension_listed() {
        let event = request(
            "select",
            Some("Allow probe_tool?"),
            Some(vec!["Allow once", "Allow always", "Deny"]),
        );

        let (id, pending, questions) = for_request(&event).expect("a select blocks");

        assert_eq!(id, "d-1", "the dialog's id is the request id");
        assert_eq!(pending.pi_dialog_method.as_deref(), Some("select"));
        assert_eq!(questions[0].question, "Allow probe_tool?");

        let labels: Vec<&str> = questions[0]
            .options
            .iter()
            .map(|o| o.label.as_str())
            .collect();
        assert_eq!(labels, ["Allow once", "Allow always", "Deny"]);

        assert!(
            !questions[0].free_text,
            "a typed sentence is not an answer this extension can use"
        );
    }

    /// The answer is the label, which is what `ctx.ui.select` resolves to.
    #[test]
    fn a_select_answers_with_the_label_that_was_picked() {
        let sent = response("select", "d-1", &answers("Allow always", "Allow probe_tool?"));

        assert_eq!(
            sent,
            json!({"type": "extension_ui_response", "id": "d-1", "value": "Allow always"})
        );
    }

    /// `confirm` resolves to a boolean, so its two buttons map back to one.
    #[test]
    fn a_confirm_answers_with_a_boolean_and_not_a_label() {
        let event = request("confirm", Some("Confirm?"), None);
        let (_, _, questions) = for_request(&event).expect("a confirm blocks");

        let labels: Vec<&str> = questions[0]
            .options
            .iter()
            .map(|o| o.label.as_str())
            .collect();
        assert_eq!(labels, [YES, NO], "pi sends no labels, so these are ours");

        assert_eq!(
            response("confirm", "d-1", &answers(YES, "Confirm?")),
            json!({"type": "extension_ui_response", "id": "d-1", "confirmed": true})
        );
        assert_eq!(
            response("confirm", "d-1", &answers(NO, "Confirm?")),
            json!({"type": "extension_ui_response", "id": "d-1", "confirmed": false})
        );
    }

    /// A confirm's title reaches the reader, because nothing else will show it.
    ///
    /// It used to ride `header`, which the card deliberately never draws — so
    /// `confirm("Overwrite?", "file exists")` put "file exists" over Yes and No
    /// and hid what Yes authorised. Which field carries the substance is not
    /// knowable from the wire, so both are shown.
    #[test]
    fn both_halves_of_a_confirm_reach_the_reader() {
        let event = PiEvent::ExtensionUiRequest {
            id: "d-1".to_string(),
            method: "confirm".to_string(),
            title: Some("Overwrite?".to_string()),
            message: Some("file exists".to_string()),
            options: None,
        };

        let (_, _, questions) = for_request(&event).expect("a confirm blocks");

        assert!(questions[0].question.contains("Overwrite?"));
        assert!(questions[0].question.contains("file exists"));
        assert_eq!(
            questions[0].header, None,
            "the card draws no header, so nothing may be left in one"
        );
    }

    /// `editor` blocks, so it gets a card rather than a refusal.
    ///
    /// It was read as unsupported once and auto-cancelled, which is the quietest
    /// way to get this wrong: the extension sees its own dialog dismissed, so it
    /// carries on with the default and the reader is never asked. `editor` is
    /// also the one method built without a timeout, so nothing else would have
    /// come along to end the wait.
    #[test]
    fn an_editor_takes_free_text_the_way_an_input_does() {
        let event = request("editor", Some("Edit the message"), None);
        let (_, pending, questions) = for_request(&event).expect("an editor blocks");

        assert!(questions[0].options.is_empty());
        assert!(questions[0].free_text);
        assert_eq!(pending.pi_dialog_method.as_deref(), Some("editor"));

        assert_eq!(
            response("editor", "d-1", &answers("rewritten", "Edit the message")),
            json!({"type": "extension_ui_response", "id": "d-1", "value": "rewritten"})
        );
    }

    /// The two lists cannot overlap, and between them they have to name every
    /// method that reaches the wire.
    ///
    /// Read off `createExtensionUIContext` in pi 0.84.4. A method in neither
    /// list is refused and filed as a coverage gap, which is the right answer to
    /// one nobody has looked at and the wrong one to `setTitle`.
    #[test]
    fn every_method_pi_sends_is_on_exactly_one_list() {
        for method in BLOCKING {
            assert!(
                !ANNOUNCEMENTS.contains(&method),
                "{method} cannot both block and be an announcement"
            );
        }

        let known: Vec<&str> = BLOCKING
            .iter()
            .chain(ANNOUNCEMENTS.iter())
            .copied()
            .collect();
        for method in [
            "select",
            "confirm",
            "input",
            "editor",
            "notify",
            "setStatus",
            "setWidget",
            "setTitle",
            "set_editor_text",
        ] {
            assert!(
                known.contains(&method),
                "{method} reaches the wire unclassified"
            );
        }
    }

    /// `input` is the one dialog whose answer is not on a list.
    #[test]
    fn an_input_is_the_only_one_that_takes_free_text() {
        let event = request("input", Some("Name it"), None);
        let (_, _, questions) = for_request(&event).expect("an input blocks");

        assert!(questions[0].options.is_empty());
        assert!(questions[0].free_text);

        assert_eq!(
            response("input", "d-1", &answers("typed by dray", "Name it")),
            json!({"type": "extension_ui_response", "id": "d-1", "value": "typed by dray"})
        );
    }

    /// Skipping still answers, because pi is blocked either way.
    ///
    /// `cancelled` and not an empty string: `confirm` would read `""` as `false`
    /// and act on a decision the reader never made.
    #[test]
    fn a_skipped_dialog_is_cancelled_rather_than_answered_emptily() {
        for method in BLOCKING {
            assert_eq!(
                response(method, "d-1", &HashMap::new()),
                json!({"type": "extension_ui_response", "id": "d-1", "cancelled": true}),
                "{method} left unanswered has to unblock the turn"
            );
        }
    }

    /// An announcement gets no card, because nothing is waiting on one.
    #[test]
    fn an_announcement_is_not_a_question() {
        for method in ANNOUNCEMENTS {
            assert!(
                for_request(&request(method, Some("hi"), None)).is_none(),
                "{method} registers no waiter, so a card would ask about nothing"
            );
        }
    }

    /// The real capture, run through the builder that will answer it.
    ///
    /// The unit tests above are written against shapes; this is written against
    /// a pi that actually ran one. The extension is committed beside the
    /// capture (`fixtures/extension_tool_and_dialogs.probe.js`) and every
    /// answer in that session was accepted — the extension's closing `notify`
    /// echoed all three back — so this pins the builder to a conversation that
    /// demonstrably worked rather than to a reading of pi's source.
    #[test]
    fn the_captured_dialogs_each_get_the_card_they_need() {
        #[derive(serde::Deserialize)]
        struct Record {
            dir: String,
            line: String,
        }

        let drawn: Vec<(String, bool, usize)> =
            include_str!("fixtures/extension_tool_and_dialogs.jsonl")
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str::<Record>(l).expect("fixture record"))
                .filter(|r| r.dir == "out")
                .filter_map(|r| super::super::parser::parse_line(&r.line).ok())
                .filter_map(|event| {
                    let (_, pending, questions) = for_request(&event)?;
                    Some((
                        pending.pi_dialog_method.unwrap_or_default(),
                        questions[0].free_text,
                        questions[0].options.len(),
                    ))
                })
                .collect();

        assert_eq!(
            drawn,
            vec![
                ("select".to_string(), false, 3),
                ("confirm".to_string(), false, 2),
                ("input".to_string(), true, 0),
            ],
            "three blocking dialogs get cards; the two announcements beside \
             them get none"
        );
    }

    /// A dialog that names nothing still says what it is.
    ///
    /// An extension may call `ctx.ui.input()` with no title at all, and a card
    /// with an empty question reads as a rendering failure rather than as a
    /// question.
    #[test]
    fn a_dialog_with_no_words_in_it_still_asks_something() {
        let event = request("input", None, None);
        let (_, _, questions) = for_request(&event).expect("an input blocks");

        assert!(questions[0].question.contains("input"));
    }
}
