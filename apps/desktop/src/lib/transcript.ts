import { toolSummary } from "@/lib/tools";
import type { AgentEvent, ToolResult, Usage } from "@/types/events";

export type SubagentRun = {
  /// The spawning tool call's id — what the envelope correlates on, and the key
  /// the panel selects by.
  id: string;
  /// The harness's own handle on the run, which is what `stop_task` names.
  ///
  /// Not the same id as `id` above, and the difference is silent if confused:
  /// the CLI answers success for a task it does not hold, so stopping by the
  /// spawning call's id looks like a stop that did nothing. Null until a
  /// lifecycle event carries it, which is also the honest reading — a run with
  /// no `agentId` yet is one the harness has not registered as stoppable.
  taskId: string | null;
  label: string | null;
  description: string | null;
  /// Latest `subagent_progress.description`, rewritten per event by the harness.
  status: string | null;
  lastTool: string | null;
  done: boolean;
  usage: Usage | null;
  /// The subagent's own work, excluding its lifecycle events.
  events: AgentEvent[];
  /// The main-thread `tool_call_started` that spawned this run. It is the only
  /// place a `local_bash` task's command and output live — such a task reports
  /// no events of its own, so a run built from the envelope alone is empty —
  /// and for an agent run it carries the prompt and the final report.
  spawn: AgentEvent | null;
};

/// A run of consecutive same-tool calls, collapsed behind one row. Built from
/// the turn's work so the renderer walks a single list rather than re-deriving
/// the runs while it draws.
export type ToolGroup = {
  kind: "tool_group";
  /// The tool every call in the run shares — the grouping key.
  name: string;
  /// The spawning events, in `seq` order. Never fewer than `GROUP_MIN`.
  calls: AgentEvent[];
  /// Distinct targets across the run, which is what the label counts — three
  /// edits to one file is "Edited 1 file", not 3. Falls back to the call count
  /// for a tool whose calls carry no identifying field.
  targets: number;
  /// The single target's summary when the whole run hit one, else null. Lets the
  /// row name it — "Edited src/lib/tools.ts" — instead of counting to one.
  target: string | null;
  key: string;
};

/// Either a lone event or a collapsed run of same-tool calls.
export type WorkItem = AgentEvent | ToolGroup;

/// The `permission_requested` payload, narrowed out of the union once here so
/// the renderer doesn't re-check a type the builder already established.
export type PermissionRequestPayload = Extract<
  AgentEvent["payload"],
  { type: "permission_requested" }
>;

export type QuestionsAskedPayload = Extract<
  AgentEvent["payload"],
  { type: "questions_asked" }
>;

/// Something the agent is blocked on until the user answers. Two shapes, one
/// list: they arrive on the same channel, share a `requestId` space, and are
/// retired by the same `permission_decided`, so splitting them would mean two
/// pending sets that have to stay ordered against each other.
export type PendingAsk = PermissionRequestPayload | QuestionsAskedPayload;

export function isToolGroup(item: WorkItem): item is ToolGroup {
  return "kind" in item && item.kind === "tool_group";
}

/// A prompt typed into the running turn, which is the only kind of user message
/// that lives in a turn's `work` rather than opening one of its own.
///
/// It is the reader's own words, so it is the one work item a collapsed turn
/// keeps on screen — hiding it behind "12 steps" files what someone just typed
/// under the agent's activity. That exemption is also why it is subtracted from
/// `rows`: that count is what the toggle promises to reveal, and a row already
/// visible is not part of the promise.
export function isQueuedPrompt(item: WorkItem): boolean {
  return !isToolGroup(item) && item.payload.type === "user_message";
}

/// A stretch of a turn's work between queued prompts: the items to hide behind
/// one summary line, and the prompt that ends the stretch (`null` on the last).
export type TurnSegment = {
  items: WorkItem[];
  prompt: AgentEvent | null;
  toolCalls: number;
  messages: number;
  /// Rendered rows in `items` — zero means the segment draws no summary line,
  /// which happens between two back-to-back queued prompts.
  rows: number;
};

