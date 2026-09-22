//! Grok Build's ACP vocabulary onto Dray's.
//!
//! Three things are synthesized rather than read, each for fx's reason one
//! harness over. grok sends no turn-started line the client can act on — the
//! turn opens when the prompt request is written and closes when it answers —
//! so `TurnStarted` is minted on the first update after a prompt. It sends no
//! "requesting" ping, so `ModelRequestStarted` is minted with it and after every
//! tool result. And a message or thought chunk carries no id at all, so one
//! block runs until an update of another kind arrives.

use crate::events::{
    usage::ContextWindow, AgentEvent, AgentEventPayload, BackgroundTask, BlockRef, BlockType,
    DeltaEvent, SessionInfo, Subagent, ToolResult, ToolType, TurnStatus, Usage,
};
use crate::harness::{mentions_any, Harness};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

use super::parser::{
    GrokEvent, GrokUpdate, PromptResponse, SubagentFinished, SubagentSpawned, ToolContent, ToolKind,
    ToolStatus,
};

/// What grok says when the account cannot run the turn. Written to under-match
/// for [`mentions_any`]'s reason: a wording missed costs the login button and
/// keeps the sentence. Read off the live refusal, which is
/// `Authentication required` with `no auth method id provided` beside it.
const LOGIN_NEEDLES: &[&str] = &["authentication required", "not authenticated", "sign in", "log in"];

/// What a delegated run is called where a label is wanted. grok names the type
/// on `subagent_spawned` (`general-purpose`), so this is the fallback alone.
const SUBAGENT_LABEL: &str = "Subagent";

/// A streamed block still open, and the text it has accumulated — the committed
/// event supersedes the deltas, so the whole text is kept.
struct OpenBlock {
    id: String,
    kind: BlockType,
    text: String,
}

/// Per-session state the mapping needs across lines.
pub struct Mapper {
    /// Dray's own id, which for grok is also grok's: `_meta.sessionId` on
    /// `session/new` is honoured, so the index id *is* the resume handle.
    session_id: String,
    seq: Arc<AtomicU64>,
    turn_open: bool,
    /// The one block streaming right now. Neither chunk kind carries an id, so
    /// at most one is open and a chunk of the other kind closes it.
    open: Option<OpenBlock>,
    /// Ids handed to blocks, which carry none of their own.
    blocks: u64,
    /// The newest occupancy reading, folded onto the turn's own `TurnCompleted`
    /// — the composer's ring reads it back out of the log.
    occupancy: Option<ContextWindow>,
    /// The context window of the model this session is on, learned from the
    /// handshake. `_meta.totalTokens` is a count with no denominator on it.
    window: u64,
    /// Text a running call has streamed, by call id.
    outputs: HashMap<String, String>,
    /// The display title a call's first update carried, so the closing event can
    /// still be joined to a name — the opening `tool_call` has only the bare
    /// tool name on it.
    names: HashMap<String, String>,
    /// `spawn_subagent` calls that have opened and not yet been claimed by a
    /// `subagent_spawned`, with the brief each carried, newest last.
    ///
    /// Nothing on the wire joins the two: the notification names the *child*
    /// and never the call that asked for it. The transcript correlates a run on
    /// the spawning call's id, so the join has to be made here — see
    /// [`Self::claim_spawn`] for why it is `description` first and order after.
    pending_spawns: Vec<(String, Option<String>)>,
    /// The spawning call id each live child was filed under, so `subagent_*`
    /// events after the first can be enveloped on the same run.
    runs: HashMap<String, String>,
    /// Background task ids with a run already open, so the whole-set update
    /// grok sends can be read as the additions and removals it implies.
    tasks: HashSet<String>,
}

impl Mapper {
    pub fn new(session_id: String, seq: Arc<AtomicU64>, window: u64) -> Self {
        Self {
            session_id,
            seq,
            turn_open: false,
            open: None,
            blocks: 0,
            occupancy: None,
            window,
            outputs: HashMap::new(),
            names: HashMap::new(),
            pending_spawns: Vec::new(),
            runs: HashMap::new(),
            tasks: HashSet::new(),
        }
    }

    /// Records the window the session's own model reports, which is the ring's
    /// denominator. Set once the handshake has answered — the read loop starts
    /// before `session/new` does, so the mapper opens on the default.
    pub fn set_window(&mut self, window: u64) {
        if window > 0 {
            self.window = window;
        }
    }

    pub fn map(&mut self, event: GrokEvent) -> Vec<AgentEvent> {
        match event {
            GrokEvent::Update(update) => self.update(update),
            GrokEvent::PromptDone(response) => self.prompt_done(*response),
            GrokEvent::PromptFailed { message } => self.prompt_failed(message),
            GrokEvent::Unknown => Vec::new(),
        }
    }

