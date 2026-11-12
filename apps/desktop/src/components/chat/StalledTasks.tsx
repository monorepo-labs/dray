import { ArrowUpRight, X } from "lucide-react";
import { useState } from "react";

import BotAvatar from "@/components/BotAvatar";
import { TONE_TEXT } from "@/components/PrPanel";
import PrStateIcon from "@/components/PrStateIcon";
import { MergeControl } from "@/components/TasksPanel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { seededAvatar } from "@/lib/botAvatar";
import type { CrewRow } from "@/lib/crew";
import { isModClick } from "@/lib/platform";
import { prStatus } from "@/lib/pr";
import { compactAge, needLine, type Stall } from "@/lib/stalled";
import { cn } from "@/lib/utils";
import type { MergeMethod, PrMark } from "@/types/events";

/// Dismissed stalls, by key. A key names one stall, so the list only grows by
/// what the reader dismisses; the cap keeps a long life from filling the store.
const DISMISSED_KEY = "ade.dismissedStalls";
const DISMISSED_CAP = 200;

/// The foot of a bot's chat while any of its tasks waits on the reader: an
/// inbox row per task — its face, title, PR and how long it has sat. A PR
/// ready to merge carries Merge; a task idle on the reader carries the line its
/// bot wrote for it (`dray session need`). A click scrolls the chat to the
/// task's last report and the bot's reply, so the reader has the whole story
/// without leaving the bot; Open, shown on hover, opens the task. A row clears
/// the moment its task moves; dismissed, a stall stays gone until the task
/// changes and stalls again.
export default function StalledTasks({
  stalls,
  now,
  onFocus,
  onOpen,
  onMerge,
}: {
  /// The card's rows: `onCard` stalls alone.
  stalls: readonly Stall[];
  now: number;
  onFocus: (sessionId: string) => void;
  /// `alone`: a ⌘-click, which switches to the task rather than opening its tab.
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  const [dismissed, setDismissed] = useLocalStorage<string[]>(DISMISSED_KEY, []);
  const shown = stalls.filter((s) => !dismissed.includes(s.key));
  if (shown.length === 0) return null;

  return (
    <div className="flex w-full flex-col rounded-xl border border-border/60 p-1">
      <div className="flex items-center py-0.5 pr-0.5 pl-2 text-ui text-muted-foreground">
        <span className="flex-1">Waiting on you</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          className="text-muted-foreground"
          onClick={() => setDismissed((d) => [...d, ...shown.map((s) => s.key)].slice(-DISMISSED_CAP))}
        >
          <X />
        </Button>
      </div>
      {shown.map((stall) => (
        <StalledRow key={stall.key} stall={stall} now={now} onFocus={onFocus} onOpen={onOpen} onMerge={onMerge} />
      ))}
    </div>
  );
}

/// One task as an inbox row: face, title, PR and time on top; for a waiting
/// task, what it needs under it, a skeleton until its bot has written that.
function StalledRow({
  stall,
  now,
  onFocus,
  onOpen,
  onMerge,
}: {
  stall: Stall;
  now: number;
  onFocus: (sessionId: string) => void;
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  const [hovered, setHovered] = useState(false);
  const [onAction, setOnAction] = useState(false);
  const { row, pr } = stall;
  const { item } = row;
  const id = item.sessionId;
  const status = pr && prStatus(pr);
  const need = needLine(stall);

  return (
    // The row's own click stays in the chat, so the tooltip says so; it hides
    // over the row's buttons, which do something else. A div, since a button
    // cannot hold Open and Merge inside it.
    <Tooltip open={hovered && !onAction}>
      <TooltipTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onFocus(id)}
          onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onFocus(id)}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BotAvatar seed={id} avatar={seededAvatar(id)} follow={hovered} className="block size-8 shrink-0 scale-[1.18]" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="min-w-0 truncate text-ui text-foreground">{item.title}</span>
              {pr && status && (
                <span
                  className={cn("flex shrink-0 items-center gap-0.5 text-[12px] tabular-nums", TONE_TEXT[status.tone])}
                  title={`Pull request #${pr.number} · ${status.label.toLowerCase()}`}
                >
                  <PrStateIcon pr={pr} strokeWidth={1.5} className="text-current" />#{pr.number}
                </span>
              )}
              {/* Held in place while hidden, so showing it moves nothing. Merge
                  sits before the time, so the time ends every row. */}
              <span
                className="ml-auto flex shrink-0 items-center gap-2"
                onPointerEnter={() => setOnAction(true)}
                onPointerLeave={() => setOnAction(false)}
              >
                <Button
                  variant="outline"
                  size="xs"
                  className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(id, isModClick(e));
                  }}
                >
                  Open task
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
                {stall.kind === "ready" && pr && <MergeControl onMerge={(method) => onMerge(row, pr, method)} />}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
                {compactAge(item.modified, now)}
              </span>
            </span>
            {need ? (
              <span className="min-w-0 truncate text-ui text-foreground/70">{need}</span>
            ) : (
              // The bot is still reading the task; the slot holds its place.
              stall.kind === "waiting" && <span className="my-1 h-3 w-48 animate-pulse rounded bg-muted-foreground/20" />
            )}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">Show in chat</TooltipContent>
    </Tooltip>
  );
}
