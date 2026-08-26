//! Claude Code events → normalized [`AgentEvent`]s.
//!
//! Stateful and per-session: `content_block_start` doesn't carry the message id
//! its `BlockRef` needs — that arrived earlier on `message_start`.

use crate::{
    events::{
        now_rfc3339, rfc3339_from_unix, AgentEvent, AgentEventPayload, BackgroundTask, BlockRef,
        BlockType, ContextWindow, DeltaEvent, ImageRef, ModelUsage, Question, QuestionOption,
        SessionInfo,
        Settings, Subagent, ToolResult, ToolType, TurnStatus, Usage,
    },
    harness::{
        claude_code::{
            parser::{
                self, AskUserQuestionInput, AssistantMessage, ContentBlock, ContentDelta,
                ControlRequest, PermissionRequest, ResultEvent, StreamFrame, SystemEvent,
                UserContent, UserContentBlock, UserMessage, ASK_USER_QUESTION,
            },
            permissions::{PendingPermissions, PendingRequest},
            ClaudeCodeEvent,
        },
        Harness,
    },
};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        Arc,
    },
};

use uuid::Uuid;

pub struct Mapper {
    /// Set by `message_start`, read by the block frames that follow it.
    current_msg_id: Option<String>,
    /// Next block index per message id, for committed `assistant` events.
    ///
    /// Claude Code emits one `assistant` event per content block, all sharing a
    /// `message.id`, and none of them carry an index — so the only way to
    /// address a block is to count arrivals. Deltas can't supply it either:
    /// subagent messages get no stream frames at all.
    block_indices: HashMap<String, u32>,
    /// The dated model id `init` reported, which is the key the `result` line's
    /// `modelUsage` map uses. Kept only to read the context window back out of
    /// that map — a session whose subagents ran a second model has two entries,
    /// and only the main thread's window describes the gauge.
    model: Option<String>,
    /// How full the context was at the most recent main-thread `assistant`
    /// message. The `result` line cannot answer this — see [`occupancy`] — so
    /// the reading is taken per message and handed to `turn_completed` when the
    /// turn closes.
    last_occupancy: Option<u64>,
    /// Events the app synthesizes itself (the user's own prompt) must be
    /// numbered through this same counter, or `seq` develops gaps.
    seq: Arc<AtomicU64>,
    // tool_use_id/subagent_id as str
    subagent_seq: HashMap<String, u64>,
    /// Requests registered here as they are mapped, and removed by
    /// [`Session`](crate::session::Session) when it answers them. The mapper
    /// owns the registration because the options it emits and the rules they
    /// carry are built together, and only one of the two is fit to leave Rust.
    pending_permissions: PendingPermissions,
    /// The session every line so far belonged to. See [`Self::build`].
    session_id: Option<String>,
}

/// A mapper with a counter of its own, for tests and one-off mapping. The real
/// session shares its counter with [`Session`](crate::session::Session).
impl Default for Mapper {
    fn default() -> Self {
        Self::new(Arc::new(AtomicU64::new(0)), PendingPermissions::default())
    }
}

impl Mapper {
    pub fn new(seq: Arc<AtomicU64>, pending_permissions: PendingPermissions) -> Self {
        Self {
            current_msg_id: None,
            block_indices: HashMap::new(),
            model: None,
            last_occupancy: None,
            seq,
            subagent_seq: HashMap::new(),
            pending_permissions,
            session_id: None,
        }
    }

    /// Map one parsed line. `Ok(None)` means the line only advanced state.
    ///
    /// Envelope fields are pulled off here rather than in the handlers: every
    /// event type carries `session_id`, `parent_tool_use_id` only the three that
    /// can be subagent traffic, and `timestamp` only `user`.
    pub fn map(&mut self, event: ClaudeCodeEvent) -> Result<Option<AgentEvent>> {
        match event {
            ClaudeCodeEvent::System(system_event) => {
                let session_id = system_event_session_id(&system_event).to_string();
                let (tool_use_id, label) = system_event_subagent_info(&system_event);

                let subagent = subagent(tool_use_id, label);
                let payload = self.handle_system_event(system_event)?;
                Ok(payload.map(|p| self.build(session_id, subagent, None, p)))
            }

            ClaudeCodeEvent::StreamEvent {
                event,
                session_id,
                parent_tool_use_id,
                ..
            } => {
                let subagent = subagent(parent_tool_use_id, None);
                let payload = self.handle_stream_event(event)?;
                Ok(payload.map(|p| self.build(session_id, subagent, None, p)))
            }

            ClaudeCodeEvent::Assistant {
                message,
                parent_tool_use_id,
                session_id,
                subagent_type,
                ..
            } => {
                // Only the main thread's. A subagent runs its own context, so
                // its messages report a smaller occupancy that says nothing
                // about the window this session's gauge measures.
                if parent_tool_use_id.is_none() {
                    if let Some(usage) = &message.usage {
                        self.last_occupancy = Some(occupancy(usage));
                    }
                }

                let payload = self.handle_assistant_msg(message, parent_tool_use_id.as_deref())?;
                let subagent = subagent(parent_tool_use_id, subagent_type);
                Ok(payload.map(|p| self.build(session_id, subagent, None, p)))
            }

            ClaudeCodeEvent::User {
                message,
                parent_tool_use_id,
                session_id,
                timestamp,
                tool_use_result,
                subagent_type,
                is_replay,
                is_synthetic,
                ..
            } => {
                // The CLI feeding its own context back to itself, not
                // conversation. A compaction replays its summary as a prompt
                // and echoes the `/compact` command; this app mints its own
                // user events, and the session log exists for the UI rather
                // than to reconstruct the model's context, so neither is ours
                // to keep.
                if is_replay || is_synthetic {
                    return Ok(None);
                }

                let payload = Self::handle_user_msg(message, tool_use_result);
                let subagent = subagent(parent_tool_use_id, subagent_type);
                Ok(payload.map(|p| self.build(session_id, subagent, timestamp, p)))
            }

            ClaudeCodeEvent::Result(result_event) => {
                let session_id = match &result_event {
                    ResultEvent::Success { session_id, .. }
                    | ResultEvent::ErrorDuringExecution { session_id, .. } => session_id.clone(),
                };

                let payload = self
                    .handle_result_event(result_event)
                    .with_context(|| format!("mapping result event for session {session_id}"))?;
                Ok(Some(self.build(session_id, None, None, payload)))
            }

            ClaudeCodeEvent::RateLimitEvent {
                rate_limit_info,
                session_id,
                ..
            } => {
                if !rate_limit_info.is_noteworthy() {
                    return Ok(None);
                }

                let payload = AgentEventPayload::RateLimited {
                    status: rate_limit_info.status,
                    resets_at: rate_limit_info.resets_at.map(rfc3339_from_unix),
                    limit_type: rate_limit_info.rate_limit_type,
                    overage_status: rate_limit_info.overage_status,
                    using_overage: rate_limit_info.is_using_overage.unwrap_or(false),
                    overage_disabled_reason: rate_limit_info.overage_disabled_reason,
                };

                Ok(Some(self.build(session_id, None, None, payload)))
            }

            // The ack for a control request this app wrote — interrupt,
            // set_model, set_permission_mode. Nothing correlates ids yet.
            ClaudeCodeEvent::ControlResponse { .. } => Ok(None),

            ClaudeCodeEvent::ControlRequest {
                request_id,
                request,
            } => {
                let ControlRequest::CanUseTool(request) = request else {
                    // Answered in the read loop, which owns the pipe back. The
                    // request needs a reply either way, and this one can't
                    // become a question the user could answer.
                    return Ok(None);
                };

                let session_id = self.session_id.clone().unwrap_or_default();

                if let Some((pending, payload)) = as_questions(&request_id, &request) {
                    self.pending_permissions
                        .lock()
                        .expect("pending permissions mutex poisoned")
                        .insert(request_id, pending);

                    return Ok(Some(self.build(session_id, None, None, payload)));
                }

                let (pending, options) = PendingRequest::new(&request);

                let payload = AgentEventPayload::PermissionRequested {
                    request_id: request_id.clone(),
                    tool_use_id: request.tool_use_id,
                    tool_name: request.tool_name,
                    display_name: request.display_name,
                    title: request.title,
                    description: request.description,
                    input: request.input,
                    blocked_path: request.blocked_path,
                    decision_reason: request.decision_reason,
                    decision_reason_type: request.decision_reason_type,
                    agent_id: request.agent_id,
                    options,
                };

                // Registered before the event goes out: the frontend can answer
                // the moment it renders, and an entry missing then would read as
                // an already-settled request.
                self.pending_permissions
                    .lock()
                    .expect("pending permissions mutex poisoned")
                    .insert(request_id, pending);

                // Deliberately main-thread even when `agent_id` says a subagent
                // asked. Two reasons, either one sufficient: subagent events are
                // filtered out of the chat and rendered in a panel, so the card
                // would be invisible while the agent hung waiting on it — and
                // `agent_id` is the harness's own handle, not the spawning
                // call's id this app correlates subagents by, so it would invent
                // a run that matches nothing. Whoever asked, the user answers in
                // one place.
                Ok(Some(self.build(session_id, None, None, payload)))
            }
        }
    }

