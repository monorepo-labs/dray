import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

import AssistantMessage from "@/components/chat/AssistantMessage";
import BackgroundTasksIndicator from "@/components/chat/BackgroundTasksIndicator";
import CheckpointRail, { type Checkpoint } from "@/components/chat/CheckpointRail";
import ApiRetryIndicator from "@/components/chat/ApiRetryIndicator";
import CompactingIndicator from "@/components/chat/CompactingIndicator";
import PermissionRequest from "@/components/chat/PermissionRequest";
import QueuedMessages from "@/components/chat/QueuedMessages";
import QuestionRequest from "@/components/chat/QuestionRequest";
import Reasoning from "@/components/chat/Reasoning";
import WorkingIndicator from "@/components/chat/WorkingIndicator";
import StreamingToolCall from "@/components/chat/StreamingToolCall";
import TurnBlock from "@/components/chat/TurnBlock";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatCwdContext } from "@/hooks/useChatCwd";
import { useHotkey } from "@/hooks/useHotkey";
import type { ApiRetryState, StreamingBlock, Working } from "@/hooks/useSessions";
import { IS_MAC } from "@/lib/platform";
import { toolArgument } from "@/lib/tools";
import { buildTranscript, type PendingAsk } from "@/lib/transcript";
import { firstMount, grow, mountedTurns } from "@/lib/turnWindow";
import type { QueuedMessage, SessionSnapshot } from "@/types/events";

type ChatProps = {
  session: SessionSnapshot | null;
  streamingBlock: StreamingBlock | null;
  onOpenSubagent: (id: string) => void;
  /// Opens the session that relayed a prompt into this one, for the avatar a
  /// `dray send` message draws. Selecting the session is all it does — the same
  /// thing clicking its sidebar row does.
  onOpenSession: (sessionId: string) => void;
  /// Opens the subagent panel on no particular run — what the background-task
  /// notice needs, since it stands for the whole set rather than for one of them.
  onOpenSubagentPanel: () => void;
  /// Answers a permission request. The agent is blocked until this fires, so it
  /// is the one callback here whose absence stalls a session rather than
  /// degrading a view.
  onRespondPermission: (requestId: string, optionId: string) => void;
  /// Answers an `AskUserQuestion`. Blocks the agent the same way, and an empty
  /// map is a real answer — the reader skipped every question.
  onAnswerQuestions: (requestId: string, answers: Record<string, string>) => void;
  /// Whether this session has a turn in flight, so the transcript can show the
  /// agent is still working.
  busy?: boolean;
  /// The current blank-screen wait, or null when something is rendering. Decides
  /// whether the working indicator shows, and carries the token count it draws.
  working?: Working | null;
  /// Outstanding async subagents. Rendered after the turns rather than inside
  /// one: the tasks outlive the turn that spawned them, so no single block owns
  /// them — unlike the working indicator, which must sit where its turn's
  /// text will land.
  backgroundTaskCount?: number;
  /// The ids of those tasks, for `buildTranscript`: a call whose task the child
  /// still holds stays pending after its turn ends.
  liveTaskIds?: ReadonlySet<string>;
  /// Whether a compaction is running. Sits beside the task indicator for the
  /// same reason: it belongs to the session, not to any one turn.
  compacting?: boolean;
  apiRetry?: ApiRetryState | null;
  /// Prompts typed into the running turn that the app has not handed to the CLI
  /// yet. Rendered here rather than built from the log, because a held prompt is
  /// deliberately unpersisted until it is delivered.
  queuedMessages?: QueuedMessage[];
  /// Both side panes are open, so the pane is at its narrowest and the rail sits
  /// close to the text. Passed in rather than measured here: the shell owns those
  /// two toggles, and the rail overlays the transcript at every width anyway — so
  /// this is about how crowded the pane *is*, not whether the rail fits.
  crowded?: boolean;
  /// Whether the chat tab is the one on screen. The transcript is hidden rather
  /// than unmounted when another view tab is picked, so ⌘↓ has to be told to
  /// stop listening — otherwise it scrolls a pane nobody can see.
  active?: boolean;
};