    fn update(&mut self, update: GrokUpdate) -> Vec<AgentEvent> {
        match update {
            GrokUpdate::AgentMessageChunk { content } => {
                let Some(text) = content.text() else {
                    return Vec::new();
                };
                let mut out = self.ensure_turn();
                out.extend(self.stream(BlockType::Text, text));
                out
            }

            GrokUpdate::AgentThoughtChunk { content } => {
                let Some(text) = content.text() else {
                    return Vec::new();
                };
                let mut out = self.ensure_turn();
                out.extend(self.stream(BlockType::Thinking, text));
                out
            }

            GrokUpdate::ToolCall {
                tool_call_id,
                kind,
                raw_input,
                meta,
                status,
                ..
            } => {
                // Only `session/load`'s replay puts a status on an opening line,
                // and Dray never calls it — Dray's own log is the replay. One
                // arriving means a shape this build did not expect, and drawing
                // a start for a call that is already over is worse than nothing.
                if status.is_some_and(ToolStatus::is_final) {
                    return Vec::new();
                }
                let name = meta
                    .name()
                    .map(str::to_string)
                    .unwrap_or_else(|| kind_name(kind).to_string());
                let mut out = self.ensure_turn();
                out.extend(self.close_open());
                self.names.insert(tool_call_id.clone(), name.clone());
                let call_type = tool_type(meta.kind(), &name, kind);
                if call_type == ToolType::SubagentSpawn {
                    // The brief is on this line and on the notification behind
                    // it; nothing else is on both, so it is the only join
                    // stronger than arrival order.
                    let brief = raw_input
                        .as_ref()
                        .and_then(|input| input.get("description"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    self.pending_spawns.push((tool_call_id.clone(), brief));
                }
                out.push(self.event(AgentEventPayload::ToolCallStarted {
                    call_id: tool_call_id,
                    tool_type: call_type,
                    name,
                    input: tool_input(raw_input),
                    raw_input: None,
                    // grok's own title on this line is the bare tool name, and
                    // the sentence lands on the update behind it. Left unset so
                    // the row falls through to `toolSummary`, which draws the
                    // path or command off the input — the same thing the
                    // sentence would have said, a frame earlier.
                    title: None,
                }));
                out
            }

            GrokUpdate::ToolCallUpdate {
                tool_call_id,
                status,
                content,
                raw_output,
                ..
            } => {
                let text: String = content
                    .iter()
                    .filter_map(|c| match c {
                        ToolContent::Content { content } => content.text(),
                        _ => None,
                    })
                    .collect();
                let diffs: Vec<&ToolContent> = content
                    .iter()
                    .filter(|c| matches!(c, ToolContent::Diff { .. }))
                    .collect();

                let Some(status) = status.filter(|s| s.is_final()) else {
                    // Streamed output, kept for the result rather than drawn.
                    // **Only the shell's, and only from `rawOutput`**: an
                    // `in_progress` update's `content` echoes the call's own
                    // *description* — "Count bytes in hello.txt" — where
                    // `output_for_prompt` beside it is the stdout so far. Taking
                    // the content would prefix every shell result with a
                    // sentence the model wrote about it.
                    if let Some(so_far) = raw_output.as_ref().and_then(|r| r.output_for_prompt.as_ref())
                    {
                        if !so_far.is_empty() {
                            self.outputs.insert(tool_call_id, so_far.clone());
                        }
                    }
                    return Vec::new();
                };

                let streamed = self.outputs.remove(&tool_call_id).unwrap_or_default();
                let result = ToolResult {
                    text: result_text(&raw_output, streamed, text, &diffs),
                    is_error: status == ToolStatus::Failed,
                    structured: None,
                    exit_code: raw_output
                        .as_ref()
                        .and_then(|r| r.exit_code)
                        .map(|code| code as i32),
                    // grok reports no per-call duration; the turn's own
                    // `apiDurationMs` covers the model rather than the tool.
                    duration_ms: None,
                    images: Vec::new(),
                };

                self.names.remove(&tool_call_id);
                vec![
                    self.event(AgentEventPayload::ToolCallCompleted {
                        call_id: tool_call_id,
                        result,
                    }),
                    // The model reads the result next — the same reading every
                    // other mapper here makes, for the same working indicator.
                    self.event(AgentEventPayload::ModelRequestStarted),
                ]
            }

            GrokUpdate::BackgroundTasks { tasks } => {
                let live: Vec<BackgroundTask> = tasks
                    .into_iter()
                    .map(|task| BackgroundTask {
                        description: task
                            .description
                            .or(task.command)
                            .unwrap_or_else(|| "background task".to_string()),
                        task_type: task.kind.unwrap_or_else(|| "bash".to_string()),
                        task_id: task.task_id,
                    })
                    .collect();

                // The count lights `BackgroundTasksIndicator`, whose click opens
                // the subagent panel — and that panel draws *runs*, so
                // publishing the list alone sent the reader to an empty pane.
                // Claude Code's backgrounded shells are rows there (DRA-264's
                // "Wait for…" list), so this is the same panel answering the
                // same question rather than a shape invented for grok.
                let mut out = Vec::new();
                for task in &live {
                    if self.tasks.insert(task.task_id.clone()) {
                        out.push(self.subagent_event(
                            &task.task_id,
                            task.task_type.clone(),
                            AgentEventPayload::SubagentStarted {
                                // Empty for the subagent rule's reason: grok
                                // publishes no per-task cancel, and a `taskId`
                                // here draws a Stop whose `stop_task` is a
                                // Claude Code control line this transport has
                                // not got. Settle still reaps the tree.
                                agent_id: String::new(),
                                label: task.task_type.clone(),
                                description: Some(task.description.clone()),
                                prompt: None,
                            },
                        ));
                    }
                }

                // grok reports the whole set each time, so a task missing from
                // one is a task that ended — there is no closing event of its
                // own to wait for.
                let ids: HashSet<&str> = live.iter().map(|t| t.task_id.as_str()).collect();
                let ended: Vec<String> = self
                    .tasks
                    .iter()
                    .filter(|id| !ids.contains(id.as_str()))
                    .cloned()
                    .collect();
                for id in ended {
                    self.tasks.remove(&id);
                    out.push(self.subagent_event(
                        &id,
                        SUBAGENT_LABEL.to_string(),
                        AgentEventPayload::SubagentCompleted {
                            agent_id: String::new(),
                            status: "completed".to_string(),
                            summary: None,
                            usage: None,
                        },
                    ));
                }

                out.push(self.event(AgentEventPayload::BackgroundTasksChanged { tasks: live }));
                out
            }

            GrokUpdate::SubagentSpawned(spawned) => vec![self.subagent_started(*spawned)],
            GrokUpdate::SubagentFinished(finished) => vec![self.subagent_finished(*finished)],
            // Progress carries a token count and a tool list and no sentence
            // about what the child is doing, which is the one field the panel's
            // live status line draws. Dropped rather than drawn as a row that
            // says the same thing every few seconds.
            GrokUpdate::SubagentProgress(_) => Vec::new(),

            GrokUpdate::AutoCompactCompleted {
                tokens_before,
                tokens_after,
            } => {
                // The ring reads the log back, so what compaction left has to be
                // the newest reading in it — otherwise the next turn's reply,
                // which answers `totalTokens: 0` on a compacting turn, is the
                // only thing after this and the ring reads empty.
                if let Some(after) = tokens_after {
                    self.occupancy = Some(ContextWindow {
                        used_tokens: after,
                        max_tokens: self.window,
                    });
                }
                vec![self.event(AgentEventPayload::ContextCompacted {
                    // grok's is the auto compactor even where `/compact` asked
                    // for it: the event is named `auto_compact_completed` either
                    // way and nothing on it says who started it.
                    trigger: Some("auto".to_string()),
                    pre_tokens: tokens_before,
                    post_tokens: tokens_after,
                    duration_ms: None,
                })]
            }

            // Read by the read loop off the parsed update rather than mapped: a
            // title is a fact about the index row and a command list is one
            // about the picker, and neither is a transcript event.
            GrokUpdate::SessionInfoUpdate { .. } | GrokUpdate::AvailableCommandsUpdate { .. } => {
                Vec::new()
            }

            GrokUpdate::UserMessageChunk
            | GrokUpdate::ToolCallDeltaChunk
            | GrokUpdate::ResponseCompleted
            | GrokUpdate::TurnCompleted
            | GrokUpdate::ModelChanged
            | GrokUpdate::SessionSummaryGenerated
            | GrokUpdate::HookRunStarted
            | GrokUpdate::HookExecution
            | GrokUpdate::PendingInteraction
            | GrokUpdate::InteractionResolved
            | GrokUpdate::TaskBackgrounded
            | GrokUpdate::ConfigOptionUpdate
            | GrokUpdate::Plan
            | GrokUpdate::Unknown => Vec::new(),
        }
    }

    fn prompt_done(&mut self, response: PromptResponse) -> Vec<AgentEvent> {
        let mut out = self.close_open();

        // A `0` is compaction's, not an empty context — the compacting turn's
        // reply reads `totalTokens: 0` with the real figure in `inputTokens`
        // beside it — so the last good reading stands until the next turn.
        if let Some(used) = response.meta.total_tokens.filter(|t| *t > 0) {
            self.occupancy = Some(ContextWindow {
                used_tokens: used,
                max_tokens: self.window,
            });
        }

        let (status, final_text) = match response.stop_reason.as_str() {
            "refusal" | "refused" => (
                TurnStatus::Error,
                Some("Grok refused this prompt.".to_string()),
            ),
            "max_tokens" => (
                TurnStatus::Error,
                Some("Grok stopped: the model hit its output token limit.".to_string()),
            ),
            "max_turn_requests" => (
                TurnStatus::Error,
                Some("Grok stopped: the turn hit its request limit.".to_string()),
            ),
            // `end_turn`, and `cancelled` — the reader's own Stop, reported as a
            // success carrying a reason nothing draws.
            //
            // **A cancelled turn leaves its running call with no terminal
            // update at all** — measured, the last word on a killed `sleep 200`
            // is `in_progress` — and nothing is minted for it here. The
            // transcript's own `ABANDONED` stand-in is what closes a call the
            // log leaves open once the session stops being busy, which is the
            // one rule covering every harness rather than a second one here.
            _ => (TurnStatus::Success, None),
        };

        let meta = response.meta.clone();
        out.push(self.turn_completed(
            status,
            Some(response.stop_reason),
            final_text,
            false,
            Some(Usage {
                input_tokens: meta.input_tokens,
                output_tokens: meta.output_tokens,
                cached_input_tokens: meta.cached_read_tokens,
                reasoning_tokens: meta.reasoning_tokens,
                context_window: self.occupancy,
                ..Default::default()
            }),
        ));
        out
    }

    /// `session/prompt` refused outright — no credential, a model grok will not
    /// run. The sentence is grok's own, so it is the row's text.
    fn prompt_failed(&mut self, message: String) -> Vec<AgentEvent> {
        let mut out = self.close_open();
        let auth_failed = mentions_any(&message, LOGIN_NEEDLES);
        out.push(self.turn_completed(TurnStatus::Error, None, Some(message), auth_failed, None));
        out
    }

    fn turn_completed(
        &mut self,
        status: TurnStatus,
        stop_reason: Option<String>,
        final_text: Option<String>,
        auth_failed: bool,
        usage: Option<Usage>,
    ) -> AgentEvent {
        let event = self.event(AgentEventPayload::TurnCompleted {
            status,
            stop_reason,
            auth_failed,
            final_text,
            usage: usage.or_else(|| {
                self.occupancy.map(|window| Usage {
                    context_window: Some(window),
                    ..Default::default()
                })
            }),
            duration_ms: None,
            // Filled by `session::ingest`, the only layer that knows the tree.
            head: None,
        });
        self.turn_open = false;
        self.outputs.clear();
        self.names.clear();
        // A spawn whose child never reported — a call that failed outright —
        // would otherwise be claimed by the next turn's first subagent and hang
        // that run off a row from the turn before.
        self.pending_spawns.clear();
        event
    }

    /// Opens the turn on its first update. grok has no turn-started line the
    /// client can act on: the prompt request is the start and its answer the
    /// end, and neither passes through here.
    fn ensure_turn(&mut self) -> Vec<AgentEvent> {
        if self.turn_open {
            return Vec::new();
        }
        self.turn_open = true;
        vec![
            self.event(AgentEventPayload::TurnStarted(SessionInfo {
                cwd: None,
                model: None,
                harness_version: None,
                tools: Vec::new(),
                mcp_servers: Vec::new(),
                subagent_types: Vec::new(),
                settings: None,
            })),
            self.event(AgentEventPayload::ModelRequestStarted),
        ]
    }

    /// Appends a chunk to the open block of `kind`, opening a new one where the
    /// kind has changed.
    fn stream(&mut self, kind: BlockType, text: &str) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        let id = match &self.open {
            Some(block) if block.kind == kind => block.id.clone(),
            _ => {
                out.extend(self.close_open());
                self.blocks += 1;
                let id = format!("block-{}", self.blocks);
                out.push(self.event(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                    block: block_ref(&id),
                    block_type: kind.clone(),
                })));
                self.open = Some(OpenBlock {
                    id: id.clone(),
                    kind,
                    text: String::new(),
                });
                id
            }
        };
        if let Some(block) = &mut self.open {
            block.text.push_str(text);
        }
        out.push(self.event(AgentEventPayload::Delta(DeltaEvent::TextDelta {
            block: block_ref(&id),
            text: text.to_string(),
        })));
        out
    }

    /// Closes the streaming block, committing its whole text: the deltas were a
    /// preview and this is what the transcript keeps.
    fn close_open(&mut self) -> Vec<AgentEvent> {
        let Some(block) = self.open.take() else {
            return Vec::new();
        };
        let stop = self.event(AgentEventPayload::Delta(DeltaEvent::BlockStop {
            block: block_ref(&block.id),
        }));
        let committed = match block.kind {
            BlockType::Thinking => self.event(AgentEventPayload::Reasoning {
                block: Some(block_ref(&block.id)),
                encrypted: block.text.is_empty(),
                text: block.text,
            }),
            _ => self.event(AgentEventPayload::AssistantText {
                block: Some(block_ref(&block.id)),
                text: block.text,
            }),
        };
        vec![stop, committed]
    }

    /// The spawning call this child belongs to, by brief where one matches and
    /// by arrival order otherwise.
    ///
    /// Order alone would be enough for the captured sessions, where a spawn is
    /// answered before the next one opens — but grok can open several calls
    /// before any child reports, and the brief is carried on both lines, so it
    /// is worth asking first. A child with no call to claim answers `None` and
    /// falls back to its own id: a run filed under a handle nothing correlates
    /// is still a run in the panel, where dropping it would lose the delegation
    /// entirely.
    fn claim_spawn(&mut self, description: Option<&str>) -> Option<String> {
        let by_brief = description.and_then(|brief| {
            self.pending_spawns
                .iter()
                .position(|(_, pending)| pending.as_deref() == Some(brief))
        });
        let found = match by_brief {
            Some(at) => at,
            None if self.pending_spawns.is_empty() => return None,
            None => 0,
        };
        Some(self.pending_spawns.remove(found).0)
    }

    fn subagent_started(&mut self, spawned: SubagentSpawned) -> AgentEvent {
        let label = spawned
            .subagent_type
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| SUBAGENT_LABEL.to_string());
        // The envelope is the spawning call's id, never the child's. That is
        // what `buildTranscript` correlates a run on — it joins the run to the
        // `tool_call` row that asked for it — so filing under grok's child
        // handle left the chat drawing a plain tool row and the panel an
        // orphaned run with no spawn behind it.
        let id = self
            .claim_spawn(spawned.description.as_deref())
            .unwrap_or_else(|| spawned.subagent_id.clone());
        self.runs.insert(spawned.subagent_id.clone(), id.clone());
        self.subagent_event(
            &id,
            label.clone(),
            AgentEventPayload::SubagentStarted {
                // Empty on purpose, the reading fx already takes: this is the
                // handle a Stop would name, and `stop_task` is Claude Code's
                // control line — it writes to a stdin this transport has not
                // got. grok publishes no subagent cancel, so a run here must
                // draw no Stop button rather than one that errors.
                agent_id: String::new(),
                label,
                description: spawned.description,
                // The brief grok handed the child rides `rawInput.prompt` on
                // the spawning `tool_call`, which is a different line with a
                // different id. `description` is the one-line version and is
                // what the row draws.
                prompt: None,
            },
        )
    }

    fn subagent_finished(&mut self, finished: SubagentFinished) -> AgentEvent {
        // The same envelope the run opened under, or the close files a second
        // run beside the one it was meant to end.
        let id = self
            .runs
            .remove(&finished.subagent_id)
            .unwrap_or_else(|| finished.subagent_id.clone());
        self.subagent_event(
            &id,
            SUBAGENT_LABEL.to_string(),
            AgentEventPayload::SubagentCompleted {
                agent_id: String::new(),
                status: finished.status.unwrap_or_else(|| "completed".to_string()),
                // The child's whole report, which is why nothing about its own
                // stream is kept: those updates arrive under the child's session
                // id and the read loop drops them.
                summary: finished.output,
                usage: finished.tokens_used.map(|tokens| Usage {
                    input_tokens: Some(tokens),
                    ..Default::default()
                }),
            },
        )
    }

    /// Mints an event the read loop needs but no update carried — a permission
    /// request, a question and a plan approval all arrive as JSON-RPC
    /// *requests* and never reach [`Self::map`].
    pub fn synthesize(&self, payload: AgentEventPayload) -> AgentEvent {
        self.event(payload)
    }

    /// A lifecycle event belonging to a run rather than to the conversation.
    fn subagent_event(&self, id: &str, label: String, payload: AgentEventPayload) -> AgentEvent {
        let mut event = self.event(payload);
        event.subagent = Some(Subagent {
            id: id.to_string(),
            label: Some(label),
        });
        event
    }

    fn event(&self, payload: AgentEventPayload) -> AgentEvent {
        AgentEvent::mint(
            self.session_id.clone(),
            Harness::Grok,
            self.seq.fetch_add(1, Relaxed),
            // grok names a `promptId` per turn on `_meta`, but only on the
            // reply — nothing streamed carries it, so a turn id minted here
            // would be absent from every row inside the turn it names.
            None,
            None,
            payload,
        )
    }
}

