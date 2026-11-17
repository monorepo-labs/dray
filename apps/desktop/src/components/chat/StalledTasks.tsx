import { SignalSlashIcon } from "@heroicons/react/16/solid";
import { ArrowUpRight, X } from "lucide-react";
import { useState } from "react";

import BotAvatar from "@/components/BotAvatar";
import { TONE_TEXT } from "@/components/PrPanel";
import PrStateIcon from "@/components/PrStateIcon";
import { MergeControl } from "@/components/TasksPanel";
import { Button } from "@/components/ui/button";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useStallLine } from "@/hooks/useStallLine";
import { seededAvatar } from "@/lib/botAvatar";
import type { CrewRow } from "@/lib/crew";
import { isModClick } from "@/lib/platform";
import { prStatus } from "@/lib/pr";
import { offlineLine, useServers } from "@/lib/servers";
import { cardRows, compactAge, DISMISSED_KEY, needLine, type Stall } from "@/lib/stalled";
import { serverOfPath } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { MergeMethod, PrMark } from "@/types/events";

/// Keeps a long life from filling the store with dismissed stalls.
const DISMISSED_CAP = 200;

/// The foot of a bot's chat while any of its tasks waits on the reader: an
/// inbox row per task — its face, title, PR and how long it has sat. A PR
/// ready to merge carries Merge; a task idle on the reader carries the line its
/// bot wrote for it (`dray session need`), and so does a ready PR the task
/// asked the reader to try first. A click scrolls the chat to the bot's reply
/// to the task's last report, so the reader has the whole story without leaving
/// the bot; with none in the chat, it opens the task in a tab, as ⌘-click and
/// Open, shown on hover, do. A row clears
/// the moment its task moves; dismissed, a stall stays gone until the task
/// changes and stalls again. A task whose machine is down stays, drawn from
/// what was last known with the offline mark in its time's place; Merge still
/// works, through GitHub from here, where `mergeBlock` allows it, and the
/// offline mark says why where it does not.
export default function StalledTasks({
  stalls,
  now,
  onFocus,
  onOpen,
  onMerge,
  mergeBlock,
}: {
  /// The card's rows: `onCard` stalls alone.
  stalls: readonly Stall[];
  now: number;
  onFocus: (sessionId: string) => void;
  /// `alone`: a ⌘-click, which switches to the task rather than opening its tab.
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
  /// Why a ready row offers no Merge, or `null` where it does.
  mergeBlock: (row: CrewRow, pr: PrMark) => string | null;
}) {
  const [dismissed, setDismissed] = useLocalStorage<string[]>(DISMISSED_KEY, []);
  // Each row's offline mark follows its machine.
  useServers();
  const shown = cardRows(stalls, dismissed);
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
        <StalledRow
          key={stall.key}
          stall={stall}
          now={now}
          onFocus={onFocus}
          onOpen={onOpen}
          onMerge={onMerge}
          mergeBlock={mergeBlock}
        />
      ))}
    </div>
  );
}

/// One task as an inbox row: face, title, PR and time on top; what it needs
/// under it where its bot wrote that. A waiting task with no need yet draws its
/// own last message instead, read off its server, and holds a skeleton only
/// while that read runs; most ready PRs never get a line at all.
function StalledRow({
  stall,
  now,
  onFocus,
  onOpen,
  onMerge,
  mergeBlock,
}: {
  stall: Stall;
  now: number;
  onFocus: (sessionId: string) => void;
  onOpen: (sessionId: string, alone: boolean) => void;
  onMerge: (row: CrewRow, pr: PrMark, method: MergeMethod) => Promise<void>;
  mergeBlock: (row: CrewRow, pr: PrMark) => string | null;
}) {
  const [hovered, setHovered] = useState(false);
  const { row, pr } = stall;
  const { item } = row;
  const id = item.sessionId;
  const status = pr && prStatus(pr);
  const need = needLine(stall);
  const waiting = stall.kind === "waiting" && !need;
  const last = useStallLine(stall.key, id, waiting);
  const offline = offlineLine(serverOfPath(item.cwd));
  const blocked = stall.kind === "ready" && pr && !stall.checking ? mergeBlock(row, pr) : null;

  return (
    // A div, since a button cannot hold Open task and Merge inside it.
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => (isModClick(e) ? onOpen(id, false) : onFocus(id))}
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
          >
            {/* A task whose machine is down has nothing to open. */}
            {!offline && (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(id, isModClick(e));
                }}
              >
                Open task
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            )}
            {stall.kind === "ready" &&
              pr &&
              (stall.checking ? (
                <span className="text-[12px] text-muted-foreground" title="GitHub is checking whether this can merge">
                  Checking…
                </span>
              ) : (
                !blocked && <MergeControl onMerge={(method) => onMerge(row, pr, method)} />
              ))}
          </span>
          {offline ? (
            <span
              className="flex shrink-0"
              title={blocked ? `${offline} · last known state\n${blocked}` : `${offline} · last known state`}
            >
              <SignalSlashIcon className="size-3.5 text-muted-foreground" aria-label={offline} />
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
              {compactAge(item.modified, now)}
            </span>
          )}
        </span>
        {need ? (
          <span className="min-w-0 truncate text-ui text-foreground/70">{need}</span>
        ) : waiting && last.reading ? (
          <span className="my-1 h-3 w-48 animate-pulse rounded bg-muted-foreground/20" />
        ) : waiting && last.line ? (
          <span className="min-w-0 truncate text-ui text-foreground/70">{last.line}</span>
        ) : (
          waiting && <span className="min-w-0 truncate text-ui text-muted-foreground">Waiting for your reply</span>
        )}
      </span>
    </div>
  );
}
