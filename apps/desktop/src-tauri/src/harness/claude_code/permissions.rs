//! The answer side of a permission request.
//!
//! A `can_use_tool` control request blocks the CLI until a `control_response`
//! carrying its `request_id` comes back, so this module exists to make sure one
//! always does. It turns the CLI's own suggestions into the buttons a user sees,
//! remembers which button carried which rule, and builds the reply.
//!
//! The rules never leave Rust. An option travels to the frontend as an id and a
//! label; the frontend answers with the id. That way a standing rule — the one
//! thing here that outlives the call it was granted for — is only ever composed
//! from what the CLI proposed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::parser::{PermissionRequest, PermissionUpdate};
use crate::events::{PermissionBehavior, PermissionOption, PermissionOptionKind};

/// Shared between the stdout task, which registers requests, and [`Session`],
/// which answers them.
///
/// A blocking `Mutex` rather than tokio's: the mapper registers entries from
/// inside a synchronous `map`, and every critical section here is a hash lookup
/// with no await in it.
///
/// (crate::session::Session)
pub type PendingPermissions = Arc<Mutex<HashMap<String, PendingRequest>>>;

/// One unanswered request, held from the moment it is parsed until a reply goes
/// out. Dropping an entry without replying leaves the CLI waiting.
#[derive(Debug, Clone)]
pub struct PendingRequest {
    pub tool_use_id: String,
    pub tool_name: String,
    /// The call's arguments, echoed back on an allow. Never edited — a host may
    /// rewrite them here, and nothing in this app does. `Null` for a harness
    /// that rebuilds nothing from the answer, which Codex does not.
    pub input: Value,
    /// Keyed by [`PermissionOption::id`].
    pub options: HashMap<String, ResolvedOption>,
    /// The JSON-RPC id the answer has to name, for a harness that asked as a
    /// peer rather than over a control channel.
    ///
    /// `None` is Claude Code, whose reply is a `control_response` addressed by
    /// the request id this entry is filed under. Held here rather than worked
    /// out at reply time because only the reader that took the request knows
    /// it — and an answer aimed at the wrong id is ignored in silence on both
    /// protocols.
    pub rpc_id: Option<i64>,
    /// pi's dialog method (`select`, `confirm`, `input`), for a request an
    /// *extension* asked rather than a permission gate.
    ///
    /// Held because pi has no one verdict envelope: each dialog is answered in
    /// its own shape, and `confirm` reads a different field from the other two.
    /// The id the answer names is the request id this entry is already filed
    /// under, so only the method has to be remembered.
    ///
    /// `None` for both other harnesses, and a pi permission gate — should one
    /// ever exist — would set it too, because what varies is the reply shape and
    /// not who asked.
    pub pi_dialog_method: Option<String>,
}

/// A button, plus the wire payload picking it sends.
///
/// The two payload fields are one per harness and exactly one is ever set:
/// Claude composes a verdict out of `updates` at reply time, where Codex was
/// handed its answer by the server and carries it back whole.
#[derive(Debug, Clone)]
pub struct ResolvedOption {
    pub option: PermissionOption,
    pub updates: Vec<PermissionUpdate>,
    /// Codex's own decision value, echoed back untouched.
    pub decision: Option<Value>,
}

impl PendingRequest {
    /// Builds the entry and the option list in one pass, so what the user is
    /// offered and what the app can honour cannot drift apart.
    pub fn new(request: &PermissionRequest) -> (Self, Vec<PermissionOption>) {
        let resolved = build_options(request);
        let offered = resolved.iter().map(|r| r.option.clone()).collect();

        let options = resolved
            .into_iter()
            .map(|r| (r.option.id.clone(), r))
            .collect();

        let pending = Self {
            tool_use_id: request.tool_use_id.clone(),
            tool_name: request.tool_name.clone(),
            input: request.input.clone(),
            options,
            // Claude answers on the control channel, addressed by the request
            // id this entry is already filed under.
            rpc_id: None,
            pi_dialog_method: None,
        };

        (pending, offered)
    }

