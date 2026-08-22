//! Per-harness integrations. Each CLI gets a directory with two stages:
//! `parser.rs` (wire format → its own typed events) and `mapper.rs` (those →
//! [`AgentEvent`](crate::events::AgentEvent)). A wire-format change then touches
//! only the parser, a vocabulary change only the mapper.

#[path = "claude_code/claude_code.rs"]
pub mod claude_code;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum Harness {
    ClaudeCode,
    Codex,
}