/// Cuts a turn's work at each queued prompt, for the collapsed view.
///
/// Hiding the work flattens its order: with every row between them gone, the
/// prompts all bunch together above the final answer, which misplaces the one
/// thing in the turn the reader wrote — *when* they said it is part of what
/// they said. Each stretch gets its own summary line instead, so a prompt sits
/// after the work it interrupted, collapsed or not.
///
/// The last segment's counts absorb the same discount `groupTurns` applies to
/// the turn: `finalText` re-renders the turn's last message, and that message is
/// always in the last segment — a queued prompt after it would have unset the
/// discount by being the last rendered row itself.
export function segmentWork(turn: Turn): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let items: WorkItem[] = [];

  const push = (prompt: AgentEvent | null) => {
    let toolCalls = 0;
    let messages = 0;
    let rows = 0;
    for (const item of items) {
      if (isToolGroup(item)) {
        toolCalls += item.calls.length;
        rows += 1;
        continue;
      }
      if (item.payload.type === "tool_call_started") toolCalls += 1;
      if (item.payload.type === "assistant_text") messages += 1;
      if (rendersRow(item)) rows += 1;
    }
    segments.push({ items, prompt, toolCalls, messages, rows });
    items = [];
  };

  for (const item of turn.work) {
    if (isQueuedPrompt(item)) {
      push(item as AgentEvent);
      continue;
    }
    items.push(item);
  }
  push(null);

  const raw = segments.reduce((n, s) => n + s.messages, 0);
  const discount = raw - turn.messages;
  const last = segments[segments.length - 1];
  last.messages -= discount;
  last.rows -= discount;

  return segments;
}

export type Turn = {
  /// The user's prompt opening this turn, absent only for a transcript that
  /// starts mid-conversation.
  prompt: AgentEvent | null;
  /// Everything the agent did between the prompt and completion — tool calls,
  /// subagent spawns, reasoning, and its intermediate messages. Runs of
  /// consecutive same-tool calls arrive pre-collapsed into a `ToolGroup`.
  work: WorkItem[];
  /// The closing `turn_completed`, absent while the turn is still running.
  completed: AgentEvent | null;
  /// `turn_completed.finalText`, which is a verbatim copy of the turn's last
  /// `assistant_text` — so showing both would print the answer twice. A turn
  /// that closed without one (an interrupt) falls back to its last
  /// `assistant_text` directly, so a collapsed turn always ends on what the
  /// agent last said; still `null` when the turn produced no text at all.
  finalText: string | null;
  toolCalls: number;
  messages: number;
  /// How many rows collapsing this turn would actually hide — groups count as
  /// one, events the transcript renders nothing for count as none, and the
  /// message duplicated into `finalText` counts as none because the collapsed
  /// view shows it anyway. What the toggle is worth is a function of this, not
  /// of `work.length`.
  rows: number;
  key: string;
};

/// Payload types that put something on screen — the complement of the
/// `return null` arms in [EventRow](../components/chat/EventRow.tsx). Keep the
/// two in step: this set decides what a collapse would reveal, what can break a
/// tool run, and whether `finalText` duplicates the last visible row, so a
/// missing entry miscounts turns and splits groups on an invisible event.
const RENDERS = new Set([
  // Only ever reached by a *queued* prompt. An ordinary one is a turn's header
  // rather than its work, so it never enters `work` for this to be asked about.
  "user_message",
  "assistant_text",
  "reasoning",
  "tool_call_started",
  "file_edits",
  "error",
  "context_compacted",
  "rate_limited",
  "permission_denied",
]);

