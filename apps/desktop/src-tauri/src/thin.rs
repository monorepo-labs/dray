//! The first frame of a transcript opened over a slow link: what the newest
//! screen draws, small enough to arrive in one flight.
//!
//! A tail is megabytes of tool output the collapsed transcript never shows —
//! 836KB of JSON, 52KB deflated, for a 100-call turn — all of it read, sent,
//! inflated and parsed twice before the newest screen can paint. And on a
//! direct connection that sat idle TCP slow start delivers a frame that size
//! over about three round trips, where ten segments, the most a sender may
//! open with, cross in one. The client draws this frame and asks for the
//! whole tail behind it (#1236).

use std::{collections::HashSet, io::Write};

use flate2::{write::DeflateEncoder, Compression};
use serde_json::Value;

use crate::events::{AgentEvent, AgentEventPayload};

/// What a thin frame's events may deflate to. An initial window is ten
/// segments, about 14.6KB; this leaves room for the index row beside them,
/// TLS, and a tunnel's framing.
const BUDGET: usize = 11 * 1024;

/// How much of a tool's argument or output survives. A collapsed row draws a
/// path or a command's first line and nothing of the result.
const BODY: usize = 256;

/// `events` cut down to a first frame, and whether anything was lost doing
/// it. Bodies go first: tool results, long arguments, reasoning. Where that
/// is not enough the oldest events go too, keeping the prompt of the turn the
/// cut lands in so the turn still opens on it.
///
/// Every event kept is its logged self with strings shortened, under the same
/// id, so the whole tail landing later replaces each by id.
pub fn thin(events: Vec<AgentEvent>) -> (Vec<AgentEvent>, bool) {
    let mut lost = false;
    let events: Vec<AgentEvent> = events
        .into_iter()
        .map(|mut event| {
            lost |= strip(&mut event.payload);
            event
        })
        .collect();
    let lines: Vec<Vec<u8>> = events.iter().map(|e| serde_json::to_vec(e).unwrap_or_default()).collect();

    // The longest suffix that fits, found by bisection: fitting is monotonic
    // in where the suffix starts. The newest event is kept whatever it weighs.
    let fits = |from: usize| deflated(&lines[from..]) <= BUDGET;
    let (mut low, mut high) = (0, events.len().saturating_sub(1));
    while low < high {
        let mid = (low + high) / 2;
        if fits(mid) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    let from = low;
    if from == 0 {
        return (events, lost);
    }

    let prompt = events[..from].iter().rposition(opens_turn).filter(|_| !opens_turn(&events[from]));
    let started: HashSet<&str> = events[from..]
        .iter()
        .filter_map(|e| match &e.payload {
            AgentEventPayload::ToolCallStarted { call_id, .. } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    // A result whose call was cut would draw against nothing.
    let orphan = |e: &AgentEvent| matches!(&e.payload, AgentEventPayload::ToolCallCompleted { call_id, .. } if !started.contains(call_id.as_str()));
    let keep: Vec<bool> = events
        .iter()
        .enumerate()
        .map(|(at, e)| Some(at) == prompt || (at >= from && !orphan(e)))
        .collect();
    let kept = events.into_iter().zip(keep).filter_map(|(e, keep)| keep.then_some(e)).collect();
    (kept, true)
}

/// The rule `store::opens_turn` reads off a raw line.
fn opens_turn(event: &AgentEvent) -> bool {
    event.subagent.is_none() && matches!(event.payload, AgentEventPayload::UserMessage { queued: false, .. })
}

fn deflated(lines: &[Vec<u8>]) -> usize {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    for line in lines {
        let _ = encoder.write_all(line);
    }
    encoder.finish().map_or(usize::MAX, |bytes| bytes.len())
}

/// Shortens what a collapsed row does not draw, answering whether it did.
fn strip(payload: &mut AgentEventPayload) -> bool {
    match payload {
        AgentEventPayload::ToolCallCompleted { result, .. } => {
            let structured = result.structured.take().is_some();
            shorten(&mut result.text) | structured
        }
        AgentEventPayload::ToolCallStarted { input, raw_input, .. } => {
            shorten_value(input) | raw_input.as_mut().is_some_and(shorten)
        }
        AgentEventPayload::FileEdits { edits, .. } => edits
            .iter_mut()
            .fold(false, |cut, edit| cut | edit.unified_diff.as_mut().is_some_and(shorten)),
        AgentEventPayload::Reasoning { text, .. } => shorten(text),
        _ => false,
    }
}

fn shorten(text: &mut String) -> bool {
    if text.len() <= BODY {
        return false;
    }
    let mut end = BODY;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}

fn shorten_value(value: &mut Value) -> bool {
    match value {
        Value::String(text) => shorten(text),
        Value::Array(items) => items.iter_mut().fold(false, |cut, item| cut | shorten_value(item)),
        Value::Object(fields) => fields.values_mut().fold(false, |cut, field| cut | shorten_value(field)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(seq: u64, payload: Value) -> AgentEvent {
        serde_json::from_value(serde_json::json!({
            "id": format!("e{seq}"), "sessionId": "s", "harness": "claude_code", "seq": seq,
            "ts": "2026-01-01T00:00:00Z", "turnId": null, "subagent": null, "payload": payload,
        }))
        .unwrap()
    }

    fn prompt(seq: u64) -> AgentEvent {
        event(seq, serde_json::json!({ "type": "user_message", "text": format!("prompt {seq}") }))
    }

    /// Incompressible, so a count of these says what the budget holds.
    fn noise(seed: u64) -> String {
        (0..200).map(|i| format!("{:x}", (seed + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15).rotate_left(i) & 0xff)).collect()
    }

    fn call(seq: u64) -> [AgentEvent; 2] {
        let id = format!("call-{seq}");
        [
            event(seq, serde_json::json!({ "type": "tool_call_started", "callId": id, "name": "Bash", "toolType": "shell", "input": { "command": noise(seq) }, "rawInput": null, "title": null })),
            event(seq + 1, serde_json::json!({ "type": "tool_call_completed", "callId": id, "result": { "text": "x".repeat(4000), "isError": false, "structured": { "stdout": "y" }, "exitCode": 0, "durationMs": 1 } })),
        ]
    }

    #[test]
    fn a_small_transcript_is_left_whole() {
        let log = vec![prompt(0), event(1, serde_json::json!({ "type": "assistant_text", "text": "hi" }))];
        let (kept, lost) = thin(log.clone());
        assert!(!lost);
        assert_eq!(kept.len(), log.len());
    }

    #[test]
    fn bodies_go_and_everything_else_stays() {
        let mut log = vec![prompt(0)];
        log.extend(call(1));
        let (kept, lost) = thin(log);
        assert!(lost);
        assert_eq!(kept.len(), 3);
        let AgentEventPayload::ToolCallCompleted { result, .. } = &kept[2].payload else { panic!() };
        assert_eq!(result.text.len(), BODY);
        assert!(result.structured.is_none());
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    fn a_turn_too_long_keeps_its_prompt_and_its_end() {
        let mut log = vec![prompt(0), event(1, serde_json::json!({ "type": "assistant_text", "text": "old" })), prompt(2)];
        for n in 0..400 {
            log.extend(call(10 + n * 2));
        }
        let last = log.last().unwrap().id.clone();
        let (kept, lost) = thin(log);
        assert!(lost);
        // The older turn is gone whole; the cut turn opens on its own prompt.
        assert_eq!(kept[0].id, "e2");
        assert_eq!(kept.last().unwrap().id, last);
        assert!(kept.len() < 400);
        assert!(deflated(&kept.iter().map(|e| serde_json::to_vec(e).unwrap()).collect::<Vec<_>>()) <= BUDGET + 1024);
        // No result without its call.
        let AgentEventPayload::ToolCallStarted { .. } = &kept[1].payload else { panic!("{:?}", kept[1].payload) };
    }

    #[test]
    fn an_empty_page_thins_to_itself() {
        let (kept, lost) = thin(Vec::new());
        assert!(kept.is_empty() && !lost);
    }
}
