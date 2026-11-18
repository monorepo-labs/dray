//! The first frame of a transcript opened over a slow link: what the newest
//! screen draws, and as little else as that allows.
//!
//! A tail is megabytes of tool output the collapsed transcript never shows —
//! 836KB of JSON, 52KB deflated, for a 100-call turn — all of it read, sent,
//! inflated and parsed twice before the newest screen can paint. A finished
//! turn draws its prompt, a count of its work and its answer, so this frame
//! keeps every event of the turns it holds and cuts their bodies. The client
//! reads the whole tail only when something drawn needs it: the reader
//! scrolling up, or a row whose body was cut coming on screen (#1236).

use std::io::Write;

use flate2::{write::DeflateEncoder, Compression};
use serde_json::{json, Value};

use crate::events::{AgentEvent, AgentEventPayload};

/// What a thin frame's events should deflate to. Ten TCP segments, about
/// 14.6KB, is the most a sender opens with, so a frame under that crosses in
/// one flight whatever state the connection is in; this leaves room for the
/// index row beside the events, TLS, and a tunnel's framing.
const BUDGET: usize = 11 * 1024;

/// How much of a tool's argument or output survives: a collapsed row draws a
/// path or a command's first line, and nothing of the result.
const BODY: usize = 256;

/// The key a cut body carries, in a call's `input` and a result's
/// `structured`, so a row drawing one knows to ask for the whole read rather
/// than show a fragment as the thing itself. Reasoning and reported diffs are
/// left whole: neither has anywhere to say it was cut.
pub const CUT: &str = "_cut";

/// `events` as a first frame, and whether it differs from them. Tool bodies
/// are cut, then whole turns are dropped from the old end until the rest fits
/// [`BUDGET`]. Never part of a turn: its header counts its calls, and a count
/// of some of them is wrong where no count is merely absent. So the newest
/// turn is kept whatever it weighs, and a long one takes a second flight.
///
/// Every event kept is its logged self under the same id, so the whole read
/// landing later replaces each by id.
pub fn thin(events: Vec<AgentEvent>) -> (Vec<AgentEvent>, bool) {
    let mut lost = false;
    let mut events: Vec<AgentEvent> = events
        .into_iter()
        .map(|mut event| {
            lost |= strip(&mut event.payload);
            event
        })
        .collect();
    let lines: Vec<Vec<u8>> = events.iter().map(|e| serde_json::to_vec(e).unwrap_or_default()).collect();

    // Where a suffix may start: the page's own start, which is a turn's
    // prompt or the top of the log, and every prompt after it.
    let starts: Vec<usize> = std::iter::once(0)
        .chain(events.iter().enumerate().skip(1).filter(|(_, e)| opens_turn(e)).map(|(at, _)| at))
        .collect();
    let from = starts
        .iter()
        .copied()
        .find(|&at| deflated(&lines[at..]) <= BUDGET)
        .or(starts.last().copied())
        .unwrap_or(0);
    if from > 0 {
        events.drain(..from);
        lost = true;
    }
    (events, lost)
}

/// How much of a kept call's output a bot's chat is sent. A started task's id
/// is the first line, and a send's receipt a line of its own.
const RECEIPT: usize = 4 * 1024;