/// Whether an item draws a row. A group always does — it is built from tool
/// calls, which always draw.
///
/// Module-private: the working indicator used to gate on this to mean "nothing
/// has happened in this turn yet", which only ever described a turn's *first*
/// wait. It reads `model_request_started` instead now.
function rendersRow(item: WorkItem): boolean {
  return isToolGroup(item) || RENDERS.has(item.payload.type);
}

/// `seq` is the ordering key — most Claude Code events carry no usable `ts`.
function bySeq(a: AgentEvent, b: AgentEvent) {
  return a.seq - b.seq;
}

/// How many consecutive same-tool calls collapse into one group row.
///
/// Any repeat groups. Consistency is the point: the tool name never appears
/// twice in a row, so a run reads the same whether it is two calls or thirty.
///
/// Constrained by `COLLAPSE_MIN` in [TurnBlock](../components/chat/TurnBlock.tsx):
/// keep this at or below it. A run too short to group still costs a row each,
/// so raising this above the collapse threshold puts ungrouped repeats inside a
/// collapsed turn — expand it and you find two rows of the same tool under a
/// summary, which is the double summary the row count exists to prevent. That
/// is exactly what a 3/3 pairing did before: a run of 2 grouped nowhere and
/// collapsed anyway.
export const GROUP_MIN = 2;

/// Bookkeeping the summary count needs while a turn is open, dropped from the
/// `Turn` handed to the UI.
type OpenTurn = Omit<Turn, "work" | "rows"> & {
  /// Ungrouped while the turn is open; `groupTools` runs once on close.
  work: AgentEvent[];
  lastWasAssistantText: boolean;
};

/// The grouping key: same tool name, and only for calls that render as a
/// `ToolCall` row. A subagent spawn draws a `SubagentRow` instead, so folding
/// several into a "Task 4 calls" row would hide the panel links they exist for.
function groupKey(event: AgentEvent, subagentIds: Set<string>): string | null {
  const { payload } = event;
  if (payload.type !== "tool_call_started") return null;
  if (payload.toolType === "subagent_spawn") return null;
  if (subagentIds.has(payload.callId)) return null;
  return payload.name;
}

/// Distinct summaries across a run — the same string a row shows, so the label
/// counts exactly what the reader will see listed. A call with no summary counts
/// as its own target: it is something that happened, just unnamed.
///
/// Returns the count and, when the run hit exactly one *named* target, that name.
/// Unnamed calls never yield a name — there is nothing to print — so a pair of
/// them stays a count.
function countTargets(run: AgentEvent[]): { count: number; only: string | null } {
  const seen = new Set<string>();
  let unnamed = 0;
  for (const event of run) {
    if (event.payload.type !== "tool_call_started") continue;
    const { title, name, toolType, input } = event.payload;
    const summary = title ?? toolSummary(name, toolType, input);
    if (summary === null) unnamed += 1;
    else seen.add(summary);
  }
  const count = seen.size + unnamed;
  return { count, only: count === 1 && seen.size === 1 ? [...seen][0] : null };
}