/// How long an answered permission card holds its place before going.
///
/// Answering one and being asked the next are two separate events, so they land
/// in two commits. Removing the card on the first collapses the transcript by a
/// card's height, and the second grows it straight back — at the bottom of a
/// pinned scroller that reads as everything above lurching down and bouncing up.
/// Waiting one beat lets the replacement arrive in the same commit, turning two
/// jumps into one small resize.
///
/// Only tuned against the fast case, which is the one that jitters: a gap longer
/// than this still clears the card first, and reads as two separate things
/// happening because it is.
const CARD_EXIT_MS = 500;

/// How far below the top of the pane a turn has to start before it stops being
/// the one being read. Matches the content's own top padding, so the turn whose
/// prompt sits just under the header is the one the rail marks.
const ACTIVE_LINE_PX = 24;

/// The gap left above a turn jumped to from the rail, so the prompt doesn't sit
/// flush against the header.
const JUMP_PAD_PX = 12;

/// Below this the rail is one or two ticks describing what is already on screen,
/// which is chrome for nothing.
const RAIL_MIN = 2;

/// How close to the end counts as being at it. One threshold for two questions —
/// whether to keep pinning, and whether to offer the jump button — so the button
/// cannot appear while the transcript is still following its own bottom.
const AT_BOTTOM_PX = 40;

