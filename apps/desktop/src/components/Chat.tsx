import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";

import AssistantMessage from "@/components/chat/AssistantMessage";
import BotTranscript, { type BotTask } from "@/components/chat/BotTranscript";
import BackgroundTasksIndicator from "@/components/chat/BackgroundTasksIndicator";
import { IssueCardChatContext } from "@/components/chat/IssueCard";
import { MergeCardChatContext } from "@/components/chat/MergeCard";
import ApiRetryIndicator from "@/components/chat/ApiRetryIndicator";
import PermissionRequest from "@/components/chat/PermissionRequest";
import QueuedMessages from "@/components/chat/QueuedMessages";
import QuestionRequest from "@/components/chat/QuestionRequest";
import { ReactionsContext, type Reactions } from "@/components/chat/Reactions";
import Reasoning from "@/components/chat/Reasoning";
import WorkingIndicator, { OrbLine } from "@/components/chat/WorkingIndicator";
import StreamingToolCall from "@/components/chat/StreamingToolCall";
import TurnBlock from "@/components/chat/TurnBlock";
import { Button } from "@/components/ui/button";
import ShortcutKeys from "@/components/ShortcutKeys";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatSessionContext } from "@/hooks/useChatSession";
import { useHotkey } from "@/hooks/useHotkey";
import type { ApiRetryState, QueuedPrompt, Working } from "@/hooks/useSessions";
import { useStreamingBlock, useStreamingKind } from "@/hooks/useStreamingBlock";
import { RANK_OWN } from "@/lib/cardKeys";
import { planAsked, setPlan } from "@/lib/plan";
import { toolArgument } from "@/lib/tools";
import { buildTranscript, type PendingAsk } from "@/lib/transcript";
import { drawnSegments, earlierTurns, lastTurns } from "@/lib/botTranscript";
import { readerMessagesAfter } from "@/lib/mergeCard";
import { isProvisional } from "@/lib/provisional";
import { dropOlder, loadOlder } from "@/lib/olderPages";
import { readerReactions } from "@/lib/reactions";
import { issueStarts, startsKey } from "@/lib/issueCard";
import { invoke } from "@/lib/transport";
import type { Bot, SessionSnapshot } from "@/types/events";

type ChatProps = {
  session: SessionSnapshot | null;
  onOpenSubagent: (id: string) => void;
  /// Opens the session that relayed a prompt into this one, for the avatar a
  /// `dray send` message draws. Selecting the session is all it does — the same
  /// thing clicking its sidebar row does. `alone` is a bot chat's ⌘-click on a
  /// task, which opens it in place of the chat rather than as a tab beside it.
  onOpenSession: (sessionId: string, alone?: boolean) => void;
  /// Opens the subagent panel on no particular run — what the background-task
  /// notice needs, since it stands for the whole set rather than for one of them.
  onOpenSubagentPanel: () => void;
  /// Opens the panel's Plan tab, for the button on a plan approval card.
  onOpenPlan: () => void;
  /// Answers a permission request. The agent is blocked until this fires, so it
  /// is the one callback here whose absence stalls a session rather than
  /// degrading a view.
  onRespondPermission: (sessionId: string, requestId: string, optionId: string) => void;
  /// Answers an `AskUserQuestion`. Blocks the agent the same way, and an empty
  /// map is a real answer — the reader skipped every question.
  onAnswerQuestions: (
    sessionId: string,
    requestId: string,
    answers: Record<string, string>,
  ) => void;
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
  queuedMessages?: QueuedPrompt[];
  onSendNow?: () => void;
  /// Whether the chat tab is the one on screen. The transcript is hidden rather
  /// than unmounted when another view tab is picked, so ⌘↓ has to be told to
  /// stop listening — otherwise it scrolls a pane nobody can see.
  active?: boolean;
  /// A bot's chat: messages and the tasks it started, tool calls only as the
  /// live line while it works. See [BotTranscript].
  bot?: boolean;
  /// A bot chat's earlier sessions, oldest first, from before it switched
  /// agent. Drawn above this one as one conversation.
  earlier?: SessionSnapshot[];
  /// An earlier session still loading, older than every one in `earlier`.
  earlierLoading?: boolean;
  /// Names a task the bot started, for its card.
  taskOf?: (sessionId: string) => BotTask | undefined;
  /// Opens another bot's chat, from a message between it and this one.
  onOpenBot?: (bot: Bot) => void;
  /// The session had unread replies, for a bot chat's NEW divider.
  unread?: boolean;
  /// Drawn under a bot chat's conversation: its stalled tasks.
  botFooter?: ReactNode;
  /// A task picked from that card, scrolled to. See [BotTranscript]'s `focus`.
  botFocus?: { sessionId: string; at: number } | null;
  /// That pick found nothing to scroll to, with the whole chat read back.
  onBotFocusMissed?: (sessionId: string) => void;
};

