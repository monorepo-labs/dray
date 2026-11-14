//! A bot's ways to end a turn without a reply: saying nothing, or reacting to
//! the user's message with an emoji.
//!
//! Claude Code re-prompts a turn that ends with no text ("[Your previous
//! response had no visible output…]"), which forced a bot told to stay silent
//! into writing filler — often a lone zero-width space. The CLI skips that
//! nudge when the turn's last tool call is one named in
//! `CLAUDE_CODE_TERMINAL_MCP_TOOLS` (v2.1.323, a comma list), so bots get two
//! such tools, served in process as an SDK MCP server: the CLI sends each
//! JSON-RPC message as a `control_request`/`mcp_message` and Dray answers on
//! the same pipe.

use serde_json::{json, Value};

const SERVER: &str = "dray";
const TOOL: &str = "no_reply_needed";
const REACT: &str = "react";
/// The name the model and `CLAUDE_CODE_TERMINAL_MCP_TOOLS` know it by.
pub const TOOL_NAME: &str = "mcp__dray__no_reply_needed";
pub const REACT_NAME: &str = "mcp__dray__react";
/// Both tools, for `--allowedTools` and [`TERMINAL_TOOLS_ENV`].
pub const TOOL_NAMES: &str = "mcp__dray__no_reply_needed,mcp__dray__react";
/// The env var that exempts a turn ending on one of [`TOOL_NAMES`] from the nudge.
pub const TERMINAL_TOOLS_ENV: &str = "CLAUDE_CODE_TERMINAL_MCP_TOOLS";

/// `--mcp-config` declaring the in-process server.
pub fn mcp_config() -> String {
    json!({"mcpServers": {SERVER: {"type": "sdk", "name": SERVER}}}).to_string()
}

/// The emoji a `tools/call` of `react` asks for, or `None` for any other
/// message. That call needs the session's log, so the read loop answers it
/// through [`react_response`] instead of [`response`].
pub fn reaction_asked(message: &Value) -> Option<String> {
    let params = &message["params"];
    let asked = message["method"] == "tools/call" && params["name"] == REACT && !message["id"].is_null();
    asked.then(|| params["arguments"]["emoji"].as_str().unwrap_or_default().to_string())
}

/// The answer to a `react` call: the emoji it put on the user's message, or
/// why it could not.
pub fn react_response(request_id: &str, message: &Value, reacted: Result<&str, String>) -> Value {
    let result = match reacted {
        Ok(emoji) => json!({"content": [{
            "type": "text",
            "text": format!("Reacted {emoji} to the user's message. The turn is closed with no reply; write nothing."),
        }]}),
        Err(why) => json!({"isError": true, "content": [{"type": "text", "text": format!("No reaction: {why}")}]}),
    };
    envelope(request_id, message, Ok(result))
}

/// The `control_response` answering one `mcp_message`. A notification has no
/// id and gets an empty result, which the CLI only acknowledges.
pub fn response(request_id: &str, message: &Value) -> Value {
    let id = message.get("id").filter(|id| !id.is_null());
    let result = match message.get("method").and_then(Value::as_str) {
        _ if id.is_none() => Ok(json!({})),
        Some("initialize") => Ok(json!({
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER, "version": env!("CARGO_PKG_VERSION")},
        })),
        // Loaded up front rather than behind ToolSearch, a hop the bot would
        // otherwise take on every silent turn.
        Some("tools/list") => Ok(json!({"tools": [
            {
                "name": TOOL,
                "description": "Ends your turn with no reply. Call it once, when a message needs nothing from the user; its result closes the turn, so write nothing and call nothing after it.",
                "inputSchema": {"type": "object", "properties": {}},
                "_meta": {"anthropic/alwaysLoad": true},
            },
            {
                "name": REACT,
                "description": "Reacts to the user's newest message with an emoji instead of replying, and ends your turn with no reply: 👍 got it (an ok or go-ahead), 👀 looking into it (investigating or checking), ✅ done, 🎉 celebrate, ❤️ thanks, 😂 funny, 😢 sorry to hear. Never react to starting or messaging a task: the chat already shows that row. Call it once; its result closes the turn, so write nothing and call nothing after it.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"emoji": {"type": "string", "enum": crate::bots::react::EMOJI.map(|(e, _)| e)}},
                    "required": ["emoji"],
                },
                "_meta": {"anthropic/alwaysLoad": true},
            },
        ]})),
        Some("tools/call") => Ok(json!({"content": [{
            "type": "text",
            "text": "Done: the turn is closed with no reply. Do not call this again; write nothing.",
        }]})),
        _ => Err(json!({"code": -32601, "message": "method not found"})),
    };
    envelope(request_id, message, result)
}

/// `result` as the JSON-RPC reply to `message`, inside its `control_response`.
fn envelope(request_id: &str, message: &Value, result: Result<Value, Value>) -> Value {
    let mut reply = match result {
        Ok(result) => json!({"jsonrpc": "2.0", "result": result}),
        Err(error) => json!({"jsonrpc": "2.0", "error": error}),
    };
    if let Some(id) = message.get("id").filter(|id| !id.is_null()) {
        reply["id"] = id.clone();
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
    fn serves_both_tools_through_a_handshake() {
        let init = reply(json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}));
        assert_eq!(init["id"], 0);
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");

        let list = reply(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}));
        assert_eq!(list["result"]["tools"][0]["name"], TOOL);
        assert_eq!(list["result"]["tools"][1]["name"], REACT);
        let offered = &list["result"]["tools"][1]["inputSchema"]["properties"]["emoji"]["enum"];
        assert_eq!(offered.as_array().map(Vec::len), Some(7));
        assert_eq!(offered[4], "❤️");
        assert_eq!(format!("mcp__{SERVER}__{TOOL}"), TOOL_NAME);
        assert_eq!(format!("mcp__{SERVER}__{REACT}"), REACT_NAME);
        assert_eq!(TOOL_NAMES, format!("{TOOL_NAME},{REACT_NAME}"));

        let call = reply(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": TOOL, "arguments": {}}}));
        assert_eq!(call["id"], 2);
        assert_eq!(call["result"]["content"][0]["type"], "text");
    }

    #[test]
    fn a_react_call_is_answered_with_what_it_did() {
        let call = json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": REACT, "arguments": {"emoji": "🎉"}}});
        assert_eq!(reaction_asked(&call).as_deref(), Some("🎉"));
        let silent = json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": TOOL, "arguments": {}}});
        assert_eq!(reaction_asked(&silent), None);

        let mcp = |reacted| react_response("r1", &call, reacted)["response"]["response"]["mcp_response"].clone();
        let done = mcp(Ok("🎉"));
        assert_eq!(done["id"], 4);
        assert!(done["result"]["content"][0]["text"].as_str().unwrap().contains("🎉"));
        assert_eq!(mcp(Err("no message".into()))["result"]["isError"], true);
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