/// The cards to draw: the live set, but one beat behind when it empties.
function useLingeringCards(pending: PendingAsk[]): PendingAsk[] {
  const [shown, setShown] = useState(pending);

  // Identity changes on every event, so the effect keys off the ids instead —
  // re-running it per event would set state in a loop.
  const key = pending.map((request) => request.requestId).join(" ");
  const latest = useRef(pending);
  latest.current = pending;

  useEffect(() => {
    // Arrivals are never delayed; the agent is blocked on them.
    if (latest.current.length > 0) {
      setShown(latest.current);
      return;
    }

    const timer = setTimeout(
      () => setShown((prev) => (prev.length === 0 ? prev : [])),
      CARD_EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [key]);

  return shown;
}

export default function Chat({
  session,
  streamingBlock,
  onOpenSubagent,
  onOpenSession,
  onOpenSubagentPanel,
  onRespondPermission,
  onAnswerQuestions,
  busy = false,
  working = null,
  backgroundTaskCount = 0,
  liveTaskIds,
  compacting = false,
  apiRetry = null,
  queuedMessages = [],
  crowded = false,
  active = true,
}: ChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether to keep pinning to the bottom. Cleared once the user scrolls up, so
  // reading back through a transcript isn't yanked forward by incoming deltas.
  const followRef = useRef(true);

  // The same fact as the pin, but as state because the button renders from it.
  // Written from a scroll, a resize and a session switch alike: the transcript
  // growing under a reader who sat still fires no scroll event, and that is
  // exactly when there is newly something below to go to.
  const [atBottom, setAtBottom] = useState(true);
  const syncAtBottom = () => {
    const el = scrollRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX);
  };

  const { events, turns, subagentById, resultByCallId, editsByCallId, pendingAsks } = useMemo(
    () => buildTranscript(session?.events ?? [], busy, liveTaskIds),
    [session?.events, busy, liveTaskIds],
  );

  const cards = useLingeringCards(pendingAsks);

  // One tick per prompt. A turn with no prompt — a resumed log truncated
  // mid-conversation, or the promptless `init` a background subagent's
  // report-back opens — is not a checkpoint: there is nothing the reader wrote
  // to preview, and jumping to it lands on work with no question above it.
  const checkpoints = useMemo<Checkpoint[]>(
    () =>
      turns.flatMap((turn) => {
        const payload = turn.prompt?.payload;
        if (payload?.type !== "user_message") return [];
        // An image-only prompt has no text to preview, but it is still a place
        // in the conversation, so it gets a tick with a stand-in label.
        const preview =
          payload.text.trim() ||
          (payload.images.length > 1 ? `${payload.images.length} images` : "Image");
        return [{ key: turn.key, preview }];
      }),
    [turns],
  );

  const showRail = checkpoints.length >= RAIL_MIN;
  const [activeTurn, setActiveTurn] = useState<string | null>(null);

  // Told apart by the type `block_start` declared, not by content — thinking
  // deltas are plain text on the wire. Only one block streams at a time, so at
  // most one of these is non-empty.
  const streamingText = streamingBlock?.type === "text" ? streamingBlock.text : "";
  const streamingThinking =
    streamingBlock?.type === "thinking" ? streamingBlock.text : "";

  // A tool call the model is still composing. Unlike the two above this is
  // non-empty from the first frame — the block announces its tool before any
  // argument arrives, and having only the name is exactly the case the preview
  // exists to cover.
  const streamingTool =
    streamingBlock?.type === "tool_use" && streamingBlock.name
      ? { name: streamingBlock.name, partialJson: streamingBlock.text }
      : null;

  // Kept a string rather than a boolean: the scroll-pin effect below takes this
  // as a dependency, and prose re-pinning per delta depends on the value
  // changing as it grows. The tool preview is one fixed-height row, so a
  // constant is right for it — it only has to differ from "".
  const streamingAny = streamingText || streamingThinking || (streamingTool ? "tool" : "");

  // The turn the indicator belongs to, or null when nothing is waiting on
  // output.
  //
  // An *open* trailing turn is the whole test. Not "has a prompt": a run
  // routinely closes a turn and opens another with no `user_message` between
  // them, and that continuation turn is exactly when the indicator is wanted.
  // Requiring a prompt lost it for the rest of the session. The window between
  // the user hitting send and the backend echoing their message back is covered
  // by the same check from the other side — until the echo lands the previous
  // turn is still closed, so there is no open turn to attach to.
  //
  // Whether the turn is waiting comes from `working` — the harness says so
  // directly, announcing a model request within 30ms of every tool result and
  // again at the top of each turn. The old rule was "this turn has drawn no row
  // yet", which could only ever describe the *first* wait in a turn: after that
  // a row existed, so every later gap went unmarked. An agentic turn is mostly
  // later gaps, and a thinking block draws nothing for its whole duration.
  const lastTurn = turns.at(-1);
  //
  // A compaction suppresses it outright. The turn is genuinely open and drawing
  // nothing, so every test above passes — but the agent is not thinking, it is
  // waiting on the compaction, and `CompactingIndicator` already says so.
  //
  // A retry suppresses it for exactly that reason, and it matters more here:
  // attempts run to 10, so this is the longest blank stretch a turn has, and it
  // is the one the reader most needs a real explanation of rather than a word
  // picked at random.
  //
  // An open request — for consent or for an answer — suppresses it for the same
  // reason a compaction does, and now more strongly: the card renders outside
  // the turn, so the turn genuinely draws nothing and every other test passes —
  // but the agent is not thinking, it is waiting on the reader, who is looking
  // at the card.
  //
  // Gated on what is drawn, not on what is pending, so the indicator can't slip
  // into a lingering card's window and undo the quiet it buys.
  const waitingTurn =
    busy &&
    working &&
    !compacting &&
    !apiRetry &&
    cards.length === 0 &&
    lastTurn &&
    !lastTurn.completed &&
    !streamingAny
      ? lastTurn
      : null;

  // Which turn hosts the preview. It has to render inside the same stack the
  // committed `assistant_text` will land in, or the two sit at different gaps
  // (the between-turn gap is wider than the within-turn one) and the text
  // jumps by the difference on the swap.
  //
  // Always the open trailing turn while anything is streaming. `turn_completed`
  // maps from `result`, which fires once per run rather than per message, so a
  // turn stays open across every `message_start` in it — and after a `result`
  // the next thing is a `user_message`, which opens the next turn before any
  // delta arrives. So this is non-null whenever `streamingText` is.
  const streamingTurn =
    streamingAny && lastTurn && !lastTurn.completed ? lastTurn : null;

  // A new session resets the pin, or the previous session's scroll position
  // would decide whether this one follows. Must run before the pin effect below,
  // which is why it sits first.
  useLayoutEffect(() => {
    followRef.current = true;
  }, [session?.sessionId]);

  // Keyed on the session too: switching between transcripts with equal event
  // counts must still land at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
    syncAtBottom();
    syncActive();
  }, [session?.sessionId, events.length, streamingAny]);

  // How many of the newest turns are drawn. Opening a long session mounts only
  // what fits on screen and backfills the rest above it in deferred steps, so
  // the open costs what a short session costs — see `FIRST_MOUNT` for the
  // measurement. Keyed on the session inside the state rather than reset by an
  // effect, so a switch draws the new session's window on its very first
  // commit instead of one full render later.
  //
  // Held as the index of the oldest mounted turn, so a turn the live session
  // appends is inside the window without moving it — see `firstMount`.
  const [mount, setMount] = useState<{ sessionId: string | null; start: number }>({
    sessionId: null,
    start: 0,
  });
  const mounted =
    mount.sessionId === session?.sessionId ? mount.start : firstMount(turns.length);
  const shownTurns = mountedTurns(turns, mounted);
  const backfilling = mounted > 0;

  // Where the oldest mounted turn sat before a step lands, for the
  // compensation below. A node, not the scroller's height: anything else
  // growing between capture and commit — a delta, a highlight landing — sits
  // *below* this node and cannot move it, where it would have counted as
  // backfill in a height diff.
  const anchorBeforeStep = useRef<{ key: string; top: number } | null>(null);
  // A rail jump aimed at a turn not mounted yet, honoured once it is.
  const pendingJump = useRef<string | null>(null);

  // One step per macrotask, after the previous one has painted. A single
  // deferred pass would still hold the thread for the whole parse; steps keep
  // the pane responsive while the rest of the transcript fills in.
  useEffect(() => {
    if (!backfilling || !session) return;
    const sessionId = session.sessionId;
    const timer = setTimeout(() => {
      const oldest = contentRef.current?.querySelector<HTMLElement>("[data-turn]");
      anchorBeforeStep.current =
        oldest?.dataset.turn && !followRef.current
          ? { key: oldest.dataset.turn, top: oldest.getBoundingClientRect().top }
          : null;
      setMount({ sessionId, start: grow(mounted) });
    }, 0);
    return () => clearTimeout(timer);
  }, [backfilling, mounted, session?.sessionId]);

  // A step mounts turns *above* everything on screen, so left alone it would
  // shove what the reader is looking at down by their height. Pinned, the
  // bottom is re-taken; unpinned, the view is moved by exactly what the anchor
  // moved, so the turn the reader was in stays where it was.
  useLayoutEffect(() => {
    const anchor = anchorBeforeStep.current;
    anchorBeforeStep.current = null;
    const el = scrollRef.current;
    if (!el) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor) {
      const node = contentRef.current?.querySelector<HTMLElement>(
        `[data-turn="${anchor.key}"]`,
      );
      if (node) el.scrollTop += node.getBoundingClientRect().top - anchor.top;
    }

    const key = pendingJump.current;
    if (key && contentRef.current?.querySelector(`[data-turn="${key}"]`)) {
      pendingJump.current = null;
      jumpToTurn(key);
    }
  }, [mounted]);

  // Which turn the rail marks. Measured from the DOM rather than tracked as
  // state per turn: heights move constantly here — Shiki lands async, a turn
  // collapses, a diff expands — so anything cached from a previous layout is
  // wrong by the time it is read.
  //
  // Throttled to a frame because the pin writes `scrollTop` on every delta, and
  // each measurement forces layout.
  const spyFrame = useRef(0);
  const syncActive = () => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || !showRail) return;
    if (spyFrame.current) return;

    spyFrame.current = requestAnimationFrame(() => {
      spyFrame.current = 0;
      const nodes = content.querySelectorAll<HTMLElement>("[data-turn]");
      if (nodes.length === 0) return;

      const line = scroller.getBoundingClientRect().top + ACTIVE_LINE_PX;
      // The last turn to start above the line. Scrolled above the first prompt,
      // that is still the first — the transcript can only be read downwards.
      let key = nodes[0].dataset.turn ?? null;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top > line) break;
        key = node.dataset.turn ?? key;
      }

      // At the bottom the final turn often starts below the line and is what
      // the reader is looking at regardless — a short last turn would otherwise
      // never be markable.
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8) {
        key = nodes[nodes.length - 1].dataset.turn ?? key;
      }

      setActiveTurn(key);
    });
  };

  // Scrolls a prompt to the top of the pane and drops the pin — jumping back
  // through the transcript must not be yanked forward by the next delta. The
  // scroll's own `onScroll` re-decides the pin from where it lands, so a jump to
  // the newest turn re-arms it.
  const jumpToTurn = (key: string) => {
    const scroller = scrollRef.current;
    const node = contentRef.current?.querySelector<HTMLElement>(`[data-turn="${key}"]`);
    if (!scroller) return;
    // The rail lists every turn, mounted or not. A tick above the window
    // mounts everything and jumps once the node exists.
    if (!node) {
      if (session && backfilling) {
        pendingJump.current = key;
        setMount({ sessionId: session.sessionId, start: 0 });
      }
      return;
    }

    const top =
      node.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      JUMP_PAD_PX;

    followRef.current = false;
    setActiveTurn(key);
    scroller.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
  };

  useEffect(() => () => cancelAnimationFrame(spyFrame.current), []);

  // The rail overlays the scroller as a sibling rather than sitting inside it,
  // so a wheel over it reaches nothing on its own and the gutter becomes a dead
  // strip for the pointer. Forwarded by hand, but only once the rail itself has
  // no room left — a long session's rail scrolls first.
  const onRailWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const rail = e.currentTarget;
    const room =
      e.deltaY < 0
        ? rail.scrollTop > 0
        : rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1;
    if (room) return;

    // Line-mode deltas come from a wheel mouse; trackpads report pixels.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (delta < 0) followRef.current = false;
    scroller.scrollTop += delta;
  };

  // Heights change with no React commit involved — Shiki highlighting lands
  // async and grows the content, and the composer growing shrinks this pane from
  // outside. Observing both boxes is the only signal that covers all of it; the
  // callback runs after layout but before paint, so re-pinning here never
  // flickers. Re-armed per session because the empty state unmounts these nodes.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) scroller.scrollTop = scroller.scrollHeight;
      syncAtBottom();
      // A turn that grew or collapsed moves every turn under it, with no scroll
      // event to notice it by.
      syncActive();
    });
    ro.observe(scroller);
    ro.observe(content);
    return () => ro.disconnect();
  }, [session?.sessionId]);

  // Unfollow only on an upward gesture, not in onScroll: resize-induced clamp
  // scrolls land at the bottom and pinning writes land at the bottom, so
  // position alone re-confirms the pin — but a wheel-up during streaming must
  // win instantly, before the next delta's pin can yank the view back down.
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) followRef.current = false;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    setAtBottom(followRef.current);
    syncActive();
  };

  // Re-arms the pin as well as scrolling: pressing this is the reader saying they
  // want the live end, so the next delta must not leave them behind again.
  //
  // Smooth only while nothing is arriving. The pin writes `scrollTop` directly on
  // every delta and on every resize, and a direct write cancels an animation
  // mid-glide — so during a turn the smooth scroll would be cut short and land
  // somewhere above the bottom, which is the one place this button must not
  // leave you.
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: busy ? "auto" : "smooth" });
  };

  // Bound whether or not the button is drawn: the button is the affordance for
  // this, not its gate, and pressing it while already at the bottom re-arms the
  // pin — which is the useful half when a turn has scrolled you off it.
  useHotkey("ArrowDown", () => {
    if (active && session) scrollToBottom();
  });

  // With no session there is no transcript to draw; AppShell centers the
  // composer and skips this pane entirely.
  if (!session) return null;

  return (
    // What decides whether the rail fits is the width of *this pane*, which the
    // sidebar and the right panel both take from. On a 1440px window with both
    // open the chat column fills the pane and the rail would sit on top of the
    // text, so it goes; open one of them, or run wider, and the gutter is there.
    //
    // The cwd rides a context because the only thing that reads it is a
    // `@mention` several components down — see `useChatCwd`.
    <ChatCwdContext value={session.cwd}>
      <div className="relative h-full">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheel}
          className="h-full overflow-y-auto"
        >
          <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {shownTurns.map((turn) => (
              // The wrapper is what the rail measures and scrolls to. It carries
              // no styles of its own — it stands in for the block as the flex item.
              <div key={turn.key} data-turn={turn.key}>
                <TurnBlock
                  turn={turn}
                  subagentById={subagentById}
                  resultByCallId={resultByCallId}
                  editsByCallId={editsByCallId}
                  onOpenSubagent={onOpenSubagent}
                  onOpenSession={onOpenSession}
                  // Both cover the wait for output, and never at once —
                  // `waitingTurn` requires no streaming text. Inside the block so
                  // they sit at the gap the committed event will occupy, rather
                  // than the wider one between turns: the preview belongs to this
                  // turn, not after it.
                  footer={
                    turn === waitingTurn ? (
                      <WorkingIndicator tokens={working?.tokens ?? 0} />
                    ) : turn !== streamingTurn ? (
                      undefined
                    ) : streamingThinking ? (
                      // The same component the committed `reasoning` event renders
                      // with, in its `streaming` presentation — the multi-line
                      // preview keeps growing live; it collapses to one line once
                      // committed.
                      <Reasoning text={streamingThinking} encrypted={false} streaming />
                    ) : streamingTool ? (
                      // Must come before the text arm: a tool block leaves
                      // `streamingText` empty, so falling through would render an
                      // empty message where the row belongs.
                      <StreamingToolCall {...streamingTool} />
                    ) : (
                      <AssistantMessage text={streamingText} streaming />
                    )
                  }
                />
              </div>
            ))}

            {cards.map((ask) =>
              ask.type === "questions_asked" ? (
                <QuestionRequest
                  key={ask.requestId}
                  questions={ask.questions}
                  onAnswer={(answers) => onAnswerQuestions(ask.requestId, answers)}
                />
              ) : (
                <PermissionRequest
                  key={ask.requestId}
                  // The agent writes a description for nearly every call; the
                  // tool's own name is the floor, so the card always has a subject.
                  description={
                    ask.description ?? ask.title ?? ask.displayName ?? ask.toolName
                  }
                  argument={toolArgument(ask.input)}
                  options={ask.options}
                  onRespond={(optionId) => onRespondPermission(ask.requestId, optionId)}
                />
              ),
            )}

            <QueuedMessages messages={queuedMessages} />

            {backgroundTaskCount > 0 && (
              <BackgroundTasksIndicator
                count={backgroundTaskCount}
                onOpen={onOpenSubagentPanel}
              />
            )}

            {compacting && <CompactingIndicator />}

            {apiRetry && (
              <ApiRetryIndicator
                attempt={apiRetry.attempt}
                maxRetries={apiRetry.maxRetries}
                status={apiRetry.status}
                reason={apiRetry.reason}
              />
            )}
          </div>
        </div>

        {/* Centred on the pane and outside the scroller, so it holds its place
            while the transcript moves under it — the rail's own arrangement. Sits
            low enough to read as belonging to the composer's edge rather than
            floating over the last message. */}
        {!atBottom && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                // `secondary` for its fill, not its emphasis: this floats over moving
                // text, so it needs an opaque surface the way a menu does. `outline`'s
                // is `--input` at 30% — 4.5% white — which the transcript scrolls
                // straight through, and the vibrancy block veils `--card` and
                // `--muted` but deliberately leaves `--secondary` alone.
                variant="secondary"
                size="icon-sm"
                aria-label="Scroll to bottom"
                onClick={scrollToBottom}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border-border shadow-sm"
              >
                <ArrowDown />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-none whitespace-nowrap">
              Scroll to bottom
              <KbdGroup>
                <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
        )}

        {showRail && (
          <CheckpointRail
            checkpoints={checkpoints}
            activeKey={activeTurn}
            onSelect={jumpToTurn}
            onWheel={onRailWheel}
            dimmed={crowded}
            // Centred vertically and outside the scroller, so it holds still while
            // the transcript moves under it.
            className="absolute left-1.5 top-1/2 -translate-y-1/2"
          />
        )}
      </div>
    </ChatCwdContext>
  );
}