    /// A request answered by a filled-in form rather than a button, so it holds
    /// no options: nothing the frontend can send resolves to a rule, and the
    /// standing-rule suggestions the CLI attaches would grant a *tool* the user
    /// was never asked about.
    pub fn for_questions(request: &PermissionRequest) -> Self {
        Self {
            tool_use_id: request.tool_use_id.clone(),
            tool_name: request.tool_name.clone(),
            input: request.input.clone(),
            options: HashMap::new(),
            rpc_id: None,
            pi_dialog_method: None,
        }
    }
}

/// Allow-once first, deny last, and whatever standing rules this particular call
/// could establish in between.
///
/// A suggestion is only rendered when its effect can be stated in the label. The
/// CLI's set is open-ended and a button whose consequence the user can't read is
/// worse than one button fewer, so unmapped kinds — the `remove*` and `replace*`
/// families, none of which a permission prompt has been seen to suggest — are
/// dropped rather than shown generically.
fn build_options(request: &PermissionRequest) -> Vec<ResolvedOption> {
    let mut options = vec![ResolvedOption {
        option: PermissionOption {
            id: "once".to_string(),
            label: "Allow once".to_string(),
            kind: PermissionOptionKind::Once,
            behavior: PermissionBehavior::Allow,
        },
        updates: Vec::new(),
        decision: None,
    }];

    for (index, suggestion) in request.permission_suggestions.iter().enumerate() {
        let (label, kind, behavior) = match suggestion {
            // Suppressed when the rule would be broader than the ask: the CLI
            // sets this where the rule it can compose covers the whole tool but
            // the question was about one verb, so "always allow" would grant
            // more than it says.
            PermissionUpdate::AddRules {
                rules, behavior, ..
            } if !request.suppress_always_allow_rule => {
                let Some(rule) = rules.first() else { continue };
                let subject = rule
                    .rule_content
                    .clone()
                    .unwrap_or_else(|| format!("all {} calls", rule.tool_name));

                let allow = behavior == "allow";
                (
                    format!("{} {subject}", if allow { "Always allow" } else { "Always deny" }),
                    PermissionOptionKind::AlwaysRule,
                    if allow {
                        PermissionBehavior::Allow
                    } else {
                        PermissionBehavior::Deny
                    },
                )
            }

            PermissionUpdate::AddDirectories { directories, .. } => {
                let Some(dir) = directories.first() else {
                    continue;
                };
                (
                    format!("Always allow in {dir}"),
                    PermissionOptionKind::AlwaysDirectory,
                    PermissionBehavior::Allow,
                )
            }

            PermissionUpdate::SetMode { mode, .. } => (
                mode_label(mode),
                PermissionOptionKind::SwitchMode,
                PermissionBehavior::Allow,
            ),

            _ => continue,
        };

        options.push(ResolvedOption {
            option: PermissionOption {
                // Positional rather than derived from the rule: two suggestions
                // can propose the same rule at different destinations, and the
                // id only has to be unique within this request.
                id: format!("suggestion_{index}"),
                label,
                kind,
                behavior,
            },
            updates: vec![suggestion.clone()],
            decision: None,
        });
    }

    options.push(ResolvedOption {
        option: PermissionOption {
            id: "deny".to_string(),
            label: "Deny".to_string(),
            kind: PermissionOptionKind::Deny,
            behavior: PermissionBehavior::Deny,
        },
        updates: Vec::new(),
        decision: None,
    });

    options
}

/// Named where the mode is one this app offers, and described generically
/// otherwise — the CLI's mode set is wider than [`ApprovalPolicy`] and grows.
///
/// (crate::events::ApprovalPolicy)
fn mode_label(mode: &str) -> String {
    match mode {
        "acceptEdits" => "Accept all edits this session".to_string(),
        "bypassPermissions" => "Stop asking this session".to_string(),
        "plan" => "Switch to plan mode".to_string(),
        "dontAsk" => "Don't ask again this session".to_string(),
        other => format!("Switch to {other} mode"),
    }
}

