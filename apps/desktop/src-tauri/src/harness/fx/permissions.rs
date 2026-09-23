//! fx's `session/request_permission` onto Dray's permission card, through
//! [`acp::pending_for`].

use crate::events::PermissionOption;
use crate::harness::acp;
use crate::harness::claude_code::permissions::PendingRequest;

use super::parser::PermissionRequest;

/// Builds the held request and its buttons in one pass.
pub fn pending_for(request: &PermissionRequest, rpc_id: i64) -> (PendingRequest, Vec<PermissionOption>) {
    let call = &request.tool_call;
    acp::pending_for("fx", &call.tool_call_id, call.name.as_deref().unwrap_or("tool"), &request.options, rpc_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::PermissionOptionKind;
    use crate::harness::claude_code::permissions::Reply;
    use crate::harness::fx::parser::{PermissionChoice, ToolCallRef};
    use serde_json::json;

    fn request(kinds: &[(&str, &str)]) -> PermissionRequest {
        PermissionRequest {
            tool_call: ToolCallRef {
                tool_call_id: "call_1".into(),
                name: Some("shell".into()),
                ..Default::default()
            },
            options: kinds
                .iter()
                .map(|(id, kind)| PermissionChoice {
                    option_id: id.to_string(),
                    name: id.replace('_', " "),
                    kind: kind.to_string(),
                })
                .collect(),
        }
    }

    /// The capture's three options, drawn in card order with the server's
    /// ids carried back whole inside the outcome envelope.
    #[test]
    fn the_captured_options_become_three_buttons() {
        let request = request(&[
            ("allow_once", "allow_once"),
            ("allow_always", "allow_always"),
            ("reject_once", "reject_once"),
        ]);
        let (pending, offered) = pending_for(&request, 1);

        let kinds: Vec<PermissionOptionKind> = offered.iter().map(|o| o.kind).collect();
        assert_eq!(
            kinds,
            [
                PermissionOptionKind::Once,
                PermissionOptionKind::AlwaysRule,
                PermissionOptionKind::Deny
            ]
        );
        assert_eq!(pending.reply, Reply::Rpc(1));
        assert_eq!(pending.tool_use_id, "call_1");
        assert_eq!(
            pending.options["fx-allow_once"].decision.as_ref().unwrap(),
            &json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}})
        );
    }

    /// No refusal offered → one is added, as ACP's `cancelled` outcome.
    #[test]
    fn a_request_with_no_refusal_gets_one() {
        let request = request(&[("allow_once", "allow_once"), ("later", "some_new_kind")]);
        let (pending, offered) = pending_for(&request, 2);

        assert_eq!(offered.len(), 2, "the unknown kind is dropped, a Deny is added");
        assert_eq!(
            pending.options["fx-cancelled"].decision.as_ref().unwrap(),
            &json!({"outcome": {"outcome": "cancelled"}})
        );
    }
}
