import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { Blobatar } from "@blobatar/react";
import { idle, surprised } from "blobatar/expression";
import { CircleDashed, MousePointerClick } from "lucide-react";

import Chat from "@/components/Chat";
import PermissionRequest from "@/components/chat/PermissionRequest";
import QuestionRequest from "@/components/chat/QuestionRequest";
import GitBranchIcon from "@/components/icons/GitBranchIcon";
import Orb from "@/components/Orb";
import PrStateIcon, { prStateLabel } from "@/components/PrStateIcon";
import SessionHeader from "@/components/layout/SessionHeader";
import ViewTabs from "@/components/layout/ViewTabs";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/useTheme";
import { THEMES, type ThemeName } from "@/lib/theme";
import { toolArgument } from "@/lib/tools";
import { cn } from "@/lib/utils";
import type {
  AgentEvent,
  AgentEventPayload,
  PrChecksState,
  SessionSnapshot,
} from "@/types/events";
import "blobatar/motion.css";
import "./App.css";

/// The spawned-sessions crew: the conversation the reader is in on the left, and
/// a fixed 320px column on the right holding a row per session it started.
///
/// **This is not a split view and must not become one.** It looks like one and a
/// row opens into a real transcript, which is exactly why the distinction has to
/// be held on purpose. A split pane is somewhere to work: it bids for width,
/// takes the composer, and the reader arbitrates between it and its neighbour.
/// This column is somewhere to *watch from* — you keep half a dozen fanned-out
/// sessions in the corner of your eye, and you drop into one when its mark says
/// it wants you. Three things follow from that and none of them are style:
/// the width is fixed rather than shared ([`CREW_W`]), nothing ever opens itself,
/// and the column is headed with what it is.
///
/// What it is for answering:
///
///  1. whether a 320px row is enough to answer a permission request in without
///     leaving the conversation you are having;
///  2. whether a column of collapsed strips keeps six sessions in reach, or just
///     out of reach in a tidier way.
///
/// A third question — what should happen when a session spawns a session — is
/// answered and gone. Membership is the index's own `parentSessionId`, so there
/// was never a preference to offer: the row is simply there.
///
/// Lineage is deliberately absent: the sidebar draws the tree and this column
/// does not repeat it. See [`PaneHeader`].
///
/// Nothing is wired to Rust. Sessions are hand-built `SessionSnapshot`s and the
/// buttons above the split stand in for what the app would do on its own. Delete
/// the page once the layout is settled.

// ---------------------------------------------------------------- fake sessions

let nextSeq = 0;

const ev = (sessionId: string, payload: AgentEventPayload): AgentEvent => ({
  id: `ev-${++nextSeq}`,
  sessionId,
  harness: "claude_code",
  seq: nextSeq,
  ts: new Date(Date.now() - 60_000).toISOString(),
  turnId: null,
  subagent: null,
  payload,
  raw: null,
});

const prompt = (id: string, text: string) =>
  ev(id, {
    type: "user_message",
    text,
    images: [],
    issues: [],
    baseline: null,
    queued: false,
    from: null,
    cwd: null,
  });

const say = (id: string, text: string) => ev(id, { type: "assistant_text", block: null, text });

const ran = (id: string, callId: string, command: string, out: string) => [
  ev(id, {
    type: "tool_call_started",
    callId,
    name: "Bash",
    toolType: "shell",
    input: { command },
    rawInput: null,
    title: null,
  }),
  ev(id, {
    type: "tool_call_completed",
    callId,
    result: { text: out, isError: false, structured: null, exitCode: 0, durationMs: 420, images: [] },
  }),
];

const done = (id: string) =>
  ev(id, {
    type: "turn_completed",
    status: "success",
    stopReason: null,
    finalText: null,
    usage: null,
    durationMs: 8_400,
    head: null,
    authFailed: false,
  });

/// A permission request, which is what makes a pane demand the reader. The real
/// shape, so the pane draws `Chat`'s own card rather than the demo faking one.
///
/// Every field is taken from a card raised live in this app rather than guessed:
/// the agent's own sentence as the description (the tool name is only the floor,
/// and a real call nearly always has one), and the option labels `build_options`
/// actually composes. The first draft guessed all three and got the only one
/// that matters wrong — see `options` below.
const asks = (id: string, requestId: string, command: string, description: string) =>
  ev(id, {
    type: "permission_requested",
    requestId,
    toolUseId: `tu-${requestId}`,
    toolName: "Bash",
    displayName: null,
    title: null,
    description,
    input: { command },
    blockedPath: null,
    decisionReason: null,
    decisionReasonType: null,
    agentId: null,
    // Copied off a live card rather than invented, and the middle one is why it
    // was worth checking. `build_options` in
    // [permissions.rs](./src-tauri/src/harness/claude_code/permissions.rs)
    // composes it as `Always allow {subject}`, where the subject is the CLI's
    // own suggested rule — for a shell call that is **the command**, so today
    // the label is as long as whatever was being run, with no cap on it. The
    // demo had `Allow every time` here, which fits anywhere and settles
    // nothing.
    //
    // It is cut to `Always allow` on purpose, which is the proposal rather than
    // the capture: the subject is a second copy of the `<pre>` three lines
    // above, and carrying it made the longest label in the card the one part of
    // it the reader had already read. Cut in the *fixture* rather than at the
    // render, because the card is drawn from two places here — this branch and
    // the whole transcript `Chat` builds — and a shortening applied to one of
    // them is a rule that holds until somebody opens the row.
    //
    // The subject is kept wherever the card is not already showing it:
    // `Always allow in {dir}` names a directory that appears nowhere else.
    // Landing it belongs in the card rather than in `build_options`, since
    // whether a subject is redundant is a question about what is drawn beside
    // it, and the Rust side composes one label for every surface.
    options: [
      { id: "once", label: "Allow once", kind: "once", behavior: "allow" },
      { id: "suggestion_0", label: "Always allow", kind: "always_rule", behavior: "allow" },
      { id: "deny", label: "Deny", kind: "deny", behavior: "deny" },
    ],
  });

