//! Codex's approval requests onto Dray's permission card.
//!
//! The same bargain [`claude_code::permissions`](crate::harness::claude_code::permissions)
//! makes, and for the same reason: **the options are the server's, not ours**.
//! Codex names what it will accept in `availableDecisions`, and each button
//! carries that value back untouched — so a decision Dray never has to compose
//! is one it can never compose wrongly.
//!
//! What differs is the reply. Claude answers a `control_request` with a
//! double-wrapped verdict; Codex answers a JSON-RPC request with
//! `{"decision": …}` against the id it asked on.

use crate::events::{PermissionBehavior, PermissionOption, PermissionOptionKind};
use crate::harness::claude_code::permissions::{PendingRequest, Reply, ResolvedOption};
use serde_json::Value;

use super::parser::ApprovalRequest;

/// Which of the two approval requests this is, which is all the card needs to
/// name the call in a sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApprovalKind {
    /// The tool name the transcript already drew this call under, so the card
    /// and the row agree about what is being asked for.
    pub tool_name: &'static str,
    pub display_name: &'static str,
}

impl ApprovalKind {
    pub const COMMAND: Self = Self { tool_name: "shell", display_name: "Shell" };
    pub const FILE_CHANGE: Self = Self { tool_name: "apply_patch", display_name: "Edit" };
}

/// Builds the held request and the buttons for it in one pass, so what the user
/// is offered and what can be sent back cannot drift apart.
pub fn pending_for(
    request: &ApprovalRequest,
    kind: ApprovalKind,
    rpc_id: i64,
) -> (PendingRequest, Vec<PermissionOption>) {
    let resolved = build_options(request);
    let offered = resolved.iter().map(|r| r.option.clone()).collect();

    let options = resolved
        .into_iter()
        .map(|r| (r.option.id.clone(), r))
        .collect();

    let pending = PendingRequest {
        tool_use_id: request.item_id.clone(),
        tool_name: kind.tool_name.to_string(),
        // Codex rebuilds nothing from what we send back — the answer is the
        // decision alone — so there is no input to echo.
        input: Value::Null,
        options,
        reply: Reply::Rpc(rpc_id),
    };

    (pending, offered)
}

/// One button per decision the server offered, in the order the card reads:
/// allow first, standing grants in the middle, refusal last.
///
/// A decision this build cannot put into words is **dropped** rather than drawn
/// generically — the rule the Claude side already follows, and the reason the
/// wire value is carried rather than reconstructed.
fn build_options(request: &ApprovalRequest) -> Vec<ResolvedOption> {
    let mut options: Vec<ResolvedOption> = Vec::new();

    for decision in &request.available_decisions {
        let Some((label, kind, behavior)) = describe(decision, request) else {
            continue;
        };

        options.push(ResolvedOption {
            option: PermissionOption {
                id: format!("codex-{}", options.len()),
                label,
                kind,
                behavior,
            },
            updates: Vec::new(),
            decision: Some(decision.clone()),
        });
    }

    options.sort_by_key(|o| order(o.option.kind));

    // A card with no way to say no cannot be answered honestly, and the server
    // has offered lists without one. `decline` is in both decision enums, so it
    // is always a legal answer even where it was not named.
    if !options
        .iter()
        .any(|o| o.option.behavior == PermissionBehavior::Deny)
    {
        options.push(ResolvedOption {
            option: PermissionOption {
                id: format!("codex-{}", options.len()),
                label: "Deny".to_string(),
                kind: PermissionOptionKind::Deny,
                behavior: PermissionBehavior::Deny,
            },
            updates: Vec::new(),
            decision: Some(Value::String("decline".to_string())),
        });
    }

    options
}

/// What a decision does, said plainly enough to put on a button.
fn describe(
    decision: &Value,
    request: &ApprovalRequest,
) -> Option<(String, PermissionOptionKind, PermissionBehavior)> {
    use PermissionBehavior::{Allow, Deny};
    use PermissionOptionKind as Kind;

    if let Some(name) = decision.as_str() {
        return match name {
            "accept" => Some(("Allow once".to_string(), Kind::Once, Allow)),
            "acceptForSession" => Some((
                "Allow for this session".to_string(),
                Kind::AlwaysRule,
                Allow,
            )),
            // Two refusals, and the difference is worth a reader's attention:
            // one answers the model, the other ends the turn.
            "decline" => Some(("Deny".to_string(), Kind::Deny, Deny)),
            "cancel" => Some(("Stop the turn".to_string(), Kind::Deny, Deny)),
            _ => None,
        };
    }

    // The object forms carry the rule they would establish, which is what makes
    // them statable at all.
    let (name, body) = decision.as_object()?.iter().next()?;
    match name.as_str() {
        "acceptWithExecpolicyAmendment" => {
            // The whole command, not the amendment's argv: the reader is
            // agreeing to what they can see on the row above.
            let what = request.command.as_deref().unwrap_or("this command");
            Some((
                format!("Always allow {}", first_line(what)),
                Kind::AlwaysRule,
                Allow,
            ))
        }
        "applyNetworkPolicyAmendment" => {
            let host = body
                .get("network_policy_amendment")
                .and_then(|a| a.get("host"))
                .and_then(Value::as_str)?;
            Some((format!("Always allow {host}"), Kind::AlwaysRule, Allow))
        }
        _ => None,
    }
}