const NO_EARLIER: SessionSnapshot[] = [];

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

/// The gap left above a reply jumped to from a bot's "Waiting on you" card, so
/// it doesn't sit flush against the header.
const JUMP_PAD_PX = 12;

/// Longest a smooth jump is taken to glide before a scroll is the reader's own
/// again.
const GLIDE_MS = 1500;

/// Turns per page while a bot chat reads back to a picked task's reply. Each
/// page lands as one render of the whole app, which costs far more than the
/// read, so a long way back is taken in few of them.
const FOCUS_PAGE_TURNS = 64;

/// Turns a chat draws while the reader follows its bottom: the tail it opens on
/// and a page above it.
const WINDOW_TURNS = 24;
/// Turns drawn above at a time as the reader nears the top of what is drawn, as
/// many as a page read from the log holds.
const OLDER_TURNS = 16;
/// A chat's window drawing everything held.
const ALL_HELD = "all";

/// How close to the end counts as being at it. One threshold for two questions —
/// whether to keep pinning, and whether to offer the jump button — so the button
/// cannot appear while the transcript is still following its own bottom.
const AT_BOTTOM_PX = 40;

/// The cards to draw: the live set, but one beat behind when it empties.
///
/// Held with the session they belong to. The single view keeps one `Chat`
/// across a switch, so cards held bare drew session A's card in B for the
/// length of the exit, answered under B's id, and copied A's plan into B.
function useLingeringCards(sessionId: string | null, pending: PendingAsk[]): PendingAsk[] {
  const [shown, setShown] = useState({ sessionId, cards: pending });

  // Identity changes on every event, so the effect keys off the ids instead —
  // re-running it per event would set state in a loop.
  const key = pending.map((request) => request.requestId).join(" ");
  const latest = useRef(pending);
  latest.current = pending;

  useEffect(() => {
    // Arrivals are never delayed; the agent is blocked on them.
    if (latest.current.length > 0) {
      setShown({ sessionId, cards: latest.current });
      return;
    }

    const timer = setTimeout(
      () =>
        setShown((prev) =>
          prev.sessionId === sessionId && prev.cards.length === 0 ? prev : { sessionId, cards: [] },
        ),
      CARD_EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [key, sessionId]);

  return shown.sessionId === sessionId ? shown.cards : pending;
}

/// Double-click on inline code selects the whole run, not the word under the
/// pointer — a path or command split at `/` or `-` is never what was wanted.
/// Code inside `pre` keeps the browser's word selection.
function selectInlineCode(e: React.MouseEvent) {
  const code = (e.target as Element).closest?.("code");
  if (!code || code.closest("pre")) return;
  const range = document.createRange();
  range.selectNodeContents(code);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export default function Chat({
  session,
  onOpenSubagent,
  onOpenSession,
  onOpenSubagentPanel,
  onOpenPlan,
  onRespondPermission,
  onAnswerQuestions,
  busy = false,
  working = null,
  backgroundTaskCount = 0,
  liveTaskIds,
  compacting = false,
  apiRetry = null,
  queuedMessages = [],
  onSendNow,
  active = true,
  bot = false,
  earlier = NO_EARLIER,
  earlierLoading = false,
  taskOf,
  onOpenBot,
  unread = false,
  botFooter,
  botFocus,
  onBotFocusMissed,
}: ChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether to keep pinning to the bottom. Cleared once the user scrolls up, so
  // reading back through a transcript isn't yanked forward by incoming deltas.
  const followRef = useRef(true);
  // Where the last pin left the scroller, for telling a scroll the reader made
  // from one the pin's own write queued — see `onScroll`. Every pin goes
  // through `pin` so the two cannot disagree.
  const pinnedTop = useRef(-1);
  // A smooth jump in flight: where it lands, and until when. Leaving the
  // bottom, its first frames are still within reach of the end, and read as
  // the reader coming back they re-took the pin, which cancelled the glide, and
  // let a bot chat's window go, which dropped the row it was headed for.
  const glide = useRef<{ to: number; until: number } | null>(null);
  const glideTo = (el: HTMLElement, top: number) => {
    const to = Math.min(Math.max(top, 0), el.scrollHeight - el.clientHeight);
    glide.current = { to, until: performance.now() + GLIDE_MS };
    el.scrollTo({ top: to, behavior: "smooth" });
  };

  // Pads the top so the newest turn starts on a whole pixel. WebKit scrolls in
  // whole pixels, so every page mounting a fractional height above put the
  // turns on screen a different fraction off the grid, and the rounding moved
  // them a pixel per page — a wobble while history landed. Measured
  // in an offscreen WKWebView: snapping to device pixels instead still wobbles.
  // The pad rides the node as `--snap`, since the empty state remounts it.
  const lastTurnRef = useRef<HTMLDivElement>(null);
  const snapToPixel = () => {
    const content = contentRef.current;
    const last = lastTurnRef.current;
    if (!content || !last) return;
    const held = parseFloat(content.style.getPropertyValue("--snap")) || 0;
    const offset = last.getBoundingClientRect().top - content.getBoundingClientRect().top - held;
    const extra = Math.max(0, Math.ceil(offset - 1e-3) - offset);
    if (Math.abs(extra - held) < 1e-3) return;
    content.style.setProperty("--snap", `${extra}px`);
  };
  const pin = (el: HTMLElement) => {
    glide.current = null;
    snapToPixel();
    el.scrollTop = el.scrollHeight;
    pinnedTop.current = el.scrollTop;
  };

  // The same fact as the pin, but as state because the button renders from it.
  // Written from a scroll, a resize and a session switch alike: the transcript
  // growing under a reader who sat still fires no scroll event, and that is
  // exactly when there is newly something below to go to.
  const [atBottom, setAtBottom] = useState(true);

  // How much of the newest session is drawn. A chat left open grows by every
  // turn, and each row it holds cost every event that landed: with a bot's whole
  // log read back, an event took ~40ms. So while the reader follows the bottom
  // (`null`) it draws the last `WINDOW_TURNS` alone, sliding as turns land;
  // scrolled up, the top holds on an event id, grown a page at a time as they
  // near it, or on `ALL_HELD`, where pages read from the log are drawn as they
  // land. Back at the bottom it slides again, and what was above goes. Keyed on
  // the session inside the state, so a switch draws the new session's tail on
  // its very first commit. `turns` is how many the sliding window draws: more
  // than `WINDOW_TURNS` where those fill less than a screen above the bottom.
  const [drawn, setDrawn] = useState<{ sessionId: string | null; from: string | null; turns: number }>({
    sessionId: null,
    from: null,
    turns: WINDOW_TURNS,
  });
  const mine = drawn.sessionId === session?.sessionId;
  const held = mine ? drawn.from : null;
  const slideTurns = mine ? drawn.turns : WINDOW_TURNS;
  const holdWindow = (from: string | null) => {
    if (held !== from) setDrawn({ sessionId: session?.sessionId ?? null, from, turns: WINDOW_TURNS });
  };
  const drawFrom = useMemo(() => {
    if (!session || held === ALL_HELD) return 0;
    const at = held ? session.events.findIndex((e) => e.id === held) : -1;
    return at >= 0 ? at : lastTurns(session.events, slideTurns);
  }, [session?.events, held, slideTurns]);
  // Pages read above a sliding window are let go, so a chat read back and left
  // holds its tail again. Turns that landed live stay held, since only a page
  // read says where in the log it began.
  const keepFrom = held === null && drawFrom > 0 ? session?.events[drawFrom]?.id : undefined;
  useEffect(() => {
    if (session && keepFrom) dropOlder(session.sessionId, keepFrom);
  }, [session?.sessionId, keepFrom]);
  // The sessions before an agent switch go back to the tails they opened on.
  const following = held === null;
  useEffect(() => {
    if (following) for (const s of earlier) dropOlder(s.sessionId);
  }, [following, earlier]);
  // A bot chat's sessions as drawn. Held across renders: a fresh array would
  // rebuild the bot chat's rows on every event. A windowed session says it has
  // more above, so the sessions before it stay undrawn and the unread divider
  // waits, as they do for a session not yet read back to its start.
  const segments = useMemo(() => {
    const live =
      session && drawFrom > 0
        ? { ...session, events: session.events.slice(drawFrom), olderBefore: session.olderBefore ?? 0 }
        : session;
    return drawnSegments(live ? [...earlier, live] : earlier);
  }, [earlier, session, drawFrom]);
  const oldest = segments[0];
  const more = oldest?.olderBefore != null || earlierLoading;
  // Moves when a page lands above, which is what the anchor below answers.
  const oldestKey = oldest ? `${oldest.sessionId}:${oldest.events[0]?.id}` : "";
  const syncAtBottom = () => {
    const el = scrollRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX);
  };

  // Every held event, never the window: a card can wait on the reader longer
  // than 24 turns, a call drawn in it can be answered after it, and App builds
  // this same array, whose cache it shares.
  const { events, turns, subagentById, resultByCallId, editsByCallId, pendingAsks } = useMemo(
    () => buildTranscript(session?.events ?? [], busy, liveTaskIds),
    [session?.events, busy, liveTaskIds],
  );

  const sessionId = session?.sessionId ?? null;
  const cards = useLingeringCards(sessionId, pendingAsks);

  // The plan is copied out of the ask because the ask is the only place it
  // exists: a permission request is never persisted, and the `exit_plan_mode`
  // call beside it carries an empty input. Safe in an effect that re-runs on
  // every session event, since `setPlan` ignores a text it already holds.
  useEffect(() => {
    for (const ask of cards) {
      if (ask.type !== "permission_requested") continue;
      const plan = planAsked(ask.toolName, ask.input);
      if (plan) setPlan(sessionId, plan);
    }
  }, [cards, sessionId]);

  // Which kind of preview is open, not its text: the text grows on every
  // delta and only `StreamingPreview` reads it, so the transcript around it
  // re-renders when a block opens or retires rather than per token.
  const streamingKind = useStreamingKind(session?.sessionId ?? null);

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
  // waiting on the compaction, and the compacting line already says so.
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
  // On fx the orb rides *beside* the preview instead of standing in for it.
  // Nothing closes an fx block until the next update arrives, so a message that
  // finished streaming sits there looking finished while the model works on in
  // silence — the reader watches a complete sentence and a dead screen, then
  // two tool calls land at once. Every other harness earns the suppression: its
  // preview is still growing, or a tool block has opened with arguments
  // streaming into it, so something on screen is moving. fx's is not, and there
  // is no way to tell its stalled preview from its slow one.
  const orbRidesPreview = session?.harness === "fx";

  const waitingTurn =
    busy &&
    working &&
    !compacting &&
    !apiRetry &&
    cards.length === 0 &&
    lastTurn &&
    !lastTurn.completed &&
    (!streamingKind || orbRidesPreview)
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
  // delta arrives. So this is non-null whenever a text preview is.
  const streamingTurn =
    streamingKind && lastTurn && !lastTurn.completed ? lastTurn : null;

  // One element across renders. `TurnBlock`'s memo compares its footer by
  // identity, so built inline the turn being streamed into re-rendered every
  // time this component did, whatever had changed. Both hosts are the last
  // turn or nothing, which is what lets one element serve.
  const previewShown = !!streamingTurn;
  const orbShown = !!waitingTurn;
  const orbTokens = working?.tokens ?? 0;
  const liveFooter = useMemo(
    () =>
      sessionId && (previewShown || orbShown) ? (
        <>
          {previewShown && <StreamingPreview sessionId={sessionId} />}
          {orbShown && <WorkingIndicator tokens={orbTokens} />}
        </>
      ) : undefined,
    [sessionId, previewShown, orbShown, orbTokens],
  );

  // A new session resets the pin, or the previous session's scroll position
  // would decide whether this one follows. Must run before the pin effect below,
  // which is why it sits first.
  useLayoutEffect(() => {
    followRef.current = true;
  }, [session?.sessionId]);

  // Keyed on the session too: switching between transcripts with equal event
  // counts must still land at the bottom. A preview *growing* is not a key: the
  // ResizeObserver below re-pins on every height it adds, where keying on the
  // text wrote `scrollTop` and read layout back on every delta.
  //
  // A send re-arms the pin first, whatever left it down: a scroll that stopped
  // short of the end, a jump from the "Waiting on you" card, a
  // smooth scroll cut short. Only the pin ever brought a send into view, so any
  // of those left the reader's own message below the fold. A send is told by
  // its provisional row *arriving*: every send here draws one, and the real
  // message replacing it, or a queue or failure taking it back, only ever
  // lowers the count, so a reader who scrolled up meanwhile stays put.
  const sent = useMemo(() => session?.events.filter(isProvisional).length ?? 0, [session?.events]);
  const sentRef = useRef(sent);
  useLayoutEffect(() => {
    if (sent > sentRef.current) followRef.current = true;
    sentRef.current = sent;
    const el = scrollRef.current;
    if (el && followRef.current) pin(el);
    syncAtBottom();
  }, [session?.sessionId, events.length, streamingKind, sent]);

  // The turns from the window's first event on. A cut is always a prompt, and
  // a prompt always opens a turn keyed on its own id.
  const shownTurns = useMemo(() => {
    if (drawFrom === 0 || !session) return turns;
    const first = session.events[drawFrom].id;
    return turns.slice(Math.max(0, turns.findIndex((turn) => turn.key === first)));
  }, [turns, drawFrom, session?.events]);

  // A chat can grow for as long as it is used, and drawing all of it was the
  // whole cost of opening a long one: it opens on its tail and reads a page
  // further back whenever the reader comes within a screen of the top. The
  // pane must also hold a screen above the bottom, or a short tail leaves
  // nothing to scroll and nothing is ever asked for. What is already held is
  // drawn before the log is read further.
  //
  // A window still sliding grows rather than holding. Held, the pin's own
  // scroll event read as the reader back at the bottom and let it go, and the
  // short tail asked again: a bot chat whose last turns draw nothing, its
  // replies to task reports, swapped its height every frame. It grows with a
  // page it reads too, or the page lands above it and is let go at once.
  const askOlder = () => {
    const el = scrollRef.current;
    if (!el || !session || el.scrollTop >= el.clientHeight) return;
    // `followRef` as well: a scroll up holds the window in this same event,
    // and `held` here is from before it.
    if (held === null && followRef.current && (drawFrom > 0 || oldest?.olderBefore != null)) {
      setDrawn({ sessionId: session.sessionId, from: null, turns: slideTurns + OLDER_TURNS });
      if (drawFrom === 0) loadOlder(oldest!.sessionId);
    } else if (drawFrom > 0) {
      const from = earlierTurns(session.events, drawFrom, OLDER_TURNS);
      holdWindow(from > 0 ? session.events[from].id : ALL_HELD);
    } else if (oldest?.olderBefore != null) {
      loadOlder(oldest.sessionId);
    }
  };

  // The rows at the top of the view and where they sat, taken on every scroll
  // near the top, so a page landing above can put the reader back on them.
  // Only near the top: the walk is short there, and nothing lands above
  // anywhere else. Never a time label or the NEW divider, which a page landing
  // above can take away; the next rows stand in for one gone some other way.
  const botAnchor = useRef<{ node: Element; top: number }[]>([]);
  const noteAnchor = () => {
    const el = scrollRef.current;
    const content = contentRef.current;
    botAnchor.current = [];
    if (!el || !content || el.scrollTop > 2 * el.clientHeight) return;
    const top = el.getBoundingClientRect().top;
    for (const node of content.children) {
      if (node.hasAttribute("data-bot-passing")) continue;
      const box = node.getBoundingClientRect();
      if (box.bottom <= top) continue;
      botAnchor.current.push({ node, top: box.top - top });
      if (botAnchor.current.length === 3) return;
    }
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = botAnchor.current.find((a) => a.node.isConnected);
    if (!el) return;
    snapToPixel();
    if (followRef.current) {
      pin(el);
    } else if (anchor) {
      el.scrollTop += anchor.node.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
    }
    noteAnchor();
    askOlder();
  }, [oldestKey]);

  // A task picked from the bot's "Waiting on you" card: the bot's reply about
  // it, at the top of the pane, once the lit block is laid out. The pin drops
  // as a jump to a turn's does. A reply above what is loaded is read back to,
  // a page at a time, until it is drawn or the chat runs out; run out, the
  // pick is handed back, and the card opens the task instead.
  const focusedAt = useRef<number | null>(null);
  const focusUnpinned = useRef(false);
  useEffect(() => {
    if (!botFocus || focusedAt.current === botFocus.at) return;
    if (!contentRef.current?.querySelector("[data-bot-focus]")) {
      if (more || drawFrom > 0) {
        // Unpinned first: pinned, the window growing re-takes the bottom, and
        // that scroll reads as the reader at the end and lets the window go.
        // Held whole even with nothing undrawn: a window left following drops
        // every page read above its tail, so the page read here went the
        // moment it landed and the reply was never found.
        focusUnpinned.current ||= followRef.current;
        followRef.current = false;
        holdWindow(ALL_HELD);
        if (drawFrom === 0 && oldest?.olderBefore != null) loadOlder(oldest.sessionId, FOCUS_PAGE_TURNS);
        return;
      }
      focusedAt.current = botFocus.at;
      if (focusUnpinned.current && scrollRef.current) {
        followRef.current = true;
        pin(scrollRef.current);
      }
      focusUnpinned.current = false;
      onBotFocusMissed?.(botFocus.sessionId);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const node = contentRef.current?.querySelector<HTMLElement>("[data-bot-focus]");
      if (!scroller || !node) return;
      focusedAt.current = botFocus.at;
      focusUnpinned.current = false;
      const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const to = Math.max(top - JUMP_PAD_PX, 0);
      followRef.current = false;
      // Within a screen of the top the scroll reads the next page, and putting
      // the reader back on their row cuts a smooth one short.
      if (to < scroller.clientHeight) scroller.scrollTo({ top: to });
      else glideTo(scroller, to);
    });
    return () => cancelAnimationFrame(frame);
  }, [botFocus, oldestKey, more]);

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
      if (followRef.current) pin(scroller);
      syncAtBottom();
    });
    ro.observe(scroller);
    ro.observe(content);
    return () => ro.disconnect();
  }, [session?.sessionId]);

  // Unfollow only on an upward gesture, not in onScroll: resize-induced clamp
  // scrolls land at the bottom and pinning writes land at the bottom, so
  // position alone re-confirms the pin — but a wheel-up during streaming must
  // win instantly, before the next delta's pin can yank the view back down.
  //
  // Only a wheel that will move *this* scroller, though: React bubbles wheels
  // from portals (the image viewer, menus) and from nested scrollers, none of
  // which move the chat, and with no scroll event after them nothing re-armed
  // the pin — the chat sat at the bottom unpinned, and whatever landed next,
  // seen or behind another tab, was left below the view.
  const onWheel = (e: React.WheelEvent) => {
    glide.current = null;
    const el = scrollRef.current;
    if (!el || e.deltaY >= 0 || el.scrollTop <= 0) return;
    for (let n = e.target as Element | null; n !== el; n = n.parentElement) {
      if (!n || n.scrollTop > 0) return;
    }
    followRef.current = false;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const g = glide.current;
    if (g && (Math.abs(el.scrollTop - g.to) <= 1 || performance.now() > g.until)) glide.current = null;
    // A card pick still reading back to its row is not the reader either: the
    // rows it mounts above can leave a scroll event at the end before the
    // glide starts, and letting the window go there drops what it mounted.
    const hunting = !!botFocus && focusedAt.current !== botFocus.at;
    const atEnd = !glide.current && !hunting && el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    // **Only a scroll that moved the view can drop the pin.** A pin is a write
    // to `scrollTop`, and the browser answers that write with a scroll event a
    // frame later — by which time anything landing async in the transcript, a
    // highlight, an image, a backfill step, has grown the content under a view
    // that has not moved. That event reads a position short of the end that
    // nobody scrolled to, and judged on its own it dropped the pin with
    // nothing left to re-arm it: the ResizeObserver a moment behind it re-pins
    // only while the pin holds. Measured on an open landing 66px short with the
    // arrow up, and 550px short on a warm switch. So the event is judged by
    // where it finds the scroller: exactly where the last pin left it means
    // the reader did not touch it. An upward wheel still clears the pin
    // itself, and a scrollbar or touch drag moves the position, so
    // every gesture the reader can make is honoured, streaming or not — which
    // is what a height-based reading of the same fact could not manage, since
    // a streaming turn grows on nearly every frame.
    const moved = el.scrollTop !== pinnedTop.current;
    if (atEnd) {
      // Re-arming records the position too, or the next event is judged
      // against where an earlier pin left the scroller rather than where the
      // reader just put it.
      followRef.current = true;
      pinnedTop.current = el.scrollTop;
    } else if (moved) {
      followRef.current = false;
    }
    setAtBottom(atEnd);
    // Turns landing must not move the top out from under a reader who left the
    // bottom, so it holds where it is until they come back.
    if (atEnd) holdWindow(null);
    else if (!followRef.current && held === null && session) {
      holdWindow(drawFrom > 0 ? session.events[drawFrom].id : ALL_HELD);
    }
    noteAnchor();
    askOlder();
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
    glide.current = null;
    followRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: busy ? "auto" : "smooth" });
  };

  // Bound whether or not the button is drawn: the button is the affordance for
  // this, not its gate, and pressing it while already at the bottom re-arms the
  // pin — which is the useful half when a turn has scrolled you off it.
  //
  // Unregistered while hidden rather than made a no-op: the chord is claimed
  // before the handler runs, and ⌘↓ belongs to whatever view is on screen.
  useHotkey("chat.bottom", scrollToBottom, { enabled: active && !!session });

  // One object per session rather than per render: every file-path span in
  // every message reads this context, and a fresh value re-renders all of them
  // through `Markdown`'s memo.
  const cwd = session?.cwd;
  const chatSession = useMemo(
    () => ({ cwd: cwd ?? null, sessionId }),
    [cwd, sessionId],
  );

  // The shell hands these down as fresh arrows on every render, which would
  // defeat `TurnBlock`'s memo; the rows only need whichever is current.
  const callbacks = useRef({ onOpenSubagent, onOpenSession, onOpenBot });
  callbacks.current = { onOpenSubagent, onOpenSession, onOpenBot };
  const openSubagent = useCallback((id: string) => callbacks.current.onOpenSubagent(id), []);
  const openSession = useCallback(
    (id: string, alone?: boolean) => callbacks.current.onOpenSession(id, alone),
    [],
  );
  const openBot = useCallback((bot: Bot) => callbacks.current.onOpenBot?.(bot), []);

  // With no session there is no transcript to draw; AppShell centers the
  // composer and skips this pane entirely. A session still being read draws the
  // same nothing, but inside the arrangement it is about to fill — see
  // `shownSession` in App.
  const cardChat = useMemo(
    () => ({ after: readerMessagesAfter(segments.flatMap((s) => s.events)), bot: !!bot }),
    [segments, bot],
  );

  // A bot's chat alone takes the reader's reactions. Kept while its contents
  // hold, so a new event re-renders no message the reader has not reacted to anew.
  const reactionKey = bot ? [...readerReactions(segments.flatMap((s) => s.events))].join() : "";
  const closed = !bot || !!session?.archived;
  const reactions = useMemo<Reactions>(
    () => ({
      mine: bot ? readerReactions(segments.flatMap((s) => s.events)) : new Map(),
      react: closed
        ? null
        : (event, emoji) =>
            void invoke("react_to_message", { sessionId: event.sessionId, messageId: event.id, emoji }).catch((e) =>
              console.error("[react]", e),
            ),
    }),
    [reactionKey, closed],
  );

  // Rebuilt only when a hand-off lands, like the reactions above.
  const starts = issueStarts(segments.flatMap((s) => s.events));
  const startedKey = startsKey(starts);
  const settled = !!session?.archived;
  const issueCards = useMemo(() => ({ starts, closed: settled }), [startedKey, settled]);

  if (!session) return null;

  // fx and OpenCode alone: each takes one prompt per turn, so a held message waits out the
  // whole turn on screen. Every other harness hands its queue over at the next
  // tool boundary, seconds away, where stopping the turn to save that wait
  // costs more than the wait.
  //
  // Gated on `active` as well, which in a split is the focused pane and on
  // screen. `onSendNow` interrupts the *selected* session, so an unfocused
  // pane's button would stop somebody else's turn — and the chord rides the
  // same prop, so four mounted transcripts would otherwise bind it four times.
  const queued = (
    <QueuedMessages
      messages={queuedMessages}
      onSendNow={(session.harness === "fx" || session.harness === "opencode") && active ? onSendNow : undefined}
      active={active}
    />
  );

  return (
    // The session rides a context because the things that read it are leaves — a
    // `@mention` and a file link, several components down. See `useChatSession`.
    <ChatSessionContext value={chatSession}>
      <MergeCardChatContext value={cardChat}>
      <IssueCardChatContext value={issueCards}>
      <ReactionsContext value={reactions}>
      <div className="relative h-full">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheel}
          onDoubleClick={selectInlineCode}
          className="h-full overflow-y-auto"
        >
          <div
            ref={contentRef}
            className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pt-[calc(1.5rem+var(--snap,0px))] pb-6"
            // A bot chat draws both sides as bubbles, so the reader's takes a
            // fill of its own there — see `[data-bot-chat]` in App.css.
            data-bot-chat={bot || undefined}
          >
            {bot ? (
              <>
                <BotTranscript
                  key={session.sessionId}
                  unread={unread}
                  segments={segments}
                  more={more}
                  busy={busy}
                  preview={previewShown ? <StreamingPreview sessionId={session.sessionId} /> : undefined}
                  taskOf={taskOf}
                  onOpenSession={openSession}
                  onOpenBot={openBot}
                  focus={botFocus}
                />
                {/* A bot chat reads as a messenger: what the reader sent sits
                    with the conversation, above the cards waiting on them —
                    "Waiting on you" and any ask — by the composer that answers. */}
                {queued}
                {botFooter}
              </>
            ) : shownTurns.map((turn, i) => (
              // The wrapper is what `snapToPixel` measures. It carries no styles
              // of its own — it stands in for the block as the flex item.
              <div key={turn.key} ref={i === shownTurns.length - 1 ? lastTurnRef : undefined}>
                <TurnBlock
                  turn={turn}
                  subagentById={subagentById}
                  resultByCallId={resultByCallId}
                  editsByCallId={editsByCallId}
                  onOpenSubagent={openSubagent}
                  onOpenSession={openSession}
                  // Both cover the wait for output, and on every harness but fx
                  // never at once — `waitingTurn` requires no streaming text
                  // there. Inside the block so they sit at the gap the committed
                  // event will occupy, rather than the wider one between turns:
                  // the preview belongs to this turn, not after it. Where both
                  // draw, the orb goes under the preview, which is where the
                  // reader is already looking and where it sits on its own.
                  footer={turn === lastTurn ? liveFooter : undefined}
                />
              </div>
            ))}

            {cards.map((ask) =>
              ask.type === "questions_asked" ? (
                <QuestionRequest
                  key={ask.requestId}
                  requestId={ask.requestId}
                  questions={ask.questions}
                  onAnswer={(answers) =>
                    onAnswerQuestions(session.sessionId, ask.requestId, answers)
                  }
                  // The pane the composer serves is the one whose card may
                  // take the caret.
                  autoFocus={active}
                  keyRank={active ? RANK_OWN : undefined}
                />
              ) : (
                <PermissionRequest
                  key={ask.requestId}
                  // The agent writes a description for nearly every call; the
                  // tool's own name is the floor, so the card always has a subject.
                  description={
                    ask.description ?? ask.title ?? ask.displayName ?? ask.toolName
                  }
                  // A plan's argument is the plan itself — pages of markdown,
                  // where this slot draws a command in a `<pre>`. The tab is
                  // where it reads, so the card points there instead.
                  argument={
                    planAsked(ask.toolName, ask.input) ? null : toolArgument(ask.input)
                  }
                  options={ask.options}
                  onRespond={(optionId) =>
                    onRespondPermission(session.sessionId, ask.requestId, optionId)
                  }
                  onViewPlan={
                    planAsked(ask.toolName, ask.input) ? onOpenPlan : undefined
                  }
                  keyRank={active ? RANK_OWN : undefined}
                />
              ),
            )}

            {!bot && queued}

            {backgroundTaskCount > 0 && (
              <BackgroundTasksIndicator
                count={backgroundTaskCount}
                onOpen={onOpenSubagentPanel}
              />
            )}

            {/* Live rather than a settled row: rewriting the conversation into a
                summary takes seconds on a small context and minutes on a full
                one, with nothing else on screen to explain the wait. */}
            {compacting && <OrbLine state="compacting" label="Compacting context" />}

            {apiRetry && (
              <ApiRetryIndicator
                attempt={apiRetry.attempt}
                maxRetries={apiRetry.maxRetries}
                status={apiRetry.status}
                reason={apiRetry.reason}
                message={apiRetry.message}
              />
            )}
          </div>
        </div>

        {/* Centred on the pane and outside the scroller, so it holds its place
            while the transcript moves under it. Sits
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
              <ShortcutKeys ids={["chat.bottom"]} />
            </TooltipContent>
          </Tooltip>
        )}

      </div>
      </ReactionsContext>
      </IssueCardChatContext>
      </MergeCardChatContext>
    </ChatSessionContext>
  );
}

/// The open block's preview — the one row that reads the streaming text, so the
/// one row a delta re-renders.
///
/// Told apart by the type `block_start` declared, not by content — thinking
/// deltas are plain text on the wire. Only one block streams at a time.
export function StreamingPreview({ sessionId }: { sessionId: string }) {
  const block = useStreamingBlock(sessionId);
  if (!block) return null;

  if (block.type === "thinking") {
    // The same component the committed `reasoning` event renders with, in its
    // `streaming` presentation — the multi-line preview keeps growing live; it
    // collapses to one line once committed.
    return block.text ? <Reasoning text={block.text} encrypted={false} streaming /> : null;
  }

  // A tool call the model is still composing. Non-empty from the first frame —
  // the block announces its tool before any argument arrives, and having only
  // the name is exactly the case the preview exists to cover.
  if (block.type === "tool_use") {
    return block.name ? <StreamingToolCall name={block.name} partialJson={block.text} /> : null;
  }

  return <AssistantMessage text={block.text} streaming />;
}