/// `AskUserQuestion` held, which is the *other* thing that stops an agent dead.
///
/// Worth having beside the permission card because the two are not the same
/// shape at 320px: a permission is one command and three buttons, where a
/// question is a form the reader fills in — a header chip, a prose question,
/// options with descriptions, and a free-text box the harness promises whatever
/// the model offered. Whether that fits in a crew row is the question this card
/// is here to answer, and it is the one the permission card cannot.
const askQuestions = (id: string, requestId: string) =>
  ev(id, {
    type: "questions_asked",
    requestId,
    toolUseId: `tu-${requestId}`,
    questions: [
      {
        question: "The setup pane needs a terminal to paste into. Which do we open?",
        header: "Terminal",
        multiSelect: false,
        // True for `AskUserQuestion`, which is what this is: the CLI promises
        // the reader a free-text box and tells the model not to offer an
        // "Other" option because of it. At 320px that box is the part worth
        // watching — it is what the card cannot shed to fit.
        freeText: true,
        options: [
          {
            label: "The reader's own pick",
            description: "`ade.runInTerminal`, the same store the composer's notice uses.",
            preview: null,
          },
          {
            label: "Terminal.app",
            description: "A `.command` script is run by Terminal alone — measured.",
            preview: null,
          },
        ],
      },
    ],
  });

function snapshot(
  sessionId: string,
  title: string,
  worktree: string,
  events: AgentEvent[],
  parentSessionId: string | null,
): SessionSnapshot {
  return {
    events,
    sessionId,
    harness: "claude_code",
    cwd: `/Users/dev/dray/.claude/worktrees/${worktree}`,
    projectPath: "/Users/dev/dray",
    branch: `worktree-${worktree}`,
    worktreeName: worktree,
    worktreeRemoved: false,
    title,
    model: "opus",
    effort: "high",
    permissionMode: "auto",
    fast: false,
    status: "idle",
    forkFrom: null,
    threadId: null,
    issues: [],
    parentSessionId,
    created: new Date(Date.now() - 900_000).toISOString(),
    modified: new Date().toISOString(),
    archived: false,
    pinned: false,
  };
}

/// One pane in the stack.
///
/// No depth and no lineage. Every session the conversation on the left started
/// is a row in this column, including one a child spawned in turn — the tree is
/// the **sidebar's** job, and drawing it twice spends a column's left edge
/// saying what the row beside it already says. What names a grandchild's real
/// parent is the relayed prompt at the top of its own transcript.
type Pane = {
  session: SessionSnapshot;
  busy: boolean;
  /// Standing still until somebody answers. The sidebar's yellow, and the one
  /// thing that opens a pane without the reader asking.
  asking: boolean;
  /// Finished and unread — the sidebar's green.
  unread: boolean;
  /// What the branch has landing, if anything. The fields [PrStateIcon] takes
  /// and nothing more — the crew draws one glyph, exactly as the sidebar row
  /// does, and shares the table with it rather than growing a second one.
  pr?: { number: number; state: string; isDraft: boolean; checksState?: PrChecksState };
};

const PARENT = snapshot(
  "parent",
  "Ship the PR panel empty states",
  "lucid-crimson-orchard",
  [
    prompt(
      "parent",
      "Split the PR panel work across sessions — one per empty state, plus the marks cache.",
    ),
    say(
      "parent",
      "Fanning out. Four worktrees, one issue each:\n\n- `dray new` × 4, forked from this branch\n- each takes its own `DRA-` issue\n\nI'll relay their reports back here.",
    ),
    ...ran(
      "parent",
      "c1",
      "dray new --from $DRAY_SESSION_ID 'fix the no_cli pane'",
      "session 7f2a… created",
    ),
    say("parent", "All four are running. I'll summarise when they report."),
    done("parent"),
  ],
  null,
);

