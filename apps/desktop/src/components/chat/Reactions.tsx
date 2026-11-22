import { createContext, useContext, type ReactNode } from "react";
import { SmilePlus } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { REACTION_LABELS, REACTIONS } from "@/lib/reactions";
import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/types/events";

/// A reaction, as iMessage draws a tapback: a round chip on the bubble's top
/// corner on the reactor's side, a step lighter than the chat's page colour and
/// edged by a hairline. Mixed off `--background` rather than `--muted`, which
/// turns into a translucent veil on glass and let the bubble show through.
export function ReactionBadge({ emoji, mine = false, className }: { emoji: string; mine?: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label={`${mine ? "You" : "Bot"} reacted: ${REACTION_LABELS[emoji] ?? emoji}`}
      className={cn(
        "flex size-7 items-center justify-center rounded-full border-[0.5px] border-border bg-[color-mix(in_oklab,var(--background),white_7%)] text-[15px] leading-none select-none",
        "motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in motion-safe:duration-200",
        className,
      )}
    >
      {emoji}
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
    <div className={cn("group/react flex max-w-[85%] items-center gap-1 self-start", className, reaction && "mb-3")}>
      <div className="relative min-w-0">
        {children}
        {reaction && <ReactionBadge emoji={reaction} mine className="absolute -right-3 -bottom-4" />}
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