    /// `&self` because the counter is atomic: `Session` advances the same one
    /// concurrently when it writes a prompt.
    fn get_seq(&self) -> u64 {
        self.seq.fetch_add(1, Relaxed)
    }

    /// Ordering within one subagent's own stream.
    fn get_subagent_seq(&mut self, subagent_id: &str) -> u64 {
        let next = self
            .subagent_seq
            .entry(subagent_id.to_string())
            .or_insert(0);
        let seq = *next;
        *next += 1;
        seq
    }

    /// The only place `AgentEvent`s are built, so `seq` can't be skipped or
    /// double-assigned.
    fn build(
        &mut self,
        session_id: String,
        subagent: Option<Subagent>,
        timestamp: Option<String>,
        payload: AgentEventPayload,
    ) -> AgentEvent {
        // Remembered for the one line that omits it: a `control_request` carries
        // no session id, and the mapper is per-session, so the last one seen is
        // this session's.
        self.session_id = Some(session_id.clone());

        let seq = match &subagent {
            // The spawn announcement is the main thread's, even though it names
            // a subagent.
            Some(_) if matches!(payload, AgentEventPayload::SubagentStarted { .. }) => {
                self.get_seq()
            }
            Some(sub) => self.get_subagent_seq(&sub.id),
            None => self.get_seq(),
        };

        AgentEvent {
            id: Uuid::now_v7().to_string(),
            session_id,
            harness: Harness::ClaudeCode,
            seq,
            ts: timestamp.unwrap_or_else(now_rfc3339),
            // No Claude Code line carries one; the session layer opens a turn
            // when it writes a prompt.
            turn_id: None,
            subagent,
            payload,
            raw: None,
        }
    }

    /// Routes a system event by subtype. Most subtypes have no mapping yet
    /// and fall through to `None`.
    fn handle_system_event(&mut self, e: SystemEvent) -> Result<Option<AgentEventPayload>> {
        match e {
            SystemEvent::Init { .. } => {
                if let SystemEvent::Init { model, .. } = &e {
                    self.model = Some(model.clone());
                }
                Self::handle_init(e).map(Some)
            }
            // A live counter for the thinking block in flight. Reported as
            // usage rather than given its own payload: it is the same fact
            // `result` reports at the end, only sooner and coarser.
            SystemEvent::ThinkingTokens {
                estimated_tokens, ..
            } => Ok(Some(AgentEventPayload::UsageUpdate(Usage {
                reasoning_tokens: Some(estimated_tokens),
                ..Default::default()
            }))),
            SystemEvent::PermissionDenied {
                tool_name,
                tool_use_id,
                message,
                ..
            } => Ok(Some(AgentEventPayload::PermissionDenied {
                tool_name,
                tool_use_id,
                message,
            })),
            SystemEvent::TaskStarted { .. }
            | SystemEvent::TaskProgress { .. }
            | SystemEvent::TaskNotification { .. } => Self::handle_task(e).map(Some),
            SystemEvent::BackgroundTasksChanged { tasks, .. } => {
                Ok(Some(AgentEventPayload::BackgroundTasksChanged {
                    tasks: tasks.into_iter().map(BackgroundTask::from).collect(),
                }))
            }
            // `status` is a general channel — `requesting` opens every turn —
            // so only the one value here means anything to us.
            SystemEvent::Status { status, .. } if status.as_deref() == Some("compacting") => {
                Ok(Some(AgentEventPayload::ContextCompactionStarted))
            }
            SystemEvent::Status { status, .. } if status.as_deref() == Some("requesting") => {
                Ok(Some(AgentEventPayload::ModelRequestStarted))
            }
            SystemEvent::CompactBoundary {
                compact_metadata, ..
            } => {
                // The last message's reading described the context this
                // compaction just discarded. The `result` closing the
                // compaction would otherwise carry it forward and land *after*
                // the boundary, overwriting the only honest post-compaction
                // figure — `post_tokens`, which the boundary itself reports.
                self.last_occupancy = None;

                Ok(Some(AgentEventPayload::ContextCompacted {
                    trigger: compact_metadata.trigger,
                    pre_tokens: compact_metadata.pre_tokens,
                    post_tokens: compact_metadata.post_tokens,
                    duration_ms: compact_metadata.duration_ms,
                }))
            }
            _ => Ok(None),
        }
    }

    /// Maps a subagent lifecycle event: `TaskStarted`, `TaskProgress`, or
    /// `TaskNotification`. Errors on any other variant.
    fn handle_task(e: SystemEvent) -> Result<AgentEventPayload> {
        match e {
            SystemEvent::TaskStarted {
                task_id,
                description,
                prompt,
                subagent_type,
                task_type,
                ..
            } => Ok(AgentEventPayload::SubagentStarted {
                agent_id: task_id,
                // A non-agent task has no subagent type; its kind
                // (`local_bash`) is the closest honest label.
                label: subagent_type.unwrap_or(task_type),
                description: Some(description),
                prompt,
            }),
            SystemEvent::TaskProgress {
                task_id,
                description,
                usage,
                last_tool_name,
                ..
            } => Ok(AgentEventPayload::SubagentProgress {
                agent_id: task_id,
                description: Some(description),
                last_tool: Some(last_tool_name),
                usage: Some(Usage::from(usage)),
            }),
            // SystemEvent::TaskUpdated { task_id, patch, uuid, session_id }
            SystemEvent::TaskNotification {
                task_id,
                status,
                summary,
                usage,
                ..
            } => Ok(AgentEventPayload::SubagentCompleted {
                agent_id: task_id,
                status,
                summary: Some(summary),
                usage: usage.map(Usage::from),
            }),
            other => bail!("handle_task called with a non-task system event: {other:?}"),
        }
    }

    /// Maps `system/init` into `TurnStarted`. This is per turn, not just per
    /// session — Claude Code sends `init` again for every turn.
    fn handle_init(e: SystemEvent) -> Result<AgentEventPayload> {
        if let SystemEvent::Init {
            cwd,
            session_id: _,
            tools,
            mcp_servers,
            model,
            permission_mode,
            claude_code_version,
            agents,
            fast_mode_state,
            ..
        } = e
        {
            let settings = Settings {
                model: Some(model.clone()),
                approval_policy: Some(permission_mode),
                sandbox: None,
                writable_roots: Vec::new(),
                network_access: None,
                fast_mode: Some(fast_mode_state),
            };

            let session_info = SessionInfo {
                cwd: Some(cwd),
                model: Some(model),
                harness_version: Some(claude_code_version),
                tools,
                mcp_servers,
                subagent_types: agents,
                settings: Some(settings),
            };

            Ok(AgentEventPayload::TurnStarted(session_info))
        } else {
            bail!("handle_init called with a non-init system event")
        }
    }

    /// Maps one SSE frame to a `Delta`, tracking `current_msg_id` as frames arrive.
    fn handle_stream_event(&mut self, event: StreamFrame) -> Result<Option<AgentEventPayload>> {
        match event {
            StreamFrame::MessageStart { message } => {
                self.current_msg_id = Some(message.id);
                Ok(None)
            }

            StreamFrame::ContentBlockStart {
                index,
                content_block,
            } => {
                let block_type = match content_block {
                    ContentBlock::Text { .. } => BlockType::Text,
                    ContentBlock::Thinking { .. } => BlockType::Thinking,
                    ContentBlock::ToolUse { id, name, .. } => BlockType::ToolUse { id, name },
                    // Skip the preview rather than guess a kind; the committed
                    // `assistant` event still carries the content.
                    ContentBlock::Unrecognized => return Ok(None),
                };

                let block = self.block_ref(index)?;
                Ok(Some(AgentEventPayload::Delta(DeltaEvent::BlockStart {
                    block,
                    block_type,
                })))
            }

            StreamFrame::ContentBlockDelta { index, delta } => {
                let block = self.block_ref(index)?;

                let delta_event = match delta {
                    ContentDelta::TextDelta { text } => DeltaEvent::TextDelta { block, text },
                    ContentDelta::InputJsonDelta { partial_json } => DeltaEvent::InputDelta {
                        block,
                        partial_json,
                    },
                    // Thinking text rides on TextDelta; the block's BlockStart
                    // already established it as thinking.
                    ContentDelta::ThinkingDelta { thinking } => DeltaEvent::TextDelta {
                        block,
                        text: thinking,
                    },
                    // A signature over the thinking block, not display content.
                    ContentDelta::SignatureDelta { .. } => return Ok(None),
                    ContentDelta::Unrecognized => return Ok(None),
                };

                Ok(Some(AgentEventPayload::Delta(delta_event)))
            }

            StreamFrame::ContentBlockStop { index } => {
                let block = self.block_ref(index)?;
                Ok(Some(AgentEventPayload::Delta(DeltaEvent::BlockStop {
                    block,
                })))
            }

            // The committed `assistant` and `result` events carry these facts.
            StreamFrame::MessageDelta { .. } | StreamFrame::MessageStop => Ok(None),
            // Q: don't we need to clear the current msg id from self when msg stops or will the next message start update it so no need to handle it here?
            StreamFrame::Unrecognized => Ok(None),
        }
    }

