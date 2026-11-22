import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SmilePlus } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { centring, inkOf, OPTICAL_DROP } from "@/lib/emojiInk";
import { REACTION_LABELS, REACTIONS } from "@/lib/reactions";
import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/types/events";

/// A reaction, as iMessage draws a tapback: a round chip on a corner of the
/// bubble, filled with `--reaction` (white on Dray light, the panel elsewhere)
/// and edged by a hairline, the emoji at about half its height and centred by
/// its ink (see [emojiInk]).
export function ReactionBadge({ emoji, mine = false, className }: { emoji: string; mine?: boolean; className?: string }) {
  const glyph = useRef<HTMLSpanElement>(null);
  const baseline = useRef<HTMLSpanElement>(null);
  const [nudge, setNudge] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = glyph.current;
    const mark = baseline.current;
    if (!el || !mark) return;
    const s = getComputedStyle(el);
    const ink = inkOf(emoji, `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`);
    const drop = (OPTICAL_DROP[emoji] ?? 0) * parseFloat(s.fontSize);
    // Offsets, not client rects: those take the badge's zoom-in mid-flight.
    setNudge(ink && centring(ink, el.offsetWidth, el.offsetHeight, mark.offsetTop, drop));
  }, [emoji]);
  return (
    <span
      role="img"
      aria-label={`${mine ? "You" : "Bot"} reacted: ${REACTION_LABELS[emoji] ?? emoji}`}
      className={cn(
        "flex size-10 items-center justify-center rounded-full border border-border bg-(--reaction) text-[18px] leading-none select-none",
        "motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in motion-safe:duration-200",
        className,
      )}
    >
      <span
        ref={glyph}
        className="relative"
        style={nudge ? { transform: `translate(${nudge.x}px, ${nudge.y}px)` } : undefined}
      >
        {emoji}
        {/* An empty inline-block's bottom edge sits on the baseline, which is how
            the text box says where its baseline is. */}
        <span ref={baseline} className="inline-block size-0 align-baseline" />
      </span>
    </span>
  );
}

/// The reader's reactions in the bot chat on screen, and how to make one. A
/// context, since its rows are memoised on what they were built from and a
/// reaction lands as an event of its own. `react` is null where nothing can
/// take one: a settled chat.
export type Reactions = {
  mine: ReadonlyMap<string, string>;
  react: ((event: AgentEvent, emoji: string) => void) | null;
};

export const ReactionsContext = createContext<Reactions>({ mine: new Map(), react: null });

/// A bot's message with the reader's reaction hanging off its bottom corner, under
/// what was read, and beside it a button to pick one on hover. Takes the
/// bubble's width and place in the chat.
export function Reactable({ event, className, children }: { event: AgentEvent; className?: string; children: ReactNode }) {
  const { mine, react } = useContext(ReactionsContext);
  const reaction = mine.get(event.id);
  return (
    <div className={cn("group/react flex max-w-[85%] items-center gap-1 self-start", className, reaction && "mb-5")}>
      <div className="relative min-w-0">
        {children}
        {reaction && <ReactionBadge emoji={reaction} mine className="absolute -right-4 -bottom-6" />}
      </div>
      {react && !event.subagent && <ReactButton current={reaction} onPick={(emoji) => react(event, emoji)} />}
    </div>
  );
}

/// The hover button and the set it opens. Shown while the row is hovered or the
/// set is open, and always to the keyboard.
function ReactButton({ current, onPick }: { current: string | undefined; onPick: (emoji: string) => void }) {
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="React"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color] outline-none group-hover/react:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:opacity-100"
            >
              <SmilePlus className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>React</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="flex w-auto min-w-0 gap-0.5"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {REACTIONS.map((emoji) => (
          <DropdownMenuItem
            key={emoji}
            aria-label={REACTION_LABELS[emoji]}
            onSelect={() => emoji !== current && onPick(emoji)}
            className={cn(
              "size-8 cursor-pointer justify-center p-0 text-[18px] leading-none",
              emoji === current && "bg-accent",
            )}
          >
            {emoji}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