/// Collapses runs of `GROUP_MIN`+ consecutive calls to the same tool into one
/// item. Only *consecutive* runs group: anything the transcript actually draws
/// between them — a message, a reasoning block — is the agent changing subject,
/// and swallowing that into a single row would reorder the transcript.
///
/// `calls` holds only the spawning events. The transparent events that fell
/// between them are re-emitted after the group — they draw nothing, so their
/// exact position among the calls carries no meaning, and keeping `calls` pure
/// means the row can count it directly.
function groupTools(work: AgentEvent[], subagentIds: Set<string>): WorkItem[] {
  const items: WorkItem[] = [];
  let run: AgentEvent[] = [];
  let runKey: string | null = null;
  // Transparent events seen since the last call. Held rather than emitted so a
  // run that continues past them isn't broken in two.
  let held: AgentEvent[] = [];
  // The held events from *inside* a run, which must outlive `held` being reset
  // as the run continues.
  let passthrough: AgentEvent[] = [];

  const flush = () => {
    if (runKey !== null && run.length >= GROUP_MIN) {
      const { count, only } = countTargets(run);
      items.push({
        kind: "tool_group",
        name: runKey,
        calls: run,
        targets: count,
        target: only,
        key: `group-${run[0].id}`,
      });
    } else {
      items.push(...run);
    }
    items.push(...passthrough, ...held);
    run = [];
    held = [];
    passthrough = [];
    runKey = null;
  };

  for (const event of work) {
    // Anything that draws nothing cannot break a run — derived from `RENDERS`
    // rather than kept as a second list, which drifted. It matters constantly: a
    // `tool_call_completed` lands between every pair of calls (consumed via
    // `resultByCallId`, never rendered), so treating those as breakers would
    // mean no run ever exceeds length 1.
    if (runKey !== null && !rendersRow(event)) {
      held.push(event);
      continue;
    }

    const key = groupKey(event, subagentIds);
    if (key !== null && key === runKey) {
      run.push(event);
      passthrough.push(...held);
      held = [];
      continue;
    }

    flush();
    if (key !== null) {
      run = [event];
      runKey = key;
    } else {
      items.push(event);
    }
  }
  flush();

  return items;
}

/// Cuts the main thread into turns: each runs from a user prompt to the
/// `turn_completed` that closes it. A turn's intermediate work collapses behind
/// one summary line, leaving the prompt and the final answer as the default view.
function groupTurns(events: AgentEvent[], subagentIds: Set<string>): Turn[] {
  const turns: Turn[] = [];
  let current: OpenTurn | null = null;

  // A turn is only pushed once, here, so the tool grouping runs exactly once
  // per turn rather than on every render.
  const close = (turn: OpenTurn) => {
    const { lastWasAssistantText, ...rest } = turn;
    const work = groupTools(turn.work, subagentIds);
    // An interrupted or otherwise cut-short turn closes with no `finalText` —
    // the CLI only writes one for a turn that ended on its own terms. Fall back
    // to the turn's last message so the collapsed view still ends on what the
    // agent last said, instead of filing every row including that message
    // behind the summary. Only for a *closed* turn: a running one shows its
    // work anyway, and a turn a dead child never closed does too.
    let finalText = turn.finalText;
    if (finalText === null && turn.completed !== null) {
      for (let i = turn.work.length - 1; i >= 0; i--) {
        const p = turn.work[i].payload;
        if (p.type === "assistant_text") {
          finalText = p.text;
          break;
        }
      }
    }
    // `finalText` is a verbatim copy of the turn's last `assistant_text`, and
    // the collapsed view renders it in that message's place — so when the last
    // rendered row really is that message, it is on screen either way:
    // collapsing hides one fewer row, and the summary has one fewer message to
    // claim. An interrupted turn has no `finalText`, and a tool call after the
    // last message means the copy is of an earlier one; neither discounts.
    const duplicated = finalText !== null && lastWasAssistantText ? 1 : 0;
    // Queued prompts stay on screen through a collapse, so they are not rows
    // the toggle has to account for. Without this a turn whose only extra row is
    // a queued prompt offers a toggle that reveals nothing.
    const alwaysShown = work.filter(isQueuedPrompt).length;
    turns.push({
      ...rest,
      finalText,
      work,
      messages: turn.messages - duplicated,
      rows: work.filter(rendersRow).length - duplicated - alwaysShown,
    });
  };

  const open = (prompt: AgentEvent | null, key: string): OpenTurn => ({
    prompt,
    work: [],
    completed: null,
    finalText: null,
    toolCalls: 0,
    messages: 0,
    key,
    lastWasAssistantText: false,
  });

  for (const event of events) {
    // A queued prompt does not open a turn: it was typed into one already
    // running, and the CLI answers both inside it and emits a single
    // `turn_completed` for the pair. Cutting here would leave the first turn
    // permanently open and hand its remaining work to a second one. It falls
    // through to the bottom instead and renders as a row where it was typed.
    //
    // `current` still guards it — a queued prompt is only ever queued onto a
    // turn, but a log replayed from a truncation could start on one, and it
    // has to have somewhere to go.
    const inlineQueued = event.payload.type === "user_message" && event.payload.queued && current;

    if (event.payload.type === "user_message" && !inlineQueued) {
      if (current) close(current);
      current = open(event, event.id);
      continue;
    }

    // Events before any prompt still need a home — a resumed session replays
    // the log from wherever it was truncated.
    current ??= open(null, `head-${event.id}`);

    if (event.payload.type === "turn_completed") {
      current.completed = event;
      current.finalText = event.payload.finalText;
      close(current);
      current = null;
      continue;
    }

    if (event.payload.type === "tool_call_started") current.toolCalls += 1;
    if (event.payload.type === "assistant_text") current.messages += 1;
    // Only a *rendered* row unseats the flag. A replayed log carries trailing
    // `delta`s the live path filters out of `events` — let those clear it and
    // the finalText discount applies live but not on reload, so the same turn
    // counts differently across a restart.
    if (rendersRow(event)) {
      current.lastWasAssistantText = event.payload.type === "assistant_text";
    }
    current.work.push(event);
  }

  // The open trailing turn groups too — a run of reads collapses as it arrives
  // rather than only once the turn closes. A run still below `GROUP_MIN` renders
  // as loose rows until the call that reaches it, which is the same thing the
  // reader would see anyway.
  if (current) close(current);
  return turns;
}