    fn handle_assistant_msg(
        &mut self,
        message: AssistantMessage,
        parent_tool_use_id: Option<&str>,
    ) -> Result<Option<AgentEventPayload>> {
        // Subagent content maps the same way as main-thread content; only the
        // envelope differs, via `parent_tool_use_id` → `ThreadRef`. The subagent
        // *lifecycle* (started, progress, finished) arrives on system events
        // instead.
        //
        // Only main-thread content is streamed, so only it has a preview to
        // supersede. Keyed on `parent_tool_use_id` rather than on whether this
        // message id matches the open one: subagent events interleave *inside*
        // a main message's start/stop window, sharing the same stdout.
        let streamed = parent_tool_use_id.is_none()
            && self.current_msg_id.as_deref() == Some(message.id.as_str());
        // Consumed even when unused, so a later block of the same message still
        // lines up with the index its preview used.
        let block = self.next_block_ref(&message.id);
        let block = streamed.then_some(block);

        let content_block = match message.content.into_iter().next() {
            Some(block) => block,
            None => bail!("assistant message carried no content block"),
        };

        let payload = match content_block {
            ContentBlock::Text { text } => AgentEventPayload::AssistantText { block, text },
            ContentBlock::Thinking { thinking, .. } => AgentEventPayload::Reasoning {
                block,
                text: thinking,
                encrypted: false,
            },
            ContentBlock::ToolUse {
                id, name, input, ..
            } => AgentEventPayload::ToolCallStarted {
                tool_type: tool_type(&name),
                call_id: id,
                name,
                input,
                raw_input: None,
                title: None,
            },
            // A block shape this build doesn't model. Its index was already
            // consumed above, so later blocks keep their place — dropping the
            // event is better than failing the line over one unknown block.
            ContentBlock::Unrecognized => return Ok(None),
        };

        Ok(Some(payload))
    }

    /// A `user` event is either the human's prompt or a tool result being fed
    /// back to the model, told apart by the shape of `content`.
    ///
    /// Every user message in the fixtures carries exactly one block (806 of 806
    /// across captures), so only the first is read; a second block would need
    /// this to return several payloads.
    fn handle_user_msg(
        message: UserMessage,
        tool_use_result: Option<Value>,
    ) -> Option<AgentEventPayload> {
        let block = match message.content {
            UserContent::Text(text) => return Some(user_message(text)),
            UserContent::Blocks(blocks) => blocks.into_iter().next()?,
        };

        match block {
            // A bare text block here is a prompt the CLI wrapped in an array, or
            // its own narration of an abort — never a tool result, which is why
            // no `tool_use_id` accompanies it. The abort narration is dropped:
            // the user stopping the turn is not an error, and the fact is
            // recorded for real on the `result` line (`stop_reason: aborted_*`).
            UserContentBlock::Text { text } if is_interrupt_notice(&text) => None,
            UserContentBlock::Text { text } => Some(user_message(text)),

            UserContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => Some(AgentEventPayload::ToolCallCompleted {
                call_id: tool_use_id,
                result: ToolResult {
                    text: strip_tool_use_error(content.as_text()),
                    is_error: is_error.unwrap_or(false),
                    // The sidecar `tool_use_result` field, whose shape is
                    // per-tool: a Read carries its file contents, a Task its
                    // agent id.
                    structured: tool_use_result.map(strip_image_bytes),
                    exit_code: None,
                    duration_ms: None,
                    // A `data:` URL, not a path: this is where the bytes are,
                    // and the session layer is where they can be written to
                    // disk. The URL never survives past the emit — the session
                    // layer strips it before the retained copies — so a failed
                    // archive still draws live and costs only the reloaded view.
                    images: content
                        .images()
                        .into_iter()
                        .map(|(mime, data)| ImageRef {
                            path: None,
                            url: Some(format!("data:{mime};base64,{data}")),
                            mime_type: Some(mime),
                        })
                        .collect(),
                },
            }),

            // An image block arriving as a message's own content rather than
            // inside a tool result: no capture holds one, and there is no tool
            // call to hang it off.
            UserContentBlock::Image { .. } | UserContentBlock::Unrecognized => None,
        }
    }

    /// Maps a turn's terminal `result` line — success or an interrupted turn —
    /// into `TurnCompleted`.
    fn handle_result_event(&self, e: ResultEvent) -> Result<AgentEventPayload> {
        match e {
            ResultEvent::Success {
                is_error,
                duration_ms,
                usage,
                total_cost_usd,
                result,
                stop_reason,
                model_usage,
                ..
            } => {
                let status = if is_error {
                    TurnStatus::Error
                } else {
                    TurnStatus::Success
                };

                Ok(AgentEventPayload::TurnCompleted {
                    status,
                    stop_reason,
                    final_text: Some(result),
                    usage: Some(self.map_result_usage(&usage, total_cost_usd, &model_usage)),
                    duration_ms: Some(duration_ms),
                    head: None,
                })
            }

            // An interrupted turn is still a completed one: same payload, error
            // status, and `terminal_reason` as the stop reason since the wire's
            // own `stop_reason` is null here.
            ResultEvent::ErrorDuringExecution {
                duration_ms,
                usage,
                total_cost_usd,
                terminal_reason,
                model_usage,
                ..
            } => Ok(AgentEventPayload::TurnCompleted {
                status: TurnStatus::Error,
                stop_reason: Some(terminal_reason),
                final_text: None,
                usage: Some(self.map_result_usage(&usage, total_cost_usd, &model_usage)),
                duration_ms: Some(duration_ms),
                head: None,
            }),
        }
    }

    /// The accounting on a `result`, which both variants carry identically.
    /// `modelUsage` is walked once here and feeds two things: the record a usage
    /// page will read back, and the window the composer's gauge measures against.
    ///
    /// Occupancy comes from the turn's last message rather than from this line —
    /// see [`occupancy`]. Zero, or no reading at all, leaves the window unset:
    /// the `result` closing a compaction runs no inference and arrives *after*
    /// the boundary, so reporting its emptiness would blank a gauge the
    /// compaction had just set. Dropping it here keeps every consumer a plain
    /// "latest wins".
    fn map_result_usage(
        &self,
        usage: &parser::Usage,
        total_cost_usd: f64,
        model_usage: &Value,
    ) -> Usage {
        let per_model = map_model_usage(model_usage);
        let window = match (self.last_occupancy, context_window(&per_model, self.model.as_deref()))
        {
            (Some(used_tokens), Some(max_tokens)) if used_tokens > 0 => Some(ContextWindow {
                used_tokens,
                max_tokens,
            }),
            _ => None,
        };

        map_usage(usage, Some(total_cost_usd), per_model, window)
    }

    /// Address the next block of a committed message.
    ///
    /// Counting arrivals reproduces the indices the stream frames use for the
    /// same message (`text` → 0, `tool_use` → 1), so a committed block and its
    /// streamed preview agree on their [`BlockRef`].
    fn next_block_ref(&mut self, message_id: &str) -> BlockRef {
        let next = self
            .block_indices
            .entry(message_id.to_string())
            .or_insert(0);
        let index = *next;
        *next += 1;

        BlockRef {
            message_id: message_id.to_string(),
            index,
        }
    }

    /// Errors rather than substituting a placeholder id — `BlockRef` is the join
    /// key, so a wrong one silently attaches text to the wrong block.
    fn block_ref(&self, index: u32) -> Result<BlockRef> {
        match &self.current_msg_id {
            Some(message_id) => Ok(BlockRef {
                message_id: message_id.clone(),
                index,
            }),
            None => bail!("content block frame arrived before any message_start"),
        }
    }
}

/// A `parent_tool_use_id` is exactly what marks an event as a subagent's, so
/// its presence decides the whole thing. The label rides along on the same
/// events (`subagent_type`), needing no lookup against `task_started`.
/// Whether a `user` text block is the CLI narrating an interruption rather than
/// something the user said. The block carries no other signal, but matching
/// prose fails safe: the abort is reported for real on the `result` line
/// (`terminal_reason`), so a reworded notice costs a stray message in the
/// transcript, not a lost turn-end.
fn is_interrupt_notice(text: &str) -> bool {
    text.starts_with("[Request interrupted by user")
}

/// Claude Code wraps a failed tool's message in `<tool_use_error>` tags. That is
/// wire framing, not content — the `is_error` flag already carries the fact — so
/// it comes off here rather than leaking into the UI and the on-disk log.
///
/// Only an exact whole-string wrap is unwrapped. A result that merely mentions
/// the tag (a grep hit on this very file, say) is left alone.
fn strip_tool_use_error(text: String) -> String {
    const OPEN: &str = "<tool_use_error>";
    const CLOSE: &str = "</tool_use_error>";

    let trimmed = text.trim();
    match trimmed
        .strip_prefix(OPEN)
        .and_then(|rest| rest.strip_suffix(CLOSE))
    {
        Some(inner) => inner.trim().to_string(),
        None => text,
    }
}

