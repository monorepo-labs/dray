import { useMemo } from "react";
import { Blobatar } from "@blobatar/react";
import { idle, surprised } from "blobatar/expression";
import { CircleDashed, MousePointerClick } from "lucide-react";

import Chat from "@/components/Chat";
import PermissionRequest from "@/components/chat/PermissionRequest";
import QuestionRequest from "@/components/chat/QuestionRequest";
import Orb from "@/components/Orb";
import PrStateIcon, { prStateLabel } from "@/components/PrStateIcon";
import { HINT_KEYS } from "@/components/Sidebar";
import ShortcutKeys from "@/components/ShortcutKeys";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PaneState } from "@/hooks/useSessions";
import type { CrewRow } from "@/lib/crew";
import { toolArgument } from "@/lib/tools";
import { buildTranscript } from "@/lib/transcript";
import { CREW_TAIL } from "@/lib/turnWindow";
import { cn } from "@/lib/utils";
import type { AgentEvent, PrMark } from "@/types/events";

/// The crew's width, fixed — not a share, and not draggable.
///
/// A split pane bids for width against its neighbour and the reader arbitrates,
/// because both sides are places to work. This column is a place to work *from*:
/// it is the one conversation's list of what it has running, so a watcher that
/// can take half the window is a second workspace nobody asked for. 320 is the
/// sidebar's own order of width, which is the right comparison — a list of
/// sessions with somewhere to answer them, beside the conversation that started
/// them.
export const CREW_W = 320;

type CrewProps = {
  rows: CrewRow[];
  /// The rows the *reader* opened. A row a question opened is not in here —
  /// see `expanded` below, which is what keeps the set meaning one thing.
  open: ReadonlySet<string>;
  selectedId: string | null;
  paneState: (sessionId: string) => PaneState;
  /// The app's own, taking repo and branch — a branch name says nothing about
  /// which checkout it belongs to. Fed the index's recorded branch like the
  /// sidebar rows are, and deliberately: reading the observed HEAD instead is
  /// one child process per row.
  prFor: (repoPath: string, branch: string | null) => PrMark | undefined;
  onToggle: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  /// ⌘-click: leave the crew and open this session as an ordinary full-width
  /// one. The only way *out* of the arrangement from inside it — everything
  /// else here keeps the conversation that started these on the left.
  onOpenInMain: (sessionId: string) => void;
  /// A draft is standing in the selected session, so every other transcript
  /// gives way. The split grid's own rule, read off the same store, and the
  /// *emptiness* alone — subscribing to the text would rerender every mounted
  /// transcript on every keystroke.
  composing: boolean;
  active: boolean;
  chat: Pick<
    React.ComponentProps<typeof Chat>,
    | "onOpenSubagent"
    | "onOpenSession"
    | "onOpenSubagentPanel"
    | "onRespondPermission"
    | "onAnswerQuestions"
    | "onSendNow"
  >;
};

