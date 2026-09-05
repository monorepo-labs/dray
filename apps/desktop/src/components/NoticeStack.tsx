import { useEffect, useRef, useState } from "react";

import { Check } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useHotkey } from "@/hooks/useHotkey";
import {
  dismissNotice,
  noticeKey,
  useNotices,
  NOTICE_TTL_MS,
  type Notice,
  type NoticeKind,
} from "@/hooks/useNotices";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";

type NoticeStackProps = {
  onSelect: (sessionId: string) => void;
  /// Where the ready-to-merge card goes: the session *and* the pane, open on
  /// its PR tab. Selecting alone would land the reader on a transcript that
  /// says nothing about the pull request the card is about.
  onOpenPr: (sessionId: string) => void;
  /// Starts the removal, which answers nothing: git finishes in the background
  /// and a refusal comes back as a card of its own.
  onDeleteWorktree: (sessionId: string) => void;
};

/// What the button promises. Named for what the reader will do there rather
/// than "Open" for both — the two cards look alike at a glance, and the verb is
/// the fastest way to tell a turn that ended from one that is still waiting.
const ACTION: Record<NoticeKind, string> = {
  completed: "View",
  asking: "Answer",
  worktree: "Delete",
  // Not "Merge". What the reader does there is merge it, which is what this
  // label rule asks for — but the app's own merge button arms a confirm before
  // it lands one, and a card button that skipped straight past that would be
  // the one irreversible thing in the app reachable by a stray click on a
  // notice nobody asked for.
  pr: "Review",
  // Where the retry is. The step that clears the index entry is the last one,
  // so a cleanup that stopped anywhere left the settled bar carrying its
  // "Delete worktree" button — the card names the reason and this puts the
  // reader back in front of the control that runs the rest.
  "worktree-failed": "View",
};

/// The bar's colour, matching the rail mark the row will be wearing when the
/// reader gets there.
///
/// The worktree card has no rail to match — nothing in the sidebar is waiting
/// — so its bar is the destructive colour instead, and reads as what it is: the
/// time left on an offer to delete something.
const BAR: Record<NoticeKind, string> = {
  completed: "bg-accent-add/70",
  asking: "bg-accent-command/70",
  worktree: "bg-destructive/70",
  // The colour of the glyph the row is wearing, which is the rule the other
  // bars follow — `--accent-add`, the app's green. It shares that
  // with `completed`, and the two are told apart by what the card says rather
  // than by hue: both are good news about a session, and inventing a fourth
  // colour to separate them would spend the palette on a distinction the label
  // already makes.
  pr: "bg-accent-add/70",
  // The colour the offer wore, kept for the card that reports it did not go
  // through: the two are the same deletion, and this one is the only place the
  // reader learns it stopped part way.
  "worktree-failed": "bg-destructive/70",
};

/// How long the card lingers after its work is done, to say so. Long enough to
/// read one word, short enough that nobody waits on it.
const CONFIRM_MS = 800;

