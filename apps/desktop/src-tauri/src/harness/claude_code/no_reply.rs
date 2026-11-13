//! A bot's way to end a turn without a reply.
//!
//! Claude Code re-prompts a turn that ends with no text ("[Your previous
//! response had no visible output…]"), which forced a bot told to stay silent
//! into writing filler — often a lone zero-width space. The CLI skips that
//! nudge when the turn's last tool call is one named in
//! `CLAUDE_CODE_TERMINAL_MCP_TOOLS` (v2.1.323), so bots get one such tool,
//! served in process as an SDK MCP server: the CLI sends each JSON-RPC message
//! as a `control_request`/`mcp_message` and Dray answers on the same pipe.

use serde_json::{json, Value};

const SERVER: &str = "dray";
const TOOL: &str = "no_reply_needed";
/// The name the model and `CLAUDE_CODE_TERMINAL_MCP_TOOLS` know it by.
pub const TOOL_NAME: &str = "mcp__dray__no_reply_needed";
/// The env var that exempts a turn ending on [`TOOL_NAME`] from the nudge.
pub const TERMINAL_TOOLS_ENV: &str = "CLAUDE_CODE_TERMINAL_MCP_TOOLS";

/// `--mcp-config` declaring the in-process server.
pub fn mcp_config() -> String {
    json!({"mcpServers": {SERVER: {"type": "sdk", "name": SERVER}}}).to_string()
}

/// The `control_response` answering one `mcp_message`. A notification has no
/// id and gets an empty result, which the CLI only acknowledges.
pub fn response(request_id: &str, message: &Value) -> Value {
    let id = message.get("id").cloned().filter(|id| !id.is_null());
    let result = match message.get("method").and_then(Value::as_str) {
        _ if id.is_none() => Ok(json!({})),
        Some("initialize") => Ok(json!({
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER, "version": env!("CARGO_PKG_VERSION")},
        })),
        Some("tools/list") => Ok(json!({"tools": [{
            "name": TOOL,
            "description": "Ends your turn with no reply. Call it once, when a message needs nothing from the user; its result closes the turn, so write nothing and call nothing after it.",
            "inputSchema": {"type": "object", "properties": {}},
            // Loaded up front rather than behind ToolSearch, a hop the bot
            // would otherwise take on every silent turn.
            "_meta": {"anthropic/alwaysLoad": true},
        }]})),
        Some("tools/call") => Ok(json!({"content": [{
            "type": "text",
            "text": "Done: the turn is closed with no reply. Do not call this again; write nothing.",
        }]})),
        _ => Err(json!({"code": -32601, "message": "method not found"})),
    };
    let mut reply = match result {
        Ok(result) => json!({"jsonrpc": "2.0", "result": result}),
        Err(error) => json!({"jsonrpc": "2.0", "error": error}),
    };
    if let Some(id) = id {
        reply["id"] = id;
    }
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {"mcp_response": reply},
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(message: Value) -> Value {
        response("r1", &message)["response"]["response"]["mcp_response"].clone()
    }

    #[test]
    fn serves_the_one_tool_through_a_handshake() {
        let init = reply(json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}));
        assert_eq!(init["id"], 0);
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");

        let list = reply(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}));
        assert_eq!(list["result"]["tools"][0]["name"], TOOL);
        assert_eq!(format!("mcp__{SERVER}__{TOOL}"), TOOL_NAME);

        let call = reply(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": TOOL, "arguments": {}}}));
        assert_eq!(call["id"], 2);
        assert_eq!(call["result"]["content"][0]["type"], "text");
    }

    #[test]
    fn a_notification_is_acknowledged_and_an_unknown_method_refused() {
        let note = reply(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        assert!(note.get("error").is_none() && note.get("id").is_none());

        let other = reply(json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list"}));
        assert_eq!(other["error"]["code"], -32601);
        assert_eq!(response("r9", &json!({}))["response"]["request_id"], "r9");
    }
}
