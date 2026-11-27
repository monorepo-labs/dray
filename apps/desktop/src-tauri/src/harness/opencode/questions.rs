//! OpenCode 2's `question` tool, asked as ACP `elicitation/create`.
//!
//! **Sent only to a client advertising `elicitation.form`**, which
//! `open_session` does; without it OpenCode answers the tool itself with "The
//! question couldn't be shown to the user in this client". Read from v2's own
//! `acp/elicitation.ts` and `tool/plugin/question.ts`: question `i` is field
//! `q<i>` — `description` the question, `title` its header, `oneOf` (one pick)
//! or `items.anyOf` (several) the options, each `{const, title, description}`
//! — and `q<i>_custom` beside it takes typed text. The answer is
//! `{"action":"accept","content":{"q0":"Red","q1":["A","B"],"q1_custom":"…"}}`;
//! `accept` with nothing filled in is a skip the model is told about.

use crate::events::{Question, QuestionOption};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const CUSTOM: &str = "_custom";

/// The card's questions, and what [`answer`] needs to map its answers back:
/// per question text, `{key, values: {label: const}, multi, custom}`.
///
/// `None` for a form with a field the card cannot draw — a yes/no, a number —
/// which OpenCode's other forms use; the caller declines it rather than guess.
pub fn read(params: &Value) -> Option<(Vec<Question>, Value)> {
    let props = params.pointer("/requestedSchema/properties")?.as_object()?;
    let mut keys: Vec<&String> = props.keys().filter(|k| !k.ends_with(CUSTOM)).collect();
    // `q0`…`q10` in asked order whatever order the map keeps.
    keys.sort_by_key(|k| (k.len(), k.as_str()));
    if keys.is_empty() {
        return None;
    }

    let mut questions = Vec::new();
    let mut lookup = Map::new();
    for key in keys {
        let field = &props[key];
        let multi = match field.get("type")?.as_str()? {
            "string" => false,
            "array" => true,
            _ => return None,
        };
        let choices = if multi { field.pointer("/items/anyOf") } else { field.get("oneOf") };
        let choices = choices.and_then(Value::as_array).cloned().unwrap_or_default();
        let custom = format!("{key}{CUSTOM}");
        let custom = props.contains_key(&custom).then_some(custom);

        let text = |name: &str| field.get(name).and_then(Value::as_str).map(str::to_string);
        let question = text("description").or_else(|| text("title"))?;
        let mut values = Map::new();
        let options = choices
            .iter()
            .filter_map(|choice| {
                let value = choice.get("const")?.clone();
                let label = choice.get("title").and_then(Value::as_str).map(str::to_string);
                let label = label.or_else(|| value.as_str().map(str::to_string))?;
                values.insert(label.clone(), value);
                Some(QuestionOption {
                    label,
                    description: choice.get("description").and_then(Value::as_str).map(str::to_string),
                    preview: None,
                })
            })
            .collect();
        lookup.insert(
            question.clone(),
            json!({"key": key, "values": values, "multi": multi, "custom": custom}),
        );
        questions.push(Question {
            question,
            header: text("title"),
            multi_select: multi,
            // No options is a plain text question: the box alone.
            free_text: custom.is_some() || choices.is_empty(),
            options,
        });
    }
    Some((questions, Value::Object(lookup)))
}