const KIDS: Pane[] = [
  {
    session: snapshot(
      "kid-1",
      "PR panel: no_cli setup pane",
      "brisk-amber-fern",
      [
        prompt(
          "kid-1",
          '[message from the Dray session "Ship the PR panel empty states"] Draw the setup pane where `gh` is missing.',
        ),
        say(
          "kid-1",
          "Reading `PrPanel.tsx` and `github.rs` first — the tab is hidden on `NoCli` today, so the change is in `prTabVisible` as much as the pane.",
        ),
        ...ran(
          "kid-1",
          "k1a",
          "rg -n 'NoCli' src-tauri/src",
          "src-tauri/src/github.rs:88: NoCli,\nsrc-tauri/src/github.rs:214: return Err(PrError::NoCli);",
        ),
        say(
          "kid-1",
          "Two states keep the tab: `no_cli` and `not_authenticated`. Everything else still follows the rows.",
        ),
      ],
      "parent",
    ),
    busy: true,
    asking: false,
    unread: false,
  },
  {
    session: snapshot(
      "kid-2",
      "PR panel: marks cache generation",
      "gilded-slate-wren",
      [
        prompt(
          "kid-2",
          '[message from the Dray session "Ship the PR panel empty states"] A read issued before the clear must not put its stale answer back.',
        ),
        say(
          "kid-2",
          "Added a module `generation` counter beside `inFlight`, bumped by `refreshAfterWrite`. A read stamps only where its generation still matches.\n\nTests pass — `pnpm test` green, 41 files.",
        ),
        done("kid-2"),
      ],
      "parent",
    ),
    busy: false,
    asking: false,
    unread: true,
    // The one the slot exists for: finished, unread, and CI still deciding.
    pr: { number: 241, state: "OPEN", isDraft: false, checksState: "RUNNING" },
  },
  {
    session: snapshot(
      "kid-3",
      "PR panel: recheck_gh and the RwLock",
      "quiet-harbor-thistle",
      [
        prompt(
          "kid-3",
          '[message from the Dray session "Ship the PR panel empty states"] Make the cached `gh` absence throwable-away.',
        ),
        say(
          "kid-3",
          "`binpath`'s `gh` slot becomes an `RwLock`. A generation rides it so a probe already running when the reader installs `gh` can't publish its miss over the recheck.",
        ),
        ...ran("kid-3", "k3a", "cargo check", "    Finished `dev` profile in 4.11s"),
      ],
      "parent",
    ),
    busy: true,
    asking: false,
    unread: false,
    // Working *and* CI running — the row that settles why the two marks are two
    // slots rather than one taking turns.
    pr: { number: 242, state: "OPEN", isDraft: false, checksState: "RUNNING" },
  },
  {
    session: snapshot(
      "kid-4",
      "PR panel: terminal opener",
      "still-cobalt-yarrow",
      [
        prompt(
          "kid-4",
          '[message from the Dray session "Ship the PR panel empty states"] `OpenInButton` wearing a third hat — terminals only.',
        ),
        say("kid-4", "`TERMINAL_OPENER` added, its own stored pick under `ade.runInTerminal`."),
        done("kid-4"),
      ],
      "parent",
    ),
    busy: false,
    asking: false,
    unread: false,
    pr: { number: 243, state: "OPEN", isDraft: true, checksState: "CLEAR" },
  },
  {
    // Spawned by kid-4 rather than by the parent — the depth cap allows it, and
    // it is here to show that a grandchild is an ordinary row in this column.
    // Only its own relayed prompt names who sent it; the sidebar draws the rest.
    session: snapshot(
      "kid-5",
      "Sweep the copy in COPY-ISSUES.md",
      "warm-linen-tansy",
      [
        prompt(
          "kid-5",
          '[message from the Dray session "PR panel: terminal opener"] Reword the empty state while you are in there.',
        ),
        say("kid-5", "Two sentences changed. Nothing behavioural, so the PR takes `no-review`."),
        done("kid-5"),
      ],
      "kid-4",
    ),
    busy: false,
    asking: false,
    unread: true,
    // Green title, red glyph. Worth having on screen: the session is done and
    // the branch is not, and those are two different answers to two different
    // questions — which is the whole reason the slot came back.
    pr: { number: 244, state: "OPEN", isDraft: false, checksState: "FAILING" },
  },
];

// --------------------------------------------------------------- pane headers