/// The sessions the conversation on the left started, one strip each, with the
/// composer serving whichever of them is selected. Its own, not everything
/// downstream of it — see [`crewRows`].
///
/// **A split view in its relationship, not in its layout.** Parent and child
/// are exactly the pair the split grid is built for, so the same rules hold
/// here: one composer serves the focused transcript, clicking into a transcript
/// is what focuses it, and every other one gives way while a draft is standing.
/// A reader who has learnt the grid has learnt this.
///
/// Two things are its own. The width is fixed rather than bid for
/// ([`CREW_W`]), and **the main column never changes** — opening a row draws
/// the child's transcript *here*, beside the conversation it came out of,
/// rather than taking that conversation's place. One transcript drawn twice on
/// one screen is the thing this arrangement exists to avoid, and it is what
/// makes the crew a place to orchestrate from rather than a slower way to
/// switch sessions.
///
/// Lineage is deliberately absent. The sidebar draws the tree; a second one
/// here would spend this column's left edge repeating what the list next to it
/// already says, and could not be drawn honestly anyway — a connector between
/// two headers is broken by whatever transcript is expanded between them.
export default function Crew({
  rows,
  open,
  selectedId,
  paneState,
  prFor,
  onToggle,
  onFocus,
  onOpenInMain,
  composing,
  active,
  chat,
}: CrewProps) {
  return (
    // No divider. A border is what a split draws between two places to work,
    // and this is one place with a list beside it — the rows' own indent and
    // the width they stop at say where the conversation ends.
    // Scrolls, hint and all. A fan-out has no ceiling on how many sessions it
    // starts, and the rows past the window's edge were simply clipped — with
    // the chord that puts the column away clipped along with them. The hint
    // scrolls with the list rather than being pinned under it, since it is the
    // end of the list rather than a status bar.
    <div
      className="flex min-h-0 shrink-0 flex-col overflow-y-auto"
      style={{ width: CREW_W }}
    >
      {/* No heading. The fixed width and the rows' own marks already say this is
          a list rather than a workspace, and a label over five rows that each
          name themselves is a row of chrome spent on the one thing nobody has
          to be told. */}
      {rows.map((row) => {
        const id = row.item.sessionId;
        // Two ways a row is open and they draw different things. `open` holds
        // what the *reader* opened; a question opens its own row without going
        // in there, so the set stays a record of what was asked for rather than
        // of what happened to be on screen — which is what lets the toggle
        // promote a card to its transcript.
        const openFully = open.has(id);
        const focused = selectedId === id;
        return (
          <div
            key={id}
            className={cn(
              "flex min-h-0 flex-col",
              // Only a *transcript* bids for height. Open rows share what the
              // strips leave, with no cap on how many may be open — a row
              // closing under somebody mid-sentence to make room is worse than
              // three tighter ones. A card is three lines and takes three.
              // The floor is what keeps that honest once the column scrolls:
              // `flex-1` shrinks to nothing before a flex container agrees to
              // overflow, so enough closed rows would squeeze every open one to
              // a line of its own header.
              openFully ? "min-h-64 flex-1" : "shrink-0",
            )}
          >
            <CrewHeader
              row={row}
              open={openFully}
              focused={focused}
              pr={prFor(row.item.projectPath, row.item.branch)}
              onToggle={() => onToggle(id)}
              onOpenInMain={() => onOpenInMain(id)}
            />
            {(openFully || row.asking) && (
              // Dimmed rather than veiled, the grid's own reading: a scrim is
              // one more element to keep in step with the palette, where
              // opacity recedes the transcript against whatever is behind it.
              // The header keeps full strength, since it is what names the row
              // — so the crew still reads as a list while one of it is being
              // written to.
              <div
                // The transcript claims focus, the header does not — and the
                // split is load-bearing rather than tidy. Pointerdown bubbles
                // before the click it precedes, so a focus claim on the *row*
                // fired before the header's own click could read `focused`,
                // and collapsing somebody else's open row then bounced the
                // composer to the anchor instead of leaving it where the
                // reader had it. The header already focuses what it opens.
                onPointerDown={() => !focused && onFocus(id)}
                onFocus={() => !focused && onFocus(id)}
                className={cn(
                  "min-h-0 flex-1 transition-opacity duration-150 ease-out",
                  composing && !focused && "opacity-35",
                )}
              >
                {openFully ? (
                  <Chat
                    {...paneState(id)}
                    {...chat}
                    // Narrowest the transcript gets, and no checkpoint rail:
                    // at 320 it would sit over the text.
                    crowded
                    rail={false}
                    // The newest turn or two and nothing above them — a strip
                    // is a look in on work happening elsewhere, and ⌘-click is
                    // there for reading the rest of it.
                    tail={CREW_TAIL}
                    active={active && focused}
                  />
                ) : (
                  <PendingCard row={row} events={paneState(id).session?.events} chat={chat} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* The chord, under the last row rather than pinned to the foot of the
          column. There is no button for this anywhere, so without a line
          saying so the crew could be put away by somebody with no way to get
          it back — and under the rows it reads as the end of the list, where
          at the window's bottom edge it read as a status bar the app had
          grown. No `mt-auto`, deliberately: an open row already takes the rest
          of the height and pushes this down on its own.

          Drawn as the sidebar's own hint row — label left, held-back caps
          right — since it is the same kind of sentence in the same kind of
          list. Caps first was tried and is worse: the label is what the eye
          reads, and leading with the chord makes the row start on the one part
          of it nobody is looking for. "Toggle", not "hide": the chord is the
          only way *back* too, and a hint naming one direction reads as a
          control that only goes that way. */}
      <div className="flex min-h-7 shrink-0 items-center justify-between px-3 text-ui text-muted-foreground/60">
        Toggle crew
        <ShortcutKeys ids={["crew.toggle"]} className={HINT_KEYS} />
      </div>
    </div>
  );
}

/// The question a row was opened by, and nothing else.
///
/// The crew opened this row on its own — the reader did not ask to read a
/// transcript, they were handed a decision — and a card at the foot of one is a
/// card the row has to be scrolled to find. It also keeps the cost of the
/// interruption proportionate: a question is three lines, where a transcript
/// takes every open row's height to show a conversation nobody asked to see.
///
/// The transcript is one click away: the header toggle puts the row in `open`.
/// A row cannot be *shut* while it is asking, which is the same promise the
/// yellow mark makes.
function PendingCard({
  row,
  events,
  chat,
}: {
  row: CrewRow;
  events: AgentEvent[] | undefined;
  chat: Pick<
    React.ComponentProps<typeof Chat>,
    "onRespondPermission" | "onAnswerQuestions"
  >;
}) {
  // `buildTranscript`'s own pairing rather than a walk of our own: it is what
  // matches a request to its decision, drops one the CLI took back, and knows
  // that a `questions_asked` rides the same channel. A second reading here
  // would answer differently on exactly the lines nobody tested.
  const ask = useMemo(() => buildTranscript(events ?? [], true).pendingAsks[0], [events]);
  // Ordinary while the log is still loading: the row is open because the index
  // says the session is asking, which arrives before its transcript does.
  if (!ask) return null;

  const id = row.item.sessionId;
  return (
    <div className="px-3 pb-3">
      {ask.type === "questions_asked" ? (
        // `autoFocus` off, unlike the main column's: there the card is in the
        // transcript the reader is already in, where this one arrives in a
        // column they were not looking at. Taking the caret would put their next
        // keystroke in a form belonging to a session they have not chosen to
        // talk to — the same reason the row expands without selecting.
        <QuestionRequest
          questions={ask.questions}
          autoFocus={false}
          onAnswer={(answers) => chat.onAnswerQuestions(id, ask.requestId, answers)}
        />
      ) : (
        <PermissionRequest
          // The agent writes a description for nearly every call; the tool's own
          // name is the floor, so the card always has a subject.
          description={ask.description ?? ask.title ?? ask.displayName ?? ask.toolName}
          argument={toolArgument(ask.input)}
          options={ask.options}
          onRespond={(optionId) => chat.onRespondPermission(id, ask.requestId, optionId)}
        />
      )}
    </div>
  );
}

/// Title, state and what the branch has landing. No tree line, no elbow, no indent —
/// see the note on [`Crew`].
function CrewHeader({
  row,
  open,
  focused,
  pr,
  onToggle,
  onOpenInMain,
}: {
  row: CrewRow;
  open: boolean;
  focused: boolean;
  pr: PrMark | undefined;
  onToggle: () => void;
  onOpenInMain: () => void;
}) {
  // The avatar cannot carry the two states on its own: its hue is seeded from
  // the session id, so yellow and green have nowhere to live on it — it says
  // *which* session, never what that session wants. So the title takes the
  // sidebar's own pair and the pose reads as its second half.
  const tone = row.asking
    ? "text-accent-command"
    : row.unread
      ? "text-accent-add"
      : undefined;

  return (
    // **The whole row is the button**, not the title inside it. It was the
    // title alone for a while, which left the avatar, the state mark and every
    // pixel of gap between them dead: the row was plainly one control, so a
    // click anywhere but on the words read as the app ignoring it. A `button`
    // rather than a div with a handler, since it is one — that is what gets it
    // Enter, Space and a tab stop for free.
    <Tooltip delayDuration={TIP_DELAY}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          // ⌘ is the app's own "out there, not here" — the transcript's link
          // dialog and the issue rows both spend it that way, and a row drawn
          // in the main column instead of in its strip is that sentence again.
          onClick={(e) => (e.metaKey || e.ctrlKey ? onOpenInMain() : onToggle())}
          className={cn(
            "group relative flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 pl-1.5 pr-3 text-left text-ui",
            // Selection is weight and colour, no fill. A filled row is how a
            // *list* marks the one thing it is showing, and in a column with no
            // borders it was the loudest shape on screen — a lit band across
            // the crew for a session that is merely where the composer happens
            // to point. Hover is the same currency one step quieter, since a
            // hover fill under an unfilled selection would make passing the
            // cursor look more selected than selecting.
            focused ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <RowAvatar row={row} />
          <span className={cn("truncate", focused && "font-medium", tone)}>
            {row.item.title}
          </span>
          {/* The tone above is the whole of what says a row wants answering or
              has finished, and colour alone says it to nobody using a screen
              reader. The sidebar's own words, since the pair means the same
              thing there. */}
          {(row.asking || row.unread) && (
            <span className="sr-only">{row.asking ? "Waiting for you" : "Unread"}</span>
          )}
      {/* One slot, three tenants, and the order is the sidebar's own — so a
          reader who has learnt it over there already knows it here.

          Checks win: the orb says the agent is working, which the reader set
          going and the row's own face is already saying, where CI reports from a
          machine elsewhere on somebody else's schedule and nothing in the
          transcript will ever mention that it went red. The orb comes next,
          because a row with a turn in flight is the one row whose PR state is
          the least live thing about it — and the state is a standing fact, so
          it comes back the moment the turn ends. */}
          <span
            // `role="img"` or the label is dropped on the floor: a bare `span`
            // takes no accessible name, so the PR state was stated to nobody.
            role={pr ? "img" : undefined}
            className="ml-auto flex size-5 shrink-0 items-center justify-center"
            aria-label={pr ? `Pull request #${pr.number}, ${prStateLabel(pr).toLowerCase()}` : undefined}
          >
            {pr?.checksState === "RUNNING" ? (
              <CircleDashed
                className="size-3.5 animate-spin text-accent-command [animation-duration:3s]"
                strokeWidth={1.5}
                aria-label="Checks running"
              />
            ) : row.busy ? (
              <Orb state="listening" size={20} aria-label="Working" />
            ) : (
              pr && <PrStateIcon pr={pr} strokeWidth={1.5} />
            )}
          </span>
        </button>
      </TooltipTrigger>
      {/* The click is a keycap rather than the word, so the whole gesture is
          one chip pair the eye takes in at once, with the sentence left to say
          only what happens. `aria-label` on the glyph, since it is the only
          copy of that word.

          It names ⌘-click alone and not the plain one: the row's own look says
          it opens, and a tooltip repeating what a click does is the thing the
          app's tooltip rule refuses. The PR state loses its `title` for the
          same reason — a native tooltip inside a real one is two boxes racing,
          and the glyph's `aria-label` is where that sentence belongs.

          "Full view" and not "in the main chat", which was the old copy and
          stopped being true: the main chat is the conversation that *started*
          these, and ⌘-click does not put a row into it — it closes the crew
          and gives the session the whole column, the way picking it out of the
          sidebar would, and the change is the part the reader can see: a 320px
          strip becoming the column. */}
      <TooltipContent side="left">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd aria-label="click">
            <MousePointerClick />
          </Kbd>
        </KbdGroup>
        to open in full view
      </TooltipContent>
    </Tooltip>
  );
}

/// Long enough that crossing the crew does not trigger it, short enough for
/// anybody who stopped.
///
/// Every other tooltip in this app runs at the provider's 0, which is right for
/// a control the cursor went to on purpose and wrong for a strip of half a
/// dozen rows it passes through on the way somewhere else.
const TIP_DELAY = 700;

/// The session's own avatar, wearing what that session wants.
///
/// Two poses for the whole crew, picked on how much each one *moves* rather
/// than on what it means: at 20px in a column watched out of the corner of the
/// eye, the only channel that reaches you is motion. `surprised` is the loudest
/// the library has and takes the one state standing still waiting for you;
/// `idle` is every other row.
///
/// **A working row gets `idle` too, and `thinking` is why.** That pose was the
/// obvious pick and cannot be held still: it sets `--mo-rock`, and the
/// library's `motion.css` runs that eye seesaw unconditionally — `animate`
/// moves `--mo-amp`, which the rock does not read. The seesaw *is* the pose
/// (the library's own note calls it the two-dot loader), so "thinking but
/// still" is not a state it has, and the orb at the row's other end already
/// says working.
///
/// Motion is therefore spent on one state and nothing else. Running the idle
/// loop everywhere was tried and made the column restless, which is what a
/// thing watched out of the corner of the eye must not be: a crew where every
/// face is moving says nothing about which one to look at. The rest keep
/// `hover`, which is not nothing — the loop is still there for anyone who goes
/// looking for it with the cursor.
function RowAvatar({ row }: { row: CrewRow }) {
  return (
    <span className="ml-0.5 flex size-5 shrink-0 items-center justify-center">
      <Blobatar
        name={row.item.sessionId}
        aria-hidden
        expression={row.asking ? surprised : idle}
        animate={row.asking ? "always" : "hover"}
        className="size-5 shrink-0"
      />
    </span>
  );
}