/// The reply the CLI is waiting on.
///
/// The envelope double-wraps `response` — the outer one is the control-protocol
/// verdict, the inner the permission decision — and the CLI ignores a reply
/// shaped any other way, silently, until its own deadline denies the call.
pub fn decision_response(
    request_id: &str,
    pending: &PendingRequest,
    chosen: &ResolvedOption,
) -> Value {
    let mut decision = match chosen.option.behavior {
        PermissionBehavior::Allow => json!({
            "behavior": "allow",
            "updatedInput": pending.input,
        }),
        PermissionBehavior::Deny => json!({
            "behavior": "deny",
            "message": format!("The user denied permission to use {}.", pending.tool_name),
        }),
    };

    decision["toolUseID"] = json!(pending.tool_use_id);
    if !chosen.updates.is_empty() {
        decision["updatedPermissions"] = json!(chosen.updates);
    }

    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": decision,
        },
    })
}

/// The reply to an `AskUserQuestion`, whose verdict is always *allow*: the call
/// is never in question, only what it should return.
///
/// The answers ride inside the tool's own input, keyed by each question's
/// verbatim text — the harness matches on the string, so a key it doesn't
/// recognize is silently no answer at all. Everything else about the input is
/// echoed back untouched, since the harness reads its own `questions` array out
/// of the same object to build the tool result.
///
/// An unanswered question is simply absent. That is what makes skipping a real
/// answer rather than a refusal: the harness honours a partial map, and reports
/// "the user did not answer" only for an empty one.
pub fn answer_response(
    request_id: &str,
    pending: &PendingRequest,
    answers: &HashMap<String, String>,
) -> Value {
    let mut input = pending.input.clone();
    // Only reachable for input that parsed as questions, so it is an object —
    // but a non-object still has to produce a reply rather than none.
    if let Some(object) = input.as_object_mut() {
        object.insert("answers".to_string(), json!(answers));
    }

    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": "allow",
                "updatedInput": input,
                "toolUseID": pending.tool_use_id,
            },
        },
    })
}