/// `events` as a bot's chat draws them. A bot is talked to like a person, so
/// its chat shows the conversation and the tasks it started and never the
/// work between: of its tool calls only a `dray … new` or `dray … send` is
/// read, for a task or a message it names, and those are kept whole. Every
/// other call goes with its result, and so do reasoning, reported edits and
/// whatever a subagent did — in a bot's log, most of the bytes and most of
/// the events.
///
/// A call still open is kept too, whatever it runs: the chat's orb line names
/// what the bot is doing now, and a chat opened mid-turn would otherwise say
/// nothing until the next event.
///
/// Whatever is not one of those is kept, so an event a later build adds
/// reaches a chat that draws it.
pub fn chat(events: Vec<AgentEvent>) -> Vec<AgentEvent> {
    let done: std::collections::HashSet<String> = events
        .iter()
        .filter_map(|e| match &e.payload {
            AgentEventPayload::ToolCallCompleted { call_id, .. } => Some(call_id.clone()),
            _ => None,
        })
        .collect();
    let mut read = std::collections::HashSet::new();
    events
        .into_iter()
        .filter_map(|mut event| {
            if event.subagent.is_some() {
                return None;
            }
            match &mut event.payload {
                AgentEventPayload::ToolCallStarted { call_id, input, .. } => {
                    let said = input.to_string();
                    let ours = said.contains("dray") && (said.contains("new") || said.contains("send"));
                    if ours {
                        read.insert(call_id.clone());
                    }
                    (ours || !done.contains(call_id.as_str())).then_some(event)
                }
                AgentEventPayload::ToolCallCompleted { call_id, result } => {
                    if !read.contains(call_id.as_str()) {
                        return None;
                    }
                    cut_to(&mut result.text, RECEIPT);
                    result.structured = None;
                    Some(event)
                }
                AgentEventPayload::Reasoning { .. } | AgentEventPayload::FileEdits { .. } => None,
                _ => Some(event),
            }
        })
        .collect()
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

/// Cuts what a collapsed row does not draw, answering whether it did.
fn strip(payload: &mut AgentEventPayload) -> bool {
    match payload {
        AgentEventPayload::ToolCallCompleted { result, .. } => {
            let heavy = result.structured.as_ref().is_some_and(|s| s.to_string().len() > BODY);
            let cut = shorten(&mut result.text) | heavy;
            if cut {
                result.structured = Some(json!({ CUT: true }));
            }
            cut
        }
        AgentEventPayload::ToolCallStarted { input, raw_input, .. } => {
            let cut = shorten_value(input) | raw_input.as_mut().is_some_and(shorten);
            if cut {
                match input {
                    Value::Object(fields) => {
                        fields.insert(CUT.into(), Value::Bool(true));
                    }
                    other => *other = json!({ CUT: true }),
                }
            }
            cut
        }
        _ => false,
    }
}

fn shorten(text: &mut String) -> bool {
    cut_to(text, BODY)
}

fn cut_to(text: &mut String, cap: usize) -> bool {
    if text.len() <= cap {
        return false;
    }
    let mut end = cap;
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
        serde_json::from_value(json!({
            "id": format!("e{seq}"), "sessionId": "s", "harness": "claude_code", "seq": seq,
            "ts": "2026-01-01T00:00:00Z", "turnId": null, "subagent": null, "payload": payload,
        }))
        .unwrap()
    }

    fn prompt(seq: u64) -> AgentEvent {
        event(seq, json!({ "type": "user_message", "text": format!("prompt {seq}") }))
    }

    /// Incompressible, so a count of these says what the budget holds.
    fn noise(seed: u64) -> String {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        (0..25)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                format!("{state:016x}")
            })
            .collect()
    }

    fn call(seq: u64) -> [AgentEvent; 2] {
        let id = format!("call-{seq}");
        [
            event(seq, json!({ "type": "tool_call_started", "callId": id, "name": "Bash", "toolType": "shell", "input": { "command": noise(seq), "description": "x".repeat(300), "id": noise(seq + 7) }, "rawInput": null, "title": null })),
            event(seq + 1, json!({ "type": "tool_call_completed", "callId": id, "result": { "text": "x".repeat(4000), "isError": false, "structured": { "stdout": "y".repeat(4000) }, "exitCode": 0, "durationMs": 1 } })),
        ]
    }

    /// A turn of `calls` calls opening at `seq`.
    fn turn(seq: u64, calls: u64) -> Vec<AgentEvent> {
        let mut log = vec![prompt(seq)];
        for n in 0..calls {
            log.extend(call(seq + 1 + n * 2));
        }
        log
    }

    #[test]
    fn a_small_transcript_is_left_whole() {
        let log = vec![prompt(0), event(1, json!({ "type": "assistant_text", "text": "hi" }))];
        let (kept, lost) = thin(log.clone());
        assert!(!lost);
        assert_eq!(kept.len(), log.len());
    }

    #[test]
    fn bodies_are_cut_and_say_so() {
        let (kept, lost) = thin(turn(0, 1));
        assert!(lost);
        assert_eq!(kept.len(), 3);
        let AgentEventPayload::ToolCallStarted { input, .. } = &kept[1].payload else { panic!() };
        assert_eq!(input["description"].as_str().unwrap().len(), BODY);
        assert_eq!(input[CUT], true);
        let AgentEventPayload::ToolCallCompleted { result, .. } = &kept[2].payload else { panic!() };
        assert_eq!(result.text.len(), BODY);
        assert_eq!(result.structured, Some(json!({ CUT: true })));
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    fn a_short_body_is_left_alone_and_unmarked() {
        let log = vec![
            prompt(0),
            event(1, json!({ "type": "tool_call_started", "callId": "c", "name": "Bash", "toolType": "shell", "input": { "command": "ls" }, "rawInput": null, "title": null })),
            event(2, json!({ "type": "tool_call_completed", "callId": "c", "result": { "text": "a.txt", "isError": false, "structured": { "stdout": "a.txt" }, "exitCode": 0, "durationMs": 1 } })),
        ];
        let (kept, lost) = thin(log);
        assert!(!lost);
        let AgentEventPayload::ToolCallStarted { input, .. } = &kept[1].payload else { panic!() };
        assert!(input.get(CUT).is_none());
        let AgentEventPayload::ToolCallCompleted { result, .. } = &kept[2].payload else { panic!() };
        assert_eq!(result.structured, Some(json!({ "stdout": "a.txt" })));
    }

    #[test]
    fn old_turns_go_whole_and_never_part_of_one() {
        let mut log = turn(0, 60);
        log.extend(turn(1000, 60));
        log.extend(turn(2000, 10));
        let (kept, lost) = thin(log);
        assert!(lost);
        // Every turn kept opens on its prompt and holds all its calls.
        assert!(matches!(kept[0].payload, AgentEventPayload::UserMessage { .. }));
        let prompts = kept.iter().filter(|e| opens_turn(e)).count();
        assert!(prompts < 3);
        assert_eq!(kept.last().unwrap().id, "e2020");
        assert!(kept.iter().any(|e| e.id == "e2000"));
        assert_eq!(kept.len() % 2, prompts % 2);
    }

    #[test]
    fn the_newest_turn_is_kept_whatever_it_weighs() {
        let mut log = turn(0, 2);
        log.extend(turn(1000, 400));
        let (kept, lost) = thin(log);
        assert!(lost);
        assert_eq!(kept[0].id, "e1000");
        assert_eq!(kept.len(), 801);
    }

    #[test]
    fn a_bots_chat_keeps_the_talk_and_the_calls_it_reads() {
        let dray = |seq: u64, command: &str, out: &str| {
            let id = format!("d{seq}");
            [
                event(seq, json!({ "type": "tool_call_started", "callId": id, "name": "Bash", "toolType": "shell", "input": { "command": command }, "rawInput": null, "title": null })),
                event(seq + 1, json!({ "type": "tool_call_completed", "callId": id, "result": { "text": out, "isError": false, "structured": { "stdout": out }, "exitCode": 0, "durationMs": 1 } })),
            ]
        };
        let mut log = vec![prompt(0)];
        log.extend(call(1));
        log.push(event(3, json!({ "type": "reasoning", "text": "hm" })));
        log.extend(dray(4, "dray session new --project /tmp 'do it'", "01a1edc2-be4d-7410-88ec-8bff59d44ac0\nStarted"));
        log.extend(dray(6, "dray session send abc 'hello'", &"y".repeat(9000)));
        log.extend(dray(8, "dray session ls", "rows"));
        let mut inner = event(10, json!({ "type": "assistant_text", "text": "from a subagent" }));
        inner.subagent = Some(crate::events::Subagent { id: "s".into(), label: None });
        log.push(inner);
        log.push(event(11, json!({ "type": "assistant_text", "text": "done" })));
        // Still running, so the chat can say what the bot is doing.
        log.push(call(12)[0].clone());

        let kept = chat(log);
        let ids: Vec<&str> = kept.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["e0", "e4", "e5", "e6", "e7", "e11", "e12"]);
        let AgentEventPayload::ToolCallStarted { input, .. } = &kept[1].payload else { panic!() };
        assert_eq!(input["command"], "dray session new --project /tmp 'do it'");
        let AgentEventPayload::ToolCallCompleted { result, .. } = &kept[2].payload else { panic!() };
        assert!(result.text.starts_with("01a1edc2"));
        let AgentEventPayload::ToolCallCompleted { result, .. } = &kept[4].payload else { panic!() };
        assert_eq!(result.text.len(), RECEIPT);
    }

    #[test]
    fn an_empty_page_thins_to_itself() {
        let (kept, lost) = thin(Vec::new());
        assert!(kept.is_empty() && !lost);
    }
}
