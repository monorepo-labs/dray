import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useHotkey } from "@/hooks/useHotkey";
import {
  dismissNotice,
  useNotices,
  NOTICE_TTL_MS,
  type NoticeKind,
} from "@/hooks/useNotices";
import { IS_MAC } from "@/lib/platform";

type NoticeStackProps = {
  onSelect: (sessionId: string) => void;
};

/// What the button promises. Named for what the reader will do there rather
/// than "Open" for both — the two cards look alike at a glance, and the verb is
/// the fastest way to tell a turn that ended from one that is still waiting.
const ACTION: Record<NoticeKind, string> = {
  completed: "View",
  asking: "Answer",
};

/// The bar's colour, matching the rail mark the row will be wearing when the
/// reader gets there.
const BAR: Record<NoticeKind, string> = {
  completed: "bg-emerald-500/70",
  asking: "bg-accent-command/70",
};

/// The in-app card for a session that wants the reader.
///
/// Top-left, over the sidebar it is talking about and below the traffic lights,
/// where nothing else in the app draws. It carries no session title, no project
/// and no icon: the sidebar rail is already marking the row, so a card that
/// repeats the name spends its width saying what the next glance says anyway.
/// What is left is the one fact that isn't on screen anywhere else — *what* is
/// wanted — and a button to go and do it.
///
/// **The button is the control, and it is the only one.** An earlier pass made
/// the whole card clickable with a chevron for a hint, and it was not obvious
/// enough to be trusted: a card you are not sure you can click is a card you
/// read and leave alone. There is no dismiss button either — the card is already
/// leaving on its own, and an X to make it leave slightly sooner is a second
/// target competing with the one that matters.
export default function NoticeStack({ onSelect }: NoticeStackProps) {
  const notices = useNotices();

  // The oldest card, which is the top one and the next to expire. Acting on it
  // rather than the newest is what makes the shortcut repeatable: hitting it
  // twice clears two cards in the order they arrived, where "newest" would
  // reshuffle what the key means every time one lands.
  const next = notices[0] ?? null;

  const take = (sessionId: string) => {
    dismissNotice(sessionId);
    onSelect(sessionId);
  };

  // The card's whole point is not having to leave what you were doing, and a
  // mouse trip to a 40px button undoes most of that.
  // Registered here rather than in `App` so it exists only while a card does —
  // ⌘G with nothing raised should stay free for whatever wants it later.
  useHotkey("g", () => next && take(next.sessionId));

  if (notices.length === 0) return null;

  return (
    // `items-start` so each card hugs its own text — these are a sentence and a
    // button, and a fixed width would leave "Task finished" padded out to the
    // length of the longest label the app can produce.
    <div className="pointer-events-none fixed top-(--titlebar-h) left-3 z-50 flex flex-col items-start gap-2">
      {notices.map((notice) => (
        <Alert
          key={notice.sessionId}
          // `flex` beats the component's own `grid`: that layout is for a title
          // over a description beside an icon, and this is one row of three
          // things. `overflow-hidden` is what clips the bar to the radius.
          className="group/notice pointer-events-auto relative flex w-fit items-center gap-2 overflow-hidden py-1.5 pr-1.5 pl-3 shadow-lg ring-1 ring-foreground/10 animate-in fade-in slide-in-from-top-2"
        >
          <AlertTitle className="text-ui">{notice.label}</AlertTitle>

          {/* `default` rather than `secondary`: the card is itself a raised
              surface, so a secondary fill on top of it is one shade off the
              thing it sits on and stops reading as a control at all. `pr-1`
              because the keycaps carry their own inset, which turns the size's
              own right padding into a gap. */}
          <Button
            size="xs"
            className="pr-1"
            onClick={() => take(notice.sessionId)}
          >
            {ACTION[notice.kind]}
            {/* Stated on the card rather than left to a tooltip, for
                [ImageLightbox](chat/ImageLightbox.tsx)'s reason: this thing is
                gone in ten seconds, so a hint that needs a hover to find is a
                hint nobody will ever see. Only on the card the key actually
                acts on, which is also how the stack says which one that is. */}
            {notice === next && (
              <KbdGroup className="ml-0.5">
                <Kbd className="h-4 min-w-4 bg-primary-foreground/12 text-primary-foreground/75">
                  {IS_MAC ? "⌘" : "Ctrl"}
                </Kbd>
                <Kbd className="h-4 min-w-4 bg-primary-foreground/12 text-primary-foreground/75">
                  G
                </Kbd>
              </KbdGroup>
            )}
          </Button>

          {/* The countdown, and the thing that actually ends it — the store
              keeps no timer, so `animationend` is the dismissal. That is what
              makes the hover pause honest: one clock, so stopping the bar stops
              the card going away under a cursor reaching for its button. */}
          <span
            aria-hidden
            onAnimationEnd={() => dismissNotice(notice.sessionId)}
            style={{ animationDuration: `${NOTICE_TTL_MS[notice.kind]}ms` }}
            className={`notice-timer absolute inset-x-0 bottom-0 h-0.5 group-hover/notice:[animation-play-state:paused] ${BAR[notice.kind]}`}
          />
        </Alert>
      ))}
    </div>
  );
}