/// grok has no message/block split — one run of chunks is one block — so the
/// index is always zero.
fn block_ref(id: &str) -> BlockRef {
    BlockRef {
        message_id: id.to_string(),
        index: 0,
    }
}

/// grok's own tool class onto Dray's, with ACP's as the fallback.
///
/// grok's `_meta["x.ai/tool"].kind` is preferred because it is on the **opening**
/// line where ACP's `kind` arrives on the update behind it, and because ACP's is
/// wrong about the two calls whose row depends on it: `ask_user_question` and
/// `spawn_subagent` both come through as `other`.
fn tool_type(xai_kind: Option<&str>, name: &str, acp: ToolKind) -> ToolType {
    match xai_kind {
        Some("write") | Some("edit") => return ToolType::FileEdit,
        Some("read") => return ToolType::FileRead,
        Some("execute") => return ToolType::Shell,
        Some("search") => return ToolType::Search,
        Some("fetch") => return ToolType::Web,
        // grok's own name for a delegated run, and the one ACP calls `other`.
        Some("task") => return ToolType::SubagentSpawn,
        _ => {}
    }
    // A tool grok classed as nothing this build spells, judged on its name the
    // way fx's two exceptions are.
    match name {
        "spawn_subagent" => return ToolType::SubagentSpawn,
        "run_terminal_command" => return ToolType::Shell,
        "read_file" => return ToolType::FileRead,
        "write" | "search_replace" => return ToolType::FileEdit,
        _ => {}
    }
    match acp {
        ToolKind::Read => ToolType::FileRead,
        ToolKind::Edit | ToolKind::Delete | ToolKind::Move => ToolType::FileEdit,
        ToolKind::Search => ToolType::Search,
        ToolKind::Execute => ToolType::Shell,
        ToolKind::Fetch => ToolType::Web,
        ToolKind::Think | ToolKind::SwitchMode | ToolKind::Other => ToolType::Other,
    }
}

