//! Codex's vocabulary onto Dray's.
//!
//! One notification can be several events — an `agentMessage` closing is both
//! the end of its streamed block and the committed text that supersedes it — so
//! this returns a `Vec` where [`claude_code::mapper`](crate::harness::claude_code::mapper)
//! returns an `Option`.
//!
//! Two events are synthesized rather than read, and both are noted where they
//! are minted: Codex sends no "requesting" ping and no user-message echo Dray
//! can use.

use crate::events::{
    usage::ContextWindow, AgentEvent, AgentEventPayload, BlockRef, BlockType, DeltaEvent, FileEdit,
    ImageRef, SessionInfo, Subagent, ToolResult, ToolType, TurnStatus, Usage,
};
use crate::harness::Harness;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use uuid::Uuid;

use super::parser::{
    CodexEvent, DeltaNotification, ErrorNotification, FileChangeEntry, ItemNotification, ItemStatus,
    PlanNotification, ThreadItem, TokenUsageNotification, TurnNotification,
    TurnStatus as CodexTurnStatus,
    WebSearchResult,
};

/// Per-session state the mapping needs across lines.
pub struct Mapper {
    /// Dray's own id, never Codex's thread id. Every event the frontend routes
    /// is keyed on this, and the two are only joined on the index entry.
    session_id: String,
    seq: Arc<AtomicU64>,
    /// The open turn, so events inside it can name it. Codex is the first
    /// harness to give Dray this at all.
    turn_id: Option<String>,
    /// The newest occupancy reading, folded onto the turn's own
    /// `TurnCompleted` — the composer's ring reads it back out of the log, and
    /// `thread/tokenUsage/updated` is not persisted.
    occupancy: Option<ContextWindow>,
    /// Item ids currently open as a streamed block, so a delta for an item we
    /// never saw start cannot mint a block the transcript has no header for.
    open_blocks: std::collections::HashSet<String>,
    /// How many times the plan has been rewritten. Part of the synthesized
    /// call id, so each rewrite is its own row rather than one row that
    /// changes under a reader scrolling back through the turn.
    plan_updates: u64,
    /// Every thread known to belong to a subagent, and the run it is.
    ///
    /// A Codex subagent is a **whole second thread on the same connection** —
    /// it sends its own `turn/started`, items, deltas, token usage and
    /// `turn/completed`, all indistinguishable from the main conversation's
    /// except by `threadId`. So this is what keeps a subagent's answer out of
    /// the transcript, its usage out of the context ring, and its turn ending
    /// out of the session's status.
    ///
    /// Keyed by `agentThreadId` and **not** by the activity's own `id`: the
    /// `started` activity carries the spawning call's id where `completed`
    /// carries a synthetic `subagent-completed-<uuid>`, so the two ids never
    /// match and a run joined on them would never close.
    ///
    /// Populated only by the server telling us, so a thread we were not told
    /// about reads as the main conversation — the safe direction, since the
    /// main thread is the one the reader is actually having.
    subagent_threads: std::collections::HashMap<String, Subagent>,
    /// The run the line being mapped belongs to, or `None` for the main
    /// conversation. Set once per line in [`Self::map`] so no arm has to
    /// remember to ask.
    current: Option<Subagent>,
    /// Calls whose `item/started` drew no row, so their `item/completed` must
    /// not draw a result. Kept rather than re-deriving the same condition on
    /// the way out, because the two notifications need not carry identical
    /// fields — `wait` populates `receiverThreadIds` on neither, but a shape
    /// that filled it in only on completion would close a row nobody opened.
    silent_calls: std::collections::HashSet<String>,
}

impl Mapper {
    pub fn new(session_id: String, seq: Arc<AtomicU64>) -> Self {
        Self {
            session_id,
            seq,
            turn_id: None,
            occupancy: None,
            open_blocks: std::collections::HashSet::new(),
            plan_updates: 0,
            subagent_threads: std::collections::HashMap::new(),
            current: None,
            silent_calls: std::collections::HashSet::new(),
        }
    }

    pub fn map(&mut self, event: CodexEvent) -> Vec<AgentEvent> {
        // Whose conversation this line belongs to, resolved once for every arm
        // below and for `event()`, which stamps it onto the envelope. Read
        // before the match so a kind added later cannot forget to ask.
        self.current = event
            .thread_id()
            .and_then(|thread| self.subagent_threads.get(thread))
            .cloned();

        // A subagent's turn is not the session's. Its `turn/completed` reaching
        // `StatusTracker` marked the whole session finished while the main turn
        // was still running, and its usage overwrote the context ring — so both
        // are dropped rather than mapped. What the reader sees of the run is
        // its items, which still map and are filed into the panel by the
        // envelope.
        if self.current.is_some() {
            match event {
                CodexEvent::TurnStarted(_)
                | CodexEvent::TurnCompleted(_)
                | CodexEvent::TokenUsage(_) => return Vec::new(),
                _ => {}
            }
        }

        match event {
            CodexEvent::TurnStarted(turn) => self.turn_started(turn),
            CodexEvent::TurnCompleted(turn) => self.turn_completed(turn),
            CodexEvent::ItemStarted(item) => self.item_started(item),
            CodexEvent::ItemCompleted(item) => self.item_completed(item),
            CodexEvent::Delta(delta) => self.delta(delta),
            CodexEvent::TokenUsage(usage) => self.token_usage(usage),
            CodexEvent::Error(err) => self.error(err),
            CodexEvent::PlanUpdated(plan) => self.plan_updated(plan),
            CodexEvent::Ignored | CodexEvent::Unknown => Vec::new(),
        }
    }

