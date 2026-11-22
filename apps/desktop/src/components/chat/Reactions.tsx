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

/// The reader's reactions in the chat on screen, and how to make one. A context,
/// since the agent's text is drawn several components below `Chat` in a task's
/// transcript. `react` is null where nothing can take one: a settled chat, a
/// subagent's view.
export type Reactions = {
  mine: ReadonlyMap<string, string>;
  react: ((event: AgentEvent, emoji: string) => void) | null;
};

export const ReactionsContext = createContext<Reactions>({ mine: new Map(), react: null });

/// The agent's message with the reader's reaction on it and, on hover, a button
/// to pick one. `bubble` for a bot's chat, where the badge sits on the bubble's
/// corner as the bot's does on the reader's, and this row takes the bubble's
/// width and place; otherwise under the text, which has no corner to sit on.
export function Reactable({
  event,
  bubble = false,
  className,
  children,
}: {
  event: AgentEvent;
  bubble?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { mine, react } = useContext(ReactionsContext);
  const reaction = mine.get(event.id);
  const pick = react && !event.subagent ? (emoji: string) => react(event, emoji) : null;
  if (bubble) {
    return (
      <div className={cn("group/react flex max-w-[85%] items-center gap-1 self-start", className, reaction && "mt-3")}>
        <div className="relative min-w-0">
          {children}
          {reaction && <ReactionBadge emoji={reaction} mine className="absolute -top-4 -right-3" />}
        </div>
        {pick && <ReactButton current={reaction} onPick={pick} />}
      </div>
    );
  }
  if (!reaction && !pick) return <>{children}</>;
  return (
    <div className={cn("group/react relative", className)}>
      {children}
      {reaction && <ReactionBadge emoji={reaction} mine className="mt-1.5" />}
      {pick && <ReactButton current={reaction} onPick={pick} className="absolute right-0 -bottom-3" floating />}
    </div>
  );
}

/// The hover button and the set it opens. Shown while the row is hovered or the
/// set is open, and always to the keyboard.
function ReactButton({
  current,
  onPick,
  floating = false,
  className,
}: {
  current: string | undefined;
  onPick: (emoji: string) => void;
  /// Sits over the text rather than beside it, so it takes a fill of its own.
  floating?: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="React"
              className={cn(
                "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color] outline-none group-hover/react:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:opacity-100",
                floating && "bg-popover shadow-xs ring-1 ring-foreground/10 backdrop-blur-xl",
                className,
              )}
            >
              <SmilePlus className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>React</TooltipContent>
      </Tooltip>
      {/* A floating button sits at the column's right edge, so its set opens
          leftwards from it; beside a bubble there is room to the right. */}
      <DropdownMenuContent
        align={floating ? "end" : "start"}
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