/// Drops the copy of an image's bytes the `tool_use_result` sidecar carries.
///
/// A `Read` of a screenshot sends the same base64 twice on one line — once as
/// the tool result's `image` block, once here as `file.base64` — and this half
/// was being persisted verbatim: 48 screenshots came to 12MB of a 14MB session
/// log, read whole every time the session is opened. The picture survives as an
/// archived file on [`ToolResult::images`]; what is left here is the shape
/// around it (dimensions, original size), which is small and describes it.
fn strip_image_bytes(mut structured: Value) -> Value {
    if structured.get("type").and_then(Value::as_str) != Some("image") {
        return structured;
    }

    if let Some(file) = structured.get_mut("file").and_then(Value::as_object_mut) {
        file.remove("base64");
    }

    structured
}

fn user_message(text: String) -> AgentEventPayload {
    AgentEventPayload::UserMessage {
        text,
        images: vec![],
        // No baseline: only a prompt the app itself sent has a snapshot behind
        // it, taken at the moment it was sent. A user line arriving from the
        // CLI is one this app never issued, so there is no "before" to name.
        baseline: None,
        // Same reasoning: queuing is a property of how *this app* sent a
        // prompt, and this one came off the wire.
        queued: false,
        // And so is the sender: only the orchestration socket relays a prompt,
        // and it does so through the session layer, never through the CLI.
        from: None,
    }
}

fn subagent(parent_tool_use_id: Option<String>, label: Option<String>) -> Option<Subagent> {
    parent_tool_use_id.map(|id| Subagent { id, label })
}

/// Classify a tool by its Claude Code name.
///
/// A rendering hint only — which icon and component the UI reaches for — so an
/// unrecognized name falls back to [`ToolType::Other`] rather than failing.
fn tool_type(name: &str) -> ToolType {
    match name {
        "Bash" | "BashOutput" | "KillShell" => ToolType::Shell,
        "Read" | "NotebookRead" => ToolType::FileRead,
        "Write" | "Edit" | "NotebookEdit" => ToolType::FileEdit,
        "Grep" | "Glob" => ToolType::Search,
        "WebFetch" | "WebSearch" => ToolType::Web,
        "Agent" | "Task" => ToolType::SubagentSpawn,
        name if name.starts_with("mcp__") => ToolType::Mcp,
        _ => ToolType::Other,
    }
}

impl From<parser::BackgroundTask> for BackgroundTask {
    fn from(wire: parser::BackgroundTask) -> Self {
        Self {
            task_id: wire.task_id,
            task_type: wire.task_type,
            description: wire.description,
        }
    }
}

impl From<parser::TaskUsage> for Usage {
    fn from(wire: parser::TaskUsage) -> Self {
        Self {
            total_tokens: Some(wire.total_tokens),
            ..Default::default()
        }
    }
}

/// How full the context was for one request: the four counts summed.
///
/// They are disjoint slices of a single prompt — fresh input, what was written
/// to cache, what was read back from it, and the reply — so for **one message**
/// their sum is what the next request starts from.
///
/// It must be one message. `result.usage` carries the same four fields summed
/// over every main-thread message in the turn, and an agentic turn re-reads the
/// whole context once per tool call — so that sum is the context multiplied by
/// the number of steps. A ten-step turn on a 40k context reports 400k. The
/// error hides completely on single-message turns, where the sum *is* the last
/// message, which is why `compaction.jsonl` agreed with its own `pre_tokens` to
/// within two tokens and the bug shipped anyway.
fn occupancy(wire: &parser::Usage) -> u64 {
    wire.input_tokens
        + wire.cache_creation_input_tokens
        + wire.cache_read_input_tokens
        + wire.output_tokens
}

/// The `result` line's `modelUsage` map, one [`ModelUsage`] per entry.
///
/// Read field by field out of the raw `Value` rather than deserialized into a
/// struct, and deliberately: this rides `turn_completed`, and a `result` that
/// fails to parse strands the session on `in_progress` — a lesson the compaction
/// capture taught the hard way. Serde would reject the whole line over one field
/// that changed type; here that costs one field.
///
/// Entry order is the map's own, which serde_json sorts by key — so a session's
/// log doesn't churn between runs.
fn map_model_usage(model_usage: &Value) -> Vec<ModelUsage> {
    let Some(map) = model_usage.as_object() else {
        return Vec::new();
    };

    map.iter()
        .map(|(model, v)| ModelUsage {
            model: model.clone(),
            input_tokens: v.get("inputTokens").and_then(Value::as_u64),
            output_tokens: v.get("outputTokens").and_then(Value::as_u64),
            cached_input_tokens: v.get("cacheReadInputTokens").and_then(Value::as_u64),
            cache_write_tokens: v.get("cacheCreationInputTokens").and_then(Value::as_u64),
            web_search_requests: v.get("webSearchRequests").and_then(Value::as_u64),
            cost_usd: v.get("costUSD").and_then(Value::as_f64),
            context_window: v.get("contextWindow").and_then(Value::as_u64),
            max_output_tokens: v.get("maxOutputTokens").and_then(Value::as_u64),
        })
        .collect()
}

/// Which of those windows the composer's gauge measures against. A session whose
/// subagents ran a second model has an entry each, so `init`'s own model picks
/// the main thread's. A lone entry is taken as-is, covering a `result` reached
/// without an `init` in front of it.
fn context_window(per_model: &[ModelUsage], model: Option<&str>) -> Option<u64> {
    let named = model.and_then(|m| per_model.iter().find(|e| e.model == m));
    let lone = match per_model {
        [only] => Some(only),
        _ => None,
    };

    named.or(lone)?.context_window
}

/// `total_cost_usd` and the context window are siblings of `usage` on the wire
/// rather than members, so both arrive separately.
///
/// Claude Code reports no rate limits here, and folds thinking tokens into
/// `output_tokens`.
fn map_usage(
    wire: &parser::Usage,
    cost_usd: Option<f64>,
    per_model: Vec<ModelUsage>,
    context_window: Option<ContextWindow>,
) -> Usage {
    Usage {
        input_tokens: Some(wire.input_tokens),
        output_tokens: Some(wire.output_tokens),
        cached_input_tokens: Some(wire.cache_read_input_tokens),
        cache_write_tokens: Some(wire.cache_creation_input_tokens),
        reasoning_tokens: None,
        total_tokens: Some(wire.input_tokens + wire.output_tokens),
        cost_usd,
        context_window,
        rate_limit: None,
        model: None,
        per_model,
    }
}

/// Recognizes the one held call that is a question rather than a request for
/// consent, and builds both halves of it.
///
/// Keyed on the tool name, not on `requires_user_interaction`. The flag says a
/// one-tap allow/deny must not be offered, which is true of any tool whose own
/// card is the answer surface — but a card can only be drawn for a shape this
/// app knows, and `AskUserQuestion` is the only one it knows. Everything else
/// carrying the flag still falls through to the consent card: wrong, and
/// answerable, which beats a question with no way to reply.
///
/// Input that doesn't parse falls through the same way, deliberately. The
/// consent card asks the wrong thing about it, but it does unblock the harness,
/// whereas a form built from half a shape would not.
fn as_questions(
    request_id: &str,
    request: &PermissionRequest,
) -> Option<(PendingRequest, AgentEventPayload)> {
    if request.tool_name != ASK_USER_QUESTION {
        return None;
    }

    let input: AskUserQuestionInput = serde_json::from_value(request.input.clone()).ok()?;

    let questions = input
        .questions
        .into_iter()
        .map(|q| Question {
            question: q.question,
            header: q.header,
            multi_select: q.multi_select,
            options: q
                .options
                .into_iter()
                .map(|o| QuestionOption {
                    label: o.label,
                    description: o.description,
                    preview: o.preview,
                })
                .collect(),
        })
        .collect();

    Some((
        PendingRequest::for_questions(request),
        AgentEventPayload::QuestionsAsked {
            request_id: request_id.to_string(),
            tool_use_id: request.tool_use_id.clone(),
            questions,
        },
    ))
}

/// Reaches the `session_id` every variant carries without consuming the event.
fn system_event_session_id(e: &SystemEvent) -> &str {
    match e {
        SystemEvent::HookStarted { session_id, .. }
        | SystemEvent::HookResponse { session_id, .. }
        | SystemEvent::Init { session_id, .. }
        | SystemEvent::Status { session_id, .. }
        | SystemEvent::TaskStarted { session_id, .. }
        | SystemEvent::TaskProgress { session_id, .. }
        | SystemEvent::TaskUpdated { session_id, .. }
        | SystemEvent::TaskNotification { session_id, .. }
        | SystemEvent::PostTurnSummary { session_id, .. }
        | SystemEvent::BackgroundTasksChanged { session_id, .. }
        | SystemEvent::ThinkingTokens { session_id, .. }
        | SystemEvent::PermissionDenied { session_id, .. }
        | SystemEvent::CompactBoundary { session_id, .. } => session_id,
        // No fields survive the catch-all. Harmless: an unrecognized subtype
        // maps to `None`, so no envelope is ever built from this value.
        SystemEvent::Unrecognized => "",
    }
}