    fn turn_started(&mut self, turn: TurnNotification) -> Vec<AgentEvent> {
        self.turn_id = Some(turn.turn.id.clone());

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
            // Codex has no `status: requesting`. Without one minted here the
            // working indicator would fire once and never again, which is the
            // exact bug CLAUDE.md describes fixing for Claude: an indicator
            // that could only ever describe a turn's *first* wait.
            self.event(AgentEventPayload::ModelRequestStarted),
        ]
    }

    fn turn_completed(&mut self, turn: TurnNotification) -> Vec<AgentEvent> {
        let usage = self.occupancy.take().map(|window| Usage {
            context_window: Some(window),
            ..Default::default()
        });

        let (status, stop_reason, final_text) = match turn.turn.status {
            // The user's own Stop. Reported as a success carrying a reason
            // nothing draws, the same way Claude's `aborted_*` are: telling a
            // reader their own interrupt failed is noise.
            CodexTurnStatus::Interrupted => {
                (TurnStatus::Success, Some("interrupted".to_string()), None)
            }
            CodexTurnStatus::Failed => (
                TurnStatus::Error,
                turn.turn
                    .error
                    .as_ref()
                    .and_then(|e| e.codex_error_info.as_ref())
                    .map(error_kind),
                // The sentence the row draws. Codex writes a real one —
                // "You've hit your usage limit", "Not logged in" — and the
                // wire token beside it says nothing to a reader.
                turn.turn.error.as_ref().map(|e| e.message.clone()),
            ),
            _ => (TurnStatus::Success, None, None),
        };

        let event = self.event(AgentEventPayload::TurnCompleted {
            status,
            stop_reason,
            final_text,
            usage,
            duration_ms: turn.turn.duration_ms,
            // Filled by `session::ingest`, which is the only layer that knows
            // the session's tree.
            head: None,
        });

        self.turn_id = None;
        vec![event]
    }

    fn item_started(&mut self, started: ItemNotification) -> Vec<AgentEvent> {
        match started.item {
            // Dropped, and this is the one mapping that would double something
            // visible. Codex echoes our prompt back as an item; Dray already
            // minted its own carrying the tree baseline, the images and the
            // issue links, none of which the echo has.
            ThreadItem::UserMessage { .. } => Vec::new(),

            ThreadItem::AgentMessage { id, .. } => {
                self.open_blocks.insert(id.clone());
                vec![self.event(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                    block: block_ref(&id),
                    block_type: BlockType::Text,
                }))]
            }

            ThreadItem::Reasoning { id, .. } => {
                self.open_blocks.insert(id.clone());
                vec![self.event(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                    block: block_ref(&id),
                    block_type: BlockType::Thinking,
                }))]
            }

            ThreadItem::CommandExecution { id, command, .. } => {
                // `cwd` deliberately not carried. It is on the wire for every
                // call and it is the session's own directory on nearly all of
                // them, so putting it in `input` gave every shell row an
                // expanded body holding one obvious line of JSON — noise on the
                // most common row in the transcript. The command is the whole
                // input, and it is already the title.
                // A skill names itself, and the invocation is the wrong label
                // for it: the row would read `Read Skill /bin/zsh -lc "sed -n
                // '1,240p' …`, which is the machinery rather than the thing.
                // `title` is left unset so the row falls through to
                // `toolSummary`, which reads `skill` — the same path Claude's
                // own skill rows take.
                let skill = skill_name(&command);
                vec![self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id,
                    name: match &skill {
                        Some(_) => "Skill".to_string(),
                        None => "shell".to_string(),
                    },
                    tool_type: ToolType::Shell,
                    input: match &skill {
                        Some(name) => json!({"skill": name, "command": command}),
                        None => json!({"command": command}),
                    },
                    raw_input: None,
                    title: skill.is_none().then_some(command),
                })]
            }

            ThreadItem::FileChange { id, changes, .. } => {
                let started = self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id.clone(),
                    // The verb follows what was done to the file, so a new file
                    // reads "Created notes.md" rather than "Edited" — a patch
                    // that adds a file has no previous version to have edited.
                    // `kind` used to reach the reader as the bare wire word
                    // "update" sitting at the end of the row, which named the
                    // distinction without making it mean anything.
                    name: edit_tool_name(&changes),
                    tool_type: ToolType::FileEdit,
                    // One path per call is the common case, so it goes on
                    // `file_path` — the key every path-reading surface already
                    // looks at, which is what makes the row title itself and
                    // the group count files. The list stays beside it for the
                    // multi-file patch.
                    input: match changes.as_slice() {
                        [one] => json!({"file_path": one.path}),
                        many => json!({
                            "paths": many.iter().map(|c| &c.path).collect::<Vec<_>>()
                        }),
                    },
                    raw_input: None,
                    title: Some(edit_title(&changes)),
                });
                // `FileEdits` exists for exactly this and Claude never emits
                // one: Codex hands over a real unified diff per file, where
                // `Edit` carries only the fragment it replaced.
                let edits = self.event(AgentEventPayload::FileEdits {
                    call_id: Some(id),
                    edits: changes.iter().map(file_edit).collect(),
                });
                vec![started, edits]
            }

            // Both search routes open the same row. The native item arrives
            // with `query: ""` — everything lands on completion — so the
            // header has nothing to say yet and the title falls back to the
            // tool's own name rather than drawing an empty string.
            ThreadItem::WebSearch { id, query, .. } => {
                vec![self.search_started(id, query)]
            }
            ThreadItem::Extension {
                id, kind, query, ..
            } if is_web_search(&kind) => {
                vec![self.search_started(id, query.unwrap_or_default())]
            }

            ThreadItem::ImageView { id, path } => {
                let shown = display_path(&path);
                vec![self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id,
                    name: "view_image".to_string(),
                    tool_type: ToolType::FileRead,
                    input: json!({"path": shown}),
                    raw_input: None,
                    title: Some(shown),
                })]
            }

            ThreadItem::McpToolCall {
                id,
                server,
                tool,
                arguments,
                ..
            } => {
                vec![self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id,
                    name: tool.clone(),
                    tool_type: ToolType::Mcp,
                    input: arguments.unwrap_or(json!({})),
                    raw_input: None,
                    // Server first, the shape Claude's MCP rows already use, so
                    // one tool name appearing on two servers stays legible.
                    title: Some(format!("{server} · {tool}")),
                })]
            }

            // The model talking to an agent it already started, and mostly
            // that is `wait` — blocking on a run whose own row and panel entry
            // are already on screen. It carries `prompt: null` and no
            // receivers, so the row read `wait wait` and said nothing twice.
            //
            // Gated on having something to say rather than on the name: a call
            // that hands a brief to a named agent is a real row, and the day
            // Codex sends one it should draw without a change here.
            ThreadItem::CollabAgentToolCall {
                id,
                tool,
                prompt,
                receiver_thread_ids,
                ..
            } => {
                if prompt.is_none() && receiver_thread_ids.is_empty() {
                    self.silent_calls.insert(id);
                    return Vec::new();
                }

                vec![self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id,
                    name: tool.clone(),
                    tool_type: ToolType::SubagentSpawn,
                    input: json!({"description": prompt}),
                    raw_input: None,
                    title: Some(tool),
                })]
            }

            // The spawn row, and the registration that files everything the
            // subagent goes on to say.
            //
            // This *is* the spawn: the call never arrives as a
            // `collabAgentToolCall` — the only one of those in the capture is
            // `wait` — so without this arm there is no row for the run at all.
            //
            // `item/started` and `item/completed` both carry the same activity,
            // so registering happens here and closing on the `completed` kind,
            // not on the completed *notification*.
            ThreadItem::SubAgentActivity {
                id,
                kind,
                agent_thread_id,
                agent_path,
            } => self.subagent_activity(id, kind, agent_thread_id, agent_path),

            ThreadItem::ContextCompaction { .. } => {
                vec![self.event(AgentEventPayload::ContextCompactionStarted)]
            }

            ThreadItem::Extension { .. } | ThreadItem::Other => Vec::new(),
        }
    }

    /// The opening row both web-search routes share.
    fn search_started(&mut self, id: String, query: String) -> AgentEvent {
        let has_query = !query.is_empty();
        self.event(AgentEventPayload::ToolCallStarted {
            call_id: id,
            name: "web_search".to_string(),
            tool_type: ToolType::Web,
            input: json!({"query": query.clone()}),
            raw_input: None,
            title: has_query.then_some(query),
        })
    }

    fn item_completed(&mut self, done: ItemNotification) -> Vec<AgentEvent> {
        match done.item {
            ThreadItem::UserMessage { .. } | ThreadItem::Other => Vec::new(),

            ThreadItem::AgentMessage { id, text, .. } => {
                let mut out = self.close_block(&id);
                out.push(self.event(AgentEventPayload::AssistantText {
                    block: Some(block_ref(&id)),
                    text,
                }));
                out
            }

            ThreadItem::Reasoning {
                id,
                summary,
                content,
            } => {
                let mut out = self.close_block(&id);
                // Summaries where the model emits them, raw blocks where it
                // does not. A reader cannot tell the two apart and shouldn't.
                let text = if summary.is_empty() {
                    content.join("\n\n")
                } else {
                    summary.join("\n\n")
                };
                out.push(self.event(AgentEventPayload::Reasoning {
                    block: Some(block_ref(&id)),
                    // `encrypted` is the existing "reasoning happened, there is
                    // nothing to show" flag. Claude never sets it; a Codex model
                    // that reasons without emitting a summary is what it was for.
                    encrypted: text.is_empty(),
                    text,
                }));
                out
            }

            ThreadItem::CommandExecution {
                id,
                status,
                aggregated_output,
                exit_code,
                duration_ms,
                ..
            } => {
                let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: id,
                    result: ToolResult {
                        text: aggregated_output.unwrap_or_default(),
                        is_error: status != ItemStatus::Completed,
                        structured: None,
                        exit_code: exit_code.map(|code| code as i32),
                        duration_ms,
                        images: Vec::new(),
                    },
                })];
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            ThreadItem::FileChange { id, status, .. } => {
                let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: id,
                    result: ToolResult {
                        text: String::new(),
                        is_error: status != ItemStatus::Completed,
                        structured: None,
                        exit_code: None,
                        duration_ms: None,
                        images: Vec::new(),
                    },
                })];
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            ThreadItem::WebSearch {
                id, query, results, ..
            } => self.search_completed(id, query, results),
            ThreadItem::Extension {
                id,
                kind,
                query,
                results,
            } if is_web_search(&kind) => {
                self.search_completed(id, query.unwrap_or_default(), results)
            }

            // The image is the whole answer, so the row has to carry it rather
            // than say a file was read. `ImageRef` holds the path; the session
            // layer copies it into the session's own attachments directory,
            // since a screenshot under `/tmp` outlives nothing.
            ThreadItem::ImageView { id, path } => {
                let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: id,
                    result: ToolResult {
                        text: String::new(),
                        is_error: false,
                        structured: None,
                        exit_code: None,
                        duration_ms: None,
                        images: vec![ImageRef {
                            path: Some(display_path(&path)),
                            url: None,
                            mime_type: None,
                        }],
                    },
                })];
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            ThreadItem::McpToolCall {
                id,
                status,
                result,
                error,
                ..
            } => {
                let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
                    call_id: id,
                    result: ToolResult {
                        text: mcp_text(result.as_ref(), error.as_ref()),
                        is_error: status != ItemStatus::Completed || error.is_some(),
                        structured: result,
                        exit_code: None,
                        duration_ms: None,
                        images: Vec::new(),
                    },
                })];
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            ThreadItem::CollabAgentToolCall { id, status, .. } => {
                // The working indicator reopens either way — the wait ending is
                // the main agent picking up again — but a call that drew no row
                // must not be answered, or the transcript closes a row that was
                // never opened.
                let drawn = !self.silent_calls.remove(&id);
                let mut out = Vec::new();
                if drawn {
                    out.push(self.event(AgentEventPayload::ToolCallCompleted {
                        call_id: id,
                        result: ToolResult {
                            text: String::new(),
                            is_error: status != ItemStatus::Completed,
                            structured: None,
                            exit_code: None,
                            duration_ms: None,
                            images: Vec::new(),
                        },
                    }));
                }
                out.push(self.event(AgentEventPayload::ModelRequestStarted));
                out
            }

            // Handled on `item/started`, which carries the identical activity —
            // acting on both would draw the spawn row twice and close the run
            // before its own events had arrived.
            ThreadItem::SubAgentActivity { .. } | ThreadItem::Extension { .. } => Vec::new(),

            ThreadItem::ContextCompaction { .. } => {
                // Codex reports no before/after counts. Every one is already
                // `Option`, so the panel drops the saving line rather than
                // drawing a wrong one.
                vec![self.event(AgentEventPayload::ContextCompacted {
                    trigger: None,
                    pre_tokens: None,
                    post_tokens: None,
                    duration_ms: None,
                })]
            }
        }
    }

    /// A subagent starting or finishing.
    ///
    /// `started` opens the run: it registers the agent's thread so everything
    /// that thread goes on to send is filed under this call, and draws the row
    /// the panel selects by. `completed` closes it.
    ///
    /// **Looked up by thread, never by the activity's own id.** `started`
    /// carries the spawning call's id; `completed` carries a synthetic
    /// `subagent-completed-<uuid>`. The two never match, so a run joined on
    /// them would sit open forever — and silently, since an unclosed run just
    /// keeps shimmering.
    fn subagent_activity(
        &mut self,
        id: String,
        kind: Option<String>,
        agent_thread_id: Option<String>,
        agent_path: Option<String>,
    ) -> Vec<AgentEvent> {
        let Some(thread) = agent_thread_id else {
            // Nothing to file work under. The row would be a card that never
            // fills, so it is not drawn at all.
            return Vec::new();
        };

        match kind.as_deref() {
            Some("started") => {
                let label = agent_name(agent_path.as_deref());
                self.subagent_threads.insert(
                    thread,
                    Subagent {
                        id: id.clone(),
                        label: Some(label.clone()),
                    },
                );

                vec![self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id,
                    name: "spawn_agent".to_string(),
                    tool_type: ToolType::SubagentSpawn,
                    input: json!({"description": label}),
                    raw_input: None,
                    title: Some(label),
                })]
            }

            Some("completed") | Some("failed") => {
                let failed = kind.as_deref() == Some("failed");
                // The run's own id, not this activity's.
                let Some(run) = self.subagent_threads.get(&thread).cloned() else {
                    return Vec::new();
                };

                let mut settle = self.event(AgentEventPayload::SubagentCompleted {
                    agent_id: thread,
                    status: if failed { "failed" } else { "completed" }.to_string(),
                    summary: None,
                    // Codex reports the subagent's tokens on its own thread, and
                    // that reading is dropped rather than folded into the
                    // session's. Reporting it here would put a second figure
                    // beside the ring it was deliberately kept out of.
                    usage: None,
                });
                // Stamped by hand: the activity rides the **main** thread, so
                // `current` is `None` here. Without the envelope the frontend
                // never matches it to a run, `done` stays false, and a finished
                // subagent shimmers for the rest of the session.
                settle.subagent = Some(run.clone());

                vec![
                    settle,
                    self.event(AgentEventPayload::ToolCallCompleted {
                        call_id: run.id,
                        result: ToolResult {
                            text: String::new(),
                            is_error: failed,
                            structured: None,
                            exit_code: None,
                            duration_ms: None,
                            images: Vec::new(),
                        },
                    }),
                ]
            }

            // A kind we have not seen. The run is already registered, so its
            // work still files correctly; this just draws no row.
            _ => Vec::new(),
        }
    }

    /// The model's plan, drawn as a tool call that opens and closes at once.
    ///
    /// `update_plan` is the one tool with no item of its own — this
    /// notification is its only trace — so without a synthesized pair the
    /// reader sees the agent go quiet and then act on a plan they were never
    /// shown. Both halves are minted here because there is no second line
    /// coming to close it.
    ///
    /// The id carries the turn and a counter: a plan is rewritten several times
    /// a turn, and each rewrite is its own row rather than one row that changes
    /// underneath the reader as they scroll back through it.
    fn plan_updated(&mut self, plan: PlanNotification) -> Vec<AgentEvent> {
        self.plan_updates += 1;
        let turn = plan.turn_id.as_deref().unwrap_or("turn");
        let call_id = format!("plan:{turn}:{}", self.plan_updates);

        let steps: Vec<_> = plan
            .plan
            .iter()
            .map(|s| json!({"step": s.step, "status": s.status}))
            .collect();

        // The model's own sentence where it wrote one, a count otherwise. A
        // plan's steps are the body, not the label.
        let title = plan
            .explanation
            .clone()
            .filter(|e| !e.trim().is_empty())
            .unwrap_or_else(|| match steps.len() {
                1 => "1 step".to_string(),
                n => format!("{n} steps"),
            });

        vec![
            self.event(AgentEventPayload::ToolCallStarted {
                call_id: call_id.clone(),
                name: "update_plan".to_string(),
                tool_type: ToolType::Other,
                input: json!({"explanation": plan.explanation, "plan": steps}),
                raw_input: None,
                title: Some(title),
            }),
            self.event(AgentEventPayload::ToolCallCompleted {
                call_id,
                result: ToolResult {
                    text: String::new(),
                    is_error: false,
                    structured: None,
                    exit_code: None,
                    duration_ms: None,
                    images: Vec::new(),
                },
            }),
        ]
    }

    /// The closing row both web-search routes share.
    ///
    /// Results are flattened to text rather than kept as structured data: the
    /// expander renders a tool result's text, and a card that listed hits would
    /// be a surface of its own. Title and URL per line, which is what a reader
    /// following one up needs.
    fn search_completed(
        &mut self,
        id: String,
        query: String,
        results: Vec<WebSearchResult>,
    ) -> Vec<AgentEvent> {
        let text = results
            .iter()
            .map(|r| {
                let title = r.title.as_deref().unwrap_or("untitled");
                match r.url.as_deref() {
                    Some(url) => format!("{title}\n{url}"),
                    None => title.to_string(),
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let mut out = vec![self.event(AgentEventPayload::ToolCallCompleted {
            call_id: id.clone(),
            result: ToolResult {
                text,
                is_error: false,
                structured: None,
                exit_code: None,
                duration_ms: None,
                images: Vec::new(),
            },
        })];

        // The started row had no query on it — the native item sends `""` and
        // fills everything in on completion — so the header would stay bare
        // without this.
        if !query.is_empty() {
            out.insert(
                0,
                self.event(AgentEventPayload::ToolCallStarted {
                    call_id: id,
                    name: "web_search".to_string(),
                    tool_type: ToolType::Web,
                    input: json!({"query": query.clone()}),
                    raw_input: None,
                    title: Some(query),
                }),
            );
        }

        out.push(self.event(AgentEventPayload::ModelRequestStarted));
        out
    }

    fn delta(&mut self, delta: DeltaNotification) -> Vec<AgentEvent> {
        // A delta for an item that never opened would mint a block with no
        // header. Dropped rather than guessed at: deltas are a preview, and the
        // committed item still draws the whole text.
        if !self.open_blocks.contains(&delta.item_id) {
            return Vec::new();
        }

        vec![self.event(AgentEventPayload::Delta(DeltaEvent::TextDelta {
            block: block_ref(&delta.item_id),
            text: delta.delta,
        }))]
    }

    fn token_usage(&mut self, usage: TokenUsageNotification) -> Vec<AgentEvent> {
        let counts = usage.token_usage.last;
        let window = match (counts, usage.token_usage.model_context_window) {
            // `last`, never `total`: `total` sums every model call in the turn,
            // so on a three-call turn it reads three times the real occupancy.
            (Some(counts), Some(max)) if max > 0 => Some(ContextWindow {
                used_tokens: counts.total_tokens,
                max_tokens: max,
            }),
            _ => None,
        };

        if window.is_some() {
            self.occupancy = window.clone();
        }

        vec![self.event(AgentEventPayload::UsageUpdate(Usage {
            input_tokens: counts.map(|c| c.input_tokens),
            output_tokens: counts.map(|c| c.output_tokens),
            cached_input_tokens: counts.map(|c| c.cached_input_tokens),
            reasoning_tokens: counts.map(|c| c.reasoning_output_tokens),
            total_tokens: counts.map(|c| c.total_tokens),
            context_window: window,
            ..Default::default()
        }))]
    }

    fn error(&mut self, err: ErrorNotification) -> Vec<AgentEvent> {
        if err.will_retry {
            return vec![self.event(AgentEventPayload::ApiRetry {
                // Codex reports neither an attempt number nor a ceiling, where
                // Claude carries both. Zero is the existing "unknown" for the
                // ceiling; the indicator reads it as an uncounted retry.
                attempt: 0,
                max_retries: 0,
                status: None,
                reason: err.error.codex_error_info.as_ref().map(error_kind),
            })];
        }

        vec![self.event(AgentEventPayload::Error {
            source: crate::events::ErrorSource::Harness,
            message: err.error.message,
            fatal: false,
        })]
    }

    /// Closes a streamed block, if one was open.
    ///
    /// Returns nothing when the item never opened — which happens for real: an
    /// item that completes in one frame emits no `item/started` we saw first.
    fn close_block(&mut self, item_id: &str) -> Vec<AgentEvent> {
        if !self.open_blocks.remove(item_id) {
            return Vec::new();
        }
        vec![self.event(AgentEventPayload::Delta(DeltaEvent::BlockStop {
            block: block_ref(item_id),
        }))]
    }

    /// Mints an event the read loop needs but no notification carried — a
    /// permission request, which arrives as a JSON-RPC *request* rather than a
    /// notification and so never reaches [`Self::map`].
    ///
    /// Through the same counter and the same turn id, because an event numbered
    /// outside them would sort into the transcript at the wrong place.
    pub fn synthesize(&self, payload: AgentEventPayload) -> AgentEvent {
        self.event(payload)
    }

    fn event(&self, payload: AgentEventPayload) -> AgentEvent {
        AgentEvent {
            id: Uuid::now_v7().to_string(),
            session_id: self.session_id.clone(),
            harness: Harness::Codex,
            seq: self.seq.fetch_add(1, Relaxed),
            ts: crate::events::now_rfc3339(),
            turn_id: self.turn_id.clone(),
            // Set for every line arriving on a subagent's thread, which is what
            // files its work into the panel instead of the transcript. The
            // frontend correlates on `subagent.id == the spawning call's
            // callId`, and that is exactly what the registry holds.
            subagent: self.current.clone(),
            payload,
            raw: None,
        }
    }
}

/// Codex has no message/block split — one item is one block — so the index is
/// always zero and the item id is the message id.
fn block_ref(item_id: &str) -> BlockRef {
    BlockRef {
        message_id: item_id.to_string(),
        index: 0,
    }
}

/// The discriminant of `codexErrorInfo`, which is a string for simple causes
/// and an object for ones carrying an HTTP status.
fn error_kind(info: &serde_json::Value) -> String {
    match info {
        serde_json::Value::String(name) => name.clone(),
        serde_json::Value::Object(map) => map
            .keys()
            .next()
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    }
}

/// What to call a subagent on its card.
///
/// `agent_path` is the agent's own name (`/root/count_to_three`), not a
/// filesystem path — the leading `/root` is the namespace every one of them
/// shares, so it says nothing and the last segment is the name.
///
/// That segment is an identifier, and the card is prose: `read_footer` sits
/// beside a title and a running orb, so it is written the way the rest of the
/// row is. Only the separators are touched — a name that is already prose, or
/// one carrying deliberate capitals, comes through as it was.
pub(super) fn agent_name(agent_path: Option<&str>) -> String {
    let raw = agent_path
        .and_then(|path| path.rsplit('/').find(|part| !part.is_empty()))
        .unwrap_or("agent");

    let spaced = raw.replace(['_', '-'], " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// Whether an `extension` item is the connector-driven web search.
///
/// Two routes reach the same row: a plain `app-server` session emits a native
/// `webSearch` item, a session running under the ChatGPT connectors emits
/// `extension` with this kind. Both were captured live; handling one drew half
/// the searches a reader makes.
fn is_web_search(kind: &Option<String>) -> bool {
    kind.as_deref() == Some("web.search")
}

/// The path an `imageView` names, with `file://` taken off.
///
/// Captured both ways — bare under a plain session, URL-shaped under a
/// connector one — and everything downstream wants a path it can open.
fn display_path(path: &str) -> String {
    path.strip_prefix("file://").unwrap_or(path).to_string()
}

/// The skill an `exec` is running, where it is running one.
///
/// Codex has no skill item: a skill is a shell command invoking the skill's own
/// script, so the only evidence is the path in the command. Recognised so the
/// row can say "Launched skill" instead of showing a reader a shell invocation
/// they did not write and cannot place.
///
/// Deliberately narrow, and it fails *towards* an ordinary shell row: a command
/// this does not recognise is still perfectly well drawn as the command it is,
/// where a false positive would relabel real work as something it isn't.
pub(super) fn skill_name(command: &str) -> Option<String> {
    let at = command.rfind("/skills/")?;
    let rest = &command[at + "/skills/".len()..];

    // Skills live one directory deeper than the path suggests: Codex's own ship
    // under `skills/.system/<name>/`, so taking the first segment named the
    // whole set `.system` on every one of them. A hidden segment is a category,
    // never the skill.
    rest.split(['/', ' ', '\'', '"'])
        .find(|part| !part.is_empty() && !part.starts_with('.'))
        .map(str::to_string)
}

/// An MCP result flattened to the text the expander draws.
///
/// The server's own `content` blocks where there are any, its error otherwise.
/// `structured` keeps the whole payload beside this, so nothing is lost by the
/// flattening — this is the readable side of the same answer.
fn mcp_text(result: Option<&serde_json::Value>, error: Option<&serde_json::Value>) -> String {
    if let Some(err) = error {
        return match err.as_str() {
            Some(text) => text.to_string(),
            None => err.to_string(),
        };
    }

    let Some(content) = result.and_then(|r| r.get("content")).and_then(|c| c.as_array()) else {
        return String::new();
    };

    content
        .iter()
        .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the row calls the change, so the verb beside it is true.
///
/// A patch that creates a file has no previous version to have edited, and one
/// that removes it has nothing left to show. Mixed patches stay `apply_patch`:
/// the header names the run, and the files under it each say their own kind.
pub(super) fn edit_tool_name(changes: &[FileChangeEntry]) -> String {
    let kinds: Vec<_> = changes
        .iter()
        .map(|c| c.kind.as_ref().and_then(kind_name))
        .collect();

    match kinds.as_slice() {
        [Some(k)] if k == "add" => "create_file".to_string(),
        [Some(k)] if k == "delete" => "delete_file".to_string(),
        _ => "apply_patch".to_string(),
    }
}

/// The row's own label: the file's name, not the path to it.
///
/// The full path is on `input.file_path`, which is what the row hovers and what
/// the diff underneath is keyed by — so nothing is lost by shortening, and the
/// line stops being mostly directory. A patch touching several files counts
/// them instead, since no one name describes it.
pub(super) fn edit_title(changes: &[FileChangeEntry]) -> String {
    match changes {
        [] => "apply_patch".to_string(),
        [one] => one
            .path
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(&one.path)
            .to_string(),
        many => format!("{} files", many.len()),
    }
}

fn file_edit(entry: &FileChangeEntry) -> FileEdit {
    FileEdit {
        path: entry.path.clone(),
        change: match entry.kind.as_ref().and_then(kind_name).as_deref() {
            Some("add") => crate::events::FileChange::Add,
            Some("delete") => crate::events::FileChange::Delete,
            _ => crate::events::FileChange::Update,
        },
        unified_diff: entry.diff.clone(),
    }
}

/// `kind` is a string for the simple cases and a tagged object for `update`,
/// which carries a move path.
fn kind_name(kind: &serde_json::Value) -> Option<String> {
    match kind {
        serde_json::Value::String(name) => Some(name.to_lowercase()),
        serde_json::Value::Object(map) => map.keys().next().map(|k| k.to_lowercase()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::codex::parser::parse_notification;
    use serde_json::json;

    fn mapper() -> Mapper {
        Mapper::new("dray-session".to_string(), Arc::new(AtomicU64::new(0)))
    }

    fn map_one(m: &mut Mapper, method: &str, params: serde_json::Value) -> Vec<AgentEvent> {
        m.map(parse_notification(method, params).expect("should parse"))
    }

    /// Codex echoes the prompt back as an item. Dray already minted its own
    /// carrying the baseline, images and issue links, so drawing this too would
    /// show every prompt twice.
    #[test]
    fn user_message_echo_is_dropped() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "turnId": "u",
                   "item": {"type": "userMessage", "id": "um_1", "content": []}}),
        );
        assert!(events.is_empty());
    }

    /// Every event inside a turn names it. Codex is the first harness to give
    /// Dray a turn id at all, and it is what scopes a row to its exchange.
    #[test]
    fn events_carry_the_open_turn_id() {
        let mut m = mapper();
        map_one(
            &mut m,
            "turn/started",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "inProgress"}}),
        );

        let events = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "turnId": "turn_1",
                   "item": {"type": "agentMessage", "id": "msg_1", "text": ""}}),
        );
        assert_eq!(events[0].turn_id.as_deref(), Some("turn_1"));

        map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "completed"}}),
        );
        let after = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t",
                   "item": {"type": "agentMessage", "id": "msg_2", "text": ""}}),
        );
        assert_eq!(after[0].turn_id, None, "the turn closed");
    }

    /// The ring reads `last` over `modelContextWindow`. Reading `total` would
    /// report three times the occupancy on a three-call turn.
    #[test]
    fn occupancy_reads_last_not_total() {
        let mut m = mapper();
        map_one(
            &mut m,
            "turn/started",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "inProgress"}}),
        );
        map_one(
            &mut m,
            "thread/tokenUsage/updated",
            json!({"threadId": "t", "turnId": "turn_1", "tokenUsage": {
                "total": {"totalTokens": 47083},
                "last": {"totalTokens": 15785},
                "modelContextWindow": 258400}}),
        );

        let closing = map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "completed"}}),
        );

        let AgentEventPayload::TurnCompleted { ref usage, .. } = closing[0].payload else {
            panic!("expected a closing turn");
        };
        let window = usage.as_ref().unwrap().context_window.as_ref().unwrap();
        assert_eq!(window.used_tokens, 15785);
        assert_eq!(window.max_tokens, 258400);
    }

    /// A stopped turn is the reader's own doing. Drawn as a failure it would
    /// put a red row under every interrupt.
    #[test]
    fn interrupted_turn_is_not_an_error() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "interrupted"}}),
        );

        let AgentEventPayload::TurnCompleted {
            ref status,
            ref stop_reason,
            ..
        } = events[0].payload
        else {
            panic!("expected a closing turn");
        };
        assert!(matches!(status, TurnStatus::Success));
        assert_eq!(stop_reason.as_deref(), Some("interrupted"));
    }

    /// A failed turn draws the harness's own sentence, never the wire token —
    /// the rule CLAUDE.md sets after `stop_sequence` was drawn instead of the
    /// message carrying the cure.
    #[test]
    fn failed_turn_draws_the_message_not_the_code() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "turn/completed",
            json!({"threadId": "t", "turn": {"id": "turn_1", "status": "failed",
                   "error": {"message": "You've hit your usage limit.",
                             "codexErrorInfo": "UsageLimitExceeded"}}}),
        );

        let AgentEventPayload::TurnCompleted {
            ref final_text,
            ref stop_reason,
            ..
        } = events[0].payload
        else {
            panic!("expected a closing turn");
        };
        assert_eq!(final_text.as_deref(), Some("You've hit your usage limit."));
        assert_eq!(stop_reason.as_deref(), Some("UsageLimitExceeded"));
    }

    /// A message streams and then commits. Both have to arrive, and the
    /// committed one has to carry the same block so it supersedes the preview
    /// rather than drawing beside it.
    #[test]
    fn message_streams_then_commits_on_one_block() {
        let mut m = mapper();
        let start = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "item": {"type": "agentMessage", "id": "msg_1", "text": ""}}),
        );
        assert!(matches!(
            start[0].payload,
            AgentEventPayload::Delta(DeltaEvent::BlockStart { .. })
        ));

        let delta = map_one(
            &mut m,
            "item/agentMessage/delta",
            json!({"threadId": "t", "itemId": "msg_1", "delta": "ok"}),
        );
        assert!(matches!(
            delta[0].payload,
            AgentEventPayload::Delta(DeltaEvent::TextDelta { .. })
        ));

        let done = map_one(
            &mut m,
            "item/completed",
            json!({"threadId": "t", "item": {"type": "agentMessage", "id": "msg_1", "text": "ok"}}),
        );
        assert!(matches!(
            done[0].payload,
            AgentEventPayload::Delta(DeltaEvent::BlockStop { .. })
        ));
        match &done[1].payload {
            AgentEventPayload::AssistantText { block, text } => {
                assert_eq!(text, "ok");
                assert_eq!(block.as_ref().unwrap().message_id, "msg_1");
            }
            other => panic!("expected committed text, got {other:?}"),
        }
    }

    /// A delta for a block that never opened would draw text under no header.
    #[test]
    fn orphan_delta_is_dropped() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/agentMessage/delta",
            json!({"threadId": "t", "itemId": "never_started", "delta": "x"}),
        );
        assert!(events.is_empty());
    }

    /// Every gap between rows needs the working indicator, not just the first.
    /// Codex sends no `requesting` ping, so a tool finishing has to mint one or
    /// the indicator goes quiet for the rest of the turn.
    #[test]
    fn tool_completion_reopens_the_working_indicator() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/completed",
            json!({"threadId": "t", "item": {"type": "commandExecution", "id": "exec_1",
                   "command": "echo hi", "status": "completed",
                   "aggregatedOutput": "hi\n", "exitCode": 0}}),
        );

        assert!(matches!(
            events[0].payload,
            AgentEventPayload::ToolCallCompleted { .. }
        ));
        assert!(matches!(
            events[1].payload,
            AgentEventPayload::ModelRequestStarted
        ));
    }

    /// A declined command is a failure as far as the row is concerned — the
    /// reader said no and the tool did not run.
    #[test]
    fn declined_command_reads_as_an_error() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/completed",
            json!({"threadId": "t", "item": {"type": "commandExecution", "id": "exec_1",
                   "command": "rm -rf /", "status": "declined"}}),
        );

        let AgentEventPayload::ToolCallCompleted { ref result, .. } = events[0].payload else {
            panic!("expected a completed call");
        };
        assert!(result.is_error);
    }

    /// A file change is both a tool row and a diff. `FileEdits` is what draws
    /// the diff, and Claude never emits one — Codex hands over a real unified
    /// diff per file.
    #[test]
    fn file_change_emits_a_call_and_its_diff() {
        let mut m = mapper();
        let events = map_one(
            &mut m,
            "item/started",
            json!({"threadId": "t", "item": {"type": "fileChange", "id": "fc_1",
                   "status": "inProgress",
                   "changes": [{"path": "src/main.rs", "kind": "add",
                                "diff": "@@ -0,0 +1 @@\n+fn main() {}"}]}}),
        );

        assert!(matches!(
            events[0].payload,
            AgentEventPayload::ToolCallStarted { .. }
        ));
        match &events[1].payload {
            AgentEventPayload::FileEdits { edits, .. } => {
                assert_eq!(edits[0].path, "src/main.rs");
                assert!(matches!(edits[0].change, crate::events::FileChange::Add));
                assert!(edits[0].unified_diff.is_some());
            }
            other => panic!("expected file edits, got {other:?}"),
        }
    }
}
