//! A subagent's conversation, read back out of fx's own session store.
//!
//! Nothing about an fx child streams over ACP, so the only account of what it
//! did is `fx session <id>/<agent> --json`, which saves a turn once it ends.
//! Read on demand by the subagent tab, never logged: fx keeps the copy.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::process::Command;

use super::mapper::{tool_input, tool_type};
use crate::events::{AgentEvent, AgentEventPayload, ToolResult};
use crate::harness::acp::ToolKind;
use crate::harness::Harness;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

/// The child `agent` of the fx session behind our `session_id`, as events the
/// transcript already knows how to draw.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fx_subagent_events(session_id: String, agent: String) -> Result<Vec<AgentEvent>, crate::Fail> {
    Ok(read(session_id, agent).await?)
}

async fn read(session_id: String, agent: String) -> Result<Vec<AgentEvent>> {
    let item = crate::store::get_session_index_item(&session_id)
        .await?
        .context("This session is gone.")?;
    // fx mints its own id; ours is only its key where it never answered one.
    let thread = item.thread_id.unwrap_or_else(|| session_id.clone());
    let bin = crate::binpath::fx().await;
    let output = tokio::time::timeout(
        READ_TIMEOUT,
        Command::new(&bin)
            .args(["session", &format!("{thread}/{agent}"), "--json"])
            .current_dir(&item.cwd)
            .env("PATH", crate::harness::agent_path(&bin))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("fx took too long to read the subagent")?
    .context("couldn't run fx to read the subagent")?;
    if !output.status.success() {
        let why = String::from_utf8_lossy(&output.stderr);
        // fx saves a turn once it ends, so a child on its first one has nothing yet.
        anyhow::bail!("fx has nothing saved for {agent} yet. {}", why.trim());
    }
    let detail: Value = serde_json::from_slice(&output.stdout).context("fx answered with something else")?;
    Ok(history_events(&session_id, &detail))
}

/// `session_detail.history` onto events: each message the child was sent, then
/// each step's text and tool calls, then its answer.
fn history_events(session_id: &str, detail: &Value) -> Vec<AgentEvent> {
    let mut out = Vec::new();
    let mut push = |payload: AgentEventPayload| {
        let seq = out.len() as u64;
        out.push(AgentEvent::mint(session_id.to_string(), Harness::Fx, seq, None, None, payload));
    };
    let text = |s: &str| AgentEventPayload::AssistantText { block: None, text: s.to_string() };
    for turn in detail["history"].as_array().into_iter().flatten() {
        if let Some(prompt) = turn["user"]["text"].as_str().filter(|s| !s.is_empty()) {
            // Every other field defaults; built through serde so this does not
            // have to name them all.
            if let Ok(p) = serde_json::from_value(json!({ "type": "user_message", "text": prompt })) {
                push(p);
            }
        }
        for step in turn["execution"]["tool_steps"].as_array().into_iter().flatten() {
            if let Some(said) = step["assistant"].as_str().filter(|s| !s.trim().is_empty()) {
                push(text(said));
            }
            for call in step["tool_calls"].as_array().into_iter().flatten() {
                let id = call["id"].as_str().unwrap_or_default().to_string();
                let name = call["name"].as_str().unwrap_or("tool").to_string();
                let kind = kind_of(&name);
                let raw = call["arguments_json"].as_str().and_then(|s| serde_json::from_str(s).ok());
                push(AgentEventPayload::ToolCallStarted {
                    call_id: id.clone(),
                    tool_type: tool_type(kind, &name),
                    input: tool_input(kind, raw),
                    name,
                    raw_input: None,
                    title: None,
                });
                let result = step["tool_results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|r| r["tool_call_id"].as_str() == Some(id.as_str()));
                if let Some(result) = result {
                    push(AgentEventPayload::ToolCallCompleted { call_id: id, result: tool_result(kind, result) });
                }
            }
        }
        if let Some(answer) = turn["assistant"].as_str().filter(|s| !s.trim().is_empty()) {
            push(text(answer));
        }
    }
    out
}

/// The ACP kind fx gives each of its tools on the live wire, which the saved
/// history leaves out. Read off the captures; an unknown name is `Other`.
fn kind_of(name: &str) -> ToolKind {
    match name {
        "shell" => ToolKind::Execute,
        "read_file" | "glob_files" => ToolKind::Read,
        "edit_file" | "write_file" => ToolKind::Edit,
        "grep_files" => ToolKind::Search,
        "web_fetch" => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

/// A saved result. A shell's is fx's own envelope with the output inside it.
fn tool_result(kind: ToolKind, result: &Value) -> ToolResult {
    let output = result["output"].as_str().or(result["preview"].as_str()).unwrap_or_default();
    let shell: Option<Value> = (kind == ToolKind::Execute).then(|| serde_json::from_str(output).ok()).flatten();
    let text = shell
        .as_ref()
        .and_then(|s| s["output_delta"].as_str())
        .unwrap_or(output)
        .to_string();
    ToolResult {
        text,
        is_error: result["status"].as_str().is_some_and(|s| s != "success"),
        structured: None,
        exit_code: shell.as_ref().and_then(|s| s["exit_code"].as_i64()).map(|c| c as i32),
        duration_ms: shell.as_ref().and_then(|s| s["duration_ms"].as_u64()),
        images: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// fx 0.0.17, `fx session <id>/worker --json` after the child listed a
    /// directory and read a file (`subagent_background.jsonl` is its parent).
    #[test]
    fn reads_a_saved_child() {
        let detail: Value = serde_json::from_str(include_str!("fixtures/subagent_history.json")).unwrap();
        let events = history_events("s", &detail);
        let kinds: Vec<&str> = events
            .iter()
            .map(|e| match &e.payload {
                AgentEventPayload::UserMessage { .. } => "user",
                AgentEventPayload::AssistantText { .. } => "text",
                AgentEventPayload::ToolCallStarted { .. } => "call",
                AgentEventPayload::ToolCallCompleted { .. } => "result",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, ["user", "text", "call", "result", "call", "result", "text"]);
        let AgentEventPayload::ToolCallStarted { tool_type, input, .. } = &events[2].payload else { panic!() };
        assert_eq!(*tool_type, crate::events::ToolType::Shell);
        assert_eq!(input, &json!({ "command": "ls -la" }));
        let AgentEventPayload::ToolCallCompleted { result, .. } = &events[3].payload else { panic!() };
        assert!(result.text.starts_with("total 8\n"), "{}", result.text);
        assert_eq!(result.exit_code, Some(0));
        let AgentEventPayload::AssistantText { text, .. } = &events[6].payload else { panic!() };
        assert_eq!(text, "alpha line one");
    }
}