fn system_event_subagent_info(e: &SystemEvent) -> (Option<String>, Option<String>) {
    match e {
        SystemEvent::TaskStarted {
            tool_use_id,
            subagent_type,
            ..
        } => (Some(tool_use_id.clone()), subagent_type.clone()),
        SystemEvent::TaskProgress {
            tool_use_id,
            subagent_type,
            ..
        } => (Some(tool_use_id.clone()), Some(subagent_type.clone())),
        SystemEvent::TaskNotification { tool_use_id, .. } => (Some(tool_use_id.clone()), None),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::PermissionOptionKind;

    fn map_fixture(mapper: &mut Mapper, fixture: &str) -> Vec<AgentEvent> {
        fixture
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| mapper.map(parser::parse_line(line).unwrap()).unwrap())
            .collect()
    }

    fn assert_dense_from_zero(events: &[&AgentEvent]) {
        let seqs: Vec<u64> = events.iter().map(|event| event.seq).collect();
        assert_eq!(seqs, (0..seqs.len() as u64).collect::<Vec<_>>());
    }

    /// Committed blocks carry no index, so the mapper counts arrivals. The
    /// indices must be dense per message and agree with the ones the stream
    /// frames used, or streamed text attaches to the wrong committed block.
    #[test]
    fn derives_dense_block_indices_matching_the_stream() {
        let fixture = include_str!("fixtures/complex.jsonl");
        let mut mapper = Mapper::default();
        let mut committed: HashMap<String, Vec<u32>> = HashMap::new();
        let mut streamed: HashMap<String, Vec<u32>> = HashMap::new();

        for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(Some(event)) =
                mapper.map(crate::harness::claude_code::parser::parse_line(line).unwrap())
            else {
                continue;
            };

            match &event.payload {
                AgentEventPayload::AssistantText {
                    block: Some(block), ..
                }
                | AgentEventPayload::Reasoning {
                    block: Some(block), ..
                } => {
                    committed
                        .entry(block.message_id.clone())
                        .or_default()
                        .push(block.index);
                }
                AgentEventPayload::Delta(DeltaEvent::BlockStart { block, .. }) => {
                    streamed
                        .entry(block.message_id.clone())
                        .or_default()
                        .push(block.index);
                }
                _ => {}
            }
        }

        assert!(!committed.is_empty());
        assert_eq!(
            committed.len(),
            streamed.len(),
            "only streamed messages should carry a BlockRef"
        );
        for (message_id, indices) in &committed {
            let expected: Vec<u32> = (0..indices.len() as u32).collect();
            assert_eq!(indices, &expected, "non-dense indices for {message_id}");
        }

        // Where a message was also streamed, the first committed block must
        // share the first streamed block's index.
        for (message_id, streamed_indices) in &streamed {
            if let Some(committed_indices) = committed.get(message_id) {
                assert_eq!(
                    streamed_indices.first(),
                    committed_indices.first(),
                    "streamed and committed disagree for {message_id}"
                );
            }
        }
    }

    #[test]
    fn classifies_tool_types_by_name() {
        assert_eq!(tool_type("Bash"), ToolType::Shell);
        assert_eq!(tool_type("Read"), ToolType::FileRead);
        assert_eq!(tool_type("Edit"), ToolType::FileEdit);
        assert_eq!(tool_type("Agent"), ToolType::SubagentSpawn);
        assert_eq!(tool_type("mcp__supabase__query"), ToolType::Mcp);
        assert_eq!(tool_type("SomethingNew"), ToolType::Other);
    }

    /// The `<tool_use_error>` wrapper is framing the UI must never see. Pinned
    /// by hand because no committed fixture carries a failed tool result.
    #[test]
    fn strips_the_tool_use_error_wrapper() {
        assert_eq!(
            strip_tool_use_error("<tool_use_error>Not found.</tool_use_error>".into()),
            "Not found."
        );

        // Multi-line bodies are the common shape — an Edit reports the string it
        // failed to match.
        assert_eq!(
            strip_tool_use_error("<tool_use_error>line one\nline two</tool_use_error>".into()),
            "line one\nline two"
        );

        // Untagged text is returned untouched, wrapper-shaped or not.
        assert_eq!(strip_tool_use_error("plain failure".into()), "plain failure");
        assert_eq!(
            strip_tool_use_error("grep hit: <tool_use_error> appears here".into()),
            "grep hit: <tool_use_error> appears here"
        );
        assert_eq!(
            strip_tool_use_error("<tool_use_error>unterminated".into()),
            "<tool_use_error>unterminated"
        );
    }

    /// Every `user` event in the fixture is a tool result, and each one must
    /// carry the id of the call it answers — that's the only join back to the
    /// `ToolCallStarted` the UI is waiting on.
    #[test]
    fn maps_tool_results_with_their_call_id() {
        let mut mapper = Mapper::default();
        let completions: Vec<(String, ToolResult)> = include_str!("fixtures/complex.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| mapper.map(parser::parse_line(line).unwrap()).unwrap())
            .filter_map(|event| match event.payload {
                AgentEventPayload::ToolCallCompleted { call_id, result } => Some((call_id, result)),
                _ => None,
            })
            .collect();

        assert_eq!(completions.len(), 30);
        for (call_id, result) in &completions {
            assert!(call_id.starts_with("toolu_"), "{call_id} is not a call id");
            assert!(!result.text.is_empty(), "result text was dropped");
        }
        assert_eq!(
            completions.iter().filter(|(_, r)| r.is_error).count(),
            2,
            "is_error is absent on success, not false"
        );
        // The per-tool sidecar rides along on the results that carry one.
        assert!(completions.iter().any(|(_, r)| r.structured.is_some()));
    }

    /// A `Read` of a `.png` answers in pictures, not in text: the result's only
    /// block is an `image`, so `text` is empty and the row has nothing to draw
    /// unless the image reaches it. The same bytes arrive twice on that line,
    /// and only one copy may survive into the log.
    #[test]
    fn maps_an_image_result_to_an_image_ref() {
        let mut mapper = Mapper::default();
        let results: Vec<ToolResult> = include_str!("fixtures/image_read.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| mapper.map(parser::parse_line(line).unwrap()).unwrap())
            .filter_map(|event| match event.payload {
                AgentEventPayload::ToolCallCompleted { result, .. } => Some(result),
                _ => None,
            })
            .collect();

        assert_eq!(results.len(), 1);
        let result = &results[0];
        assert!(result.text.is_empty(), "an image result carries no text");
        assert_eq!(result.images.len(), 1);

        let image = &result.images[0];
        assert_eq!(image.mime_type.as_deref(), Some("image/png"));
        assert!(image.path.is_none(), "the session layer archives it, not us");
        assert!(image
            .url
            .as_deref()
            .is_some_and(|url| url.starts_with("data:image/png;base64,iVBOR")));

        // The sidecar's copy of the same bytes is what used to be persisted.
        let file = result.structured.as_ref().unwrap().get("file").unwrap();
        assert!(file.get("base64").is_none(), "the second copy survived");
        assert!(file.get("dimensions").is_some(), "the shape came off with it");
    }

    /// A prompt reaches the mapper two ways — bare string, or wrapped in a lone
    /// `text` block — and both are the same user message. The block form has no
    /// `tool_use_id` because it answers no tool call.
    #[test]
    fn maps_both_prompt_shapes_to_user_messages() {
        for line in [
            r#"{"type":"user","message":{"role":"user","content":"hi"},"parent_tool_use_id":null,"session_id":"s","uuid":"u"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"u"}"#,
        ] {
            let event = Mapper::default()
                .map(parser::parse_line(line).unwrap())
                .unwrap()
                .expect("a prompt is an event");
            assert!(matches!(
                event.payload,
                AgentEventPayload::UserMessage { text, .. } if text == "hi"
            ));
        }
    }

    /// A subagent is ordered among its own events: it renders in a separate
    /// panel and outlives the turn that spawned it, so numbering it against the
    /// main conversation would order two independent streams as one.
    #[test]
    fn numbers_each_subagent_apart_from_the_main_thread() {
        let mut mapper = Mapper::default();
        let events = map_fixture(&mut mapper, include_str!("fixtures/complex.jsonl"));

        let (subagent_events, main_events): (Vec<&AgentEvent>, Vec<&AgentEvent>) =
            events.iter().partition(|event| {
                event.subagent.is_some()
                    && !matches!(event.payload, AgentEventPayload::SubagentStarted { .. })
            });

        assert!(!subagent_events.is_empty() && !main_events.is_empty());
        assert_dense_from_zero(&main_events);
        assert_dense_from_zero(&subagent_events);

        // Both restart at 0, so the two sequences are only meaningful apart —
        // a consumer that merged them would see duplicate keys.
        let started = events
            .iter()
            .find(|e| matches!(e.payload, AgentEventPayload::SubagentStarted { .. }))
            .expect("the fixture spawns a subagent");
        assert!(
            started.subagent.is_some(),
            "the spawn still names its subagent"
        );
        assert!(
            main_events.iter().any(|e| e.seq == started.seq),
            "the spawn announcement belongs to the main conversation"
        );
    }

    /// Each subagent counts independently, so a second one starts over at 0
    /// rather than continuing the first's sequence.
    #[test]
    fn gives_every_subagent_its_own_sequence() {
        let mut mapper = Mapper::default();
        let mut event = |parent: &str, seq_line: String| {
            mapper
                .map(parser::parse_line(&seq_line).unwrap())
                .unwrap()
                .map(|e| (parent.to_string(), e.seq))
        };

        let line = |parent: &str| {
            format!(
                r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_x","content":"ok"}}]}},"parent_tool_use_id":"{parent}","session_id":"s","uuid":"u"}}"#
            )
        };

        let seqs: Vec<(String, u64)> = ["agent_a", "agent_b", "agent_a", "agent_b", "agent_a"]
            .iter()
            .filter_map(|parent| event(parent, line(parent)))
            .collect();

        let a: Vec<u64> = seqs
            .iter()
            .filter(|(p, _)| p == "agent_a")
            .map(|(_, s)| *s)
            .collect();
        let b: Vec<u64> = seqs
            .iter()
            .filter(|(p, _)| p == "agent_b")
            .map(|(_, s)| *s)
            .collect();

        assert_eq!(a, vec![0, 1, 2]);
        assert_eq!(b, vec![0, 1]);
    }

    /// The counter is shared with the session, which numbers the user's own
    /// prompt through it — the CLI never echoes prompts back, so a second
    /// counter would hand two events the same `seq`.
    #[test]
    fn continues_a_sequence_the_session_has_already_advanced() {
        let seq = Arc::new(AtomicU64::new(0));
        // Stands in for `Session::send_msg` writing a prompt.
        let prompt_seq = seq.fetch_add(1, Relaxed);
        assert_eq!(prompt_seq, 0);

        let mut mapper = Mapper::new(Arc::clone(&seq), PendingPermissions::default());
        let events = map_fixture(&mut mapper, include_str!("fixtures/printed.jsonl"));
        let first = events.first().expect("the fixture maps at least one event");
        assert_eq!(first.seq, 1, "the mapper resumed after the prompt");
    }

    /// The two ids a task event carries are different: `tool_use_id`
    /// correlates the subagent's events, `task_id` is the CLI's internal agent
    /// handle. Only the first appears anywhere else, so it's the one the
    /// envelope must hold.
    #[test]
    fn keys_subagent_events_on_the_spawning_call() {
        let mut mapper = Mapper::default();
        let subagent_events: Vec<AgentEvent> = include_str!("fixtures/complex.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| mapper.map(parser::parse_line(line).unwrap()).unwrap())
            .filter(|event| {
                matches!(
                    event.payload,
                    AgentEventPayload::SubagentStarted { .. }
                        | AgentEventPayload::SubagentProgress { .. }
                        | AgentEventPayload::SubagentCompleted { .. }
                )
            })
            .collect();

        assert_eq!(subagent_events.len(), 31);
        for event in &subagent_events {
            let subagent = event
                .subagent
                .as_ref()
                .expect("task events name a subagent");
            assert_eq!(subagent.id, "toolu_01XZvNi7gNM53ByhyDb5LN45");
        }

        assert!(subagent_events.iter().any(|e| matches!(
            &e.payload,
            AgentEventPayload::SubagentStarted { agent_id, label, .. }
                if agent_id == "aa402df71b1918f96" && label == "Explore"
        )));

        // `description` is rewritten per progress event, which is what makes it
        // usable as a live status line.
        let descriptions: std::collections::HashSet<&str> = subagent_events
            .iter()
            .filter_map(|e| match &e.payload {
                AgentEventPayload::SubagentProgress { description, .. } => description.as_deref(),
                _ => None,
            })
            .collect();
        assert!(
            descriptions.len() > 1,
            "progress descriptions never changed"
        );

        assert!(subagent_events.iter().any(|e| matches!(
            &e.payload,
            AgentEventPayload::SubagentCompleted { status, usage: Some(usage), .. }
                if status == "completed" && usage.total_tokens == Some(27160)
        )));
    }

    /// The set is republished whole, so an empty list is meaningful — it says
    /// the session's async work has drained — and must map rather than be
    /// treated as nothing-to-report.
    #[test]
    fn maps_background_task_sets_including_empty() {
        let mut mapper = Mapper::default();

        let full = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"aa47","task_type":"local_agent","description":"Investigate blog"}],"uuid":"u","session_id":"s"}"#;
        let event = mapper
            .map(parser::parse_line(full).unwrap())
            .unwrap()
            .expect("a task set is an event");
        assert!(matches!(
            &event.payload,
            AgentEventPayload::BackgroundTasksChanged { tasks }
                if tasks.len() == 1 && tasks[0].task_id == "aa47" && tasks[0].task_type == "local_agent"
        ));

        let drained = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[],"uuid":"u","session_id":"s"}"#;
        let event = mapper
            .map(parser::parse_line(drained).unwrap())
            .unwrap()
            .expect("an empty set still maps");
        assert!(matches!(
            &event.payload,
            AgentEventPayload::BackgroundTasksChanged { tasks } if tasks.is_empty()
        ));
    }

    /// An interrupted turn reports the abort twice — as prose in a `user` text
    /// block, and as `terminal_reason` on the result. The prose maps to
    /// nothing: it must not become a `UserMessage`, and a user stopping the
    /// turn is not an error to surface. The result alone closes the turn.
    #[test]
    fn maps_an_interrupted_turn() {
        let mut mapper = Mapper::default();
        let payloads: Vec<AgentEventPayload> = include_str!("fixtures/interrupted.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| mapper.map(parser::parse_line(line).unwrap()).unwrap())
            .map(|event| event.payload)
            .collect();

        assert!(
            !payloads
                .iter()
                .any(|p| matches!(p, AgentEventPayload::UserMessage { .. })),
            "the interrupt notice was attributed to the user"
        );

        assert!(
            !payloads
                .iter()
                .any(|p| matches!(p, AgentEventPayload::Error { .. })),
            "the interrupt notice surfaced as an error"
        );

        assert!(payloads.iter().any(|p| matches!(
            p,
            AgentEventPayload::TurnCompleted {
                status: TurnStatus::Error,
                stop_reason: Some(reason),
                final_text: None,
                ..
            } if reason == "aborted_streaming"
        )));
    }

    /// The healthy report arrives on roughly every turn and must stay silent;
    /// anything else has to reach the user. The unknown-status case is the
    /// point of the inverted check — a status this build has never seen is
    /// far more likely to be bad news than routine.
    #[test]
    fn emits_only_actionable_rate_limits() {
        let event = |info: &str| {
            let line = format!(
                r#"{{"type":"rate_limit_event","rate_limit_info":{info},"uuid":"u","session_id":"s"}}"#
            );
            Mapper::default().map(parser::parse_line(&line).unwrap()).unwrap()
        };

        assert!(
            event(r#"{"status":"allowed","isUsingOverage":false}"#).is_none(),
            "the steady state must not reach the transcript"
        );

        // Verbatim from a `say hi` turn against an unremarkable session. The
        // window was 93% spent and nothing was blocked — reading this as
        // trouble put "Usage limit reached" on screen mid-conversation.
        assert!(
            event(
                r#"{"status":"allowed_warning","resetsAt":1786366800,"rateLimitType":"five_hour","utilization":0.93,"isUsingOverage":false,"surpassedThreshold":0.9}"#
            )
            .is_none(),
            "approaching a limit is not reaching one"
        );

        // Healthy status, but the user is paying per request — worth saying.
        assert!(event(r#"{"status":"allowed","isUsingOverage":true}"#).is_some());
        assert!(
            event(r#"{"status":"allowed_warning","isUsingOverage":true}"#).is_some(),
            "overage outranks a healthy status"
        );
        assert!(event(r#"{"status":"rejected"}"#).is_some());
        assert!(event(r#"{"status":"some_future_status"}"#).is_some());
        assert!(event("{}").is_some(), "a missing status is not a healthy one");

        let payload = event(
            r#"{"status":"rejected","resetsAt":1785494400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}"#,
        )
        .expect("a rejected limit is actionable")
        .payload;

        // The wire sends unix seconds; everything downstream reads RFC3339.
        assert!(matches!(
            payload,
            AgentEventPayload::RateLimited {
                resets_at: Some(ref at),
                limit_type: Some(ref kind),
                overage_status: Some(ref overage),
                using_overage: false,
                ..
            } if at == "2026-07-31T10:40:00.000Z"
                && kind == "five_hour"
                && overage == "rejected"
        ));
    }

    /// A thinking-token estimate is a running counter for the block in flight,
    /// so it maps to usage rather than to a payload of its own.
    #[test]
    fn maps_thinking_token_estimates_to_usage() {
        let line = r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":42,"estimated_tokens_delta":3,"uuid":"u","session_id":"s"}"#;

        let payload = Mapper::default()
            .map(parser::parse_line(line).unwrap())
            .unwrap()
            .expect("a token estimate is an event")
            .payload;

        assert!(matches!(
            payload,
            AgentEventPayload::UsageUpdate(Usage {
                reasoning_tokens: Some(42),
                ..
            })
        ));
    }

    /// A built-in slash command answers without the model, and its reply has to
    /// reach the transcript like any other text. Asserted through the mapper
    /// rather than the parser alone because "the line parses" was never the
    /// point — the user-visible failure was an empty turn.
    ///
    /// The zeroed usage must also leave the context gauge alone: a synthetic
    /// turn spends nothing, and reporting an occupancy of zero would blank a
    /// reading the previous turn had legitimately set.
    #[test]
    fn maps_a_builtin_commands_reply_into_the_transcript() {
        let events = map_fixture(
            &mut Mapper::default(),
            include_str!("fixtures/builtin_command.jsonl"),
        );

        assert!(
            events.iter().any(|event| matches!(
                &event.payload,
                AgentEventPayload::AssistantText { text, .. } if text.contains("renamed")
            )),
            "the command's answer never reached the transcript"
        );

        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AgentEventPayload::TurnCompleted {
                status: TurnStatus::Success,
                usage: Some(usage),
                ..
            } if usage.context_window.is_none()
        )));
    }

    /// A compaction is exactly two events, and the CLI's own bookkeeping that
    /// follows it is not conversation.
    #[test]
    fn maps_a_compaction_to_a_start_and_a_finish() {
        let events = map_fixture(
            &mut Mapper::default(),
            include_str!("fixtures/compaction.jsonl"),
        );

        let compaction: Vec<&AgentEventPayload> = events
            .iter()
            .map(|event| &event.payload)
            .filter(|payload| {
                matches!(
                    payload,
                    AgentEventPayload::ContextCompactionStarted
                        | AgentEventPayload::ContextCompacted { .. }
                )
            })
            .collect();

        assert!(matches!(
            compaction.as_slice(),
            [
                AgentEventPayload::ContextCompactionStarted,
                AgentEventPayload::ContextCompacted {
                    trigger: Some(trigger),
                    pre_tokens: Some(31872),
                    post_tokens: Some(1318),
                    duration_ms: Some(6681),
                },
            ] if trigger == "manual"
        ));

        // The replayed summary and the `/compact` echo both arrive as `user`
        // lines. Two prompts were typed in this capture; a third bubble would
        // mean one leaked through.
        let prompts = events
            .iter()
            .filter(|event| matches!(event.payload, AgentEventPayload::UserMessage { .. }))
            .count();
        assert_eq!(prompts, 0, "this app mints its own user events");
    }

    /// The gauge's whole input, checked end to end on the one capture that
    /// exercises both halves: a turn's occupancy climbs, the compaction's
    /// `post_tokens` resets it, and the zeroed `result` that lands *after* the
    /// boundary reports no window at all rather than blanking it back to 0/200k.
    #[test]
    fn context_occupancy_tracks_a_compaction() {
        let fixture = include_str!("fixtures/compaction.jsonl");
        let mut mapper = Mapper::default();
        let mut windows = Vec::new();

        for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };

            if let AgentEventPayload::TurnCompleted {
                usage: Some(usage), ..
            } = event.payload
            {
                windows.push(usage.context_window);
            }
        }

        // The second is the compaction's own `pre_tokens` (31872) less the tail
        // of the final message's output, which the last `assistant` event
        // predates. Tens of tokens on a 31k context — the gauge is a
        // proportion, and being 34 light is invisible where being a multiple
        // out is not.
        //
        // The third is `None`: the `result` closing a compaction ran no
        // inference, and the boundary before it already published `post_tokens`.
        assert_eq!(
            windows,
            vec![
                Some(ContextWindow {
                    used_tokens: 31273,
                    max_tokens: 200_000
                }),
                Some(ContextWindow {
                    used_tokens: 31836,
                    max_tokens: 200_000
                }),
                None,
            ]
        );
    }

    /// The regression that shipped: `result.usage` sums its four counts over
    /// every main-thread message in the turn, so an agentic turn reports the
    /// context once per step. This turn's `result` claims 401103 against a real
    /// occupancy of 41102 — a tenfold overshoot that pins the gauge at 100% on a
    /// 200k window and reads as 795k on the 1M one where it was caught.
    ///
    /// A single-message turn hides it completely, which is why the compaction
    /// fixture agreed with `pre_tokens` and the bug shipped anyway.
    #[test]
    fn occupancy_is_one_message_not_the_turns_sum() {
        let fixture = include_str!("fixtures/multi_turn.jsonl");
        let mut mapper = Mapper::default();
        let mut first: Option<ContextWindow> = None;

        for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };

            if let AgentEventPayload::TurnCompleted {
                usage: Some(usage), ..
            } = event.payload
            {
                first = usage.context_window;
                break;
            }
        }

        assert_eq!(first.map(|w| w.used_tokens), Some(41102));

        // What the old formula produced, read off that same line so the two
        // numbers can never drift apart in this test.
        let line = fixture
            .lines()
            .find(|line| line.contains(r#""type":"result""#))
            .unwrap();
        let usage = &serde_json::from_str::<Value>(line).unwrap()["usage"];
        let summed: u64 = [
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
            "output_tokens",
        ]
        .iter()
        .map(|field| usage[field].as_u64().unwrap())
        .sum();

        assert_eq!(summed, 401_103);
        assert!(summed > 9 * 41_102, "the overshoot is a multiple, not a drift");
    }

    /// A window keyed by a model this session never ran is not this session's
    /// window. Only reachable with a subagent on a second model, which no
    /// capture has — so it is pinned by hand.
    #[test]
    fn a_context_window_for_another_model_is_ignored() {
        let per_model = map_model_usage(&serde_json::json!({
            "claude-opus-4-6-20260115": { "contextWindow": 1_000_000 },
            "claude-haiku-4-5-20251001": { "contextWindow": 200_000 },
        }));

        assert_eq!(
            context_window(&per_model, Some("claude-haiku-4-5-20251001")),
            Some(200_000)
        );
        // No `init` seen and more than one candidate: guessing is worse than a
        // gauge that stays hidden until the next turn names its model.
        assert_eq!(context_window(&per_model, None), None);
        assert_eq!(context_window(&[], None), None);
    }

    /// What a usage page will read back. `result.usage` describes a turn's *last
    /// message* — 239 and 485 output tokens across this session's two turns —
    /// while the model actually produced 4682, so this map is the only record of
    /// real consumption and the only thing a per-turn figure can be differenced
    /// out of.
    #[test]
    fn per_model_usage_is_cumulative_and_survives_into_the_event() {
        let fixture = include_str!("fixtures/complex.jsonl");
        let mut mapper = Mapper::default();
        let mut per_turn = Vec::new();

        for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };

            if let AgentEventPayload::TurnCompleted {
                usage: Some(usage), ..
            } = event.payload
            {
                per_turn.push((usage.output_tokens, usage.per_model));
            }
        }

        let [(first_msg, first), (second_msg, second)] = per_turn.as_slice() else {
            panic!("expected two turns, got {}", per_turn.len());
        };

        assert_eq!((*first_msg, *second_msg), (Some(239), Some(485)));

        for cumulative in [first, second] {
            assert!(matches!(
                cumulative.as_slice(),
                [ModelUsage {
                    model,
                    output_tokens: Some(4682),
                    cached_input_tokens: Some(339_010),
                    cost_usd: Some(_),
                    context_window: Some(200_000),
                    max_output_tokens: Some(32_000),
                    ..
                }] if model == "claude-haiku-4-5-20251001"
            ));
        }
    }

    /// The request must reach the UI *and* the registry in one pass. Only the
    /// second can answer the CLI, and the agent stays blocked until something
    /// does — so an event emitted without a matching entry is a hung turn, not
    /// a missing row.
    #[test]
    fn a_permission_request_is_registered_as_it_is_mapped() {
        let pending = PendingPermissions::default();
        let mut mapper = Mapper::new(Arc::new(AtomicU64::new(0)), Arc::clone(&pending));

        let events = map_fixture(&mut mapper, include_str!("fixtures/permission_allow.jsonl"));

        let request = events
            .iter()
            .find_map(|event| match &event.payload {
                AgentEventPayload::PermissionRequested {
                    request_id,
                    tool_name,
                    options,
                    blocked_path,
                    ..
                } => Some((request_id, tool_name, options, blocked_path)),
                _ => None,
            })
            .expect("the fixture asks once");

        let (request_id, tool_name, options, blocked_path) = request;
        assert_eq!(tool_name, "Bash");
        assert!(blocked_path.is_some());

        // Allow-once and deny bracket the three the CLI suggested.
        let kinds: Vec<_> = options.iter().map(|o| o.kind).collect();
        assert_eq!(
            kinds,
            vec![
                PermissionOptionKind::Once,
                PermissionOptionKind::AlwaysRule,
                PermissionOptionKind::AlwaysDirectory,
                PermissionOptionKind::SwitchMode,
                PermissionOptionKind::Deny,
            ]
        );

        let guard = pending.lock().unwrap();
        let entry = guard
            .get(request_id)
            .expect("the emitted request is answerable");
        assert_eq!(entry.tool_name, "Bash");
        for option in options {
            assert!(
                entry.options.contains_key(&option.id),
                "option {} has no rule behind it",
                option.id
            );
        }
    }

    /// A subagent's request must still land on the main thread. Subagent events
    /// are filtered out of the chat and rendered in a panel, so tagging this one
    /// would hide the card while the agent hung waiting for it — and `agent_id`
    /// is the harness's own handle rather than the spawning call's id, so it
    /// would key a subagent run that matches nothing. No fixture carries the
    /// field, so this pins the documented shape.
    #[test]
    fn a_subagents_permission_request_stays_on_the_main_thread() {
        let line = r#"{"type":"control_request","request_id":"req_1","request":{
            "subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"toolu_1",
            "input":{"command":"ls"},"agent_id":"agent_abc"}}"#;

        let event = Mapper::default()
            .map(parser::parse_line(line).unwrap())
            .unwrap()
            .expect("a request always emits");

        assert!(event.subagent.is_none());
        assert!(matches!(
            event.payload,
            AgentEventPayload::PermissionRequested { .. }
        ));
    }

    /// `AskUserQuestion` rides the permission channel but is not a permission:
    /// mapping it to the consent card would offer Allow/Deny to a question, and
    /// allowing tells the agent it was ignored.
    #[test]
    fn an_ask_user_question_becomes_questions_rather_than_a_consent_card() {
        let pending = PendingPermissions::default();
        let mut mapper = Mapper::new(Arc::new(AtomicU64::new(0)), Arc::clone(&pending));

        let events = map_fixture(&mut mapper, include_str!("fixtures/ask_user_question.jsonl"));

        assert!(!events
            .iter()
            .any(|e| matches!(e.payload, AgentEventPayload::PermissionRequested { .. })));

        let (request_id, questions) = events
            .iter()
            .find_map(|event| match &event.payload {
                AgentEventPayload::QuestionsAsked {
                    request_id,
                    questions,
                    ..
                } => Some((request_id, questions)),
                _ => None,
            })
            .expect("the fixture asks once");

        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question, "Tabs or spaces?");
        assert_eq!(questions[0].header.as_deref(), Some("Indentation"));
        assert!(!questions[0].multi_select);
        assert_eq!(questions[1].options.len(), 3);
        // The one field that changes how the second question is answered.
        assert!(questions[1].multi_select);

        // Registered like any held request — the agent is blocked on it either
        // way — but with no options, because the form is the answer.
        let guard = pending.lock().unwrap();
        let entry = guard.get(request_id).expect("the question is answerable");
        assert_eq!(entry.tool_name, "AskUserQuestion");
        assert!(entry.options.is_empty());
    }

    /// Input that doesn't parse must still reach the user as *something*. The
    /// consent card asks the wrong question about it, but it unblocks the
    /// harness, which a half-built form would not.
    #[test]
    fn an_unreadable_question_shape_falls_back_to_the_consent_card() {
        let line = r#"{"type":"control_request","request_id":"req_1","request":{
            "subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"toolu_1",
            "input":{"prompts":["what?"]},"requires_user_interaction":true}}"#;

        let event = Mapper::default()
            .map(parser::parse_line(line).unwrap())
            .unwrap()
            .expect("a request always emits");

        assert!(matches!(
            event.payload,
            AgentEventPayload::PermissionRequested { .. }
        ));
    }

    /// A denial with no question behind it. Worth its own payload rather than an
    /// `Error`: nothing went wrong, the agent asked for something outside what
    /// the session allows.
    #[test]
    fn maps_a_denial_the_cli_made_alone() {
        let events = map_fixture(
            &mut Mapper::default(),
            include_str!("fixtures/permission_denied_system.jsonl"),
        );

        let denied = events
            .iter()
            .find_map(|event| match &event.payload {
                AgentEventPayload::PermissionDenied {
                    tool_name, message, ..
                } => Some((tool_name, message)),
                _ => None,
            })
            .expect("the fixture holds one auto-denial");

        assert_eq!(denied.0, "Bash");
        assert!(denied.1.contains("blocked"));
    }

    /// A field that changes type must cost that field and nothing else — this
    /// rides `turn_completed`, and a `result` that fails to parse leaves the
    /// session stuck on `in_progress`.
    #[test]
    fn an_unfamiliar_model_usage_shape_costs_one_field() {
        let per_model = map_model_usage(&serde_json::json!({
            "some-model": { "contextWindow": "200k", "outputTokens": 12 },
        }));

        assert!(matches!(
            per_model.as_slice(),
            [ModelUsage {
                context_window: None,
                output_tokens: Some(12),
                ..
            }]
        ));

        // Not a map at all, which is what an interrupted turn's `{}` degrades to
        // if the CLI ever sends something else there.
        assert!(map_model_usage(&Value::Null).is_empty());
    }

    /// `status` is a general channel carrying values that drive unrelated UI, so
    /// the gate has to be the value and not the subtype. These pin both mapped
    /// values apart, and the unmapped case below keeps the gate honest.
    #[test]
    fn maps_each_status_value_to_its_own_event() {
        let mapped = |status: &str| {
            let line = format!(
                r#"{{"type":"system","subtype":"status","status":"{status}","uuid":"u","session_id":"s"}}"#
            );
            Mapper::default()
                .map(parser::parse_line(&line).unwrap())
                .unwrap()
                .map(|event| event.payload)
        };

        assert!(matches!(
            mapped("requesting"),
            Some(AgentEventPayload::ModelRequestStarted)
        ));
        assert!(matches!(
            mapped("compacting"),
            Some(AgentEventPayload::ContextCompactionStarted)
        ));
    }

    /// The indicator this drives sits in the gap *after* a tool call, so the
    /// event has to land there — not only at the top of a turn. Pinned against a
    /// real capture rather than argued: every request in the fixture is
    /// announced, and all but the first follow a tool result.
    #[test]
    fn announces_a_model_request_after_every_tool_result() {
        let fixture = include_str!("fixtures/file_write.jsonl");
        let mut mapper = Mapper::default();

        let mut requests = 0;
        let mut results = 0;
        let mut announced_results = 0;
        // Whether a tool result is still waiting for its request. Not "was the
        // previous event a result": a rate-limit notice lands in between on one
        // of these, and the indicator only needs the request to beat the next
        // thing that draws.
        let mut open_result = false;

        for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(Some(event)) = mapper.map(parser::parse_line(line).unwrap()) else {
                continue;
            };

            match event.payload {
                AgentEventPayload::ModelRequestStarted => {
                    requests += 1;
                    if open_result {
                        announced_results += 1;
                        open_result = false;
                    }
                }
                AgentEventPayload::ToolCallCompleted { .. } => {
                    results += 1;
                    open_result = true;
                }
                // Anything that draws closes the window: a request arriving
                // after this would be marking a gap the reader never saw.
                AgentEventPayload::AssistantText { .. }
                | AgentEventPayload::Reasoning { .. }
                | AgentEventPayload::ToolCallStarted { .. } => open_result = false,
                _ => {}
            }
        }

        assert_eq!(requests, 4, "every `requesting` line is announced");
        assert_eq!(results, 3, "the capture's three tool calls all return");
        assert_eq!(
            announced_results, results,
            "every tool result is followed by a request before anything draws"
        );
    }

    /// The null status rides between a compaction's two events, carrying
    /// `compact_result` rather than a state — the boundary is the same signal
    /// with numbers attached, so nothing is mapped from it.
    #[test]
    fn ignores_a_status_line_that_drives_nothing() {
        let line = r#"{"type":"system","subtype":"status","status":null,"compact_result":"success","uuid":"u","session_id":"s"}"#;

        let event = Mapper::default().map(parser::parse_line(line).unwrap()).unwrap();
        assert!(event.is_none());
    }

    /// The wire is snake_case and every `Usage` field is `Option`, so a plain
    /// `from_value::<Usage>()` parses *successfully* into all-`None`. This pins
    /// real numbers so that silent regression can't return.
    #[test]
    fn maps_result_usage_from_wire() {
        let fixture = include_str!("fixtures/complex.jsonl");
        let mut mapper = Mapper::default();
        let mut turns = 0;

        for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
            let event =
                match mapper.map(crate::harness::claude_code::parser::parse_line(line).unwrap()) {
                    Ok(Some(event)) => event,
                    Ok(None) => continue,
                    Err(err) => panic!("{err}\n{line}"),
                };

            if let AgentEventPayload::TurnCompleted {
                status,
                usage: Some(usage),
                ..
            } = &event.payload
            {
                turns += 1;
                assert_eq!(*status, TurnStatus::Success);
                assert!(usage.input_tokens.is_some());
                assert!(usage.output_tokens.is_some());
                assert!(usage.cached_input_tokens.is_some());
                assert!(usage.cache_write_tokens.is_some());
                assert!(usage.cost_usd.is_some());
                assert!(!usage.is_empty());
            }
        }

        // Not a session terminator: one result arrives per completed turn.
        assert_eq!(turns, 2);
    }
}
