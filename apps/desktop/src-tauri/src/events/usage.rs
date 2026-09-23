//! Token and cost accounting.
//!
//! The harnesses report disjoint things — Claude Code gives cost in USD, Codex
//! never does — so nearly every field is optional. Show cost only when [`Usage::cost_usd`] is set and a
//! context gauge only when [`Usage::context_window`] is set; neither is
//! universal.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    /// Broken out only by harnesses that report it separately; others fold
    /// thinking tokens into `output_tokens`.
    pub reasoning_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub context_window: Option<ContextWindow>,
    pub model: Option<String>,
    /// Session-cumulative consumption, split by model. Empty on every harness
    /// and every event that doesn't report one. See [`ModelUsage`].
    #[serde(default)]
    pub per_model: Vec<ModelUsage>,
}

/// What one model has consumed **for the session so far** — cumulative and
/// monotonic across turns, not a per-turn figure.
///
/// That is the whole reason it is carried and persisted. [`Usage`]'s own counts
/// are the harness's per-turn sum over every main-thread message, which double
/// counts a context re-read once per tool call and so describes neither the turn
/// nor the context. Here a turn's real consumption is the difference between
/// consecutive readings.
///
/// Every field is optional and the harness's own map is left untyped upstream:
/// this rides `turn_completed`, and a `result` line that fails to parse strands
/// the session on `in_progress`. A shape we don't recognize must cost this
/// struct a field, never the line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// The harness's own key — a dated id (`claude-haiku-4-5-20251001`), not the
    /// alias a session was started with.
    pub model: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub web_search_requests: Option<u64>,
    pub cost_usd: Option<f64>,
    /// This model's context window. Also what the composer's gauge measures
    /// against — see `context_window` in the Claude Code mapper.
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ContextWindow {
    pub used_tokens: u64,
    pub max_tokens: u64,
}
