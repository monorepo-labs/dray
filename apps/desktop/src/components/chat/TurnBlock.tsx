import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import AssistantMessage from "@/components/chat/AssistantMessage";
import EventRow from "@/components/chat/EventRow";
import MediaRow from "@/components/chat/MediaRow";
import SubagentRow from "@/components/chat/SubagentRow";
import ToolGroupRow from "@/components/chat/ToolGroupRow";
import UserMessage from "@/components/chat/UserMessage";
import { drawsSameTurn, GROUP_MIN, isToolGroup, rendersRow, segmentMedia, segmentWork, type SubagentRun, type Turn, type TurnSegment, type WorkItem } from "@/lib/transcript";
import type { FileEdit, ToolResult } from "@/types/events";
import { cn } from "@/lib/utils";

type TurnBlockProps = {
  turn: Turn;
  subagentById: Map<string, SubagentRun>;
  resultByCallId: Map<string, ToolResult>;
  editsByCallId?: Map<string, FileEdit[]>;
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
function segmentLabel(seg: Pick<TurnSegment, "toolCalls" | "messages" | "rows">) {
  const parts: string[] = [];
  if (seg.toolCalls) parts.push(plural(seg.toolCalls, "tool call"));
  if (seg.messages) parts.push(plural(seg.messages, "message"));
  return parts.join(" · ") || plural(seg.rows, "step");
}

/// One turn: the user's prompt, a collapsed summary of the work, and the final
/// answer. Expanding reveals the intermediate steps.
export default memo(function TurnBlock({
  turn,
  subagentById,
  resultByCallId,
  editsByCallId,
  onOpenSubagent,
  onOpenSession,
  footer,
}: TurnBlockProps) {
  // Per segment, not per turn: a stretch of work between queued prompts opens
  // and closes on its own, so peeking at one leaves the others collapsed. Keyed
  // by index, which is stable here — a running turn only ever appends to its
  // last segment or opens a new one after it. A turn without queued prompts is
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

  // A running turn is cut the same way, so the stretches before a queued prompt
  // already sit in the shape they will finish in and only the stretch being
  // worked on is live.
  const segments = collapsible || running ? segmentWork(turn) : [];
  // The last message lives in the last segment, so opening that segment is what
  // puts it on screen twice if `finalText` keeps rendering.
  const lastOpen = collapsible && !!openSegments[segments.length - 1];

  /// One work item, shared by the expanded walk and a segment's queued prompt
  /// so the two views cannot drift on how a row draws.
  const renderItem = (item: WorkItem) => {
    if (isToolGroup(item)) {
      return (
        <ToolGroupRow
          key={item.key}
          group={item}
          resultByCallId={resultByCallId}
          editsByCallId={editsByCallId}
        />
      );
    }

    const run =
      item.payload.type === "tool_call_started"
        ? subagentById.get(item.payload.callId)
        : undefined;

    // An `inline` run draws its spawning tool row, which for a harness that
    // reports nothing about the child is the whole run — see `SubagentRun`.
    return run && !run.inline ? (
      <SubagentRow key={item.id} run={run} onOpen={onOpenSubagent} />
    ) : (
      <EventRow
        key={item.id}
        event={item}
        resultByCallId={resultByCallId}
        editsByCallId={editsByCallId}
        onOpenSession={onOpenSession}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {turn.prompt && <UserMessage {...userProps(turn)} onOpenSession={onOpenSession} />}

      {/* The work is cut at each queued prompt and each stretch collapses
          behind its own summary line — hiding the rows between the prompts
          would bunch them all together at the end, and *when* the reader said
          something is part of what they said. */}
      {segments.length === 0
        ? turn.work.map(renderItem)
        : segments.map((seg, i) => {
            const open = !!openSegments[i];
            const toggle = () => setOpenSegments((prev) => ({ ...prev, [i]: !prev[i] }));
            // Same index as the finished turn's last segment, so a fold the
            // reader opened mid-turn is still open when the turn lands.
            if (running && i === segments.length - 1) {
              return (
                <LiveWork key={i} items={seg.items} open={open} onToggle={toggle} renderItem={renderItem} />
              );
            }
            // Open, every row draws its own pictures; closed, they would be
            // behind the click, so they are lifted out under the summary.
            const media = open ? null : segmentMedia(seg.items, turn.finalText);
            return (
              <Fragment key={i}>
                {seg.rows > 0 && <SummaryToggle label={segmentLabel(seg)} open={open} onToggle={toggle} />}
                {media && media.length > 0 && <MediaRow media={media} />}
                {open && seg.items.map(renderItem)}
                {seg.prompt && renderItem(seg.prompt)}
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
          editsByCallId={editsByCallId}
        />
      )}
    </div>
  );
}, drawsTheSame);

function SummaryToggle({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group/turn flex items-center gap-2 text-left text-chat text-muted-foreground"
    >
      <span className="tabular-nums">{label}</span>
      <ChevronRight
        className={cn(
          "size-3 shrink-0 transition-all",
          open ? "rotate-90 opacity-100" : "opacity-0 group-hover/turn:opacity-100",
        )}
      />
    </button>
  );
}

/// How many of a running turn's newest rows stay on screen. Older ones fold
/// behind the summary line the finished turn draws, so a long turn stops
/// growing down the screen and lands already in its finished shape.
const LIVE_ROWS = 5;

/// The stretch of a running turn being worked on. Until it holds more than
/// `LIVE_ROWS` rows it draws them as they come. Past that the window over them
/// slides rather than snapping, so a row leaving it scrolls up under the
/// summary line and fades out. Rows vary in height, so the window is measured:
/// its top is the oldest row still shown, its height everything below that.
function LiveWork({
  items,
  open,
  onToggle,
  renderItem,
}: {
  items: WorkItem[];
  open: boolean;
  onToggle: () => void;
  renderItem: (item: WorkItem) => ReactNode;
}) {
  const [view, setView] = useState<{ offset: number; height: number } | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const rows = items.filter(rendersRow);
  const hidden = rows.slice(0, Math.max(0, rows.length - LIVE_ROWS));

  const measure = useCallback(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const first = inner.children[Math.max(0, inner.children.length - LIVE_ROWS)] as HTMLElement | undefined;
    const offset = first?.offsetTop ?? 0;
    const height = inner.offsetHeight - offset;
    setView((v) => (v && v.offset === offset && v.height === height ? v : { offset, height }));
  }, []);

  useLayoutEffect(measure);
  // A row growing on its own — expanded, or a message wrapping as the pane
  // narrows — moves the window too, and no render of this one says so.
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const windowed = !open && hidden.length > 0 && view !== null;
  let toolCalls = 0;
  let messages = 0;
  for (const item of hidden) {
    if (isToolGroup(item)) toolCalls += item.calls.length;
    else if (item.payload.type === "tool_call_started") toolCalls += 1;
    else if (item.payload.type === "assistant_text") messages += 1;
  }

  return (
    <>
      {hidden.length > 0 && (
        <SummaryToggle
          label={segmentLabel({ toolCalls, messages, rows: hidden.length })}
          open={open}
          onToggle={onToggle}
        />
      )}
      <div
        className={cn(
          "overflow-hidden transition-[height] duration-300 ease-out",
          windowed && "[mask-image:linear-gradient(to_bottom,transparent,black_3rem)]",
        )}
        style={windowed ? { height: view.height } : undefined}
      >
        <div
          ref={innerRef}
          className="relative flex flex-col gap-3 transition-transform duration-300 ease-out"
          style={windowed ? { transform: `translateY(${-view.offset}px)` } : undefined}
        >
          {rows.map((item, i) => (
            // A row above the window is clipped, not gone: `inert` keeps focus
            // out of it, or tabbing in would scroll this box under the transform.
            <div key={isToolGroup(item) ? item.key : item.id} inert={windowed && i < hidden.length}>
              {renderItem(item)}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/// Whether a turn would draw what it drew last time — its callbacks and footer
/// by identity, its data by [`drawsSameTurn`].
function drawsTheSame(a: TurnBlockProps, b: TurnBlockProps): boolean {
  return (
    a.footer === b.footer &&
    a.onOpenSubagent === b.onOpenSubagent &&
    a.onOpenSession === b.onOpenSession &&
    drawsSameTurn(a, b)
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
        cwd: payload.cwd,
      }
    : { text: "" };
}