/// What leads a crew row: the session's own face, wearing what that session is
/// doing. A morphing status caret was the other option here and lost, so it is
/// gone with the switch that compared them.
///
/// What the avatar gives up is **colour** — the blob's hue is seeded from the
/// session id, so yellow-means-you and green-means-done have nowhere to live on
/// it. That is why the title beside it takes the sidebar's pair and the pose
/// reads as its second half.
///
/// Two costs, both stated by the library: `animate` switches it from an `<img>`
/// to inline SVG, about a dozen nodes per row, and the motion needs
/// `blobatar/motion.css` imported or the poses simply sit still.
///
/// `Blobatar` directly rather than [SessionAvatar], which exposes neither prop.
function StatusAvatar({ pane }: { pane: Pane }) {
  // Two poses for the whole crew, picked on how much each one *moves* rather
  // than on what it means: at 20px in a column you are watching out of the
  // corner of your eye, the only channel that reaches you is motion.
  // `surprised` is the loudest of the fourteen and takes the one state standing
  // still waiting for you. `idle` is every other row — named rather than left
  // `undefined`, which renders the same face: what is being said is that these
  // rows have nothing to say, not that nobody got round to giving them a pose.
  //
  // **Working gets `idle` too, and `thinking` is why.** That pose was the
  // obvious pick and cannot be held still: it sets `--mo-rock`, and
  // `motion.css` runs the `mo-rock` seesaw on `.mo-eye` unconditionally — the
  // `animate` prop moves `--mo-amp`, which the eye rock does not read. The
  // seesaw *is* the pose (the library's own note calls it the two-dot loader),
  // so "thinking but still" is not a state this library has. Since the orb at
  // the row's other end already says working, the face says nothing and the
  // one moving row in the crew is the one that wants an answer.
  const pose = pane.asking ? surprised : idle;
  return (
    // The avatar stays put — no caret, not even on hover. Swapping it out cost
    // the one thing an avatar is for: a row you recognise without reading.
    // Clicking the row still opens it; the affordance is the row.
    //
    // Motion is spent on one state and nothing else: the row standing still
    // waiting for an answer. Running the idle loop everywhere was tried and in
    // the crew it made the column restless, which is the state a thing you
    // watch out of the corner of your eye must not be in. A crew where every
    // face is moving says nothing about which one to look at.
    //
    // So the other rows keep `hover`, which is not nothing: the loop is still
    // there for anyone who goes looking for it with the cursor.
    <span className="ml-0.5 flex size-5 shrink-0 items-center justify-center">
      <Blobatar
        name={pane.session.sessionId}
        aria-hidden
        expression={pose}
        animate={pane.asking ? "always" : "hover"}
        className="size-5 shrink-0"
      />
    </span>
  );
}

/// Names the one thing a crew row does that nothing on it shows: **⌘-click
/// opens the session in the main chat.**
///
/// The behaviour is not wired here — the demo has one conversation on the left
/// and nowhere to open a second — but the affordance is, because it is the half
/// that has to be designed. A modifier is invisible by definition, so a verb
/// reachable only through one is a verb nobody finds, and this is the crew's
/// only way *out* of itself: everything else here is watching, and this is
/// going.
///
/// **Delayed, and that is the whole of why it is not just a tooltip.** Every
/// other tooltip in this app labels a control the cursor went to on purpose, so
/// the provider's delay is 0. A crew row is a strip a cursor crosses on its way
/// to somewhere else, half a dozen of them stacked — at 0 the column would
/// flicker tooltips at anyone moving the mouse through it. 700ms is longer than
/// crossing and shorter than reading, so it only ever opens for somebody who
/// stopped.
///
/// ⌘ rather than the app's own chord vocabulary: this is not a registered
/// shortcut and cannot be rebound, which is what `ShortcutKeys` is for. It is
/// the same modifier the transcript's link dialog and the issue rows already
/// spend on "out there, not here", and a crew row leaving for the main column
/// is that sentence again.
function TitleTip({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <Tooltip delayDuration={700}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="left">
        {/* The click is a keycap rather than the word, so the whole gesture is
            one chip pair the eye takes in at once — ⌘ and the thing you do with
            it, in the tooltip's own keycap vocabulary, with the sentence left
            to say only what happens. Spelt out, "⌘ click to open…" put the
            modifier in chrome and its other half in prose, which reads as a
            key and then an instruction rather than as one chord.

            `aria-label` on the `Kbd`, because the glyph is the only copy of
            that word now and an icon with no text is nothing to a screen
            reader. */}
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd aria-label="click">
            <MousePointerClick />
          </Kbd>
        </KbdGroup>
        to open in the main chat
      </TooltipContent>
    </Tooltip>
  );
}

