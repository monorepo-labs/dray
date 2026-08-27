import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import AssistantMessage from "@/components/chat/AssistantMessage";
import EventRow from "@/components/chat/EventRow";
import SubagentRow from "@/components/chat/SubagentRow";
import ToolGroupRow from "@/components/chat/ToolGroupRow";
import UserMessage from "@/components/chat/UserMessage";
import { GROUP_MIN, isToolGroup, segmentWork, type SubagentRun, type Turn, type TurnSegment, type WorkItem } from "@/lib/transcript";
import type { ToolResult } from "@/types/events";
import { cn } from "@/lib/utils";

type TurnBlockProps = {
  turn: Turn;
  subagentById: Map<string, SubagentRun>;
  resultByCallId: Map<string, ToolResult>;
  onOpenSubagent: (id: string) => void;
  /// Opens the session that relayed a prompt, for a `user_message` that carries
  /// a sender. Reaches both the turn's own prompt and any queued one inside it.
  onOpenSession: (sessionId: string) => void;
  /// Trails the turn's work inside this block's own stack. The thinking
  /// indicator and the streaming preview both go here rather than after the
  /// block, so they sit at the same gap the committed event will — placing them
  /// outside left them at the between-turn gap, and the content that replaced
  /// them jumped up by the difference.
  footer?: ReactNode;
};

/// How many rendered rows a turn must have before it collapses behind its
/// summary. Fewer than this and the collapse costs a click to reveal less than
/// the summary line it stood in for.
///
/// Separate from `GROUP_MIN` because they answer different questions — that one
/// is how many *calls* make a group, this is how many *rows* make a collapse —
/// but not independent of it: grouping runs first, so a group is already one row
/// by the time this counts. Keeping this at or above `GROUP_MIN` is what stops a
/// run too short to group from collapsing a turn on its own.
const COLLAPSE_MIN = 3;

// Tune either constant freely, but not past the other: this throws on load
// rather than letting the pairing silently reintroduce ungrouped repeats inside
// a collapsed turn.
if (GROUP_MIN > COLLAPSE_MIN) {
  throw new Error(
    `GROUP_MIN (${GROUP_MIN}) must not exceed COLLAPSE_MIN (${COLLAPSE_MIN}) — ` +
      "runs too short to group would still collapse a turn on their own.",
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/// The same vocabulary as the turn-level summary, per stretch. "step" is the
/// floor for a segment whose rows are all things the parts don't name
/// (reasoning, edits) — a summary line that says nothing offers nothing.
function segmentLabel(seg: TurnSegment) {
  const parts: string[] = [];
  if (seg.toolCalls) parts.push(plural(seg.toolCalls, "tool call"));
  if (seg.messages) parts.push(plural(seg.messages, "message"));
  return parts.join(" · ") || plural(seg.rows, "step");
}

/// One turn: the user's prompt, a collapsed summary of the work, and the final
/// answer. Expanding reveals the intermediate steps.
export default function TurnBlock({
  turn,
  subagentById,
  resultByCallId,
  onOpenSubagent,
  onOpenSession,
  footer,
}: TurnBlockProps) {
  // Per segment, not per turn: a stretch of work between queued prompts opens
  // and closes on its own, so peeking at one leaves the others collapsed. Keyed
  // by index, which is stable here — only a running turn's work still grows,
  // and a running turn is never collapsible. A turn without queued prompts is
  // one segment, so this is the old whole-turn toggle in that case.
  const [openSegments, setOpenSegments] = useState<Record<number, boolean>>({});

  const running = turn.completed === null;

  // `finalText` duplicates the turn's last `assistant_text`, so the collapsed
  // view renders it in that message's place rather than alongside it. A running
  // turn has no `finalText` yet, so its work stays visible instead.
  //
  // `rows` rather than `work.length` or the summary counts: a turn whose only
  // work *is* that final message has nothing left to reveal and would offer an
  // empty toggle. See `COLLAPSE_MIN` for why the threshold is what it is.
  const collapsible = !running && turn.rows >= COLLAPSE_MIN;

  const segments = collapsible ? segmentWork(turn) : [];
  // The last message lives in the last segment, so opening that segment is what
  // puts it on screen twice if `finalText` keeps rendering.
  const lastOpen = collapsible && !!openSegments[segments.length - 1];

  return (
    <div className="flex flex-col gap-3">
      {turn.prompt && <UserMessage {...userProps(turn)} onOpenSession={onOpenSession} />}

      {/* The work is cut at each queued prompt and each stretch collapses
          behind its own summary line — hiding the rows between the prompts
          would bunch them all together at the end, and *when* the reader said
          something is part of what they said. */}
      {!collapsible
        ? turn.work.map((item) =>
            renderItem(item, subagentById, resultByCallId, onOpenSubagent, onOpenSession),
          )
        : segments.map((seg, i) => {
            const open = !!openSegments[i];
            return (
              <Fragment key={i}>
                {seg.rows > 0 && (
                  <button
                    type="button"
                    onClick={() => setOpenSegments((prev) => ({ ...prev, [i]: !prev[i] }))}
                    className="group/turn flex items-center gap-2 text-left text-chat text-muted-foreground"
                  >
                    <span>{segmentLabel(seg)}</span>
                    <ChevronRight
                      className={cn(
                        "size-3 shrink-0 transition-all",
                        open ? "rotate-90 opacity-100" : "opacity-0 group-hover/turn:opacity-100",
                      )}
                    />
                  </button>
                )}
                {open &&
                  seg.items.map((item) =>
                    renderItem(item, subagentById, resultByCallId, onOpenSubagent, onOpenSession),
                  )}
                {seg.prompt &&
                  renderItem(
                    seg.prompt,
                    subagentById,
                    resultByCallId,
                    onOpenSubagent,
                    onOpenSession,
                  )}
              </Fragment>
            );
          })}

      {/* Collapsed, this stands in for the turn's last message; with the last
          segment open, that message already rendered above, so it would be a
          duplicate. */}
      {!lastOpen && collapsible && turn.finalText && <AssistantMessage text={turn.finalText} />}

      {footer}

      {turn.completed && (
        <EventRow
          event={turn.completed}
          resultByCallId={resultByCallId}
        />
      )}
    </div>
  );
}

/// One work item, shared by the expanded walk and a segment's queued prompt so
/// the two views cannot drift on how a row draws.
function renderItem(
  item: WorkItem,
  subagentById: Map<string, SubagentRun>,
  resultByCallId: Map<string, ToolResult>,
  onOpenSubagent: (id: string) => void,
  onOpenSession: (sessionId: string) => void,
) {
  if (isToolGroup(item)) {
    return <ToolGroupRow key={item.key} group={item} resultByCallId={resultByCallId} />;
  }

  const run =
    item.payload.type === "tool_call_started"
      ? subagentById.get(item.payload.callId)
      : undefined;

  return run ? (
    <SubagentRow key={item.id} run={run} onOpen={onOpenSubagent} />
  ) : (
    <EventRow
      key={item.id}
      event={item}
      resultByCallId={resultByCallId}
      onOpenSession={onOpenSession}
    />
  );
}

/// `prompt` is always a `user_message` here — the grouping only opens a turn on
/// one — but the payload union has to be narrowed for the props to typecheck.
function userProps(turn: Turn) {
  const payload = turn.prompt?.payload;
  return payload?.type === "user_message"
    ? {
        text: payload.text,
        images: payload.images,
        issues: payload.issues,
        from: payload.from,
      }
    : { text: "" };
}