/// Wraps a button in the tooltip that carries its accelerator, and only where
/// there is one to carry.
///
/// The caps used to sit *in* the buttons. That reads well on a card holding one
/// of them and badly on the worktree card holding two — the row grew wider than
/// the sentence above it, and a card meant to sit in a corner stopped fitting
/// in one. A tooltip is where this app puts shortcuts anyway.
///
/// `keys` empty means no tooltip at all rather than an empty one: only the top
/// card answers to the keys, and everywhere else the tooltip would repeat the
/// button's own visible label back at the reader — the one thing this app's
/// tooltip rule says a tooltip must not do.
function WithShortcut({
  keys,
  children,
}: {
  keys: string[];
  children: React.ReactNode;
}) {
  if (keys.length === 0) return children;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {/* One line, so it stays a tooltip rather than a menu of shortcuts. */}
      <TooltipContent side="bottom" className="max-w-none whitespace-nowrap">
        <KbdGroup>
          <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
          {keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

/// One card.
///
/// Its own component for its countdown, which is one `Animation` per card and
/// cannot live in the map that renders them.
function NoticeCard({
  notice,
  isNext,
  done,
  onTake,
  onDeleteWorktree,
}: {
  notice: Notice;
  isNext: boolean;
  /// Acted on already, and saying so for a moment before it goes. Owned by the
  /// stack rather than by the card, because it is what takes the card out of
  /// the running for the shortcuts — a card the reader has answered must not
  /// still be what the next keypress lands on.
  done: boolean;
  onTake: () => void;
  onDeleteWorktree: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const worktree = notice.kind === "worktree";

  const bar = useRef<HTMLSpanElement>(null);
  const timer = useRef<Animation | null>(null);
  const duration = done ? CONFIRM_MS : NOTICE_TTL_MS[notice.kind];

  // The countdown, and the thing that ends it: one `Animation` object owning
  // both the bar and the dismissal, so there is still exactly one clock.
  //
  // Driven from script rather than by a CSS class, because the class version
  // had no single object to ask. Duration arrived as an inline style and the
  // pause as a `group-hover` rule, and between them a hover could leave the
  // bar visibly frozen while the card went away the moment the cursor left.
  // `pause()` freezes `currentTime` outright and `play()` picks it up there,
  // which is what hovering to read a card is supposed to cost: nothing.
  //
  // `onfinish` only fires on a real finish, so a paused card cannot expire —
  // and neither can one whose window is occluded and whose animation the
  // browser has throttled, which is the behaviour we want anyway.
  useEffect(() => {
    if (!bar.current) return;

    const countdown = bar.current.animate(
      [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
      { duration, easing: "linear", fill: "forwards" },
    );
    countdown.onfinish = () => dismissNotice(notice.sessionId, notice.kind);
    timer.current = countdown;

    return () => {
      timer.current = null;
      countdown.cancel();
    };
  }, [duration, notice.sessionId]);

  // Nothing runs down while the reader is on the card. `done` deliberately
  // keeps running under the cursor: the reader just clicked this, and the pause
  // exists to protect a button they are still reaching for — past that press
  // there is no target left to protect, and a card waiting for the mouse to
  // leave reads as stuck.
  const frozen = hovered && !done;
  useEffect(() => {
    if (frozen) timer.current?.pause();
    else timer.current?.play();
  }, [frozen, duration]);

  // ⌘⇧D deletes without the trip to a 40px button, which is the whole point of
  // the card. Bound here rather than in the stack because it has to run the
  // same handler the button does, so the press and the click leave the card in
  // one state rather than two.
  //
  // A key of its own rather than more meaning on ⌘G: one chord that sometimes
  // navigates and sometimes destroys is the shape that burns someone once.
  // Shifted because plain ⌘D is dictation, app-wide — a card raising itself
  // under the cursor must not take a chord the composer already owns.
  // Guarded on `isNext` alone, which is now enough: a card that has been acted
  // on stops being next, so a repeat press cannot ask for the same removal
  // twice and lands on the card behind it instead.
  useHotkey(
    "d",
    () => {
      if (worktree && isNext) onDeleteWorktree();
    },
    { shift: true },
  );

  return (
    <Alert
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // `flex` beats the component's own `grid`: that layout is for a title
      // over a description beside an icon, and this is one row of three
      // things. `overflow-hidden` is what clips the bar to the radius.
      className="group/notice pointer-events-auto relative flex w-fit items-center gap-2 overflow-hidden py-1.5 pr-1.5 pl-3 shadow-lg ring-1 ring-foreground/10 has-[[data-slot=alert-description]]:items-start has-[[data-slot=alert-description]]:py-2.5 animate-in fade-in slide-in-from-top-2"
    >
      {/* A column only when there is a second line to stack. The other kinds
          stay the single row they have always been — wrapping a lone title in a
          flex column changes nothing about it, but it is the kind of nothing
          that drifts. */}
      {notice.detail ? (
        <span className="flex min-w-0 flex-col gap-0.5 pr-1">
          {/* The action first and the subject after it, on one line. What this
              card is *for* has to be readable without reading the rest of it,
              and the subject muted behind it reads as the qualifier it is —
              stacked on its own line the two looked like two things to deal
              with. The action never wraps; the title is the half that gives
              way, since it is the part the reader can recognise from its
              opening words. `title` restores what the clip took, which is the
              one use the app's tooltip rule keeps the attribute for. */}
          <AlertTitle className="flex max-w-64 items-baseline gap-1.5 text-ui">
            <span className="shrink-0">{notice.label}</span>
            {notice.subject && (
              <span className="truncate font-normal text-muted-foreground" title={notice.subject}>
                {notice.subject}
              </span>
            )}
          </AlertTitle>
          <AlertDescription className="max-w-64 text-ui-sm text-muted-foreground">
            {notice.detail}
          </AlertDescription>
        </span>
      ) : (
        <AlertTitle className="text-ui">{notice.label}</AlertTitle>
      )}

      <span className="flex shrink-0 items-center gap-1">
        {/* Skip is the answer the card gives itself when the bar runs out, so
            it is here to be *said* rather than waited for — and it holds the
            keycap, which keeps ⌘G non-destructive on every card in the stack.
            It goes once the deletion has happened: there is nothing left to
            skip, and a live button beside "Deleted" invites a second thought
            about a directory that is already gone. */}
        {worktree && !done && (
          <WithShortcut keys={isNext ? ["G"] : []}>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => dismissNotice(notice.sessionId, notice.kind)}
            >
              Skip
            </Button>
          </WithShortcut>
        )}

        {/* `default` rather than `secondary`: the card is itself a raised
            surface, so a secondary fill on top of it is one shade off the thing
            it sits on and stops reading as a control at all. `pr-1` because the
            keycaps carry their own inset, which turns the size's own right
            padding into a gap. */}
        <WithShortcut keys={isNext ? (worktree ? ["⇧", "D"] : ["G"]) : []}>
        <Button
          size="xs"
          className={cn(
            "shrink-0",
            // Destructive fill for the one card whose button destroys. On a
            // card the reader did not ask for, it is the difference between a
            // button they read and one they click past.
            worktree && "bg-destructive text-white hover:bg-destructive/90",
            // Done is a statement, not a control. It keeps the fill so the card
            // doesn't reflow into a different shape at the moment the eye is on
            // it, and drops the pointer so nothing invites a second press.
            done && "pointer-events-none",
          )}
          onClick={worktree ? onDeleteWorktree : onTake}
        >
          {done ? (
            <>
              <Check className="size-3.5" />
              Deleted
            </>
          ) : (
            ACTION[notice.kind]
          )}
        </Button>
        </WithShortcut>
      </span>

      {/* Drained left to right. `transform` rather than `width` so it runs on
          the compositor and never lays the card out again mid-countdown. What
          drives it lives in the effects above. */}
      <span
        ref={bar}
        aria-hidden
        className={cn("absolute inset-x-0 bottom-0 h-0.5 origin-left", BAR[notice.kind])}
      />
    </Alert>
  );
}

/// The in-app card for a session that wants the reader.
///
/// Top-left, over the sidebar it is talking about and below the traffic lights,
/// where nothing else in the app draws. It carries no session title, no project
/// and no icon: the sidebar rail is already marking the row, so a card that
/// repeats the name spends its width saying what the next glance says anyway.
/// What is left is the one fact that isn't on screen anywhere else — *what* is
/// wanted — and a button to go and do it. The worktree card is the exception
/// and says why in [useNotices](../hooks/useNotices.ts).
///
/// **The buttons are the controls, and they are the only ones.** An earlier
/// pass made the whole card clickable with a chevron for a hint, and it was not
/// obvious enough to be trusted: a card you are not sure you can click is a card
/// you read and leave alone. There is no dismiss button on the navigating kinds
/// either — those are already leaving on their own, and an X to make one leave
/// slightly sooner is a second target competing with the one that matters. The
/// worktree card earns its Skip by being a *question*: leaving is a real answer
/// there, and an answer you can only give by waiting is one you cannot give.
export default function NoticeStack({
  onSelect,
  onOpenPr,
  onDeleteWorktree,
}: NoticeStackProps) {
  const notices = useNotices();

  // Cards the reader has answered, which are still on screen only to say so.
  // Pruned as it is written, so keys of cards long gone cannot pile up.
  const [acted, setActed] = useState<string[]>([]);
  const markActed = (key: string) =>
    setActed((keys) => [
      ...keys.filter((k) => notices.some((n) => noticeKey(n) === k)),
      key,
    ]);

  // The oldest card *still waiting on an answer*, which is the top one and the
  // next to expire. Acting on it rather than the newest is what makes the
  // shortcut repeatable: hitting it twice clears two cards in the order they
  // arrived, where "newest" would reshuffle what the key means every time one
  // lands. Skipping the answered ones is the other half of that — a worktree
  // card keeps its place for the moment it spends saying "Deleted", and a key
  // pressed in that window belongs to the card behind it.
  const next = notices.find((n) => !acted.includes(noticeKey(n))) ?? null;

  // Where a card leads, which is the same for the key and for the button. The
  // navigating kinds go somewhere and a worktree card only leaves: its Skip is
  // what this lands on, which is what keeps the key below non-destructive.
  //
  // `worktree-failed` navigates like the rest, and has to: it is the one card
  // whose subject is a session the reader is being sent back to, where the
  // button that tries the removal again still is.
  const take = (notice: Notice) => {
    dismissNotice(notice.sessionId, notice.kind);
    if (notice.kind === "pr") onOpenPr(notice.sessionId);
    else if (notice.kind !== "worktree") onSelect(notice.sessionId);
  };

  // ⌘G takes the navigating kinds — a session, or a session and its PR tab —
  // and *skips* a worktree card, so the key never destroys anything. That is
  // the whole reason the worktree card has a Skip button to hang it on: a
  // shortcut that usually navigates but sometimes deletes a directory is the
  // shape that burns someone exactly once.
  //
  // Registered here rather than in `App` so it exists only while a card does —
  // ⌘G with nothing raised should stay free for whatever wants it later.
  useHotkey("g", () => {
    if (!next) return;
    take(next);
  });

  if (notices.length === 0) return null;

  return (
    // `items-start` so each card hugs its own text — these are a sentence and a
    // button, and a fixed width would leave "Task finished" padded out to the
    // length of the longest label the app can produce.
    <div className="pointer-events-none fixed top-(--titlebar-h) left-3 z-50 flex flex-col items-start gap-2">
      {notices.map((notice) => (
        <NoticeCard
          key={noticeKey(notice)}
          notice={notice}
          isNext={notice === next}
          done={acted.includes(noticeKey(notice))}
          onTake={() => take(notice)}
          onDeleteWorktree={() => {
            // Said, not awaited — and "Deleted" is *optimistic*, deliberately.
            // It reports a removal that is under way rather than one that has
            // happened: the alternative is a spinner saying "still going" over
            // three git commands, which is the click that reads as missed. A
            // cleanup that fails comes back on a `worktree-failed` card, which
            // exists to take this word back.
            onDeleteWorktree(notice.sessionId);
            markActed(noticeKey(notice));
          }}
        />
      ))}
    </div>
  );
}
