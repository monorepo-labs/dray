import { ArrowUpRight, MousePointerClick, X } from "lucide-react";
import { useState } from "react";

import BotAvatar from "@/components/BotAvatar";
import TaskMessage from "@/components/chat/TaskMessage";
import { TONE_TEXT } from "@/components/PrPanel";
import PrStateIcon from "@/components/PrStateIcon";
import { MergeControl } from "@/components/TasksPanel";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useStallLine } from "@/hooks/useStallLine";
import { seededAvatar } from "@/lib/botAvatar";
import type { CrewRow } from "@/lib/crew";
import { IS_MAC, isModClick } from "@/lib/platform";
import { prStatus } from "@/lib/pr";
import { cardRows, compactAge, DISMISSED_KEY, needLine, type Stall } from "@/lib/stalled";
import { cn } from "@/lib/utils";
import type { MergeMethod, PrMark } from "@/types/events";

/// Keeps a long life from filling the store with dismissed stalls.
const DISMISSED_CAP = 200;

/// Rows drawn before "Show N more", so a long card doesn't push the chat off screen.
const ROWS_SHOWN = 3;

/// The foot of a bot's chat while any of its tasks waits on the reader: an
/// inbox row per task — its face, title, PR and how long it has sat. A PR
/// ready to merge carries Merge; a task idle on the reader carries the line its
/// bot wrote for it (`dray session need`), and so does a ready PR the task
/// asked the reader to try first. A click opens the task's last message under
/// its row, read off the end of the task's own log; a second click closes it.
/// It used to scroll the chat back to the bot's reply, which on a long chat
/// meant reading days of log and stalled the app. ⌘-click and Open, shown on
/// hover, open the task in a tab. A row clears the moment its task moves;
/// dismissed, a stall stays gone until the task changes and stalls again.
export default function StalledTasks({
  stalls,
  now,
  onOpen,
  onMerge,
}: {
  /// The card's rows: `onCard` stalls alone.
  stalls: readonly Stall[];
  now: number;
  /// `alone`: a ⌘-click, which switches to the task rather than opening its tab.
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  const [dismissed, setDismissed] = useLocalStorage<string[]>(DISMISSED_KEY, []);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = cardRows(stalls, dismissed);
  if (shown.length === 0) return null;
  const capped = !all && shown.length > ROWS_SHOWN;

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
      {(capped ? shown.slice(0, ROWS_SHOWN) : shown).map((stall) => (
        <StalledRow
          key={stall.key}
          stall={stall}
          now={now}
          expanded={open === stall.row.item.sessionId}
          onToggle={(id) => setOpen((o) => (o === id ? null : id))}
          onOpen={onOpen}
          onMerge={onMerge}
        />
      ))}
      {shown.length > ROWS_SHOWN && (
        <Button
          variant="ghost"
          size="xs"
          className="w-full text-muted-foreground"
          onClick={() => setAll((a) => !a)}
        >
          {capped ? `Show ${shown.length - ROWS_SHOWN} more` : "Show less"}
        </Button>
      )}
    </div>
  );
}

/// One task as an inbox row: face, title, PR and time on top; what it needs
/// under it where its bot wrote that. A waiting task with no need yet draws its
/// own last message instead, read off its server, and holds a skeleton only
/// while that read runs; most ready PRs never get a line at all. Expanded, the
/// whole of that message sits under it.
function StalledRow({
  stall,
  now,
  expanded,
  onToggle,
  onOpen,
  onMerge,
}: {
  stall: Stall;
  now: number;
  expanded: boolean;
  onToggle: (sessionId: string) => void;
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
}) {
  const [hovered, setHovered] = useState(false);
  const { row, pr } = stall;
  const { item } = row;
  const id = item.sessionId;
  const status = pr && prStatus(pr);
  const need = needLine(stall);
  const waiting = stall.kind === "waiting" && !need;
  const last = useStallLine(stall.key, id, waiting);

  return (
    <div className={cn("flex flex-col rounded-lg", expanded && "bg-muted/30")}>
      {/* A div, since a button cannot hold Open task and Merge inside it. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={(e) => (isModClick(e) ? onOpen(id, false) : onToggle(id))}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onToggle(id)}
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
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {/* Half strength: it sits on every row the pointer crosses. */}
              <span className="flex items-center gap-1 opacity-0 group-focus-within:opacity-50 group-hover:opacity-50">
                {/* What the row does with ⌘ held. */}
                <KbdGroup>
                  <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
                  <Kbd>
                    <MousePointerClick />
                  </Kbd>
                </KbdGroup>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(id, isModClick(e));
                  }}
                >
                  Open task
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              </span>
              {stall.kind === "ready" &&
                pr &&
                (stall.checking ? (
                  <span className="text-[12px] text-muted-foreground" title="GitHub is checking whether this can merge">
                    Checking…
                  </span>
                ) : (
                  <MergeControl onMerge={(method) => onMerge(row, pr, method)} />
                ))}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
              {compactAge(item.modified, now)}
            </span>
          </span>
          {need ? (
            <span className="min-w-0 truncate text-ui text-foreground/70">{need}</span>
          ) : expanded || !waiting ? null : last.reading ? (
            <span className="my-1 h-3 w-48 animate-pulse rounded bg-muted-foreground/20" />
          ) : last.line ? (
            <span className="min-w-0 truncate text-ui text-foreground/70">{last.line}</span>
          ) : (
            <span className="min-w-0 truncate text-ui text-muted-foreground">Waiting for your reply</span>
          )}
        </span>
      </div>
      {expanded && (
        <div className="pr-3 pb-3 pl-[52px] text-ui">
          <TaskMessage sessionId={id} cwd={item.cwd} />
        </div>
      )}
    </div>
  );
}