/// Title, state, and — in the left column only — the branch. One component for
/// both: the parent draws it with no caret, which is the difference between the
/// conversation the reader is in and the sessions they are watching.
///
/// No crew, no elbow, no indent, and that is a decision rather than an omission.
/// The sidebar is where lineage is drawn; a second tree here would spend this
/// column's left edge repeating what the tree next to it already says, and it
/// cannot be drawn honestly anyway — a connector between two headers is broken
/// by whatever transcript is expanded between them.
function PaneHeader({
  pane,
  open,
  focused,
  branch,
  onToggle,
  onFocus,
}: {
  pane: Pane;
  open: boolean;
  focused: boolean;
  /// Whether there is room for the branch. False in the crew, open or shut: at
  /// 320px a row that draws both truncates *both*, and two half-words say less
  /// than one whole one. It was worth saying on an open row when the crew was a
  /// split pane and the reader worked in it; here they never do — they read the
  /// row, answer it, and go back to the left.
  branch?: boolean;
  onToggle?: () => void;
  onFocus: () => void;
}) {
  // The avatar cannot carry the two states on its own: its hue is seeded from
  // the session id, so yellow and green have nowhere to live on it — it says
  // *which* session, never what that session wants. So the title takes the
  // sidebar's own pair and the pose reads as its second half.
  const tone = pane.asking
    ? "text-accent-command"
    : pane.unread
      ? "text-accent-add"
      : undefined;
  return (
    <div
      // The parent header selects on press; a crew row does not, because its
      // click is a toggle and what that *means* for selection depends on which
      // way it went — see `toggle` in [`Demo`].
      onPointerDown={onToggle ? undefined : onFocus}
      className={cn(
        "group relative flex h-8 shrink-0 cursor-pointer items-center gap-2 pl-1.5 pr-3 text-ui",
        // Selection is weight and colour, no fill. A filled row is how a *list*
        // marks the one thing it is showing, and with the borders gone it was
        // the loudest shape on the page — a lit band across the crew for a
        // session that is merely where the composer happens to point. Hover is
        // the same currency one step quieter, since a hover fill under an
        // unfilled selection would make passing the cursor look more selected
        // than selecting.
        focused ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {onToggle && <StatusAvatar pane={pane} />}

      <TitleTip enabled={Boolean(onToggle)}>
        <button
          type="button"
          aria-expanded={onToggle ? open : undefined}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span className={cn("truncate", focused && "font-medium", tone)}>
            {pane.session.title}
          </span>
          {branch && (
            <span className="flex min-w-0 shrink items-center gap-1 text-muted-foreground">
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate">{pane.session.branch}</span>
            </span>
          )}
        </button>
      </TitleTip>

      {/* What the branch has landing. Four controls have now been drawn in this
          slot and three were cut — a close, because a row is not the reader's to
          dismiss; an "open in main chat", which named a real thing the crew
          cannot otherwise do and still spent the row's only other slot on a verb
          nobody had asked for; and the orb, which said "working" a second time
          beside a face already saying it.

          That is the whole argument for the PR mark taking the slot instead. The
          avatar is on the left saying what the *session* is doing, and it says
          it better than an orb did — so a second indicator for the same fact was
          the slot's least valuable tenant. CI is the opposite: it reports on a
          machine elsewhere, on somebody else's schedule, and nothing in the
          transcript beside it will ever mention that it went red.

          Order is the sidebar's, and shares its table: a running check outranks
          the state glyph, since "did it pass" is the live question and the state
          is a standing fact the row can say a moment later. */}
      {onToggle && (
        <span
          className="ml-auto flex size-5 shrink-0 items-center justify-center"
          title={
            pane.pr && `Pull request #${pane.pr.number} · ${prStateLabel(pane.pr).toLowerCase()}`
          }
        >
          {/* One slot, three tenants, and the order is the sidebar's own — so a
              reader who has learnt it over there already knows it here.

              Checks win: the orb says the agent is working, which the reader set
              going and the row's own face is already saying, where CI reports
              from a machine elsewhere on somebody else's schedule and nothing in
              the transcript will ever mention that it went red. The orb comes
              next, because a row with a turn in flight is the one row whose PR
              state is the least live thing about it — and the state is a
              standing fact, so it comes back the moment the turn ends.

              Two slots were drawn here first, to keep a working row's checks and
              its orb both on screen. They read as a second column of marks down
              the crew's right edge for the sake of the one row holding both. */}
          {pane.pr?.checksState === "RUNNING" ? (
            <CircleDashed
              className="size-3.5 animate-spin text-accent-command [animation-duration:3s]"
              strokeWidth={1.5}
              aria-label="Checks running"
            />
          ) : pane.busy ? (
            <Orb state="listening" size={20} aria-label="Working" />
          ) : (
            pane.pr && <PrStateIcon pr={pane.pr} strokeWidth={1.5} />
          )}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the split

const NO_TASKS: ReadonlySet<string> = new Set();

/// The crew's width, fixed — not a share, and not draggable.
///
/// This is the whole of what stops it being a split view. A split pane is a
/// place to *work*, so it bids for width against its neighbour and the reader
/// arbitrates; this column is a place to *watch from*, and a watcher that can
/// take half the window is a second workspace nobody asked for. 320 is the
/// sidebar's own order of width, which is the right comparison: a list of
/// sessions with somewhere to answer them, beside the conversation the reader
/// is actually having.
const CREW_W = 320;

/// Everything `Chat` wants that this page has no backend for.
const chatProps = {
  streamingBlock: null,
  onOpenSubagent: () => {},
  onOpenSession: () => {},
  onOpenSubagentPanel: () => {},
  onAnswerQuestions: () => {},
  backgroundTaskCount: 0,
  liveTaskIds: NO_TASKS,
  compacting: false,
  apiRetry: null,
  queuedMessages: [],
  crowded: true,
  // Never: a pane sharing its column is at half height or less, where the
  // checkpoint rail sits over the text.
  crew: false,
};

/// The question a row is blocked on, or `null`.
///
/// The newest `permission_requested` in the log, and nothing checks for a
/// decision after it because nothing in this page can produce one without also
/// clearing `asking`. The app's own `buildTranscript` is where that pairing
/// really lives; this reads the log directly so the crew's card needs no
/// transcript built for it.
function pendingAsk(pane: Pane) {
  if (!pane.asking) return null;
  for (let i = pane.session.events.length - 1; i >= 0; i--) {
    const payload = pane.session.events[i].payload;
    if (payload.type === "permission_requested" || payload.type === "questions_asked") {
      return payload;
    }
  }
  return null;
}

function OrchestrationSplit({
  kids,
  open,
  focusedId,
  onToggle,
  onFocus,
  onRespondPermission,
  onAnswerQuestions,
}: {
  kids: Pane[];
  open: ReadonlySet<string>;
  focusedId: string;
  onToggle: (id: string) => void;
  onFocus: (id: string) => void;
  onRespondPermission: (sessionId: string, requestId: string, optionId: string) => void;
  onAnswerQuestions: (sessionId: string, requestId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The app's own titlebar row — `SessionHeader` and `ViewTabs`, composed
          the way `App` composes them — spanning the window, with both columns
          under it. Not a pane header on the main column.

          A pane header is a split-view part: it exists to say *which of several
          equal panes* the composer is serving. There are no equal panes here.
          This is the session the window is about, and the crew beside it is a
          list — giving the main column a header of the same shape as the crew's
          rows made the two read as a two-up grid, which is the reading
          everything else on this page is spent refusing. Spanning also settles
          where the crew starts: under the chrome, like the right panel, rather
          than level with it. */}
      <div className="flex h-11 shrink-0 items-center gap-2 px-3">
        <SessionHeader session={PARENT} branch={PARENT.branch} className="flex-1" />
        {/* The unfilled selection is [ViewTabs](./components/layout/ViewTabs.tsx)'
            own now, and scoped there rather than taken out of `TabButton`: the
            right panel's panes and the settings crew sit inside the panel they
            are the tabs of, where the fill is the pane's top edge. */}
        <ViewTabs tab="chat" onChange={() => {}} />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The transcript carries the selection press, since it has no header of
            its own to carry it — the same rule the crew's open rows follow:
            clicking into a conversation is what says the composer sends there. */}
        <div className="flex min-w-0 flex-1 flex-col" onPointerDown={() => onFocus("parent")}>
          <Chat
            {...chatProps}
            session={PARENT}
            busy={false}
            working={null}
            // The main column is full width with a checkpoint rail, like the
            // app's. Only the crew's rows are crowded.
            crowded={false}
            rail
            onRespondPermission={onRespondPermission}
            active={focusedId === "parent"}
          />
        </div>

        <div
          className="flex shrink-0 flex-col"
          style={{ width: CREW_W }}
        >
          {/* No heading. It was drawn and cut: the fixed width and the rows' own
              carets already say this is a list rather than a workspace, and a
              label over five rows that each name themselves is a row of chrome
              spent on the one thing nobody has to be told. */}
          {kids.map((kid) => {
            const id = kid.session.sessionId;
            // Two ways a row is open and they draw different things. `open`
            // holds what the *reader* opened; a question opens its own row
            // without going in there, so the set stays a record of what was
            // asked for rather than of what happened to be on screen — which is
            // what lets the toggle promote a card to its transcript.
            const openFully = open.has(id);
            const expanded = openFully || kid.asking;
            const ask = !openFully ? pendingAsk(kid) : null;
            return (
              <div
                key={id}
                className={cn(
                  "flex min-h-0 flex-col",
                  // Only a *transcript* bids for height. Open rows share what
                  // the strips leave, with no cap on how many may be open — a
                  // row closing under somebody mid-sentence to make room is
                  // worse than three tighter ones. A card-only row is three
                  // lines and takes three lines: given `flex-1` it drew the
                  // card at the top of a column of empty space and pushed every
                  // row under it to the bottom of the crew, which reads as the
                  // question having taken the column over.
                  openFully ? "flex-1" : "shrink-0",
                )}
              >
                <PaneHeader
                  pane={kid}
                  open={expanded}
                  focused={focusedId === id}
                  onToggle={() => onToggle(id)}
                  onFocus={() => onFocus(id)}
                />
                {expanded && (
                  // Clicking anywhere in the transcript selects the session, so
                  // the composer follows where the reader is reading. Separate
                  // from the header, whose click is a toggle: reaching into an
                  // open row to scroll or copy is not asking it to shut.
                  <div className="min-h-0 flex-1" onPointerDown={() => onFocus(id)}>
                    {ask ? (
                      // Auto-expanded by the question, so the question is all it
                      // draws. The crew opened this row on its own — the reader
                      // did not ask to read a transcript, they were handed a
                      // decision — and a card at the foot of one is a card the
                      // row has to be scrolled to find. It also keeps the cost
                      // of the interruption proportionate: a question is three
                      // lines, where a transcript takes every open row's height
                      // to show a conversation nobody asked to see.
                      //
                      // The transcript is one click away: the header toggle puts
                      // the row in `open`, and `openFully` is what that means.
                      // A row cannot be *shut* while it is asking, which is the
                      // same promise the yellow mark makes.
                      <div className="px-3 pb-3">
                        {ask.type === "questions_asked" ? (
                          // `autoFocus` off, unlike the app's: there the card is
                          // in the transcript the reader is already in, where
                          // this one arrives in a column they were not looking
                          // at. Taking the caret would put their next keystroke
                          // in a form belonging to a session they have not
                          // chosen to talk to — the same reason the row expands
                          // without selecting.
                          <QuestionRequest
                            questions={ask.questions}
                            autoFocus={false}
                            onAnswer={() => onAnswerQuestions(id, ask.requestId)}
                          />
                        ) : (
                          // `bg-card` is the permission card's own now, landed
                          // in [PermissionRequest](./components/chat/PermissionRequest.tsx)
                          // — and it stayed the *permission* card's alone. The
                          // question card is a form: its choices are transparent
                          // so the checked one can fill, which is the only fill
                          // in it that means anything, and a card fill under
                          // them turns a picked answer into one white block on
                          // another.
                          <PermissionRequest
                            description={ask.description ?? ask.toolName}
                            argument={toolArgument(ask.input)}
                            options={ask.options}
                            onRespond={(optionId) =>
                              onRespondPermission(id, ask.requestId, optionId)
                            }
                          />
                        )}
                      </div>
                    ) : (
                      <Chat
                        {...chatProps}
                        session={kid.session}
                        busy={kid.busy}
                        working={kid.busy ? { tokens: 0 } : null}
                        onRespondPermission={onRespondPermission}
                        active={focusedId === id}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- the page

let spawnCount = 0;

function Demo() {
  const [kids, setKids] = useState<Pane[]>(KIDS);
  // Everything starts shut. Arriving does not open a row and neither does the
  // notice being taken: the crew sits beside the conversation the reader is in,
  // so a row unfolding is height off whatever they were already looking at.
  // **A permission request is the one exception**, below, and it earns it by
  // being the one state where nothing happens until the reader acts.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState("parent");
  const [controls, setControls] = useState(true);
  // The two state marks are near the floor of the ramp, so the page has to be
  // readable in either mode without the reader going to the real app's Settings
  // to switch.
  const { theme, resolvedMode, setTheme: setAppTheme, setMode: setAppMode } = useTheme();

  /// Opening a row selects it and closing hands selection back to the parent.
  ///
  /// Selection is where the composer sends, so it has to follow the transcript
  /// the reader is looking at — and closing the only row they had open leaves
  /// them looking at the parent, which is the one session guaranteed to still
  /// be on screen. Anything else would leave the composer pointed at a
  /// transcript that just folded away.
  const toggle = (id: string) => {
    const opening = !open.has(id);
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    setFocusedId(opening ? id : "parent");
  };

  // The one thing that opens a row on its own is a permission request, and it
  // needs no effect at all: `asking` is read straight in the render
  // (`expanded` in [`OrchestrationSplit`]), so the row opens with the question
  // and shuts with it, and nothing has to remember to clean up after a decision.
  //
  // Writing the id into `open` was the first shape and it made `open` two
  // things at once — what the reader asked to read, and what happened to be on
  // screen. The card-only view is exactly the difference between them, so the
  // set had to stop carrying the second. It also meant answering a question
  // left its row standing open, which is the transcript nobody asked for
  // arriving one beat late.
  //
  // Expanding, deliberately **not** selecting: the buttons work whatever the
  // composer points at, and moving it would send the reader's next sentence to
  // a session they never chose to talk to.

  /// The first quiet, collapsed child raises one. Real events, so the crew
  /// draws the app's own cards rather than a drawing of them — which is the
  /// whole of what makes the fit question answerable here.
  const raiseAsk = (kind: "permission" | "question") => {
    const target =
      kids.find((k) => !k.asking && !open.has(k.session.sessionId)) ?? kids.find((k) => !k.asking);
    if (!target) return;
    const id = target.session.sessionId;
    const requestId = `req-${id}-${nextSeq}`;
    // No focus move either. Taking the composer is the same interruption as
    // opening the row, one step further: the reader would type their next
    // sentence to the parent and send it to a child.
    setKids((list) =>
      list.map((k) =>
        k.session.sessionId === id
          ? {
              ...k,
              asking: true,
              busy: false,
              session: {
                ...k.session,
                events: [
                  ...k.session.events,
                  kind === "question"
                    ? askQuestions(id, requestId)
                    : asks(
                        id,
                        requestId,
                        "rm -rf node_modules && pnpm install",
                        "Reinstall the workspace before checking the empty state",
                      ),
                ],
              },
            }
          : k,
      ),
    );
  };

  const respond = (sessionId: string, requestId: string, optionId: string) => {
    setKids((list) =>
      list.map((k) =>
        k.session.sessionId === sessionId
          ? {
              ...k,
              asking: false,
              busy: optionId !== "deny",
              session: {
                ...k.session,
                events: [
                  ...k.session.events,
                  ev(sessionId, {
                    type: "permission_decided",
                    requestId,
                    toolUseId: `tu-${requestId}`,
                    behavior: optionId === "deny" ? "deny" : "allow",
                    label: optionId === "deny" ? "Deny" : "Allow once",
                    automatic: false,
                  }),
                ],
              },
            }
          : k,
      ),
    );
  };

  /// Answering a question does not decide anything, so nothing is logged: the
  /// tool call's own row shows the answers once it completes, which this page
  /// has no turn to produce. Clearing `asking` is the whole of it — the row
  /// shuts, the yellow goes, and the session carries on.
  const answerQuestions = (sessionId: string, _requestId: string) => {
    setKids((list) =>
      list.map((k) =>
        k.session.sessionId === sessionId ? { ...k, asking: false, busy: true } : k,
      ),
    );
  };

  const mint = (): Pane => {
    const n = ++spawnCount;
    const id = `spawned-${n}`;
    return {
      session: snapshot(
        id,
        `Spawned task ${n}`,
        `fresh-worktree-${n}`,
        [
          prompt(
            id,
            '[message from the Dray session "Ship the PR panel empty states"] Take the next item off the list.',
          ),
          say(id, "Starting. Reading the issue first."),
        ],
        "parent",
      ),
      busy: true,
      asking: false,
      unread: false,
    };
  };

  /// A session spawns a session, and the row arrives **collapsed** — arriving
  /// is not the same as demanding to be read, and a transcript that opened
  /// itself would take height off whichever row the reader was in the middle
  /// of. Nothing is asked first: membership is the index's `parentSessionId`,
  /// so there is no preference here to answer.
  const spawn = () => setKids((list) => [...list, mint()]);

  const openCount = useMemo(
    () => kids.filter((k) => open.has(k.session.sessionId)).length,
    [kids, open],
  );

  return (
    <TooltipProvider>
      <div className="relative flex h-full flex-col bg-background text-foreground">
        {/* The demo's own controls. Not part of what is being designed — they
            stand in for things the app would do on its own, which is exactly
            why they hide: a strip of buttons over the layout is the loudest
            thing on screen and it is the one thing here nobody is judging. */}
        {controls && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-4 py-2 text-ui">
          <span className="font-medium">Spawned sessions crew</span>
          <span className="text-muted-foreground">
            {kids.length} rows · {openCount} open · crew {CREW_W}px fixed
          </span>
          <Button size="xs" className="ml-auto" variant="outline" onClick={spawn}>
            Spawn a session
          </Button>
          <Button size="xs" variant="outline" onClick={() => raiseAsk("permission")}>
            A child asks for permission
          </Button>
          <Button size="xs" variant="outline" onClick={() => raiseAsk("question")}>
            A child asks a question
          </Button>
          {/* A native select, not the app's own swatch grid. The palette is not
              what is being designed here — it is here so the crew's two status
              colours can be read on every one of them, and Default's light
              yellow is the reason it exists at all. */}
          <select
            value={theme}
            onChange={(e) => setAppTheme(e.target.value as ThemeName)}
            className="rounded-md border border-hairline bg-transparent px-1.5 py-0.5 text-ui"
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setAppMode(resolvedMode === "dark" ? "light" : "dark")}
          >
            {resolvedMode === "dark" ? "Light" : "Dark"}
          </Button>
          {/* Hiding is offered *in* the strip, where the thing it hides is.
              A floating button in a corner was the first try and it failed the
              way an undiscoverable control does: it is only findable by
              somebody who already knows it is there. */}
          <Button size="xs" variant="ghost" onClick={() => setControls(false)}>
            Hide
          </Button>
        </div>
        )}

        {/* Bringing them back has no strip to live in, so it takes the corner
            instead — bottom-left, since the top-right is the app's own tab row
            and the bottom-right is where the spawn notice lands. Half-lit at
            rest: with the strip gone the point is to see the layout, and the
            one control on screen should not be the loudest thing on it. */}
        {!controls && (
          <button
            type="button"
            onClick={() => setControls(true)}
            className="absolute bottom-3 left-3 z-20 rounded-md bg-popover px-2 py-1 text-ui text-muted-foreground opacity-60 shadow-sm backdrop-blur-xl transition-opacity hover:opacity-100"
          >
            Controls
          </button>
        )}

        <div className="min-h-0 flex-1">
          <OrchestrationSplit
            kids={kids}
            open={open}
            focusedId={focusedId}
            onToggle={toggle}
            onFocus={setFocusedId}
            onRespondPermission={respond}
            onAnswerQuestions={answerQuestions}
          />
        </div>

      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