/// Splits the event log into the main thread and the subagent runs the panel
/// lists.
///
/// Correlation is `envelope.subagent.id === the spawning call's callId`, not the
/// `agentId` on the subagent payloads — that is the harness's own handle and
/// matches nothing else.
/// Stands in for the result a call will now never get.
///
/// Not an error: nothing went wrong with the call, the process it belonged to
/// stopped existing. Flagging it would tint the row red and spring it open on
/// load, which is a lot of noise for "this didn't finish".
const ABANDONED: ToolResult = {
  text: "No result — the session ended before this call finished.",
  isError: false,
  structured: null,
  exitCode: null,
  durationMs: null,
};

export function buildTranscript(
  source: AgentEvent[],
  /// Whether a child is actually running this session. A call with no result is
  /// only *pending* while something could still produce one; with the process
  /// gone it is abandoned, and rendering it as in-flight leaves a row shimmering
  /// forever. Most visible on `AskUserQuestion`, which blocks the harness until
  /// the app answers and so is the call most likely to be open at a quit — but
  /// it is true of any tool call caught mid-flight.
  live = false,
): {
  /// Main-thread events only, in `seq` order. Subagent work is excluded; the
  /// spawning tool call stays so the chat can show a row linking to the panel.
  events: AgentEvent[];
  /// The same main-thread events, cut into user-prompt-to-turn-completed spans.
  turns: Turn[];
  subagents: SubagentRun[];
  subagentById: Map<string, SubagentRun>;
  resultByCallId: Map<string, ToolResult>;
  /// Consent requests and questions still waiting on the user, oldest first.
  ///
  /// Lifted out of the turns on purpose. A subagent's request would otherwise
  /// have nowhere to render — its events are filed into the panel, not the
  /// chat — and a main-thread one would sit buried in a turn that collapses
  /// once it closes. One place, below the transcript, works for both.
  pendingAsks: PendingAsk[];
} {
  const events = [...source].sort(bySeq);

  const resultByCallId = new Map<string, ToolResult>();
  // Calls with no result yet, and the ones a later event proved will never get
  // one. Only the second is decided during the walk — a result routinely lands
  // many events after its call, so "still open" is a running state, not a
  // verdict.
  const open = new Set<string>();
  const abandoned = new Set<string>();
  const asks: PendingAsk[] = [];
  const answered = new Set<string>();
  const callById = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.payload.type === "tool_call_started") {
      open.add(event.payload.callId);
      callById.set(event.payload.callId, event);
    }
    if (event.payload.type === "tool_call_completed") {
      open.delete(event.payload.callId);
      resultByCallId.set(event.payload.callId, event.payload.result);
    }
    // A new prompt closes the book on everything before it: whatever the agent
    // was mid-way through, this turn is not going to finish it. Without this the
    // marks below would be undone by the next send — the session goes live
    // again, and a row abandoned at the last restart would start shimmering a
    // second time.
    //
    // A *queued* prompt proves the opposite. It was typed into a turn that was
    // already running, and the CLI folds it into that turn — so the calls open
    // in front of it are still live, and marking them here would stop a running
    // tool's row shimmering while it is genuinely still working.
    if (event.payload.type === "user_message" && !event.payload.queued) {
      for (const callId of open) abandoned.add(callId);
      open.clear();
    }
    if (
      event.payload.type === "permission_requested" ||
      event.payload.type === "questions_asked"
    ) {
      asks.push(event.payload);
    }
    if (event.payload.type === "permission_decided") {
      answered.add(event.payload.requestId);
    }
  }

  const pendingAsks = asks.filter((ask) => !answered.has(ask.requestId));

  // Whatever is still open at the end of the log is only pending while something
  // could still produce a result. With no child running, nothing can.
  if (!live) for (const callId of open) abandoned.add(callId);

  // Applied last, and only where no real result exists. A background subagent
  // can report back after the turn that spawned it, so a call marked here early
  // in the walk must still lose to the result that eventually arrives.
  for (const callId of abandoned) {
    if (!resultByCallId.has(callId)) resultByCallId.set(callId, ABANDONED);
  }

  const subagentById = new Map<string, SubagentRun>();
  for (const event of events) {
    const ref = event.subagent;
    if (!ref) continue;

    let run = subagentById.get(ref.id);
    if (!run) {
      run = {
        id: ref.id,
        taskId: null,
        label: ref.label,
        description: null,
        status: null,
        lastTool: null,
        done: false,
        usage: null,
        events: [],
        spawn: null,
      };
      subagentById.set(ref.id, run);
    }

    // The envelope label is null on some events (the completion, notably), so
    // keep the first non-null rather than letting a later one erase it.
    run.label ??= ref.label;

    switch (event.payload.type) {
      case "subagent_started":
        run.taskId = event.payload.agentId;
        run.label ??= event.payload.label;
        run.description = event.payload.description;
        break;
      case "subagent_progress":
        run.taskId = event.payload.agentId;
        run.status = event.payload.description;
        run.lastTool = event.payload.lastTool;
        break;
      case "subagent_completed":
        run.taskId = event.payload.agentId;
        run.done = true;
        run.usage = event.payload.usage;
        break;
      default:
        // Only real work goes in the body; the lifecycle events above drive the
        // header and the live status line instead.
        run.events.push(event);
    }
  }

  // A second pass, because the spawning call is logged before the `task_started`
  // that creates the run — the tool_use block lands in the assistant message
  // first.
  for (const run of subagentById.values()) {
    run.spawn = callById.get(run.id) ?? null;
  }

  const mainThread = events.filter((event) => !event.subagent);

  return {
    events: mainThread,
    // `subagentById` is keyed by the spawning call's id, so its key set is
    // exactly the calls that render as a `SubagentRow` and must not group.
    turns: groupTurns(mainThread, new Set(subagentById.keys())),
    // Newest first. The map is keyed in spawn order, which put the run the
    // reader is waiting on at the bottom of a list that only ever grows — and
    // the panel keeps its scroll position, so a long session opened the tab on
    // whatever was running an hour ago. `subagentById` keeps insertion order for
    // everything that looks a run up by id.
    subagents: [...subagentById.values()].reverse(),
    subagentById,
    resultByCallId,
    pendingAsks,
  };
}