/// A name for a call that arrived without one — grok names every one on every
/// capture, so this is the line-survives-anything fallback.
fn kind_name(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "shell",
        ToolKind::Fetch => "fetch",
        ToolKind::Think => "think",
        ToolKind::SwitchMode => "switch_mode",
        ToolKind::Other => "tool",
    }
}

/// The call's arguments as the row draws them. Always an object.
///
/// grok names its edit fields exactly as Claude Code does — `file_path` and
/// `content` for `write`, `file_path`/`old_string`/`new_string` for
/// `search_replace`, `command`/`description` for the shell — so `diff.ts` and
/// `toolSummary` read them with nothing added. The one field dropped is
/// `variant`, grok's own tag for which arm of its input enum this is, which is
/// the tool name said a second time.
fn tool_input(raw: Option<Value>) -> Value {
    let mut input = match raw {
        Some(Value::Object(map)) => Value::Object(map),
        Some(Value::Null) | None => json!({}),
        Some(other) => json!({ "_unparsed": other.to_string() }),
    };
    if let Some(map) = input.as_object_mut() {
        map.remove("variant");
    }
    input
}

/// What a finished call reports.
///
/// The shell's answer is `rawOutput.output_for_prompt`, which grok prefixes
/// `exit: 0\n` on the closing update — cut, since the row draws the exit code
/// in its own slot and a duplicate reads as output the command printed. The
/// streamed copy stands in where the closing update carried none, which is a
/// command killed mid-run.
///
/// An edit's closing update carries its diff blocks and a `rawOutput` sentence
/// ("The file … has been created"), and neither is the result: the diff is what
/// the row draws and the sentence restates the row's own title. So a call whose
/// content is a diff answers with **nothing**, the reading a whole-file `Read`
/// already takes.
fn result_text(
    raw_output: &Option<super::parser::RawOutput>,
    streamed: String,
    closing: String,
    diffs: &[&ToolContent],
) -> String {
    if let Some(output) = raw_output.as_ref().and_then(|r| r.output_for_prompt.as_ref()) {
        if !output.is_empty() {
            return strip_exit_line(output).to_string();
        }
    }
    if !diffs.is_empty() {
        return String::new();
    }
    if !closing.is_empty() {
        return closing;
    }
    streamed
}