/// Allow first, standing grants next, refusal last — the order every permission
/// card in this app reads in.
fn order(kind: PermissionOptionKind) -> u8 {
    match kind {
        PermissionOptionKind::Once => 0,
        PermissionOptionKind::AlwaysRule
        | PermissionOptionKind::AlwaysDirectory
        | PermissionOptionKind::SwitchMode => 1,
        PermissionOptionKind::Deny => 2,
    }
}

/// A label is one line. A shell command is often several, and the rest of it is
/// on the row above anyway.
fn first_line(command: &str) -> String {
    let line = command.lines().next().unwrap_or(command).trim();
    if line.chars().count() > 40 {
        let cut: String = line.chars().take(39).collect();
        format!("{cut}…")
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request_offering(decisions: Value) -> ApprovalRequest {
        ApprovalRequest {
            item_id: "exec-1".to_string(),
            command: Some("printf 'hello' > notes.txt".to_string()),
            available_decisions: decisions.as_array().unwrap().clone(),
            ..Default::default()
        }
    }

    /// The real capture, which is the case worth pinning: this request offered
    /// no `decline` at all, so a card built only from what was named would have
    /// had no way to refuse.
    #[test]
    fn the_captured_request_gets_a_refusal_it_was_not_offered() {
        let request = request_offering(json!([
            "accept",
            {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["/bin/zsh", "-lc", "printf"]}},
            "cancel"
        ]));

        let (pending, offered) = pending_for(&request, ApprovalKind::COMMAND, 7);

        let labels: Vec<&str> = offered.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Allow once",
                "Always allow printf 'hello' > notes.txt",
                "Stop the turn",
            ]
        );
        assert!(offered
            .iter()
            .any(|o| o.behavior == PermissionBehavior::Deny));
        assert_eq!(pending.reply, Reply::Rpc(7));
        assert_eq!(pending.tool_use_id, "exec-1");
    }

    /// The value goes back exactly as it arrived. Retyping an amendment is the
    /// one way this could grant something the server never offered.
    #[test]
    fn a_button_carries_the_servers_own_decision() {
        let amendment = json!({"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["/bin/zsh"]}});
        let request = request_offering(json!(["accept", amendment.clone(), "decline"]));

        let (pending, offered) = pending_for(&request, ApprovalKind::COMMAND, 1);
        let always = offered
            .iter()
            .find(|o| o.kind == PermissionOptionKind::AlwaysRule)
            .expect("the amendment is offered");

        assert_eq!(
            pending.options[&always.id].decision.as_ref().unwrap(),
            &amendment
        );
    }

    /// A decision whose effect cannot be stated is dropped, not drawn as a
    /// button nobody can predict.
    #[test]
    fn an_unstatable_decision_is_dropped() {
        let request = request_offering(json!([
            "accept",
            {"somethingNewEntirely": {}},
            {"applyNetworkPolicyAmendment": {"network_policy_amendment": {"host": "example.com", "action": "allow"}}},
            "decline"
        ]));

        let (_, offered) = pending_for(&request, ApprovalKind::COMMAND, 1);
        let labels: Vec<&str> = offered.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Allow once", "Always allow example.com", "Deny"]
        );
    }

    /// A file change carries no command, so the amendment label has nothing to
    /// name — and the request kind is what the card says instead.
    #[test]
    fn a_file_change_names_its_own_tool() {
        let request = ApprovalRequest {
            item_id: "patch-1".to_string(),
            available_decisions: vec![json!("accept"), json!("decline")],
            ..Default::default()
        };

        let (pending, _) = pending_for(&request, ApprovalKind::FILE_CHANGE, 2);
        assert_eq!(pending.tool_name, "apply_patch");
    }
}