/// Refuses a request this build can't put to the user. Sent for a control
/// request subtype we don't model: the CLI blocks until answered, so staying
/// silent would hang the turn on a line we already know we can't act on.
pub fn auto_deny_response(request_id: &str, reason: &str) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {"behavior": "deny", "message": reason},
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::claude_code::parser::PermissionRule;

    fn request_with(suggestions: Vec<PermissionUpdate>) -> PermissionRequest {
        PermissionRequest {
            tool_name: "Bash".to_string(),
            input: json!({"command": "touch ./marker.txt"}),
            tool_use_id: "toolu_1".to_string(),
            permission_suggestions: suggestions,
            blocked_path: None,
            decision_reason: None,
            decision_reason_type: None,
            classifier_approvable: None,
            suppress_always_allow_rule: false,
            requires_user_interaction: false,
            title: None,
            display_name: None,
            description: None,
            agent_id: None,
        }
    }

    #[test]
    fn always_offers_once_and_deny_around_the_suggestions() {
        let (_, options) = PendingRequest::new(&request_with(Vec::new()));

        assert_eq!(options.len(), 2);
        assert_eq!(options[0].kind, PermissionOptionKind::Once);
        assert_eq!(options[1].kind, PermissionOptionKind::Deny);
    }

    /// The exact suggestion set a `touch` under `manual` produced, so the labels
    /// are pinned against real CLI output rather than an invented shape.
    #[test]
    fn builds_a_button_per_supported_suggestion() {
        let (_, options) = PendingRequest::new(&request_with(vec![
            PermissionUpdate::AddRules {
                rules: vec![PermissionRule {
                    tool_name: "Bash".to_string(),
                    rule_content: Some("touch ./marker.txt".to_string()),
                }],
                behavior: "allow".to_string(),
                destination: "localSettings".to_string(),
            },
            PermissionUpdate::AddDirectories {
                directories: vec!["/tmp/proj".to_string()],
                destination: "session".to_string(),
            },
            PermissionUpdate::SetMode {
                mode: "acceptEdits".to_string(),
                destination: "session".to_string(),
            },
        ]));

        let labels: Vec<_> = options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "Allow once",
                "Always allow touch ./marker.txt",
                "Always allow in /tmp/proj",
                "Accept all edits this session",
                "Deny",
            ]
        );
    }

    /// The flag exists precisely because the composable rule is broader than the
    /// question, so the rule button has to go while the rest stay.
    #[test]
    fn suppresses_the_always_allow_rule_when_the_cli_asks_it_to() {
        let mut request = request_with(vec![
            PermissionUpdate::AddRules {
                rules: vec![PermissionRule {
                    tool_name: "Bash".to_string(),
                    rule_content: Some("rm -rf /".to_string()),
                }],
                behavior: "allow".to_string(),
                destination: "localSettings".to_string(),
            },
            PermissionUpdate::SetMode {
                mode: "acceptEdits".to_string(),
                destination: "session".to_string(),
            },
        ]);
        request.suppress_always_allow_rule = true;

        let (_, options) = PendingRequest::new(&request);

        assert!(!options
            .iter()
            .any(|o| o.kind == PermissionOptionKind::AlwaysRule));
        assert!(options
            .iter()
            .any(|o| o.kind == PermissionOptionKind::SwitchMode));
    }

    /// Pins the double-wrapped envelope: the CLI ignores anything else without
    /// complaint, so a shape regression would present as a hung turn.
    #[test]
    fn allow_carries_the_input_back_and_the_rule_alongside() {
        let suggestion = PermissionUpdate::AddRules {
            rules: vec![PermissionRule {
                tool_name: "Bash".to_string(),
                rule_content: Some("touch ./marker.txt".to_string()),
            }],
            behavior: "allow".to_string(),
            destination: "localSettings".to_string(),
        };
        let (pending, _) = PendingRequest::new(&request_with(vec![suggestion]));
        let chosen = &pending.options["suggestion_0"];

        let response = decision_response("req_1", &pending, chosen);
        let inner = &response["response"]["response"];

        assert_eq!(response["type"], "control_response");
        assert_eq!(response["response"]["subtype"], "success");
        assert_eq!(response["response"]["request_id"], "req_1");
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["toolUseID"], "toolu_1");
        assert_eq!(inner["updatedInput"]["command"], "touch ./marker.txt");
        assert_eq!(inner["updatedPermissions"][0]["type"], "addRules");
        assert_eq!(
            inner["updatedPermissions"][0]["rules"][0]["toolName"],
            "Bash"
        );
    }

    /// Pins the two facts a working answer depends on, both verified against the
    /// CLI: the verdict is an allow, and the answers ride *inside* the tool's own
    /// input keyed by the question's verbatim text. Send them anywhere else and
    /// the call runs reporting that nobody answered.
    #[test]
    fn an_answer_rides_back_inside_the_tools_own_input() {
        let mut request = request_with(Vec::new());
        request.tool_name = "AskUserQuestion".to_string();
        request.input = json!({
            "questions": [{"question": "Tabs or spaces?", "header": "Indentation",
                           "options": [{"label": "Tabs"}, {"label": "Spaces"}],
                           "multiSelect": false}]
        });
        let pending = PendingRequest::for_questions(&request);

        let answers = HashMap::from([("Tabs or spaces?".to_string(), "Tabs".to_string())]);
        let inner = answer_response("req_1", &pending, &answers)["response"]["response"].clone();

        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["toolUseID"], "toolu_1");
        assert_eq!(inner["updatedInput"]["answers"]["Tabs or spaces?"], "Tabs");
        // Echoed untouched: the harness rebuilds the tool result from this same
        // object, so a dropped `questions` array loses what was asked.
        assert_eq!(
            inner["updatedInput"]["questions"][0]["question"],
            "Tabs or spaces?"
        );
    }

    /// Skipping everything is still an allow. Denying instead would report a
    /// refused tool call, which is not what happened.
    #[test]
    fn skipping_every_question_still_allows_the_call() {
        let mut request = request_with(Vec::new());
        request.tool_name = "AskUserQuestion".to_string();
        request.input = json!({"questions": []});
        let pending = PendingRequest::for_questions(&request);

        let inner =
            answer_response("req_1", &pending, &HashMap::new())["response"]["response"].clone();

        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["updatedInput"]["answers"], json!({}));
    }

    #[test]
    fn deny_sends_a_message_and_no_permission_updates() {
        let (pending, _) = PendingRequest::new(&request_with(Vec::new()));
        let chosen = &pending.options["deny"];

        let inner = decision_response("req_1", &pending, chosen)["response"]["response"].clone();

        assert_eq!(inner["behavior"], "deny");
        assert!(inner["message"].as_str().unwrap().contains("Bash"));
        assert!(inner.get("updatedPermissions").is_none());
    }
}