/// The `elicitation/create` result for the card's answers, keyed by question
/// text as every card answers. An empty map is a skip.
pub fn answer(lookup: &Value, answers: &HashMap<String, String>) -> Value {
    let mut content = Map::new();
    for (question, said) in answers {
        let Some(spec) = lookup.get(question) else {
            continue;
        };
        let Some(key) = spec["key"].as_str() else {
            continue;
        };
        let custom = spec["custom"].as_str();
        let pick = |label: &str| spec["values"].get(label.trim()).cloned();

        if spec["multi"].as_bool().unwrap_or(false) {
            // A multi-select answer is one comma-joined string on every card.
            let (picked, typed): (Vec<&str>, Vec<&str>) =
                said.split(',').map(str::trim).filter(|s| !s.is_empty()).partition(|s| pick(s).is_some());
            content.insert(key.to_string(), Value::Array(picked.iter().filter_map(|s| pick(s)).collect()));
            if let (Some(custom), false) = (custom, typed.is_empty()) {
                content.insert(custom.to_string(), json!(typed.join(", ")));
            }
        } else if let Some(value) = pick(said) {
            content.insert(key.to_string(), value);
        } else {
            content.insert(custom.unwrap_or(key).to_string(), json!(said));
        }
    }
    json!({"action": "accept", "content": content})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `acp/elicitation.ts` builds for two questions, the second a
    /// multi-select, each with its typed-answer field.
    fn asked() -> Value {
        json!({
            "mode": "form", "sessionId": "ses_1", "toolCallId": "call_1", "message": "Questions",
            "requestedSchema": {"type": "object", "required": [], "properties": {
                "q1": {"type": "array", "title": "Extras", "description": "Which extras?",
                       "items": {"anyOf": [{"const": "A", "title": "A"}, {"const": "B", "title": "B"}]}},
                "q1_custom": {"type": "string", "title": "Extras (other)"},
                "q0": {"type": "string", "title": "Color", "description": "Which color?",
                       "oneOf": [{"const": "Red", "title": "Red", "description": "Warm."},
                                 {"const": "Blue", "title": "Blue"}]},
                "q0_custom": {"type": "string", "title": "Color (other)"},
            }},
        })
    }

    #[test]
    fn a_question_form_reads_into_the_card_in_asked_order() {
        let (questions, _) = read(&asked()).unwrap();
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question, "Which color?");
        assert_eq!(questions[0].header.as_deref(), Some("Color"));
        assert!(!questions[0].multi_select && questions[0].free_text);
        assert_eq!(questions[0].options[0].description.as_deref(), Some("Warm."));
        assert!(questions[1].multi_select);
    }

    /// A label goes back as its `const`; anything else rides the `_custom`
    /// field beside it, which is how OpenCode takes typed text.
    #[test]
    fn answers_go_back_on_their_fields() {
        let (_, lookup) = read(&asked()).unwrap();
        let answers = HashMap::from([
            ("Which color?".to_string(), "Blue".to_string()),
            ("Which extras?".to_string(), "A, B, my own".to_string()),
        ]);
        assert_eq!(
            answer(&lookup, &answers),
            json!({"action": "accept", "content": {"q0": "Blue", "q1": ["A", "B"], "q1_custom": "my own"}})
        );

        let typed = HashMap::from([("Which color?".to_string(), "Green".to_string())]);
        assert_eq!(answer(&lookup, &typed)["content"], json!({"q0_custom": "Green"}));
        assert_eq!(answer(&lookup, &HashMap::new()), json!({"action": "accept", "content": {}}));
    }

    /// The form a live 2.4.2 sent, answered the way the capture answered it.
    #[test]
    fn the_captured_form_reads_and_answers() {
        let line = include_str!("fixtures/question_v2.jsonl")
            .lines()
            .find(|l| l.contains("elicitation/create"))
            .unwrap();
        let asked: Value = serde_json::from_str(&line[3..]).unwrap();
        let (questions, lookup) = read(&asked["params"]).unwrap();
        assert_eq!(questions[0].question, "Which color do you choose?");
        let labels: Vec<&str> = questions[0].options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Red", "Blue"]);
        let answers = HashMap::from([("Which color do you choose?".to_string(), "Blue".to_string())]);
        assert_eq!(answer(&lookup, &answers)["content"], json!({"q0": "Blue"}));
    }

    #[test]
    fn a_form_the_card_cannot_draw_is_declined() {
        let form = json!({"requestedSchema": {"properties": {"ok": {"type": "boolean", "title": "Sure?"}}}});
        assert!(read(&form).is_none());
    }
}