/// Drops grok's own `exit: N` header off a shell result.
///
/// Only where it is the whole first line, so a command whose own first line of
/// output happens to read `exit: 3` keeps it.
fn strip_exit_line(output: &str) -> &str {
    let Some((first, rest)) = output.split_once('\n') else {
        return output;
    };
    match first.strip_prefix("exit: ") {
        Some(code) if !code.is_empty() && code.bytes().all(|b| b.is_ascii_digit()) => rest,
        _ => output,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::AgentEventPayload as P;
    use serde_json::Value;

    const LIVE_TURN: &str = include_str!("fixtures/live_turn.jsonl");
    const CANCEL: &str = include_str!("fixtures/cancel.jsonl");
    const ASK_USER: &str = include_str!("fixtures/ask_user.jsonl");
    const SUBAGENT: &str = include_str!("fixtures/subagent.jsonl");

    /// grok's context window, the one every current model reports.
    const WINDOW: u64 = 500_000;

    /// Replays one capture through the mapper the way the read loop does:
    /// every notification on either channel, filtered to the session the
    /// capture's own `session/new` opened, then the prompt's response.
    fn replay(fixture: &str) -> Vec<AgentEvent> {
        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)), WINDOW);
        let mut out = Vec::new();
        let mut session: Option<String> = None;

        for line in fixture.lines().filter_map(|l| l.strip_prefix("<< ")) {
            let value: Value = serde_json::from_str(line).unwrap();

            if session.is_none() {
                if let Some(id) = value.pointer("/result/sessionId").and_then(Value::as_str) {
                    session = Some(id.to_string());
                    continue;
                }
            }

            match value.get("method").and_then(Value::as_str) {
                Some(method) => {
                    let Ok(note) =
                        super::super::parser::parse_notification(method, value["params"].clone())
                    else {
                        continue;
                    };
                    // The rule the whole harness rests on: a subagent's
                    // transcript rides this pipe under the child's own id.
                    if Some(&note.session_id) != session.as_ref() {
                        continue;
                    }
                    out.extend(mapper.map(GrokEvent::Update(note.update)));
                }
                None => {
                    if value.pointer("/result/stopReason").is_some() {
                        let response: PromptResponse =
                            serde_json::from_value(value["result"].clone()).unwrap();
                        out.extend(mapper.map(GrokEvent::PromptDone(Box::new(response))));
                    }
                }
            }
        }
        out
    }

    fn tool_starts(events: &[AgentEvent]) -> Vec<(&str, ToolType)> {
        events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallStarted { name, tool_type, .. } => Some((name.as_str(), *tool_type)),
                _ => None,
            })
            .collect()
    }

    fn results(events: &[AgentEvent]) -> Vec<&ToolResult> {
        events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallCompleted { result, .. } => Some(result),
                _ => None,
            })
            .collect()
    }

    /// The whole lifecycle at its smallest: a turn opens on the first chunk,
    /// both calls draw as what they are and close, and the turn ends with an
    /// occupancy on it.
    #[test]
    fn a_live_turn_maps_to_one_exchange() {
        let events = replay(LIVE_TURN);

        assert!(matches!(events[0].payload, P::TurnStarted(_)));
        assert!(matches!(events[1].payload, P::ModelRequestStarted));

        assert_eq!(
            tool_starts(&events),
            [
                ("write", ToolType::FileEdit),
                ("run_terminal_command", ToolType::Shell)
            ]
        );

        let results = results(&events);
        assert_eq!(results.len(), 2);
        // The write's answer is its diff, which the row draws — grok's own
        // "has been created" sentence beside it says the title again.
        assert_eq!(results[0].text, "");
        // The shell's is its stdout with grok's `exit: 0` header cut. The
        // capture ran `wc -c`, so two bytes of "hi" is the honest answer.
        assert_eq!(results[1].text.trim_end(), "       2 hello.txt");
        assert_eq!(results[1].exit_code, Some(0));

        let P::TurnCompleted { usage, status, .. } = &events.last().unwrap().payload else {
            panic!("the turn closes on the prompt's reply");
        };
        assert_eq!(*status, TurnStatus::Success);
        let window = usage.as_ref().unwrap().context_window.unwrap();
        assert!(window.used_tokens > 0);
        assert_eq!(window.max_tokens, WINDOW);
    }

    /// Stop leaves **the call it killed** with no terminal update at all — the
    /// last word on that one is `in_progress` — so the mapper closes the *turn*
    /// and mints nothing for it. The transcript's own abandoned stand-in is what
    /// settles the row, one rule for every harness.
    ///
    /// A sibling that was already running is the other half, and it is why this
    /// cannot be "a cancelled turn answers no results": the capture's `read_file`
    /// lands its result **after** the shell has gone `in_progress`, so grok
    /// flushes what finished rather than dropping the turn's work whole.
    #[test]
    fn a_cancelled_turn_closes_the_turn_and_leaves_its_call_open() {
        let events = replay(CANCEL);

        let started: Vec<&str> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallStarted { call_id, .. } => Some(call_id.as_str()),
                _ => None,
            })
            .collect();
        let answered: Vec<&str> = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::ToolCallCompleted { call_id, .. } => Some(call_id.as_str()),
                _ => None,
            })
            .collect();

        assert_eq!(started.len(), 2, "both calls draw");
        assert_eq!(
            answered,
            [started[0]],
            "the sibling still answers and the killed call never does"
        );

        let P::TurnCompleted { status, stop_reason, .. } = &events.last().unwrap().payload else {
            panic!("the prompt still answers");
        };
        // A Stop is the reader's own, not a failure.
        assert_eq!(*status, TurnStatus::Success);
        assert_eq!(stop_reason.as_deref(), Some("cancelled"));
    }

    /// `ask_user_question` is a client *request*, so nothing about the question
    /// reaches the mapper — but its tool row does, and it must draw as a tool
    /// rather than as an edit or a shell.
    #[test]
    fn the_question_tool_draws_a_row_of_its_own() {
        let events = replay(ASK_USER);

        let asked = tool_starts(&events)
            .into_iter()
            .find(|(name, _)| *name == "ask_user_question");
        assert_eq!(asked, Some(("ask_user_question", ToolType::Other)));
    }

    /// A backgrounded shell opens a run and closes it when grok stops listing
    /// it, because the count alone sent the reader to an empty panel: the
    /// indicator's click opens the subagent pane, which draws runs and knows
    /// nothing of `BackgroundTasksChanged`.
    ///
    /// Hand-written, since no capture here backgrounds anything — grok
    /// republishes the whole set on every change, which is the half worth
    /// pinning: the close is inferred from an id going missing.
    #[test]
    fn a_background_task_is_a_run_the_panel_can_draw() {
        const TASKS: &str = concat!(
            "<< {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"sessionId\":\"s\"}}\n",
            "<< {\"jsonrpc\":\"2.0\",\"method\":\"_x.ai/session_notification\",\"params\":",
            "{\"sessionId\":\"s\",\"update\":{\"sessionUpdate\":\"background_tasks\",\"tasks\":",
            "[{\"task_id\":\"t1\",\"command\":\"pnpm dev\",\"kind\":\"bash\"}]}}}\n",
            "<< {\"jsonrpc\":\"2.0\",\"method\":\"_x.ai/session_notification\",\"params\":",
            "{\"sessionId\":\"s\",\"update\":{\"sessionUpdate\":\"background_tasks\",\"tasks\":[]}}}\n",
        );
        let events = replay(TASKS);

        let lifecycle: Vec<(&str, &str)> = events
            .iter()
            .filter_map(|e| {
                let id = e.subagent.as_ref()?.id.as_str();
                match &e.payload {
                    P::SubagentStarted { agent_id, .. } => Some((id, agent_id.as_str())),
                    P::SubagentCompleted { agent_id, .. } => Some((id, agent_id.as_str())),
                    _ => None,
                }
            })
            .collect();
        assert_eq!(
            lifecycle,
            vec![("t1", ""), ("t1", "")],
            "the task opens a run and the set losing it closes that same run, and \
             neither end names a handle — grok publishes no per-task cancel, so a \
             Stop drawn here would reach Claude Code's control line"
        );

        // The list itself still goes out: it is what the indicator counts and
        // what `has_outstanding_work` reads.
        let published = events.iter().filter(|e| {
            matches!(&e.payload, P::BackgroundTasksChanged { .. })
        });
        assert_eq!(published.count(), 2);
    }

    /// Both ends of a run are enveloped on the **spawning call's** id, which is
    /// what `buildTranscript` correlates on (`callById.get(run.id)`). grok
    /// names the child on every lifecycle line and nothing anywhere joins it to
    /// the call, so filing under the child handle — which is what this did
    /// first — left the panel a run with no spawn behind it and the chat a
    /// plain tool row. Pinned by the two ids being different in the capture.
    #[test]
    fn a_run_is_filed_under_the_call_that_asked_for_it() {
        let events = replay(SUBAGENT);

        let spawn = events
            .iter()
            .find_map(|e| match &e.payload {
                P::ToolCallStarted { call_id, tool_type: ToolType::SubagentSpawn, .. } => {
                    Some(call_id.clone())
                }
                _ => None,
            })
            .expect("the capture opens a spawn_subagent call");
        assert!(spawn.starts_with("call-"), "the join must be the call id, not the child's");

        let filed: Vec<&str> = events
            .iter()
            .filter(|e| {
                matches!(e.payload, P::SubagentStarted { .. } | P::SubagentCompleted { .. })
            })
            .filter_map(|e| Some(e.subagent.as_ref()?.id.as_str()))
            .collect();
        assert_eq!(filed, vec![spawn.as_str(), spawn.as_str()], "one run, opened and closed");
    }

    /// A child's whole transcript rides the parent's pipe under its own session
    /// id — 113 updates in the capture — and dropping them is what keeps the
    /// child's thinking out of the parent's chat. What is kept is the
    /// lifecycle, whose `output` is the child's entire report.
    #[test]
    fn a_subagent_reports_through_its_lifecycle_and_never_through_its_stream() {
        let events = replay(SUBAGENT);

        let started = events
            .iter()
            .find_map(|e| match &e.payload {
                P::SubagentStarted { agent_id, label, description, .. } => {
                    Some((agent_id.clone(), label.clone(), description.clone()))
                }
                _ => None,
            })
            .expect("the spawn is announced");
        assert!(
            started.0.is_empty(),
            "grok publishes no subagent cancel, so a run must name no handle a Stop could send"
        );
        assert_eq!(started.1, "general-purpose");

        let finished = events
            .iter()
            .find_map(|e| match &e.payload {
                P::SubagentCompleted { summary, status, .. } => Some((summary.clone(), status.clone())),
                _ => None,
            })
            .expect("the run is closed");
        assert_eq!(finished.1, "completed");
        assert!(finished.0.is_some_and(|s| !s.is_empty()));

        // Nothing the child streamed became a chat row. Matched on the child's
        // own opening sentence and deliberately **not** on what it found: the
        // parent reports those names back itself ("The explore subagent
        // reported: **alpha.txt, beta.md**"), so a filename is a word both
        // sides say and asserting on one would pass with the filter removed.
        let chat: String = events
            .iter()
            .filter_map(|e| match &e.payload {
                P::AssistantText { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            !chat.contains("I'll list the workspace root"),
            "the child's own narration must not arrive as the parent's message"
        );
        assert!(
            chat.contains("The explore subagent reported"),
            "the parent's own report still draws"
        );
    }

    /// Compaction is one event with no start and no boundary, and the figure it
    /// leaves has to become the newest occupancy: the turn that ran `/compact`
    /// answers `totalTokens: 0`, so a ring reading the log back would otherwise
    /// find nothing but that zero.
    #[test]
    fn compaction_publishes_what_it_left_and_a_zero_never_reaches_the_ring() {
        let mut mapper = Mapper::new("s".into(), Arc::new(AtomicU64::new(0)), WINDOW);

        // A first turn establishes a reading.
        let first: PromptResponse = serde_json::from_value(json_meta(21877)).unwrap();
        mapper.map(GrokEvent::PromptDone(Box::new(first)));

        let compacted: GrokUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": "auto_compact_completed",
            "tokens_before": 21877, "tokens_after": 9000, "summary_preview": null,
        }))
        .unwrap();
        let events = mapper.map(GrokEvent::Update(compacted));
        assert!(matches!(
            events[0].payload,
            P::ContextCompacted { post_tokens: Some(9000), .. }
        ));

        // The compacting turn's own reply reads zero. The ring must keep what
        // compaction left rather than snapping to empty.
        let zeroed: PromptResponse = serde_json::from_value(json_meta(0)).unwrap();
        let out = mapper.map(GrokEvent::PromptDone(Box::new(zeroed)));
        let P::TurnCompleted { usage, .. } = &out.last().unwrap().payload else {
            panic!("a turn ends");
        };
        assert_eq!(
            usage.as_ref().unwrap().context_window.unwrap().used_tokens,
            9000
        );
    }

    fn json_meta(total: u64) -> Value {
        serde_json::json!({
            "stopReason": "end_turn",
            "_meta": {"totalTokens": total, "inputTokens": 21830, "outputTokens": 10},
        })
    }

    /// grok prefixes a shell result with its own exit line, which the row
    /// already draws in its own slot — but a command that prints one itself
    /// must keep it.
    #[test]
    fn the_exit_header_is_cut_and_a_command_that_prints_one_keeps_it() {
        assert_eq!(strip_exit_line("exit: 0\nhello\n"), "hello\n");
        assert_eq!(strip_exit_line("exit: 127\n"), "");
        assert_eq!(strip_exit_line("exit: soon\nhello"), "exit: soon\nhello");
        assert_eq!(strip_exit_line("no header here"), "no header here");
    }

    /// grok's own `_meta` class wins over ACP's, which arrives a line late and
    /// calls both of the calls whose row depends on it `other`.
    #[test]
    fn the_tool_class_is_read_off_groks_own_meta() {
        assert_eq!(
            tool_type(Some("task"), "spawn_subagent", ToolKind::Other),
            ToolType::SubagentSpawn
        );
        assert_eq!(
            tool_type(Some("execute"), "run_terminal_command", ToolKind::Other),
            ToolType::Shell
        );
        // No `_meta` at all: the name, then ACP's kind.
        assert_eq!(tool_type(None, "read_file", ToolKind::Other), ToolType::FileRead);
        assert_eq!(tool_type(None, "whatever", ToolKind::Execute), ToolType::Shell);
        assert_eq!(tool_type(None, "whatever", ToolKind::Other), ToolType::Other);
    }
}
